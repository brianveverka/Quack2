// SPDX-License-Identifier: GPL-2.0-or-later
// Synthetic archives, palettes and .wal files only; no game data.
import { GameFs } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { syntheticPalette, writePak, writePalettePcx, writeWal, writeZip } from "../../../scripts/synthetic-data.mjs";
import { deflateRawSync } from "node:zlib";
import { MapLoadError, errorMessage, inflateRaw, loadMap, loadWalTextures, openGameArchive, walPath } from "../src/assets.js";
import { CHECKER_SIZE, resolveTextures } from "../src/textures.js";
import { PALETTE_PATH, TRANSPARENT_INDEX, WalError, decodeWal, pcxPalette, walToRgba } from "../src/wal.js";

const palette = syntheticPalette();
palette.set([255, 0, 0], 1 * 3);
palette.set([0, 0, 255], 2 * 3);
const pcx = writePalettePcx(palette);
/** 16x8, index 1 in the left half, 2 in the right, row 0 tagged with index x for orientation. */
const wal = writeWal("test/half", 16, 8, (x, y) => (y === 0 ? x : x < 8 ? 1 : 2));
const rgb = (img: { data: Uint8Array; width: number }, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("wal", () => {
  it("decodes mip 0 from the header's size and offset", () => {
    const w = decodeWal(wal);
    expect([w.width, w.height, w.pixels.length]).toEqual([16, 8, 128]);
    expect(Array.from(w.pixels.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    expect(w.pixels[16 + 3]).toBe(1);
    expect(w.pixels[16 + 12]).toBe(2);
  });

  it("rejects truncated files and absurd sizes", () => {
    expect(() => decodeWal(wal.subarray(0, 99))).toThrow(WalError);
    expect(() => decodeWal(wal.subarray(0, 100 + 127))).toThrow(/outside/);
    const huge = wal.slice();
    new DataView(huge.buffer).setUint32(32, 1 << 20, true);
    expect(() => decodeWal(huge)).toThrow(/out of range/);
    const zero = wal.slice();
    new DataView(zero.buffer).setUint32(36, 0, true);
    expect(() => decodeWal(zero)).toThrow(/out of range/);
  });

  it("expands through the palette, rows top to bottom", () => {
    const img = walToRgba(decodeWal(wal), pcxPalette(pcx));
    expect([img.width, img.height]).toEqual([16, 8]);
    expect(rgb(img, 2, 5)).toEqual([255, 0, 0, 255]);
    expect(rgb(img, 12, 5)).toEqual([0, 0, 255, 255]);
    expect(rgb(img, 7, 0)).toEqual([7, 248, (7 * 37) & 255, 255]);
  });

  it("makes index 255 transparent with a neighbor's color, as GL_Upload8 does", () => {
    // 4x3: a 255 in the middle row takes the pixel above; row 0 position 0 has no
    // pixel above (engine tests i > width) so it takes the one below.
    const rows = [
      [TRANSPARENT_INDEX, 1, 1, 1],
      [2, TRANSPARENT_INDEX, 2, 2],
      [3, 3, 3, TRANSPARENT_INDEX],
    ];
    const img = walToRgba(decodeWal(writeWal("t", 4, 3, (x, y) => rows[y]![x]!)), palette);
    expect(rgb(img, 0, 0)).toEqual([...palette.subarray(2 * 3, 2 * 3 + 3), 0]);
    expect(rgb(img, 1, 1)).toEqual([255, 0, 0, 0]);
    expect(rgb(img, 3, 2)).toEqual([0, 0, 255, 0]);
    const lone = walToRgba(decodeWal(writeWal("t", 1, 1, () => TRANSPARENT_INDEX)), palette);
    expect(rgb(lone, 0, 0)).toEqual([...palette.subarray(0, 3), 0]);
  });

  it("reads the PCX trailing palette and rejects other files", () => {
    expect(pcxPalette(pcx)).toEqual(palette);
    expect(() => pcxPalette(pcx.subarray(1))).toThrow(WalError);
    const noMarker = pcx.slice();
    noMarker[noMarker.length - 769] = 0;
    expect(() => pcxPalette(noMarker)).toThrow(/trailing 256-color palette/);
  });
});

describe("loadWalTextures", () => {
  const names = ["test/half", "test/zipped", "test/missing", "test/broken"];
  const files = {
    [PALETTE_PATH]: pcx,
    [walPath("test/half")]: wal,
    [walPath("test/broken")]: wal.subarray(0, 50),
  };
  const zipped = writeWal("test/zipped", 32, 32, () => 2);

  it("inflates through DecompressionStream", async () => {
    const zip = writeZip({ "a.wal": zipped });
    expect(await (await openGameArchive(zip)).read("a.wal")).toEqual(zipped);
    expect(await inflateRaw(new Uint8Array([3, 0]), 0)).toEqual(new Uint8Array(0));
  });

  it("stops inflating once output passes the expected size", async () => {
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(50 << 20)));
    expect((await inflateRaw(bomb, 10)).length).toBe(11);
    const zip = writeZip({ "bomb.wal": new Uint8Array(1 << 20) });
    const v = new DataView(zip.buffer);
    const cd = v.getUint32(zip.length - 22 + 16, true);
    v.setUint32(cd + 24, 10, true); // central directory claims 10 bytes
    await expect((await openGameArchive(zip)).read("bomb.wal")).rejects.toThrow(/inflated to 11 bytes, expected 10/);
  });

  it("gives truncated deflate data a readable error", async () => {
    const cut = new Uint8Array(deflateRawSync(zipped)).subarray(0, 20);
    const e = await inflateRaw(cut, zipped.length).catch((x: unknown) => x);
    expect(errorMessage(e)).not.toBe("");
  });

  it("decodes found textures, leaves missing ones to the fallback, reports broken ones", async () => {
    const fs = new GameFs();
    fs.mount("pak0.pak", await openGameArchive(writePak(files)));
    fs.mount("pak1.zip", await openGameArchive(writeZip({ [walPath("TEST/Zipped")]: zipped })));
    const t = await loadWalTextures(fs, names);
    expect(t.palette).toBe(true);
    expect(t.loaded).toEqual(["test/half", "test/zipped"]);
    expect(t.errors).toEqual([expect.stringMatching(/^textures\/test\/broken\.wal: .*shorter than its header/)]);
    expect(rgb(t.source("test/zipped")!, 31, 31)).toEqual([0, 0, 255, 255]);
    const { images, missing } = resolveTextures(names, t.source);
    expect(missing).toEqual(["test/missing", "test/broken"]);
    expect(images.map((i) => [i.width, i.height])).toEqual([[16, 8], [32, 32], [CHECKER_SIZE, CHECKER_SIZE], [CHECKER_SIZE, CHECKER_SIZE]]);
  });

  it("without a palette, draws checkers at each .wal's real size", async () => {
    const fs = new GameFs();
    fs.mount("nopal.pak", await openGameArchive(writePak({ [walPath("test/half")]: wal })));
    const t = await loadWalTextures(fs, ["test/half"]);
    expect(t.palette).toBe(false);
    expect(t.loaded).toEqual([]);
    const { images, missing } = resolveTextures(["test/half"], t.source);
    expect(missing).toEqual(["test/half"]);
    expect([images[0]!.width, images[0]!.height]).toEqual([16, 8]);
  });

  it("reports a corrupt palette and carries on", async () => {
    const fs = new GameFs();
    fs.mount("bad.pak", await openGameArchive(writePak({ [PALETTE_PATH]: pcx.subarray(0, 300), [walPath("test/half")]: wal })));
    const t = await loadWalTextures(fs, ["test/half"]);
    expect(t.palette).toBe(false);
    expect(t.errors).toEqual([expect.stringMatching(/^pics\/colormap\.pcx: /)]);
  });

  it("an empty GameFs leaves every name to the fallback", async () => {
    const t = await loadWalTextures(new GameFs(), names);
    expect([t.palette, t.loaded, t.errors]).toEqual([false, [], []]);
    expect(resolveTextures(names, t.source).missing).toEqual(names);
  });
});

describe("loadMap", () => {
  const packed = new TextEncoder().encode("bsp from the pak");
  const served = new TextEncoder().encode("bsp from the server");
  const text = (m: { bytes: Uint8Array }) => new TextDecoder().decode(m.bytes);
  /** A fetch that serves `served` at "maps/served.bsp" and 404s everything else, logging each URL. */
  const server = () => {
    const urls: string[] = [];
    const fetchUrl = async (url: string) => {
      urls.push(url);
      return url === "maps/served.bsp" || url === "maps/both.bsp" ? new Response(served) : new Response("no", { status: 404 });
    };
    return { urls, fetchUrl };
  };
  const mounted = async () => {
    const fs = new GameFs();
    fs.mount("pak0.pak", await openGameArchive(writePak({ "maps/packed.bsp": packed, "maps/both.bsp": packed })));
    fs.mount("pak1.pak", await openGameArchive(writePak({ "pics/colormap.pcx": pcx })));
    return fs;
  };

  it("reads a path from the mounted archives without fetching, case-insensitively", async () => {
    const { urls, fetchUrl } = server();
    const m = await loadMap(await mounted(), "Maps/Packed.BSP", fetchUrl);
    expect([text(m), m.source, urls]).toEqual(["bsp from the pak", "pak0.pak", []]);
  });

  it("prefers the archive copy over the same path on the server", async () => {
    const { urls, fetchUrl } = server();
    const m = await loadMap(await mounted(), "maps/both.bsp", fetchUrl);
    expect([text(m), m.source, urls]).toEqual(["bsp from the pak", "pak0.pak", []]);
  });

  it("falls back to fetching a path the archives lack", async () => {
    const { urls, fetchUrl } = server();
    const m = await loadMap(await mounted(), "maps/served.bsp", fetchUrl);
    expect([text(m), m.source, urls]).toEqual(["bsp from the server", "maps/served.bsp", ["maps/served.bsp"]]);
  });

  it("only fetches a URL with a scheme, even when an archive has that path", async () => {
    const { urls, fetchUrl } = server();
    const e = await loadMap(await mounted(), "http://x/maps/packed.bsp", fetchUrl).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MapLoadError);
    expect((e as Error).message).toBe("Could not load http://x/maps/packed.bsp: HTTP 404");
    expect(urls).toEqual(["http://x/maps/packed.bsp"]);
  });

  it("names the searched archives and the HTTP failure when a path is in neither", async () => {
    const { fetchUrl } = server();
    await expect(loadMap(await mounted(), "maps/absent.bsp", fetchUrl)).rejects.toThrow(
      new MapLoadError("Could not load maps/absent.bsp: not in pak0.pak, pak1.pak and HTTP 404"),
    );
    await expect(loadMap(new GameFs(), "maps/absent.bsp", fetchUrl)).rejects.toThrow("Could not load maps/absent.bsp: HTTP 404");
  });

  it("reports a network failure as a MapLoadError", async () => {
    const fetchUrl = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(loadMap(new GameFs(), "maps/x.bsp", fetchUrl)).rejects.toThrow(new MapLoadError("Could not load maps/x.bsp: Failed to fetch"));
  });

  it("reports a corrupt archive entry instead of fetching another copy", async () => {
    const bsp = new Uint8Array(4000).fill(7);
    const zip = writeZip({ "maps/bad.bsp": bsp });
    // Corrupt the deflated data (it follows the 30-byte local header and the name).
    zip.fill(0xff, 30 + "maps/bad.bsp".length, 30 + "maps/bad.bsp".length + 4);
    const fs = new GameFs();
    fs.mount("bad.zip", await openGameArchive(zip));
    const { urls, fetchUrl } = server();
    await expect(loadMap(fs, "maps/bad.bsp", fetchUrl)).rejects.toThrow(/^Could not load maps\/bad\.bsp from bad\.zip: ./);
    expect(urls).toEqual([]);
  });
});
