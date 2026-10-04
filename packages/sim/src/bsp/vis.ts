// SPDX-License-Identifier: GPL-2.0-or-later
// Point-in-leaf lookup and PVS decompression, after CM_PointLeafnum and
// CM_DecompressVis in the Quake 2 collision model.

import { DVIS_PVS } from "./format.js";
import type { Bsp } from "./parse.js";

/** Leaf containing a point, walking the BSP tree from `headNode` (node 0 by default, as CM_PointLeafnum starts). */
export function pointLeaf(bsp: Bsp, x: number, y: number, z: number, headNode = 0): number {
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
 * Every leaf an axis-aligned box touches, solid ones included, after CM_BoxLeafnums but
 * with no cap on the count, in its order (front child first), from `headNode` (model 0's
 * by default, as CM_BoxLeafnums starts). By default a box on a node's plane goes to
 * both children, where the engine's axial fast path (BOX_ON_PLANE_SIDE) sends a box whose max is on an axial plane only to the back and
 * one whose min is on it only to the front: a superset, never missing a leaf. With
 * `axialTies` the fast path is followed, for the engine's exact leaf list. Each node is
 * visited once, so a corrupt map whose children loop or share subtrees still terminates.
 */
export function boxLeafs(
  bsp: Bsp,
  mins: readonly [number, number, number],
  maxs: readonly [number, number, number],
  headNode = bsp.models.headNode[0] ?? 0,
  axialTies = false,
): number[] {
  const { nodes, planes } = bsp;
  const out: number[] = [];
  const seenNodes = new Uint8Array(nodes.count);
  const seenLeafs = new Uint8Array(bsp.leafs.count);
  const stack = [headNode];
  while (stack.length > 0) {
    const num = stack.pop()!;
    if (num < 0) {
      const leaf = -(num + 1);
      if (leaf < bsp.leafs.count && !seenLeafs[leaf]) {
        seenLeafs[leaf] = 1;
        out.push(leaf);
      }
      continue;
    }
    if (num >= nodes.count || seenNodes[num]) continue;
    seenNodes[num] = 1;
    const p = nodes.planeNum[num]!;
    const type = planes.type[p]!;
    if (axialTies && type >= 0 && type < 3) {
      const dist = planes.dist[p]!;
      const front = dist <= mins[type]!;
      const back = !front && dist >= maxs[type]!;
      if (!front) stack.push(nodes.children[num * 2 + 1]!);
      if (!back) stack.push(nodes.children[num * 2]!);
      continue;
    }
    // Distances of the box corners nearest and farthest along the plane normal.
    let lo = -planes.dist[p]!;
    let hi = lo;
    for (let k = 0; k < 3; k++) {
      const n = planes.normal[p * 3 + k]!;
      lo += n * (n < 0 ? maxs[k]! : mins[k]!);
      hi += n * (n < 0 ? mins[k]! : maxs[k]!);
    }
    // Same side test as pointLeaf: on the plane is front. Written so that NaN (a plane
    // index past the lump) goes both ways rather than dropping leafs.
    if (!(lo >= 0)) stack.push(nodes.children[num * 2 + 1]!);
    if (!(hi < 0)) stack.push(nodes.children[num * 2]!);
  }
  return out;
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
