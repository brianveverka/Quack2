// SPDX-License-Identifier: GPL-2.0-or-later
// Parses a Quake 2 BSP into struct-of-arrays typed arrays. Every value is copied out
// through a DataView, so the result does not depend on host endianness or lump
// alignment, and it does not keep the source buffer alive.
//
// Coordinates are float everywhere: node and leaf bounds are stored as int16 in the
// file and widened to Float32Array here, so callers never mix integer and float space.

import {
  BSP_MAGIC,
  BSP_VERSION,
  HEADER_LUMPS,
  HEADER_SIZE,
  LUMP_AREAPORTALS,
  LUMP_AREAS,
  LUMP_BRUSHES,
  LUMP_BRUSHSIDES,
  LUMP_EDGES,
  LUMP_ENTITIES,
  LUMP_FACES,
  LUMP_LEAFBRUSHES,
  LUMP_LEAFFACES,
  LUMP_LEAFS,
  LUMP_LIGHTING,
  LUMP_MODELS,
  LUMP_NAMES,
  LUMP_NODES,
  LUMP_PLANES,
  LUMP_POP,
  LUMP_SURFEDGES,
  LUMP_TEXINFO,
  LUMP_VERTEXES,
  LUMP_VISIBILITY,
  MAX_LIGHTMAPS,
  RECORD_SIZE,
  TEXTURE_NAME_LENGTH,
} from "./format.js";

export class BspError extends Error {
  override name = "BspError";
}

export interface BspLumpInfo {
  readonly offset: number;
  readonly length: number;
}

export interface BspPlanes {
  readonly count: number;
  /** xyz per plane. */
  readonly normal: Float32Array;
  readonly dist: Float32Array;
  /** PLANE_X .. PLANE_ANYZ. */
  readonly type: Int32Array;
}

export interface BspVertexes {
  readonly count: number;
  /** xyz per vertex. */
  readonly position: Float32Array;
}

export interface BspVisibility {
  readonly numClusters: number;
  /** [pvs, phs] byte offsets per cluster, into `data`. */
  readonly offsets: Int32Array;
  /** The whole lump, header included, so `offsets` index it directly. */
  readonly data: Uint8Array;
}

export interface BspNodes {
  readonly count: number;
  readonly planeNum: Int32Array;
  /** front, back per node. Negative child c means leaf -(c + 1). */
  readonly children: Int32Array;
  /** xyz per node. */
  readonly mins: Float32Array;
  readonly maxs: Float32Array;
  readonly firstFace: Uint16Array;
  readonly numFaces: Uint16Array;
}

export interface BspTexinfo {
  readonly count: number;
  /** s xyz offset, t xyz offset: 8 floats per texinfo. */
  readonly vecs: Float32Array;
  /** SURF_* flags. */
  readonly flags: Int32Array;
  readonly value: Int32Array;
  /** Texture path without extension, e.g. "e1u1/floor1_1". The file may not exist. */
  readonly texture: readonly string[];
  /** Next frame of an animated texture, or -1. */
  readonly nextTexinfo: Int32Array;
}

export interface BspFaces {
  readonly count: number;
  readonly planeNum: Uint16Array;
  /** Nonzero if the face points opposite its plane normal. */
  readonly side: Int16Array;
  readonly firstEdge: Int32Array;
  readonly numEdges: Int16Array;
  readonly texinfo: Int16Array;
  /** MAX_LIGHTMAPS light styles per face; 255 ends the list. */
  readonly styles: Uint8Array;
  /** Byte offset into the lighting lump, or -1. */
  readonly lightOfs: Int32Array;
}

export interface BspLeafs {
  readonly count: number;
  /** CONTENTS_* flags. */
  readonly contents: Int32Array;
  /** -1 for leafs that are not in any cluster (solid). */
  readonly cluster: Int16Array;
  readonly area: Int16Array;
  readonly mins: Float32Array;
  readonly maxs: Float32Array;
  readonly firstLeafFace: Uint16Array;
  readonly numLeafFaces: Uint16Array;
  readonly firstLeafBrush: Uint16Array;
  readonly numLeafBrushes: Uint16Array;
}

export interface BspModels {
  readonly count: number;
  readonly mins: Float32Array;
  readonly maxs: Float32Array;
  readonly origin: Float32Array;
  readonly headNode: Int32Array;
  readonly firstFace: Int32Array;
  readonly numFaces: Int32Array;
}

export interface BspBrushes {
  readonly count: number;
  readonly firstSide: Int32Array;
  readonly numSides: Int32Array;
  readonly contents: Int32Array;
}

export interface BspBrushSides {
  readonly count: number;
  readonly planeNum: Uint16Array;
  readonly texinfo: Int16Array;
}

export interface BspAreas {
  readonly count: number;
  readonly numAreaPortals: Int32Array;
  readonly firstAreaPortal: Int32Array;
}

export interface BspAreaPortals {
  readonly count: number;
  readonly portalNum: Int32Array;
  readonly otherArea: Int32Array;
}

export interface Bsp {
  readonly version: number;
  /** Raw lump directory, indexed by LUMP_*. */
  readonly lumps: readonly BspLumpInfo[];
  readonly entityString: string;
  readonly planes: BspPlanes;
  readonly vertexes: BspVertexes;
  readonly visibility: BspVisibility;
  readonly nodes: BspNodes;
  readonly texinfo: BspTexinfo;
  readonly faces: BspFaces;
  /** RGB lightmap samples, addressed by faces.lightOfs. */
  readonly lighting: Uint8Array;
  readonly leafs: BspLeafs;
  readonly leafFaces: Uint16Array;
  readonly leafBrushes: Uint16Array;
  /** v0, v1 per edge. */
  readonly edges: Uint16Array;
  readonly surfEdges: Int32Array;
  readonly models: BspModels;
  readonly brushes: BspBrushes;
  readonly brushSides: BspBrushSides;
  /** Unused by the Quake 2 engine; kept for completeness. */
  readonly pop: Uint8Array;
  readonly areas: BspAreas;
  readonly areaPortals: BspAreaPortals;
}

/** Decode bytes as Latin-1, stopping at the first NUL. Q2 strings are byte strings. */
export function decodeLatin1(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let out = "";
  // Chunked to stay under argument-count limits on large entity lumps.
  for (let i = 0; i < end; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  }
  return out;
}

function identString(view: DataView): string {
  let s = "";
  for (let i = 0; i < 4; i++) {
    const c = view.getUint8(i);
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return s;
}

export function parseBsp(input: ArrayBuffer | Uint8Array): Bsp {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < HEADER_SIZE) {
    throw new BspError(`BSP too small: ${bytes.byteLength} bytes, header alone is ${HEADER_SIZE}`);
  }
  const magic = view.getInt32(0, true);
  if (magic !== BSP_MAGIC) {
    throw new BspError(
      `not a Quake 2 BSP: magic is "${identString(view)}", expected "IBSP"` +
        (identString(view) === "QBSP" ? " (Qbism extended format is not supported)" : ""),
    );
  }
  const version = view.getInt32(4, true);
  if (version !== BSP_VERSION) {
    throw new BspError(`unsupported IBSP version ${version}, expected ${BSP_VERSION} (Quake 2)`);
  }

  const lumps: BspLumpInfo[] = [];
  for (let i = 0; i < HEADER_LUMPS; i++) {
    const offset = view.getInt32(8 + i * 8, true);
    const length = view.getInt32(12 + i * 8, true);
    const name = LUMP_NAMES[i];
    if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
      throw new BspError(
        `lump ${name} out of bounds: offset ${offset}, length ${length}, file ${bytes.byteLength}`,
      );
    }
    const size = RECORD_SIZE[i];
    if (size !== undefined && length % size !== 0) {
      throw new BspError(`lump ${name} length ${length} is not a multiple of record size ${size}`);
    }
    lumps.push({ offset, length });
  }

  const lump = (i: number): BspLumpInfo => lumps[i]!;
  const count = (i: number): number => lump(i).length / RECORD_SIZE[i]!;
  const blob = (i: number): Uint8Array => bytes.slice(lump(i).offset, lump(i).offset + lump(i).length);
  const f32 = (o: number) => view.getFloat32(o, true);
  const i32 = (o: number) => view.getInt32(o, true);
  const i16 = (o: number) => view.getInt16(o, true);
  const u16 = (o: number) => view.getUint16(o, true);

  // Planes
  let n = count(LUMP_PLANES);
  let base = lump(LUMP_PLANES).offset;
  const planes = {
    count: n,
    normal: new Float32Array(n * 3),
    dist: new Float32Array(n),
    type: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 20;
    for (let k = 0; k < 3; k++) planes.normal[i * 3 + k] = f32(o + k * 4);
    planes.dist[i] = f32(o + 12);
    planes.type[i] = i32(o + 16);
  }

  // Vertexes
  n = count(LUMP_VERTEXES);
  base = lump(LUMP_VERTEXES).offset;
  const vertexes = { count: n, position: new Float32Array(n * 3) };
  for (let i = 0; i < n * 3; i++) vertexes.position[i] = f32(base + i * 4);

  // Visibility: int numclusters, int bitofs[numclusters][2], then RLE data.
  const visLump = lump(LUMP_VISIBILITY);
  let visibility: BspVisibility;
  if (visLump.length === 0) {
    visibility = { numClusters: 0, offsets: new Int32Array(0), data: new Uint8Array(0) };
  } else {
    if (visLump.length < 4) throw new BspError(`visibility lump too short: ${visLump.length} bytes`);
    const numClusters = i32(visLump.offset);
    if (numClusters < 0 || 4 + numClusters * 8 > visLump.length) {
      throw new BspError(
        `visibility header claims ${numClusters} clusters, lump is ${visLump.length} bytes`,
      );
    }
    const offsets = new Int32Array(numClusters * 2);
    for (let i = 0; i < numClusters * 2; i++) {
      const ofs = i32(visLump.offset + 4 + i * 4);
      if (ofs < 0 || ofs > visLump.length) {
        throw new BspError(`visibility offset ${ofs} for cluster ${i >> 1} outside lump`);
      }
      offsets[i] = ofs;
    }
    visibility = { numClusters, offsets, data: blob(LUMP_VISIBILITY) };
  }

  // Nodes
  n = count(LUMP_NODES);
  base = lump(LUMP_NODES).offset;
  const nodes = {
    count: n,
    planeNum: new Int32Array(n),
    children: new Int32Array(n * 2),
    mins: new Float32Array(n * 3),
    maxs: new Float32Array(n * 3),
    firstFace: new Uint16Array(n),
    numFaces: new Uint16Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 28;
    nodes.planeNum[i] = i32(o);
    nodes.children[i * 2] = i32(o + 4);
    nodes.children[i * 2 + 1] = i32(o + 8);
    for (let k = 0; k < 3; k++) {
      nodes.mins[i * 3 + k] = i16(o + 12 + k * 2);
      nodes.maxs[i * 3 + k] = i16(o + 18 + k * 2);
    }
    nodes.firstFace[i] = u16(o + 24);
    nodes.numFaces[i] = u16(o + 26);
  }

  // Texinfo
  n = count(LUMP_TEXINFO);
  base = lump(LUMP_TEXINFO).offset;
  const texture: string[] = [];
  const texinfo = {
    count: n,
    vecs: new Float32Array(n * 8),
    flags: new Int32Array(n),
    value: new Int32Array(n),
    texture,
    nextTexinfo: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 76;
    for (let k = 0; k < 8; k++) texinfo.vecs[i * 8 + k] = f32(o + k * 4);
    texinfo.flags[i] = i32(o + 32);
    texinfo.value[i] = i32(o + 36);
    texture.push(decodeLatin1(bytes.subarray(o + 40, o + 40 + TEXTURE_NAME_LENGTH)));
    texinfo.nextTexinfo[i] = i32(o + 72);
  }

  // Faces
  n = count(LUMP_FACES);
  base = lump(LUMP_FACES).offset;
  const faces = {
    count: n,
    planeNum: new Uint16Array(n),
    side: new Int16Array(n),
    firstEdge: new Int32Array(n),
    numEdges: new Int16Array(n),
    texinfo: new Int16Array(n),
    styles: new Uint8Array(n * MAX_LIGHTMAPS),
    lightOfs: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 20;
    faces.planeNum[i] = u16(o);
    faces.side[i] = i16(o + 2);
    faces.firstEdge[i] = i32(o + 4);
    faces.numEdges[i] = i16(o + 8);
    faces.texinfo[i] = i16(o + 10);
    for (let k = 0; k < MAX_LIGHTMAPS; k++) faces.styles[i * MAX_LIGHTMAPS + k] = bytes[o + 12 + k]!;
    faces.lightOfs[i] = i32(o + 16);
  }

  // Leafs
  n = count(LUMP_LEAFS);
  base = lump(LUMP_LEAFS).offset;
  const leafs = {
    count: n,
    contents: new Int32Array(n),
    cluster: new Int16Array(n),
    area: new Int16Array(n),
    mins: new Float32Array(n * 3),
    maxs: new Float32Array(n * 3),
    firstLeafFace: new Uint16Array(n),
    numLeafFaces: new Uint16Array(n),
    firstLeafBrush: new Uint16Array(n),
    numLeafBrushes: new Uint16Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 28;
    leafs.contents[i] = i32(o);
    leafs.cluster[i] = i16(o + 4);
    leafs.area[i] = i16(o + 6);
    for (let k = 0; k < 3; k++) {
      leafs.mins[i * 3 + k] = i16(o + 8 + k * 2);
      leafs.maxs[i * 3 + k] = i16(o + 14 + k * 2);
    }
    leafs.firstLeafFace[i] = u16(o + 20);
    leafs.numLeafFaces[i] = u16(o + 22);
    leafs.firstLeafBrush[i] = u16(o + 24);
    leafs.numLeafBrushes[i] = u16(o + 26);
  }

  // Index lists
  const u16List = (l: number): Uint16Array => {
    const out = new Uint16Array(lump(l).length / 2);
    for (let i = 0; i < out.length; i++) out[i] = u16(lump(l).offset + i * 2);
    return out;
  };
  const leafFaces = u16List(LUMP_LEAFFACES);
  const leafBrushes = u16List(LUMP_LEAFBRUSHES);
  const edges = u16List(LUMP_EDGES);
  const surfEdges = new Int32Array(count(LUMP_SURFEDGES));
  for (let i = 0; i < surfEdges.length; i++) surfEdges[i] = i32(lump(LUMP_SURFEDGES).offset + i * 4);

  // Models
  n = count(LUMP_MODELS);
  base = lump(LUMP_MODELS).offset;
  const models = {
    count: n,
    mins: new Float32Array(n * 3),
    maxs: new Float32Array(n * 3),
    origin: new Float32Array(n * 3),
    headNode: new Int32Array(n),
    firstFace: new Int32Array(n),
    numFaces: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 48;
    for (let k = 0; k < 3; k++) {
      models.mins[i * 3 + k] = f32(o + k * 4);
      models.maxs[i * 3 + k] = f32(o + 12 + k * 4);
      models.origin[i * 3 + k] = f32(o + 24 + k * 4);
    }
    models.headNode[i] = i32(o + 36);
    models.firstFace[i] = i32(o + 40);
    models.numFaces[i] = i32(o + 44);
  }

  // Brushes
  n = count(LUMP_BRUSHES);
  base = lump(LUMP_BRUSHES).offset;
  const brushes = {
    count: n,
    firstSide: new Int32Array(n),
    numSides: new Int32Array(n),
    contents: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const o = base + i * 12;
    brushes.firstSide[i] = i32(o);
    brushes.numSides[i] = i32(o + 4);
    brushes.contents[i] = i32(o + 8);
  }

  // Brush sides
  n = count(LUMP_BRUSHSIDES);
  base = lump(LUMP_BRUSHSIDES).offset;
  const brushSides = { count: n, planeNum: new Uint16Array(n), texinfo: new Int16Array(n) };
  for (let i = 0; i < n; i++) {
    brushSides.planeNum[i] = u16(base + i * 4);
    brushSides.texinfo[i] = i16(base + i * 4 + 2);
  }

  // Areas
  n = count(LUMP_AREAS);
  base = lump(LUMP_AREAS).offset;
  const areas = { count: n, numAreaPortals: new Int32Array(n), firstAreaPortal: new Int32Array(n) };
  for (let i = 0; i < n; i++) {
    areas.numAreaPortals[i] = i32(base + i * 8);
    areas.firstAreaPortal[i] = i32(base + i * 8 + 4);
  }

  // Area portals
  n = count(LUMP_AREAPORTALS);
  base = lump(LUMP_AREAPORTALS).offset;
  const areaPortals = { count: n, portalNum: new Int32Array(n), otherArea: new Int32Array(n) };
  for (let i = 0; i < n; i++) {
    areaPortals.portalNum[i] = i32(base + i * 8);
    areaPortals.otherArea[i] = i32(base + i * 8 + 4);
  }

  return {
    version,
    lumps,
    entityString: decodeLatin1(bytes.subarray(lump(LUMP_ENTITIES).offset, lump(LUMP_ENTITIES).offset + lump(LUMP_ENTITIES).length)),
    planes,
    vertexes,
    visibility,
    nodes,
    texinfo,
    faces,
    lighting: blob(LUMP_LIGHTING),
    leafs,
    leafFaces,
    leafBrushes,
    edges,
    surfEdges,
    models,
    brushes,
    brushSides,
    pop: blob(LUMP_POP),
    areas,
    areaPortals,
  };
}
