// SPDX-License-Identifier: GPL-2.0-or-later
// Packs every face's style-0 lightmap into one RGBA atlas. Animated light styles
// (styles 1-3 and their stored maps) are not blended yet; style 0 is the static light.

import { lightmapExtents, type Bsp } from "@quack2/sim";

export interface LightmapRect {
  /** Atlas position of luxel (0, 0). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Texture-space origin of the face's lightmap, from lightmapExtents. */
  readonly textureMinS: number;
  readonly textureMinT: number;
  /** False for faces with no lightmap; their rect is the fullbright block. */
  readonly lit: boolean;
}

export interface LightmapAtlas {
  readonly width: number;
  readonly height: number;
  /** RGBA8. */
  readonly data: Uint8Array;
  /** Per face; faces without a lightmap point at the fullbright block. */
  readonly rects: readonly LightmapRect[];
}

/**
 * A white block reserved at (0, 0) for faces with no lightmap (lightOfs -1). 2x2 so
 * bilinear sampling at its centre never reaches a neighbour.
 */
const FULLBRIGHT = 2;

/**
 * Shelf-pack lightmaps tallest first, doubling the atlas until they fit. Throws only if
 * the map needs more than `maxSize` square, which no IBSP v38 map should.
 */
export function buildLightmapAtlas(bsp: Bsp, maxSize = 4096): LightmapAtlas {
  const n = bsp.faces.count;
  const ext = Array.from({ length: n }, (_, f) => lightmapExtents(bsp, f));
  const lit = [...Array(n).keys()].filter((f) => bsp.faces.lightOfs[f] !== -1);
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
      let src = bsp.faces.lightOfs[f]!;
      for (let row = 0; row < e.height; row++) {
        let dst = ((y + row) * size + x) * 4;
        for (let col = 0; col < e.width; col++) {
          // A lightmap past the lump (flagged by checkBspIntegrity, not enforced) reads as black.
          data[dst] = bsp.lighting[src] ?? 0;
          data[dst + 1] = bsp.lighting[src + 1] ?? 0;
          data[dst + 2] = bsp.lighting[src + 2] ?? 0;
          data[dst + 3] = 255;
          src += 3;
          dst += 4;
        }
      }
    }
    return { width: size, height: size, data, rects };
  }
  throw new Error(`lightmaps do not fit a ${maxSize}x${maxSize} atlas`);
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
