// SPDX-License-Identifier: GPL-2.0-or-later
// Cross-reference and geometry checks on a parsed BSP. parseBsp only guarantees the
// file is structurally readable; these confirm the indices and brushes make sense
// before trace or render code trusts them.

import { PLANE_ANYX, PLANE_X } from "./format.js";
import type { Bsp } from "./parse.js";
import { faceLightmapBytes, lightmapExtents } from "./surface.js";

const NORMAL_EPSILON = 1e-4;
/** Distance tolerance for a point lying on or inside a brush plane, in world units. */
const ON_EPSILON = 0.01;

/** Returns a list of problems; empty means the BSP passed every check. */
export function checkBspIntegrity(bsp: Bsp): string[] {
  const errs: string[] = [];
  const range = (what: string, v: number, n: number) => {
    if (!(v >= 0 && v < n)) errs.push(`${what} = ${v}, valid range [0, ${n})`);
  };
  const span = (what: string, first: number, num: number, n: number) => {
    if (first < 0 || num < 0 || first + num > n) errs.push(`${what} [${first}, +${num}) exceeds ${n}`);
  };
  const { planes, nodes, faces, leafs, models, brushes, brushSides, texinfo, areas, areaPortals } = bsp;

  for (let i = 0; i < planes.count; i++) {
    const nx = planes.normal[i * 3]!, ny = planes.normal[i * 3 + 1]!, nz = planes.normal[i * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz);
    if (Math.abs(len - 1) > NORMAL_EPSILON) errs.push(`plane ${i} normal length ${len}`);
    const abs = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
    const type = planes.type[i]!;
    const axial = abs.findIndex((a) => a === 1);
    if (axial >= 0) {
      if (type !== PLANE_X + axial) errs.push(`plane ${i} is axial on ${axial} but has type ${type}`);
    } else {
      const major = abs.indexOf(Math.max(...abs));
      if (type !== PLANE_ANYX + major) errs.push(`plane ${i} has major axis ${major} but type ${type}`);
    }
  }

  for (let i = 0; i < nodes.count; i++) {
    range(`node ${i} planeNum`, nodes.planeNum[i]!, planes.count);
    for (let s = 0; s < 2; s++) {
      const c = nodes.children[i * 2 + s]!;
      if (c >= 0) range(`node ${i} child ${s}`, c, nodes.count);
      else range(`node ${i} child ${s} leaf`, -(c + 1), leafs.count);
    }
    span(`node ${i} faces`, nodes.firstFace[i]!, nodes.numFaces[i]!, faces.count);
  }

  for (let i = 0; i < faces.count; i++) {
    range(`face ${i} planeNum`, faces.planeNum[i]!, planes.count);
    range(`face ${i} texinfo`, faces.texinfo[i]!, texinfo.count);
    if (faces.numEdges[i]! < 3) errs.push(`face ${i} has ${faces.numEdges[i]} edges`);
    span(`face ${i} surfedges`, faces.firstEdge[i]!, faces.numEdges[i]!, bsp.surfEdges.length);
    const ofs = faces.lightOfs[i]!;
    if (ofs !== -1) range(`face ${i} lightOfs`, ofs, bsp.lighting.length);
  }
  for (let i = 0; i < bsp.surfEdges.length; i++) {
    range(`surfedge ${i}`, Math.abs(bsp.surfEdges[i]!), bsp.edges.length / 2);
  }
  for (let i = 0; i < bsp.edges.length; i++) range(`edge ${i >> 1} vertex`, bsp.edges[i]!, bsp.vertexes.count);

  for (let i = 0; i < texinfo.count; i++) {
    const next = texinfo.nextTexinfo[i]!;
    if (next !== -1) range(`texinfo ${i} next`, next, texinfo.count);
  }

  for (let i = 0; i < leafs.count; i++) {
    const cluster = leafs.cluster[i]!;
    if (cluster !== -1) range(`leaf ${i} cluster`, cluster, bsp.visibility.numClusters);
    range(`leaf ${i} area`, leafs.area[i]!, Math.max(areas.count, 1));
    span(`leaf ${i} leaffaces`, leafs.firstLeafFace[i]!, leafs.numLeafFaces[i]!, bsp.leafFaces.length);
    span(`leaf ${i} leafbrushes`, leafs.firstLeafBrush[i]!, leafs.numLeafBrushes[i]!, bsp.leafBrushes.length);
  }
  bsp.leafFaces.forEach((f, i) => range(`leafface ${i}`, f, faces.count));
  bsp.leafBrushes.forEach((b, i) => range(`leafbrush ${i}`, b, brushes.count));

  for (let i = 0; i < models.count; i++) {
    range(`model ${i} headNode`, models.headNode[i]!, nodes.count);
    span(`model ${i} faces`, models.firstFace[i]!, models.numFaces[i]!, faces.count);
    for (let k = 0; k < 3; k++) {
      if (models.mins[i * 3 + k]! > models.maxs[i * 3 + k]!) errs.push(`model ${i} mins > maxs on axis ${k}`);
    }
  }

  for (let i = 0; i < brushes.count; i++) {
    span(`brush ${i} sides`, brushes.firstSide[i]!, brushes.numSides[i]!, brushSides.count);
    if (brushes.numSides[i]! < 4) errs.push(`brush ${i} has only ${brushes.numSides[i]} sides`);
  }
  for (let i = 0; i < brushSides.count; i++) {
    range(`brushside ${i} planeNum`, brushSides.planeNum[i]!, planes.count);
    const ti = brushSides.texinfo[i]!;
    if (ti !== -1) range(`brushside ${i} texinfo`, ti, texinfo.count);
  }
  if (errs.length === 0) {
    // Needs valid surfedges and texinfo indices, checked above.
    for (let i = 0; i < faces.count; i++) {
      const ofs = faces.lightOfs[i]!;
      if (ofs === -1) continue;
      const bytes = faceLightmapBytes(bsp, i);
      if (ofs + bytes > bsp.lighting.length) {
        const { width, height } = lightmapExtents(bsp, i);
        errs.push(
          `face ${i} lightmap ${width}x${height} (${bytes} bytes) at ${ofs} overruns lighting lump of ${bsp.lighting.length}`,
        );
      }
    }
    for (let i = 0; i < brushes.count; i++) {
      const g = brushGeometry(bsp, i);
      if (!g.bounded) errs.push(`brush ${i} is unbounded (an inverted or missing side)`);
      else if (g.vertices.length < 4) errs.push(`brush ${i} is empty (${g.vertices.length} vertices)`);
      g.sidesTouching.forEach((touching, s) => {
        if (!touching) errs.push(`brush ${i} side ${s} does not touch the brush (redundant or inverted plane)`);
      });
    }
  }

  for (let i = 0; i < areas.count; i++) {
    span(`area ${i} portals`, areas.firstAreaPortal[i]!, areas.numAreaPortals[i]!, areaPortals.count);
  }
  for (let i = 0; i < areaPortals.count; i++) {
    range(`areaportal ${i} otherArea`, areaPortals.otherArea[i]!, Math.max(areas.count, 1));
  }
  return errs;
}

export interface BrushGeometry {
  /** Corner points of the convex brush, deduplicated. */
  readonly vertices: readonly (readonly [number, number, number])[];
  /** Bounds of `vertices`. Meaningless unless `bounded`: an open brush reaches the clip box. */
  readonly mins: readonly [number, number, number];
  readonly maxs: readonly [number, number, number];
  /** Per side: whether at least one corner lies on that side's plane. */
  readonly sidesTouching: readonly boolean[];
  /** False if the planes do not enclose a finite volume. */
  readonly bounded: boolean;
}

/** Larger than any Q2 map (int16 bounds); a corner this far out means an open brush. */
const WORLD_BOUND = 1 << 17;

/**
 * Recover a brush's corners by intersecting every triple of its planes and keeping
 * points inside all of them. Brush planes face outward. O((sides + 6)^3); for checks
 * and debugging, not per-frame use.
 */
export function brushGeometry(bsp: Bsp, brush: number): BrushGeometry {
  const first = bsp.brushes.firstSide[brush]!;
  const num = bsp.brushes.numSides[brush]!;
  const pl: Plane[] = [];
  for (let s = 0; s < num; s++) {
    const p = bsp.brushSides.planeNum[first + s]!;
    const n = bsp.planes.normal;
    pl.push([n[p * 3]!, n[p * 3 + 1]!, n[p * 3 + 2]!, bsp.planes.dist[p]!]);
  }
  // Clip to a world-sized box so an open brush still yields corners, at the box.
  const all = [...pl];
  for (let k = 0; k < 3; k++) {
    const e: Plane = [0, 0, 0, WORLD_BOUND];
    e[k] = 1;
    all.push(e, [-e[0], -e[1], -e[2], WORLD_BOUND]);
  }
  const verts: [number, number, number][] = [];
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      for (let c = b + 1; c < all.length; c++) {
        const v = intersect3(all[a]!, all[b]!, all[c]!);
        if (!v) continue;
        if (!all.every(([x, y, z, d]) => x * v[0] + y * v[1] + z * v[2] - d <= ON_EPSILON)) continue;
        if (!verts.some((u) => Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]) < ON_EPSILON)) {
          verts.push(v);
        }
      }
    }
  }
  const mins: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let k = 0; k < 3; k++) {
      mins[k] = Math.min(mins[k]!, v[k]!);
      maxs[k] = Math.max(maxs[k]!, v[k]!);
    }
  }
  const sidesTouching = pl.map(([x, y, z, d]) =>
    verts.some((v) => Math.abs(x * v[0] + y * v[1] + z * v[2] - d) <= ON_EPSILON),
  );
  const bounded = verts.every((v) => v.every((x) => Math.abs(x) < WORLD_BOUND - 1));
  return { vertices: verts, mins, maxs, sidesTouching, bounded };
}

type Plane = [number, number, number, number];

function intersect3(p: Plane, q: Plane, r: Plane): [number, number, number] | undefined {
  // Cramer's rule on n_i . x = d_i.
  const [a1, b1, c1, d1] = p, [a2, b2, c2, d2] = q, [a3, b3, c3, d3] = r;
  const det = a1 * (b2 * c3 - b3 * c2) - b1 * (a2 * c3 - a3 * c2) + c1 * (a2 * b3 - a3 * b2);
  if (Math.abs(det) < 1e-9) return undefined;
  const x = (d1 * (b2 * c3 - b3 * c2) - b1 * (d2 * c3 - d3 * c2) + c1 * (d2 * b3 - d3 * b2)) / det;
  const y = (a1 * (d2 * c3 - d3 * c2) - d1 * (a2 * c3 - a3 * c2) + c1 * (a2 * d3 - a3 * d2)) / det;
  const z = (a1 * (b2 * d3 - b3 * d2) - b1 * (a2 * d3 - a3 * d2) + d1 * (a2 * b3 - a3 * b2)) / det;
  return [x, y, z];
}
