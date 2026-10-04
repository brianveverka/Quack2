// SPDX-License-Identifier: GPL-2.0-or-later
// Sky images as ref_gl loads them for R_SetSky: LoadTGA (32-bit RGB) or LoadPCX (8-bit,
// mapped through the global palette as GL_Upload8 does), then GL_Upload32's sizing for
// an unmipmapped it_sky image. Where the engine Sys_Errors, these throw SkyImageError,
// which the loader reports and falls back from; nothing here is fatal.

import type { TextureImage } from "./textures.js";
import { walToRgba } from "./wal.js";

export class SkyImageError extends Error {
  override name = "SkyImageError";
}

const TGA_HEADER_SIZE = 18;

/**
 * LoadTGA: image types 2 (raw) and 10 (RLE), 24 or 32 bits, no colormap. The engine
 * ignores the descriptor's origin bit and always stores the first file row as the last
 * memory row, so a top-origin file comes out upside down, there and here. RLE packets
 * run on across rows as one pixel stream, as LoadTGA lets them. Truncated data throws
 * (the engine reads past the end), and a file too short for its size does so before
 * allocating; a zero width or height throws (GL_ResampleTexture would read out of bounds).
 */
export function decodeTga(bytes: Uint8Array): TextureImage {
  if (bytes.length < TGA_HEADER_SIZE) throw new SkyImageError(`tga is ${bytes.length} bytes, shorter than its header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0]!;
  const colormapType = bytes[1]!;
  const imageType = bytes[2]!;
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const pixelSize = bytes[16]!;
  if (imageType !== 2 && imageType !== 10) throw new SkyImageError(`tga image type ${imageType}: only types 2 and 10 are supported`);
  if (colormapType !== 0 || (pixelSize !== 32 && pixelSize !== 24)) {
    throw new SkyImageError(`tga ${pixelSize}-bit, colormap type ${colormapType}: only 24 or 32 bit without a colormap are supported`);
  }
  if (width === 0 || height === 0) throw new SkyImageError(`tga size ${width}x${height} is empty`);
  const bpp = pixelSize / 8;
  // The fewest bytes that can hold the pixels (raw, or RLE at 128 pixels per run
  // packet), checked before allocating: a short file with a corrupt header cannot ask
  // for more than about 128 times its own size.
  const pixels = width * height;
  const least = TGA_HEADER_SIZE + idLength + (imageType === 2 ? pixels * bpp : Math.ceil(pixels / 128) * (1 + bpp));
  if (least > bytes.length) throw new SkyImageError(`tga is ${bytes.length} bytes, too short for ${width}x${height} pixels`);
  const data = new Uint8Array(width * height * 4);
  let p = TGA_HEADER_SIZE + idLength;
  const need = (n: number) => {
    if (p + n > bytes.length) throw new SkyImageError(`tga data ends at byte ${bytes.length}, before its ${width}x${height} pixels`);
  };
  // Stream position: memory row rows-1 first, left to right, up to row 0.
  let row = height - 1;
  let column = 0;
  const put = (r: number, g: number, b: number, a: number) => {
    const o = (row * width + column) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
    if (++column === width) {
      column = 0;
      row--;
    }
  };
  const readPixel = (): [number, number, number, number] => {
    need(bpp);
    const px: [number, number, number, number] = [bytes[p + 2]!, bytes[p + 1]!, bytes[p]!, bpp === 4 ? bytes[p + 3]! : 255];
    p += bpp;
    return px;
  };
  while (row >= 0) {
    if (imageType === 2) {
      put(...readPixel());
      continue;
    }
    need(1);
    const header = bytes[p++]!;
    const count = 1 + (header & 0x7f);
    if (header & 0x80) {
      const px = readPixel();
      for (let j = 0; j < count && row >= 0; j++) put(...px);
    } else {
      for (let j = 0; j < count && row >= 0; j++) put(...readPixel());
    }
  }
  return { width, height, data };
}

const PCX_HEADER_SIZE = 128;

/**
 * LoadPCX: manufacturer 0x0a, version 5, RLE encoding, 8 bits per pixel, xmax < 640 and
 * ymax < 480, else it throws. Like the engine it ignores xmin, ymin and bytes_per_line,
 * drops a run's overflow past a row's end (the next row overwrites it there), and lets
 * the pixel data run into the trailing palette; data past the file's end throws.
 */
export function decodePcx(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  if (bytes.length < PCX_HEADER_SIZE) throw new SkyImageError(`pcx is ${bytes.length} bytes, shorter than its header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);
  if (bytes[0] !== 0x0a || bytes[1] !== 5 || bytes[2] !== 1 || bytes[3] !== 8 || xmax >= 640 || ymax >= 480) {
    throw new SkyImageError("not a version 5, RLE, 8-bit pcx under 640x480");
  }
  const width = xmax + 1;
  const height = ymax + 1;
  const pixels = new Uint8Array(width * height);
  let p = PCX_HEADER_SIZE;
  const next = () => {
    if (p >= bytes.length) throw new SkyImageError(`pcx data ends at byte ${bytes.length}, before its ${width}x${height} pixels`);
    return bytes[p++]!;
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; ) {
      let value = next();
      let run = 1;
      if ((value & 0xc0) === 0xc0) {
        run = value & 0x3f;
        value = next();
      }
      for (; run > 0; run--, x++) if (x < width) pixels[row + x] = value;
    }
  }
  return { width, height, pixels };
}

/** GL_Upload8's buffer: larger 8-bit images are a Sys_Error there. */
export const UPLOAD8_MAX_PIXELS = 512 * 256;

/**
 * GL_Upload8 for a sky PCX: indices through the global palette (pics/colormap.pcx's
 * d_8to24table, not the PCX's own palette, which GL_FindImage discards), with its rule
 * for index 255.
 */
export function pcxToRgba(pcx: { width: number; height: number; pixels: Uint8Array }, palette: Uint8Array): TextureImage {
  if (pcx.width * pcx.height > UPLOAD8_MAX_PIXELS) throw new SkyImageError(`pcx ${pcx.width}x${pcx.height} is too large to upload`);
  return walToRgba(pcx, palette);
}

/** GL_Upload32's size for an unmipmapped image: each side rounded up to a power of two, at most 256. */
export function uploadSize(width: number, height: number): [number, number] {
  const fit = (n: number) => {
    let s = 1;
    while (s < n) s <<= 1;
    return Math.min(s, 256);
  };
  return [fit(width), fit(height)];
}

/**
 * GL_Upload32 for an unmipmapped (it_sky) image: unchanged at its upload size, else
 * scaled with GL_ResampleTexture. The resampled path's GL_LightScaleTexture is gamma only
 * there, the identity at the default vid_gamma 1, so it is left out.
 */
export function uploadImage(img: TextureImage): TextureImage {
  const [w, h] = uploadSize(img.width, img.height);
  if (w === img.width && h === img.height) return img;
  return { width: w, height: h, data: resampleTexture(img.data, img.width, img.height, w, h) };
}

/** GL_ResampleTexture, bit for bit: unsigned 16.16 column steps, rows picked in double. */
export function resampleTexture(input: Uint8Array, inWidth: number, inHeight: number, outWidth: number, outHeight: number): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight * 4);
  // `inwidth*0x10000/outwidth` in int; widths here are at most 65535, and the unsigned
  // result of a larger product is what the C stores too.
  const fracstep = (Math.trunc(((inWidth * 0x10000) | 0) / outWidth) >>> 0);
  const p1 = new Uint32Array(outWidth);
  const p2 = new Uint32Array(outWidth);
  let frac = fracstep >>> 2;
  for (let i = 0; i < outWidth; i++) {
    p1[i] = 4 * (frac >>> 16);
    frac = (frac + fracstep) >>> 0;
  }
  frac = (3 * (fracstep >>> 2)) >>> 0;
  for (let i = 0; i < outWidth; i++) {
    p2[i] = 4 * (frac >>> 16);
    frac = (frac + fracstep) >>> 0;
  }
  for (let i = 0; i < outHeight; i++) {
    const row1 = inWidth * 4 * Math.trunc(((i + 0.25) * inHeight) / outHeight);
    const row2 = inWidth * 4 * Math.trunc(((i + 0.75) * inHeight) / outHeight);
    for (let j = 0; j < outWidth; j++) {
      const a = row1 + p1[j]!, b = row1 + p2[j]!, c = row2 + p1[j]!, d = row2 + p2[j]!;
      const o = (i * outWidth + j) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (input[a + k]! + input[b + k]! + input[c + k]! + input[d + k]!) >> 2;
    }
  }
  return out;
}

/** dottexture from gl_rmisc.c; r_notexture reads only its first four rows and columns. */
const DOT_TEXTURE = [
  [0, 0, 0, 0],
  [0, 0, 1, 1],
  [0, 1, 1, 1],
  [0, 1, 1, 1],
];

/** r_notexture (R_InitParticleTexture): 8x8, red dots on black, opaque. */
export function notexture(): TextureImage {
  const data = new Uint8Array(8 * 8 * 4);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      const o = (y * 8 + x) * 4;
      data[o] = DOT_TEXTURE[x & 3]![y & 3]! * 255;
      data[o + 3] = 255;
    }
  }
  return { width: 8, height: 8, data };
}
