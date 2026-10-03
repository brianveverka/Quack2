// SPDX-License-Identifier: GPL-2.0-or-later
// Game data in the browser: archives the user supplies (file picker or ?pak= URL) are
// mounted into a GameFs, and world textures are decoded from it up front so the
// renderer's synchronous TextureSource can serve them. Nothing here is required: no
// archives, no palette, or a broken .wal each degrade to checker placeholders. Maps are
// looked up in the same GameFs before falling back to a fetch.

import { GameFs, openArchive, type Archive } from "@quack2/sim";
import { checkerTexture, type TextureImage, type TextureSource } from "./textures.js";
import { PALETTE_PATH, decodeWal, pcxPalette, walToRgba } from "./wal.js";

/**
 * Raw deflate through the platform's DecompressionStream (browsers and Node 18+). Stops
 * as soon as the output passes `size`, so an entry that lies about its size cannot
 * inflate without bound; the caller rejects the short or long result.
 */
export async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  // Copy into a fresh buffer: Blob parts must not be views of a shared or resizable one.
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const out = new Uint8Array(size + 1);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value.subarray(0, out.length - length), length);
    length += value.length;
    if (length > size) {
      await reader.cancel();
      break;
    }
  }
  return out.subarray(0, Math.min(length, size + 1));
}

export function openGameArchive(bytes: Uint8Array): Archive {
  return openArchive(bytes, inflateRaw);
}

export function walPath(name: string): string {
  return `textures/${name}.wal`;
}

export interface WalTextures {
  readonly source: TextureSource;
  /** Whether pics/colormap.pcx was found and valid. Without it every .wal is a sized checker. */
  readonly palette: boolean;
  /** Names whose .wal was found and decoded to real pixels. */
  readonly loaded: readonly string[];
  /** Non-fatal problems: unreadable archive entries, corrupt .wal or palette. */
  readonly errors: readonly string[];
}

/** Error text, falling back to the cause or name: Node's zlib errors have an empty message. */
export function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return e.message || cause || e.name;
}

/** Decode `textures/<name>.wal` for every name. Names with no .wal are left to the renderer's fallback. */
export async function loadWalTextures(fs: GameFs, names: readonly string[]): Promise<WalTextures> {
  const errors: string[] = [];
  let palette: Uint8Array | undefined;
  try {
    const pcx = await fs.read(PALETTE_PATH);
    if (pcx) palette = pcxPalette(pcx);
  } catch (e) {
    errors.push(`${PALETTE_PATH}: ${errorMessage(e)}`);
  }

  const images = new Map<string, TextureImage>();
  const loaded: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      const path = walPath(name);
      try {
        const bytes = await fs.read(path);
        if (!bytes) return;
        const wal = decodeWal(bytes);
        if (palette) {
          images.set(name, walToRgba(wal, palette));
          loaded.push(name);
        } else {
          images.set(name, checkerTexture(name, wal.width, wal.height));
        }
      } catch (e) {
        errors.push(`${path}: ${errorMessage(e)}`);
      }
    }),
  );
  loaded.sort();
  errors.sort();
  return { source: (name) => images.get(name), palette: palette !== undefined, loaded, errors };
}

/** A loaded BSP and where it came from: a mounted archive's name, or the fetched URL. */
export interface MapFile {
  readonly bytes: Uint8Array;
  readonly source: string;
}

/** Thrown with a status-line message when a map cannot be loaded from anywhere. */
export class MapLoadError extends Error {
  override name = "MapLoadError";
}

/** A scheme (http:, blob:, data:) or a protocol-relative "//": only fetch can load it. */
function isUrl(map: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(map);
}

/**
 * Loads `map` from the mounted archives when it is a path they hold (like the engine's
 * search path, newest mount first), otherwise fetches it as a URL relative to the page.
 * A corrupt archive entry is an error, not a reason to fall back: the archive copy is
 * the one the engine would load.
 */
export async function loadMap(
  fs: GameFs,
  map: string,
  fetchUrl: (url: string) => Promise<Response> = fetch,
): Promise<MapFile> {
  const archive = isUrl(map) ? undefined : fs.source(map);
  if (archive !== undefined) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await fs.read(map);
    } catch (e) {
      throw new MapLoadError(`Could not load ${map} from ${archive}: ${errorMessage(e)}`);
    }
    // source() found it, so read() searches the same mounts and finds it too.
    return { bytes: bytes!, source: archive };
  }
  let failure: string;
  try {
    const res = await fetchUrl(map);
    if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), source: map };
    failure = `HTTP ${res.status}`;
  } catch (e) {
    failure = errorMessage(e);
  }
  const searched = !isUrl(map) && fs.names.length > 0 ? `not in ${fs.names.join(", ")} and ` : "";
  throw new MapLoadError(`Could not load ${map}: ${searched}${failure}`);
}
