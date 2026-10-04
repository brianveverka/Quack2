// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clusterPvs, parseBsp, pointLeaf } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import type { BrushModelInstance } from "../src/bmodels.js";
import { boxClusters, boxOutsideFrustum, clustersVisible, fatClusters, frustumPlanes, instanceBox, pvsUnion, type Box } from "../src/cull.js";
import { fovY, modelMatrix, multiply, perspective, transformPoint, viewMatrix } from "../src/math.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const wall = (origin: [number, number, number], angles: [number, number, number] = [0, 0, 0]): BrushModelInstance => ({
  model: 1,
  origin,
  angles,
  classname: "func_wall",
});
const clusterAt = (x: number, y: number, z: number) => bsp.leafs.cluster[pointLeaf(bsp, x, y, z)]!;

/** Model 1's vertices in model space. */
function modelVertices(): [number, number, number][] {
  const out: [number, number, number][] = [];
  const first = bsp.models.firstFace[1]!;
  for (let f = first; f < first + bsp.models.numFaces[1]!; f++) {
    for (let e = 0; e < bsp.faces.numEdges[f]!; e++) {
      const se = bsp.surfEdges[bsp.faces.firstEdge[f]! + e]!;
      const v = bsp.edges[Math.abs(se) * 2 + (se < 0 ? 1 : 0)]!;
      out.push([0, 1, 2].map((k) => bsp.vertexes.position[v * 3 + k]!) as [number, number, number]);
    }
  }
  return out;
}

describe("brush model boxes", () => {
  it("unrotated: the model bounds spread by a unit, at the entity origin", () => {
    expect(instanceBox(bsp, wall([0, -320, 0]))).toEqual({ mins: [-385, -193, -1], maxs: [-319, -127, 49] });
  });

  it("rotated: a cube of the bounds' corner radius around the origin, enclosing every vertex", () => {
    const r = Math.hypot(385, 193, 49);
    expect(instanceBox(bsp, wall([0, 192, 0], [0, 90, 0]))).toEqual({ mins: [-r, 192 - r, -r], maxs: [r, 192 + r, r] });
    const verts = modelVertices();
    expect(verts.length).toBeGreaterThan(0);
    for (const angles of [[0, 90, 0], [30, 45, 0], [0, 0, 60], [-80, 200, 15]] as [number, number, number][]) {
      const inst = wall([10, 20, 30], angles);
      const { mins, maxs } = instanceBox(bsp, inst);
      const m = modelMatrix(inst.origin, angles);
      for (const [x, y, z] of verts) {
        const p = transformPoint(m, x, y, z);
        for (let k = 0; k < 3; k++) {
          expect(p[k]).toBeGreaterThanOrEqual(mins[k]!);
          expect(p[k]).toBeLessThanOrEqual(maxs[k]!);
        }
      }
    }
  });
});

describe("brush model PVS", () => {
  it("finds the clusters of the leafs a box touches, skipping solid ones", () => {
    // The compiled func_wall stands on open floor in the north-west room.
    expect(boxClusters(bsp, instanceBox(bsp, wall([0, 0, 0])))).toEqual([clusterAt(-352, 160, 24)]);
    // Wholly outside the map: only solid leafs.
    expect(boxClusters(bsp, instanceBox(bsp, wall([2000, 0, 0])))).toEqual([]);
  });

  it("culls a box in a cluster the eye's cluster cannot see", () => {
    // The corridor between the pillars (cluster 5) is hidden from the one west of the
    // west pillar (cluster 6, the player start), and from the one east of the east pillar.
    const corridor: Box = { mins: [-100, -20, 10], maxs: [100, 20, 100] };
    const clusters = boxClusters(bsp, corridor);
    expect(clusters).toEqual([clusterAt(0, 0, 50)]);
    const start = clusterAt(-448, 0, 46);
    expect(clustersVisible(clusters, clusterPvs(bsp, start))).toBe(false);
    expect(clustersVisible(clusters, clusterPvs(bsp, clusterAt(400, 0, 46)))).toBe(false);
    expect(clustersVisible(clusters, clusterPvs(bsp, clusters[0]!))).toBe(true);
    // Above the pillars every cluster sees it.
    expect(clustersVisible(clusters, clusterPvs(bsp, clusterAt(0, 0, 200)))).toBe(true);
    // The fat PVS: well inside cluster 6 it is that cluster's row; within reach of the
    // open space above the pillars (cluster 3, which sees everything) it sees the corridor.
    expect(fatClusters(bsp, [-448, 0, 46], start, 8)).toEqual([start]);
    expect(Array.from(pvsUnion(bsp, [start]))).toEqual(Array.from(clusterPvs(bsp, start)));
    const high = fatClusters(bsp, [-448, 0, 124], start, 8)!;
    expect(high).toEqual([clusterAt(0, 0, 200), start]);
    expect(clustersVisible(clusters, pvsUnion(bsp, high))).toBe(true);
    expect(fatClusters(bsp, [-256, 0, 64], -1, 8)).toBeUndefined();
    // Nothing but solid is never visible.
    expect(clustersVisible([], clusterPvs(bsp, start))).toBe(false);
  });
});

describe("brush model frustum", () => {
  // The player start, facing east, at 4:3.
  const aspect = 4 / 3;
  const viewProj = multiply(perspective(fovY(90, aspect), aspect, 4, 16384), viewMatrix([-448, 0, 46], 0, 0));
  const planes = frustumPlanes(viewProj);
  const cube = (x: number, y: number, z: number, h = 8): Box => ({ mins: [x - h, y - h, z - h], maxs: [x + h, y + h, z + h] });

  it("keeps boxes in view or straddling an edge, culls those behind or beside it", () => {
    expect(boxOutsideFrustum(planes, cube(0, 0, 46))).toBe(false);
    expect(boxOutsideFrustum(planes, cube(-400, 0, 46, 60))).toBe(false); // around the eye
    expect(boxOutsideFrustum(planes, cube(-300, 148, 46))).toBe(false); // over the left edge (|y| = x distance)
    expect(boxOutsideFrustum(planes, cube(-600, 0, 46))).toBe(true); // behind
    expect(boxOutsideFrustum(planes, cube(-300, 200, 46))).toBe(true); // left of 45 degrees
    expect(boxOutsideFrustum(planes, cube(-300, -200, 46))).toBe(true); // right
    expect(boxOutsideFrustum(planes, cube(0, 0, 600))).toBe(true); // above the vertical fov
    expect(boxOutsideFrustum(planes, cube(20000, 0, 46))).toBe(true); // past the far plane
    // The compiled func_wall's corner at (-320, 128) is on the left edge, so it is kept;
    // moved 16 units north it is not.
    expect(boxOutsideFrustum(planes, instanceBox(bsp, wall([0, 0, 0])))).toBe(false);
    expect(boxOutsideFrustum(planes, instanceBox(bsp, wall([0, 16, 0])))).toBe(true);
  });

  it("culls only boxes whose corners all clip against one plane", () => {
    const clipped = (x: number, y: number, z: number) => {
      const [cx, cy, cz, w] = transformPoint(viewProj, x, y, z);
      return [cx < -w, cx > w, cy < -w, cy > w, cz < -w, cz > w];
    };
    let culled = 0;
    for (let x = -1000; x <= 1000; x += 125) {
      for (let y = -1000; y <= 1000; y += 125) {
        for (const z of [-300, 46, 400]) {
          const box = cube(x, y, z, 40);
          const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
            clipped(i & 1 ? box.maxs[0] : box.mins[0], i & 2 ? box.maxs[1] : box.mins[1], i & 4 ? box.maxs[2] : box.mins[2]),
          );
          const expected = [0, 1, 2, 3, 4, 5].some((p) => corners.every((c) => c[p]));
          expect(boxOutsideFrustum(planes, box)).toBe(expected);
          if (expected) culled++;
        }
      }
    }
    expect(culled).toBeGreaterThan(0);
  });
});
