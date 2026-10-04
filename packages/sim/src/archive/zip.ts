// SPDX-License-Identifier: GPL-2.0-or-later
// Zip (and pk3) reader: entries come from the central directory, stored (method 0) and
// deflate (method 8) are supported, contents are inflated on read and CRC-checked.
// Encryption and other methods are rejected per entry, not per archive. Zip64 end
// records and extra fields are read, and a stub prepended without adjusting the offsets
// (an unfixed self-extractor) is found the way Python's zipfile finds it. Only the end
// records and central directory are read up front; entry data is read on demand.

import { ArchiveError, normalizePath, readName, readRange, toSource, type Archive, type ArchiveSource, type InflateRaw } from "./archive.js";

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const LOCATOR64_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const EOCD64_SIZE = 56;
const LOCATOR64_SIZE = 20;
const ZIP64_EXTRA_ID = 0x0001;
/** A 32-bit size or offset field with this value is in the zip64 extra field instead. */
const ZIP64_MARK = 0xffffffff;
const MAX_COMMENT = 0xffff;
/** Far above any game file; refuses entries whose claimed size is an allocation attack. */
export const ZIP_MAX_ENTRY_SIZE = 256 * 1024 * 1024;
/**
 * Deflate cannot expand past about 1032:1, so a claimed size beyond that is a lie; the
 * check stops an entry from making the inflater allocate memory the data cannot fill.
 */
const DEFLATE_MAX_RATIO = 1032;

/** Thrown when there is no end record at all, so the input is not a zip of any kind. */
export class NotZipError extends ArchiveError {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  /** As stored in the directory, before the stub shift is added. */
  readonly localOffset: number;
}

/** The parts of an end record (zip64 or not) that locate the central directory. */
interface DirectoryEnd {
  readonly cdSize: number;
  readonly cdOffset: number;
  /** Where the directory actually ends: the zip64 end record if there is one, else the end record. */
  readonly cdEnd: number;
}

type ReadAt = (start: number, end: number) => Promise<Uint8Array>;

const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A u64 field as a number; one above 2^53 - 1 becomes Infinity so it fails every range check. */
function u64(view: DataView, offset: number): number {
  const v = view.getBigUint64(offset, true);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(v);
}

/** Offset of the end record within `tail`, which must end where the file ends. */
function findEocd(view: DataView): number {
  for (let o = view.byteLength - EOCD_SIZE; o >= 0; o--) {
    if (view.getUint32(o, true) === EOCD_SIG && o + EOCD_SIZE + view.getUint16(o + 20, true) <= view.byteLength) return o;
  }
  throw new NotZipError("not a zip file (no end of central directory record)");
}

/**
 * The zip64 end record, if a zip64 locator sits right before the end record at `eocd`.
 * Follows Python's zipfile (_EndRecData64): the record is at the locator's offset, or,
 * when that misses and a stub may have shifted it, directly before the locator.
 */
async function readZip64End(eocd: number, at: ReadAt): Promise<DirectoryEnd | undefined> {
  const locator = eocd - LOCATOR64_SIZE;
  if (locator < 0) return undefined;
  const lv = viewOf(await at(locator, eocd));
  if (lv.getUint32(0, true) !== LOCATOR64_SIG) return undefined;
  if (lv.getUint32(4, true) !== 0 || lv.getUint32(16, true) > 1) throw new ArchiveError("multi-disk zip archives are not supported");
  const adjacent = locator - EOCD64_SIZE;
  const claimed = u64(lv, 8);
  if (adjacent < 0 || claimed > adjacent) throw new ArchiveError("zip64 end of central directory locator is corrupt");
  let record = claimed;
  let rv = viewOf(await at(claimed, claimed + EOCD64_SIZE));
  if (rv.getUint32(0, true) !== EOCD64_SIG && claimed !== adjacent) {
    record = adjacent;
    rv = viewOf(await at(adjacent, locator));
  }
  if (rv.getUint32(0, true) !== EOCD64_SIG) throw new ArchiveError("zip64 end of central directory record not found");
  const cdSize = u64(rv, 40);
  const cdOffset = u64(rv, 48);
  // Both checks are in the archive's own offsets, so they hold with or without a stub.
  // Bytes between the record and the locator are its extensible data, counted by its size.
  if (cdOffset + cdSize !== claimed || u64(rv, 4) + 12 !== EOCD64_SIZE + (adjacent - record)) {
    throw new ArchiveError("zip64 end of central directory record is corrupt");
  }
  return { cdSize, cdOffset, cdEnd: record };
}

/**
 * Values for the [size, compressed size, local offset] fields an entry marked
 * ZIP64_MARK, from its zip64 extra field in that order (APPNOTE 4.5.3). A field the
 * extra lacks stays marked, and reading that entry fails.
 */
function zip64Fields(view: DataView, start: number, length: number, fields: number[]): number[] {
  const end = start + length;
  for (let p = start; p + 4 <= end; ) {
    const id = view.getUint16(p, true);
    const blockEnd = p + 4 + view.getUint16(p + 2, true);
    if (blockEnd > end) break;
    if (id === ZIP64_EXTRA_ID) {
      let q = p + 4;
      return fields.map((f) => {
        if (f !== ZIP64_MARK || q + 8 > blockEnd) return f;
        q += 8;
        return u64(view, q - 8);
      });
    }
    p = blockEnd;
  }
  return fields;
}

/** Entries by normalized path; the first of duplicate names wins, directories are skipped. */
function parseDirectory(cd: Uint8Array): Map<string, ZipEntry> {
  const view = viewOf(cd);
  const end = cd.length;
  const entries = new Map<string, ZipEntry>();
  let o = 0;
  // Bounded by the directory's size, not the entry count, as in Python's zipfile: some
  // writers put 0xffff or a zip64 count there that the entries do not match.
  for (let i = 0; o < end; i++) {
    if (o + CENTRAL_SIZE > end || view.getUint32(o, true) !== CENTRAL_SIG) {
      throw new ArchiveError(`zip central directory entry ${i} is corrupt`);
    }
    const nameLength = view.getUint16(o + 28, true);
    const extraLength = view.getUint16(o + 30, true);
    const next = o + CENTRAL_SIZE + nameLength + extraLength + view.getUint16(o + 32, true);
    if (next > end) throw new ArchiveError(`zip central directory entry ${i} is corrupt`);
    let fields = [view.getUint32(o + 24, true), view.getUint32(o + 20, true), view.getUint32(o + 42, true)];
    if (fields.includes(ZIP64_MARK)) fields = zip64Fields(view, o + CENTRAL_SIZE + nameLength, extraLength, fields);
    const [size, compressedSize, localOffset] = fields as [number, number, number];
    const entry: ZipEntry = {
      name: readName(cd, o + CENTRAL_SIZE, nameLength),
      flags: view.getUint16(o + 8, true),
      method: view.getUint16(o + 10, true),
      crc: view.getUint32(o + 16, true),
      compressedSize,
      size,
      localOffset,
    };
    o = next;
    const path = normalizePath(entry.name);
    if (!path || path.endsWith("/") || entries.has(path)) continue;
    entries.set(path, entry);
  }
  return entries;
}

export async function parseZip(data: Uint8Array | ArchiveSource, inflateRaw: InflateRaw): Promise<Archive> {
  const source = toSource(data);
  const tailStart = Math.max(0, source.size - EOCD_SIZE - MAX_COMMENT);
  const tail = await readRange(source, tailStart, source.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const e = findEocd(tv);
  const eocd = tailStart + e;
  const at: ReadAt = (start, end) =>
    start >= tailStart ? Promise.resolve(tail.subarray(start - tailStart, end - tailStart)) : readRange(source, start, end);
  const dir = (await readZip64End(eocd, at)) ?? {
    cdSize: tv.getUint32(e + 12, true),
    cdOffset: tv.getUint32(e + 16, true),
    cdEnd: eocd,
  };
  const { cdSize, cdOffset } = dir;
  if (dir.cdEnd === eocd && (cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK)) {
    throw new ArchiveError("zip end record defers to a zip64 record that is not there");
  }
  // The directory is taken to end where the end record (or zip64 end record) starts, as
  // Python's zipfile does. Any difference from the stored offset is a stub prepended
  // without adjusting the offsets (or, when negative, an adjusted stub since stripped),
  // and shifts every offset in the archive.
  let shift = dir.cdEnd - cdSize - cdOffset;
  if (cdOffset + shift < 0) throw new ArchiveError(`zip central directory out of range (offset ${cdOffset}, size ${cdSize})`);

  // The read is exactly the cdSize bytes the directory claims, never the gap before it.
  let entries: Map<string, ZipEntry>;
  try {
    entries = parseDirectory(await readRange(source, cdOffset + shift, dir.cdEnd));
  } catch (err) {
    // Bytes between a correctly placed directory and the end record also look like a
    // stub. Python rejects such a zip; unzip, and this reader, fall back to the stored
    // offset when the shifted one does not hold a directory.
    if (!(err instanceof ArchiveError) || shift <= 0) throw err;
    entries = parseDirectory(await readRange(source, cdOffset, cdOffset + cdSize));
    shift = 0;
  }

  const read = async (path: string): Promise<Uint8Array | undefined> => {
    const e = entries.get(normalizePath(path));
    if (!e) return undefined;
    if (e.flags & 1) throw new ArchiveError(`${e.name}: encrypted zip entries are not supported`);
    if (e.compressedSize === ZIP64_MARK || e.size === ZIP64_MARK || e.localOffset === ZIP64_MARK) {
      throw new ArchiveError(`${e.name}: zip64 extra field is missing or short`);
    }
    if (e.size > ZIP_MAX_ENTRY_SIZE) throw new ArchiveError(`${e.name}: ${e.size} bytes is over the ${ZIP_MAX_ENTRY_SIZE}-byte entry limit`);
    if (e.method === 8 && e.size > e.compressedSize * DEFLATE_MAX_RATIO + 1024) {
      throw new ArchiveError(`${e.name}: claims ${e.size} bytes from ${e.compressedSize} compressed`);
    }
    if (e.method !== 0 && e.method !== 8) throw new ArchiveError(`${e.name}: zip compression method ${e.method} is not supported`);
    const lo = e.localOffset + shift;
    const local = lo < 0 || lo + LOCAL_SIZE > source.size ? undefined : await readRange(source, lo, lo + LOCAL_SIZE);
    const lv = local && new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (!lv || lv.getUint32(0, true) !== LOCAL_SIG) throw new ArchiveError(`${e.name}: zip local header is corrupt`);
    // The local header's own name and extra lengths can differ from the central copy.
    const start = lo + LOCAL_SIZE + lv.getUint16(26, true) + lv.getUint16(28, true);
    if (start + e.compressedSize > source.size) throw new ArchiveError(`${e.name}: zip entry data out of range`);
    const raw = await readRange(source, start, start + e.compressedSize);
    let data: Uint8Array;
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new ArchiveError(`${e.name}: stored entry sizes differ`);
      data = raw;
    } else {
      data = await inflateRaw(raw, e.size);
    }
    if (data.length !== e.size) throw new ArchiveError(`${e.name}: inflated to ${data.length} bytes, expected ${e.size}`);
    if (crc32(data) !== e.crc) throw new ArchiveError(`${e.name}: CRC mismatch`);
    return data;
  };

  return {
    paths: [...entries.keys()],
    has: (path) => entries.has(normalizePath(path)),
    read,
  };
}
