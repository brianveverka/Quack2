// SPDX-License-Identifier: GPL-2.0-or-later
// Mesh of every model's faces (the world, model 0, and the inline brush models), in
// model space: triangle fans, one per face, or one per 64-unit piece of a warped face,
// the world's faces per frame as R_RecursiveWorldNode walks them (PVS, areas, view
// frustum), and per-model index lists. Translucent faces are drawn after everything
// else, in the order ref_gl's R_DrawAlphaSurfaces gets them. The world's sky faces are
// not drawn: they only bound the sky box (sky.ts). DOM-free so it is testable under Node.

import {
  CONTENTS_SOLID,
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
import { boxOutsidePlanes } from "./cull.js";
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
 * engine's novis path does. With `areaBits` (areaBits in @quack2/sim), a leaf whose
 * area bit is clear adds no faces, as R_RecursiveWorldNode skips leafs behind a closed
 * area portal, on the novis path too (every non-solid leaf then counts as in the PVS).
 * Pass none for an eye in area 0, whose bits are all set.
 */
export function visibleFaceMask(bsp: Bsp, mesh: WorldMesh, cluster: number, areaBits?: Uint8Array): Uint8Array {
  const mask = new Uint8Array(bsp.faces.count);
  const end = mesh.firstFace + mesh.numFaces;
  // A leaf cluster past the vis data (a corrupt map that warns but still draws) has no
  // PVS row; draw everything rather than nothing.
  const novis = cluster < 0 || cluster >= bsp.visibility.numClusters;
  if (novis && !areaBits) {
    mask.fill(1, mesh.firstFace, end);
    return mask;
  }
  const pvs = novis ? undefined : clusterPvs(bsp, cluster);
  const { leafs, leafFaces } = bsp;
  for (let l = 0; l < leafs.count; l++) {
    if (pvs) {
      const c = leafs.cluster[l]!;
      if (c < 0 || !(pvs[c >> 3]! & (1 << (c & 7)))) continue;
    } else if (leafs.contents[l] === CONTENTS_SOLID) continue;
    const a = leafs.area[l]!;
    if (areaBits && !((areaBits[a >> 3] ?? 0) & (1 << (a & 7)))) continue;
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
 * into one draw each; translucent faces are listed apart. Sky faces draw as any opaque
 * face, as R_DrawInlineBModel draws a brush model's (the world's go through WorldDraws).
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
    const key = drawKey(mesh, f);
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

/** A face's draw group: texture, then flags, so the draw order does not depend on face order. */
function drawKey(mesh: WorldMesh, f: number): number {
  return mesh.faceTexture[f]! * 256 + mesh.faceFlags[f]!;
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
 * The eye's side of a plane as R_RecursiveWorldNode computes it: 0 in front or on it, 1
 * behind. In float, axial planes (type 0-2) by one coordinate, any other type by the dot
 * product.
 */
export function eyePlaneSide(bsp: Bsp, p: number, eye: readonly [number, number, number]): number {
  const { planes } = bsp;
  const type = planes.type[p]!;
  const n = planes.normal;
  const f = Math.fround;
  const dot =
    type >= 0 && type < 3
      ? f(f(eye[type]!) - planes.dist[p]!)
      : f(f(f(f(f(eye[0]) * n[p * 3]!) + f(f(eye[1]) * n[p * 3 + 1]!)) + f(f(eye[2]) * n[p * 3 + 2]!)) - planes.dist[p]!);
  return dot >= 0 ? 0 : 1;
}

/**
 * The order R_DrawAlphaSurfaces draws a model's translucent faces in: R_DrawInlineBModel
 * walks them in face order, each one prepended to the alpha chain, so last face first.
 */
export function brushModelAlphaOrder(faces: readonly number[]): number[] {
  return [...faces].reverse();
}

/**
 * What R_MarkLeaves and the area bits leave R_RecursiveWorldNode for one eye cluster and
 * area. `nodes`: a leaf under the node is in the PVS (its visframe; areas play no part).
 * `leafs`: the leaf adds its faces: in the PVS, not CONTENTS_SOLID, and with its area
 * bit set. Cluster -1, one past the vis data, or a map without vis marks every leaf and
 * node, as the engine's novis path does. Pass no `areaBits` for an eye in area 0.
 */
export interface WorldVis {
  readonly nodes: Uint8Array;
  readonly leafs: Uint8Array;
}

/** R_MarkLeaves' marks for an eye in `cluster`, with the area test on leafs (WorldVis). */
export function worldVis(bsp: Bsp, cluster: number, areaBits?: Uint8Array): WorldVis {
  const { nodes, leafs } = bsp;
  const nodeVis = new Uint8Array(nodes.count);
  const leafVis = new Uint8Array(leafs.count);
  const novis = cluster < 0 || cluster >= bsp.visibility.numClusters;
  if (novis) {
    nodeVis.fill(1);
    leafVis.fill(1);
  } else {
    // R_MarkLeaves walks each PVS leaf's parents up to the first already marked.
    const nodeParent = new Int32Array(nodes.count).fill(-1);
    const leafParent = new Int32Array(leafs.count).fill(-1);
    for (let n = 0; n < nodes.count; n++) {
      for (let s = 0; s < 2; s++) {
        const c = nodes.children[n * 2 + s]!;
        if (c >= 0) {
          if (c < nodes.count && nodeParent[c] === -1 && c !== 0) nodeParent[c] = n;
        } else if (-1 - c < leafs.count && leafParent[-1 - c] === -1) leafParent[-1 - c] = n;
      }
    }
    const pvs = clusterPvs(bsp, cluster);
    for (let l = 0; l < leafs.count; l++) {
      const c = leafs.cluster[l]!;
      if (c < 0 || !(pvs[c >> 3]! & (1 << (c & 7)))) continue;
      leafVis[l] = 1;
      for (let n = leafParent[l]!; n >= 0 && !nodeVis[n]; n = nodeParent[n]!) nodeVis[n] = 1;
    }
  }
  for (let l = 0; l < leafs.count; l++) {
    if (leafs.contents[l] === CONTENTS_SOLID) leafVis[l] = 0;
    const a = leafs.area[l]!;
    if (areaBits && !((areaBits[a >> 3] ?? 0) & (1 << (a & 7)))) leafVis[l] = 0;
  }
  return { nodes: nodeVis, leafs: leafVis };
}

/**
 * The world faces R_RecursiveWorldNode passes from `eye`, in the order it reaches them.
 * From node 0 it skips nodes and leafs not marked in `vis` and, with `planes`, those
 * whose box lies wholly outside one of them (R_CullBox: give it the four side planes).
 * A leaf marks its faces; after a node's eye-side subtree, each face of the node that
 * is marked by then and has the eye on its front side is passed, then the other subtree
 * is walked. Faces not drawn (no texture) are left out.
 */
export function walkWorld(bsp: Bsp, mesh: WorldMesh, vis: WorldVis, eye: readonly [number, number, number], planes?: readonly (readonly number[])[]): number[] {
  const { nodes, leafs, leafFaces } = bsp;
  const nfaces = bsp.faces.count;
  const marked = new Uint8Array(nfaces);
  // Each node is entered at most once, so a corrupt map whose children loop cannot hang.
  const entered = new Uint8Array(nodes.count);
  const out: number[] = [];
  type Frame = { node: number; side: number };
  const stack: (number | Frame)[] = [0];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (typeof top !== "number") {
      const { node, side } = top;
      const first = nodes.firstFace[node]!;
      for (let f = first; f < Math.min(first + nodes.numFaces[node]!, nfaces); f++) {
        if (marked[f] && (bsp.faces.side[f] ? 1 : 0) === side && mesh.faceTexture[f]! >= 0) out.push(f);
      }
      stack.push(nodes.children[node * 2 + (side ^ 1)]!);
      continue;
    }
    if (top < 0) {
      const l = -1 - top;
      if (l >= leafs.count || !vis.leafs[l]) continue;
      if (planes && boxOutsidePlanes(planes, leafs.mins, leafs.maxs, l * 3)) continue;
      const first = leafs.firstLeafFace[l]!;
      for (let k = first; k < Math.min(first + leafs.numLeafFaces[l]!, leafFaces.length); k++) {
        const f = leafFaces[k]!;
        if (f < nfaces) marked[f] = 1;
      }
      continue;
    }
    const node = top;
    if (node >= nodes.count || entered[node]) continue;
    entered[node] = 1;
    if (!vis.nodes[node]) continue;
    if (planes && boxOutsidePlanes(planes, nodes.mins, nodes.maxs, node * 3)) continue;
    const side = eyePlaneSide(bsp, nodes.planeNum[node]!, eye);
    stack.push({ node, side });
    stack.push(nodes.children[node * 2 + side]!);
  }
  return out;
}

/**
 * The world's draws for the faces walkWorld passes. R_RecursiveWorldNode tests SURF_SKY
 * before the translucent flags: sky faces only bound the sky box (`sky`), translucent
 * ones are prepended to the alpha chain (`alpha`, in R_DrawAlphaSurfaces' order), and
 * the rest are drawn from `indices`, grouped by texture and flags as buildDrawList
 * groups them. The indices are rebuilt from per-face slices only when the set of opaque
 * faces changes, so a still eye costs no rebuild and no upload.
 */
export class WorldDraws {
  /** Opaque faces' indices; the first `indexCount` are valid. */
  readonly indices: Uint32Array;
  indexCount = 0;
  draws: DrawRange[] = [];
  sky: number[] = [];
  alpha: number[] = [];
  /** World opaque faces sorted by draw key, then face number. */
  private readonly order: Int32Array;
  /** Per face: its triangles' first index in `all`, and their index count. */
  private readonly faceFirst: Uint32Array;
  private readonly faceCount: Uint32Array;
  private readonly all: Uint32Array;
  private readonly marked: Uint8Array;
  /** The opaque faces drawn, in `order`; -1 entries before the first update. */
  private readonly drawn: Int32Array;
  private drawnCount = -1;

  constructor(private readonly mesh: WorldMesh) {
    const n = mesh.faceTexture.length;
    const faces: number[] = [];
    for (let f = mesh.firstFace; f < mesh.firstFace + mesh.numFaces; f++) {
      if (mesh.faceTexture[f]! >= 0 && !(mesh.faceFlags[f]! & (SURF_SKY | SURF_TRANSLUCENT))) faces.push(f);
    }
    faces.sort((a, b) => drawKey(mesh, a) - drawKey(mesh, b) || a - b);
    this.order = Int32Array.from(faces);
    this.faceFirst = new Uint32Array(n);
    this.faceCount = new Uint32Array(n);
    const list: number[] = [];
    for (const f of faces) {
      this.faceFirst[f] = list.length;
      pushFace(mesh, f, list);
      this.faceCount[f] = list.length - this.faceFirst[f]!;
    }
    this.all = Uint32Array.from(list);
    this.indices = new Uint32Array(list.length);
    this.marked = new Uint8Array(n);
    this.drawn = new Int32Array(faces.length);
  }

  /** Take one frame's walkWorld faces. Returns whether `indices` and `draws` changed. */
  update(faces: readonly number[]): boolean {
    const { mesh, marked, drawn } = this;
    marked.fill(0);
    const sky: number[] = [];
    const alpha: number[] = [];
    for (const f of faces) {
      const flags = mesh.faceFlags[f]!;
      if (flags & SURF_SKY) sky.push(f);
      else if (flags & SURF_TRANSLUCENT) alpha.push(f);
      else marked[f] = 1;
    }
    this.sky = sky;
    this.alpha = alpha.reverse();
    let count = 0;
    let same = true;
    for (const f of this.order) {
      if (!marked[f]) continue;
      if (count >= this.drawnCount || drawn[count] !== f) same = false;
      drawn[count++] = f;
    }
    if (same && count === this.drawnCount) return false;
    this.drawnCount = count;
    const draws: { -readonly [K in keyof DrawRange]: DrawRange[K] }[] = [];
    let o = 0;
    let key = -1;
    for (let k = 0; k < count; k++) {
      const f = drawn[k]!;
      const first = this.faceFirst[f]!;
      const len = this.faceCount[f]!;
      this.indices.set(this.all.subarray(first, first + len), o);
      const fk = drawKey(mesh, f);
      if (fk === key) draws[draws.length - 1]!.count += len;
      else {
        draws.push({ texture: mesh.faceTexture[f]!, flags: mesh.faceFlags[f]!, first: o, count: len });
        key = fk;
      }
      o += len;
    }
    this.indexCount = o;
    this.draws = draws;
    return true;
  }
}
