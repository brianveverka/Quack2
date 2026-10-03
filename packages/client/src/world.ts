// SPDX-License-Identifier: GPL-2.0-or-later
// World model (model 0) mesh: one vertex per face corner, triangle fans, and per-cluster
// index lists from the PVS. DOM-free so it is testable under Node.

import { SURF_NODRAW, clusterPvs, faceVertexIndices, texCoord, type Bsp } from "@quack2/sim";
import { lightmapUv, type LightmapAtlas } from "./lightmap.js";

/** Floats per vertex: position xyz, texture st (texels), lightmap uv (atlas 0..1). */
export const VERTEX_FLOATS = 7;

export interface WorldMesh {
  readonly vertices: Float32Array;
  /** Distinct texinfo texture names, indexed by `faceTexture`. */
  readonly textures: readonly string[];
  /** Per face: index into `textures`, or -1 if the face is not drawn. */
  readonly faceTexture: Int32Array;
  /** Per face: first vertex and corner count in `vertices`. */
  readonly faceFirstVertex: Uint32Array;
  readonly faceNumVertices: Uint32Array;
  /** Faces of model 0: [first, first + count). Leafs of brush models reference others. */
  readonly firstFace: number;
  readonly numFaces: number;
}

export function buildWorldMesh(bsp: Bsp, atlas: LightmapAtlas): WorldMesh {
  const firstFace = bsp.models.firstFace[0] ?? 0;
  const numFaces = bsp.models.numFaces[0] ?? 0;
  const n = bsp.faces.count;
  const faceTexture = new Int32Array(n).fill(-1);
  const faceFirstVertex = new Uint32Array(n);
  const faceNumVertices = new Uint32Array(n);
  const textures: string[] = [];
  const textureIndex = new Map<string, number>();
  const verts: number[] = [];
  const pos = bsp.vertexes.position;

  for (let f = firstFace; f < firstFace + numFaces; f++) {
    const ti = bsp.faces.texinfo[f]!;
    if (bsp.texinfo.flags[ti]! & SURF_NODRAW) continue;
    const name = bsp.texinfo.texture[ti]!;
    let tex = textureIndex.get(name);
    if (tex === undefined) {
      tex = textures.push(name) - 1;
      textureIndex.set(name, tex);
    }
    faceTexture[f] = tex;
    faceFirstVertex[f] = verts.length / VERTEX_FLOATS;
    const corners = faceVertexIndices(bsp, f);
    faceNumVertices[f] = corners.length;
    for (const v of corners) {
      const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
      const [s, t] = texCoord(bsp, ti, x, y, z);
      const [lu, lv] = lightmapUv(atlas, f, s, t);
      verts.push(x, y, z, s, t, lu, lv);
    }
  }
  return { vertices: new Float32Array(verts), textures, faceTexture, faceFirstVertex, faceNumVertices, firstFace, numFaces };
}

export interface DrawRange {
  readonly texture: number;
  /** Offset and count in indices (not bytes). */
  readonly first: number;
  readonly count: number;
}

export interface DrawList {
  readonly indices: Uint32Array;
  readonly draws: readonly DrawRange[];
  readonly visibleFaces: number;
}

/**
 * Faces potentially visible from `cluster`, as world-model face flags. Cluster -1 (the
 * eye is in solid or outside the map) marks every face, as the engine's novis path does.
 */
export function visibleFaceMask(bsp: Bsp, mesh: WorldMesh, cluster: number): Uint8Array {
  const mask = new Uint8Array(bsp.faces.count);
  const end = mesh.firstFace + mesh.numFaces;
  if (cluster < 0 || bsp.visibility.numClusters === 0) {
    mask.fill(1, mesh.firstFace, end);
    return mask;
  }
  const pvs = clusterPvs(bsp, cluster);
  const { leafs, leafFaces } = bsp;
  for (let l = 0; l < leafs.count; l++) {
    const c = leafs.cluster[l]!;
    if (c < 0 || !(pvs[c >> 3]! & (1 << (c & 7)))) continue;
    const first = leafs.firstLeafFace[l]!;
    for (let k = 0; k < leafs.numLeafFaces[l]!; k++) {
      const f = leafFaces[first + k]!;
      if (f >= mesh.firstFace && f < end) mask[f] = 1;
    }
  }
  return mask;
}

/** Triangle-fan indices for the masked faces, grouped by texture into one draw each. */
export function buildDrawList(mesh: WorldMesh, mask: Uint8Array): DrawList {
  const perTexture: number[][] = mesh.textures.map(() => []);
  let visibleFaces = 0;
  for (let f = mesh.firstFace; f < mesh.firstFace + mesh.numFaces; f++) {
    const tex = mesh.faceTexture[f]!;
    if (!mask[f] || tex < 0) continue;
    visibleFaces++;
    const v0 = mesh.faceFirstVertex[f]!;
    const list = perTexture[tex]!;
    for (let i = 2; i < mesh.faceNumVertices[f]!; i++) list.push(v0, v0 + i - 1, v0 + i);
  }
  const draws: DrawRange[] = [];
  const indices = new Uint32Array(perTexture.reduce((a, l) => a + l.length, 0));
  let o = 0;
  perTexture.forEach((list, texture) => {
    if (list.length === 0) return;
    draws.push({ texture, first: o, count: list.length });
    indices.set(list, o);
    o += list.length;
  });
  return { indices, draws, visibleFaces };
}
