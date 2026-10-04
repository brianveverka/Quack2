// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { areaBits, areasConnected, floodAreas } from "../src/index.js";

/** Areas from per-area portal lists of [portalnum, otherarea]; area 0 has none. */
function areaLumps(lists: [number, number][][]) {
  const flat = lists.flat();
  let first = 0;
  return {
    areas: {
      count: lists.length,
      numAreaPortals: Int32Array.from(lists, (l) => l.length),
      firstAreaPortal: Int32Array.from(lists, (l) => ((first += l.length), first - l.length)),
    },
    areaPortals: {
      count: flat.length,
      portalNum: Int32Array.from(flat, (p) => p[0]),
      otherArea: Int32Array.from(flat, (p) => p[1]),
    },
  };
}

// A row of three rooms: 1 -(portal 1)- 2 -(portal 2)- 3, each portal listed on both sides.
const row = areaLumps([[], [[1, 2]], [[1, 1], [2, 3]], [[2, 2]]]);

describe("area flood", () => {
  it("numbers areas from 1, area 0 keeps 0, closed portals separate", () => {
    expect([...floodAreas(row, new Set())]).toEqual([0, 1, 2, 3]);
  });

  it("an open portal joins the areas on its two sides", () => {
    expect([...floodAreas(row, new Set([1]))]).toEqual([0, 1, 1, 2]);
    expect([...floodAreas(row, new Set([2]))]).toEqual([0, 1, 2, 2]);
    expect([...floodAreas(row, new Set([1, 2]))]).toEqual([0, 1, 1, 1]);
  });

  it("ignores portal numbers no area lists", () => {
    expect([...floodAreas(row, new Set([0, 7, -1]))]).toEqual([0, 1, 2, 3]);
  });

  it("a portal listed on one side only floods one way, keeping each area's first flood (the engine drops the map)", () => {
    // Area 1 lists nothing; area 2 lists portal 1 to area 1.
    const oneSided = areaLumps([[], [], [[1, 1]]]);
    expect([...floodAreas(oneSided, new Set([1]))]).toEqual([0, 1, 2]);
    // Area 1 lists portal 1 to area 2; area 2 lists nothing.
    const reverse = areaLumps([[], [[1, 2]], []]);
    expect([...floodAreas(reverse, new Set([1]))]).toEqual([0, 1, 1]);
  });

  it("skips portal spans and other areas past their lumps", () => {
    // Area 1's span runs past the lump; inside it, one portal to an area past the lump
    // and area 2's back to area 1, so area 1 floods alone.
    const bad = areaLumps([[], [[1, 9]], [[1, 1]]]);
    const spans = { ...bad, areas: { ...bad.areas, numAreaPortals: Int32Array.from([0, 5, 1]) } };
    expect([...floodAreas(spans, new Set([1]))]).toEqual([0, 1, 2]);
  });

  it("floods into area 0 only through a portal to it, as FloodArea_r does", () => {
    const toZero = areaLumps([[], [[1, 0]]]);
    expect([...floodAreas(toZero, new Set([1]))]).toEqual([1, 1]);
  });
});

describe("area connections", () => {
  const flood = floodAreas(row, new Set([1]));

  it("connects areas in one flood (CM_AreasConnected)", () => {
    expect(areasConnected(flood, 1, 2)).toBe(true);
    expect(areasConnected(flood, 2, 3)).toBe(false);
    expect(areasConnected(flood, 0, 0)).toBe(true);
    expect(areasConnected(flood, 0, 1)).toBe(false);
    expect(areasConnected(flood, 1, 4)).toBe(false);
  });

  it("sets the bits of the eye area's flood, or of every area from area 0 (CM_WriteAreaBits)", () => {
    expect([...areaBits(flood, 1)]).toEqual([0b0110]);
    expect([...areaBits(flood, 3)]).toEqual([0b1000]);
    expect([...areaBits(flood, 0)]).toEqual([0b1111]);
    const many = floodAreas(areaLumps(Array.from({ length: 10 }, () => [])), new Set());
    expect([...areaBits(many, 9)]).toEqual([0, 0b10]);
    expect([...areaBits(many, 0)]).toEqual([0xff, 0b11]);
  });
});
