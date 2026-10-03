// SPDX-License-Identifier: GPL-2.0-or-later
import { ArchiveError, type Archive, type InflateRaw } from "./archive.js";
import { isPak, parsePak } from "./pak.js";
import { isZip, parseZip } from "./zip.js";

export * from "./archive.js";
export * from "./pak.js";
export * from "./zip.js";

/** Opens a pak or zip/pk3 by its leading magic bytes, not its file name. */
export function openArchive(bytes: Uint8Array, inflateRaw: InflateRaw): Archive {
  if (isPak(bytes)) return parsePak(bytes);
  if (isZip(bytes)) return parseZip(bytes, inflateRaw);
  throw new ArchiveError("not a pak or zip archive");
}
