// SPDX-License-Identifier: GPL-2.0-or-later
// Packs every face's lightmap into one RGBA atlas. A face stores one map per light style
// (up to four); its atlas block holds their sum, each map scaled by its style's current
// brightness, composed on the CPU as ref_gl's R_BuildLightMap does. When style values
// change, only the faces using a changed style are composed again. Sky, warp and
// translucent faces get no lightmap, as in Mod_LoadFaces, and draw at full brightness.

import {
  MAX_LIGHTMAPS,
  MAX_LIGHTSTYLES,
  SURF_SKY,
  SURF_TRANS33,
  SURF_TRANS66,
  SURF_WARP,
  faceStyleCount,
  lightmapExtents,
  type Bsp,
} from "@quack2/sim";

export interface LightmapRect {
  /** Atlas position of luxel (0, 0). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Texture-space origin of the face's lightmap, from lightmapExtents. */
  readonly textureMinS: number;
  readonly textureMinT: number;
  /** False for faces with no lightmap (none stored, or an unlit surface); their rect is the fullbright block. */
  readonly lit: boolean;
}

export interface LightmapAtlas {
  readonly width: number;
  readonly height: number;
  /** RGBA8. */
  readonly data: Uint8Array;
  /** Per face; faces without a lightmap point at the fullbright block. */
  readonly rects: readonly LightmapRect[];
  /** Style brightnesses the lit faces were last composed with, per light style. */
  readonly styleValues: Float32Array;
}

/**
 * A white block reserved at (0, 0) for faces with no lightmap (lightOfs -1). 2x2 so
 * bilinear sampling at its centre never reaches a neighbour.
 */
const FULLBRIGHT = 2;

/** Surfaces ref_gl builds no lightmap for, whatever the map stores (GL_CreateSurfaceLightmap is skipped). */
export const SURF_UNLIT = SURF_SKY | SURF_TRANS33 | SURF_TRANS66 | SURF_WARP;

/** Every style at normal brightness ('m'), what ref_gl builds lightmaps with at load. */
const STYLES_NORMAL = new Float32Array(MAX_LIGHTSTYLES).fill(1);

/**
 * Shelf-pack lightmaps tallest first, doubling the atlas until they fit, and compose
 * each with `styles` (brightness per light style, as lightStyleValues gives). Throws only
 * if the map needs more than `maxSize` square, which no IBSP v38 map should.
 */
export function buildLightmapAtlas(bsp: Bsp, maxSize = 4096, styles: ArrayLike<number> = STYLES_NORMAL): LightmapAtlas {
  const n = bsp.faces.count;
  const ext = Array.from({ length: n }, (_, f) => lightmapExtents(bsp, f));
  const lit = [...Array(n).keys()].filter(
    (f) => bsp.faces.lightOfs[f] !== -1 && !((bsp.texinfo.flags[bsp.faces.texinfo[f]!] ?? 0) & SURF_UNLIT),
  );
  lit.sort((a, b) => ext[b]!.height - ext[a]!.height || ext[b]!.width - ext[a]!.width || a - b);

  for (let size = 64; size <= maxSize; size *= 2) {
    const pos = pack(lit, ext, size);
    if (!pos) continue;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < FULLBRIGHT; y++) data.fill(255, y * size * 4, (y * size + FULLBRIGHT) * 4);
    const rects: LightmapRect[] = ext.map((e) => ({
      x: 0, y: 0, width: FULLBRIGHT, height: FULLBRIGHT, textureMinS: e.textureMinS, textureMinT: e.textureMinT, lit: false,
    }));
    for (const f of lit) {
      const e = ext[f]!;
      const [x, y] = pos.get(f)!;
      rects[f] = { x, y, width: e.width, height: e.height, textureMinS: e.textureMinS, textureMinT: e.textureMinT, lit: true };
    }
    const styleValues = Float32Array.from(STYLES_NORMAL);
    for (let s = 0; s < Math.min(styles.length, MAX_LIGHTSTYLES); s++) styleValues[s] = styles[s]!;
    const atlas = { width: size, height: size, data, rects, styleValues };
    for (const f of lit) composeFace(bsp, atlas, f);
    return atlas;
  }
  throw new Error(`lightmaps do not fit a ${maxSize}x${maxSize} atlas`);
}

/**
 * Set new style brightnesses and compose again every lit face that uses a style whose
 * value changed, as ref_gl does for a surface whose cached_light no longer matches.
 * Returns those faces, for the caller to upload their rects.
 */
export function updateLightmapAtlas(bsp: Bsp, atlas: LightmapAtlas, styles: ArrayLike<number>): number[] {
  const changed = new Uint8Array(MAX_LIGHTSTYLES);
  let any = false;
  for (let s = 0; s < Math.min(styles.length, MAX_LIGHTSTYLES); s++) {
    const v = Math.fround(styles[s]!);
    if (v === atlas.styleValues[s]) continue;
    atlas.styleValues[s] = v;
    changed[s] = 1;
    any = true;
  }
  const faces: number[] = [];
  if (!any) return faces;
  for (let f = 0; f < atlas.rects.length; f++) {
    if (!atlas.rects[f]!.lit) continue;
    const n = faceStyleCount(bsp, f);
    for (let k = 0; k < n; k++) {
      if (!changed[bsp.faces.styles[f * MAX_LIGHTMAPS + k]!]) continue;
      composeFace(bsp, atlas, f);
      faces.push(f);
      break;
    }
  }
  return faces;
}

/**
 * R_BuildLightMap for one face (gl_modulate 1, no dynamic lights, gl_monolightmap 0):
 * sum each stored map times its style's brightness in float, truncate to int (Q_ftol
 * as its C fallback defines it), clamp negatives to 0, and scale all three channels
 * down by the brightest when it passes 255. Every float operation rounds to IEEE single,
 * as SSE (x86-64) builds evaluate it. x87 builds keep extended precision until a store,
 * which can move overbright or multi-style luxels one step; the Windows asm Q_ftol
 * rounds to nearest, which moves any luxel with a fraction (any style not at 'm'). A face with lightmap data but no styles composes to black, as there.
 */
function composeFace(bsp: Bsp, atlas: LightmapAtlas, f: number): void {
  const r = atlas.rects[f]!;
  const size = r.width * r.height;
  const n = faceStyleCount(bsp, f);
  const scale: number[] = [];
  for (let k = 0; k < n; k++) scale.push(atlas.styleValues[bsp.faces.styles[f * MAX_LIGHTMAPS + k]!]!);
  const light = bsp.lighting;
  const base = bsp.faces.lightOfs[f]!;
  const bl = [0, 0, 0];
  for (let i = 0; i < size; i++) {
    bl[0] = bl[1] = bl[2] = 0;
    for (let k = 0; k < n; k++) {
      const src = base + (k * size + i) * 3;
      // A lightmap past the lump (flagged by checkBspIntegrity, not enforced) reads as black.
      for (let c = 0; c < 3; c++) bl[c] = Math.fround(bl[c]! + Math.fround((light[src + c] ?? 0) * scale[k]!));
    }
    let red = Math.max(Math.trunc(bl[0]!), 0), green = Math.max(Math.trunc(bl[1]!), 0), blue = Math.max(Math.trunc(bl[2]!), 0);
    const max = Math.max(red, green, blue);
    if (max > 255) {
      const t = Math.fround(255 / max);
      red = Math.trunc(Math.fround(red * t));
      green = Math.trunc(Math.fround(green * t));
      blue = Math.trunc(Math.fround(blue * t));
    }
    const dst = ((r.y + Math.floor(i / r.width)) * atlas.width + r.x + (i % r.width)) * 4;
    atlas.data[dst] = red;
    atlas.data[dst + 1] = green;
    atlas.data[dst + 2] = blue;
    atlas.data[dst + 3] = 255;
  }
}

function pack(order: readonly number[], ext: readonly { width: number; height: number }[], size: number) {
  const pos = new Map<number, [number, number]>();
  // The fullbright block opens the first shelf.
  let x = FULLBRIGHT, y = 0, shelf = FULLBRIGHT;
  for (const f of order) {
    const { width, height } = ext[f]!;
    if (width > size) return undefined;
    if (x + width > size) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    if (y + height > size) return undefined;
    pos.set(f, [x, y]);
    x += width;
    shelf = Math.max(shelf, height);
  }
  return pos;
}

/** Atlas UV of a texture-space point on a face: luxel centres sit on 16-unit boundaries. */
export function lightmapUv(atlas: LightmapAtlas, face: number, s: number, t: number): [number, number] {
  const r = atlas.rects[face]!;
  if (!r.lit) return [(r.x + FULLBRIGHT / 2) / atlas.width, (r.y + FULLBRIGHT / 2) / atlas.height];
  return [
    (r.x + (s - r.textureMinS) / 16 + 0.5) / atlas.width,
    (r.y + (t - r.textureMinT) / 16 + 0.5) / atlas.height,
  ];
}
