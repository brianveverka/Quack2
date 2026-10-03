// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import {
  CONTENTS_SOLID,
  checkBspIntegrity,
  clusterPvs,
  faceLightmapBytes,
  faceStyleCount,
  faceVertexIndices,
  lightmapExtents,
  parseBsp,
  pointLeaf,
  texCoord,
  type Bsp,
} from "../src/index.js";
import { loadFixtureBytes } from "./fixture.js";

const bytes = loadFixtureBytes("test_arena.bsp");
const bsp = parseBsp(bytes);

describe("face polygons", () => {
  it("every corner lies on the face plane and the winding is closed", () => {
    for (let f = 0; f < bsp.faces.count; f++) {
      const idx = faceVertexIndices(bsp, f);
      expect(idx).toHaveLength(bsp.faces.numEdges[f]!);
      const p = bsp.faces.planeNum[f]!;
      const n = bsp.planes.normal;
      for (const v of idx) {
        const pos = bsp.vertexes.position;
        const d = pos[v * 3]! * n[p * 3]! + pos[v * 3 + 1]! * n[p * 3 + 1]! + pos[v * 3 + 2]! * n[p * 3 + 2]! - bsp.planes.dist[p]!;
        expect(Math.abs(d)).toBeLessThan(0.01);
      }
      // Each edge ends where the next begins.
      const first = bsp.faces.firstEdge[f]!;
      for (let i = 0; i < idx.length; i++) {
        const e = bsp.surfEdges[first + i]!;
        const end = e >= 0 ? bsp.edges[e * 2 + 1]! : bsp.edges[-e * 2]!;
        expect(end).toBe(idx[(i + 1) % idx.length]);
      }
    }
  });

  it("texCoord applies texinfo vecs as s = dot(p, s.xyz) + s.w", () => {
    // The fixture uses world-aligned projection with scale 1, so s and t are world axes.
    const ti = bsp.faces.texinfo[0]!;
    const [s, t] = texCoord(bsp, ti, 10, 20, 30);
    const v = bsp.texinfo.vecs.subarray(ti * 8, ti * 8 + 8);
    expect(s).toBeCloseTo(10 * v[0]! + 20 * v[1]! + 30 * v[2]! + v[3]!);
    expect(t).toBeCloseTo(10 * v[4]! + 20 * v[5]! + 30 * v[6]! + v[7]!);
  });
});

describe("lightmap extents", () => {
  it("lit faces tile the lighting lump exactly, in lightOfs order", () => {
    // ericw-tools light writes lightmaps back to back, rounding each allocation up to a
    // multiple of 4 luxels (measured on this fixture: 90 of 111 faces are padded). If the
    // extent math disagreed with the compiler by a row or column, the offsets would drift.
    const padded = (f: number) => {
      const { width, height } = lightmapExtents(bsp, f);
      return Math.ceil((width * height) / 4) * 4 * 3 * faceStyleCount(bsp, f);
    };
    const lit = [...Array(bsp.faces.count).keys()].filter((f) => bsp.faces.lightOfs[f] !== -1);
    expect(lit.length).toBeGreaterThan(0);
    lit.sort((a, b) => bsp.faces.lightOfs[a]! - bsp.faces.lightOfs[b]!);
    let end = 0;
    for (const f of lit) {
      expect({ face: f, ofs: bsp.faces.lightOfs[f] }).toEqual({ face: f, ofs: end });
      expect(faceLightmapBytes(bsp, f)).toBeLessThanOrEqual(padded(f));
      end += padded(f);
    }
    expect(end).toBe(bsp.lighting.length);
  });

  it("snaps to 16-unit luxels with a sample on each boundary", () => {
    for (let f = 0; f < bsp.faces.count; f++) {
      const e = lightmapExtents(bsp, f);
      expect(e.textureMinS % 16 === 0 && e.textureMinT % 16 === 0).toBe(true);
      expect(e.width).toBeGreaterThanOrEqual(2);
      expect(e.height).toBeGreaterThanOrEqual(2);
      expect(faceStyleCount(bsp, f)).toBe(bsp.faces.lightOfs[f] === -1 ? 0 : 1);
    }
  });

  it("rounds the low bound down and the high bound up on both axes", () => {
    // The fixture's texinfo puts every face bound on a multiple of 16 in t, which cannot
    // tell floor from ceil there. Offset face 2's texinfo so none of its bounds is.
    // Corners (s, t) are (232, -256), (232, -32), (224, -32); with s + 3, t + 5 the bounds
    // are s 227..235 and t -251..-27, so luxels span s 14..15 and t -16..-1.
    const shifted = parseBsp(bytes);
    const ti = shifted.faces.texinfo[2]!;
    expect(lightmapExtents(shifted, 2)).toEqual({ textureMinS: 224, textureMinT: -256, width: 2, height: 15 });
    shifted.texinfo.vecs[ti * 8 + 3] = shifted.texinfo.vecs[ti * 8 + 3]! + 3;
    shifted.texinfo.vecs[ti * 8 + 7] = shifted.texinfo.vecs[ti * 8 + 7]! + 5;
    expect(lightmapExtents(shifted, 2)).toEqual({ textureMinS: 224, textureMinT: -256, width: 2, height: 16 });
  });

  it("integrity check flags a lightmap that runs past the lighting lump", () => {
    const broken = parseBsp(bytes);
    const f = bsp.faces.lightOfs.findIndex((o) => o !== -1);
    (broken.faces.lightOfs as Int32Array)[f] = broken.lighting.length - 3;
    const { width, height } = lightmapExtents(broken, f);
    expect(checkBspIntegrity(broken)).toEqual([
      `face ${f} lightmap ${width}x${height} (${width * height * 3} bytes) at ${broken.lighting.length - 3} overruns lighting lump of ${broken.lighting.length}`,
    ]);
  });
});

describe("point leaf and PVS", () => {
  const leafAt = (x: number, y: number, z: number) => pointLeaf(bsp, x, y, z);

  it("spawn points are in empty leafs with a cluster; a pillar interior is solid", () => {
    for (const [x, y, z] of [[-448, 0, 24], [-448, -192, 24], [448, 192, 24], [0, 0, 16]] as const) {
      const leaf = leafAt(x, y, z);
      expect(bsp.leafs.contents[leaf]).toBe(0);
      expect(bsp.leafs.cluster[leaf]).toBeGreaterThanOrEqual(0);
    }
    // Inside the pillar brush at x -288..-224, y -32..32, z 0..128.
    const solid = leafAt(-256, 0, 64);
    expect(bsp.leafs.contents[solid]! & CONTENTS_SOLID).toBe(CONTENTS_SOLID);
    expect(bsp.leafs.cluster[solid]).toBe(-1);
  });

  it("every cluster sees itself, and visibility is symmetric", () => {
    const n = bsp.visibility.numClusters;
    const rows = [...Array(n).keys()].map((c) => clusterPvs(bsp, c));
    const sees = (a: number, b: number) => (rows[a]![b >> 3]! & (1 << (b & 7))) !== 0;
    for (let a = 0; a < n; a++) {
      expect(sees(a, a)).toBe(true);
      for (let b = 0; b < n; b++) expect(sees(a, b)).toBe(sees(b, a));
    }
  });

  it("cluster -1 sees nothing; a map without vis has an empty row", () => {
    expect(Array.from(clusterPvs(bsp, -1))).toEqual([0, 0]);
    const novis: Bsp = { ...bsp, visibility: { numClusters: 0, offsets: new Int32Array(0), data: new Uint8Array(0) } };
    expect(Array.from(clusterPvs(novis, 0))).toEqual([]);
  });

  it("decodes zero runs and clamps a run that overflows the row", () => {
    // 20 clusters -> 3-byte rows. Cluster 0: 0x05, then a run of 2 zero bytes.
    // Cluster 1: a run of 9 zero bytes, clamped to the row.
    const data = new Uint8Array([20, 0, 0, 0, ...new Array(20 * 8).fill(0), 0x05, 0x00, 0x02, 0x00, 0x09]);
    const offsets = new Int32Array(40);
    offsets[0] = 164;
    offsets[2] = 167;
    const synthetic: Bsp = { ...bsp, visibility: { numClusters: 20, offsets, data } };
    expect(Array.from(clusterPvs(synthetic, 0))).toEqual([0x05, 0, 0]);
    expect(Array.from(clusterPvs(synthetic, 1))).toEqual([0, 0, 0]);
  });
});
