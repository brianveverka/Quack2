// SPDX-License-Identifier: GPL-2.0-or-later
// WebGL2 world renderer: one static vertex buffer for every model, a world index buffer
// rebuilt when the faces R_RecursiveWorldNode passes change, a static index buffer for
// the brush models drawn at their entity origins and angles (movers' origins set each
// frame), one draw per texture and surface flags per model. World leafs and brush
// models behind a closed area portal, outside the eye's PVS, or outside the view
// frustum are skipped. Warped faces (SURF_WARP) are moved in the vertex shader as
// EmitWaterPolys does; translucent ones (SURF_TRANS33/66) are blended last, in
// R_DrawAlphaSurfaces' order. The world's sky faces are not drawn; the sky box is,
// where they bound it (R_DrawSkyBox).

import { SURF_FLOWING, SURF_TRANS33, SURF_TRANS66, SURF_WARP, areaBits, floodAreas, pointLeaf, type Bsp } from "@quack2/sim";
import type { BrushModelInstance } from "./bmodels.js";
import {
  areasVisible,
  boxOutsideFrustum,
  fatClusters,
  frustumPlanes,
  placeInstance,
  PlacedInstances,
  type PlacedInstance,
  type Pose,
  type Vec3,
} from "./cull.js";
import { buildLightmapAtlas, refreshLightmaps, setLightmapStyles, type LightmapAtlas } from "./lightmap.js";
import { fovY, modelMatrix, multiply, perspective, viewMatrix, type Mat4 } from "./math.js";
import { addSkyPolygon, clearSkyBounds, newSkyBounds, skyBoxQuads, skyMatrix, type SkySettings } from "./sky.js";
import { notexture } from "./skyimage.js";
import { resolveTextures, type TextureImage, type TextureSource } from "./textures.js";
import { TURBSIN, flowingScroll } from "./warp.js";
import {
  SURF_TRANSLUCENT,
  VERTEX_FLOATS,
  WorldDraws,
  WorldWalk,
  brushInstanceAlphaOrder,
  brushModelAlphaOrder,
  buildDrawList,
  buildOrderedDraws,
  buildWorldMesh,
  modelFaceMask,
  viewClusters,
  visibleFaceMask,
  worldVis,
  type DrawList,
  type DrawRange,
  type WorldMesh,
  type WorldVis,
} from "./world.js";

// The warp is EmitWaterPolys per vertex: r_turbsin packed four to a vec4 (a float[256]
// would take 256 uniform vectors, all WebGL2 guarantees). int() truncates as the C cast
// does and `& 255` wraps negatives as two's complement does. Here the argument is
// evaluated in single precision, the engine's in double, so a vertex near a table step
// can pick the neighbouring entry. uScroll is in st units on a warp (EmitWaterPolys adds
// it before the 1/64) and in texture widths otherwise (v[3] + scroll in gl_rsurf.c).
const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aST;
layout(location = 2) in vec2 aLM;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec2 uTexSize;
uniform bool uWarp;
uniform float uTime;
uniform float uScroll;
uniform vec4 uTurbSin[64];
out vec2 vUV;
out vec2 vLM;
const float TURBSCALE = 256.0 / (2.0 * 3.14159265358979323846);
float turb(float x) {
  int i = int(x * TURBSCALE) & 255;
  return uTurbSin[i >> 2][i & 3];
}
void main() {
  if (uWarp) {
    float s = aST.x + turb(aST.y * 0.125 + uTime) + uScroll;
    float t = aST.y + turb(aST.x * 0.125 + uTime);
    vUV = vec2(s, t) * (1.0 / 64.0);
  } else {
    vUV = vec2(aST.x / uTexSize.x + uScroll, aST.y / uTexSize.y);
  }
  vLM = aLM;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uLightmap;
uniform float uAlpha;
in vec2 vUV;
in vec2 vLM;
out vec4 outColor;
void main() {
  vec4 tex = texture(uTex, vUV);
  // GL_MODULATE: texture alpha (0 at palette index 255) times the colour's. Only the
  // alpha pass blends, and the canvas has no alpha channel, so it matters only there.
  outColor = vec4(tex.rgb * texture(uLightmap, vLM).rgb, tex.a * uAlpha);
}`;

// The sky box: unlit and opaque, as R_DrawSkyBox draws it.
const SKY_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aST;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec2 vUV;
void main() {
  vUV = aST;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUV).rgb, 1.0);
}`;

/** Floats per sky box vertex: box-space xyz, texture st (skyBoxQuads). */
const SKY_VERTEX_FLOATS = 5;

/** Background where no face covers a pixel; distinctive so tests can count leak pixels. */
export const CLEAR_COLOR = [64, 0, 64] as const;
export const FOV_X = 90;
const NEAR = 4;
const FAR = 16384;
const IDENTITY = modelMatrix([0, 0, 0], [0, 0, 0]);

export interface View {
  readonly origin: readonly [number, number, number];
  readonly pitch: number;
  readonly yaw: number;
}

export interface FrameStats {
  /** The eye's leaf, as ref_gl's Mod_PointInLeaf finds it (renderLeaf). */
  readonly leaf: number;
  readonly cluster: number;
  /** The second view cluster R_MarkLeaves merges (viewClusters); `cluster` when there is none. */
  readonly cluster2: number;
  /** The area of the eye's leaf as the server finds it (pointLeaf); 0 in solid or outside the map. */
  readonly area: number;
  /** World faces in the PVS and in areas connected to the eye's; brush model faces are not counted. */
  readonly visibleFaces: number;
  /**
   * World faces R_RecursiveWorldNode passes: those, less faces in leafs outside the view
   * frustum or facing away; sky and translucent ones included.
   */
  readonly drawnFaces: number;
  /** Brush model instances drawn. */
  readonly brushModels: number;
  /** Brush model instances skipped: in no area connected to the eye's (behind a closed area portal). */
  readonly areaCulled: number;
  /** Brush model instances in a connected area but skipped: touching no cluster in the eye's PVS. */
  readonly pvsCulled: number;
  /** Brush model instances in the PVS but skipped: wholly outside the view frustum. */
  readonly frustumCulled: number;
  /** Translucent faces sent to the alpha pass, brush models' included (their back faces too, which the GPU culls). */
  readonly alphaFaces: number;
  /** Sky polygon pieces that bounded the sky box (the engine's c_sky). */
  readonly skyPolygons: number;
  /** Sky box sides drawn. */
  readonly skySides: number;
  readonly draws: number;
  /** Faces whose lightmap was composed again and uploaded: drawn faces on a style that changed since they were last composed. */
  readonly lightmapUploads: number;
}

interface InstanceDraws extends PlacedInstance {
  /** Index into bsp.models. */
  readonly modelIndex: number;
  /** Ranges in the brush model index buffer. */
  readonly draws: readonly DrawRange[];
  /** Translucent faces' ranges in the brush model index buffer, in alpha pass order. */
  readonly alphaDraws: readonly DrawRange[];
  readonly alphaFaces: number;
  /** The model's faces, for refreshing their lightmaps when it is drawn. */
  readonly faces: readonly number[];
}

export class WorldRenderer {
  readonly mesh: WorldMesh;
  /** Texture names drawn as a checker placeholder. */
  missingTextures: readonly string[] = [];
  /**
   * Culling, on by default. Off, the world skips no node or leaf for the view frustum
   * (the engine's r_nocull) and every brush model instance is drawn (r_nocull, and the
   * server's PVS and area tests too).
   */
  cull = true;
  /** Every area connected to every other, for the world and brush models alike (the server's map_noareas). */
  noAreas = false;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly indexBuffer: WebGLBuffer;
  private readonly brushIndexBuffer: WebGLBuffer;
  private readonly instances: PlacedInstances<InstanceDraws>;
  private textures: { tex: WebGLTexture; width: number; height: number }[] = [];
  private readonly atlas: LightmapAtlas;
  private readonly lightmap: WebGLTexture;
  private readonly uViewProj: WebGLUniformLocation | null;
  private readonly uModel: WebGLUniformLocation | null;
  private readonly uTexSize: WebGLUniformLocation | null;
  private readonly uWarp: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;
  private readonly uScroll: WebGLUniformLocation | null;
  private readonly uAlpha: WebGLUniformLocation | null;
  private readonly alphaIndexBuffer: WebGLBuffer;
  /** World translucent faces in the order the alpha index buffer holds them. */
  private alphaOrder: number[] = [];
  private alphaDraws: DrawRange[] = [];
  /** Level time in seconds, r_newrefdef.time, for warps. */
  private time = 0;
  /** EmitWaterPolys' SURF_FLOWING scroll this frame. */
  private warpScroll = 0;
  /** DrawGLFlowingPoly's scroll this frame, for unwarped opaque faces. */
  private flowScroll = 0;
  /** View-projection of the last rendered frame. */
  viewProj: Float32Array = new Float32Array(16);
  private cluster = Number.NaN;
  private cluster2 = Number.NaN;
  /** Area of the eye the world draw list was built for, -1 with noAreas. */
  private area = Number.NaN;
  /** Flood number per area (floodAreas) for the open portals (`setOpenPortals`). */
  private flood: Int32Array;
  /** The set `flood` was last asked for. */
  private openPortals: ReadonlySet<number>;
  private vis: WorldVis = { nodes: new Uint8Array(0), leafs: new Uint8Array(0) };
  private visibleFaces = 0;
  private readonly worldWalk: WorldWalk;
  private readonly worldDraws: WorldDraws;
  private readonly skyProgram: WebGLProgram;
  private readonly skyVao: WebGLVertexArrayObject;
  private readonly skyVertexBuffer: WebGLBuffer;
  private readonly uSkyViewProj: WebGLUniformLocation | null;
  private readonly uSkyModel: WebGLUniformLocation | null;
  private readonly skyBounds = newSkyBounds();
  /** Sky images in SKY_SUFFIXES order. */
  private skyTextures: WebGLTexture[] = [];
  /** What R_SetSky was given; no sky name and no rotation until setSky. */
  private sky: SkySettings = { name: "", rotate: 0, axis: [0, 0, 0] };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly bsp: Bsp,
    textureSource: TextureSource,
    brushModels: readonly BrushModelInstance[] = [],
    lightStyles?: ArrayLike<number>,
    /** Open area portal numbers (openAreaPortals); the rest are closed. */
    openPortals: ReadonlySet<number> = new Set(),
  ) {
    this.flood = floodAreas(bsp, openPortals);
    this.openPortals = openPortals;
    this.instances = new PlacedInstances(bsp);
    const atlas = buildLightmapAtlas(bsp, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, lightStyles);
    this.atlas = atlas;
    this.mesh = buildWorldMesh(bsp, atlas);
    this.worldWalk = new WorldWalk(bsp);
    this.worldDraws = new WorldDraws(this.mesh);

    this.program = linkProgram(gl, VS, FS);
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj");
    this.uModel = gl.getUniformLocation(this.program, "uModel");
    this.uTexSize = gl.getUniformLocation(this.program, "uTexSize");
    this.uWarp = gl.getUniformLocation(this.program, "uWarp");
    this.uTime = gl.getUniformLocation(this.program, "uTime");
    this.uScroll = gl.getUniformLocation(this.program, "uScroll");
    this.uAlpha = gl.getUniformLocation(this.program, "uAlpha");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTex"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uLightmap"), 1);
    gl.uniform4fv(gl.getUniformLocation(this.program, "uTurbSin"), TURBSIN);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertices, gl.STATIC_DRAW);
    const stride = VERTEX_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 20);
    this.indexBuffer = gl.createBuffer();
    this.alphaIndexBuffer = gl.createBuffer();
    gl.bindVertexArray(null);

    // Each model's lists are built once and shared by every instance of it: its opaque
    // faces, then its translucent ones in alpha pass order.
    const lists = new Map<number, { base: number; list: DrawList; alpha: ReturnType<typeof buildOrderedDraws>; faces: number[] }>();
    let total = 0;
    for (const inst of brushModels) {
      if (lists.has(inst.model)) continue;
      const mask = modelFaceMask(bsp, inst.model);
      const list = buildDrawList(this.mesh, mask);
      const alpha = buildOrderedDraws(this.mesh, brushModelAlphaOrder(list.translucent));
      const faces: number[] = [];
      mask.forEach((m, f) => m && faces.push(f));
      lists.set(inst.model, { base: total, list, alpha, faces });
      total += list.indices.length + alpha.indices.length;
    }
    const brushIndices = new Uint32Array(total);
    for (const { base, list, alpha } of lists.values()) {
      brushIndices.set(list.indices, base);
      brushIndices.set(alpha.indices, base + list.indices.length);
    }
    for (const inst of brushModels) {
      const { base, list, alpha, faces } = lists.get(inst.model)!;
      if (list.draws.length === 0 && alpha.draws.length === 0) continue;
      const alphaBase = base + list.indices.length;
      this.instances.list.push({
        ...placeInstance(bsp, inst),
        modelIndex: inst.model,
        draws: list.draws.map((d) => ({ ...d, first: d.first + base })),
        alphaDraws: alpha.draws.map((d) => ({ ...d, first: d.first + alphaBase })),
        alphaFaces: list.translucent.length,
        faces,
      });
    }
    this.brushIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.brushIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, brushIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    this.setTextures(textureSource);
    this.lightmap = uploadTexture(gl, atlas, "lightmap");

    this.skyProgram = linkProgram(gl, SKY_VS, SKY_FS);
    this.uSkyViewProj = gl.getUniformLocation(this.skyProgram, "uViewProj");
    this.uSkyModel = gl.getUniformLocation(this.skyProgram, "uModel");
    gl.useProgram(this.skyProgram);
    gl.uniform1i(gl.getUniformLocation(this.skyProgram, "uTex"), 0);
    this.skyVao = gl.createVertexArray();
    gl.bindVertexArray(this.skyVao);
    this.skyVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * SKY_VERTEX_FLOATS * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, SKY_VERTEX_FLOATS * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, SKY_VERTEX_FLOATS * 4, 12);
    // Each side is a GL_QUADS quad of four vertices: two triangles sharing its first corner.
    const quadIndices = new Uint16Array(6 * 6);
    for (let q = 0; q < 6; q++) quadIndices.set([0, 1, 2, 0, 2, 3].map((i) => q * 4 + i), q * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.setSky(this.sky, []);
  }

  /**
   * R_SetSky: the worldspawn sky settings and the six images in SKY_SUFFIXES order; a
   * missing image draws r_notexture, as the engine does.
   */
  setSky(settings: SkySettings, images: readonly (TextureImage | undefined)[]): void {
    const { gl } = this;
    this.sky = settings;
    for (const t of this.skyTextures) gl.deleteTexture(t);
    const fallback = notexture();
    // it_sky images are not mipmapped and keep GL's default repeat; MakeSkyVec's clamp
    // keeps bilinear filtering off the far edge. r_notexture is a mipmapped wall image
    // in the engine; stretched over a sky side it is only ever magnified, so the same
    // upload serves.
    this.skyTextures = [0, 1, 2, 3, 4, 5].map((i) => uploadTexture(gl, images[i] ?? fallback, "sky"));
  }

  /** Replace every surface texture, e.g. after game data is mounted. */
  setTextures(source: TextureSource): void {
    const { images, missing } = resolveTextures(this.mesh.textures, source);
    for (const t of this.textures) this.gl.deleteTexture(t.tex);
    this.textures = images.map((img) => ({ tex: uploadTexture(this.gl, img, "surface"), width: img.width, height: img.height }));
    this.missingTextures = missing;
  }

  /**
   * Set the brightness of each light style (lightStyleValues). Faces on a changed style
   * are composed again and uploaded when next drawn (render).
   */
  setLightStyles(values: ArrayLike<number>): void {
    setLightmapStyles(this.bsp, this.atlas, values);
  }

  /** Compose and upload the stale lightmaps among `faces`; returns how many. */
  private refreshLightmaps(faces: Iterable<number>): number {
    const stale = refreshLightmaps(this.bsp, this.atlas, faces);
    if (stale.length === 0) return 0;
    const { gl, atlas } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, atlas.width);
    for (const f of stale) {
      const r = atlas.rects[f]!;
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.width, r.height, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
    }
    // Other uploads read whole, tightly packed images.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.activeTexture(gl.TEXTURE0);
    return stale.length;
  }

  /** Move brush entities, by entity index, as PlacedInstances.move does. */
  moveBrushModels(drawn: ReadonlyMap<number, Pose>, linked: ReadonlyMap<number, Pose> = drawn): void {
    this.instances.move(drawn, linked);
  }

  /**
   * Set the open area portals (the rest are closed), as cl.frame.areabits changes with
   * the frame: the world and brush models of the next render are culled by them.
   */
  setOpenPortals(open: ReadonlySet<number>): void {
    if (open === this.openPortals) return;
    this.openPortals = open;
    const flood = floodAreas(this.bsp, open);
    if (flood.every((f, a) => f === this.flood[a])) return;
    this.flood = flood;
    // The world's draw list is cached by the eye's area; its area bits are stale now.
    this.area = Number.NaN;
  }

  /** Set the level time in milliseconds that warps move with. */
  setTime(ms: number): void {
    // r_newrefdef.time is a float, in seconds.
    this.time = Math.fround(ms * 0.001);
  }

  render(view: View, width: number, height: number): FrameStats {
    const { gl, bsp } = this;
    const { leaf, cluster, cluster2 } = viewClusters(bsp, view.origin);
    // The server finds the client's area, and the fat PVS for brush models, with
    // CM_PointLeafnum, which can pick the other leaf of a plane the eye is on.
    const serverLeaf = pointLeaf(bsp, view.origin[0], view.origin[1], view.origin[2]);
    // A leaf area outside the areas lump (a corrupt map) counts as area 0, so the map still draws.
    const leafArea = bsp.leafs.area[serverLeaf] ?? 0;
    const area = leafArea > 0 && leafArea < this.flood.length ? leafArea : 0;
    // The world's area bits depend on the eye's area and on the flood, which
    // `setOpenPortals` clears the cached area for when it changes.
    const worldArea = this.noAreas ? -1 : area;
    if (cluster !== this.cluster || cluster2 !== this.cluster2 || worldArea !== this.area) {
      this.cluster = cluster;
      this.cluster2 = cluster2;
      this.area = worldArea;
      const bits = worldArea > 0 ? areaBits(this.flood, worldArea) : undefined;
      this.vis = worldVis(bsp, cluster, bits, cluster2);
      const mask = visibleFaceMask(bsp, this.mesh, cluster, bits, cluster2);
      this.visibleFaces = mask.reduce((n, m, f) => (m && this.mesh.faceTexture[f]! >= 0 ? n + 1 : n), 0);
    }
    const aspect = width / height;
    const fy = fovY(FOV_X, aspect);
    const proj = perspective(fy, aspect, NEAR, FAR);
    this.viewProj = multiply(proj, viewMatrix(view.origin, view.pitch, view.yaw));
    const planes = frustumPlanes(this.viewProj);
    // R_CullBox tests the four side planes only.
    const faces = this.worldWalk.walk(this.mesh, this.vis, view.origin, this.cull ? planes.slice(0, 4) : undefined);
    const world = this.worldDraws;
    const rebuild = world.update(faces);
    // Farthest a near-plane point lies from the eye on any axis is at most its corner distance.
    const nearCorner = NEAR * Math.hypot(1, Math.tan((FOV_X * Math.PI) / 360), Math.tan((fy * Math.PI) / 360));
    const fat = fatClusters(bsp, view.origin, bsp.leafs.cluster[serverLeaf] ?? -1, Math.max(8, nearCorner));
    this.instances.testPvs(fat);

    // Any model point on screen is seen along a ray from a point of the near plane, which
    // is inside the fat PVS box, and the model's box touches the leaf the point is in.
    // Where the near plane is inside solid, models and world alike can show a cluster
    // past this, as in the engine.
    let areaCulled = 0, pvsCulled = 0, frustumCulled = 0;
    const eyeArea = this.noAreas ? 0 : area;
    const drawn: InstanceDraws[] = [];
    for (const inst of this.instances.list) {
      if (this.cull && !areasVisible(this.flood, eyeArea, inst.areas)) {
        areaCulled++;
        continue;
      }
      if (this.cull && !inst.inPvs) {
        pvsCulled++;
        continue;
      }
      if (this.cull && boxOutsideFrustum(planes, inst.box)) {
        frustumCulled++;
        continue;
      }
      drawn.push(inst);
    }
    // ref_gl rebuilds a surface's lightmap as it draws it, so a face out of view keeps
    // its old light until it is drawn again.
    let lightmapUploads = this.refreshLightmaps(faces);
    for (const inst of drawn) lightmapUploads += this.refreshLightmaps(inst.faces);

    gl.viewport(0, 0, width, height);
    gl.clearColor(CLEAR_COLOR[0] / 255, CLEAR_COLOR[1] / 255, CLEAR_COLOR[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // Quake 2 winds faces clockwise seen from the front.
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
    gl.activeTexture(gl.TEXTURE0);
    // The element array binding is VAO state, so both buffers are bound with the VAO bound.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    if (rebuild) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, world.indices.subarray(0, world.indexCount), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(this.uModel, false, IDENTITY);
    gl.uniform1f(this.uTime, this.time);
    // EmitWaterPolys' scroll for SURF_FLOWING warps, computed as the C does in double; its
    // store to float scroll is uniform1f's rounding.
    this.warpScroll = -64 * (this.time * 0.5 - Math.trunc(this.time * 0.5));
    this.flowScroll = flowingScroll(this.time);
    this.drawRanges(world.draws);
    let draws = world.draws.length;
    // R_DrawWorld ends with the sky box, before any entity.
    const sky = this.drawSkyBox(view.origin);
    draws += sky.sides;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.brushIndexBuffer);
    for (const inst of drawn) {
      gl.uniformMatrix4fv(this.uModel, false, inst.model);
      this.drawRanges(inst.draws);
      draws += inst.draws.length;
    }

    // Alpha pass (R_DrawAlphaSurfaces): blended, depth tested and written as ref_gl
    // leaves it. Brush models were prepended to the alpha chain after the world
    // (brushInstanceAlphaOrder), so they draw before the world's back-to-front faces.
    // ref_gl draws them all with the world matrix, so a moved or rotated brush model's
    // translucent faces stay at their compiled spot there; here they move with their
    // entity.
    let alphaFaces = 0;
    const order = world.alpha;
    if (drawn.some((i) => i.alphaDraws.length > 0) || order.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const inst of brushInstanceAlphaOrder(drawn)) {
        if (inst.alphaDraws.length === 0) continue;
        gl.uniformMatrix4fv(this.uModel, false, inst.model);
        this.drawRanges(inst.alphaDraws);
        draws += inst.alphaDraws.length;
        alphaFaces += inst.alphaFaces;
      }
      if (order.length > 0) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.alphaIndexBuffer);
        if (!sameOrder(order, this.alphaOrder)) {
          const list = buildOrderedDraws(this.mesh, order);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, list.indices, gl.DYNAMIC_DRAW);
          this.alphaOrder = order;
          this.alphaDraws = list.draws;
        }
        gl.uniformMatrix4fv(this.uModel, false, IDENTITY);
        this.drawRanges(this.alphaDraws);
        draws += this.alphaDraws.length;
        alphaFaces += order.length;
      }
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    return {
      leaf,
      cluster,
      cluster2,
      area,
      visibleFaces: this.visibleFaces,
      drawnFaces: faces.length,
      brushModels: drawn.length,
      areaCulled,
      pvsCulled,
      frustumCulled,
      alphaFaces,
      skyPolygons: sky.polygons,
      skySides: sky.sides,
      draws,
      lightmapUploads,
    };
  }

  /**
   * R_AddSkySurface for each world sky face R_RecursiveWorldNode passed, then
   * R_DrawSkyBox: depth tested and written, after the world's opaque faces, so nearer
   * geometry hides the box and anything drawn behind a sky face nearer than the box shows
   * through it, as in the engine.
   */
  private drawSkyBox(eye: readonly [number, number, number]): { polygons: number; sides: number } {
    const { gl, bsp, mesh } = this;
    const bounds = this.skyBounds;
    clearSkyBounds(bounds);
    let polygons = 0;
    const f32 = Math.fround;
    const ex = f32(eye[0]), ey = f32(eye[1]), ez = f32(eye[2]);
    for (const f of this.worldDraws.sky) {
      const p0 = mesh.faceFirstPoly[f]!;
      for (let p = p0; p < p0 + mesh.faceNumPolys[f]!; p++) {
        const v0 = mesh.polyFirstVertex[p]!;
        const n = mesh.polyNumVertices[p]!;
        const points = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const o = (v0 + i) * VERTEX_FLOATS;
          points[i * 3] = mesh.vertices[o]! - ex;
          points[i * 3 + 1] = mesh.vertices[o + 1]! - ey;
          points[i * 3 + 2] = mesh.vertices[o + 2]! - ez;
        }
        polygons += addSkyPolygon(bounds, points, n);
      }
    }
    const { vertices, quads } = skyBoxQuads(bounds, this.sky.rotate);
    if (quads.length === 0) return { polygons, sides: 0 };
    gl.useProgram(this.skyProgram);
    gl.uniformMatrix4fv(this.uSkyViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(this.uSkyModel, false, skyMatrix(eye, this.time, this.sky.rotate, this.sky.axis));
    gl.bindVertexArray(this.skyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyVertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    quads.forEach((q, k) => {
      gl.bindTexture(gl.TEXTURE_2D, this.skyTextures[q.image]!);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, k * 6 * 2);
    });
    return { polygons, sides: quads.length };
  }

  private drawRanges(ranges: readonly DrawRange[]): void {
    const { gl } = this;
    for (const d of ranges) {
      const t = this.textures[d.texture]!;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform2f(this.uTexSize, t.width, t.height);
      gl.uniform1i(this.uWarp, d.flags & SURF_WARP ? 1 : 0);
      // Unwarped translucent faces go through DrawGLPoly, which does not scroll.
      const scroll = d.flags & SURF_WARP ? this.warpScroll : d.flags & SURF_TRANSLUCENT ? 0 : this.flowScroll;
      gl.uniform1f(this.uScroll, d.flags & SURF_FLOWING ? scroll : 0);
      // R_DrawAlphaSurfaces tests TRANS33 first.
      gl.uniform1f(this.uAlpha, d.flags & SURF_TRANS33 ? 0.33 : d.flags & SURF_TRANS66 ? 0.66 : 1);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4);
    }
  }
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

function uploadTexture(gl: WebGL2RenderingContext, img: TextureImage, kind: "surface" | "lightmap" | "sky"): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
  const wrap = kind === "lightmap" ? gl.CLAMP_TO_EDGE : gl.REPEAT;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (kind === "surface") {
    // Surface textures: mipmapped, crisp up close like the software renderer.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  } else {
    // Lightmap atlas: bilinear between luxels, no mips (they would bleed across faces).
    // Sky: bilinear (gl_filter_max) and unmipmapped, as GL_Upload32 leaves it_sky.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  return tex;
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("createShader failed");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(sh)}`);
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);
  return program;
}
