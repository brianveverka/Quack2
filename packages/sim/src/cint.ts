// SPDX-License-Identifier: GPL-2.0-or-later
// C's float-to-int conversion as x86 builds of the engine run it.

const INT_MIN = -2147483648;

/**
 * (int)x for a float or double, as x86 compiles it: truncated toward zero, and
 * INT_MIN for NaN, the infinities and anything else outside int's range, as SSE builds
 * (cvttss2si, cvttsd2si) and a 32-bit x87 fistp give. The C leaves those undefined. The
 * win32 game DLL differs: MSVC's _ftol stores a 64-bit fistp and keeps its low 32 bits,
 * so 0 for NaN and the infinities and a wrapped value past int's range (see BACKLOG.md
 * on which build is the reference). Never -0, which int has no room for.
 */
export function cInt(x: number): number {
  return x > -2147483649 && x < 2147483648 ? Math.trunc(x) + 0 : INT_MIN;
}
