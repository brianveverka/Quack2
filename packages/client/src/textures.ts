// SPDX-License-Identifier: GPL-2.0-or-later
// Texture images by name. Real game data comes from pak/.wal loaders (not written yet);
// anything a source cannot supply gets a checker placeholder, never an error.

export interface TextureImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, rows top to bottom. */
  readonly data: Uint8Array;
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

/** 64x64 two-tone checker tinted by the texture name. Q2 world textures are mostly 64-unit. */
export function checkerTexture(name: string): TextureImage {
  const h = hashName(name);
  const tint = [96 + (h & 0x7f), 96 + ((h >>> 8) & 0x7f), 96 + ((h >>> 16) & 0x7f)];
  const data = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
  for (let y = 0; y < CHECKER_SIZE; y++) {
    for (let x = 0; x < CHECKER_SIZE; x++) {
      const dark = ((x / CHECKER_CELL) ^ (y / CHECKER_CELL)) & 1;
      const o = (y * CHECKER_SIZE + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = dark ? tint[c]! >> 1 : tint[c]!;
      data[o + 3] = 255;
    }
  }
  return { width: CHECKER_SIZE, height: CHECKER_SIZE, data };
}

/** Resolve every name, substituting a checker for each one the source lacks. */
export function resolveTextures(names: readonly string[], source: TextureSource) {
  const missing: string[] = [];
  const images = names.map((name) => {
    const img = source(name);
    if (img) return img;
    missing.push(name);
    return checkerTexture(name);
  });
  return { images, missing };
}
