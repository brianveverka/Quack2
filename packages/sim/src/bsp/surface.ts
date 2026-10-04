// SPDX-License-Identifier: GPL-2.0-or-later
// Per-face surface math: polygon winding, texture coordinates, and lightmap extents,
// after CalcSurfaceExtents in the Quake 2 ref_gl model loader. Shared by the renderer
// (mesh building) and the integrity checks (lightmap sizes).

import { MAX_LIGHTMAPS } from "./format.js";
import type { Bsp } from "./parse.js";

/** World units per lightmap sample (luxel) in IBSP v38. */
export const LIGHTMAP_SCALE = 16;

/**
 * Vertex index of each corner of a face, in winding order. Surfedge e >= 0 walks edge e
 * forwards (starts at v0), e < 0 walks edge -e backwards (starts at v1).
 */
export function faceVertexIndices(bsp: Bsp, face: number): number[] {
  const first = bsp.faces.firstEdge[face]!;
  const num = bsp.faces.numEdges[face]!;
  const out: number[] = [];
  for (let i = 0; i < num; i++) {
    const e = bsp.surfEdges[first + i]!;
    out.push(e >= 0 ? bsp.edges[e * 2]! : bsp.edges[-e * 2 + 1]!);
  }
  return out;
}

/** Texture-space (s, t) of a world point under a texinfo, in texels. */
export function texCoord(bsp: Bsp, texinfo: number, x: number, y: number, z: number): [number, number] {
  const v = bsp.texinfo.vecs;
  const o = texinfo * 8;
  return [
    x * v[o]! + y * v[o + 1]! + z * v[o + 2]! + v[o + 3]!,
    x * v[o + 4]! + y * v[o + 5]! + z * v[o + 6]! + v[o + 7]!,
  ];
}

export interface LightmapExtents {
  /** Texture-space s, t of luxel (0, 0): floor(min / 16) * 16. */
  readonly textureMinS: number;
  readonly textureMinT: number;
  /** Luxels per row and rows: ceil(max / 16) - floor(min / 16) + 1. */
  readonly width: number;
  readonly height: number;
}

/**
 * Lightmap placement of a face, derived from the texture-space bounds of its corners, as
 * CalcSurfaceExtents computes it. Each product and sum rounds to float, as in SSE builds
 * and in the win32 x87 build, which sets 24-bit precision (`_controlfp(_PC_24)`) at the
 * start of every frame; Math.fround reproduces that, in the engine's left-to-right order.
 * Unverified: GL driver calls run between that and every map load (SCR_UpdateScreen on
 * connect, the driver load itself on vid_restart), and drivers of the era could change
 * the control word. On rotated or scaled texinfo the rounding can move a bound across a
 * multiple of 16 and change the size by a luxel. ericw-tools light accumulates in long double and rounds once, so in that
 * case the compiler's lightmap size differs too; the engine's is the one that reads it.
 * The 999999 / -99999 starting bounds are the engine's.
 */
export function lightmapExtents(bsp: Bsp, face: number): LightmapExtents {
  const f = Math.fround;
  const v = bsp.texinfo.vecs;
  const o = bsp.faces.texinfo[face]! * 8;
  const p = bsp.vertexes.position;
  const mins = [999999, 999999], maxs = [-99999, -99999];
  for (const vi of faceVertexIndices(bsp, face)) {
    const x = p[vi * 3]!, y = p[vi * 3 + 1]!, z = p[vi * 3 + 2]!;
    for (let j = 0; j < 2; j++) {
      const k = o + j * 4;
      const val = f(f(f(f(x * v[k]!) + f(y * v[k + 1]!)) + f(z * v[k + 2]!)) + v[k + 3]!);
      if (val < mins[j]!) mins[j] = val;
      if (val > maxs[j]!) maxs[j] = val;
    }
  }
  const bminS = Math.floor(mins[0]! / LIGHTMAP_SCALE), bmaxS = Math.ceil(maxs[0]! / LIGHTMAP_SCALE);
  const bminT = Math.floor(mins[1]! / LIGHTMAP_SCALE), bmaxT = Math.ceil(maxs[1]! / LIGHTMAP_SCALE);
  return {
    textureMinS: bminS * LIGHTMAP_SCALE,
    textureMinT: bminT * LIGHTMAP_SCALE,
    width: bmaxS - bminS + 1,
    height: bmaxT - bminT + 1,
  };
}

/** Light styles stored for a face: entries before the first 255. */
export function faceStyleCount(bsp: Bsp, face: number): number {
  let n = 0;
  while (n < MAX_LIGHTMAPS && bsp.faces.styles[face * MAX_LIGHTMAPS + n] !== 255) n++;
  return n;
}

/** Bytes a face's lightmaps occupy in the lighting lump (RGB, one map per style). */
export function faceLightmapBytes(bsp: Bsp, face: number): number {
  const { width, height } = lightmapExtents(bsp, face);
  return width * height * 3 * faceStyleCount(bsp, face);
}
