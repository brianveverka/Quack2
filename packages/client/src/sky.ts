// SPDX-License-Identifier: GPL-2.0-or-later
// Port of ref_gl/gl_warp.c's sky box: clipping sky surfaces into the six box sides
// (ClipSkyPolygon, DrawSkyPolygon) to find the rectangle of each side in view, the quads
// R_DrawSkyBox draws for them (MakeSkyVec), its rotation, and the sky settings the game
// (SP_worldspawn) and client (CL_PrepRefresh) derive from worldspawn. DOM-free.
// Precision: the clipping runs in float as the C does (every operation rounded with
// Math.fround or by storing into a Float32Array), so the bounds match a float build of
// it bit for bit; the remaining sums and quotients are rounded where the C stores them.

import type { BspEntity } from "@quack2/sim";

const f = Math.fround;

/** R_SetSky's suf: the image suffixes, in image-index order. */
export const SKY_SUFFIXES: readonly string[] = ["rt", "bk", "lf", "ft", "up", "dn"];

/** skytexorder: the image (index into SKY_SUFFIXES) each box axis 0..5 (+x, -x, +y, -y, +z, -z) shows. */
export const SKY_TEX_ORDER: readonly number[] = [0, 2, 1, 3, 4, 5];

/** MakeSkyVec's distance from the eye to each box side. */
export const SKY_BOX_DISTANCE = 2300;

/** skyclip: the planes through the eye that separate the six box sides. */
const SKY_CLIP: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [1, -1, 0],
  [0, -1, 1],
  [0, 1, 1],
  [1, 0, 1],
  [-1, 0, 1],
];

/** st_to_vec: per axis, the box-space x y z as 1 = s, 2 = t, 3 = distance, negative = negated. */
const ST_TO_VEC: readonly (readonly [number, number, number])[] = [
  [3, -1, 2],
  [-3, 1, 2],
  [1, 3, 2],
  [-1, -3, 2],
  [-2, -1, 3], // 0 degrees yaw, look straight up
  [2, -1, -3], // look straight down
];

/** vec_to_st: per axis, s and t numerators and the divisor, as 1-based signed vector components. */
const VEC_TO_ST: readonly (readonly [number, number, number])[] = [
  [-2, 3, 1],
  [2, 3, -1],
  [1, 3, 2],
  [-1, 3, -2],
  [-2, -1, 3],
  [-2, 1, -3],
];

/** Signed 1-based component of a vector, as vec_to_st and st_to_vec encode them. */
function component(v: ArrayLike<number>, base: number, k: number): number {
  return k < 0 ? -v[base - k - 1]! : v[base + k - 1]!;
}

/**
 * Per-frame sky extents: s at [axis], t at [6 + axis] (the engine's skymins[0][axis],
 * skymins[1][axis]), on the side's plane at unit distance, in [-1, 1] where visible.
 */
export interface SkyBounds {
  readonly mins: Float32Array;
  readonly maxs: Float32Array;
}

/** Bounds with nothing in view. */
export function newSkyBounds(): SkyBounds {
  const b = { mins: new Float32Array(12), maxs: new Float32Array(12) };
  clearSkyBounds(b);
  return b;
}

/** R_ClearSkyBox. */
export function clearSkyBounds(b: SkyBounds): void {
  b.mins.fill(9999);
  b.maxs.fill(-9999);
}

const ON_EPSILON = 0.1;
const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_ON = 2;

/** DrawSkyPolygon: grow the bounds of the side the polygon's summed vector points at. */
function drawSkyPolygon(b: SkyBounds, vecs: Float32Array, nump: number): void {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < nump; i++) {
    x = f(x + vecs[i * 3]!);
    y = f(y + vecs[i * 3 + 1]!);
    z = f(z + vecs[i * 3 + 2]!);
  }
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  // Strict comparisons: a tie falls through to the next test, and finally to z.
  let axis: number;
  if (ax > ay && ax > az) axis = x < 0 ? 1 : 0;
  else if (ay > az && ay > ax) axis = y < 0 ? 3 : 2;
  else axis = z < 0 ? 5 : 4;

  const [js, jt, jd] = VEC_TO_ST[axis]!;
  for (let i = 0; i < nump; i++) {
    const dv = component(vecs, i * 3, jd);
    if (dv < 0.001) continue; // don't divide by zero
    const s = f(component(vecs, i * 3, js) / dv);
    const t = f(component(vecs, i * 3, jt) / dv);
    if (s < b.mins[axis]!) b.mins[axis] = s;
    if (t < b.mins[6 + axis]!) b.mins[6 + axis] = t;
    if (s > b.maxs[axis]!) b.maxs[axis] = s;
    if (t > b.maxs[6 + axis]!) b.maxs[6 + axis] = t;
  }
}

/**
 * ClipSkyPolygon. The engine Sys_Errors past MAX_CLIP_VERTS (64) and copies the first
 * vertex past the caller's last to close the loop; here lists grow as needed, so any
 * vertex count is accepted, and the wrap reads vertex 0 instead.
 */
function clipSkyPolygon(b: SkyBounds, vecs: Float32Array, nump: number, stage: number): number {
  if (stage === 6) {
    // fully clipped, so draw it
    drawSkyPolygon(b, vecs, nump);
    return 1;
  }
  const [nx, ny, nz] = SKY_CLIP[stage]!;
  const dists = new Float32Array(nump + 1);
  const sides = new Uint8Array(nump + 1);
  let front = false, back = false;
  for (let i = 0; i < nump; i++) {
    const d = f(vecs[i * 3]! * nx + vecs[i * 3 + 1]! * ny + vecs[i * 3 + 2]! * nz);
    if (d > ON_EPSILON) {
      front = true;
      sides[i] = SIDE_FRONT;
    } else if (d < -ON_EPSILON) {
      back = true;
      sides[i] = SIDE_BACK;
    } else sides[i] = SIDE_ON;
    dists[i] = d;
  }
  // not clipped
  if (!front || !back) return clipSkyPolygon(b, vecs, nump, stage + 1);

  sides[nump] = sides[0]!;
  dists[nump] = dists[0]!;
  const lists: [number[], number[]] = [[], []];
  for (let i = 0; i < nump; i++) {
    const v = i * 3;
    const next = ((i + 1) % nump) * 3;
    const side = sides[i]!;
    if (side !== SIDE_BACK) lists[0].push(vecs[v]!, vecs[v + 1]!, vecs[v + 2]!);
    if (side !== SIDE_FRONT) lists[1].push(vecs[v]!, vecs[v + 1]!, vecs[v + 2]!);
    if (side === SIDE_ON || sides[i + 1] === SIDE_ON || sides[i + 1] === side) continue;
    const d = f(dists[i]! / f(dists[i]! - dists[i + 1]!));
    for (let j = 0; j < 3; j++) {
      const e = f(vecs[v + j]! + f(d * f(vecs[next + j]! - vecs[v + j]!)));
      lists[0].push(e);
      lists[1].push(e);
    }
  }
  // continue
  return (
    clipSkyPolygon(b, Float32Array.from(lists[0]), lists[0].length / 3, stage + 1) +
    clipSkyPolygon(b, Float32Array.from(lists[1]), lists[1].length / 3, stage + 1)
  );
}

/** ClipSkyPolygon from stage 0 on `count` points (xyz, already relative to the eye, as R_AddSkySurface subtracts r_origin). Returns the number of DrawSkyPolygon calls (c_sky). */
export function addSkyPolygon(b: SkyBounds, points: ArrayLike<number>, count: number): number {
  const vecs = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) vecs[i] = points[i]!;
  return clipSkyPolygon(b, vecs, count, 0);
}

/**
 * R_SetSky's texture coordinate clamp: [1/256, 255/256] when rotate != 0 (gl_skymip is 0), else [1/512, 511/512].
 * Half a texel of a 256 pixel image avoids the bilerp seam. R_SetSky raises gl_picmip for
 * a rotating sky, but it_sky uploads are not mipmapped, so picmip never shrinks them: the
 * wider clamp is a whole texel there.
 */
export function skyTexClamp(rotate: number): readonly [number, number] {
  // C truthiness: NaN counts as rotating.
  return rotate !== 0 ? [1 / 256, 255 / 256] : [1 / 512, 511 / 512];
}

export interface SkyQuad {
  /** Index into SKY_SUFFIXES, via SKY_TEX_ORDER. */
  readonly image: number;
  readonly axis: number;
}

/** MakeSkyVec into out[o..o+5]: x y z s t. */
function makeSkyVec(out: Float32Array, o: number, s: number, t: number, axis: number, lo: number, hi: number): void {
  const bv = [f(s * SKY_BOX_DISTANCE), f(t * SKY_BOX_DISTANCE), SKY_BOX_DISTANCE];
  const map = ST_TO_VEC[axis]!;
  for (let j = 0; j < 3; j++) out[o + j] = component(bv, 0, map[j]!);
  // avoid bilerp seam
  s = f((s + 1) * 0.5);
  t = f((t + 1) * 0.5);
  if (s < lo) s = lo;
  else if (s > hi) s = hi;
  if (t < lo) t = lo;
  else if (t > hi) t = hi;
  out[o + 3] = s;
  out[o + 4] = 1 - t;
}

/**
 * R_DrawSkyBox's quads in box space (centred on the eye, before rotation): for each axis 0..5 in order that has a nonempty
 * rectangle (mins < maxs on both s and t), four MakeSkyVec vertices in the engine's order
 * (min,min),(min,max),(max,max),(max,min), 5 floats each: x y z s t (t already flipped as MakeSkyVec does: t = 1 - t).
 * When rotate != 0: returns no quads if no side has a nonempty rectangle, else all six full sides (the engine's "hack");
 * `b` is not mutated (the engine overwrites it, but the bounds are cleared every frame anyway).
 */
export function skyBoxQuads(b: SkyBounds, rotate: number): { readonly vertices: Float32Array; readonly quads: readonly SkyQuad[] } {
  const rotating = rotate !== 0;
  let mins: ArrayLike<number> = b.mins;
  let maxs: ArrayLike<number> = b.maxs;
  if (rotating) {
    // check for no sky at all
    let i = 0;
    for (; i < 6; i++) if (mins[i]! < maxs[i]! && mins[6 + i]! < maxs[6 + i]!) break;
    if (i === 6) return { vertices: new Float32Array(0), quads: [] };
    // hack, forces full sky to draw when rotating
    mins = new Array<number>(12).fill(-1);
    maxs = new Array<number>(12).fill(1);
  }
  const [lo, hi] = skyTexClamp(rotate);
  const quads: SkyQuad[] = [];
  const corners: [number, number][] = [];
  for (let axis = 0; axis < 6; axis++) {
    const s0 = mins[axis]!, s1 = maxs[axis]!, t0 = mins[6 + axis]!, t1 = maxs[6 + axis]!;
    if (s0 >= s1 || t0 >= t1) continue;
    quads.push({ image: SKY_TEX_ORDER[axis]!, axis });
    corners.push([s0, t0], [s0, t1], [s1, t1], [s1, t0]);
  }
  const vertices = new Float32Array(corners.length * 5);
  corners.forEach(([s, t], i) => makeSkyVec(vertices, i * 5, s, t, quads[i >> 2]!.axis, lo, hi));
  return { vertices, quads };
}

/**
 * Box to world: translate to the eye, then glRotatef(timeSeconds * rotate, axis). The
 * angle is the engine's float product (r_newrefdef.time * skyrotate). glRotatef rotates
 * counterclockwise in degrees about the normalized axis; like Mesa's _math_matrix_rotate,
 * an axis with exactly one nonzero component is used as is, and any other axis of length
 * at most 1e-4 (a zero axis included) rotates nothing. Column-major.
 */
export function skyMatrix(
  eye: readonly [number, number, number],
  timeSeconds: number,
  rotate: number,
  axis: readonly [number, number, number],
): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = eye[0];
  m[13] = eye[1];
  m[14] = eye[2];
  let [x, y, z] = axis;
  const mag = Math.sqrt(x * x + y * y + z * z);
  const singleAxis = [x, y, z].filter((c) => c !== 0).length === 1;
  if (!singleAxis && !(mag > f(1e-4))) return m;
  x /= mag;
  y /= mag;
  z /= mag;
  const angle = (f(f(timeSeconds) * f(rotate)) * Math.PI) / 180;
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  // prettier-ignore
  m.set([
    x * x * k + c,     y * x * k + z * s, x * z * k - y * s, 0,
    x * y * k - z * s, y * y * k + c,     y * z * k + x * s, 0,
    x * z * k + y * s, y * z * k - x * s, z * z * k + c,     0,
  ]);
  return m;
}

export interface SkySettings {
  /** Image name prefix: the box sides load as env/<name><suffix>. At most 63 characters. */
  readonly name: string;
  /** Degrees per second. */
  readonly rotate: number;
  readonly axis: readonly [number, number, number];
}

/** C's decimal float prefix (atof, scanf %f), anchored at the start; hex, inf and nan are not read. */
const FLOAT_PREFIX = /[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

/** atof, then stored into a float. 0 when nothing parses. */
function atofFloat(s: string): number {
  FLOAT_PREFIX.lastIndex = 0;
  const m = FLOAT_PREFIX.exec(s);
  return m ? f(Number(m[1])) : 0;
}

/**
 * sscanf(s, "%f %f %f") into floats. A field after the first one that fails to parse is
 * left unassigned; the game's ED_ParseField then copies uninitialized stack values, here 0.
 */
function scanVec3(s: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  FLOAT_PREFIX.lastIndex = 0;
  for (let i = 0; i < 3; i++) {
    const m = FLOAT_PREFIX.exec(s);
    if (!m) break;
    out[i] = f(Number(m[1]));
  }
  return out;
}

/**
 * A float through the configstring: printf "%f" (six decimals) on the server, atof or
 * sscanf "%f" back into a float on the client. x * 1e6 is exact in double for any float
 * (24 + 14 significant bits), so the six-decimal rounding is exact; ties go to even as
 * glibc rounds the exact value. A float that overflowed to infinity prints as
 * platform-dependent text ("inf", "1.#INF00"); it is taken as 0 here.
 */
function viaConfigstring(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const scaled = x * 1e6;
  const fl = Math.floor(scaled);
  const frac = scaled - fl;
  const n = frac > 0.5 || (frac === 0.5 && fl % 2 !== 0) ? fl + 1 : fl;
  // glibc prints "-0.000000" for a negative that rounds to zero, and atof keeps the sign.
  return f((n === 0 && x < 0 ? -0 : n) / 1e6);
}

/** ED_NewString's escapes: backslash-n becomes a newline, a backslash before anything else stays a lone backslash. */
function edNewString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++; // past the end too: a trailing backslash is kept
      out += s[i] === "n" ? "\n" : "\\";
    } else out += s[i];
  }
  return out;
}

/** strncpy into skyname[MAX_QPATH]: R_SetSky keeps the first MAX_QPATH - 1 characters. */
const MAX_SKY_NAME = 63;

/**
 * What the client hands R_SetSky for these entities. Entity 0 is spawned into the world
 * edict, and SP_worldspawn runs only when its classname is exactly "worldspawn"
 * (ED_CallSpawn's strcmp); otherwise CS_SKY, CS_SKYROTATE and CS_SKYAXIS stay empty and
 * the client reads "", 0 and (here) 0 0 0. SP_worldspawn sets "sky" (default "unit1_"
 * when absent or empty), "skyrotate" (F_FLOAT) and "skyaxis" (F_VECTOR) as "%f" text,
 * which the client reads back, so values round to six decimals.
 * The image paths ("env/<name><suffix>.tga" in a MAX_QPATH buffer) may truncate further.
 */
export function skySettings(entities: readonly BspEntity[]): SkySettings {
  const world = entities[0];
  if (world?.classname === undefined || edNewString(world.classname) !== "worldspawn") {
    return { name: "", rotate: 0, axis: [0, 0, 0] };
  }
  const sky = world.sky === undefined ? "" : edNewString(world.sky);
  const name = (sky !== "" ? sky : "unit1_").slice(0, MAX_SKY_NAME);
  const rotate = viaConfigstring(world.skyrotate === undefined ? 0 : atofFloat(world.skyrotate));
  const raw = world.skyaxis === undefined ? [0, 0, 0] : scanVec3(world.skyaxis);
  const axis: [number, number, number] = [viaConfigstring(raw[0]!), viaConfigstring(raw[1]!), viaConfigstring(raw[2]!)];
  return { name, rotate, axis };
}
