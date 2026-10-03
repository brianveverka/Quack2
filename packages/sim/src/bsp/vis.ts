// SPDX-License-Identifier: GPL-2.0-or-later
// Point-in-leaf lookup and PVS decompression, after CM_PointLeafnum and
// CM_DecompressVis in the Quake 2 collision model.

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

/** Bytes in one decompressed vis row: one bit per cluster. */
export function visRowBytes(bsp: Bsp): number {
  return (bsp.visibility.numClusters + 7) >> 3;
}

/**
 * Decompressed PVS row of a cluster: bit c set means cluster c is potentially visible.
 * Rows are run-length encoded: a zero byte is followed by a count of zero bytes.
 * A map without vis data sees everything; cluster -1 (in solid) sees nothing, as in the
 * engine. Callers that want "draw everything when outside the map" check -1 themselves.
 */
export function clusterPvs(bsp: Bsp, cluster: number, out = new Uint8Array(visRowBytes(bsp))): Uint8Array {
  const { numClusters, offsets, data } = bsp.visibility;
  const row = visRowBytes(bsp);
  if (numClusters === 0) return out.fill(0xff, 0, row);
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
