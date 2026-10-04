// SPDX-License-Identifier: GPL-2.0-or-later
// C's float-to-int conversion as x86 builds of the engine run it.

const INT_MIN = -2147483648;

/**
 * (int)x for a float or double, as x86 compiles it: truncated toward zero, and
 * INT_MIN for NaN, the infinities and anything else outside int's range. The C leaves
 * those undefined; SSE's cvttss2si/cvttsd2si give INT_MIN, as Intel documents the x87
 * fistp (MSVC's _ftol) does. JS's ToInt32 (`x | 0`) wraps instead.
 */
export function cInt(x: number): number {
  return x > -2147483649 && x < 2147483648 ? Math.trunc(x) : INT_MIN;
}
