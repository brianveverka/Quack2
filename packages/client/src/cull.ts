// SPDX-License-Identifier: GPL-2.0-or-later
// Brush model culling: by PVS, as the engine's server decides which entities a client
// is sent (sv_ents.c SV_BuildClientFrame over the clusters SV_LinkEdict found), and by
// view frustum, as the GL renderer skips a model before drawing it (gl_rsurf.c
// R_DrawBrushModel, R_CullBox), and by area, as the server leaves out an entity in no
// area connected to the client's (CM_AreasConnected). DOM-free.

import { areasConnected, boxLeafs, clusterPvs, visRowBytes, type Bsp } from "@quack2/sim";
import { modelBounds, type BrushModelInstance } from "./bmodels.js";
import { modelMatrix, type Mat4 } from "./math.js";

export type Vec3 = readonly [number, number, number];

export interface Box {
  readonly mins: Vec3;
  readonly maxs: Vec3;
}

/** An entity's origin and angles (pitch, yaw, roll). */
export interface Pose {
  readonly origin: Vec3;
  readonly angles: Vec3;
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

/**
 * A brush model instance where the client draws it and where the server links it. The
 * client draws it at its blended pose and culls it by frustum there (R_DrawBrushModel);
 * the server links it where the last game frame left it (SV_LinkEdict) and sends it by
 * the clusters and areas found there. The two differ only while it moves.
 */
export interface PlacedInstance {
  readonly source: BrushModelInstance;
  /** Where it is drawn, and turned to. */
  origin: Vec3;
  angles: Vec3;
  /** Where it is linked, and turned to. */
  linkOrigin: Vec3;
  linkAngles: Vec3;
  /** Model to world: `angles`, then `origin`. */
  model: Mat4;
  /** World box enclosing it at `origin` and `angles`, for the frustum test. */
  box: Box;
  /**
   * Distinct non-solid clusters its `instanceBox` at the link pose touches. The server
   * uses its link box (`linkBox`); see BACKLOG.md.
   */
  clusters: readonly number[];
  /** areanum and areanum2 of the server's link box at the link pose (boxAreas). */
  areas: readonly [number, number];
  /** In the fat PVS last tested against. */
  inPvs: boolean;
}

/** A brush model instance drawn and linked at its own origin and angles, in every PVS until tested. */
export function placeInstance(bsp: Bsp, source: BrushModelInstance): PlacedInstance {
  const o: Vec3 = [source.origin[0], source.origin[1], source.origin[2]];
  const a: Vec3 = [source.angles[0], source.angles[1], source.angles[2]];
  return {
    source,
    origin: o,
    angles: a,
    linkOrigin: o,
    linkAngles: a,
    model: modelMatrix(o, source.angles),
    box: instanceBox(bsp, source),
    clusters: boxClusters(bsp, instanceBox(bsp, source)),
    areas: boxAreas(bsp, linkBox(bsp, source)),
    inPvs: true,
  };
}

const sameVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const copyVec = (v: Vec3): Vec3 => [v[0], v[1], v[2]];

/**
 * Draw `inst` at `drawn` and link it at `linked`, re-testing it against `pvs` (the fat
 * PVS last tested; undefined passes every model) when its link moved or turned. What
 * did not move is left as it is, so a mover at rest costs a comparison.
 */
export function moveInstance(bsp: Bsp, inst: PlacedInstance, drawn: Pose, linked: Pose, pvs: Uint8Array | undefined): void {
  if (!sameVec(drawn.origin, inst.origin) || !sameVec(drawn.angles, inst.angles)) {
    const at = { ...inst.source, origin: drawn.origin, angles: drawn.angles };
    inst.origin = copyVec(drawn.origin);
    inst.angles = copyVec(drawn.angles);
    inst.model = modelMatrix(drawn.origin, drawn.angles);
    inst.box = instanceBox(bsp, at);
  }
  if (!sameVec(linked.origin, inst.linkOrigin) || !sameVec(linked.angles, inst.linkAngles)) {
    const at = { ...inst.source, origin: linked.origin, angles: linked.angles };
    inst.linkOrigin = copyVec(linked.origin);
    inst.linkAngles = copyVec(linked.angles);
    inst.clusters = boxClusters(bsp, instanceBox(bsp, at));
    inst.areas = boxAreas(bsp, linkBox(bsp, at));
    inst.inPvs = !pvs || clustersVisible(inst.clusters, pvs);
  }
}

/**
 * Brush model instances and the fat PVS they were last tested against: an eye whose fat
 * clusters did not change tests nothing, and a moved instance is re-tested against that
 * PVS as it moves.
 */
export class PlacedInstances<T extends PlacedInstance> {
  readonly list: T[] = [];
  /** Clusters of the fat PVS last tested; "" before the first test, undefined for none. */
  private fatKey: string | undefined = "";
  /** That fat PVS; undefined passes every instance. */
  private pvs: Uint8Array | undefined;

  constructor(private readonly bsp: Bsp) {}

  /** Test every instance against the fat PVS of `fat` (fatClusters; undefined passes them all), unless those clusters were the last tested. */
  testPvs(fat: readonly number[] | undefined): void {
    const key = fat?.join(",");
    if (key === this.fatKey) return;
    this.fatKey = key;
    const pvs = fat && pvsUnion(this.bsp, fat);
    this.pvs = pvs;
    for (const inst of this.list) inst.inPvs = !pvs || clustersVisible(inst.clusters, pvs);
  }

  /**
   * Move brush entities, by entity index: each is drawn at its `drawn` pose (the
   * client's blended one) and linked, for the PVS and area tests, at its `linked` one
   * (where the last game frame left it), or at `drawn` without one. An entity in
   * neither keeps its place.
   */
  move(drawn: ReadonlyMap<number, Pose>, linked: ReadonlyMap<number, Pose> = drawn): void {
    for (const inst of this.list) {
      const entity = inst.source.entity;
      const pose = drawn.get(entity) ?? linked.get(entity);
      if (!pose) continue;
      moveInstance(this.bsp, inst, pose, linked.get(entity) ?? pose, this.pvs);
    }
  }
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
 * `eyeCluster` is the server's (pointLeaf). Returns the clusters, ascending, for
 * `pvsUnion`; undefined when the eye is in no cluster with a PVS row: every model then
 * passes. The world's view cluster comes from renderLeaf, which can differ for an eye
 * on a node's plane in float.
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
  // Indexed rather than destructured: the world walk calls this per node and leaf.
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i]!;
    const a = p[0]!, b = p[1]!, c = p[2]!;
    // The box corner farthest along the plane normal.
    const x = a >= 0 ? maxs[offset]! : mins[offset]!;
    const y = b >= 0 ? maxs[offset + 1]! : mins[offset + 1]!;
    const z = c >= 0 ? maxs[offset + 2]! : mins[offset + 2]!;
    if (a * x + b * y + c * z + p[3]! < 0) return true;
  }
  return false;
}
