// SPDX-License-Identifier: GPL-2.0-or-later
// Reduce an ericw-tools bspinfo JSON dump to the fields stored in a Q2 IBSP file, in
// file field order. The tests compare the parser against this: an independent reader.
// bspinfo dumps a format-neutral superset (Q1 fields, 16 light styles, per-face
// vertices, lightdata hex without zero padding); those parts are dropped here.
// bspinfo has no usable dump of lighting, vis rows, pop, areas or areaportals, so for
// those lumps the golden holds a SHA-256 of the raw lump bytes, cut straight from the
// file header here rather than through the parser.
// Usage: node scripts/make-golden.mjs file.bsp.json file.bsp > file.golden.json
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const RAW_LUMPS = { visibility: 3, lighting: 7, pop: 16, areas: 17, areaportals: 18 };
const bsp = readFileSync(process.argv[3]);
const rawLumpSha256 = Object.fromEntries(
  Object.entries(RAW_LUMPS).map(([name, i]) => {
    const ofs = bsp.readInt32LE(8 + i * 8);
    const len = bsp.readInt32LE(12 + i * 8);
    return [name, createHash("sha256").update(bsp.subarray(ofs, ofs + len)).digest("hex")];
  }),
);

const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const golden = {
  entities: d.entdata,
  planes: d.planes.map((p) => [...p.normal, p.dist, p.type]),
  vertexes: d.vertexes,
  visibility: d.visdata ? d.visdata.pvs : [],
  nodes: d.nodes.map((n) => [n.planenum, ...n.children, ...n.mins, ...n.maxs, n.firstface, n.numfaces]),
  texinfo: d.texinfo.map((t) => [...t.vecs.flat(), t.flags, t.value, t.texture, t.nexttexinfo]),
  faces: d.faces.map((f) => [f.planenum, f.side, f.firstedge, f.numedges, f.texinfo, ...f.styles.slice(0, 4), f.lightofs]),
  leafs: d.leafs.map((l) => [
    l.contents, l.cluster, l.area, ...l.mins, ...l.maxs,
    l.firstmarksurface, l.nummarksurfaces, l.firstleafbrush, l.numleafbrushes,
  ]),
  leaffaces: d.leaffaces,
  leafbrushes: d.leafbrushes,
  edges: d.edges,
  surfedges: d.surfedges,
  models: d.models.map((m) => [...m.mins, ...m.maxs, ...m.origin, m.headnode[0], m.firstface, m.numfaces]),
  brushes: d.brushes.map((b) => [b.firstside, b.numsides, b.contents]),
  brushsides: d.brushsides.map((s) => [s.planenum, s.texinfo]),
  rawLumpSha256,
};

// One record per line keeps diffs readable when the fixture is rebuilt.
const lines = Object.entries(golden).map(([k, v]) =>
  Array.isArray(v)
    ? `  ${JSON.stringify(k)}: [\n${v.map((r) => "    " + JSON.stringify(r)).join(",\n")}\n  ]`
    : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
);
process.stdout.write(`{\n${lines.join(",\n")}\n}\n`);
