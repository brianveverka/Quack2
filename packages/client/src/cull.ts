// SPDX-License-Identifier: GPL-2.0-or-later
// Brush model culling: by PVS, as the engine's server decides which entities a client
// is sent (sv_ents.c SV_BuildClientFrame over the clusters SV_LinkEdict found), and by
// view frustum, as the GL renderer skips a model before drawing it (gl_rsurf.c
// R_DrawBrushModel, R_CullBox). DOM-free.

import { boxLeafs, clusterPvs, visRowBytes, type Bsp } from "@quack2/sim";
import { modelBounds, type BrushModelInstance } from "./bmodels.js";
import type { Mat4 } from "./math.js";

export type Vec3 = readonly [number, number, number];

export interface Box {
  readonly mins: Vec3;
  readonly maxs: Vec3;
}

/**
 * World box enclosing a brush model instance, as R_DrawBrushModel builds it: the model's
 * bounds spread by a unit (Mod_LoadSubmodels) at the entity origin, or, when any angle is
 * set, a cube of the bounds' corner radius around the origin. The server's link box for
 * a rotated model (SV_LinkEdict) is a cube of the largest single bound instead, which a
 * rotated corner can poke out of; the radius cube always encloses the model.
 */
export function instanceBox(bsp: Bsp, inst: BrushModelInstance): Box {
  const { mins, maxs } = modelBounds(bsp, inst.model);
  const o = inst.origin;
  if (inst.angles[0] || inst.angles[1] || inst.angles[2]) {
    const r = Math.hypot(...[0, 1, 2].map((k) => Math.max(Math.abs(mins[k]!), Math.abs(maxs[k]!))));
    return { mins: [o[0] - r, o[1] - r, o[2] - r], maxs: [o[0] + r, o[1] + r, o[2] + r] };
  }
  return { mins: [o[0] + mins[0]!, o[1] + mins[1]!, o[2] + mins[2]!], maxs: [o[0] + maxs[0]!, o[1] + maxs[1]!, o[2] + maxs[2]!] };
}

/**
 * Distinct clusters of the world leafs a box touches; solid leafs (cluster -1) are left
 * out, as in SV_LinkEdict. The engine falls back to a whole-subtree test past 128 leafs
 * or 16 clusters; the full list here is never less precise.
 */
export function boxClusters(bsp: Bsp, box: Box): number[] {
  const clusters = new Set<number>();
  for (const leaf of boxLeafs(bsp, box.mins, box.maxs)) {
    const c = bsp.leafs.cluster[leaf]!;
    if (c >= 0) clusters.add(c);
  }
  return [...clusters];
}

/**
 * Every cluster within `half` units of the eye on each axis, whose PVS rows together
 * make the fat PVS, after SV_FatPVS (which uses 8). The near plane puts the first
 * visible point of a ray a few units past the eye, possibly through a thin wall into a
 * cluster the eye's own one cannot see; a box reaching past the near plane's corners
 * covers that.
 * Returns the clusters, ascending, for `pvsUnion`; undefined when the eye is in no
 * cluster with a PVS row: the world then draws every face, and every model passes.
 */
export function fatClusters(bsp: Bsp, eye: Vec3, eyeCluster: number, half: number): number[] | undefined {
  const n = bsp.visibility.numClusters;
  if (eyeCluster < 0 || eyeCluster >= n) return undefined;
  const clusters = new Set([eyeCluster]);
  const mins: Vec3 = [eye[0] - half, eye[1] - half, eye[2] - half];
  const maxs: Vec3 = [eye[0] + half, eye[1] + half, eye[2] + half];
  for (const leaf of boxLeafs(bsp, mins, maxs)) {
    const c = bsp.leafs.cluster[leaf]!;
    if (c >= 0 && c < n) clusters.add(c);
  }
  return [...clusters].sort((a, b) => a - b);
}

/** The union of the clusters' PVS rows. */
export function pvsUnion(bsp: Bsp, clusters: readonly number[]): Uint8Array {
  const pvs = new Uint8Array(visRowBytes(bsp));
  const row = new Uint8Array(pvs.length);
  for (const c of clusters) {
    clusterPvs(bsp, c, row);
    for (let i = 0; i < pvs.length; i++) pvs[i]! |= row[i]!;
  }
  return pvs;
}

/**
 * Whether any of `clusters` is set in a PVS row. An entity touching only solid leafs is
 * never visible, as the server never sends it.
 */
export function clustersVisible(clusters: readonly number[], pvs: Uint8Array): boolean {
  return clusters.some((c) => (pvs[c >> 3]! & (1 << (c & 7))) !== 0);
}

/**
 * The six clip planes of a view-projection matrix (Gribb and Hartmann), as [a, b, c, d]
 * with a*x + b*y + c*z + d >= 0 inside. Unnormalized: only the sign is used.
 */
export function frustumPlanes(viewProj: Mat4): number[][] {
  const row = (r: number) => [viewProj[r]!, viewProj[4 + r]!, viewProj[8 + r]!, viewProj[12 + r]!];
  const [x, y, z, w] = [row(0), row(1), row(2), row(3)];
  const planes: number[][] = [];
  for (const p of [x, y, z]) {
    planes.push(w.map((v, i) => v + p[i]!), w.map((v, i) => v - p[i]!));
  }
  return planes;
}

/**
 * Whether a box lies wholly outside one of the planes, so no part of it can reach the
 * screen. R_CullBox tests only the four side planes; the near and far planes clip
 * just as surely, so a box beyond either is culled here too.
 */
export function boxOutsideFrustum(planes: readonly (readonly number[])[], box: Box): boolean {
  const { mins, maxs } = box;
  return planes.some(([a, b, c, d]) => {
    // The box corner farthest along the plane normal.
    const x = a! >= 0 ? maxs[0] : mins[0];
    const y = b! >= 0 ? maxs[1] : mins[1];
    const z = c! >= 0 ? maxs[2] : mins[2];
    return a! * x + b! * y + c! * z + d! < 0;
  });
}
