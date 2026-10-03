// SPDX-License-Identifier: GPL-2.0-or-later
// Quake pak: "PACK", int32 directory offset, int32 directory length, then 64-byte
// entries of name[56], int32 offset, int32 length. Little-endian, uncompressed.

import { ArchiveError, normalizePath, readName, readRange, toSource, type Archive, type ArchiveSource } from "./archive.js";

export const PAK_MAGIC = 0x4b434150; // "PACK"
export const PAK_HEADER_SIZE = 12;
export const PAK_ENTRY_SIZE = 64;
export const PAK_NAME_LENGTH = 56;

export function isPak(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x43 && bytes[3] === 0x4b;
}

/** Reads the header and directory now, each entry's bytes when it is read. */
export async function parsePak(data: Uint8Array | ArchiveSource): Promise<Archive> {
  const source = toSource(data);
  const size = source.size;
  const header = size < PAK_HEADER_SIZE ? undefined : await readRange(source, 0, PAK_HEADER_SIZE);
  if (!header || !isPak(header)) throw new ArchiveError("not a pak file (no PACK header)");
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const dirOffset = hv.getInt32(4, true);
  const dirLength = hv.getInt32(8, true);
  if (dirOffset < PAK_HEADER_SIZE || dirLength < 0 || dirLength % PAK_ENTRY_SIZE !== 0 || dirOffset + dirLength > size) {
    throw new ArchiveError(`pak directory out of range (offset ${dirOffset}, length ${dirLength}, file ${size})`);
  }
  const dir = await readRange(source, dirOffset, dirOffset + dirLength);
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const files = new Map<string, { pos: number; len: number }>();
  for (let o = 0; o < dirLength; o += PAK_ENTRY_SIZE) {
    const name = readName(dir, o, PAK_NAME_LENGTH);
    const pos = view.getInt32(o + PAK_NAME_LENGTH, true);
    const len = view.getInt32(o + PAK_NAME_LENGTH + 4, true);
    if (pos < 0 || len < 0 || pos + len > size) {
      throw new ArchiveError(`pak entry "${name}" out of range (offset ${pos}, length ${len}, file ${size})`);
    }
    const path = normalizePath(name);
    // The engine scans the directory front to back, so the first duplicate wins.
    if (path && !files.has(path)) files.set(path, { pos, len });
  }
  return {
    paths: [...files.keys()],
    has: (path) => files.has(normalizePath(path)),
    read: async (path) => {
      const f = files.get(normalizePath(path));
      return f && readRange(source, f.pos, f.pos + f.len);
    },
  };
}
