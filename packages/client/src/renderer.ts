// SPDX-License-Identifier: GPL-2.0-or-later
// WebGL2 world renderer: one static vertex buffer for every model, a world index buffer
// rebuilt when the eye changes cluster, a static index buffer for the brush models drawn
// at their entity origins and angles, one draw per texture and surface flags per model.
// Brush models outside the eye's PVS or the view frustum are skipped. Warped faces
// (SURF_WARP) are moved in the vertex shader as EmitWaterPolys does; translucent ones
// (SURF_TRANS33/66) are blended last, in R_DrawAlphaSurfaces' order.

import { SURF_FLOWING, SURF_TRANS33, SURF_TRANS66, SURF_WARP, pointLeaf, type Bsp } from "@quack2/sim";
import type { BrushModelInstance } from "./bmodels.js";
import { boxClusters, boxOutsideFrustum, clustersVisible, fatClusters, frustumPlanes, instanceBox, pvsUnion, type Box } from "./cull.js";
import { buildLightmapAtlas, updateLightmapAtlas, type LightmapAtlas } from "./lightmap.js";
import { fovY, modelMatrix, multiply, perspective, viewMatrix, type Mat4 } from "./math.js";
import { resolveTextures, type TextureImage, type TextureSource } from "./textures.js";
import { TURBSIN } from "./warp.js";
import {
  SURF_TRANSLUCENT,
  VERTEX_FLOATS,
  brushModelAlphaOrder,
  buildDrawList,
  buildOrderedDraws,
  buildWorldMesh,
  modelFaceMask,
  visibleFaceMask,
  worldAlphaOrder,
  type DrawList,
  type DrawRange,
  type WorldMesh,
} from "./world.js";

// The warp is EmitWaterPolys per vertex: r_turbsin packed four to a vec4 (a float[256]
// would take 256 uniform vectors, all WebGL2 guarantees). int() truncates as the C cast
// does and `& 255` wraps negatives as two's complement does. Here the argument is
// evaluated in single precision, the engine's in double, so a vertex near a table step
// can pick the neighbouring entry.
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
    vUV = aST / uTexSize;
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
  readonly leaf: number;
  readonly cluster: number;
  /** World faces in the PVS; brush model faces are not counted. */
  readonly visibleFaces: number;
  /** Brush model instances drawn. */
  readonly brushModels: number;
  /** Brush model instances skipped: touching no cluster in the eye's PVS. */
  readonly pvsCulled: number;
  /** Brush model instances in the PVS but skipped: wholly outside the view frustum. */
  readonly frustumCulled: number;
  /** Translucent faces sent to the alpha pass, brush models' included (their back faces too, which the GPU culls). */
  readonly alphaFaces: number;
  readonly draws: number;
}

interface InstanceDraws {
  /** Model to world: entity angles, then origin. */
  readonly model: Mat4;
  /** Ranges in the brush model index buffer. */
  readonly draws: readonly DrawRange[];
  /** Translucent faces' ranges in the brush model index buffer, in alpha pass order. */
  readonly alphaDraws: readonly DrawRange[];
  readonly alphaFaces: number;
  /** World box enclosing the instance. */
  readonly box: Box;
  /** Distinct non-solid clusters the box touches. Computed once: models do not move yet; a mover must recompute this and `box`. */
  readonly clusters: readonly number[];
  /** In the fat PVS of the current eye position. */
  inPvs: boolean;
}

export class WorldRenderer {
  readonly mesh: WorldMesh;
  /** Texture names drawn as a checker placeholder. */
  missingTextures: readonly string[] = [];
  /** Brush model culling, on by default; off draws every instance (the engine's r_nocull, for the server's PVS test too). */
  cull = true;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly indexBuffer: WebGLBuffer;
  private readonly brushIndexBuffer: WebGLBuffer;
  private readonly instances: InstanceDraws[] = [];
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
  private scroll = 0;
  /** View-projection of the last rendered frame. */
  viewProj: Float32Array = new Float32Array(16);
  private cluster = Number.NaN;
  /** Clusters of the fat PVS the brush models were last tested against. */
  private fatKey: string | undefined = "";
  private drawList: DrawList = { indices: new Uint32Array(0), draws: [], visibleFaces: 0, translucent: [] };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly bsp: Bsp,
    textureSource: TextureSource,
    brushModels: readonly BrushModelInstance[] = [],
    lightStyles?: ArrayLike<number>,
  ) {
    const atlas = buildLightmapAtlas(bsp, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, lightStyles);
    this.atlas = atlas;
    this.mesh = buildWorldMesh(bsp, atlas);

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
    const lists = new Map<number, { base: number; list: DrawList; alpha: ReturnType<typeof buildOrderedDraws> }>();
    let total = 0;
    for (const inst of brushModels) {
      if (lists.has(inst.model)) continue;
      const list = buildDrawList(this.mesh, modelFaceMask(bsp, inst.model));
      const alpha = buildOrderedDraws(this.mesh, brushModelAlphaOrder(list.translucent));
      lists.set(inst.model, { base: total, list, alpha });
      total += list.indices.length + alpha.indices.length;
    }
    const brushIndices = new Uint32Array(total);
    for (const { base, list, alpha } of lists.values()) {
      brushIndices.set(list.indices, base);
      brushIndices.set(alpha.indices, base + list.indices.length);
    }
    for (const inst of brushModels) {
      const { base, list, alpha } = lists.get(inst.model)!;
      if (list.draws.length === 0 && alpha.draws.length === 0) continue;
      const box = instanceBox(bsp, inst);
      const alphaBase = base + list.indices.length;
      this.instances.push({
        model: modelMatrix(inst.origin, inst.angles),
        draws: list.draws.map((d) => ({ ...d, first: d.first + base })),
        alphaDraws: alpha.draws.map((d) => ({ ...d, first: d.first + alphaBase })),
        alphaFaces: list.translucent.length,
        box,
        clusters: boxClusters(bsp, box),
        inPvs: true,
      });
    }
    this.brushIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.brushIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, brushIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    this.setTextures(textureSource);
    this.lightmap = uploadTexture(gl, atlas, false);
  }

  /** Replace every surface texture, e.g. after game data is mounted. */
  setTextures(source: TextureSource): void {
    const { images, missing } = resolveTextures(this.mesh.textures, source);
    for (const t of this.textures) this.gl.deleteTexture(t.tex);
    this.textures = images.map((img) => ({ tex: uploadTexture(this.gl, img, true), width: img.width, height: img.height }));
    this.missingTextures = missing;
  }

  /**
   * Set the brightness of each light style (lightStyleValues) and upload the lightmap of
   * every face whose composed light changed. Returns how many faces were uploaded.
   */
  setLightStyles(values: ArrayLike<number>): number {
    const faces = updateLightmapAtlas(this.bsp, this.atlas, values);
    if (faces.length === 0) return 0;
    const { gl, atlas } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, atlas.width);
    for (const f of faces) {
      const r = atlas.rects[f]!;
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.width, r.height, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
    }
    // Other uploads read whole, tightly packed images.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    return faces.length;
  }

  /** Set the level time in milliseconds that warps move with. */
  setTime(ms: number): void {
    // r_newrefdef.time is a float, in seconds.
    this.time = Math.fround(ms * 0.001);
  }

  render(view: View, width: number, height: number): FrameStats {
    const { gl, bsp } = this;
    const leaf = pointLeaf(bsp, view.origin[0], view.origin[1], view.origin[2]);
    const cluster = bsp.leafs.cluster[leaf] ?? -1;
    const rebuild = cluster !== this.cluster;
    if (rebuild) {
      this.cluster = cluster;
      this.drawList = buildDrawList(this.mesh, visibleFaceMask(bsp, this.mesh, cluster));
    }
    const aspect = width / height;
    const fy = fovY(FOV_X, aspect);
    // Farthest a near-plane point lies from the eye on any axis is at most its corner distance.
    const nearCorner = NEAR * Math.hypot(1, Math.tan((FOV_X * Math.PI) / 360), Math.tan((fy * Math.PI) / 360));
    const fat = fatClusters(bsp, view.origin, cluster, Math.max(8, nearCorner));
    const fatKey = fat?.join(",");
    if (fatKey !== this.fatKey) {
      this.fatKey = fatKey;
      const pvs = fat && pvsUnion(bsp, fat);
      for (const inst of this.instances) inst.inPvs = !pvs || clustersVisible(inst.clusters, pvs);
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(CLEAR_COLOR[0] / 255, CLEAR_COLOR[1] / 255, CLEAR_COLOR[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // Quake 2 winds faces clockwise seen from the front.
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);

    const proj = perspective(fy, aspect, NEAR, FAR);
    gl.useProgram(this.program);
    this.viewProj = multiply(proj, viewMatrix(view.origin, view.pitch, view.yaw));
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
    gl.activeTexture(gl.TEXTURE0);
    // The element array binding is VAO state, so both buffers are bound with the VAO bound.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    if (rebuild) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.drawList.indices, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(this.uModel, false, IDENTITY);
    gl.uniform1f(this.uTime, this.time);
    // EmitWaterPolys' scroll for SURF_FLOWING warps, computed as the C does in double.
    this.scroll = -64 * (this.time * 0.5 - Math.trunc(this.time * 0.5));
    this.drawRanges(this.drawList.draws);
    let draws = this.drawList.draws.length;
    // Any model point on screen is seen along a ray from a point of the near plane, which
    // is inside the fat PVS box, and the model's box touches the leaf the point is in.
    // Where the near plane is inside solid, models and world alike can show a cluster
    // past this, as in the engine.
    const planes = frustumPlanes(this.viewProj);
    let brushModels = 0, pvsCulled = 0, frustumCulled = 0;
    const drawn: InstanceDraws[] = [];
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.brushIndexBuffer);
    for (const inst of this.instances) {
      if (this.cull && !inst.inPvs) {
        pvsCulled++;
        continue;
      }
      if (this.cull && boxOutsideFrustum(planes, inst.box)) {
        frustumCulled++;
        continue;
      }
      gl.uniformMatrix4fv(this.uModel, false, inst.model);
      this.drawRanges(inst.draws);
      draws += inst.draws.length;
      brushModels++;
      drawn.push(inst);
    }

    // Alpha pass (R_DrawAlphaSurfaces): blended, depth tested and written as ref_gl
    // leaves it. Brush models were prepended to the alpha chain after the world, the
    // last one first, so they draw before the world's back-to-front faces. ref_gl draws
    // them all with the world matrix, so a moved or rotated brush model's translucent
    // faces stay at their compiled spot there; here they move with their entity.
    let alphaFaces = 0;
    const order = worldAlphaOrder(bsp, this.drawList.translucent, view.origin);
    if (drawn.some((i) => i.alphaDraws.length > 0) || order.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (let k = drawn.length - 1; k >= 0; k--) {
        const inst = drawn[k]!;
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
    return { leaf, cluster, visibleFaces: this.drawList.visibleFaces, brushModels, pvsCulled, frustumCulled, alphaFaces, draws };
  }

  private drawRanges(ranges: readonly DrawRange[]): void {
    const { gl } = this;
    for (const d of ranges) {
      const t = this.textures[d.texture]!;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform2f(this.uTexSize, t.width, t.height);
      gl.uniform1i(this.uWarp, d.flags & SURF_WARP ? 1 : 0);
      gl.uniform1f(this.uScroll, d.flags & SURF_FLOWING ? this.scroll : 0);
      // R_DrawAlphaSurfaces tests TRANS33 first.
      gl.uniform1f(this.uAlpha, d.flags & SURF_TRANS33 ? 0.33 : d.flags & SURF_TRANS66 ? 0.66 : 1);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4);
    }
  }
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

function uploadTexture(gl: WebGL2RenderingContext, img: TextureImage, repeat: boolean): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (repeat) {
    // Surface textures: mipmapped, crisp up close like the software renderer.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  } else {
    // Lightmap atlas: bilinear between luxels, no mips (they would bleed across faces).
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
