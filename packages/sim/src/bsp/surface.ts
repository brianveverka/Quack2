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
 * Lightmap placement of a face, derived from the texture-space bounds of its corners.
 * Computed in double precision; the reference engine accumulates in float, which can
 * only differ when a bound lands within float error of a multiple of 16. The fixture only
 * has axis-aligned, unscaled texinfo, so it cannot show such a mismatch.
 */
export function lightmapExtents(bsp: Bsp, face: number): LightmapExtents {
  const ti = bsp.faces.texinfo[face]!;
  const p = bsp.vertexes.position;
  let minS = Infinity, minT = Infinity, maxS = -Infinity, maxT = -Infinity;
  for (const vi of faceVertexIndices(bsp, face)) {
    const [s, t] = texCoord(bsp, ti, p[vi * 3]!, p[vi * 3 + 1]!, p[vi * 3 + 2]!);
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }
  const bminS = Math.floor(minS / LIGHTMAP_SCALE), bmaxS = Math.ceil(maxS / LIGHTMAP_SCALE);
  const bminT = Math.floor(minT / LIGHTMAP_SCALE), bmaxT = Math.ceil(maxT / LIGHTMAP_SCALE);
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
