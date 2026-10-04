// SPDX-License-Identifier: GPL-2.0-or-later
// Area connectivity through open area portals, after FloodAreaConnections,
// CM_AreasConnected and CM_WriteAreaBits in the Quake 2 collision model (cmodel.c).

import type { Bsp } from "./parse.js";

/**
 * Flood number of each area: areas joined through open portals share one. Area 0 (the
 * one solid leafs and the outside are in) is never flooded and keeps 0, as in the
 * engine; areas from 1 up get 1 and up in area order. `open` holds the open portal
 * numbers (dareaportal_t portalnum, the func_areaportal "style"); every other portal is
 * closed.
 *
 * FloodArea_r drops the map ("reflooded") when one flood reaches an area another
 * already holds, which only a portal listed on one side can cause; here the area keeps
 * its first flood number.
 */
export function floodAreas(bsp: Pick<Bsp, "areas" | "areaPortals">, open: ReadonlySet<number>): Int32Array {
  const { areas, areaPortals } = bsp;
  const flood = new Int32Array(areas.count);
  let floodnum = 0;
  for (let start = 1; start < areas.count; start++) {
    if (flood[start]) continue;
    floodnum++;
    flood[start] = floodnum;
    const stack = [start];
    while (stack.length > 0) {
      const a = stack.pop()!;
      const first = areas.firstAreaPortal[a]!;
      for (let p = first; p < first + areas.numAreaPortals[a]!; p++) {
        // checkBspIntegrity reports a span or area past its lump; skip it here.
        if (p < 0 || p >= areaPortals.count || !open.has(areaPortals.portalNum[p]!)) continue;
        const other = areaPortals.otherArea[p]!;
        if (other < 0 || other >= areas.count || flood[other]) continue;
        flood[other] = floodnum;
        stack.push(other);
      }
    }
  }
  return flood;
}

/**
 * CM_AreasConnected: whether two areas are in one flood. Area 0 is connected only to
 * area 0. An area past the lump (the engine drops the map) is connected to nothing.
 */
export function areasConnected(flood: Int32Array, area1: number, area2: number): boolean {
  if (area1 < 0 || area2 < 0 || area1 >= flood.length || area2 >= flood.length) return false;
  return flood[area1] === flood[area2];
}

/**
 * CM_WriteAreaBits: one bit per area, set for the areas in `area`'s flood, or for every
 * area when `area` is 0 (the eye is in solid or outside the map). The renderer draws
 * only world leafs whose area bit is set.
 */
export function areaBits(flood: Int32Array, area: number): Uint8Array {
  const bits = new Uint8Array((flood.length + 7) >> 3);
  const own = area > 0 && area < flood.length ? flood[area] : undefined;
  for (let i = 0; i < flood.length; i++) {
    if (area === 0 || flood[i] === own) bits[i >> 3]! |= 1 << (i & 7);
  }
  return bits;
}
