// SPDX-License-Identifier: GPL-2.0-or-later
// Texture images by name. Real game data comes from .wal files in mounted archives
// (assets.ts); anything a source cannot supply gets a checker placeholder, never an error.

export interface TextureImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, rows top to bottom. */
  readonly data: Uint8Array;
  /** A checker standing in for a texture that could not be decoded. */
  readonly placeholder?: boolean;
}

/** Looks up a texture by its texinfo name (no extension). undefined means missing. */
export type TextureSource = (name: string) => TextureImage | undefined;

export const noTextures: TextureSource = () => undefined;

export const CHECKER_SIZE = 64;
const CHECKER_CELL = 8;

/** FNV-1a, so each missing texture keeps a stable, distinguishable tint. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Two-tone checker tinted by the texture name. 64x64 when the real size is unknown (Q2
 * world textures are mostly 64-unit); given the .wal's size, texture scale stays correct.
 */
export function checkerTexture(name: string, width = CHECKER_SIZE, height = CHECKER_SIZE): TextureImage {
  const h = hashName(name);
  const tint = [96 + (h & 0x7f), 96 + ((h >>> 8) & 0x7f), 96 + ((h >>> 16) & 0x7f)];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = ((x / CHECKER_CELL) ^ (y / CHECKER_CELL)) & 1;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = dark ? tint[c]! >> 1 : tint[c]!;
      data[o + 3] = 255;
    }
  }
  return { width, height, data, placeholder: true };
}

/**
 * Resolve every name, substituting a checker for each one the source lacks. `missing`
 * lists every name drawn as a checker, including placeholders the source returned.
 */
export function resolveTextures(names: readonly string[], source: TextureSource) {
  const missing: string[] = [];
  const images = names.map((name) => {
    const img = source(name) ?? checkerTexture(name);
    if (img.placeholder) missing.push(name);
    return img;
  });
  return { images, missing };
}
