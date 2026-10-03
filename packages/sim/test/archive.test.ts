// SPDX-License-Identifier: GPL-2.0-or-later
// Every archive here is built in the test from synthetic bytes; no game data.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writePak, writeZip } from "../../../scripts/synthetic-data.mjs";
import {
  ArchiveError,
  GameFs,
  blobSource,
  crc32,
  normalizePath,
  openArchive,
  parsePak,
  parseZip,
  type ArchiveSource,
  type InflateRaw,
} from "../src/index.js";

const inflate: InflateRaw = async (data) => new Uint8Array(inflateRawSync(data));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
// Compressible and long enough that deflate actually shrinks it.
const BIG = bytes("quack ".repeat(500));

describe("pak", () => {
  const pak = writePak({ "pics/colormap.pcx": bytes("palette"), "Textures/E1U1/Floor.wal": bytes("floor"), "empty.txt": new Uint8Array(0) });

  it("lists entries in directory order and reads them case-insensitively", async () => {
    const a = await parsePak(pak);
    expect(a.paths).toEqual(["pics/colormap.pcx", "textures/e1u1/floor.wal", "empty.txt"]);
    expect(text(await a.read("textures/e1u1/floor.wal"))).toBe("floor");
    expect(text(await a.read("TEXTURES\\E1U1\\FLOOR.WAL"))).toBe("floor");
    expect((await a.read("empty.txt"))?.length).toBe(0);
    expect(await a.read("missing.wal")).toBeUndefined();
    expect(a.has("./pics/colormap.pcx")).toBe(true);
  });

  it("keeps the first of duplicate names, as the engine's front-to-back scan does", async () => {
    const dup = writePak({ "a.txt": bytes("first") });
    // Append a second directory entry with the same name pointing at new data.
    const v = new DataView(dup.buffer);
    const dirOffset = v.getInt32(4, true);
    const extra = bytes("second");
    const out = new Uint8Array(dup.length + extra.length + 64);
    out.set(dup.subarray(0, dirOffset));
    out.set(extra, dirOffset);
    const newDir = dirOffset + extra.length;
    out.set(dup.subarray(dirOffset), newDir);
    out.set(dup.subarray(dirOffset, dirOffset + 56), newDir + 64);
    const ov = new DataView(out.buffer);
    ov.setInt32(4, newDir, true);
    ov.setInt32(8, 128, true);
    ov.setInt32(newDir + 64 + 56, dirOffset, true);
    ov.setInt32(newDir + 64 + 60, extra.length, true);
    expect(text(await (await parsePak(out)).read("a.txt"))).toBe("first");
  });

  it("rejects bad headers and out-of-range entries", async () => {
    await expect(parsePak(bytes("PAKK00000000"))).rejects.toThrow(ArchiveError);
    const badDir = pak.slice();
    new DataView(badDir.buffer).setInt32(8, 65, true);
    await expect(parsePak(badDir)).rejects.toThrow(/directory out of range/);
    const badEntry = pak.slice();
    const v = new DataView(badEntry.buffer);
    v.setInt32(v.getInt32(4, true) + 60, 1 << 20, true);
    await expect(parsePak(badEntry)).rejects.toThrow(/out of range/);
  });

  it("parses a pak that sits at a nonzero offset in its buffer", async () => {
    const host = new Uint8Array(pak.length + 7);
    host.set(pak, 7);
    expect(text(await (await parsePak(host.subarray(7))).read("pics/colormap.pcx"))).toBe("palette");
  });
});

describe("zip", () => {
  const files = { "textures/a.wal": BIG, "Pics/Colormap.pcx": bytes("stored"), "dir/": new Uint8Array(0) };

  it("reads stored and deflated entries, skipping directories", async () => {
    const zip = writeZip(files, { deflate: new Set(["textures/a.wal"]) });
    expect(zip.length).toBeLessThan(BIG.length); // the deflate path really ran
    const a = await parseZip(zip, inflate);
    expect(a.paths).toEqual(["textures/a.wal", "pics/colormap.pcx"]);
    expect(await a.read("textures/a.wal")).toEqual(BIG);
    expect(text(await a.read("pics/colormap.pcx"))).toBe("stored");
    expect(await a.read("dir/")).toBeUndefined();
  });

  it("finds the end record behind an archive comment", async () => {
    const a = await parseZip(writeZip(files, { comment: "x".repeat(300) }), inflate);
    expect(await a.read("textures/a.wal")).toEqual(BIG);
  });

  it("rejects corrupt data at read time with a CRC or size error", async () => {
    const zip = writeZip({ "s.txt": bytes("stored data") }, { deflate: false });
    zip[35] = zip[35]! ^ 0xff; // first byte of the stored data (30-byte header + 5-byte name)
    await expect((await parseZip(zip, inflate)).read("s.txt")).rejects.toThrow(/CRC mismatch/);
    const short: InflateRaw = async (d) => (await inflate(d, 0)).subarray(1);
    await expect((await parseZip(writeZip({ "a.wal": BIG }), short)).read("a.wal")).rejects.toThrow(/expected 3000/);
  });

  it("rejects unsupported methods per entry, not per archive", async () => {
    const zip = writeZip({ "a.txt": bytes("a"), "b.txt": bytes("b") }, { deflate: false });
    const v = new DataView(zip.buffer);
    const cd = v.getUint32(zip.length - 22 + 16, true);
    v.setUint16(cd + 10, 12, true); // bzip2 in the central entry for a.txt
    const a = await parseZip(zip, inflate);
    await expect(a.read("a.txt")).rejects.toThrow(/method 12/);
    expect(text(await a.read("b.txt"))).toBe("b");
  });

  it("refuses entries claiming more than the size limit before inflating", async () => {
    const zip = writeZip({ "big.wal": bytes("x") });
    const v = new DataView(zip.buffer);
    v.setUint32(v.getUint32(zip.length - 22 + 16, true) + 24, 0x7fffffff, true);
    let called = false;
    const spy: InflateRaw = async (d, n) => ((called = true), inflate(d, n));
    await expect((await parseZip(zip, spy)).read("big.wal")).rejects.toThrow(/entry limit/);
    expect(called).toBe(false);
  });

  it("refuses a claimed size deflate cannot reach from the compressed size", async () => {
    const zip = writeZip({ "a.wal": bytes("x") });
    const v = new DataView(zip.buffer);
    v.setUint32(v.getUint32(zip.length - 22 + 16, true) + 24, 200 << 20, true);
    let called = false;
    const spy: InflateRaw = async (d, n) => ((called = true), inflate(d, n));
    await expect((await parseZip(zip, spy)).read("a.wal")).rejects.toThrow(/claims 209715200 bytes from 3 compressed/);
    expect(called).toBe(false);
  });

  it("rejects input with no end record", async () => {
    await expect(parseZip(bytes("PK\x03\x04 not really a zip"), inflate)).rejects.toThrow(/no end of central directory/);
    await expect(parseZip(bytes("PK"), inflate)).rejects.toThrow(/no end of central directory/);
  });

  it("crc32 matches the standard check value", () => {
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
  });
});

/** A source over `data` that records every range read through it. */
function spySource(data: Uint8Array): { source: ArchiveSource; reads: [number, number][] } {
  const reads: [number, number][] = [];
  const source: ArchiveSource = {
    size: data.length,
    slice: async (start, end) => (reads.push([start, end]), data.subarray(start, end)),
  };
  return { source, reads };
}

describe("range reads", () => {
  const files = { "a.txt": bytes("aaaa"), "b.wal": BIG, "c.txt": bytes("cc") };

  it("pak: opening reads the header and directory, an entry only its own range", async () => {
    const { source, reads } = spySource(writePak(files));
    const a = await parsePak(source);
    const dirOffset = 12 + 4 + BIG.length + 2;
    expect(reads).toEqual([[0, 12], [dirOffset, dirOffset + 3 * 64]]);
    reads.length = 0;
    expect(await a.read("b.wal")).toEqual(BIG);
    expect(reads).toEqual([[16, 16 + BIG.length]]);
  });

  it("zip: opening reads the end record and directory, an entry only its local header and data", async () => {
    // A large stored entry first, so the end-record search window starts inside it.
    const pad = new Uint8Array(200_000);
    const zip = writeZip({ "pad.bin": pad, ...files }, { deflate: new Set(["b.wal"]) });
    const { source, reads } = spySource(zip);
    const a = await parseZip(source, inflate);
    const cdOffset = new DataView(zip.buffer).getUint32(zip.length - 22 + 16, true);
    expect(reads).toEqual([[zip.length - 22 - 0xffff, zip.length], [cdOffset, zip.length - 22]]);
    reads.length = 0;
    expect(await a.read("b.wal")).toEqual(BIG);
    const local = 30 + 7 + pad.length + 30 + 5 + 4; // after pad.bin and a.txt
    const data = local + 30 + 5;
    expect(reads).toEqual([[local, local + 30], [data, data + deflateRawSync(BIG).length]]);
  });

  it("zip: reads only the directory's claimed size, not a gap before the end record", async () => {
    const empty = writeZip({});
    const zip = new Uint8Array(100_000 + empty.length);
    zip.set(empty, 100_000); // the end record still says the directory is at offset 0
    const { source, reads } = spySource(zip);
    expect((await parseZip(source, inflate)).paths).toEqual([]);
    expect(reads).toEqual([[zip.length - 22 - 0xffff, zip.length], [0, 0]]);
  });

  it("reads a Blob by range", async () => {
    const a = await openArchive(blobSource(new Blob([writeZip(files, { deflate: new Set(["b.wal"]) })])), inflate);
    expect(await a.read("b.wal")).toEqual(BIG);
    expect(text(await a.read("c.txt"))).toBe("cc");
    const p = await openArchive(blobSource(new Blob([writePak(files)])), inflate);
    expect(text(await p.read("a.txt"))).toBe("aaaa");
  });

  it("rejects a read the source returns short, as from a file that shrank after opening", async () => {
    const pak = writePak(files);
    const shrunk: ArchiveSource = { size: pak.length, slice: async (s, e) => pak.subarray(s, s === 16 ? e - 1 : e) };
    const a = await parsePak(shrunk);
    await expect(a.read("b.wal")).rejects.toThrow(/returned 2999 bytes; did the file change/);
    expect(text(await a.read("a.txt"))).toBe("aaaa");
  });
});

describe("openArchive and GameFs", () => {
  it("detects the format by magic", async () => {
    expect((await openArchive(writePak({ "a": bytes("p") }), inflate)).paths).toEqual(["a"]);
    expect((await openArchive(writeZip({ "a": bytes("z") }), inflate)).paths).toEqual(["a"]);
    await expect(openArchive(bytes("GIF89a"), inflate)).rejects.toThrow(/not a pak or zip/);
    await expect(openArchive(bytes("PK"), inflate)).rejects.toThrow(/not a pak or zip/);
  });

  it("searches the newest mount first, falling through to older ones", async () => {
    const fs = new GameFs();
    fs.mount("pak0.pak", await openArchive(writePak({ "a.txt": bytes("pak0 a"), "b.txt": bytes("pak0 b") }), inflate));
    fs.mount("pak1.zip", await openArchive(writeZip({ "A.TXT": bytes("zip a") }), inflate));
    expect(fs.names).toEqual(["pak0.pak", "pak1.zip"]);
    expect(text(await fs.read("a.txt"))).toBe("zip a");
    expect(text(await fs.read("b.txt"))).toBe("pak0 b");
    expect(await fs.read("c.txt")).toBeUndefined();
    expect(fs.has("B.txt")).toBe(true);
    expect([fs.source("A.txt"), fs.source("./b.TXT"), fs.source("c.txt")]).toEqual(["pak1.zip", "pak0.pak", undefined]);
  });

  it("normalizes separators, leading ./ and case", () => {
    expect(normalizePath("./Textures\\E1U1/Floor.WAL")).toBe("textures/e1u1/floor.wal");
    expect(normalizePath("/pics/x.pcx")).toBe("pics/x.pcx");
    expect(normalizePath("textures//e1u1/./floor.wal")).toBe("textures/e1u1/floor.wal");
  });
});
