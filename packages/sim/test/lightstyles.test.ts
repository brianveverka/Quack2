// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { DEATHMATCH_LIGHTSTYLES, MAX_LIGHTSTYLES, lightStyleValues } from "../src/index.js";

const PULSE = "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba";

describe("DEATHMATCH_LIGHTSTYLES", () => {
  it("is the worldspawn table, frozen, every other style empty", () => {
    expect(DEATHMATCH_LIGHTSTYLES).toHaveLength(MAX_LIGHTSTYLES);
    expect(Object.isFrozen(DEATHMATCH_LIGHTSTYLES)).toBe(true);
    expect(DEATHMATCH_LIGHTSTYLES[0]).toBe("m");
    expect(DEATHMATCH_LIGHTSTYLES[1]).toBe("mmnmmommommnonmmonqnmmo");
    expect(DEATHMATCH_LIGHTSTYLES[2]).toBe(PULSE);
    expect(DEATHMATCH_LIGHTSTYLES[11]).toBe("abcdefghijklmnopqrrqponmlkjihgfedcba");
    expect(DEATHMATCH_LIGHTSTYLES[63]).toBe("a");
    expect(DEATHMATCH_LIGHTSTYLES[12]).toBe("");
    expect(DEATHMATCH_LIGHTSTYLES[32]).toBe("");
    const set = DEATHMATCH_LIGHTSTYLES.flatMap((s, n) => (s ? [n] : []));
    expect(set).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 63]);
  });
});

describe("lightStyleValues", () => {
  it("maps 'a' to 0, 'm' to 1 and 'z' to the float32 of 25/12", () => {
    const v = lightStyleValues(["a", "m", "z"], 0);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(1);
    expect(v[2]).toBe(Math.fround(25 / 12));
  });

  it("steps style 2 every 100 ms and wraps at length * 100", () => {
    const at = (t: number) => lightStyleValues(DEATHMATCH_LIGHTSTYLES, t)[2];
    expect(at(0)).toBe(0); // 'a'
    expect(at(99)).toBe(0);
    expect(at(100)).toBe(Math.fround(1 / 12)); // 'b'
    expect(at(2500)).toBe(Math.fround(25 / 12)); // 'z'
    expect(at(PULSE.length * 100)).toBe(0);
    expect(at(PULSE.length * 100 + 100)).toBe(Math.fround(1 / 12));
  });

  it("floors fractional and negative times with a non-negative modulo", () => {
    expect(lightStyleValues([PULSE], 199.9)[0]).toBe(Math.fround(1 / 12));
    expect(lightStyleValues([PULSE], -1)[0]).toBe(0); // last char, 'a'
    expect(lightStyleValues([PULSE], -101)[0]).toBe(Math.fround(1 / 12)); // 'b'
  });

  it("returns 1 for an empty style", () => {
    expect(lightStyleValues(DEATHMATCH_LIGHTSTYLES, 1234)[12]).toBe(1);
  });

  it("holds a single-character style constant over time", () => {
    for (const t of [0, 100, 12345, 999999]) {
      const v = lightStyleValues(DEATHMATCH_LIGHTSTYLES, t);
      expect(v[0]).toBe(1);
      expect(v[63]).toBe(0);
    }
  });

  it("writes into and returns the given out array", () => {
    const out = new Float32Array(MAX_LIGHTSTYLES).fill(-1);
    expect(lightStyleValues(DEATHMATCH_LIGHTSTYLES, 100, out)).toBe(out);
    expect(out[2]).toBe(Math.fround(1 / 12));
    expect(out[255]).toBe(1);
    expect(lightStyleValues(["z"], 0, out)).toBe(out);
    expect(out[0]).toBe(Math.fround(25 / 12));
    expect(out[2]).toBe(Math.fround(1 / 12)); // untouched beyond styles.length
  });

  it("defaults out to MAX_LIGHTSTYLES floats", () => {
    expect(lightStyleValues([], 0)).toHaveLength(MAX_LIGHTSTYLES);
  });
});
