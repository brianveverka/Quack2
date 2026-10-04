// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxLeafs, clusterPvs, parseBsp, pointLeaf } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import type { BrushModelInstance } from "../src/bmodels.js";
import {
  areasVisible,
  boxAreas,
  boxClusters,
  boxOutsideFrustum,
  clustersVisible,
  fatClusters,
  frustumPlanes,
  instanceBox,
  linkBox,
  moveInstance,
  placeInstance,
  pvsUnion,
  type Box,
} from "../src/cull.js";
import { closedFlood, openFlood, withEastArea } from "./areas-fixture.js";
import { fovY, modelMatrix, multiply, perspective, transformPoint, viewMatrix } from "../src/math.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));
const wall = (origin: [number, number, number], angles: [number, number, number] = [0, 0, 0]): BrushModelInstance => ({
  model: 1,
  entity: 1,
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

describe("moving brush models", () => {
  // Origin (352, -160, 26) puts the func_wall's middle at 0 0 50, over the corridor;
  // at 2000 0 0 it is outside the map, in no cluster. The PVS sees only its compiled cluster.
  const corridor: [number, number, number] = [352, -160, 26];
  const outside: [number, number, number] = [2000, 0, 0];
  const home = clusterAt(-352, 160, 24);
  const start = new Uint8Array((bsp.visibility.numClusters + 7) >> 3);
  start[home >> 3] = 1 << (home & 7);
  const linked = (inst: BrushModelInstance) => {
    const { model, box, clusters, areas } = placeInstance(bsp, inst);
    return { model, box, clusters, areas };
  };

  it("places an instance at its own origin, in every PVS until tested", () => {
    const placed = placeInstance(bsp, wall([0, 0, 0]));
    expect(placed.box).toEqual(instanceBox(bsp, wall([0, 0, 0])));
    expect(placed.clusters).toEqual([home]);
    expect(placed.areas).toEqual(boxAreas(bsp, linkBox(bsp, wall([0, 0, 0]))));
    expect(Array.from(placed.model)).toEqual(Array.from(modelMatrix([0, 0, 0], [0, 0, 0])));
    expect(placed.inPvs).toBe(true);
  });

  it("re-links a moved instance as if it had spawned there, and re-tests its PVS", () => {
    const placed = placeInstance(bsp, wall([0, 0, 0]));
    moveInstance(bsp, placed, corridor, corridor, start);
    const { model, box, clusters, areas } = placed;
    expect({ model, box, clusters, areas }).toEqual(linked(wall(corridor)));
    expect(clusters).toContain(clusterAt(0, 0, 50));
    moveInstance(bsp, placed, outside, outside, start);
    expect([placed.clusters, placed.inPvs]).toEqual([[], false]);
    moveInstance(bsp, placed, [0, 0, 0], [0, 0, 0], start);
    expect([placed.clusters, placed.inPvs]).toEqual([[home], true]);
    moveInstance(bsp, placed, outside, outside, start);
    // No fat PVS (the eye in no cluster) passes it.
    moveInstance(bsp, placed, corridor, corridor, undefined);
    expect(placed.inPvs).toBe(true);
  });

  it("draws and frustum culls at the drawn origin, sends by clusters and areas at the linked one", () => {
    const placed = placeInstance(bsp, wall([0, 0, 0]));
    moveInstance(bsp, placed, corridor, [0, 0, 0], start);
    const at = linked(wall(corridor));
    const there = linked(wall([0, 0, 0]));
    expect([placed.model, placed.box]).toEqual([at.model, at.box]);
    expect([placed.clusters, placed.areas]).toEqual([there.clusters, there.areas]);
    expect(placed.origin).toEqual(corridor);
    expect(placed.linkOrigin).toEqual([0, 0, 0]);
    // And the other way round, both moving in one call.
    moveInstance(bsp, placed, [0, 0, 0], corridor, start);
    expect([placed.model, placed.box]).toEqual([there.model, there.box]);
    expect([placed.clusters, placed.areas]).toEqual([at.clusters, at.areas]);
    expect(at.clusters).not.toEqual(there.clusters);
  });

  it("leaves what did not move as it is, the cached PVS test included", () => {
    const placed = placeInstance(bsp, wall([0, 0, 0]));
    const { model, clusters } = placed;
    placed.inPvs = false;
    moveInstance(bsp, placed, [0, 0, 0], [0, 0, 0], undefined);
    expect(placed.model).toBe(model);
    expect(placed.clusters).toBe(clusters);
    expect(placed.inPvs).toBe(false);
    // Moving only the drawn origin keeps the link and its test.
    moveInstance(bsp, placed, corridor, [0, 0, 0], undefined);
    expect(placed.model).not.toBe(model);
    expect(placed.clusters).toBe(clusters);
    expect(placed.inPvs).toBe(false);
  });

  it("keeps its own copies of the origins", () => {
    const placed = placeInstance(bsp, wall([0, 0, 0]));
    const origin: [number, number, number] = [...corridor];
    moveInstance(bsp, placed, origin, origin, start);
    origin[2] = 0;
    expect(placed.origin).toEqual(corridor);
    expect(placed.linkOrigin).toEqual(corridor);
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

describe("brush model areas", () => {
  const split = withEastArea(bsp);

  it("link box: the model bounds spread by one more unit, at the entity origin", () => {
    expect(linkBox(bsp, wall([0, -320, 0]))).toEqual({ mins: [-386, -194, -2], maxs: [-318, -126, 50] });
  });

  it("link box when rotated: a cube of the largest single bound, plus a unit, around the origin", () => {
    // Bounds spread by a unit: x -385..-319, y 127..193, z -1..49; the largest is 385.
    expect(linkBox(bsp, wall([0, 192, 0], [0, 90, 0]))).toEqual({ mins: [-386, 192 - 386, -386], maxs: [386, 192 + 386, 386] });
  });

  it("a box whose min is on an axial plane is only in front of it", () => {
    // Min x -512 is on the west wall's plane (normal +x): the wall leaf 19 is behind it.
    // The general test agrees here (only a max on the plane differs).
    const box: Box = { mins: [-512, -100, 10], maxs: [-500, -90, 20] };
    expect(boxLeafs(split, box.mins, box.maxs, undefined, true)).toEqual([17]);
  });

  it("lists leafs front child first, as CM_BoxLeafnums_r recurses", () => {
    // Measured on the fixture and traced by hand through its nodes; every split plane is
    // axial with a +axis normal, so the larger-coordinate side comes first: north before
    // south (y -32), east before west (x -8 and 8).
    const box: Box = { mins: [-20, -100, 10], maxs: [20, 100, 20] };
    expect(boxLeafs(split, box.mins, box.maxs, undefined, true)).toEqual([4, 5, 6, 7, 11, 14, 15, 16, 17]);
  });

  it("keeps the last area differing from the first as areanum2 (SV_LinkEdict)", () => {
    // A third area: the south-west room (leaf 17, x -512..-8, y -256..-32).
    const three = withEastArea(bsp);
    const area = Int16Array.from(three.leafs.area);
    area[17] = 3;
    const split3 = { ...three, leafs: { ...three.leafs, area } };
    const box: Box = { mins: [-20, -100, 10], maxs: [20, 100, 20] };
    const inOrder = boxLeafs(split3, box.mins, box.maxs, undefined, true).map((l) => split3.leafs.area[l]!).filter((a) => a !== 0);
    expect(new Set(inOrder)).toEqual(new Set([1, 2, 3]));
    const second = [...inOrder].reverse().find((a) => a !== inOrder[0])!;
    expect(inOrder.find((a) => a !== inOrder[0])).not.toBe(second);
    expect(boxAreas(split3, box)).toEqual([inOrder[0], second]);
  });

  it("an entity in one area has it as areanum and no areanum2", () => {
    expect(boxAreas(split, linkBox(split, wall([0, 0, 0])))).toEqual([1, 0]);
    expect(boxAreas(split, linkBox(split, wall([700, 0, 0])))).toEqual([2, 0]);
  });

  it("an entity straddling the portal has both areas, the first in tree order first", () => {
    const box: Box = { mins: [-20, 100, 10], maxs: [20, 110, 20] };
    const areas = boxAreas(split, box);
    const inOrder = boxLeafs(split, box.mins, box.maxs, undefined, true).map((l) => split.leafs.area[l]!).filter((a) => a !== 0);
    expect(new Set(inOrder)).toEqual(new Set([1, 2]));
    expect(areas).toEqual([inOrder[0], [...inOrder].reverse().find((a) => a !== inOrder[0])]);
  });

  it("follows the engine's axial-plane ties: a box whose max is on a plane is only behind it", () => {
    // The link box's max x is -512, on the west wall's plane: CM_BoxLeafnums sends it only
    // into the wall, so the entity is in area 0; both sides would put it in area 1.
    const box = linkBox(split, wall([-194, -450, 0]));
    expect(box.maxs[0]).toBe(-512);
    expect(boxAreas(split, box)).toEqual([0, 0]);
    const both = boxLeafs(split, box.mins, box.maxs).map((l) => split.leafs.area[l]);
    expect(both).toContain(1);
  });

  it("an entity touching only solid leafs is in area 0", () => {
    expect(boxAreas(split, linkBox(split, wall([2000, 0, 0])))).toEqual([0, 0]);
  });

  it("is sent when either area is connected to the eye's (SV_BuildClientFrame)", () => {
    const closed = closedFlood(split);
    expect(areasVisible(closed, 1, [1, 0])).toBe(true);
    expect(areasVisible(closed, 1, [2, 0])).toBe(false);
    expect(areasVisible(closed, 2, [1, 2])).toBe(true);
    expect(areasVisible(closed, 1, [2, 1])).toBe(true);
    expect(areasVisible(closed, 1, [0, 0])).toBe(false);
    expect(areasVisible(openFlood(split), 1, [2, 0])).toBe(true);
  });

  it("an eye in area 0 passes every entity, as the PVS test does there", () => {
    expect(areasVisible(closedFlood(split), 0, [2, 0])).toBe(true);
    expect(areasVisible(closedFlood(split), 0, [0, 0])).toBe(true);
  });
});
