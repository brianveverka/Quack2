// SPDX-License-Identifier: GPL-2.0-or-later
// Quake pak: "PACK", int32 directory offset, int32 directory length, then 64-byte
// entries of name[56], int32 offset, int32 length. Little-endian, uncompressed.

import { ArchiveError, normalizePath, readName, type Archive } from "./archive.js";

export const PAK_MAGIC = 0x4b434150; // "PACK"
export const PAK_HEADER_SIZE = 12;
export const PAK_ENTRY_SIZE = 64;
export const PAK_NAME_LENGTH = 56;

export function isPak(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x43 && bytes[3] === 0x4b;
}

export function parsePak(bytes: Uint8Array): Archive {
  if (bytes.length < PAK_HEADER_SIZE || !isPak(bytes)) throw new ArchiveError("not a pak file (no PACK header)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dirOffset = view.getInt32(4, true);
  const dirLength = view.getInt32(8, true);
  if (dirOffset < PAK_HEADER_SIZE || dirLength < 0 || dirLength % PAK_ENTRY_SIZE !== 0 || dirOffset + dirLength > bytes.length) {
    throw new ArchiveError(`pak directory out of range (offset ${dirOffset}, length ${dirLength}, file ${bytes.length})`);
  }
  const files = new Map<string, Uint8Array>();
  for (let o = dirOffset; o < dirOffset + dirLength; o += PAK_ENTRY_SIZE) {
    const name = readName(bytes, o, PAK_NAME_LENGTH);
    const pos = view.getInt32(o + PAK_NAME_LENGTH, true);
    const len = view.getInt32(o + PAK_NAME_LENGTH + 4, true);
    if (pos < 0 || len < 0 || pos + len > bytes.length) {
      throw new ArchiveError(`pak entry "${name}" out of range (offset ${pos}, length ${len}, file ${bytes.length})`);
    }
    const path = normalizePath(name);
    // The engine scans the directory front to back, so the first duplicate wins.
    if (path && !files.has(path)) files.set(path, bytes.subarray(pos, pos + len));
  }
  return {
    paths: [...files.keys()],
    has: (path) => files.has(normalizePath(path)),
    read: (path) => Promise.resolve(files.get(normalizePath(path))),
  };
}
