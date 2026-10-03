// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import {
  CONTENTS_SOLID,
  boxLeafs,
  boxOnPlaneSide,
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

describe("box against planes and leafs", () => {
  /** The fixture with plane 0 replaced, for cases the all-axial fixture lacks. */
  const withPlane0 = (normal: [number, number, number], dist: number, type: number): Bsp => {
    const planes = { ...bsp.planes, normal: bsp.planes.normal.slice(), dist: bsp.planes.dist.slice(), type: bsp.planes.type.slice() };
    planes.normal.set(normal, 0);
    planes.dist[0] = dist;
    planes.type[0] = type;
    return { ...bsp, planes };
  };

  it("axial planes compare one axis; touching from in front is in front, from behind is behind", () => {
    // Plane 2 is x = -512 (normal +X, type 0).
    expect([...bsp.planes.normal.subarray(6, 9), bsp.planes.dist[2], bsp.planes.type[2]]).toEqual([1, 0, 0, -512, 0]);
    expect(boxOnPlaneSide(bsp, 2, [-512, 0, 0], [-400, 1, 1])).toBe(1);
    expect(boxOnPlaneSide(bsp, 2, [-600, 0, 0], [-512, 1, 1])).toBe(2);
    expect(boxOnPlaneSide(bsp, 2, [-600, 0, 0], [-500, 1, 1])).toBe(3);
  });

  it("other planes test the nearest and farthest corners, with the same touching rule", () => {
    // Normal components exact in float32 (not unit length: the test does not need it), so
    // the touching cases land exactly on the plane.
    const tilted = withPlane0([0.5, 0.5, 0], 10, 3);
    expect(boxOnPlaneSide(tilted, 0, [0, 0, 0], [5, 5, 5])).toBe(2); // farthest corner 5
    expect(boxOnPlaneSide(tilted, 0, [0, 0, 0], [10, 10, 0])).toBe(3); // farthest corner touches: 10
    expect(boxOnPlaneSide(tilted, 0, [10, 10, 0], [20, 20, 0])).toBe(1); // nearest corner touches: 10
    expect(boxOnPlaneSide(tilted, 0, [0, 0, 0], [9.5, 10, 0])).toBe(2); // farthest corner 9.75
    // A negative normal component takes the other corner.
    const flipped = withPlane0([-0.5, 0.5, 0], 10, 3);
    expect(boxOnPlaneSide(flipped, 0, [-20, 10, 0], [-10, 20, 0])).toBe(1); // nearest (-10, 10) touches
    expect(boxOnPlaneSide(flipped, 0, [-10, 0, 0], [0, 10, 0])).toBe(3); // farthest (-10, 10) touches
    expect(boxOnPlaneSide(flipped, 0, [0, 0, 0], [10, 10, 0])).toBe(2); // farthest (0, 10): 5
  });

  it("a box inside one empty leaf lists only it, with no top node", () => {
    // The player start, in cluster 6 (x -512..-288, y -32..32, z 0..128).
    const { leafs, topNode } = boxLeafs(bsp, [-456, -8, 38], [-440, 8, 54], 64);
    expect(leafs).toEqual([pointLeaf(bsp, -448, 0, 46)]);
    expect(topNode).toBe(-1);
  });

  it("a box over the whole map lists every world leaf once; a full list keeps the same top node", () => {
    const all = boxLeafs(bsp, [-1024, -1024, -1024], [1024, 1024, 1024], 1024);
    // The world's leafs are those reachable from model 0's head node; the func_wall's own tree has the rest.
    const reachable = new Set<number>();
    const stack = [bsp.models.headNode[0]!];
    while (stack.length) {
      const n = stack.pop()!;
      if (n < 0) reachable.add(-(n + 1));
      else stack.push(bsp.nodes.children[n * 2]!, bsp.nodes.children[n * 2 + 1]!);
    }
    expect([...all.leafs].sort((a, b) => a - b)).toEqual([...reachable].sort((a, b) => a - b));
    expect(all.topNode).toBe(bsp.models.headNode[0]);
    const three = boxLeafs(bsp, [-1024, -1024, -1024], [1024, 1024, 1024], 3);
    expect(three.leafs).toEqual(all.leafs.slice(0, 3));
    expect(three.topNode).toBe(all.topNode);
  });

  it("stops at a child index past the node lump instead of looping", () => {
    const children = bsp.nodes.children.slice();
    children[1] = bsp.nodes.count + 5;
    const broken: Bsp = { ...bsp, nodes: { ...bsp.nodes, children } };
    const { leafs } = boxLeafs(broken, [-1024, -1024, -1024], [1024, 1024, 1024], 1024);
    expect(leafs.length).toBeGreaterThan(0);
    expect(leafs.length).toBeLessThan(boxLeafs(bsp, [-1024, -1024, -1024], [1024, 1024, 1024], 1024).leafs.length);
  });

  it("a box straddling the pillar's side lists the empty leaf and the pillar's solid leaf", () => {
    const { leafs } = boxLeafs(bsp, [-296, -8, 38], [-280, 8, 54], 64);
    expect(leafs.map((l) => bsp.leafs.cluster[l]).sort()).toEqual([-1, 6]);
  });
});
