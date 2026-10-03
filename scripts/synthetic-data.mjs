// SPDX-License-Identifier: GPL-2.0-or-later
// Writers for synthetic game data: pak, zip, .wal, a palette-only colormap.pcx, and a
// BSP with its entity string replaced.
// Tests and the smoke test build every archive and texture with these, so nothing
// depends on id Software data. Node only (zip deflate uses node:zlib).
import { deflateRawSync } from "node:zlib";

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Pak with the given files in order. */
export function writePak(files) {
  const entries = Object.entries(files);
  let size = 12;
  for (const [, data] of entries) size += data.length;
  const dirOffset = size;
  const out = new Uint8Array(size + entries.length * 64);
  const view = new DataView(out.buffer);
  out.set(ascii("PACK"), 0);
  view.setInt32(4, dirOffset, true);
  view.setInt32(8, entries.length * 64, true);
  let pos = 12;
  entries.forEach(([name, data], i) => {
    out.set(data, pos);
    const e = dirOffset + i * 64;
    out.set(ascii(name).subarray(0, 55), e);
    view.setInt32(e + 56, pos, true);
    view.setInt32(e + 60, data.length, true);
    pos += data.length;
  });
  return out;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Zip with each file stored or deflated (`deflate` true, or a set of names to deflate).
 * `comment` is appended to the end record, which moves it off the file's last 22 bytes.
 */
export function writeZip(files, { deflate = true, comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = deflate === true || (deflate instanceof Set && deflate.has(name));
    const body = packed ? new Uint8Array(deflateRawSync(data)) : data;
    const n = ascii(name);
    const local = new Uint8Array(30 + n.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, packed ? 8 : 0, true);
    lv.setUint32(14, crc32(data), true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(body, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, packed ? 8 : 0, true);
    cv.setUint32(16, crc32(data), true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const c = ascii(comment);
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(offset + cdSize + 22 + c.length);
  let pos = 0;
  for (const part of [...locals, ...centrals]) {
    out.set(part, pos);
    pos += part.length;
  }
  const ev = new DataView(out.buffer, pos);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, c.length, true);
  out.set(c, pos + 22);
  return out;
}

/** .wal with four mip levels; `pixel(x, y)` gives the palette index of mip 0. Lower mips are point-sampled. */
export function writeWal(name, width, height, pixel) {
  const sizes = [0, 1, 2, 3].map((m) => [Math.max(1, width >> m), Math.max(1, height >> m)]);
  const total = 100 + sizes.reduce((a, [w, h]) => a + w * h, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(ascii(name).subarray(0, 31), 0);
  view.setUint32(32, width, true);
  view.setUint32(36, height, true);
  let pos = 100;
  sizes.forEach(([w, h], m) => {
    view.setUint32(40 + m * 4, pos, true);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[pos + y * w + x] = pixel(x << m, y << m);
    pos += w * h;
  });
  return out;
}

/** 1x1 8-bit PCX carrying `palette` (768 bytes, RGB per index), the only part the client reads from colormap.pcx. */
export function writePalettePcx(palette) {
  const out = new Uint8Array(128 + 1 + 769);
  const view = new DataView(out.buffer);
  out[0] = 0x0a; // manufacturer
  out[1] = 5; // version
  out[2] = 1; // RLE
  out[3] = 8; // bits per pixel
  view.setUint16(66, 1, true); // bytes per line
  out[65] = 1; // planes
  out[128] = 0; // the single pixel, below the RLE run marker range
  out[129] = 0x0c;
  out.set(palette, 130);
  return out;
}

/** A made-up palette: index i is (i, 255 - i, (i * 37) & 255). Callers overwrite the indices they test. */
export function syntheticPalette() {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) p.set([i, 255 - i, (i * 37) & 255], i * 3);
  return p;
}

/**
 * Copy of a BSP whose entity lump (lump 0) is `entities`: the new lump is appended,
 * NUL-terminated, and the header pointed at it. Every other lump is unchanged.
 */
export function withEntityString(bsp, entities) {
  const text = ascii(entities);
  const offset = (bsp.length + 3) & ~3;
  const out = new Uint8Array(offset + text.length + 1);
  out.set(bsp);
  out.set(text, offset);
  const view = new DataView(out.buffer);
  view.setInt32(8, offset, true);
  view.setInt32(12, text.length + 1, true);
  return out;
}
