// SPDX-License-Identifier: GPL-2.0-or-later
// Sky, warp and translucent surfaces. The fixture has none, so faces are given copies of
// their texinfo with the flags set.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SURF_FLOWING, SURF_SKY, SURF_TRANS33, SURF_TRANS66, SURF_WARP, parseBsp, type Bsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { buildLightmapAtlas, lightmapUv } from "../src/lightmap.js";
import { subdivideWarpPolygon } from "../src/warp.js";
import {
  VERTEX_FLOATS,
  brushModelAlphaOrder,
  buildDrawList,
  buildOrderedDraws,
  buildWorldMesh,
  modelFaceMask,
  visibleFaceMask,
  worldAlphaOrder,
} from "../src/world.js";

const fixture = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const WORLD_FACES = 105;

/** The fixture with each face in `flags` given its own copy of its texinfo, with those flags. */
function flagged(flags: Record<number, number>, bsp: Bsp = fixture): Bsp {
  const faces = Object.keys(flags).map(Number);
  const t = bsp.texinfo;
  const n = t.count + faces.length;
  const vecs = new Float32Array(n * 8);
  vecs.set(t.vecs);
  const flagArr = new Int32Array(n);
  flagArr.set(t.flags);
  const value = new Int32Array(n);
  value.set(t.value);
  const nextTexinfo = new Int32Array(n).fill(-1);
  nextTexinfo.set(t.nextTexinfo);
  const texture = [...t.texture];
  const faceTexinfo = Int16Array.from(bsp.faces.texinfo);
  faces.forEach((f, k) => {
    const src = bsp.faces.texinfo[f]!;
    const dst = t.count + k;
    vecs.set(t.vecs.subarray(src * 8, src * 8 + 8), dst * 8);
    flagArr[dst] = flags[f]!;
    value[dst] = t.value[src]!;
    texture.push(t.texture[src]!);
    faceTexinfo[f] = dst;
  });
  return {
    ...bsp,
    texinfo: { ...t, count: n, vecs, flags: flagArr, value, nextTexinfo, texture },
    faces: { ...bsp.faces, texinfo: faceTexinfo },
  };
}

describe("unlit surfaces", () => {
  it("sky, warp and translucent faces get no lightmap, as Mod_LoadFaces skips them", () => {
    const bsp = flagged({ 0: SURF_SKY, 1: SURF_WARP, 2: SURF_TRANS33, 3: SURF_TRANS66, 4: SURF_FLOWING });
    const atlas = buildLightmapAtlas(bsp);
    expect([0, 1, 2, 3].every((f) => fixture.faces.lightOfs[f] !== -1)).toBe(true);
    expect([0, 1, 2, 3, 4].map((f) => atlas.rects[f]!.lit)).toEqual([false, false, false, false, true]);
    // They sample the fullbright block.
    expect(lightmapUv(atlas, 2, 0, 0)).toEqual(lightmapUv(atlas, 2, 1000, -1000));
  });
});

describe("warped faces", () => {
  const f = [...Array(WORLD_FACES).keys()].find((i) => fixture.texinfo.texture[fixture.faces.texinfo[i]!] === "quack/floor")!;
  const bsp = flagged({ [f]: SURF_WARP | SURF_FLOWING });
  const atlas = buildLightmapAtlas(bsp);
  const mesh = buildWorldMesh(bsp, atlas);

  it("are cut into GL_SubdivideSurface's fans, with untransformed s, t", () => {
    const ti = bsp.faces.texinfo[f]!;
    const v = bsp.texinfo.vecs;
    // The face's corners in edge order, as GL_SubdivideSurface reads them.
    const points: number[] = [];
    for (let i = 0; i < bsp.faces.numEdges[f]!; i++) {
      const e = bsp.surfEdges[bsp.faces.firstEdge[f]! + i]!;
      const vert = e >= 0 ? bsp.edges[e * 2]! : bsp.edges[-e * 2 + 1]!;
      points.push(...bsp.vertexes.position.subarray(vert * 3, vert * 3 + 3));
    }
    const polys = subdivideWarpPolygon(points, v.subarray(ti * 8, ti * 8 + 3), v.subarray(ti * 8 + 4, ti * 8 + 7));
    expect(polys.length).toBeGreaterThan(1);
    expect(mesh.faceNumPolys[f]).toBe(polys.length);
    expect(mesh.faceFlags[f]).toBe(SURF_WARP | SURF_FLOWING);
    const [lu, lv] = lightmapUv(atlas, f, 0, 0);
    polys.forEach((poly, k) => {
      const p = mesh.faceFirstPoly[f]! + k;
      expect(mesh.polyNumVertices[p]).toBe(poly.st.length / 2);
      for (let i = 0; i < poly.st.length / 2; i++) {
        const o = (mesh.polyFirstVertex[p]! + i) * VERTEX_FLOATS;
        expect(Array.from(mesh.vertices.subarray(o, o + VERTEX_FLOATS))).toEqual([
          ...poly.position.subarray(i * 3, i * 3 + 3),
          ...poly.st.subarray(i * 2, i * 2 + 2),
          Math.fround(lu),
          Math.fround(lv),
        ]);
      }
    });
    const total = polys.reduce((a, p) => a + p.st.length / 2, 0);
    expect(mesh.faceNumVertices[f]).toBe(total);
  });

  it("draw apart from the same texture unwarped, every fan triangulated", () => {
    const mask = visibleFaceMask(bsp, mesh, -1);
    const list = buildDrawList(mesh, mask);
    const floor = mesh.textures.indexOf("quack/floor");
    const warp = list.draws.filter((d) => d.texture === floor && d.flags === (SURF_WARP | SURF_FLOWING));
    expect(warp).toHaveLength(1);
    let tris = 0;
    for (let p = mesh.faceFirstPoly[f]!; p < mesh.faceFirstPoly[f]! + mesh.faceNumPolys[f]!; p++) tris += mesh.polyNumVertices[p]! - 2;
    expect(warp[0]!.count).toBe(tris * 3);
    expect(list.draws.some((d) => d.texture === floor && d.flags === 0)).toBe(true);
    expect(list.translucent).toEqual([]);
  });
});

describe("translucent faces", () => {
  const trans: Record<number, number> = {};
  for (let f = 0; f < fixture.faces.count; f++) trans[f] = f % 2 ? SURF_TRANS66 : SURF_TRANS33;
  const bsp = flagged(trans);
  const mesh = buildWorldMesh(bsp, buildLightmapAtlas(bsp));

  it("are left out of the opaque draws and listed for the alpha pass", () => {
    const list = buildDrawList(mesh, visibleFaceMask(bsp, mesh, -1));
    expect(list.draws).toEqual([]);
    expect(list.indices.length).toBe(0);
    expect(list.translucent).toEqual([...Array(WORLD_FACES).keys()]);
    expect(list.visibleFaces).toBe(WORLD_FACES);
    const brush = buildDrawList(mesh, modelFaceMask(bsp, 1));
    expect(brush.translucent).toEqual([105, 106, 107, 108, 109, 110]);
    expect(brushModelAlphaOrder(brush.translucent)).toEqual([110, 109, 108, 107, 106, 105]);
  });

  it("draw in the order given, one draw per run of the same texture and flags", () => {
    const faces = [0, 2, 4, 1];
    const { indices, draws } = buildOrderedDraws(mesh, faces);
    let o = 0;
    const expected: number[] = [];
    for (const f of faces) {
      const v0 = mesh.faceFirstVertex[f]!;
      for (let i = 2; i < mesh.faceNumVertices[f]!; i++) expected.push(v0, v0 + i - 1, v0 + i);
    }
    expect(Array.from(indices)).toEqual(expected);
    for (const d of draws) {
      expect(d.first).toBe(o);
      o += d.count;
    }
    expect(o).toBe(indices.length);
    // Runs merge only while texture and flags match.
    for (let k = 1; k < draws.length; k++) {
      expect([draws[k]!.texture, draws[k]!.flags]).not.toEqual([draws[k - 1]!.texture, draws[k - 1]!.flags]);
    }
  });

  /** R_RecursiveWorldNode as the C writes it: recursive, prepending to the alpha chain. */
  function reference(b: Bsp, want: Set<number>, eye: readonly number[]): number[] {
    let chain: number[] = [];
    const walk = (node: number) => {
      if (node < 0) return;
      const p = b.nodes.planeNum[node]!;
      const n = b.planes.normal;
      const type = b.planes.type[p]!;
      // float modelorg; axial planes compare one coordinate, others a float DotProduct.
      const o = eye.map((x) => Math.fround(x));
      const f = Math.fround;
      const dot =
        type >= 0 && type < 3
          ? f(o[type]! - b.planes.dist[p]!)
          : f(f(f(f(o[0]! * n[p * 3]!) + f(o[1]! * n[p * 3 + 1]!)) + f(o[2]! * n[p * 3 + 2]!)) - b.planes.dist[p]!);
      const side = dot >= 0 ? 0 : 1;
      walk(b.nodes.children[node * 2 + side]!);
      for (let k = 0; k < b.nodes.numFaces[node]!; k++) {
        const f = b.nodes.firstFace[node]! + k;
        if (!want.has(f) || (b.faces.side[f] ? 1 : 0) !== side) continue;
        chain = [f, ...chain];
      }
      walk(b.nodes.children[node * 2 + 1 - side]!);
    };
    walk(0); // r_worldmodel->nodes
    return chain;
  }

  it("world faces come in R_RecursiveWorldNode's alpha chain order, facing the eye only", () => {
    const all = [...Array(WORLD_FACES).keys()];
    for (const eye of [
      [0, 0, 64],
      [-200, 150, 30],
      [300, -100, 100],
      [-352, 160, 24],
    ] as const) {
      const order = worldAlphaOrder(bsp, all, eye);
      expect(order).toEqual(reference(bsp, new Set(all), eye));
      expect(order.length).toBeGreaterThan(0);
      expect(order.length).toBeLessThan(WORLD_FACES);
      // Every listed face has the eye on its front side.
      for (const f of order) {
        const p = bsp.faces.planeNum[f]!;
        const n = bsp.planes.normal;
        const d = eye[0] * n[p * 3]! + eye[1] * n[p * 3 + 1]! + eye[2] * n[p * 3 + 2]! - bsp.planes.dist[p]!;
        expect(bsp.faces.side[f] ? d < 0 : d >= 0).toBe(true);
      }
    }
    // Only the faces asked for.
    expect(worldAlphaOrder(bsp, [3, 7], [0, 0, 64]).every((f) => f === 3 || f === 7)).toBe(true);
    expect(worldAlphaOrder(bsp, [], [0, 0, 64])).toEqual([]);
  });

  it("a node tree that loops does not hang the walk", () => {
    const children = Int32Array.from(bsp.nodes.children);
    children[2] = 0; // node 1's front child points back at the root
    const looped = { ...bsp, nodes: { ...bsp.nodes, children } };
    expect(() => worldAlphaOrder(looped, [...Array(WORLD_FACES).keys()], [0, 0, 64])).not.toThrow();
  });
});
