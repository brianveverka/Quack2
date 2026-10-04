// SPDX-License-Identifier: GPL-2.0-or-later
// Mesh of every model's faces (the world, model 0, and the inline brush models), in
// model space: triangle fans, one per face, or one per 64-unit piece of a warped face,
// per-cluster index lists for the world from the PVS, and per-model index lists.
// Translucent faces are drawn after everything else, in the order ref_gl's
// R_DrawAlphaSurfaces gets them. DOM-free so it is testable under Node.

import {
  SURF_FLOWING,
  SURF_NODRAW,
  SURF_SKY,
  SURF_TRANS33,
  SURF_TRANS66,
  SURF_WARP,
  clusterPvs,
  faceVertexIndices,
  texCoord,
  type Bsp,
} from "@quack2/sim";
import { lightmapUv, type LightmapAtlas } from "./lightmap.js";
import { subdivideWarpPolygon } from "./warp.js";

/**
 * Floats per vertex: position xyz, texture st, lightmap uv (atlas 0..1). Texture st is in
 * texels, except on warped faces: there it is the untransformed s, t (no offset term)
 * that EmitWaterPolys warps and divides by 64.
 */
export const VERTEX_FLOATS = 7;

export const SURF_TRANSLUCENT = SURF_TRANS33 | SURF_TRANS66;
/** Texinfo flags that change how a face is drawn; draws group by texture and these. */
export const SURF_DRAW_FLAGS = SURF_SKY | SURF_WARP | SURF_TRANS33 | SURF_TRANS66 | SURF_FLOWING;

export interface WorldMesh {
  readonly vertices: Float32Array;
  /** Distinct texinfo texture names, indexed by `faceTexture`. */
  readonly textures: readonly string[];
  /** Per face: index into `textures`, or -1 if the face is not drawn. */
  readonly faceTexture: Int32Array;
  /** Per face: its texinfo flags masked to SURF_DRAW_FLAGS. */
  readonly faceFlags: Uint8Array;
  /** Per face: first vertex and vertex count in `vertices`, all its fans together. */
  readonly faceFirstVertex: Uint32Array;
  readonly faceNumVertices: Uint32Array;
  /**
   * Per face: its fans, `faceNumPolys` of them from `faceFirstPoly`, each `polyNumVertices`
   * vertices from `polyFirstVertex`. One fan of the face's corners, or for a warped face
   * GL_SubdivideSurface's pieces in the engine's list order.
   */
  readonly faceFirstPoly: Uint32Array;
  readonly faceNumPolys: Uint32Array;
  readonly polyFirstVertex: Uint32Array;
  readonly polyNumVertices: Uint32Array;
  /** Faces of model 0: [first, first + count). Leafs of brush models reference others. */
  readonly firstFace: number;
  readonly numFaces: number;
}

/** A model's face range, trimmed to the face lump so a corrupt map that warns still draws. */
export function modelFaces(bsp: Bsp, model: number): { first: number; end: number } {
  const n = bsp.faces.count;
  const start = bsp.models.firstFace[model] ?? 0;
  const end = Math.min(start + Math.max(bsp.models.numFaces[model] ?? 0, 0), n);
  const first = Math.min(Math.max(start, 0), n);
  return { first, end: Math.max(end, first) };
}

export function buildWorldMesh(bsp: Bsp, atlas: LightmapAtlas): WorldMesh {
  const world = modelFaces(bsp, 0);
  const n = bsp.faces.count;
  const faceTexture = new Int32Array(n).fill(-1);
  const faceFlags = new Uint8Array(n);
  const faceFirstVertex = new Uint32Array(n);
  const faceNumVertices = new Uint32Array(n);
  const faceFirstPoly = new Uint32Array(n);
  const faceNumPolys = new Uint32Array(n);
  const polyFirstVertex: number[] = [];
  const polyNumVertices: number[] = [];
  const textures: string[] = [];
  const textureIndex = new Map<string, number>();
  const verts: number[] = [];
  const pos = bsp.vertexes.position;
  // Model face ranges never overlap in compiler output. In a corrupt map that overlaps,
  // a face belongs to the lowest model claiming it, here and in modelFaceMask.
  const seen = new Uint8Array(n);

  for (let m = 0; m < bsp.models.count; m++) {
    const { first, end } = modelFaces(bsp, m);
    for (let f = first; f < end; f++) {
      if (seen[f]) continue;
      seen[f] = 1;
      addFace(f);
    }
  }
  return {
    vertices: new Float32Array(verts),
    textures,
    faceTexture,
    faceFlags,
    faceFirstVertex,
    faceNumVertices,
    faceFirstPoly,
    faceNumPolys,
    polyFirstVertex: Uint32Array.from(polyFirstVertex),
    polyNumVertices: Uint32Array.from(polyNumVertices),
    firstFace: world.first,
    numFaces: world.end - world.first,
  };

  function addFace(f: number): void {
    const ti = bsp.faces.texinfo[f]!;
    if (bsp.texinfo.flags[ti]! & SURF_NODRAW) return;
    const name = bsp.texinfo.texture[ti]!;
    let tex = textureIndex.get(name);
    if (tex === undefined) {
      tex = textures.push(name) - 1;
      textureIndex.set(name, tex);
    }
    const flags = bsp.texinfo.flags[ti]! & SURF_DRAW_FLAGS;
    faceTexture[f] = tex;
    faceFlags[f] = flags;
    const first = verts.length / VERTEX_FLOATS;
    faceFirstVertex[f] = first;
    faceFirstPoly[f] = polyFirstVertex.length;
    const corners = faceVertexIndices(bsp, f);
    if (flags & SURF_WARP) {
      const points = new Float32Array(corners.length * 3);
      corners.forEach((v, i) => points.set(pos.subarray(v * 3, v * 3 + 3), i * 3));
      const vecs = bsp.texinfo.vecs.subarray(ti * 8, ti * 8 + 8);
      // Warped faces have no lightmap; every vertex samples the fullbright block.
      const [lu, lv] = lightmapUv(atlas, f, 0, 0);
      for (const poly of subdivideWarpPolygon(points, vecs.subarray(0, 3), vecs.subarray(4, 7))) {
        addPoly(poly.st.length / 2);
        for (let i = 0; i < poly.st.length / 2; i++) {
          verts.push(poly.position[i * 3]!, poly.position[i * 3 + 1]!, poly.position[i * 3 + 2]!, poly.st[i * 2]!, poly.st[i * 2 + 1]!, lu, lv);
        }
      }
    } else {
      addPoly(corners.length);
      for (const v of corners) {
        const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
        const [s, t] = texCoord(bsp, ti, x, y, z);
        const [lu, lv] = lightmapUv(atlas, f, s, t);
        verts.push(x, y, z, s, t, lu, lv);
      }
    }
    faceNumVertices[f] = verts.length / VERTEX_FLOATS - first;
    faceNumPolys[f] = polyFirstVertex.length - faceFirstPoly[f]!;
  }

  function addPoly(count: number): void {
    polyFirstVertex.push(verts.length / VERTEX_FLOATS);
    polyNumVertices.push(count);
  }
}

/** Every face of one model, as face flags for buildDrawList. */
export function modelFaceMask(bsp: Bsp, model: number): Uint8Array {
  const mask = new Uint8Array(bsp.faces.count);
  const { first, end } = modelFaces(bsp, model);
  mask.fill(1, first, end);
  for (let m = 0; m < model; m++) {
    const earlier = modelFaces(bsp, m);
    mask.fill(0, Math.max(earlier.first, first), Math.min(earlier.end, end));
  }
  return mask;
}

export interface DrawRange {
  readonly texture: number;
  /** The faces' SURF_DRAW_FLAGS. */
  readonly flags: number;
  /** Offset and count in indices (not bytes). */
  readonly first: number;
  readonly count: number;
}

export interface DrawList {
  readonly indices: Uint32Array;
  readonly draws: readonly DrawRange[];
  /** Faces drawn, translucent ones included. */
  readonly visibleFaces: number;
  /** Translucent faces, in face order, left out of `indices` for the alpha pass. */
  readonly translucent: readonly number[];
}

/**
 * Faces potentially visible from `cluster`, as world-model face flags. Cluster -1 (the
 * eye is in solid or outside the map) or a map without vis marks every face, as the
 * engine's novis path does.
 */
export function visibleFaceMask(bsp: Bsp, mesh: WorldMesh, cluster: number): Uint8Array {
  const mask = new Uint8Array(bsp.faces.count);
  const end = mesh.firstFace + mesh.numFaces;
  // A leaf cluster past the vis data (a corrupt map that warns but still draws) has no
  // PVS row; draw everything rather than nothing.
  if (cluster < 0 || cluster >= bsp.visibility.numClusters) {
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

/**
 * Triangle-fan indices for the masked opaque faces, grouped by texture and draw flags
 * into one draw each. Translucent faces are listed apart.
 */
export function buildDrawList(mesh: WorldMesh, mask: Uint8Array): DrawList {
  const groups = new Map<number, number[]>();
  const translucent: number[] = [];
  let visibleFaces = 0;
  for (let f = 0; f < mask.length; f++) {
    const tex = mesh.faceTexture[f]!;
    if (!mask[f] || tex < 0) continue;
    visibleFaces++;
    const flags = mesh.faceFlags[f]!;
    if (flags & SURF_TRANSLUCENT) {
      translucent.push(f);
      continue;
    }
    // Keys in texture order, then flags, so the draw order does not depend on face order.
    const key = tex * 256 + flags;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    pushFace(mesh, f, list);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const draws: DrawRange[] = [];
  const indices = new Uint32Array(keys.reduce((a, k) => a + groups.get(k)!.length, 0));
  let o = 0;
  for (const key of keys) {
    const list = groups.get(key)!;
    draws.push({ texture: Math.floor(key / 256), flags: key % 256, first: o, count: list.length });
    indices.set(list, o);
    o += list.length;
  }
  return { indices, draws, visibleFaces, translucent };
}

/** Indices for `faces` drawn in the order given, one draw per run of faces with the same texture and flags. */
export function buildOrderedDraws(mesh: WorldMesh, faces: readonly number[]): { indices: Uint32Array; draws: DrawRange[] } {
  const list: number[] = [];
  const draws: DrawRange[] = [];
  for (const f of faces) {
    const texture = mesh.faceTexture[f]!;
    if (texture < 0) continue;
    const flags = mesh.faceFlags[f]!;
    const first = list.length;
    pushFace(mesh, f, list);
    const last = draws[draws.length - 1];
    if (last && last.texture === texture && last.flags === flags) draws[draws.length - 1] = { ...last, count: last.count + list.length - first };
    else draws.push({ texture, flags, first, count: list.length - first });
  }
  return { indices: Uint32Array.from(list), draws };
}

function pushFace(mesh: WorldMesh, f: number, list: number[]): void {
  const p0 = mesh.faceFirstPoly[f]!;
  for (let p = p0; p < p0 + mesh.faceNumPolys[f]!; p++) {
    const v0 = mesh.polyFirstVertex[p]!;
    for (let i = 2; i < mesh.polyNumVertices[p]!; i++) list.push(v0, v0 + i - 1, v0 + i);
  }
}

/**
 * The order R_DrawAlphaSurfaces draws a model's translucent faces in: R_DrawInlineBModel
 * walks them in face order, each one prepended to the alpha chain, so last face first.
 */
export function brushModelAlphaOrder(faces: readonly number[]): number[] {
  return [...faces].reverse();
}

/**
 * The world's translucent faces among `faces` in the order R_DrawAlphaSurfaces draws
 * them: R_RecursiveWorldNode visits the eye's side of each node first and prepends each
 * face on the eye's side of its node to the alpha chain, so the chain runs back to front.
 * Faces whose plane side faces away from the eye are left out, as the engine does.
 * Brush models' translucent faces come before these (they are prepended later).
 */
export function worldAlphaOrder(bsp: Bsp, faces: readonly number[], eye: readonly [number, number, number]): number[] {
  if (faces.length === 0) return [];
  const want = new Uint8Array(bsp.faces.count);
  for (const f of faces) want[f] = 1;
  const { nodes, planes } = bsp;
  const visit: number[] = [];
  // Each node is entered at most once, so a corrupt map whose children loop cannot hang.
  const entered = new Uint8Array(nodes.count);
  type Frame = { node: number; back: number };
  // R_RecursiveWorldNode starts at r_worldmodel->nodes, node 0.
  const stack: (number | Frame)[] = [0];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (typeof top !== "number") {
      // Front subtree done: this node's faces, then the back subtree.
      emitFaces(top.node);
      if (top.back >= 0) stack.push(top.back);
      continue;
    }
    const node = top;
    if (node < 0 || node >= nodes.count || entered[node]) continue;
    entered[node] = 1;
    const side = planeSide(nodes.planeNum[node]!);
    stack.push({ node, back: nodes.children[node * 2 + (side ^ 1)]! });
    stack.push(nodes.children[node * 2 + side]!);
  }
  return visit.reverse();

  /**
   * The eye's side of a plane as R_RecursiveWorldNode computes it: in float, axial planes
   * (type 0-2) by one coordinate, any other type by the dot product.
   */
  function planeSide(p: number): number {
    const type = planes.type[p]!;
    const n = planes.normal;
    const f = Math.fround;
    const dot =
      type >= 0 && type < 3
        ? f(f(eye[type]!) - planes.dist[p]!)
        : f(f(f(f(f(eye[0]) * n[p * 3]!) + f(f(eye[1]) * n[p * 3 + 1]!)) + f(f(eye[2]) * n[p * 3 + 2]!)) - planes.dist[p]!);
    return dot >= 0 ? 0 : 1;
  }

  function emitFaces(node: number): void {
    const sidebit = planeSide(nodes.planeNum[node]!);
    const first = nodes.firstFace[node]!;
    for (let f = first; f < Math.min(first + nodes.numFaces[node]!, bsp.faces.count); f++) {
      if (want[f] && (bsp.faces.side[f] ? 1 : 0) === sidebit) visit.push(f);
    }
  }
}
