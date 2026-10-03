// SPDX-License-Identifier: GPL-2.0-or-later
// Brush model culling, in the engine's two stages: the server sends only entities that
// touch a cluster in the eye's fat PVS (sv_ents.c SV_BuildClientFrame, with the clusters
// SV_LinkEdict finds under the entity's box), and the GL renderer skips a model whose box
// is outside the view frustum (gl_rsurf.c R_DrawBrushModel, gl_rmain.c R_CullBox).
// Area portals are not checked (no areabits yet). DOM-free.

import { boxLeafs, clusterPvs, visRowBytes, type Bsp } from "@quack2/sim";
import type { BrushModelInstance } from "./bmodels.js";
import type { Mat4 } from "./math.js";

/** sv_world.c and game.h: an entity touching more leafs or clusters than these is tested by its top node. */
const MAX_TOTAL_ENT_LEAFS = 128;
const MAX_ENT_CLUSTERS = 16;

type Vec3 = [number, number, number];

/**
 * A model's bounds from the model lump, spread by a unit on every side as both
 * CMod_LoadSubmodels and Mod_LoadSubmodels do.
 */
function modelBounds(bsp: Bsp, model: number): { mins: Vec3; maxs: Vec3 } {
  const at = (a: Float32Array, k: number) => a[model * 3 + k] ?? 0;
  const { mins, maxs } = bsp.models;
  return {
    mins: [at(mins, 0) - 1, at(mins, 1) - 1, at(mins, 2) - 1],
    maxs: [at(maxs, 0) + 1, at(maxs, 1) + 1, at(maxs, 2) + 1],
  };
}

const rotated = (angles: readonly number[]) => angles[0] !== 0 || angles[1] !== 0 || angles[2] !== 0;

/**
 * Clusters the server links a brush entity into (SV_LinkEdict): its world box (origin
 * plus model bounds, or origin plus or minus the largest bound when rotated) grown by a
 * unit, then the clusters of the leafs under it. Past MAX_TOTAL_ENT_LEAFS leafs or
 * MAX_ENT_CLUSTERS clusters the engine tests every leaf under the box's top node
 * instead (CM_HeadnodeVisible), so those clusters are listed. Every brush class shown at
 * spawn is SOLID_BSP, the case that expands for rotation.
 */
export function entityClusters(bsp: Bsp, inst: BrushModelInstance): number[] {
  const { mins, maxs } = modelBounds(bsp, inst.model);
  const o = inst.origin;
  const absmin: Vec3 = [0, 0, 0];
  const absmax: Vec3 = [0, 0, 0];
  if (rotated(inst.angles)) {
    const r = Math.max(...mins.map(Math.abs), ...maxs.map(Math.abs));
    for (let i = 0; i < 3; i++) {
      absmin[i] = o[i]! - r;
      absmax[i] = o[i]! + r;
    }
  } else {
    for (let i = 0; i < 3; i++) {
      absmin[i] = o[i]! + mins[i]!;
      absmax[i] = o[i]! + maxs[i]!;
    }
  }
  // "movement is clipped an epsilon away from an actual edge"
  for (let i = 0; i < 3; i++) {
    absmin[i]! -= 1;
    absmax[i]! += 1;
  }

  const { leafs, topNode } = boxLeafs(bsp, absmin, absmax, MAX_TOTAL_ENT_LEAFS);
  const clusters: number[] = [];
  let overflow = leafs.length >= MAX_TOTAL_ENT_LEAFS;
  for (const leaf of leafs) {
    if (overflow) break;
    const c = bsp.leafs.cluster[leaf] ?? -1;
    if (c === -1 || clusters.includes(c)) continue;
    if (clusters.length === MAX_ENT_CLUSTERS) overflow = true;
    else clusters.push(c);
  }
  return overflow ? subtreeClusters(bsp, topNode) : clusters;
}

/** Distinct clusters of the leafs under a node (or the leaf -(node + 1)). */
function subtreeClusters(bsp: Bsp, node: number): number[] {
  const found = new Set<number>();
  // Visited flags guard against a corrupt tree that shares or loops subtrees.
  const seen = new Uint8Array(bsp.nodes.count);
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n < 0) {
      const c = bsp.leafs.cluster[-(n + 1)] ?? -1;
      if (c !== -1) found.add(c);
      continue;
    }
    if (n >= bsp.nodes.count || seen[n]) continue;
    seen[n] = 1;
    stack.push(bsp.nodes.children[n * 2]!, bsp.nodes.children[n * 2 + 1]!);
  }
  return [...found];
}

/**
 * The server's fat PVS for an eye (SV_FatPVS): the union of the PVS rows of every
 * cluster within 8 units of it. Null, so brush models are not PVS culled, where there is no
 * row to use: a map without vis, an eye whose box touches no cluster (outside the map,
 * where the engine would send no entities; the world is drawn whole there), or a cluster
 * in the box past the vis data (a corrupt map). An eye in solid whose box reaches a
 * cluster gets that cluster's rows, as in the engine, while the world is drawn whole.
 */
export function fatPvs(bsp: Bsp, eye: readonly number[]): Uint8Array | null {
  const numClusters = bsp.visibility.numClusters;
  if (numClusters === 0) return null;
  const { leafs } = boxLeafs(
    bsp,
    [eye[0]! - 8, eye[1]! - 8, eye[2]! - 8],
    [eye[0]! + 8, eye[1]! + 8, eye[2]! + 8],
    64,
  );
  const clusters = [...new Set(leafs.map((l) => bsp.leafs.cluster[l] ?? -1))].filter((c) => c !== -1);
  if (clusters.length === 0 || clusters.some((c) => c >= numClusters)) return null;
  const out = new Uint8Array(visRowBytes(bsp));
  const row = new Uint8Array(out.length);
  for (const c of clusters) {
    clusterPvs(bsp, c, row);
    for (let i = 0; i < out.length; i++) out[i]! |= row[i]!;
  }
  return out;
}

/** Whether any of the clusters is set in the row. A cluster past the vis data (a corrupt map) counts as visible. */
export function touchesPvs(bsp: Bsp, pvs: Uint8Array, clusters: readonly number[]): boolean {
  const n = bsp.visibility.numClusters;
  return clusters.some((c) => c >= n || (pvs[c >> 3]! & (1 << (c & 7))) !== 0);
}

/**
 * The box R_DrawBrushModel culls by: origin plus model bounds, or, when rotated, origin
 * plus or minus the model's radius (the length of its farthest-from-origin corner).
 */
export function renderBox(bsp: Bsp, inst: BrushModelInstance): { mins: Vec3; maxs: Vec3 } {
  const { mins, maxs } = modelBounds(bsp, inst.model);
  const o = inst.origin;
  if (rotated(inst.angles)) {
    const r = Math.hypot(...[0, 1, 2].map((i) => Math.max(Math.abs(mins[i]!), Math.abs(maxs[i]!))));
    return { mins: [o[0] - r, o[1] - r, o[2] - r], maxs: [o[0] + r, o[1] + r, o[2] + r] };
  }
  return { mins: [o[0] + mins[0], o[1] + mins[1], o[2] + mins[2]], maxs: [o[0] + maxs[0], o[1] + maxs[1], o[2] + maxs[2]] };
}

/** World-space plane: normal · p + d >= 0 on the inside. */
export type Plane = readonly [number, number, number, number];

/**
 * The four side planes of a view-projection's frustum (left, right, bottom, top), as
 * R_SetFrustum builds from the field of view. Near and far are left out, as there.
 */
export function frustumPlanes(viewProj: Mat4): Plane[] {
  const row = (r: number) => [0, 1, 2, 3].map((c) => viewProj[c * 4 + r]!);
  const w = row(3);
  return [row(0), row(1)].flatMap((a) => [
    [w[0]! + a[0]!, w[1]! + a[1]!, w[2]! + a[2]!, w[3]! + a[3]!] as const,
    [w[0]! - a[0]!, w[1]! - a[1]!, w[2]! - a[2]!, w[3]! - a[3]!] as const,
  ]);
}

/** R_CullBox: true if the box is wholly behind one of the planes (its farthest corner strictly behind). */
export function cullBox(planes: readonly Plane[], mins: readonly number[], maxs: readonly number[]): boolean {
  return planes.some(([a, b, c, d]) => a * (a < 0 ? mins[0]! : maxs[0]!) + b * (b < 0 ? mins[1]! : maxs[1]!) + c * (c < 0 ? mins[2]! : maxs[2]!) + d < 0);
}
