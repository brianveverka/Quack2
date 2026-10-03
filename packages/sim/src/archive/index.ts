// SPDX-License-Identifier: GPL-2.0-or-later
import { ArchiveError, readRange, toSource, type Archive, type ArchiveSource, type InflateRaw } from "./archive.js";
import { isPak, parsePak } from "./pak.js";
import { isZip, parseZip } from "./zip.js";

export * from "./archive.js";
export * from "./pak.js";
export * from "./zip.js";

/** Opens a pak or zip/pk3 by its leading magic bytes, not its file name. */
export async function openArchive(data: Uint8Array | ArchiveSource, inflateRaw: InflateRaw): Promise<Archive> {
  const source = toSource(data);
  const magic = await readRange(source, 0, Math.min(4, source.size));
  if (isPak(magic)) return parsePak(source);
  if (isZip(magic)) return parseZip(source, inflateRaw);
  throw new ArchiveError("not a pak or zip archive");
}
