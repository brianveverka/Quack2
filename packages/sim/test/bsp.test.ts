// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BspError,
  CONTENTS_SOLID,
  HEADER_SIZE,
  LUMP_AREAPORTALS,
  LUMP_AREAS,
  LUMP_FACES,
  LUMP_PLANES,
  LUMP_POP,
  brushGeometry,
  checkBspIntegrity,
  parseBsp,
  type Bsp,
} from "../src/index.js";
import { loadFixtureBytes, loadGolden } from "./fixture.js";

const bytes = loadFixtureBytes("test_arena.bsp");
const bsp = parseBsp(bytes);

/** Rows of `width` values from a struct-of-arrays view, for comparison with the golden. */
function rows(width: number, count: number, cols: (i: number) => (number | string)[]): (number | string)[][] {
  const out: (number | string)[][] = [];
  for (let i = 0; i < count; i++) {
    // JSON has no -0, and the fixture stores some -0 normal components.
    const r = cols(i).map((v) => (typeof v === "number" ? v + 0 : v));
    expect(r).toHaveLength(width);
    out.push(r);
  }
  return out;
}
const vec = (a: Float32Array | Int32Array | Uint8Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));

describe("test_arena.bsp lump counts", () => {
  // Expected values are ericw-tools bspinfo output for the committed fixture.
  it("matches bspinfo record counts", () => {
    expect(bsp.version).toBe(38);
    expect(bsp.lumps).toHaveLength(19);
    expect({
      models: bsp.models.count,
      planes: bsp.planes.count,
      vertexes: bsp.vertexes.count,
      nodes: bsp.nodes.count,
      texinfo: bsp.texinfo.count,
      faces: bsp.faces.count,
      leafs: bsp.leafs.count,
      leaffaces: bsp.leafFaces.length,
      leafbrushes: bsp.leafBrushes.length,
      edges: bsp.edges.length / 2,
      surfedges: bsp.surfEdges.length,
      brushes: bsp.brushes.count,
      brushsides: bsp.brushSides.count,
      areas: bsp.areas.count,
      areaportals: bsp.areaPortals.count,
    }).toEqual({
      models: 2,
      planes: 41,
      vertexes: 128,
      nodes: 25,
      texinfo: 9,
      faces: 111,
      leafs: 28,
      leaffaces: 117,
      leafbrushes: 11,
      edges: 236,
      surfedges: 470,
      brushes: 11,
      brushsides: 66,
      areas: 2,
      areaportals: 1,
    });
  });

  it("matches bspinfo blob sizes", () => {
    expect(bsp.lighting.length).toBe(32748);
    // The lump ends in a NUL terminator, which the string does not include.
    expect(bsp.lumps[0]!.length).toBe(651);
    expect(bsp.entityString.length).toBe(650);
    expect(bsp.pop.length).toBe(0);
    // bspinfo prints 40 for visdata: the compressed rows only, without the
    // 4 + 10 * 8 byte cluster header that the lump also holds.
    expect(bsp.visibility.numClusters).toBe(10);
    expect(bsp.visibility.data.length).toBe(4 + 10 * 8 + 40);
  });
});

describe("test_arena.bsp against the bspinfo golden dump", () => {
  const g = loadGolden("test_arena.golden.json");
  const b: Bsp = bsp;

  it("entities", () => expect(b.entityString + "\0").toBe(g.entities));
  it("planes", () =>
    expect(rows(5, b.planes.count, (i) => [...vec(b.planes.normal, i, 3), b.planes.dist[i]!, b.planes.type[i]!])).toEqual(g.planes));
  it("vertexes", () => expect(rows(3, b.vertexes.count, (i) => vec(b.vertexes.position, i, 3))).toEqual(g.vertexes));
  it("visibility offsets", () => expect(Array.from(b.visibility.offsets)).toEqual(g.visibility));
  it("nodes", () =>
    expect(
      rows(11, b.nodes.count, (i) => [
        b.nodes.planeNum[i]!, ...vec(b.nodes.children, i, 2), ...vec(b.nodes.mins, i, 3), ...vec(b.nodes.maxs, i, 3),
        b.nodes.firstFace[i]!, b.nodes.numFaces[i]!,
      ]),
    ).toEqual(g.nodes));
  it("texinfo", () =>
    expect(
      rows(12, b.texinfo.count, (i) => [
        ...vec(b.texinfo.vecs, i, 8), b.texinfo.flags[i]!, b.texinfo.value[i]!, b.texinfo.texture[i]!, b.texinfo.nextTexinfo[i]!,
      ]),
    ).toEqual(g.texinfo));
  it("faces", () =>
    expect(
      rows(10, b.faces.count, (i) => [
        b.faces.planeNum[i]!, b.faces.side[i]!, b.faces.firstEdge[i]!, b.faces.numEdges[i]!, b.faces.texinfo[i]!,
        ...vec(b.faces.styles, i, 4), b.faces.lightOfs[i]!,
      ]),
    ).toEqual(g.faces));
  it("leafs", () =>
    expect(
      rows(13, b.leafs.count, (i) => [
        b.leafs.contents[i]!, b.leafs.cluster[i]!, b.leafs.area[i]!, ...vec(b.leafs.mins, i, 3), ...vec(b.leafs.maxs, i, 3),
        b.leafs.firstLeafFace[i]!, b.leafs.numLeafFaces[i]!, b.leafs.firstLeafBrush[i]!, b.leafs.numLeafBrushes[i]!,
      ]),
    ).toEqual(g.leafs));
  it("leaffaces", () => expect(Array.from(b.leafFaces)).toEqual(g.leaffaces));
  it("leafbrushes", () => expect(Array.from(b.leafBrushes)).toEqual(g.leafbrushes));
  it("edges", () => expect(rows(2, b.edges.length / 2, (i) => [b.edges[i * 2]!, b.edges[i * 2 + 1]!])).toEqual(g.edges));
  it("surfedges", () => expect(Array.from(b.surfEdges)).toEqual(g.surfedges));
  it("models", () =>
    expect(
      rows(12, b.models.count, (i) => [
        ...vec(b.models.mins, i, 3), ...vec(b.models.maxs, i, 3), ...vec(b.models.origin, i, 3),
        b.models.headNode[i]!, b.models.firstFace[i]!, b.models.numFaces[i]!,
      ]),
    ).toEqual(g.models));
  it("brushes", () =>
    expect(rows(3, b.brushes.count, (i) => [b.brushes.firstSide[i]!, b.brushes.numSides[i]!, b.brushes.contents[i]!])).toEqual(g.brushes));
  it("brushsides", () =>
    expect(rows(2, b.brushSides.count, (i) => [b.brushSides.planeNum[i]!, b.brushSides.texinfo[i]!])).toEqual(g.brushsides));

  // Lumps bspinfo does not dump usefully: compare against hashes of the raw file bytes.
  const sha = (u8: Uint8Array) => createHash("sha256").update(u8).digest("hex");
  const int32Pairs = (a: Int32Array, c: Int32Array) => {
    const out = new DataView(new ArrayBuffer(a.length * 8));
    a.forEach((v, i) => {
      out.setInt32(i * 8, v, true);
      out.setInt32(i * 8 + 4, c[i]!, true);
    });
    return new Uint8Array(out.buffer);
  };
  it("lighting, visibility and pop bytes", () => {
    const raw = g.rawLumpSha256 as Record<string, string>;
    expect(sha(b.lighting)).toBe(raw.lighting);
    expect(sha(b.visibility.data)).toBe(raw.visibility);
    expect(sha(b.pop)).toBe(raw.pop);
  });
  it("areas and areaportals, re-serialized in file field order", () => {
    const raw = g.rawLumpSha256 as Record<string, string>;
    expect(sha(int32Pairs(b.areas.numAreaPortals, b.areas.firstAreaPortal))).toBe(raw.areas);
    expect(sha(int32Pairs(b.areaPortals.portalNum, b.areaPortals.otherArea))).toBe(raw.areaportals);
  });
});

describe("pop lump", () => {
  // The fixture's pop lump is empty, so point it at four appended bytes.
  it("returns the lump bytes", () => {
    const copy = new Uint8Array(bytes.length + 4);
    copy.set(bytes);
    copy.set([1, 2, 3, 4], bytes.length);
    const v = new DataView(copy.buffer);
    v.setInt32(8 + LUMP_POP * 8, bytes.length, true);
    v.setInt32(12 + LUMP_POP * 8, 4, true);
    expect(Array.from(parseBsp(copy).pop)).toEqual([1, 2, 3, 4]);
  });
});

describe("area lump field order", () => {
  // The fixture's area data is nearly all zeros, so write distinct values and read them back.
  it("reads dareaportal_t as portalnum, otherarea and darea_t as numareaportals, firstareaportal", () => {
    const copy = bytes.slice();
    const v = new DataView(copy.buffer);
    const portals = v.getInt32(8 + LUMP_AREAPORTALS * 8, true);
    const areasOfs = v.getInt32(8 + LUMP_AREAS * 8, true);
    v.setInt32(portals, 7, true);
    v.setInt32(portals + 4, 1, true);
    v.setInt32(areasOfs + 8, 1, true);
    v.setInt32(areasOfs + 12, 0, true);
    const p = parseBsp(copy);
    expect([p.areaPortals.portalNum[0], p.areaPortals.otherArea[0]]).toEqual([7, 1]);
    expect([p.areas.numAreaPortals[1], p.areas.firstAreaPortal[1]]).toEqual([1, 0]);
  });
});

describe("test_arena.bsp integrity", () => {
  it("passes every cross-reference and geometry check", () => {
    expect(checkBspIntegrity(bsp)).toEqual([]);
  });

  it("brushes reproduce the boxes in test_arena.map", () => {
    // [mins, maxs] of every brush in fixtures/maps/test_arena.map.
    const mapBoxes = [
      [[-528, -272, -16], [528, 272, 0]],
      [[-528, -272, 256], [528, 272, 272]],
      [[-528, -272, 0], [-512, 272, 256]],
      [[512, -272, 0], [528, 272, 256]],
      [[-512, -272, 0], [512, -256, 256]],
      [[-512, 256, 0], [512, 272, 256]],
      [[-8, -256, 0], [8, -64, 256]],
      [[-8, 64, 0], [8, 256, 256]],
      [[-288, -32, 0], [-224, 32, 128]],
      [[224, -32, 0], [288, 32, 128]],
      [[-384, 128, 0], [-320, 192, 48]], // func_wall
    ];
    const key = (b: unknown) => JSON.stringify(b);
    const fromBsp: string[] = [];
    for (let i = 0; i < bsp.brushes.count; i++) {
      const g = brushGeometry(bsp, i);
      expect(g.vertices).toHaveLength(8);
      expect(bsp.brushes.contents[i]! & CONTENTS_SOLID).toBe(CONTENTS_SOLID);
      fromBsp.push(key([g.mins, g.maxs]));
    }
    expect(fromBsp.sort()).toEqual(mapBoxes.map(key).sort());
  });

  it("flags a brush side whose plane index is out of range", () => {
    const broken = parseBsp(bytes);
    (broken.brushSides.planeNum as Uint16Array)[0] = broken.planes.count;
    expect(checkBspIntegrity(broken)).toContain(`brushside 0 planeNum = ${broken.planes.count}, valid range [0, 41)`);
  });

  it("flags an inverted brush plane", () => {
    const broken = parseBsp(bytes);
    const p = broken.brushSides.planeNum[0]!;
    for (let k = 0; k < 3; k++) broken.planes.normal[p * 3 + k] = -broken.planes.normal[p * 3 + k]!;
    broken.planes.dist[p] = -broken.planes.dist[p]!;
    const errs = checkBspIntegrity(broken);
    // Plane 17 (the floor top) is shared by three brushes; flipping it opens the floor brush downward.
    expect(errs).toContain("brush 0 is unbounded (an inverted or missing side)");
    expect(errs.filter((e) => e.startsWith("brush ")).length).toBe(errs.length);
  });

  it("brushGeometry reports an open brush as unbounded", () => {
    const open = parseBsp(bytes);
    (open.brushes.numSides as Int32Array)[0] = 5; // drop the last side of brush 0
    expect(brushGeometry(open, 0).bounded).toBe(false);
    expect(brushGeometry(bsp, 0).bounded).toBe(true);
  });
});

describe("parseBsp errors", () => {
  const withInt = (at: number, value: number) => {
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(at, value, true);
    return copy;
  };

  it("rejects wrong magic and names what it found", () => {
    const copy = bytes.slice();
    copy.set([0x56, 0x42, 0x53, 0x50], 0); // "VBSP" (Source engine)
    expect(() => parseBsp(copy)).toThrow(BspError);
    expect(() => parseBsp(copy)).toThrow('magic is "VBSP", expected "IBSP"');
  });

  it("identifies the unsupported Qbism extended format", () => {
    const copy = bytes.slice();
    copy.set([0x51, 0x42, 0x53, 0x50], 0); // "QBSP"
    expect(() => parseBsp(copy)).toThrow("Qbism extended format is not supported");
  });

  it("rejects a Quake 1 BSP (version 29, no IBSP magic)", () => {
    const copy = withInt(0, 29);
    expect(() => parseBsp(copy)).toThrow(/magic is "\\x1d\\x00\\x00\\x00"/);
  });

  it("rejects wrong version", () => {
    expect(() => parseBsp(withInt(4, 46))).toThrow("unsupported IBSP version 46, expected 38 (Quake 2)");
  });

  it("rejects a file shorter than the header", () => {
    expect(() => parseBsp(bytes.subarray(0, HEADER_SIZE - 1))).toThrow(/BSP too small/);
  });

  it("rejects a truncated file whose lumps run past the end", () => {
    const end = Math.max(...parseBsp(bytes).lumps.map((l) => l.offset + l.length));
    expect(() => parseBsp(bytes.subarray(0, end - 1))).toThrow(/lump \w+ out of bounds/);
  });

  it("rejects a lump length that is not a whole number of records", () => {
    const at = 8 + LUMP_PLANES * 8 + 4;
    expect(() => parseBsp(withInt(at, 819))).toThrow("lump planes length 819 is not a multiple of record size 20");
  });

  it("rejects a negative lump offset", () => {
    expect(() => parseBsp(withInt(8 + LUMP_FACES * 8, -4))).toThrow(/lump faces out of bounds/);
  });

  it("accepts an ArrayBuffer and an unaligned Uint8Array view", () => {
    expect(parseBsp(bytes.slice().buffer).planes.count).toBe(41);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    expect(parseBsp(shifted.subarray(1)).faces.count).toBe(111);
  });
});
