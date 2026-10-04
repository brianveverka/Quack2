// SPDX-License-Identifier: GPL-2.0-or-later
// WebGL2 world renderer: one static vertex buffer for every model, a world index buffer
// rebuilt when the eye changes cluster, a static index buffer for the brush models drawn
// at their entity origins and angles, one draw per texture per model. Brush models
// outside the eye's PVS or the view frustum are skipped.

import { pointLeaf, type Bsp } from "@quack2/sim";
import type { BrushModelInstance } from "./bmodels.js";
import { boxClusters, boxOutsideFrustum, clustersVisible, fatClusters, frustumPlanes, instanceBox, pvsUnion, type Box } from "./cull.js";
import { buildLightmapAtlas } from "./lightmap.js";
import { fovY, modelMatrix, multiply, perspective, viewMatrix, type Mat4 } from "./math.js";
import { resolveTextures, type TextureImage, type TextureSource } from "./textures.js";
import {
  VERTEX_FLOATS,
  buildDrawList,
  buildWorldMesh,
  modelFaceMask,
  visibleFaceMask,
  type DrawList,
  type DrawRange,
  type WorldMesh,
} from "./world.js";

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aST;
layout(location = 2) in vec2 aLM;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec2 uTexSize;
out vec2 vUV;
out vec2 vLM;
void main() {
  vUV = aST / uTexSize;
  vLM = aLM;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uLightmap;
in vec2 vUV;
in vec2 vLM;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUV).rgb * texture(uLightmap, vLM).rgb, 1.0);
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
  readonly draws: number;
}

interface InstanceDraws {
  /** Model to world: entity angles, then origin. */
  readonly model: Mat4;
  /** Ranges in the brush model index buffer. */
  readonly draws: readonly DrawRange[];
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
  private readonly lightmap: WebGLTexture;
  private readonly uViewProj: WebGLUniformLocation | null;
  private readonly uModel: WebGLUniformLocation | null;
  private readonly uTexSize: WebGLUniformLocation | null;
  /** View-projection of the last rendered frame. */
  viewProj: Float32Array = new Float32Array(16);
  private cluster = Number.NaN;
  /** Clusters of the fat PVS the brush models were last tested against. */
  private fatKey: string | undefined = "";
  private drawList: DrawList = { indices: new Uint32Array(0), draws: [], visibleFaces: 0 };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly bsp: Bsp,
    textureSource: TextureSource,
    brushModels: readonly BrushModelInstance[] = [],
  ) {
    const atlas = buildLightmapAtlas(bsp, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.mesh = buildWorldMesh(bsp, atlas);

    this.program = linkProgram(gl, VS, FS);
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj");
    this.uModel = gl.getUniformLocation(this.program, "uModel");
    this.uTexSize = gl.getUniformLocation(this.program, "uTexSize");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTex"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uLightmap"), 1);

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
    gl.bindVertexArray(null);

    // Each model's lists are built once and shared by every instance of it.
    const lists = new Map<number, { base: number; list: DrawList }>();
    let total = 0;
    for (const inst of brushModels) {
      if (lists.has(inst.model)) continue;
      const list = buildDrawList(this.mesh, modelFaceMask(bsp, inst.model));
      lists.set(inst.model, { base: total, list });
      total += list.indices.length;
    }
    const brushIndices = new Uint32Array(total);
    for (const { base, list } of lists.values()) brushIndices.set(list.indices, base);
    for (const inst of brushModels) {
      const { base, list } = lists.get(inst.model)!;
      if (list.draws.length === 0) continue;
      const box = instanceBox(bsp, inst);
      this.instances.push({
        model: modelMatrix(inst.origin, inst.angles),
        draws: list.draws.map((d) => ({ ...d, first: d.first + base })),
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
    this.drawRanges(this.drawList.draws);
    let draws = this.drawList.draws.length;
    // Any model point on screen is seen along a ray from a point of the near plane, which
    // is inside the fat PVS box, and the model's box touches the leaf the point is in.
    // Where the near plane is inside solid, models and world alike can show a cluster
    // past this, as in the engine.
    const planes = frustumPlanes(this.viewProj);
    let brushModels = 0, pvsCulled = 0, frustumCulled = 0;
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
    }
    gl.bindVertexArray(null);
    return { leaf, cluster, visibleFaces: this.drawList.visibleFaces, brushModels, pvsCulled, frustumCulled, draws };
  }

  private drawRanges(ranges: readonly DrawRange[]): void {
    const { gl } = this;
    for (const d of ranges) {
      const t = this.textures[d.texture]!;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform2f(this.uTexSize, t.width, t.height);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4);
    }
  }
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
