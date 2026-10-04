// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { cInt } from "../src/cint.js";

describe("cInt", () => {
  it("truncates toward zero within int's range", () => {
    expect([2.9, -2.9, 0.5, 2147483647.9, -2147483648.9].map(cInt)).toEqual([2, -2, 0, 2147483647, -2147483648]);
  });

  it("gives INT_MIN for NaN, the infinities and anything past int's range, as x86 does", () => {
    // From a gcc (SSE) build: (int) of each, as a double.
    expect([Number.NaN, Infinity, -Infinity, 2147483648, -2147483649, 4294967296 + 5, 1e300].map(cInt)).toEqual([
      -2147483648, -2147483648, -2147483648, -2147483648, -2147483648, -2147483648, -2147483648,
    ]);
  });
});
