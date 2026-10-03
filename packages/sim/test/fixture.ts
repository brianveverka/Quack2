// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mapsDir = fileURLToPath(new URL("../../../fixtures/maps/", import.meta.url));

export function loadFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(mapsDir + name));
}

export function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(mapsDir + name, "utf8")) as Record<string, unknown>;
}
