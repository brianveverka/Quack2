// SPDX-License-Identifier: GPL-2.0-or-later
import { ArchiveError, readRange, toSource, type Archive, type ArchiveSource, type InflateRaw } from "./archive.js";
import { isPak, parsePak } from "./pak.js";
import { NotZipError, parseZip } from "./zip.js";

export * from "./archive.js";
export * from "./pak.js";
export * from "./zip.js";

/**
 * Opens a pak by its leading magic bytes, and anything else as a zip/pk3 by its end
 * record, never by file name. A zip is not tested for "PK" up front: a self-extractor
 * starts with its stub.
 */
export async function openArchive(data: Uint8Array | ArchiveSource, inflateRaw: InflateRaw): Promise<Archive> {
  const source = toSource(data);
  const magic = await readRange(source, 0, Math.min(4, source.size));
  if (isPak(magic)) return parsePak(source);
  try {
    return await parseZip(source, inflateRaw);
  } catch (err) {
    if (err instanceof NotZipError) throw new ArchiveError("not a pak or zip archive");
    throw err;
  }
}
