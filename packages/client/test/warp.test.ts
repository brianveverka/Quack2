// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { SUBDIVIDE_SIZE, TURBSIN, flowingScroll, subdivideWarpPolygon, warpTexCoord, type WarpPoly } from "../src/warp.js";

const f = Math.fround;
const X = [1, 0, 0];
const Y = [0, 1, 0];
const vertCount = (p: WarpPoly) => p.position.length / 3;
const vert = (p: WarpPoly, i: number) => Array.from(p.position.subarray(i * 3, i * 3 + 3));
const stAt = (p: WarpPoly, i: number) => Array.from(p.st.subarray(i * 2, i * 2 + 2));
/** Corner bounds of a poly, centre and closure vertex excluded. */
function bounds(p: WarpPoly) {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 1; i < vertCount(p) - 1; i++) {
    const v = vert(p, i);
    for (let k = 0; k < 3; k++) {
      mins[k] = Math.min(mins[k]!, v[k]!);
      maxs[k] = Math.max(maxs[k]!, v[k]!);
    }
  }
  return { mins, maxs };
}
/** Signed z-component areas of a fan's triangles (centre, corner i, corner i+1). */
function fanAreas(p: WarpPoly): number[] {
  const c = vert(p, 0);
  const out: number[] = [];
  for (let i = 1; i < vertCount(p) - 1; i++) {
    const a = vert(p, i);
    const b = vert(p, i + 1);
    out.push(((a[0]! - c[0]!) * (b[1]! - c[1]!) - (a[1]! - c[1]!) * (b[0]! - c[0]!)) / 2);
  }
  return out;
}
function ngon(n: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    pts.push(radius * Math.cos(a), radius * Math.sin(a), 0);
  }
  return pts;
}

describe("TURBSIN", () => {
  it("is warpsin.h's 256-entry 8*sin table", () => {
    expect(TURBSIN.length).toBe(256);
    expect(TURBSIN[0]).toBe(0);
    expect(TURBSIN[64]).toBe(8);
    for (let i = 0; i < 256; i++) expect(Math.abs(TURBSIN[i]! - 8 * Math.sin((i * 2 * Math.PI) / 256))).toBeLessThan(1e-5);
  });
});

describe("subdivideWarpPolygon", () => {
  it("splits a 128x128 square into four 64x64 fans, last created first", () => {
    const square = [0, 0, 0, 128, 0, 0, 128, 128, 0, 0, 128, 0];
    const polys = subdivideWarpPolygon(square, X, Y);
    expect(SUBDIVIDE_SIZE).toBe(64);
    expect(polys).toHaveLength(4);
    // Creation order is x>=64 (y>=64, y<64), then x<64 (y>=64, y<64); the list is reversed.
    expect(polys.map((p) => bounds(p).mins)).toEqual([
      [0, 0, 0],
      [0, 64, 0],
      [64, 0, 0],
      [64, 64, 0],
    ]);
    for (const p of polys) {
      expect(vertCount(p)).toBe(6);
      const { mins, maxs } = bounds(p);
      expect([maxs[0]! - mins[0]!, maxs[1]! - mins[1]!]).toEqual([64, 64]);
      expect(vert(p, 0)).toEqual([mins[0]! + 32, mins[1]! + 32, 0]);
      expect(vert(p, 5)).toEqual(vert(p, 1));
      expect(stAt(p, 5)).toEqual(stAt(p, 1));
    }
    expect(fanAreas(polys[0]!).every((a) => a > 0)).toBe(true);
    expect(polys.flatMap(fanAreas).reduce((a, b) => a + b, 0)).toBe(128 * 128);
  });

  it("leaves a 32x32 face whole, centre first and first corner repeated last", () => {
    const face = [8, 8, 0, 40, 8, 0, 40, 40, 0, 8, 40, 0];
    const polys = subdivideWarpPolygon(face, X, Y);
    expect(polys).toHaveLength(1);
    const p = polys[0]!;
    expect(vertCount(p)).toBe(6);
    expect(vert(p, 0)).toEqual([24, 24, 0]);
    expect(Array.from(p.position.subarray(3, 15))).toEqual(face);
    expect(vert(p, 5)).toEqual([8, 8, 0]);
  });

  it("does not cut an axis whose cut point is within 8 units of the bound", () => {
    // x: 0..70 rounds m to 64, 6 short of maxs; y: 0..32 rounds m to 0, on mins.
    const polys = subdivideWarpPolygon([0, 0, 0, 70, 0, 0, 70, 32, 0, 0, 32, 0], X, Y);
    expect(polys).toHaveLength(1);
    // x: 0..80 puts m=64 16 units from maxs, so it does cut.
    expect(subdivideWarpPolygon([0, 0, 0, 80, 0, 0, 80, 32, 0, 0, 32, 0], X, Y)).toHaveLength(2);
  });

  it("computes st as plain dot products and averages them at the centre", () => {
    const sVec = [0.5, 0.25, 0];
    const tVec = [0, -1, 0.5];
    const face = [0, 0, 10, 32, 0, 10, 32, 32, 10, 0, 32, 10];
    const p = subdivideWarpPolygon(face, sVec, tVec)[0]!;
    const corners = [0, 1, 2, 3].map((i) => {
      const [x, y, z] = face.slice(i * 3, i * 3 + 3) as [number, number, number];
      return [x * sVec[0]! + y * sVec[1]! + z * sVec[2]!, x * tVec[0]! + y * tVec[1]! + z * tVec[2]!];
    });
    expect([1, 2, 3, 4].map((i) => stAt(p, i))).toEqual(corners);
    expect(corners[1]).toEqual([16, 5]);
    const avg = [0, 1].map((k) => corners.reduce((a, c) => a + c[k]!, 0) / 4);
    expect(stAt(p, 0)).toEqual(avg);
  });

  it("does not mutate the caller's array", () => {
    const square = [0, 0, 0, 128, 0, 0, 128, 128, 0, 0, 128, 0];
    const copy = square.slice();
    subdivideWarpPolygon(square, X, Y);
    expect(square).toEqual(copy);
    const typed = new Float32Array(square);
    subdivideWarpPolygon(typed, X, Y);
    expect(Array.from(typed)).toEqual(copy);
  });

  it("emits a polygon over 60 vertices whole instead of dropping the map", () => {
    const polys = subdivideWarpPolygon(ngon(61, 100), X, Y);
    expect(polys).toHaveLength(1);
    expect(vertCount(polys[0]!)).toBe(63);
    // 60 is within the engine's limit and subdivides as usual.
    expect(subdivideWarpPolygon(ngon(60, 100), X, Y).length).toBeGreaterThan(1);
  });

  it("returns nothing for a degenerate polygon of fewer than 3 vertices", () => {
    expect(subdivideWarpPolygon([0, 0, 0, 64, 0, 0], X, Y)).toEqual([]);
  });

  it("terminates on a polygon beyond the 9999 starting bound", () => {
    // The engine recurses forever here: the phantom bound leaves one side of the cut empty.
    const polys = subdivideWarpPolygon([10000, 0, 0, 10032, 0, 0, 10032, 32, 0, 10000, 32, 0], X, Y);
    expect(polys).toHaveLength(1);
    // A vertex on the cut (m = 10048) and the rest beyond it, and the negative mirror.
    expect(subdivideWarpPolygon([10048, 0, 0, 10097, 0, 0, 10097, 32, 0, 10048, 32, 0], X, Y)).toHaveLength(1);
    expect(subdivideWarpPolygon([-10048, 0, 0, -10048, 32, 0, -10097, 32, 0, -10097, 0, 0], X, Y)).toHaveLength(1);
  });

  it("splits a diagonal triangle into convex fans that preserve its area", () => {
    const tri = [0, 0, 0, 200, 10, 0, 30, 170, 0];
    const area = (200 * 170 - 10 * 30) / 2;
    const polys = subdivideWarpPolygon(tri, X, Y);
    expect(polys.length).toBeGreaterThan(4);
    let total = 0;
    for (const p of polys) {
      const areas = fanAreas(p);
      for (const a of areas) expect(a).toBeGreaterThan(-1e-3);
      total += areas.reduce((a, b) => a + b, 0);
      const { mins, maxs } = bounds(p);
      // Each piece stays inside one 64-unit cell, give or take the 8-unit slack.
      expect(maxs[0]! - mins[0]!).toBeLessThan(64 + 8);
      expect(maxs[1]! - mins[1]!).toBeLessThan(64 + 8);
    }
    expect(Math.abs(total - area)).toBeLessThan(1e-3);
  });
});

describe("warpTexCoord", () => {
  it("adds the table value indexed by the other coordinate, then divides by 64", () => {
    expect(warpTexCoord(0, 0, 0, false)).toEqual([0, 0]);
    // s: 128 * 0.125 * 40.74 = 651.9 -> 651 & 255 = 139; t: 64 * 0.125 * 40.74 = 325.9 -> 325 & 255 = 69.
    expect(warpTexCoord(64, 128, 0, false)).toEqual([f(64 + TURBSIN[139]!) / 64, f(128 + TURBSIN[69]!) / 64]);
  });

  it("indexes the table by (int)((x*0.125 + time) * TURBSCALE) & 255", () => {
    // 0.25 * 40.74 = 10.19 -> 10.
    const v = f(TURBSIN[10]!) / 64;
    expect(warpTexCoord(0, 0, 0.25, false)).toEqual([v, v]);
  });

  it("truncates toward zero and wraps negative indices two's complement", () => {
    // -16 * 0.125 * 40.74 = -81.49 -> -81 (floor would give -82) -> & 255 = 175.
    expect(TURBSIN[175]).toBe(f(-7.31368));
    expect(warpTexCoord(0, -16, 0, false)).toEqual([f(f(-7.31368) / 64), -0.25]);
  });

  it("scrolls flowing surfaces by -64 * frac(time / 2)", () => {
    // time 3: scroll = -64 * 0.5 = -32; index 3 * 40.74 = 122.2 -> 122.
    const sin = TURBSIN[122]!;
    expect(sin).toBe(f(1.17384));
    expect(warpTexCoord(0, 0, 3, true)).toEqual([f(f(sin - 32) / 64), f(sin / 64)]);
    expect(warpTexCoord(0, 0, 3, false)).toEqual([f(sin / 64), f(sin / 64)]);
  });
});

describe("flowingScroll", () => {
  it("is -64 * frac(time / 40) texture widths", () => {
    expect(flowingScroll(10)).toBe(-16);
    expect(flowingScroll(30)).toBe(-48);
    expect(flowingScroll(50)).toBe(-16);
    // 1 / 40 is not exact in double; the product rounds to float.
    expect(flowingScroll(1)).toBe(f(-64 * (1 / 40)));
  });

  it("scrolls -64 where frac is 0, as the C swaps it", () => {
    expect(flowingScroll(0)).toBe(-64);
    expect(flowingScroll(40)).toBe(-64);
    expect(flowingScroll(80)).toBe(-64);
  });

  it("rounds time to float first", () => {
    // 0.3 as a float is 0.30000001192..., not the double 0.3.
    expect(flowingScroll(0.3)).toBe(f(-64 * (f(0.3) / 40)));
    expect(flowingScroll(0.3)).not.toBe(f(-64 * (0.3 / 40)));
  });
});
