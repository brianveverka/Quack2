// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { FlyCamera } from "../src/camera.js";
import { buildLightmapAtlas, lightmapUv, type LightmapAtlas } from "../src/lightmap.js";
import { fovY, multiply, perspective, transformPoint, viewMatrix } from "../src/math.js";
import { CHECKER_SIZE, checkerTexture, resolveTextures } from "../src/textures.js";
import { VERTEX_FLOATS, buildDrawList, buildWorldMesh, modelFaceMask, modelFaces, visibleFaceMask } from "../src/world.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const atlas = buildLightmapAtlas(bsp);
const mesh = buildWorldMesh(bsp, atlas);
const WORLD_FACES = 105; // model 0 of the fixture; faces 105..110 are the func_wall
const ALL_FACES = 111;

describe("world mesh", () => {
  it("covers every model, one vertex per face corner, three textures", () => {
    expect(bsp.faces.count).toBe(ALL_FACES);
    expect(mesh.firstFace).toBe(0);
    expect(mesh.numFaces).toBe(WORLD_FACES);
    let corners = 0;
    for (let f = 0; f < ALL_FACES; f++) corners += bsp.faces.numEdges[f]!;
    expect(mesh.vertices.length).toBe(corners * VERTEX_FLOATS);
    expect([...mesh.textures].sort()).toEqual(["quack/floor", "quack/trim", "quack/wall"]);
    // The func_wall (model 1) is all trim, through the same texture list as the world.
    const trim = mesh.textures.indexOf("quack/trim");
    expect(Array.from(mesh.faceTexture.subarray(WORLD_FACES))).toEqual(Array(6).fill(trim));
  });

  it("keeps brush model vertices in model space (the func_wall's compiled box)", () => {
    const xs = [], ys = [], zs = [];
    for (let f = WORLD_FACES; f < ALL_FACES; f++) {
      for (let i = 0; i < mesh.faceNumVertices[f]!; i++) {
        const o = (mesh.faceFirstVertex[f]! + i) * VERTEX_FLOATS;
        xs.push(mesh.vertices[o]!), ys.push(mesh.vertices[o + 1]!), zs.push(mesh.vertices[o + 2]!);
      }
    }
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)]).toEqual([
      -384, -320, 128, 192, 0, 48,
    ]);
  });

  it("emits each face once when model face ranges overlap", () => {
    const firstFace = Int32Array.from(bsp.models.firstFace);
    const numFaces = Int32Array.from(bsp.models.numFaces);
    // Model 1 also claims the last world face, and runs past the face lump.
    firstFace[1] = WORLD_FACES - 1;
    numFaces[1] = 100;
    const bad = { ...bsp, models: { ...bsp.models, firstFace, numFaces } };
    const m = buildWorldMesh(bad, atlas);
    expect(m.vertices.length).toBe(mesh.vertices.length);
    // The shared face belongs to the world, so the brush model does not draw it again.
    expect(modelFaceMask(bad, 1).reduce((a, v) => a + v, 0)).toBe(ALL_FACES - WORLD_FACES);
    expect(modelFaceMask(bad, 1)[WORLD_FACES - 1]).toBe(0);
  });

  it("trims a model face range that starts before the face lump", () => {
    const firstFace = Int32Array.from(bsp.models.firstFace);
    const numFaces = Int32Array.from(bsp.models.numFaces);
    firstFace[1] = -5;
    numFaces[1] = 10;
    const bad = { ...bsp, models: { ...bsp.models, firstFace, numFaces } };
    expect(modelFaces(bad, 1)).toEqual({ first: 0, end: 5 });
    firstFace[1] = -50;
    expect(modelFaces(bad, 1)).toEqual({ first: 0, end: 0 });
  });

  it("winds every triangle clockwise seen from the face's front (gl.frontFace(CW))", () => {
    const v = mesh.vertices;
    const at = (i: number) => [v[i * VERTEX_FLOATS]!, v[i * VERTEX_FLOATS + 1]!, v[i * VERTEX_FLOATS + 2]!];
    for (let f = 0; f < ALL_FACES; f++) {
      const p = bsp.faces.planeNum[f]!;
      const sign = bsp.faces.side[f] ? -1 : 1;
      const n = [0, 1, 2].map((k) => bsp.planes.normal[p * 3 + k]! * sign);
      const v0 = mesh.faceFirstVertex[f]!;
      for (let i = 2; i < mesh.faceNumVertices[f]!; i++) {
        const a = at(v0), b = at(v0 + i - 1), c = at(v0 + i);
        const e1 = [0, 1, 2].map((k) => b[k]! - a[k]!), e2 = [0, 1, 2].map((k) => c[k]! - a[k]!);
        const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        // Counter-clockwise around n would give cross . n > 0.
        expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeLessThan(0);
      }
    }
  });

  it("texture coordinates are the texinfo projection in texels", () => {
    // Floor texinfo is s = x, t = -y.
    const f = [...Array(WORLD_FACES).keys()].find((i) => mesh.textures[mesh.faceTexture[i]!] === "quack/floor")!;
    const o = mesh.faceFirstVertex[f]! * VERTEX_FLOATS;
    const [x, y, , s, t] = mesh.vertices.subarray(o, o + 5);
    expect([s, t]).toEqual([x, -y! + 0]);
  });
});

describe("lightmap atlas", () => {
  it("packs every lit face without overlap, inside the atlas, clear of the fullbright block", () => {
    const rects = atlas.rects.filter((r) => r.lit);
    expect(rects).toHaveLength(bsp.faces.count);
    const owner = new Int32Array(atlas.width * atlas.height).fill(-1);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) owner[y * atlas.width + x] = -2;
    rects.forEach((r, i) => {
      expect(r.x + r.width).toBeLessThanOrEqual(atlas.width);
      expect(r.y + r.height).toBeLessThanOrEqual(atlas.height);
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          expect(owner[y * atlas.width + x]).toBe(-1);
          owner[y * atlas.width + x] = i;
        }
      }
    });
  });

  it("puts luxel i's centre at s = textureMinS + 16 i, so corners stay inside their rect", () => {
    // Luxel i is sampled at texture-space textureMin + 16 i; a texel centre is at +0.5 in
    // atlas space. Corners then span [0.5, size - 0.5] luxels and bilinear filtering never
    // reads a neighbouring face's luxels.
    for (let f = 0; f < ALL_FACES; f++) {
      const r = atlas.rects[f]!;
      const o = mesh.faceFirstVertex[f]! * VERTEX_FLOATS;
      for (let i = 0; i < mesh.faceNumVertices[f]!; i++) {
        const [s, t, u, v] = mesh.vertices.subarray(o + i * VERTEX_FLOATS + 3, o + i * VERTEX_FLOATS + 7);
        const lx = u! * atlas.width - r.x, ly = v! * atlas.height - r.y;
        expect(r.textureMinS + 16 * (lx - 0.5)).toBeCloseTo(s!, 3);
        expect(r.textureMinT + 16 * (ly - 0.5)).toBeCloseTo(t!, 3);
        expect(lx).toBeGreaterThanOrEqual(0.5);
        expect(lx).toBeLessThanOrEqual(r.width - 0.5);
        expect(ly).toBeGreaterThanOrEqual(0.5);
        expect(ly).toBeLessThanOrEqual(r.height - 0.5);
      }
    }
  });

  it("copies each face's luxels row by row from lightOfs", () => {
    for (let f = 0; f < bsp.faces.count; f++) {
      const r = atlas.rects[f]!;
      const last = r.width * r.height - 1;
      for (const [i, x, y] of [[0, 0, 0], [last, r.width - 1, r.height - 1], [r.width, 0, 1]] as const) {
        const src = bsp.faces.lightOfs[f]! + i * 3;
        const dst = ((r.y + y) * atlas.width + r.x + x) * 4;
        expect(Array.from(atlas.data.subarray(dst, dst + 4))).toEqual([...bsp.lighting.subarray(src, src + 3), 255]);
      }
    }
  });

  it("maps a floor point to the luxel that lit it: the pillar's shadow lands around the pillar", () => {
    // Light at (-256 0 200) sits 72 units above the pillar spanning x -288..-224, y -32..32,
    // z 0..128, so the floor just around the pillar is in shadow and the ring beyond it is
    // lit. Points are on luxel centres (multiples of 16) so nearest-luxel lookup is exact.
    const shadowed = [[-304, 0], [-256, -48], [-256, 48], [-208, 0]];
    const lit = [[-352, 0], [-256, -112], [-256, 112], [-160, 0]];
    const b = (x: number, y: number) => floorBrightness(atlas, x, y);
    const darkest = Math.max(...shadowed.map(([x, y]) => b(x!, y!)));
    const brightest = Math.min(...lit.map(([x, y]) => b(x!, y!)));
    expect(darkest * 3).toBeLessThan(brightest);
    // The arena is mirror-symmetric in y, so its lighting is too; a flipped or transposed
    // lookup breaks this (measured: flipping t within each face's rect gives differences of 20+).
    for (const x of [-448, -352, -160]) {
      // One 8-bit step of tolerance: measured 8 of 9 pairs equal, one differing by 3.
      for (const y of [48, 112, 192]) expect(Math.abs(b(x, y) - b(x, -y))).toBeLessThanOrEqual(3);
    }
  });
});

/** Nearest-luxel brightness (R+G+B) of the floor at (x, y, 0), via the mesh's own UV path. */
function floorBrightness(a: LightmapAtlas, x: number, y: number): number {
  for (let f = 0; f < WORLD_FACES; f++) {
    if (mesh.textures[mesh.faceTexture[f]!] !== "quack/floor" || bsp.planes.normal[bsp.faces.planeNum[f]! * 3 + 2] !== 1) continue;
    const o = mesh.faceFirstVertex[f]! * VERTEX_FLOATS;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < mesh.faceNumVertices[f]!; i++) {
      xs.push(mesh.vertices[o + i * VERTEX_FLOATS]!);
      ys.push(mesh.vertices[o + i * VERTEX_FLOATS + 1]!);
    }
    // Floor faces in the fixture are axis-aligned rectangles.
    if (x < Math.min(...xs) || x > Math.max(...xs) || y < Math.min(...ys) || y > Math.max(...ys)) continue;
    const [u, v] = lightmapUv(a, f, x, -y);
    const px = Math.floor(u * a.width), py = Math.floor(v * a.height);
    const i = (py * a.width + px) * 4;
    return a.data[i]! + a.data[i + 1]! + a.data[i + 2]!;
  }
  throw new Error(`no floor face at ${x} ${y}`);
}

describe("PVS face selection", () => {
  it("cluster -1 draws every world face", () => {
    const mask = visibleFaceMask(bsp, mesh, -1);
    expect(mask.reduce((a, m) => a + m, 0)).toBe(WORLD_FACES);
    expect(buildDrawList(mesh, mask).visibleFaces).toBe(WORLD_FACES);
  });

  it("a map without vis data draws every world face from any cluster", () => {
    const novis = { ...bsp, visibility: { numClusters: 0, offsets: new Int32Array(0), data: new Uint8Array(0) } };
    expect(visibleFaceMask(novis, mesh, 3).reduce((a, m) => a + m, 0)).toBe(WORLD_FACES);
  });

  it("a cluster past the vis data draws every world face", () => {
    expect(visibleFaceMask(bsp, mesh, bsp.visibility.numClusters).reduce((a, m) => a + m, 0)).toBe(WORLD_FACES);
  });

  it("the player start's cluster culls faces, and never selects brush-model faces", () => {
    // Measured on the fixture: cluster 6 does not see clusters 4 and 5.
    const mask = visibleFaceMask(bsp, mesh, 6);
    expect(Array.from(mask.subarray(WORLD_FACES))).toEqual([0, 0, 0, 0, 0, 0]);
    const list = buildDrawList(mesh, mask);
    expect(list.visibleFaces).toBe(95);
    let tris = 0;
    for (let f = 0; f < WORLD_FACES; f++) if (mask[f]) tris += mesh.faceNumVertices[f]! - 2;
    expect(list.indices.length).toBe(tris * 3);
    // One contiguous range per texture, in order.
    let next = 0;
    for (const d of list.draws) {
      expect(d.first).toBe(next);
      next += d.count;
    }
    expect(next).toBe(list.indices.length);
  });

  it("a brush model's mask selects its own faces only", () => {
    const mask = modelFaceMask(bsp, 1);
    expect(Array.from(mask.subarray(0, WORLD_FACES)).every((m) => m === 0)).toBe(true);
    const list = buildDrawList(mesh, mask);
    expect(list.visibleFaces).toBe(6);
    // Six quads, one texture.
    expect(list.draws).toEqual([{ texture: mesh.textures.indexOf("quack/trim"), first: 0, count: 6 * 2 * 3 }]);
  });
});

describe("camera and view math", () => {
  const proj = perspective(fovY(90, 4 / 3), 4 / 3, 4, 16384);
  const ndc = (m: Float32Array, p: [number, number, number]) => {
    const [x, y, , w] = transformPoint(m, ...p);
    return [x / w, y / w, w] as const;
  };

  it("yaw 0 looks down +X with +Y on the left and +Z up (no mirroring)", () => {
    const m = multiply(proj, viewMatrix([0, 0, 0], 0, 0));
    const ahead = ndc(m, [100, 0, 0]);
    expect(ahead[0]).toBeCloseTo(0);
    expect(ahead[1]).toBeCloseTo(0);
    expect(ahead[2]).toBeGreaterThan(0);
    expect(ndc(m, [100, 50, 0])[0]).toBeLessThan(0);
    expect(ndc(m, [100, 0, 50])[1]).toBeGreaterThan(0);
    // 90 degree horizontal fov: a point 45 degrees right is on the right screen edge.
    expect(ndc(m, [100, -100, 0])[0]).toBeCloseTo(1);
  });

  it("positive pitch looks down; yaw 90 looks down +Y", () => {
    expect(ndc(multiply(proj, viewMatrix([0, 0, 0], 30, 0)), [100, 0, -57.735])[1]).toBeCloseTo(0);
    expect(ndc(multiply(proj, viewMatrix([0, 0, 0], 0, 90)), [0, 100, 0])[0]).toBeCloseTo(0);
  });

  it("FlyCamera moves along the view direction and clamps pitch", () => {
    const cam = new FlyCamera([0, 0, 0], 0, 90);
    cam.move({ forward: 1, right: 0, up: 0, fast: false }, 0.5);
    expect(cam.origin.map((v) => Math.round(v))).toEqual([0, 160, 0]);
    cam.move({ forward: 0, right: 1, up: 1, fast: false }, 0.5);
    expect(cam.origin.map((v) => Math.round(v))).toEqual([160, 160, 160]);
    cam.look(200, -100);
    expect([cam.pitch, cam.yaw]).toEqual([89, 350]);
  });
});

describe("placeholder textures", () => {
  it("are deterministic two-tone checkers, tinted per name", () => {
    const a = checkerTexture("quack/wall");
    expect(a.width).toBe(CHECKER_SIZE);
    expect(a.data).toEqual(checkerTexture("quack/wall").data);
    const tones = new Set<number>();
    for (let i = 0; i < a.data.length; i += 4) tones.add((a.data[i]! << 16) | (a.data[i + 1]! << 8) | a.data[i + 2]!);
    expect(tones.size).toBe(2);
    expect(checkerTexture("quack/floor").data).not.toEqual(a.data);
  });

  it("only fill in for names the source cannot supply", () => {
    const real = { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) };
    const { images, missing } = resolveTextures(["a", "b"], (n) => (n === "a" ? real : undefined));
    expect(images[0]).toBe(real);
    expect(images[1]!.width).toBe(CHECKER_SIZE);
    expect(missing).toEqual(["b"]);
  });
});
