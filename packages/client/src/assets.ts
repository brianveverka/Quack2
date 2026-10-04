// SPDX-License-Identifier: GPL-2.0-or-later
// Game data in the browser: archives the user supplies (file picker or ?pak= URL) are
// mounted into a GameFs, and world textures are decoded from it up front so the
// renderer's synchronous TextureSource can serve them. Nothing here is required: no
// archives, no palette, or a broken .wal each degrade to checker placeholders, and a
// missing or broken sky image to r_notexture. Maps are looked up in the same GameFs
// before falling back to a fetch.

import { GameFs, blobSource, openArchive, type Archive } from "@quack2/sim";
import { SKY_SUFFIXES } from "./sky.js";
import { decodePcx, decodeTga, pcxToRgba, uploadImage } from "./skyimage.js";
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

/** Bytes (a ?pak= fetch) are read in place; a Blob (a picked File) is read by range, never whole. */
export function openGameArchive(data: Uint8Array | Blob): Promise<Archive> {
  return openArchive(data instanceof Uint8Array ? data : blobSource(data), inflateRaw);
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

export interface SkyImages {
  /**
   * Six images in R_SetSky's suffix order (rt, bk, lf, ft, up, dn), sized as GL_Upload32
   * uploads them; undefined where none loaded, which the renderer draws as r_notexture.
   */
  readonly images: readonly (TextureImage | undefined)[];
  /** Paths that loaded. */
  readonly loaded: readonly string[];
  /** Non-fatal problems: unreadable entries, corrupt images, a .pcx with no palette mounted. */
  readonly errors: readonly string[];
}

/** MAX_QPATH: R_SetSky's Com_sprintf keeps at most 63 characters of the path. */
const MAX_QPATH = 64;

/**
 * R_SetSky's images for `name`: per side env/<name><suffix>.tga, else .pcx. The engine
 * tries only one of the two (.pcx with the paletted texture extension, else .tga) and
 * draws r_notexture without it; trying both is this client's choice. A corrupt .tga is
 * reported and the .pcx tried. A path cut short by MAX_QPATH loads by whatever its cut
 * end is, as GL_FindImage picks the loader from the last four characters: if that is
 * not .tga or .pcx (or the cut path is under five characters), nothing loads.
 */
export async function loadSkyImages(fs: GameFs, name: string): Promise<SkyImages> {
  const errors: string[] = [];
  const loaded: string[] = [];
  let palette: Promise<Uint8Array | undefined> | undefined;
  const readPalette = async () => {
    try {
      const pcx = await fs.read(PALETTE_PATH);
      return pcx && pcxPalette(pcx);
    } catch (e) {
      errors.push(`${PALETTE_PATH}: ${errorMessage(e)}`);
      return undefined;
    }
  };
  const load = async (path: string): Promise<TextureImage | undefined> => {
    const ext = path.length < 5 ? "" : path.slice(-4);
    if (ext !== ".tga" && ext !== ".pcx") return undefined;
    let bytes;
    try {
      bytes = await fs.read(path);
      if (!bytes) return undefined;
      let img: TextureImage;
      if (ext === ".tga") {
        img = decodeTga(bytes);
      } else {
        const pcx = decodePcx(bytes);
        const pal = await (palette ??= readPalette());
        if (!pal) {
          errors.push(`${path}: no palette (${PALETTE_PATH}) to map it through`);
          return undefined;
        }
        img = pcxToRgba(pcx, pal);
      }
      loaded.push(path);
      return uploadImage(img);
    } catch (e) {
      errors.push(`${path}: ${errorMessage(e)}`);
      return undefined;
    }
  };
  const images = await Promise.all(
    SKY_SUFFIXES.map(async (suffix) => {
      const base = `env/${name}${suffix}`;
      const tga = `${base}.tga`.slice(0, MAX_QPATH - 1);
      const pcx = `${base}.pcx`.slice(0, MAX_QPATH - 1);
      return (await load(tga)) ?? (pcx === tga ? undefined : await load(pcx));
    }),
  );
  loaded.sort();
  errors.sort();
  return { images, loaded, errors };
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
