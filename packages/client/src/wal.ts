// SPDX-License-Identifier: GPL-2.0-or-later
// Quake 2 .wal textures and the palette they index. A .wal is a 100-byte header
// (name[32], width, height, four mip offsets, animname[32], flags, contents, value)
// followed by four 8-bit mip levels. The palette is not in the .wal: the engine takes it
// from the trailing 768 bytes of pics/colormap.pcx, which only the user's own game data
// provides.

import type { TextureImage } from "./textures.js";

export const WAL_HEADER_SIZE = 100;
/** Larger than any Q2 texture; guards allocation against a corrupt header. */
export const WAL_MAX_SIZE = 4096;
export const PALETTE_PATH = "pics/colormap.pcx";
/** Palette index the engine treats as transparent. */
export const TRANSPARENT_INDEX = 255;

export class WalError extends Error {
  override name = "WalError";
}

export interface Wal {
  readonly width: number;
  readonly height: number;
  /** Palette indices of mip 0, rows top to bottom. The GPU builds the smaller mips. */
  readonly pixels: Uint8Array;
}

export function decodeWal(bytes: Uint8Array): Wal {
  if (bytes.length < WAL_HEADER_SIZE) throw new WalError(`wal is ${bytes.length} bytes, shorter than its header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(32, true);
  const height = view.getUint32(36, true);
  const offset = view.getUint32(40, true);
  if (width === 0 || height === 0 || width > WAL_MAX_SIZE || height > WAL_MAX_SIZE) {
    throw new WalError(`wal size ${width}x${height} out of range`);
  }
  if (offset < WAL_HEADER_SIZE || offset + width * height > bytes.length) {
    throw new WalError(`wal mip 0 (offset ${offset}, ${width}x${height}) outside the ${bytes.length}-byte file`);
  }
  return { width, height, pixels: bytes.subarray(offset, offset + width * height) };
}

/** The 768-byte RGB palette appended to an 8-bit PCX (marker byte 0x0C, then 256 RGB triples). */
export function pcxPalette(bytes: Uint8Array): Uint8Array {
  const marker = bytes.length - 769;
  if (bytes.length < 128 + 769 || bytes[0] !== 0x0a || bytes[3] !== 8 || bytes[marker] !== 0x0c) {
    throw new WalError("not an 8-bit PCX with a trailing 256-color palette");
  }
  return bytes.subarray(marker + 1);
}

/**
 * Expand to RGBA the way the GL engine's GL_Upload8 does: index 255 gets alpha 0 and the
 * RGB of a neighbor (above, below, left, right, else index 0) so filtering and mipmaps
 * do not bleed the palette's placeholder color.
 */
export function walToRgba(wal: Wal, palette: Uint8Array): TextureImage {
  const { width, height, pixels } = wal;
  const n = width * height;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let p = pixels[i]!;
    let alpha = 255;
    if (p === TRANSPARENT_INDEX) {
      alpha = 0;
      // Bounds tests copied from the engine, including its strict i > width.
      if (i > width && pixels[i - width] !== TRANSPARENT_INDEX) p = pixels[i - width]!;
      else if (i < n - width && pixels[i + width] !== TRANSPARENT_INDEX) p = pixels[i + width]!;
      else if (i > 0 && pixels[i - 1] !== TRANSPARENT_INDEX) p = pixels[i - 1]!;
      else if (i < n - 1 && pixels[i + 1] !== TRANSPARENT_INDEX) p = pixels[i + 1]!;
      else p = 0;
    }
    data[i * 4] = palette[p * 3]!;
    data[i * 4 + 1] = palette[p * 3 + 1]!;
    data[i * 4 + 2] = palette[p * 3 + 2]!;
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}
