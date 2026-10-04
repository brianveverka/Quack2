// SPDX-License-Identifier: GPL-2.0-or-later
// Light styles: the CS_LIGHTS configstrings that animate lightmap brightness, and the
// client's per-frame evaluation of them (CL_SetLightstyle / CL_RunLightStyles in
// client/cl_fx.c). Lives in sim so the server table and the renderer agree.

/** Light styles per map: CS_LIGHTS configstrings. */
export const MAX_LIGHTSTYLES = 256;

// SP_worldspawn (game/g_spawn.c). Styles 32+ come only from targeted lights, which
// SP_light frees in deathmatch, and SP_target_lightramp frees itself there too.
const WORLDSPAWN_STYLES: Readonly<Record<number, string>> = {
  0: "m", // normal
  1: "mmnmmommommnonmmonqnmmo", // flicker 1
  2: "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba", // slow strong pulse
  3: "mmmmmaaaaammmmmaaaaaabcdefgabcdefg", // candle 1
  4: "mamamamamama", // fast strobe
  5: "jklmnopqrstuvwxyzyxwvutsrqponmlkj", // gentle pulse 1
  6: "nmonqnmomnmomomno", // flicker 2
  7: "mmmaaaabcdefgmmmmaaaammmaamm", // candle 2
  8: "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa", // candle 3
  9: "aaaaaaaazzzzzzzz", // slow strobe
  10: "mmamammmmammamamaaamammma", // fluorescent flicker
  11: "abcdefghijklmnopqrrqponmlkjihgfedcba", // slow pulse, not fading to black
  63: "a", // testing
};

/** CS_LIGHTS configstrings in deathmatch: worldspawn's table, every other style empty. */
export const DEATHMATCH_LIGHTSTYLES: readonly string[] = Object.freeze(
  Array.from({ length: MAX_LIGHTSTYLES }, (_, n) => WORLDSPAWN_STYLES[n] ?? ""),
);

const A = 97; // 'a'
const M = 109; // 'm'

/**
 * Brightness of each style at `timeMs` since the level started, as the client computes it
 * (1 = normal, 'm'). Writes into `out` (length >= styles.length) and returns it.
 */
export function lightStyleValues(
  styles: readonly string[],
  timeMs: number,
  out: Float32Array = new Float32Array(MAX_LIGHTSTYLES),
): Float32Array {
  // The engine steps at 10 Hz: ofs = cl.time / 100 in integer milliseconds.
  const ofs = Math.floor(timeMs / 100);
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i]!;
    if (s.length === 0) {
      out[i] = 1;
      continue;
    }
    const k = s.length === 1 ? 0 : ((ofs % s.length) + s.length) % s.length;
    // C divides as float; fround keeps the result bit-equal to that float32.
    out[i] = Math.fround((s.charCodeAt(k) - A) / (M - A));
  }
  return out;
}
