// SPDX-License-Identifier: GPL-2.0-or-later
export function writePak(files: Record<string, Uint8Array>): Uint8Array;
export function writeZip(
  files: Record<string, Uint8Array>,
  options?: {
    deflate?: boolean | ReadonlySet<string>;
    comment?: string;
    prefix?: Uint8Array;
    adjustOffsets?: boolean;
    zip64?: boolean;
  },
): Uint8Array;
export function writeWal(name: string, width: number, height: number, pixel: (x: number, y: number) => number): Uint8Array;
export function writeTga(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly number[],
  options?: { bits?: 24 | 32; rle?: boolean; topOrigin?: boolean },
): Uint8Array;
export function writePcx(width: number, height: number, pixel: (x: number, y: number) => number): Uint8Array;
export function writePalettePcx(palette: Uint8Array): Uint8Array;
export function syntheticPalette(): Uint8Array;
export function withEntityString(bsp: Uint8Array, entities: string): Uint8Array;
