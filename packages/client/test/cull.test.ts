// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clusterPvs, parseBsp, type Bsp } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import type { BrushModelInstance } from "../src/bmodels.js";
import { cullBox, entityClusters, fatPvs, frustumPlanes, renderBox, touchesPvs, type Plane } from "../src/cull.js";
import { angleVectors, fovY, multiply, perspective, viewMatrix } from "../src/math.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const wall = (origin: [number, number, number], angles: [number, number, number] = [0, 0, 0]): BrushModelInstance => ({
  model: 1,
  origin,
  angles,
  classname: "func_wall",
});
const bits = (row: Uint8Array) => [...Array(row.length * 8).keys()].filter((c) => row[c >> 3]! & (1 << (c & 7)));
/** The player start eye, in cluster 6 (x -512..-288, y -32..32, z 0..128 beside the west pillar). */
const SPAWN_EYE = [-448, 0, 46];
/** East of the east pillar, in cluster 4, which cluster 6 does not see. */
const EAST_EYE = [400, 0, 46];

describe("fixture clusters these tests rely on", () => {
  it("cluster 6 does not see clusters 4 and 5, and cluster 2 sees everything", () => {
    expect(bsp.visibility.numClusters).toBe(10);
    expect(bits(clusterPvs(bsp, 6))).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
    expect(bits(clusterPvs(bsp, 4))).toEqual([0, 1, 2, 3, 4, 7, 8, 9]);
    expect(bits(clusterPvs(bsp, 2))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("entity clusters (SV_LinkEdict)", () => {
  it("the func_wall (x -384..-320, y 128..192, z 0..48) is in cluster 2 only", () => {
    expect(entityClusters(bsp, wall([0, 0, 0]))).toEqual([2]);
  });

  it("an entity buried below the floor touches no cluster", () => {
    expect(entityClusters(bsp, wall([0, 0, -256]))).toEqual([]);
  });

  it("the box grows by the model's one-unit spread and the link's one unit", () => {
    // Moved so its south face is 2 units north of y 32, the cluster 6 / cluster 2 boundary
    // west of the divider: the box reaches it exactly, which is not crossing it.
    expect(entityClusters(bsp, wall([0, -94, 0]))).toEqual([2]);
    // One unit further south it crosses into cluster 6 (and the pillar band's solid).
    expect(entityClusters(bsp, wall([0, -95, 0])).sort()).toEqual([2, 6]);
  });

  it("a rotated entity is linked by origin plus or minus its largest bound", () => {
    // Largest |bound| is 385 (x -384 - 1): the box spans most of the map, every cluster.
    expect(entityClusters(bsp, wall([0, 192, 0], [0, 90, 0])).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Not by the radius (433, the render box's): 400 down, the box tops out at z -14, in
    // the floor brush (z -16..0); the radius would reach the room above.
    expect(entityClusters(bsp, wall([0, 0, -400], [0, 90, 0]))).toEqual([]);
  });

  /**
   * A synthetic tree: node i splits on x = i + 1, its front child is node i + 1 and its
   * back child is leaf i, in cluster i; the last node's front child is leaf n - 1.
   */
  function chainBsp(n: number): Bsp {
    const nodes = n - 1;
    const planes = { count: nodes, normal: new Float32Array(nodes * 3), dist: new Float32Array(nodes), type: new Int32Array(nodes) };
    const children = new Int32Array(nodes * 2);
    for (let i = 0; i < nodes; i++) {
      planes.normal[i * 3] = 1;
      planes.dist[i] = i + 1;
      children[i * 2] = i + 1 < nodes ? i + 1 : -(n - 1) - 1;
      children[i * 2 + 1] = -i - 1;
    }
    const cluster = Int16Array.from({ length: n }, (_, i) => i);
    const models = { ...bsp.models, mins: new Float32Array(6), maxs: new Float32Array(6), headNode: new Int32Array([0, 0]) };
    return {
      ...bsp,
      planes,
      nodes: { ...bsp.nodes, count: nodes, planeNum: Int32Array.from({ length: nodes }, (_, i) => i), children },
      leafs: { ...bsp.leafs, count: n, cluster },
      models,
    };
  }
  /** An instance whose linked box is x0..x1 (model bounds are 0, spread and link add 2 each side). */
  const boxed = (b: Bsp, x0: number, x1: number): number[] => {
    const models = { ...b.models, mins: new Float32Array([0, 0, 0, x0 + 2, 0, 0]), maxs: new Float32Array([0, 0, 0, x1 - 2, 0, 0]) };
    return entityClusters({ ...b, models }, wall([0, 0, 0])).sort((a, c) => a - c);
  };

  it("lists up to 16 clusters; past that, every cluster under the box's top node", () => {
    const b = chainBsp(24);
    // Clusters 2..17 (16 of them): listed as is.
    expect(boxed(b, 2.5, 17.5)).toEqual([...Array(16).keys()].map((i) => i + 2));
    // Clusters 2..18 (17): the top node is node 2 (x = 3), whose subtree holds clusters 2..23.
    expect(boxed(b, 2.5, 18.5)).toEqual([...Array(22).keys()].map((i) => i + 2));
  });

  it("past 127 leafs, every cluster under the top node, even with few distinct clusters", () => {
    const b = chainBsp(140);
    // Every leaf in clusters 0..3 only: 16 or fewer distinct, but 128 leafs overflow the list.
    const fewClusters = { ...b, leafs: { ...b.leafs, cluster: Int16Array.from({ length: 140 }, (_, i) => (i < 135 ? i % 4 : 4 + i)) } };
    expect(boxed(fewClusters, 0.5, 126.5)).toEqual([0, 1, 2, 3]); // 127 leafs
    expect(boxed(fewClusters, 0.5, 127.5)).toEqual([0, 1, 2, 3, 139, 140, 141, 142, 143]); // 128: all under node 0
  });
});

describe("fat PVS (SV_FatPVS)", () => {
  it("is the eye cluster's row when the 16-unit box is inside one cluster", () => {
    expect(bits(fatPvs(bsp, SPAWN_EYE)!)).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
  });

  it("ORs in the rows of every cluster within 8 units", () => {
    // 4 units north of the cluster 6 / cluster 9 boundary at y -32. The box lists cluster
    // 6 first, then 9, which sees all; both rows must be in.
    expect(bits(fatPvs(bsp, [-448, -28, 46])!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bits(fatPvs(bsp, [-448, 28, 46])!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("is null (no culling) outside the map and on a map without vis", () => {
    expect(fatPvs(bsp, [1200, 0, 400])).toBeNull();
    const novis: Bsp = { ...bsp, visibility: { numClusters: 0, offsets: new Int32Array(0), data: new Uint8Array(0) } };
    expect(fatPvs(novis, SPAWN_EYE)).toBeNull();
  });

  it("is null when a cluster near the eye is past the vis data", () => {
    const cluster = bsp.leafs.cluster.slice();
    cluster.forEach((c, l) => c === 6 && (cluster[l] = 10));
    expect(fatPvs({ ...bsp, leafs: { ...bsp.leafs, cluster } }, SPAWN_EYE)).toBeNull();
  });
});

describe("PVS test", () => {
  it("drops an entity whose clusters are all outside the eye's fat PVS", () => {
    // Model 1 shrunk to y 0..16 on a copy, so a box fits in the 64-unit pillar band
    // (the real one is 68 units deep once spread, so it cannot).
    const mins = bsp.models.mins.slice(), maxs = bsp.models.maxs.slice();
    mins.set([0, 0, 0], 3);
    maxs.set([64, 16, 48], 3);
    const shrunk: Bsp = { ...bsp, models: { ...bsp.models, mins, maxs } };
    const east = entityClusters(shrunk, wall([400, -8, 8]));
    expect(east).toEqual([4]);
    expect(touchesPvs(bsp, fatPvs(bsp, SPAWN_EYE)!, east)).toBe(false);
    expect(touchesPvs(bsp, fatPvs(bsp, EAST_EYE)!, east)).toBe(true);
    // One cluster in the PVS is enough: the same box reaching north into cluster 0.
    const straddling = entityClusters(shrunk, wall([400, 16, 8])).sort();
    expect(straddling).toEqual([0, 4]);
    expect(touchesPvs(bsp, fatPvs(bsp, SPAWN_EYE)!, straddling)).toBe(true);
  });

  it("keeps the fixture's func_wall from everywhere inside the map and drops a buried one", () => {
    const pvs = fatPvs(bsp, SPAWN_EYE)!;
    expect(touchesPvs(bsp, pvs, entityClusters(bsp, wall([0, 0, 0])))).toBe(true);
    expect(touchesPvs(bsp, pvs, entityClusters(bsp, wall([0, 0, -256])))).toBe(false);
  });

  it("counts a cluster past the vis data as visible", () => {
    // 10 clusters: a 2-byte row whose bits 10..15 are padding.
    expect(touchesPvs(bsp, new Uint8Array(2), [10])).toBe(true);
    expect(touchesPvs(bsp, new Uint8Array(2), [9])).toBe(false);
  });
});

describe("render box (R_DrawBrushModel)", () => {
  it("is origin plus the spread model bounds when not rotated", () => {
    expect(renderBox(bsp, wall([10, 20, 30]))).toEqual({ mins: [-375, 147, 29], maxs: [-309, 213, 79] });
  });

  it("is origin plus or minus the radius to the farthest spread corner when rotated", () => {
    const r = Math.hypot(385, 193, 49);
    expect(renderBox(bsp, wall([10, 20, 30], [0, 0, 1]))).toEqual({ mins: [10 - r, 20 - r, 30 - r], maxs: [10 + r, 20 + r, 30 + r] });
  });
});

describe("frustum (R_SetFrustum, R_CullBox)", () => {
  const origin = [10, 20, 30] as const;
  const [pitch, yaw, aspect] = [20, 30, 4 / 3];
  const fy = fovY(90, aspect);
  const viewProj = multiply(perspective(fy, aspect, 4, 16384), viewMatrix(origin, pitch, yaw));
  const planes = frustumPlanes(viewProj);

  it("matches the engine's planes: forward turned toward right and up by 90 - fov/2", () => {
    const { forward: f, right: r, up: u } = angleVectors(pitch, yaw);
    const turn = (side: readonly number[], sign: number, fov: number) => {
      const a = ((90 - fov / 2) * Math.PI) / 180;
      const n = [0, 1, 2].map((i) => f[i]! * Math.cos(a) + sign * side[i]! * Math.sin(a));
      return [...n, -(n[0]! * origin[0] + n[1]! * origin[1] + n[2]! * origin[2])];
    };
    const engine = [turn(r, 1, 90), turn(r, -1, 90), turn(u, 1, fy), turn(u, -1, fy)];
    const unit = (p: readonly number[]) => p.map((v) => v / Math.hypot(p[0]!, p[1]!, p[2]!));
    const key = (p: readonly number[]) => unit(p).map((v) => v.toFixed(4)).join(",");
    expect(planes.map(key).sort()).toEqual(engine.map(key).sort());
  });

  it("culls a box wholly outside one side plane, keeps one in view or straddling a plane", () => {
    const view = viewMatrix([0, 0, 0], 0, 0);
    const p = frustumPlanes(multiply(perspective(90, 1, 4, 16384), view));
    const box = (x: number, y: number, z: number, h = 1) => cullBox(p, [x - h, y - h, z - h], [x + h, y + h, z + h]);
    expect(box(100, 0, 0)).toBe(false); // ahead
    expect(box(-100, 0, 0)).toBe(true); // behind
    expect(box(100, 120, 0)).toBe(true); // left of the 45-degree plane
    expect(box(100, 0, -120)).toBe(true); // below
    expect(box(100, 100, 0, 2)).toBe(false); // straddles the left plane
    expect(box(0, 0, 0, 2)).toBe(false); // around the eye: no near plane
    expect(box(100000, 0, 0)).toBe(false); // past the far plane: none either
  });

  it("a box touching a plane from outside is culled only if its farthest corner is strictly outside", () => {
    const p = frustumPlanes(multiply(perspective(90, 1, 4, 16384), viewMatrix([0, 0, 0], 0, 0)));
    // The left plane is y = x. Boxes flat at x 100, their near edge a hair either side of
    // y 100: float rounding in the matrix makes "exactly on it" unreliable.
    expect(cullBox(p, [100, 100.001, -1], [100, 102, 1])).toBe(true);
    expect(cullBox(p, [100, 99.999, -1], [100, 102, 1])).toBe(false);
    // Exactly on a plane is kept: x >= 100 inside.
    const half: Plane[] = [[1, 0, 0, -100]];
    expect(cullBox(half, [90, 0, 0], [100, 1, 1])).toBe(false);
    expect(cullBox(half, [90, 0, 0], [99.5, 1, 1])).toBe(true);
  });
});
