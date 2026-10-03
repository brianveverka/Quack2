// SPDX-License-Identifier: GPL-2.0-or-later
// Zip (and pk3) reader: entries come from the central directory, stored (method 0) and
// deflate (method 8) are supported, contents are inflated on read and CRC-checked.
// Zip64, encryption and other methods are rejected per entry, not per archive. Only the
// end record and central directory are read up front; entry data is read on demand.

import { ArchiveError, normalizePath, readName, readRange, toSource, type Archive, type ArchiveSource, type InflateRaw } from "./archive.js";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** Far above any game file; refuses entries whose claimed size is an allocation attack. */
export const ZIP_MAX_ENTRY_SIZE = 256 * 1024 * 1024;
/**
 * Deflate cannot expand past about 1032:1, so a claimed size beyond that is a lie; the
 * check stops an entry from making the inflater allocate memory the data cannot fill.
 */
const DEFLATE_MAX_RATIO = 1032;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && bytes[3] === bytes[2] + 1;
}

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
  readonly localOffset: number;
}

/** Offset of the end record within `tail`, which must end where the file ends. */
function findEocd(view: DataView): number {
  for (let o = view.byteLength - EOCD_SIZE; o >= 0; o--) {
    if (view.getUint32(o, true) === EOCD_SIG && o + EOCD_SIZE + view.getUint16(o + 20, true) <= view.byteLength) return o;
  }
  throw new ArchiveError("not a zip file (no end of central directory record)");
}

export async function parseZip(data: Uint8Array | ArchiveSource, inflateRaw: InflateRaw): Promise<Archive> {
  const source = toSource(data);
  const tailStart = Math.max(0, source.size - EOCD_SIZE - MAX_COMMENT);
  const tail = await readRange(source, tailStart, source.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const e = findEocd(tv);
  const eocd = tailStart + e;
  const count = tv.getUint16(e + 10, true);
  const cdSize = tv.getUint32(e + 12, true);
  const cdOffset = tv.getUint32(e + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ArchiveError("zip64 archives are not supported");
  if (cdOffset + cdSize > eocd) throw new ArchiveError(`zip central directory out of range (offset ${cdOffset}, size ${cdSize})`);

  // Bounded by cdSize, not the end record: a gap before the end record (or a bogus
  // offset of 0) would otherwise read most of a picked file.
  const cd = await readRange(source, cdOffset, cdOffset + cdSize);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const end = cd.length;
  const entries = new Map<string, ZipEntry>();
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + CENTRAL_SIZE > end || view.getUint32(o, true) !== CENTRAL_SIG) {
      throw new ArchiveError(`zip central directory entry ${i} is corrupt`);
    }
    const nameLength = view.getUint16(o + 28, true);
    const next = o + CENTRAL_SIZE + nameLength + view.getUint16(o + 30, true) + view.getUint16(o + 32, true);
    if (next > end) throw new ArchiveError(`zip central directory entry ${i} is corrupt`);
    const entry: ZipEntry = {
      name: readName(cd, o + CENTRAL_SIZE, nameLength),
      flags: view.getUint16(o + 8, true),
      method: view.getUint16(o + 10, true),
      crc: view.getUint32(o + 16, true),
      compressedSize: view.getUint32(o + 20, true),
      size: view.getUint32(o + 24, true),
      localOffset: view.getUint32(o + 42, true),
    };
    o = next;
    const path = normalizePath(entry.name);
    if (!path || path.endsWith("/") || entries.has(path)) continue;
    entries.set(path, entry);
  }

  const read = async (path: string): Promise<Uint8Array | undefined> => {
    const e = entries.get(normalizePath(path));
    if (!e) return undefined;
    if (e.flags & 1) throw new ArchiveError(`${e.name}: encrypted zip entries are not supported`);
    if (e.compressedSize === 0xffffffff || e.size === 0xffffffff) throw new ArchiveError(`${e.name}: zip64 entries are not supported`);
    if (e.size > ZIP_MAX_ENTRY_SIZE) throw new ArchiveError(`${e.name}: ${e.size} bytes is over the ${ZIP_MAX_ENTRY_SIZE}-byte entry limit`);
    if (e.method === 8 && e.size > e.compressedSize * DEFLATE_MAX_RATIO + 1024) {
      throw new ArchiveError(`${e.name}: claims ${e.size} bytes from ${e.compressedSize} compressed`);
    }
    if (e.method !== 0 && e.method !== 8) throw new ArchiveError(`${e.name}: zip compression method ${e.method} is not supported`);
    const lo = e.localOffset;
    const local = lo + LOCAL_SIZE > source.size ? undefined : await readRange(source, lo, lo + LOCAL_SIZE);
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
