// SPDX-License-Identifier: GPL-2.0-or-later
// The world walk (walkWorld) against R_MarkLeaves, R_SetFrustum, R_CullBox and
// R_RecursiveWorldNode written as the C does, and WorldDraws' per-frame index rebuild.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTENTS_SOLID, areaBits, clusterPvs, parseBsp, pointLeaf, type Bsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { closedFlood, withEastArea } from "./areas-fixture.js";
import { frustumPlanes } from "../src/cull.js";
import { buildLightmapAtlas } from "../src/lightmap.js";
import { angleVectors, fovY, multiply, perspective, viewMatrix } from "../src/math.js";
import { WorldDraws, buildDrawList, buildWorldMesh, eyePlaneSide, visibleFaceMask, walkWorld, worldVis, type WorldMesh } from "../src/world.js";

const fixture = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const mesh = buildWorldMesh(fixture, buildLightmapAtlas(fixture));
const WORLD_FACES = 105;

type Vec3 = readonly [number, number, number];
interface View {
  readonly origin: Vec3;
  readonly pitch: number;
  readonly yaw: number;
  readonly aspect: number;
}

/** RotatePointAroundVector: `point` turned `degrees` about unit `dir`, right-handed. */
function rotate(dir: Vec3, point: Vec3, degrees: number): Vec3 {
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const d = dir[0] * point[0] + dir[1] * point[1] + dir[2] * point[2];
  const cross = [dir[1] * point[2] - dir[2] * point[1], dir[2] * point[0] - dir[0] * point[2], dir[0] * point[1] - dir[1] * point[0]];
  return [0, 1, 2].map((k) => point[k]! * c + cross[k]! * s + dir[k]! * d * (1 - c)) as unknown as Vec3;
}

/** R_SetFrustum for fov_x 90 and fov_y from CalcFov, as normal and dist. */
function engineFrustum(view: View): { normal: Vec3; dist: number }[] {
  const { forward, right, up } = angleVectors(view.pitch, view.yaw);
  const fovX = 90;
  // CalcFov(fov_x, width, height) with height 1.
  const x = view.aspect / Math.tan((fovX / 360) * Math.PI);
  const fovYDeg = (Math.atan(1 / x) * 360) / Math.PI;
  const normals = [
    rotate(up, forward, -(90 - fovX / 2)),
    rotate(up, forward, 90 - fovX / 2),
    rotate(right, forward, 90 - fovYDeg / 2),
    rotate(right, forward, -(90 - fovYDeg / 2)),
  ];
  return normals.map((normal) => ({ normal, dist: normal[0] * view.origin[0] + normal[1] * view.origin[1] + normal[2] * view.origin[2] }));
}

/** R_CullBox: BOX_ON_PLANE_SIDE returns 2 for one of the four planes. */
function cullBox(frustum: { normal: Vec3; dist: number }[], mins: Float32Array, maxs: Float32Array, o: number): boolean {
  return frustum.some(({ normal: n, dist }) => {
    let dist1 = 0;
    for (let k = 0; k < 3; k++) dist1 += n[k]! * (n[k]! >= 0 ? maxs[o + k]! : mins[o + k]!);
    return dist1 < dist;
  });
}

/** R_MarkLeaves, then R_RecursiveWorldNode from node 0 as the C writes them, recursive. */
function reference(bsp: Bsp, view: View | undefined, eye: Vec3, cluster: number, bits?: Uint8Array): number[] {
  const { nodes, leafs } = bsp;
  const nodeVis = new Uint8Array(nodes.count);
  const leafVis = new Uint8Array(leafs.count);
  if (cluster < 0) {
    nodeVis.fill(1);
    leafVis.fill(1);
  } else {
    const parent = new Map<number, number>(); // child (node n, or leaf as -1 - l) -> parent node
    for (let n = 0; n < nodes.count; n++) for (let s = 0; s < 2; s++) parent.set(nodes.children[n * 2 + s]!, n);
    const pvs = clusterPvs(bsp, cluster);
    for (let l = 0; l < leafs.count; l++) {
      const c = leafs.cluster[l]!;
      if (c === -1 || !(pvs[c >> 3]! & (1 << (c & 7)))) continue;
      leafVis[l] = 1;
      let node = parent.get(-1 - l);
      while (node !== undefined && !nodeVis[node]) {
        nodeVis[node] = 1;
        node = parent.get(node);
      }
    }
  }
  const frustum = view && engineFrustum(view);
  const marked = new Set<number>();
  const out: number[] = [];
  const walk = (child: number): void => {
    if (child < 0) {
      const l = -1 - child;
      if (leafs.contents[l] === CONTENTS_SOLID || !leafVis[l]) return;
      if (frustum && cullBox(frustum, leafs.mins, leafs.maxs, l * 3)) return;
      const a = leafs.area[l]!;
      if (bits && !(bits[a >> 3]! & (1 << (a & 7)))) return;
      for (let k = 0; k < leafs.numLeafFaces[l]!; k++) marked.add(bsp.leafFaces[leafs.firstLeafFace[l]! + k]!);
      return;
    }
    if (!nodeVis[child]) return;
    if (frustum && cullBox(frustum, nodes.mins, nodes.maxs, child * 3)) return;
    const side = eyePlaneSide(bsp, nodes.planeNum[child]!, eye);
    walk(nodes.children[child * 2 + side]!);
    for (let k = 0; k < nodes.numFaces[child]!; k++) {
      const f = nodes.firstFace[child]! + k;
      if (marked.has(f) && (bsp.faces.side[f] ? 1 : 0) === side) out.push(f);
    }
    walk(nodes.children[child * 2 + 1 - side]!);
  };
  walk(0);
  return out;
}

/** The four side planes of the renderer's frustum, as render() builds them. */
function sidePlanes(view: View): number[][] {
  const proj = perspective(fovY(90, view.aspect), view.aspect, 4, 16384);
  return frustumPlanes(multiply(proj, viewMatrix(view.origin, view.pitch, view.yaw))).slice(0, 4);
}

const VIEWS: View[] = [];
for (const origin of [
  [-448, 0, 46],
  [300, -150, 46],
  [-256, -128, 128],
  [0, 0, 64],
  [1200, 0, 400],
] as const) {
  for (const [pitch, yaw] of [
    [0, 0],
    [0, 90],
    [20, 180],
    [-30, 270],
    [10, 45],
    [-89, 0],
  ] as const) {
    VIEWS.push({ origin, pitch, yaw, aspect: 4 / 3 }, { origin, pitch, yaw, aspect: 16 / 9 });
  }
}

const clusterAt = (bsp: Bsp, o: Vec3) => bsp.leafs.cluster[pointLeaf(bsp, o[0], o[1], o[2])]!;

describe("walkWorld", () => {
  it("passes R_RecursiveWorldNode's faces in its order, with R_CullBox on nodes and leafs", () => {
    let culledSome = 0;
    for (const view of VIEWS) {
      const cluster = clusterAt(fixture, view.origin);
      const vis = worldVis(fixture, cluster);
      const faces = walkWorld(fixture, mesh, vis, view.origin, sidePlanes(view));
      expect(faces).toEqual(reference(fixture, view, view.origin, cluster));
      const unculled = walkWorld(fixture, mesh, vis, view.origin);
      expect(unculled).toEqual(reference(fixture, undefined, view.origin, cluster));
      expect(faces.every((f) => unculled.includes(f))).toBe(true);
      if (faces.length < unculled.length) culledSome++;
    }
    // Most views look away from some of the world.
    expect(culledSome).toBeGreaterThan(VIEWS.length / 2);
  });

  it("passes only PVS faces facing the eye", () => {
    for (const view of VIEWS) {
      const cluster = clusterAt(fixture, view.origin);
      const pvs = visibleFaceMask(fixture, mesh, cluster);
      for (const f of walkWorld(fixture, mesh, worldVis(fixture, cluster), view.origin)) {
        expect(pvs[f]).toBe(1);
        expect(eyePlaneSide(fixture, fixture.faces.planeNum[f]!, view.origin)).toBe(fixture.faces.side[f] ? 1 : 0);
      }
    }
  });

  it("skips leafs behind a closed area portal, as R_RecursiveWorldNode tests areabits", () => {
    const split = withEastArea(fixture);
    const view: View = { origin: [-256, -128, 128], pitch: 0, yaw: 0, aspect: 4 / 3 };
    const cluster = clusterAt(split, view.origin);
    const bits = areaBits(closedFlood(split), 1);
    const faces = walkWorld(split, mesh, worldVis(split, cluster, bits), view.origin, sidePlanes(view));
    expect(faces).toEqual(reference(split, view, view.origin, cluster, bits));
    expect(faces.length).toBeLessThan(walkWorld(split, mesh, worldVis(split, cluster), view.origin, sidePlanes(view)).length);
    // Without vis (cluster -1) the area test still holds.
    const novis = walkWorld(split, mesh, worldVis(split, -1, bits), view.origin);
    expect(novis).toEqual(reference(split, undefined, view.origin, -1, bits));
  });

  it("a view straight at a wall passes few faces", () => {
    const view: View = { origin: [-448, 0, 46], pitch: 0, yaw: 180, aspect: 4 / 3 };
    const cluster = clusterAt(fixture, view.origin);
    const vis = worldVis(fixture, cluster);
    const faces = walkWorld(fixture, mesh, vis, view.origin, sidePlanes(view));
    expect(faces.length).toBeLessThan(walkWorld(fixture, mesh, vis, view.origin).length / 2);
  });

  it("a node tree that loops does not hang the walk", () => {
    const children = Int32Array.from(fixture.nodes.children);
    children[2] = 0; // node 1's front child points back at the root
    const looped = { ...fixture, nodes: { ...fixture.nodes, children } };
    expect(() => walkWorld(looped, mesh, worldVis(looped, -1), [0, 0, 64])).not.toThrow();
    expect(() => worldVis(looped, 0)).not.toThrow();
  });
});

describe("WorldDraws", () => {
  const opaqueList = (m: WorldMesh, faces: readonly number[]) => {
    const mask = new Uint8Array(m.faceTexture.length);
    for (const f of faces) mask[f] = 1;
    return buildDrawList(m, mask);
  };

  it("draws the walked faces as buildDrawList groups them, rebuilding only on change", () => {
    const draws = new WorldDraws(mesh);
    let changes = 0;
    let last: number[] = [];
    for (const view of VIEWS) {
      const faces = walkWorld(fixture, mesh, worldVis(fixture, clusterAt(fixture, view.origin)), view.origin, sidePlanes(view));
      const changed = draws.update(faces);
      const same = faces.length === last.length && [...faces].sort().join() === [...last].sort().join();
      expect(changed).toBe(!same);
      if (changed) changes++;
      last = faces;
      const list = opaqueList(mesh, faces);
      expect(Array.from(draws.indices.subarray(0, draws.indexCount))).toEqual(Array.from(list.indices));
      expect(draws.draws).toEqual(list.draws);
      expect(draws.update(faces)).toBe(false);
    }
    expect(changes).toBeGreaterThan(5);
    // Every face, then none.
    expect(draws.update([...Array(WORLD_FACES).keys()])).toBe(true);
    expect(draws.indexCount).toBe(draws.indices.length);
    expect(draws.update([])).toBe(true);
    expect(draws.indexCount).toBe(0);
    expect(draws.draws).toEqual([]);
    expect(draws.update([])).toBe(false);
  });
});
