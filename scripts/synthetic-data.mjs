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
 * `prefix` bytes (a self-extractor stub) go before the first local header. Stored offsets
 * ignore the prefix unless `adjustOffsets` is set: unset gives what `cat stub zip`
 * produces, set gives what `zip -A` produces, with offsets from the true file start.
 * `zip64` sets version 45 and moves every size and offset into zip64 fields: local headers
 * as Info-ZIP `zip -fz` writes them (both sizes 0xffffffff, extra 0x0001 with uncompressed
 * then compressed size); central entries with both sizes and the local offset 0xffffffff
 * and all three in extra 0x0001; then a zip64 end record and locator ahead of an end
 * record whose counts, size and offset are all set to their 0xff markers.
 */
export function writeZip(
  files,
  { deflate = true, comment = "", prefix = new Uint8Array(0), adjustOffsets = false, zip64 = false } = {},
) {
  const base = adjustOffsets ? prefix.length : 0;
  const version = zip64 ? 45 : 20;
  const localExtra = zip64 ? 20 : 0;
  const centralExtra = zip64 ? 28 : 0;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = deflate === true || (deflate instanceof Set && deflate.has(name));
    const body = packed ? new Uint8Array(deflateRawSync(data)) : data;
    const n = ascii(name);
    const local = new Uint8Array(30 + n.length + localExtra + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, version, true);
    lv.setUint16(8, packed ? 8 : 0, true);
    lv.setUint32(14, crc32(data), true);
    lv.setUint32(18, zip64 ? 0xffffffff : body.length, true);
    lv.setUint32(22, zip64 ? 0xffffffff : data.length, true);
    lv.setUint16(26, n.length, true);
    lv.setUint16(28, localExtra, true);
    local.set(n, 30);
    if (zip64) {
      const x = 30 + n.length;
      lv.setUint16(x, 0x0001, true);
      lv.setUint16(x + 2, 16, true);
      lv.setBigUint64(x + 4, BigInt(data.length), true);
      lv.setBigUint64(x + 12, BigInt(body.length), true);
    }
    local.set(body, 30 + n.length + localExtra);
    const central = new Uint8Array(46 + n.length + centralExtra);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, version, true);
    cv.setUint16(6, version, true);
    cv.setUint16(10, packed ? 8 : 0, true);
    cv.setUint32(16, crc32(data), true);
    cv.setUint32(20, zip64 ? 0xffffffff : body.length, true);
    cv.setUint32(24, zip64 ? 0xffffffff : data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint16(30, centralExtra, true);
    cv.setUint32(42, zip64 ? 0xffffffff : base + offset, true);
    central.set(n, 46);
    if (zip64) {
      const x = 46 + n.length;
      cv.setUint16(x, 0x0001, true);
      cv.setUint16(x + 2, 24, true);
      cv.setBigUint64(x + 4, BigInt(data.length), true);
      cv.setBigUint64(x + 12, BigInt(body.length), true);
      cv.setBigUint64(x + 20, BigInt(base + offset), true);
    }
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const c = ascii(comment);
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const zip64Tail = zip64 ? 56 + 20 : 0;
  const out = new Uint8Array(prefix.length + offset + cdSize + zip64Tail + 22 + c.length);
  out.set(prefix, 0);
  let pos = prefix.length;
  for (const part of [...locals, ...centrals]) {
    out.set(part, pos);
    pos += part.length;
  }
  if (zip64) {
    // Zip64 end record (56 bytes) then its locator (20 bytes).
    const zv = new DataView(out.buffer, pos, zip64Tail);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, 44n, true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(centrals.length), true);
    zv.setBigUint64(32, BigInt(centrals.length), true);
    zv.setBigUint64(40, BigInt(cdSize), true);
    zv.setBigUint64(48, BigInt(base + offset), true);
    zv.setUint32(56, 0x07064b50, true);
    zv.setBigUint64(64, BigInt(base + offset + cdSize), true);
    zv.setUint32(72, 1, true);
    pos += zip64Tail;
  }
  const ev = new DataView(out.buffer, pos);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip64 ? 0xffff : centrals.length, true);
  ev.setUint16(10, zip64 ? 0xffff : centrals.length, true);
  ev.setUint32(12, zip64 ? 0xffffffff : cdSize, true);
  ev.setUint32(16, zip64 ? 0xffffffff : base + offset, true);
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

/**
 * A TGA as Quake 2's LoadTGA reads it: `pixel(x, y)` is [r, g, b] or [r, g, b, a] with y = 0
 * the top row as the engine shows it. LoadTGA puts the first file row at the bottom
 * whatever the origin bit says, so file rows are written bottom-up; `topOrigin` only sets
 * the bit (the image then still decodes the same). RLE writes one run or raw packet per
 * stretch of up to 128 pixels, continuing across rows as LoadTGA allows.
 */
export function writeTga(width, height, pixel, { bits = 24, rle = false, topOrigin = false } = {}) {
  const bpp = bits / 8;
  const stream = [];
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      stream.push(bpp === 4 ? [b, g, r, a] : [b, g, r]);
    }
  }
  const body = [];
  if (!rle) {
    for (const px of stream) body.push(...px);
  } else {
    let i = 0;
    while (i < stream.length) {
      let run = 1;
      while (i + run < stream.length && run < 128 && stream[i + run].join() === stream[i].join()) run++;
      if (run > 1) {
        body.push(0x80 | (run - 1), ...stream[i]);
        i += run;
        continue;
      }
      let raw = 1;
      while (i + raw < stream.length && raw < 128 && stream[i + raw].join() !== stream[i + raw - 1].join()) raw++;
      body.push(raw - 1);
      for (let k = 0; k < raw; k++) body.push(...stream[i + k]);
      i += raw;
    }
  }
  const out = new Uint8Array(18 + body.length);
  const view = new DataView(out.buffer);
  out[2] = rle ? 10 : 2;
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  out[16] = bits;
  out[17] = (bpp === 4 ? 8 : 0) | (topOrigin ? 0x20 : 0);
  out.set(body, 18);
  return out;
}

/**
 * An 8-bit RLE PCX of palette indices `pixel(x, y)` (y = 0 the top row), runs of up to 63
 * within a row, with the synthetic palette appended (the engine ignores it for skies).
 */
export function writePcx(width, height, pixel) {
  const body = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const v = pixel(x, y);
      let run = 1;
      while (x + run < width && run < 63 && pixel(x + run, y) === v) run++;
      if (run > 1 || (v & 0xc0) === 0xc0) body.push(0xc0 | run, v);
      else body.push(v);
      x += run;
    }
  }
  const out = new Uint8Array(128 + body.length + 769);
  const view = new DataView(out.buffer);
  out[0] = 0x0a;
  out[1] = 5;
  out[2] = 1;
  out[3] = 8;
  view.setUint16(8, width - 1, true);
  view.setUint16(10, height - 1, true);
  view.setUint16(66, width, true);
  out[65] = 1;
  out.set(body, 128);
  out[128 + body.length] = 0x0c;
  out.set(syntheticPalette(), 129 + body.length);
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
