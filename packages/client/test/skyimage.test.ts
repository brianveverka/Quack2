// SPDX-License-Identifier: GPL-2.0-or-later
// Sky image decoding and loading, from synthetic TGA and PCX files only.
import { GameFs } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { syntheticPalette, writePalettePcx, writePcx, writeTga, writeZip } from "../../../scripts/synthetic-data.mjs";
import { loadSkyImages, openGameArchive } from "../src/assets.js";
import { SkyImageError, decodePcx, decodeTga, notexture, pcxToRgba, resampleTexture, uploadImage, uploadSize } from "../src/skyimage.js";
import { PALETTE_PATH } from "../src/wal.js";

const px = (img: { data: Uint8Array; width: number }, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
/** A distinct colour per pixel of a small image, top-left (0, 0). */
const colour = (x: number, y: number) => [x * 10, y * 20, 7, 200 + x];

describe("decodeTga", () => {
  for (const bits of [24, 32] as const) {
    for (const rle of [false, true]) {
      it(`reads ${bits}-bit ${rle ? "RLE" : "raw"} pixels, top row first`, () => {
        const img = decodeTga(writeTga(5, 3, colour, { bits, rle }));
        expect([img.width, img.height]).toEqual([5, 3]);
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 5; x++) expect(px(img, x, y)).toEqual([x * 10, y * 20, 7, bits === 32 ? 200 + x : 255]);
        }
      });
    }
  }

  it("ignores the origin bit, as LoadTGA does", () => {
    const bottom = decodeTga(writeTga(3, 2, colour));
    const top = decodeTga(writeTga(3, 2, colour, { topOrigin: true }));
    expect(top.data).toEqual(bottom.data);
  });

  it("runs RLE packets on across rows", () => {
    // One run packet of 6 pixels fills both 3-pixel rows; then a raw packet would follow
    // in a longer image. Built by hand: header, then 0x85 (run of 6) and one BGR pixel.
    const bytes = new Uint8Array([...writeTga(3, 2, () => [0, 0, 0], { rle: true }).subarray(0, 18), 0x85, 3, 2, 1]);
    const img = decodeTga(bytes);
    for (let i = 0; i < 6; i++) expect(px(img, i % 3, Math.floor(i / 3))).toEqual([1, 2, 3, 255]);
    // A packet running past the last pixel stops there (LoadTGA's breakOut).
    const over = new Uint8Array([...bytes.subarray(0, 18), 0xff, 3, 2, 1]);
    expect(decodeTga(over).data).toEqual(img.data);
    // A raw packet split across rows, after a run: the stream fills bottom row first.
    const mixed = new Uint8Array([...bytes.subarray(0, 18), 0x81, 9, 9, 9, 0x03, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    const m = decodeTga(mixed);
    expect([px(m, 0, 1), px(m, 1, 1), px(m, 2, 1)].map((p) => p[0])).toEqual([9, 9, 1]);
    expect([px(m, 0, 0), px(m, 1, 0), px(m, 2, 0)].map((p) => p[0])).toEqual([2, 3, 4]);
  });

  it("rejects what LoadTGA refuses, and truncated or empty images", () => {
    const good = writeTga(2, 2, colour);
    const patched = (o: number, v: number) => {
      const b = good.slice();
      b[o] = v;
      return b;
    };
    expect(() => decodeTga(patched(2, 1))).toThrow(/image type 1/);
    expect(() => decodeTga(patched(2, 3))).toThrow(SkyImageError);
    expect(() => decodeTga(patched(1, 1))).toThrow(/colormap/);
    expect(() => decodeTga(patched(16, 16))).toThrow(/16-bit/);
    expect(() => decodeTga(good.subarray(0, good.length - 1))).toThrow(/too short for 2x2/);
    expect(() => decodeTga(writeTga(2, 2, colour, { rle: true }).subarray(0, 20))).toThrow(/too short/);
    // Past the lower bound (22 bytes) but cut inside its raw packet: caught while decoding.
    expect(() => decodeTga(writeTga(2, 2, colour, { rle: true }).subarray(0, 25))).toThrow(/data ends at byte 25/);
    expect(() => decodeTga(good.subarray(0, 10))).toThrow(/header/);
    // A header claiming 20000x20000 is refused before its 1.6 GB is allocated.
    const huge = good.slice();
    new DataView(huge.buffer).setUint16(12, 20000, true);
    new DataView(huge.buffer).setUint16(14, 20000, true);
    expect(() => decodeTga(huge)).toThrow(/too short for 20000x20000/);
    huge[2] = 10;
    expect(() => decodeTga(huge)).toThrow(/too short for 20000x20000/);
    const empty = good.slice();
    empty[12] = empty[13] = 0;
    expect(() => decodeTga(empty)).toThrow(/empty/);
  });

  it("skips the image ID", () => {
    const good = writeTga(2, 1, colour);
    const withId = new Uint8Array([...good.subarray(0, 18), 0xaa, 0xbb, ...good.subarray(18)]);
    withId[0] = 2;
    expect(decodeTga(withId).data).toEqual(decodeTga(good).data);
  });
});

describe("decodePcx", () => {
  it("decodes RLE runs and literals, top row first", () => {
    const index = (x: number, y: number) => (y === 0 ? x : x < 70 ? 0xc5 : 3);
    const img = decodePcx(writePcx(100, 3, index));
    expect([img.width, img.height]).toEqual([100, 3]);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 100; x++) expect(img.pixels[y * 100 + x]).toBe(index(x, y));
  });

  it("drops a run's overflow past the row's end", () => {
    const base = writePcx(2, 2, () => 0);
    // Row 0: a run of 3 of index 7 (one too many), row 1: a run of 2 of index 8.
    const bytes = new Uint8Array([...base.subarray(0, 128), 0xc3, 7, 0xc2, 8, 0x0c, ...syntheticPalette()]);
    expect(Array.from(decodePcx(bytes).pixels)).toEqual([7, 7, 8, 8]);
  });

  it("rejects what LoadPCX refuses and data past the end", () => {
    const good = writePcx(4, 4, () => 1);
    const patched = (o: number, v: number) => {
      const b = good.slice();
      b[o] = v;
      return b;
    };
    expect(() => decodePcx(patched(0, 0x0b))).toThrow(SkyImageError);
    expect(() => decodePcx(patched(1, 3))).toThrow(SkyImageError);
    expect(() => decodePcx(patched(2, 0))).toThrow(SkyImageError);
    expect(() => decodePcx(patched(3, 4))).toThrow(SkyImageError);
    const wide = good.slice();
    new DataView(wide.buffer).setInt16(8, 640, true);
    expect(() => decodePcx(wide)).toThrow(SkyImageError);
    // pcx_t's sizes are unsigned short: 0xffff is far past 639, not -1.
    new DataView(wide.buffer).setUint16(8, 0xffff, true);
    expect(() => decodePcx(wide)).toThrow(/not a version 5/);
    // Pixel data may run into the palette, but not past the file's end.
    expect(() => decodePcx(good.subarray(0, 128 + 4))).toThrow(/data ends/);
    expect(decodePcx(good.subarray(0, 128 + 8)).pixels.every((p) => p === 1)).toBe(true);
  });

  it("maps through the given palette, not its own, with GL_Upload8's limit", () => {
    const palette = syntheticPalette();
    palette.set([1, 2, 3], 5 * 3);
    const img = pcxToRgba(decodePcx(writePcx(2, 1, () => 5)), palette);
    expect(px(img, 1, 0)).toEqual([1, 2, 3, 255]);
    expect(() => pcxToRgba({ width: 513, height: 256, pixels: new Uint8Array(513 * 256) }, palette)).toThrow(/too large/);
  });
});

describe("uploadImage", () => {
  it("keeps power-of-two sizes up to 256 and rounds others up, capped at 256", () => {
    expect(uploadSize(256, 256)).toEqual([256, 256]);
    expect(uploadSize(100, 60)).toEqual([128, 64]);
    expect(uploadSize(512, 1000)).toEqual([256, 256]);
    expect(uploadSize(1, 1)).toEqual([1, 1]);
    const img = { width: 256, height: 256, data: new Uint8Array(256 * 256 * 4) };
    expect(uploadImage(img)).toBe(img);
    expect([uploadImage({ width: 100, height: 60, data: new Uint8Array(100 * 60 * 4) })].map((i) => [i.width, i.height])).toEqual([[128, 64]]);
  });

  it("resamples as GL_ResampleTexture does", () => {
    // 3x1 to 4x1: fracstep 49152, p1 columns 0 0 1 2, p2 columns 0 1 2 2, rows 0 and 0.
    const input = new Uint8Array([0, 0, 0, 0, 100, 4, 0, 0, 200, 8, 0, 0]);
    expect(Array.from(resampleTexture(input, 3, 1, 4, 1).filter((_, i) => i % 4 === 0))).toEqual([0, 50, 150, 200]);
    expect(Array.from(resampleTexture(input, 3, 1, 4, 1).filter((_, i) => i % 4 === 1))).toEqual([0, 2, 6, 8]);
    // Halving is a 2x2 box filter, truncating.
    const big = new Uint8Array(512 * 512 * 4);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) big[(y * 512 + x) * 4] = (x & 1 ? 200 : 0) + (y & 1 ? 3 : 0);
    const half = uploadImage({ width: 512, height: 512, data: big });
    expect([half.width, half.height]).toEqual([256, 256]);
    expect(half.data.filter((_, i) => i % 4 === 0).every((v) => v === 101)).toBe(true);
  });
});

describe("notexture", () => {
  it("is r_notexture: 8x8 red dots on black from dottexture[x&3][y&3]", () => {
    const img = notexture();
    expect([img.width, img.height]).toEqual([8, 8]);
    const red = (x: number, y: number) => px(img, x, y);
    expect(red(0, 0)).toEqual([0, 0, 0, 255]);
    // dottexture[1][2] = 1, dottexture[2][1] = 1, dottexture[1][1] = 0.
    expect(red(1, 2)).toEqual([255, 0, 0, 255]);
    expect(red(2, 1)).toEqual([255, 0, 0, 255]);
    expect(red(1, 1)).toEqual([0, 0, 0, 255]);
    expect(red(5, 6)).toEqual(red(1, 2));
    expect(img.data.filter((_, i) => i % 4 === 0 && img.data[i] === 255).length).toBe(4 * 8);
  });
});

describe("loadSkyImages", () => {
  const solid = (r: number) => () => [r, 0, 0];
  // A zip: pak entry names stop at 56 bytes, short of MAX_QPATH.
  const fsWith = async (files: Record<string, Uint8Array>) => {
    const fs = new GameFs();
    fs.mount("sky.zip", await openGameArchive(writeZip(files)));
    return fs;
  };

  it("loads .tga, else .pcx through the global palette, in suffix order", async () => {
    const palette = syntheticPalette();
    palette.set([9, 8, 7], 4 * 3);
    const fs = await fsWith({
      "env/testrt.tga": writeTga(4, 4, solid(10)),
      "env/testbk.tga": writeTga(4, 4, solid(20), { rle: true }),
      "env/testlf.pcx": writePcx(4, 4, () => 4),
      // .tga wins over .pcx.
      "env/testft.tga": writeTga(4, 4, solid(40)),
      "env/testft.pcx": writePcx(4, 4, () => 1),
      // Corrupt .tga: reported, then the .pcx.
      "env/testup.tga": new Uint8Array(5),
      "env/testup.pcx": writePcx(4, 4, () => 4),
      [PALETTE_PATH]: writePalettePcx(palette),
    });
    const sky = await loadSkyImages(fs, "test");
    expect(sky.images.map((i) => i && px(i, 0, 0))).toEqual([
      [10, 0, 0, 255],
      [20, 0, 0, 255],
      [9, 8, 7, 255],
      [40, 0, 0, 255],
      [9, 8, 7, 255],
      undefined,
    ]);
    expect(sky.loaded).toEqual(["env/testbk.tga", "env/testft.tga", "env/testlf.pcx", "env/testrt.tga", "env/testup.pcx"]);
    expect(sky.errors).toEqual(["env/testup.tga: tga is 5 bytes, shorter than its header"]);
  });

  it("reports a .pcx with no palette mounted, and resizes for upload", async () => {
    const fs = await fsWith({ "env/qrt.pcx": writePcx(4, 4, () => 4), "env/qbk.tga": writeTga(300, 2, solid(1)) });
    const sky = await loadSkyImages(fs, "q");
    expect(sky.images[0]).toBeUndefined();
    expect([sky.images[1]!.width, sky.images[1]!.height]).toEqual([256, 2]);
    expect(sky.errors).toEqual([`env/qrt.pcx: no palette (${PALETTE_PATH}) to map it through`]);
  });

  it("gives nothing, without errors, when nothing is mounted", async () => {
    const sky = await loadSkyImages(new GameFs(), "unit1_");
    expect(sky.images).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(sky.errors).toEqual([]);
  });

  it("cuts paths at MAX_QPATH and loads by the cut path's ending", async () => {
    // "env/" + 55 characters + "rt" + ".tga" is 65: cut to 63, "env/<name>rt.t".
    const name = "n".repeat(55);
    const cut = `env/${name}rt.t`;
    expect(cut.length).toBe(63);
    const fs = await fsWith({ [cut]: writeTga(2, 2, solid(5)), [`env/${name}rt.tga`]: writeTga(2, 2, solid(6)) });
    expect((await loadSkyImages(fs, name)).images[0]).toBeUndefined();
    // A cut that ends in ".tga": "env/" + 55 + "rt.tga" would need 65; 53 characters fit exactly.
    const short = "s".repeat(53);
    const fs2 = await fsWith({ [`env/${short}rt.tga`]: writeTga(2, 2, solid(7)) });
    expect((await loadSkyImages(fs2, short)).images[0]).toBeDefined();
  });
});
