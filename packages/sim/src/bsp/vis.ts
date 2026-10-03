// SPDX-License-Identifier: GPL-2.0-or-later
// Point-in-leaf lookup, box-against-plane and box-in-leafs tests, and PVS decompression,
// after CM_PointLeafnum, BOX_ON_PLANE_SIDE, CM_BoxLeafnums and CM_DecompressVis in the
// Quake 2 collision model.

import { DVIS_PVS } from "./format.js";
import type { Bsp } from "./parse.js";

/** Leaf containing a point, walking the BSP tree from `headNode` (model 0's by default). */
export function pointLeaf(bsp: Bsp, x: number, y: number, z: number, headNode = bsp.models.headNode[0] ?? 0): number {
  const { nodes, planes } = bsp;
  let num = headNode;
  while (num >= 0) {
    const p = nodes.planeNum[num]!;
    const d = x * planes.normal[p * 3]! + y * planes.normal[p * 3 + 1]! + z * planes.normal[p * 3 + 2]! - planes.dist[p]!;
    num = nodes.children[num * 2 + (d < 0 ? 1 : 0)]!;
  }
  return -(num + 1);
}

/**
 * Which side of plane `p` a box lies on: 1 in front, 2 behind, 3 crossing, as
 * BOX_ON_PLANE_SIDE in q_shared.h. Axial planes (type 0..2) compare one axis, and a box
 * touching the plane from in front counts as in front only; others test the box corners
 * nearest and farthest along the normal.
 */
export function boxOnPlaneSide(bsp: Bsp, p: number, mins: ArrayLike<number>, maxs: ArrayLike<number>): 1 | 2 | 3 {
  const { normal, dist: dists, type } = bsp.planes;
  const dist = dists[p]!;
  const t = type[p]!;
  if (t >= 0 && t < 3) {
    if (dist <= mins[t]!) return 1;
    if (dist >= maxs[t]!) return 2;
    return 3;
  }
  let far = 0;
  let near = 0;
  for (let i = 0; i < 3; i++) {
    const n = normal[p * 3 + i]!;
    far += n * (n < 0 ? mins[i]! : maxs[i]!);
    near += n * (n < 0 ? maxs[i]! : mins[i]!);
  }
  return ((far >= dist ? 1 : 0) | (near < dist ? 2 : 0)) as 1 | 2 | 3;
}

/**
 * Leafs a box touches, solid ones included, walking from `headNode` (model 0's by
 * default), as CM_BoxLeafnums_headnode. At most `max` leafs are listed; `topNode` is the
 * first node the box straddles, or -1 if it lies in one leaf. The walk stops once the
 * list is full and `topNode` found, which the engine does not, so a corrupt tree that
 * shares subtrees cannot make it exponential; the result is the same either way. A child
 * index past the node lump (a corrupt map that warns but still draws) ends that branch.
 */
export function boxLeafs(
  bsp: Bsp,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  max: number,
  headNode = bsp.models.headNode[0] ?? 0,
): { leafs: number[]; topNode: number } {
  const { nodes } = bsp;
  const leafs: number[] = [];
  let topNode = -1;
  const walk = (start: number): void => {
    let num = start;
    for (;;) {
      if (num < 0) {
        if (leafs.length < max) leafs.push(-(num + 1));
        return;
      }
      if (!(num < nodes.count) || (leafs.length >= max && topNode !== -1)) return;
      const side = boxOnPlaneSide(bsp, nodes.planeNum[num]!, mins, maxs);
      if (side === 3) {
        if (topNode === -1) topNode = num;
        walk(nodes.children[num * 2]!);
        num = nodes.children[num * 2 + 1]!;
      } else {
        num = nodes.children[num * 2 + (side === 1 ? 0 : 1)]!;
      }
    }
  };
  walk(headNode);
  return { leafs, topNode };
}

/** Bytes in one decompressed vis row: one bit per cluster. */
export function visRowBytes(bsp: Bsp): number {
  return (bsp.visibility.numClusters + 7) >> 3;
}

/**
 * Decompressed PVS row of a cluster: bit c set means cluster c is potentially visible.
 * Rows are run-length encoded: a zero byte is followed by a count of zero bytes.
 * Cluster -1 (in solid) sees nothing, as in the engine. A map without vis data has no
 * clusters and an empty row; callers that want "draw everything" in either case check
 * for it themselves.
 */
export function clusterPvs(bsp: Bsp, cluster: number, out = new Uint8Array(visRowBytes(bsp))): Uint8Array {
  const { numClusters, offsets, data } = bsp.visibility;
  const row = visRowBytes(bsp);
  if (cluster < 0 || cluster >= numClusters) return out.fill(0, 0, row);
  let i = offsets[cluster * 2 + DVIS_PVS]!;
  let o = 0;
  while (o < row && i < data.length) {
    const b = data[i++]!;
    if (b !== 0) {
      out[o++] = b;
      continue;
    }
    // A run longer than the row is clamped, as the engine does.
    const run = Math.min(data[i++] ?? 0, row - o);
    out.fill(0, o, o + run);
    o += run;
  }
  // Truncated data: treat the rest as not visible rather than reading past the lump.
  out.fill(0, o, row);
  return out;
}
