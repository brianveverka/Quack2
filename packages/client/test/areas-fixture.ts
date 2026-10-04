// SPDX-License-Identifier: GPL-2.0-or-later
import { floodAreas, type Bsp } from "@quack2/sim";

/**
 * The fixture split by a synthetic area portal (number 1) along the dividing wall at
 * x -8..8: leafs wholly east of it (x 8 up) are area 2, the rest keep area 1 (solid
 * leafs area 0). The fixture as compiled has one area and no portals.
 */
export function withEastArea(bsp: Bsp): Bsp {
  const area = Int16Array.from(bsp.leafs.area);
  for (let l = 0; l < bsp.leafs.count; l++) if (area[l] && bsp.leafs.mins[l * 3]! >= 8) area[l] = 2;
  return {
    ...bsp,
    leafs: { ...bsp.leafs, area },
    areas: { count: 3, numAreaPortals: Int32Array.from([0, 1, 1]), firstAreaPortal: Int32Array.from([0, 0, 1]) },
    areaPortals: { count: 2, portalNum: Int32Array.from([1, 1]), otherArea: Int32Array.from([2, 1]) },
  };
}

export const closedFlood = (bsp: Bsp) => floodAreas(bsp, new Set());
export const openFlood = (bsp: Bsp) => floodAreas(bsp, new Set([1]));
