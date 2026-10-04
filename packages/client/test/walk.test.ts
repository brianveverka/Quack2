// SPDX-License-Identifier: GPL-2.0-or-later
// The world walk (walkWorld) against R_SetupFrame's view clusters, R_MarkLeaves,
// R_SetFrustum, R_CullBox and R_RecursiveWorldNode written as the C does, and
// WorldDraws' per-frame index rebuild.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTENTS_SOLID, CONTENTS_WATER, SURF_SKY, SURF_TRANS33, SURF_TRANS66, areaBits, clusterPvs, parseBsp, pointLeaf, type Bsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { closedFlood, withEastArea } from "./areas-fixture.js";
import { frustumPlanes } from "../src/cull.js";
import { buildLightmapAtlas } from "../src/lightmap.js";
import { angleVectors, fovY, multiply, perspective, viewMatrix } from "../src/math.js";
import { WorldDraws, WorldWalk, buildDrawList, buildWorldMesh, eyePlaneSide, renderLeaf, viewClusters, visibleFaceMask, walkWorld, worldVis, type WorldMesh } from "../src/world.js";

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

/** Mod_PointInLeaf as the C writes it: float DotProduct less dist, front only when > 0. */
function modPointInLeaf(bsp: Bsp, p: Vec3): number {
  const f = Math.fround;
  const n = bsp.planes.normal;
  let node = 0;
  for (;;) {
    if (node < 0) return -1 - node;
    const pl = bsp.nodes.planeNum[node]!;
    const d = f(f(f(f(f(p[0]) * n[pl * 3]!) + f(f(p[1]) * n[pl * 3 + 1]!)) + f(f(p[2]) * n[pl * 3 + 2]!)) - bsp.planes.dist[pl]!);
    node = bsp.nodes.children[node * 2 + (d > 0 ? 0 : 1)]!;
  }
}

/** R_SetupFrame's r_viewcluster and r_viewcluster2. */
function setupFrame(bsp: Bsp, origin: Vec3): [number, number] {
  let leaf = modPointInLeaf(bsp, origin);
  const viewcluster = bsp.leafs.cluster[leaf]!;
  let viewcluster2 = viewcluster;
  const temp: [number, number, number] = [origin[0], origin[1], Math.fround(origin[2])];
  if (!bsp.leafs.contents[leaf]) temp[2] = Math.fround(temp[2] - 16); // look down a bit
  else temp[2] = Math.fround(temp[2] + 16); // look up a bit
  leaf = modPointInLeaf(bsp, temp);
  if (!(bsp.leafs.contents[leaf]! & CONTENTS_SOLID) && bsp.leafs.cluster[leaf] !== viewcluster2) viewcluster2 = bsp.leafs.cluster[leaf]!;
  return [viewcluster, viewcluster2];
}

/** R_MarkLeaves, then R_RecursiveWorldNode from node 0 as the C writes them, recursive. */
function reference(bsp: Bsp, view: View | undefined, eye: Vec3, cluster: number, bits?: Uint8Array, cluster2 = cluster): number[] {
  const { nodes, leafs } = bsp;
  const nodeVis = new Uint8Array(nodes.count);
  const leafVis = new Uint8Array(leafs.count);
  if (cluster < 0) {
    nodeVis.fill(1);
    leafVis.fill(1);
  } else {
    const parent = new Map<number, number>(); // child (node n, or leaf as -1 - l) -> parent node
    for (let n = 0; n < nodes.count; n++) for (let s = 0; s < 2; s++) parent.set(nodes.children[n * 2 + s]!, n);
    let pvs = clusterPvs(bsp, cluster);
    // may have to combine two clusters because of solid water boundaries
    if (cluster2 !== cluster) {
      const fatvis = Uint8Array.from(pvs);
      // Mod_ClusterPVS(-1) is mod_novis, all set.
      pvs = cluster2 === -1 ? new Uint8Array(fatvis.length).fill(0xff) : clusterPvs(bsp, cluster2);
      for (let i = 0; i < fatvis.length; i++) fatvis[i]! |= pvs[i]!;
      pvs = fatvis;
    }
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
    // float modelorg; axial planes compare one coordinate, others a float DotProduct.
    const p = nodes.planeNum[child]!;
    const n = bsp.planes.normal;
    const type = bsp.planes.type[p]!;
    const f = Math.fround;
    const o = eye.map(f);
    const dot =
      type >= 0 && type < 3
        ? f(o[type]! - bsp.planes.dist[p]!)
        : f(f(f(f(o[0]! * n[p * 3]!) + f(o[1]! * n[p * 3 + 1]!)) + f(o[2]! * n[p * 3 + 2]!)) - bsp.planes.dist[p]!);
    const side = dot >= 0 ? 0 : 1;
    walk(nodes.children[child * 2 + side]!);
    for (let k = 0; k < nodes.numFaces[child]!; k++) {
      const face = nodes.firstFace[child]! + k;
      if (marked.has(face) && (bsp.faces.side[face] ? 1 : 0) === side) out.push(face);
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

  it("passes the same faces from one WorldWalk reused across views, past its counter wrapping", () => {
    const walker = new WorldWalk(fixture);
    const counter = walker as unknown as { frame: number };
    for (const view of VIEWS) {
      const vis = worldVis(fixture, clusterAt(fixture, view.origin));
      const culled = walkWorld(fixture, mesh, vis, view.origin, sidePlanes(view));
      expect([...walker.walk(mesh, vis, view.origin, sidePlanes(view))]).toEqual(culled);
      expect([...walker.walk(mesh, vis, view.origin)]).toEqual(walkWorld(fixture, mesh, vis, view.origin));
      // Stamp every node and face with frame 1, then wrap the counter back to 1: those
      // stamps must not count as this walk's.
      counter.frame = 0;
      walker.walk(mesh, worldVis(fixture, -1), view.origin);
      counter.frame = 0xffffffff;
      expect([...walker.walk(mesh, vis, view.origin, sidePlanes(view))]).toEqual(culled);
      expect(counter.frame).toBe(1);
    }
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

  it("leaves out faces that are not drawn (no texture)", () => {
    const view: View = { origin: [-448, 0, 46], pitch: 0, yaw: 0, aspect: 4 / 3 };
    const cluster = clusterAt(fixture, view.origin);
    const expected = reference(fixture, view, view.origin, cluster);
    const dropped = expected.slice(0, 3);
    const faceTexture = Int32Array.from(mesh.faceTexture);
    for (const f of dropped) faceTexture[f] = -1;
    const faces = walkWorld(fixture, { ...mesh, faceTexture }, worldVis(fixture, cluster), view.origin, sidePlanes(view));
    expect(faces).toEqual(expected.filter((f) => !dropped.includes(f)));
  });

  it("a node tree that loops does not hang the walk", () => {
    const children = Int32Array.from(fixture.nodes.children);
    children[2] = 0; // node 1's front child points back at the root
    const looped = { ...fixture, nodes: { ...fixture.nodes, children } };
    expect(() => walkWorld(looped, mesh, worldVis(looped, -1), [0, 0, 64])).not.toThrow();
    expect(() => worldVis(looped, 0)).not.toThrow();
  });
});

/** The fixture with the leafs at `points` given `contents`. */
function withContents(bsp: Bsp, contents: number, ...points: Vec3[]): Bsp {
  const c = Int32Array.from(bsp.leafs.contents);
  for (const p of points) c[renderLeaf(bsp, p)] = contents;
  return { ...bsp, leafs: { ...bsp.leafs, contents: c } };
}

describe("viewClusters", () => {
  // The fixture's leafs split at z 128 here: cluster 3 above, 6 below.
  const above: Vec3 = [-496, -16, 136];
  const below: Vec3 = [-496, -16, 120];

  it("matches R_SetupFrame over the map, plane ties and water leafs included", () => {
    const water = withContents(fixture, CONTENTS_WATER, below, [304, -16, 120], [0, 0, 64]);
    let differ = 0;
    for (const bsp of [fixture, water]) {
      for (let x = -544; x <= 544; x += 16) {
        for (let y = -288; y <= 288; y += 32) {
          for (let z = -32; z <= 288; z += 8) {
            const v = viewClusters(bsp, [x, y, z]);
            expect([v.cluster, v.cluster2]).toEqual(setupFrame(bsp, [x, y, z]));
            expect(v.leaf).toBe(modPointInLeaf(bsp, [x, y, z]));
            if (v.cluster2 !== v.cluster) differ++;
          }
        }
      }
    }
    expect(differ).toBeGreaterThan(0);
  });

  it("looks 16 units down from an empty leaf and up from any other", () => {
    expect(viewClusters(fixture, above)).toMatchObject({ cluster: 3, cluster2: 6 });
    // Empty, so it looks down and stays in cluster 6.
    expect(viewClusters(fixture, below)).toMatchObject({ cluster: 6, cluster2: 6 });
    expect(viewClusters(withContents(fixture, CONTENTS_WATER, below), below)).toMatchObject({ cluster: 6, cluster2: 3 });
    // Water above looks up, out of the cluster below.
    expect(viewClusters(withContents(fixture, CONTENTS_WATER, above), above)).toMatchObject({ cluster: 3, cluster2: 3 });
  });

  it("ignores a solid leaf", () => {
    expect(viewClusters(withContents(fixture, CONTENTS_SOLID | CONTENTS_WATER, below), above)).toMatchObject({ cluster: 3, cluster2: 3 });
  });

  it("puts a point on a plane in the back leaf, as Mod_PointInLeaf does", () => {
    const on: Vec3 = [-496, -16, 128];
    expect(renderLeaf(fixture, on)).toBe(renderLeaf(fixture, below));
    expect(pointLeaf(fixture, on[0], on[1], on[2])).toBe(renderLeaf(fixture, above));
    // In float, 128 + 1e-6 is on the plane.
    expect(renderLeaf(fixture, [-496, -16, 128 + 1e-6])).toBe(renderLeaf(fixture, below));
    expect(renderLeaf(fixture, [-496, -16, 128 + 2e-5])).toBe(renderLeaf(fixture, above));
  });

  it("walks from node 0, as Mod_PointInLeaf starts at model->nodes", () => {
    // A head node whose subtree puts the point in another leaf.
    const head = [...Array(fixture.nodes.count).keys()].find((n) => pointLeaf(fixture, above[0], above[1], above[2], n) !== renderLeaf(fixture, above))!;
    expect(head).toBeGreaterThan(0);
    const moved = { ...fixture, models: { ...fixture.models, headNode: Int32Array.from(fixture.models.headNode, () => head) } };
    expect(renderLeaf(moved, above)).toBe(renderLeaf(fixture, above));
  });

  it("marks both clusters' PVS for R_RecursiveWorldNode, as R_MarkLeaves ORs the rows", () => {
    // Clusters 4, 5 and 6 of the fixture do not see each other.
    const one = worldVis(fixture, 6);
    const both = worldVis(fixture, 6, undefined, 4);
    const four = worldVis(fixture, 4);
    for (let l = 0; l < fixture.leafs.count; l++) expect(both.leafs[l]).toBe(one.leafs[l]! | four.leafs[l]!);
    expect(both.leafs.reduce((a, m) => a + m, 0)).toBeGreaterThan(one.leafs.reduce((a, m) => a + m, 0));
    for (const view of VIEWS) {
      for (const [c, c2] of [[6, 4], [4, 6], [3, 6], [6, -1], [-1, 6]] as const) {
        const faces = walkWorld(fixture, mesh, worldVis(fixture, c, undefined, c2), view.origin, sidePlanes(view));
        expect(faces).toEqual(reference(fixture, view, view.origin, c, undefined, c2));
      }
    }
    const split = withEastArea(fixture);
    const bits = areaBits(closedFlood(split), 1);
    const eye: Vec3 = [-256, -128, 128];
    expect(walkWorld(split, mesh, worldVis(split, 3, bits, 4), eye)).toEqual(reference(split, undefined, eye, 3, bits, 4));
  });

  it("a second cluster of -1 sees every leaf with a cluster, as mod_novis does", () => {
    const vis = worldVis(fixture, 6, undefined, -1);
    for (let l = 0; l < fixture.leafs.count; l++) {
      expect(vis.leafs[l]).toBe(fixture.leafs.cluster[l]! >= 0 && fixture.leafs.contents[l] !== CONTENTS_SOLID ? 1 : 0);
    }
  });

  it("visibleFaceMask counts both clusters' faces", () => {
    const both = visibleFaceMask(fixture, mesh, 6, undefined, 4);
    const one = visibleFaceMask(fixture, mesh, 6);
    const four = visibleFaceMask(fixture, mesh, 4);
    expect(Array.from(both)).toEqual(Array.from(one, (m, f) => m | four[f]!));
    expect(both.reduce((a, m) => a + m, 0)).toBeGreaterThan(one.reduce((a, m) => a + m, 0));
    expect(visibleFaceMask(fixture, mesh, 6, undefined, -1).reduce((a, m) => a + m, 0)).toBe(WORLD_FACES);
  });
});

describe("WorldDraws", () => {
  const opaqueList = (m: WorldMesh, faces: readonly number[]) => {
    const mask = new Uint8Array(m.faceTexture.length);
    for (const f of faces) mask[f] = 1;
    return buildDrawList(m, mask);
  };

  /** The opaque faces (what `update` reports changes in), as a comparable string. */
  const opaqueKey = (faces: readonly number[]) =>
    faces
      .filter((f) => !(mesh.faceFlags[f]! & (SURF_SKY | SURF_TRANS33 | SURF_TRANS66)))
      .sort((a, b) => a - b)
      .join();

  it("draws the walked faces as buildDrawList groups them, rebuilding only on change", () => {
    const draws = new WorldDraws(mesh);
    let changes = 0;
    let last: number[] = [];
    for (const view of VIEWS) {
      const faces = walkWorld(fixture, mesh, worldVis(fixture, clusterAt(fixture, view.origin)), view.origin, sidePlanes(view));
      const changed = draws.update(faces);
      const same = opaqueKey(faces) === opaqueKey(last);
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

  it("rebuilds nothing when only sky or translucent faces change", () => {
    const faceFlags = Uint8Array.from(mesh.faceFlags);
    faceFlags[0] = SURF_SKY;
    faceFlags[1] = SURF_TRANS33;
    faceFlags[2] = SURF_TRANS66;
    const draws = new WorldDraws({ ...mesh, faceFlags });
    const rest = [...Array(WORLD_FACES).keys()].slice(3);
    expect(draws.update([0, 1, 2, ...rest])).toBe(true);
    expect([draws.sky, draws.alpha]).toEqual([[0], [2, 1]]);
    const indices = Array.from(draws.indices.subarray(0, draws.indexCount));
    expect(draws.update(rest)).toBe(false);
    expect([draws.sky, draws.alpha]).toEqual([[], []]);
    expect(draws.update([1, ...rest])).toBe(false);
    expect(draws.alpha).toEqual([1]);
    expect(Array.from(draws.indices.subarray(0, draws.indexCount))).toEqual(indices);
    expect(draws.update(rest.slice(1))).toBe(true);
  });

  it("the first update reports a change even with no faces", () => {
    expect(new WorldDraws(mesh).update([])).toBe(true);
  });
});
