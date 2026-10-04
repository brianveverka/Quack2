// SPDX-License-Identifier: GPL-2.0-or-later
// Brush model culling: by PVS, as the engine's server decides which entities a client
// is sent (sv_ents.c SV_BuildClientFrame over the clusters SV_LinkEdict found), and by
// view frustum, as the GL renderer skips a model before drawing it (gl_rsurf.c
// R_DrawBrushModel, R_CullBox), and by area, as the server leaves out an entity in no
// area connected to the client's (CM_AreasConnected). DOM-free.

import { areasConnected, boxLeafs, clusterPvs, visRowBytes, type Bsp } from "@quack2/sim";
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
 * The box SV_LinkEdict links a brush entity by (absmin/absmax): the model's bounds
 * spread by a unit at the entity origin, or, when any angle is set, a cube of the
 * largest single bound around it; either way grown by one more unit on every side.
 */
export function linkBox(bsp: Bsp, inst: BrushModelInstance): Box {
  const { mins, maxs } = modelBounds(bsp, inst.model);
  const o = inst.origin;
  if (inst.angles[0] || inst.angles[1] || inst.angles[2]) {
    const r = Math.max(...mins.map(Math.abs), ...maxs.map(Math.abs)) + 1;
    return { mins: [o[0] - r, o[1] - r, o[2] - r], maxs: [o[0] + r, o[1] + r, o[2] + r] };
  }
  return {
    mins: [o[0] + mins[0]! - 1, o[1] + mins[1]! - 1, o[2] + mins[2]! - 1],
    maxs: [o[0] + maxs[0]! + 1, o[1] + maxs[1]! + 1, o[2] + maxs[2]! + 1],
  };
}

/** SV_LinkEdict's MAX_TOTAL_ENT_LEAFS: areas come from the first this many leafs the box touches. */
const MAX_TOTAL_ENT_LEAFS = 128;

/**
 * An entity's areanum and areanum2 as SV_LinkEdict sets them from the leafs its link box
 * touches, in CM_BoxLeafnums' order and with its axial-plane ties: the first nonzero
 * area, and the last nonzero one that differs from it (doors straddle two); 0 for none.
 * Ties are compared in double; the engine's float bounds can differ off integer values. An entity touching three or more areas keeps
 * only those two, as in the engine.
 */
export function boxAreas(bsp: Bsp, box: Box): [number, number] {
  let area1 = 0;
  let area2 = 0;
  for (const leaf of boxLeafs(bsp, box.mins, box.maxs, undefined, true).slice(0, MAX_TOTAL_ENT_LEAFS)) {
    const area = bsp.leafs.area[leaf]!;
    if (!area) continue;
    if (area1 && area1 !== area) area2 = area;
    else area1 = area;
  }
  return [area1, area2];
}

/**
 * Whether the server sends an entity with these areas to a client in `eyeArea`
 * (SV_BuildClientFrame): its first or, if it has one, its second area is connected to
 * the client's. An eye in area 0 (in solid or outside the map) passes every entity, as
 * the PVS test does there; the engine would pass only entities in area 0.
 */
export function areasVisible(flood: Int32Array, eyeArea: number, areas: readonly [number, number]): boolean {
  if (eyeArea === 0) return true;
  return areasConnected(flood, eyeArea, areas[0]) || (areas[1] !== 0 && areasConnected(flood, eyeArea, areas[1]));
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
 * with a*x + b*y + c*z + d >= 0 inside, in the order left, right, bottom, top, near,
 * far: the first four are R_SetFrustum's side planes. Unnormalized: only the sign is used.
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
  return boxOutsidePlanes(planes, box.mins, box.maxs);
}

/**
 * boxOutsideFrustum for a box stored at `offset` in flat bounds arrays (BSP node and
 * leaf mins/maxs), as BOX_ON_PLANE_SIDE returning 2: the box is culled only when its
 * corner farthest along the normal is behind the plane.
 */
export function boxOutsidePlanes(planes: readonly (readonly number[])[], mins: ArrayLike<number>, maxs: ArrayLike<number>, offset = 0): boolean {
  for (const [a, b, c, d] of planes) {
    // The box corner farthest along the plane normal.
    const x = a! >= 0 ? maxs[offset]! : mins[offset]!;
    const y = b! >= 0 ? maxs[offset + 1]! : mins[offset + 1]!;
    const z = c! >= 0 ? maxs[offset + 2]! : mins[offset + 2]!;
    if (a! * x + b! * y + c! * z + d! < 0) return true;
  }
  return false;
}
