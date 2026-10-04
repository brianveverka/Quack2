// SPDX-License-Identifier: GPL-2.0-or-later
import type { BspEntity } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { transformPoint } from "../src/math.js";
import {
  SKY_BOX_DISTANCE,
  SKY_SUFFIXES,
  SKY_TEX_ORDER,
  addSkyPolygon,
  clearSkyBounds,
  newSkyBounds,
  skyBoxQuads,
  skyMatrix,
  skySettings,
  skyTexClamp,
  type SkyBounds,
} from "../src/sky.js";

const f = Math.fround;

/** [smin, smax, tmin, tmax] of one axis. */
function rect(b: SkyBounds, axis: number): number[] {
  return [b.mins[axis]!, b.maxs[axis]!, b.mins[6 + axis]!, b.maxs[6 + axis]!];
}

const EMPTY = [9999, -9999, 9999, -9999];

function expectClose(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, 5));
}

function setRect(b: SkyBounds, axis: number, s0: number, s1: number, t0: number, t1: number): void {
  b.mins[axis] = s0;
  b.maxs[axis] = s1;
  b.mins[6 + axis] = t0;
  b.maxs[6 + axis] = t1;
}

describe("sky polygon clipping", () => {
  it("starts and clears to the empty bounds", () => {
    const b = newSkyBounds();
    expect(Array.from(b.mins)).toEqual(new Array(12).fill(9999));
    expect(Array.from(b.maxs)).toEqual(new Array(12).fill(-9999));
    addSkyPolygon(b, [100, 10, 10, 100, -10, 10, 100, -10, -10], 3);
    expect(rect(b, 0)).not.toEqual(EMPTY);
    clearSkyBounds(b);
    expect(Array.from(b.mins)).toEqual(new Array(12).fill(9999));
    expect(Array.from(b.maxs)).toEqual(new Array(12).fill(-9999));
  });

  it("maps a square straight ahead on +x to axis 0, cut in four by the z = +-y planes", () => {
    const b = newSkyBounds();
    const n = addSkyPolygon(b, [100, 10, 10, 100, -10, 10, 100, -10, -10, 100, 10, -10], 4);
    expect(n).toBe(4);
    // vec_to_st[0]: s = -y / x, t = z / x.
    expect(rect(b, 0)).toEqual([f(-0.1), f(0.1), f(-0.1), f(0.1)]);
    for (let axis = 1; axis < 6; axis++) expect(rect(b, axis)).toEqual(EMPTY);
  });

  it("splits a polygon across the x = y plane into axis 0 and axis 2", () => {
    const b = newSkyBounds();
    addSkyPolygon(b, [100, -50, 10, 100, 150, 10, 100, 150, -10, 100, -50, -10], 4);
    // Axis 0 up to the split at y = 100: s = -y / x in [-1, 0.5], t = z / x.
    expectClose(rect(b, 0), [-1, 0.5, -0.1, 0.1]);
    // Axis 2 beyond it (vec_to_st[2]): s = x / y in [100/150, 1], t = z / y, widest at y = 100.
    expectClose(rect(b, 2), [100 / 150, 1, -0.1, 0.1]);
    for (const axis of [1, 3, 4, 5]) expect(rect(b, axis)).toEqual(EMPTY);
  });

  it("maps a polygon behind the eye to axis 1", () => {
    const b = newSkyBounds();
    addSkyPolygon(b, [-100, 0, 5, -100, 20, 5, -100, 20, 15, -100, 0, 15], 4);
    // vec_to_st[1]: dv = -x, s = y / dv, t = z / dv.
    expectClose(rect(b, 1), [0, 0.2, 0.05, 0.15]);
    for (const axis of [0, 2, 3, 4, 5]) expect(rect(b, axis)).toEqual(EMPTY);
  });

  it("skips vertices less than 0.001 in front of the side", () => {
    const b = newSkyBounds();
    // The first vertex would give s = 0.4 / 0.5 = 0.8 if it counted.
    const n = addSkyPolygon(b, [0.0005, -0.0004, 0, 100, 10, 10, 100, -10, 10], 3);
    expect(n).toBe(1);
    expectClose(rect(b, 0), [-0.1, 0.1, 0.1, 0.1]);
  });

  it("falls through a tie between |x| and |y| to the z sides", () => {
    const b = newSkyBounds();
    // Sum (300, 300, 5): neither x nor y is strictly largest, so axis 4. Only the z = 10
    // vertex is in front of it: vec_to_st[4] gives s = -y / z, t = -x / z.
    expect(addSkyPolygon(b, [100, 100, 0, 100, 100, 10, 100, 100, -5], 3)).toBe(1);
    expect(rect(b, 4)).toEqual([-10, -10, -10, -10]);
    for (const axis of [0, 1, 2, 3, 5]) expect(rect(b, axis)).toEqual(EMPTY);
  });

  it("accepts more vertices than the engine's MAX_CLIP_VERTS", () => {
    const b = newSkyBounds();
    const pts: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * 2 * Math.PI;
      pts.push(100, 50 * Math.cos(a), 50 * Math.sin(a));
    }
    expect(addSkyPolygon(b, pts, 200)).toBe(4);
    expectClose(rect(b, 0), [-0.5, 0.5, -0.5, 0.5]);
  });
});

describe("sky box quads", () => {
  it("emits axis 0's rectangle with st_to_vec positions and seam-clamped, flipped texcoords", () => {
    const b = newSkyBounds();
    setRect(b, 0, -0.5, 0.25, 0, 0.5);
    const { vertices, quads } = skyBoxQuads(b, 0);
    expect(quads).toEqual([{ image: 0, axis: 0 }]);
    // prettier-ignore
    expectClose(vertices, [
      2300, 1150, 0, 0.25, 0.5,
      2300, 1150, 1150, 0.25, 0.25,
      2300, -575, 1150, 0.625, 0.25,
      2300, -575, 0, 0.625, 0.5,
    ]);
  });

  it("emits axis 2's full side, clamped to half a texel of a 256 image", () => {
    const b = newSkyBounds();
    setRect(b, 2, -1, 1, -1, 1);
    const { vertices, quads } = skyBoxQuads(b, 0);
    expect(quads).toEqual([{ image: 1, axis: 2 }]);
    const lo = 1 / 512, hi = 511 / 512;
    // prettier-ignore
    expectClose(vertices, [
      -2300, 2300, -2300, lo, hi,
      -2300, 2300, 2300, lo, lo,
      2300, 2300, 2300, hi, lo,
      2300, 2300, -2300, hi, hi,
    ]);
  });

  it("emits axis 4's rectangle", () => {
    const b = newSkyBounds();
    setRect(b, 4, 0, 0.5, -0.5, 0);
    const { vertices, quads } = skyBoxQuads(b, 0);
    expect(quads).toEqual([{ image: 4, axis: 4 }]);
    // st_to_vec[4]: (-t, -s, 1) * 2300.
    // prettier-ignore
    expectClose(vertices, [
      1150, 0, 2300, 0.5, 0.75,
      0, 0, 2300, 0.5, 0.5,
      0, -1150, 2300, 0.75, 0.5,
      1150, -1150, 2300, 0.75, 0.75,
    ]);
  });

  it("shows rt, lf, bk, ft, up, dn on +x, -x, +y, -y, +z, -z", () => {
    const b = newSkyBounds();
    for (let axis = 0; axis < 6; axis++) setRect(b, axis, -1, 1, -1, 1);
    const { vertices, quads } = skyBoxQuads(b, 0);
    expect(quads.map((q) => q.axis)).toEqual([0, 1, 2, 3, 4, 5]);
    const byDirection: Record<string, string> = {};
    quads.forEach((q, i) => {
      const c = [0, 1, 2].map((k) => [0, 1, 2, 3].reduce((sum, v) => sum + vertices[(i * 4 + v) * 5 + k]!, 0) / 4);
      const k = c.findIndex((x) => Math.abs(x) === SKY_BOX_DISTANCE);
      byDirection[(c[k]! > 0 ? "+" : "-") + "xyz"[k]] = SKY_SUFFIXES[q.image]!;
      expect(q.image).toBe(SKY_TEX_ORDER[q.axis]);
    });
    expect(byDirection).toEqual({ "+x": "rt", "-x": "lf", "+y": "bk", "-y": "ft", "+z": "up", "-z": "dn" });
  });

  it("puts the left image edge at +y and the top row at +z on the +x side", () => {
    const b = newSkyBounds();
    setRect(b, 0, -1, 1, -1, 1);
    const { vertices } = skyBoxQuads(b, 0);
    for (let v = 0; v < 4; v++) {
      const [, y, z, s, t] = vertices.subarray(v * 5, v * 5 + 5);
      expect(s === f(1 / 512)).toBe(y === 2300);
      expect(t === f(1 / 512)).toBe(z === 2300);
    }
  });

  it("skips empty and degenerate rectangles", () => {
    const b = newSkyBounds();
    setRect(b, 1, 0.2, 0.2, -0.5, 0.5);
    expect(skyBoxQuads(b, 0)).toEqual({ vertices: new Float32Array(0), quads: [] });
  });

  it("draws all six full sides when rotating and anything is visible, nothing otherwise", () => {
    const b = newSkyBounds();
    expect(skyBoxQuads(b, 10)).toEqual({ vertices: new Float32Array(0), quads: [] });
    setRect(b, 3, 0.1, 0.2, 0.1, 0.2);
    const before = [Array.from(b.mins), Array.from(b.maxs)];
    const { vertices, quads } = skyBoxQuads(b, 10);
    expect(quads.map((q) => q.axis)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(vertices.length).toBe(6 * 4 * 5);
    // Full side, clamped at 1/256: a whole texel, since picmip does not shrink it_sky images.
    expectClose(vertices.subarray(0, 5), [2300, 2300, -2300, 1 / 256, 255 / 256]);
    expect([Array.from(b.mins), Array.from(b.maxs)]).toEqual(before);
  });
});

describe("sky texture clamp", () => {
  it("is 1/512 still, 1/256 rotating", () => {
    expect(skyTexClamp(0)).toEqual([1 / 512, 511 / 512]);
    expect(skyTexClamp(5)).toEqual([1 / 256, 255 / 256]);
    expect(skyTexClamp(-0.5)).toEqual([1 / 256, 255 / 256]);
  });
});

describe("sky matrix", () => {
  const apply = (m: Float32Array, p: [number, number, number]) => transformPoint(m, ...p).slice(0, 3);

  it("translates to the eye", () => {
    expectClose(apply(skyMatrix([10, 20, 30], 5, 0, [0, 0, 1]), [1, 2, 3]), [11, 22, 33]);
  });

  it("rotates counterclockwise in degrees per second about the normalized axis", () => {
    const m = skyMatrix([0, 0, 0], 2, 45, [0, 0, 7]);
    expectClose(apply(m, [1, 0, 0]), [0, 1, 0]);
    expectClose(apply(m, [0, 1, 0]), [-1, 0, 0]);
    // 180 degrees about the x = y diagonal swaps x and y.
    expectClose(apply(skyMatrix([0, 0, 0], 1, 180, [1, 1, 0]), [1, 0, 0]), [0, 1, 0]);
  });

  it("rotates nothing about a zero (or Mesa-tiny) axis, but a single tiny component still counts", () => {
    expectClose(apply(skyMatrix([1, 2, 3], 1, 90, [0, 0, 0]), [1, 0, 0]), [2, 2, 3]);
    expectClose(apply(skyMatrix([0, 0, 0], 1, 90, [1e-5, 1e-5, 0]), [1, 0, 0]), [1, 0, 0]);
    expectClose(apply(skyMatrix([0, 0, 0], 1, 90, [0, 0, 1e-6]), [1, 0, 0]), [0, 1, 0]);
  });
});

describe("sky settings", () => {
  const world = (fields: Record<string, string>): BspEntity[] => [{ classname: "worldspawn", ...fields }];

  it("defaults to unit1_, no rotation", () => {
    expect(skySettings(world({}))).toEqual({ name: "unit1_", rotate: 0, axis: [0, 0, 0] });
    expect(skySettings(world({ sky: "" }))).toEqual({ name: "unit1_", rotate: 0, axis: [0, 0, 0] });
    expect(skySettings(world({ sky: "space1_", skyrotate: "10", skyaxis: "0 0 1" }))).toEqual({
      name: "space1_",
      rotate: 10,
      axis: [0, 0, 1],
    });
  });

  it("sets nothing when entity 0 is not exactly worldspawn", () => {
    const none = { name: "", rotate: 0, axis: [0, 0, 0] };
    expect(skySettings([])).toEqual(none);
    expect(skySettings([{ classname: "Worldspawn", sky: "x" }])).toEqual(none);
    expect(skySettings([{ sky: "x" }])).toEqual(none);
    expect(skySettings([{ classname: "info_null" }, { classname: "worldspawn", sky: "x" }])).toEqual(none);
  });

  it("rounds rotate to six decimals through the configstring", () => {
    const rotate = (v: string) => skySettings(world({ skyrotate: v })).rotate;
    expect(rotate("0.0000004")).toBe(0);
    expect(rotate("0.0000006")).toBe(f(0.000001));
    expect(rotate("1.23456789")).toBe(f(1.234568));
    expect(Object.is(rotate("-0.0000004"), -0)).toBe(true);
    // Exact ties of the float value round to even, as glibc's printf does.
    expect(rotate("0.0078125")).toBe(f(0.007812));
    expect(rotate("0.0234375")).toBe(f(0.023438));
    expect(rotate("12abc")).toBe(12);
    expect(rotate("abc")).toBe(0);
    expect(rotate("1e39")).toBe(0); // overflows the float
  });

  it("reads the axis as sscanf %f %f %f does, rounded the same way", () => {
    const axis = (v: string) => skySettings(world({ skyaxis: v })).axis;
    expect(axis("1 0.5 0.0000004")).toEqual([1, 0.5, 0]);
    expect(axis("2 3")).toEqual([2, 3, 0]);
    expect(axis("1 x 3")).toEqual([1, 0, 0]);
    expect(axis("1.5.25 2")).toEqual([1.5, 0.25, 2]);
    expect(axis("0.1 0 0")).toEqual([f(0.1), 0, 0]);
  });

  it("truncates the name to 63 characters and applies ED_NewString escapes", () => {
    expect(skySettings(world({ sky: "a".repeat(70) })).name).toBe("a".repeat(63));
    expect(skySettings(world({ sky: "a\\nb\\xc\\" })).name).toBe("a\nb\\c\\");
  });
});
