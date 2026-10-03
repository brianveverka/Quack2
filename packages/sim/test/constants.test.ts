// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { PLAYER_MAXS, PLAYER_MINS } from "../src/index.js";

describe("player box", () => {
  it("is the stock Quake 2 32x32x56 box", () => {
    expect(PLAYER_MAXS.map((v, k) => v - PLAYER_MINS[k]!)).toEqual([32, 32, 56]);
    expect(Object.isFrozen(PLAYER_MINS) && Object.isFrozen(PLAYER_MAXS)).toBe(true);
  });
});
