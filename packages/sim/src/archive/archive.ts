// SPDX-License-Identifier: GPL-2.0-or-later
// Read-only game data archives (pak, zip/pk3) and the mount stack that layers them.
// Paths are matched case-insensitively with forward slashes, so "Textures\E1U1\Floor.wal"
// finds "textures/e1u1/floor.wal".

export class ArchiveError extends Error {
  override name = "ArchiveError";
}

/**
 * Inflates raw deflate data (no zlib or gzip header). `size` is the expected length; an
 * implementation should stop once output exceeds it, and the zip reader rejects any
 * result whose length differs.
 */
export type InflateRaw = (data: Uint8Array, size: number) => Promise<Uint8Array>;

export interface Archive {
  /** Normalized paths of every file, in directory order. */
  readonly paths: readonly string[];
  has(path: string): boolean;
  /** File contents, or undefined if absent. May share memory with the archive; do not mutate. */
  read(path: string): Promise<Uint8Array | undefined>;
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/(\.\/)+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.?\/)+/, "")
    .toLowerCase();
}

/** Latin-1 decode of a NUL-terminated (or full-length) name field. */
export function readName(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    const c = bytes[offset + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Archives searched newest first, like the engine's search path: pak1 mounted after
 * pak0 overrides it.
 */
export class GameFs {
  private readonly mounts: { name: string; archive: Archive }[] = [];

  /** Names of mounted archives, oldest first. */
  get names(): string[] {
    return this.mounts.map((m) => m.name);
  }

  mount(name: string, archive: Archive): void {
    this.mounts.push({ name, archive });
  }

  has(path: string): boolean {
    return this.source(path) !== undefined;
  }

  /** Name of the archive a read of `path` comes from (the newest that has it), or undefined. */
  source(path: string): string | undefined {
    const p = normalizePath(path);
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      if (this.mounts[i]!.archive.has(p)) return this.mounts[i]!.name;
    }
    return undefined;
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const p = normalizePath(path);
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      const archive = this.mounts[i]!.archive;
      if (archive.has(p)) return archive.read(p);
    }
    return undefined;
  }
}
