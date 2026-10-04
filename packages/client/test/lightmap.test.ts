// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEATHMATCH_LIGHTSTYLES, MAX_LIGHTMAPS, MAX_LIGHTSTYLES, lightStyleValues, parseBsp, type Bsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { buildLightmapAtlas, updateLightmapAtlas, type LightmapAtlas } from "../src/lightmap.js";

const fixture = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const FACE = 0;

/**
 * The fixture with FACE given `styles` and one map per style appended to the lighting
 * lump, every luxel of map k set to `maps[k]`. The fixture's own faces are all style 0.
 */
function styledFixture(styles: readonly number[], maps: readonly (readonly [number, number, number])[]): Bsp {
  const atlas = buildLightmapAtlas(fixture);
  const { width, height } = atlas.rects[FACE]!;
  const size = width * height;
  const lighting = new Uint8Array(fixture.lighting.length + maps.length * size * 3);
  lighting.set(fixture.lighting);
  maps.forEach((rgb, k) => {
    for (let i = 0; i < size; i++) lighting.set(rgb, fixture.lighting.length + (k * size + i) * 3);
  });
  const faceStyles = Uint8Array.from(fixture.faces.styles);
  faceStyles.fill(255, FACE * MAX_LIGHTMAPS, (FACE + 1) * MAX_LIGHTMAPS);
  faceStyles.set(styles, FACE * MAX_LIGHTMAPS);
  const lightOfs = Int32Array.from(fixture.faces.lightOfs);
  lightOfs[FACE] = fixture.lighting.length;
  return { ...fixture, lighting, faces: { ...fixture.faces, styles: faceStyles, lightOfs } };
}

/** Every luxel of `face` in the atlas, as RGBA. */
function luxels(atlas: LightmapAtlas, face: number): number[][] {
  const r = atlas.rects[face]!;
  const out: number[][] = [];
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = ((r.y + y) * atlas.width + r.x + x) * 4;
      out.push(Array.from(atlas.data.subarray(i, i + 4)));
    }
  }
  return out;
}

/** Style values with every style normal (1) except the ones given. */
function styleValues(set: Record<number, number>): Float32Array {
  const v = new Float32Array(MAX_LIGHTSTYLES).fill(1);
  for (const [s, x] of Object.entries(set)) v[Number(s)] = x;
  return v;
}

const allEqual = (atlas: LightmapAtlas, rgb: readonly number[]) => {
  for (const l of luxels(atlas, FACE)) expect(l).toEqual([...rgb, 255]);
};

describe("lightmap style composition", () => {
  it("sums each map scaled by its style's value, truncating as Q_ftol's C fallback does", () => {
    const bsp = styledFixture([0, 2], [[40, 50, 60], [100, 90, 13]]);
    allEqual(buildLightmapAtlas(bsp, 4096, styleValues({ 2: 0 })), [40, 50, 60]);
    // 'b' is 1/12 as a float: 100/12 = 8.33, 90/12 = 7.5, 13/12 = 1.08, each truncated.
    allEqual(buildLightmapAtlas(bsp, 4096, styleValues({ 2: Math.fround(1 / 12) })), [48, 57, 61]);
    allEqual(buildLightmapAtlas(bsp, 4096, styleValues({})), [140, 140, 73]);
  });

  it("accumulates in float: 1 b + 1 x is float 2.0, though 1.99999996 in double", () => {
    const v = styleValues({ 1: Math.fround(1 / 12), 2: Math.fround(23 / 12) });
    allEqual(buildLightmapAtlas(styledFixture([1, 2], [[1, 1, 1], [1, 1, 1]]), 4096, v), [2, 2, 2]);
  });

  it("scales all channels by the brightest when it passes 255, in float", () => {
    // 200 + 200 = 400; t = float(255 / 400) = 0.63749999; 400 t rounds to float 255.0,
    // 100 t = 63.75 -> 63, 60 t = 38.25 -> 38.
    allEqual(buildLightmapAtlas(styledFixture([0, 1], [[200, 100, 50], [200, 0, 10]])), [255, 63, 38]);
    // 'z' (25/12 as a float) doubles past 255 on one map alone: 200 z = 416.67 -> 416, 30 z -> 62.
    const z = styleValues({ 9: Math.fround(25 / 12) });
    allEqual(buildLightmapAtlas(styledFixture([9], [[200, 30, 0]]), 4096, z), [255, 38, 0]);
  });

  it("clamps negative light to 0 and draws a face with light data but no styles black", () => {
    allEqual(buildLightmapAtlas(styledFixture([5], [[90, 0, 30]]), 4096, styleValues({ 5: -1 / 12 })), [0, 0, 0]);
    allEqual(buildLightmapAtlas(styledFixture([], [])), [0, 0, 0]);
  });

  it("leaves every other face as its stored style-0 map", () => {
    const bsp = styledFixture([0, 2], [[40, 50, 60], [100, 90, 13]]);
    const a = buildLightmapAtlas(bsp, 4096, styleValues({ 2: 0 }));
    const plain = buildLightmapAtlas(fixture);
    for (let f = 1; f < fixture.faces.count; f++) expect(luxels(a, f)).toEqual(luxels(plain, f));
  });
});

describe("updateLightmapAtlas", () => {
  it("composes again only the faces using a style whose value changed", () => {
    const bsp = styledFixture([0, 2], [[40, 50, 60], [100, 90, 13]]);
    const atlas = buildLightmapAtlas(bsp, 4096, styleValues({ 2: 0 }));
    expect(updateLightmapAtlas(bsp, atlas, styleValues({ 2: 0 }))).toEqual([]);
    // Style 5 is used by no face.
    expect(updateLightmapAtlas(bsp, atlas, styleValues({ 2: 0, 5: 0 }))).toEqual([]);
    expect(updateLightmapAtlas(bsp, atlas, styleValues({}))).toEqual([FACE]);
    allEqual(atlas, [140, 140, 73]);
    expect(atlas.styleValues[2]).toBe(1);
    // Plain numbers compare as the floats the atlas stores, so 0.1 twice is no change.
    expect(updateLightmapAtlas(bsp, atlas, [1, 1, 0.1])).toEqual([FACE]);
    expect(updateLightmapAtlas(bsp, atlas, [1, 1, 0.1])).toEqual([]);
    updateLightmapAtlas(bsp, atlas, styleValues({}));
    // Style 0 is on every fixture face.
    expect(updateLightmapAtlas(bsp, atlas, styleValues({ 0: 0.5 }))).toHaveLength(fixture.faces.count);
  });

  it("matches a fresh build at the same values, over the deathmatch styles' animation", () => {
    const bsp = styledFixture([0, 1, 9, 11], [[30, 20, 10], [40, 40, 40], [90, 5, 70], [10, 60, 200]]);
    const atlas = buildLightmapAtlas(bsp, 4096, lightStyleValues(DEATHMATCH_LIGHTSTYLES, 0));
    for (const ms of [100, 799, 800, 1700, 3600]) {
      const v = lightStyleValues(DEATHMATCH_LIGHTSTYLES, ms);
      updateLightmapAtlas(bsp, atlas, v);
      expect(luxels(atlas, FACE)).toEqual(luxels(buildLightmapAtlas(bsp, 4096, v), FACE));
    }
  });
});
