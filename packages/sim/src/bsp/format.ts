// SPDX-License-Identifier: GPL-2.0-or-later
// Quake 2 BSP (IBSP version 38) on-disk layout, after qfiles.h in the Quake 2 source.

/** "IBSP" read as a little-endian int32. */
export const BSP_MAGIC = 0x50534249;
export const BSP_VERSION = 38;

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_VERTEXES = 2;
export const LUMP_VISIBILITY = 3;
export const LUMP_NODES = 4;
export const LUMP_TEXINFO = 5;
export const LUMP_FACES = 6;
export const LUMP_LIGHTING = 7;
export const LUMP_LEAFS = 8;
export const LUMP_LEAFFACES = 9;
export const LUMP_LEAFBRUSHES = 10;
export const LUMP_EDGES = 11;
export const LUMP_SURFEDGES = 12;
export const LUMP_MODELS = 13;
export const LUMP_BRUSHES = 14;
export const LUMP_BRUSHSIDES = 15;
export const LUMP_POP = 16;
export const LUMP_AREAS = 17;
export const LUMP_AREAPORTALS = 18;
export const HEADER_LUMPS = 19;

export const LUMP_NAMES = [
  "entities",
  "planes",
  "vertexes",
  "visibility",
  "nodes",
  "texinfo",
  "faces",
  "lighting",
  "leafs",
  "leaffaces",
  "leafbrushes",
  "edges",
  "surfedges",
  "models",
  "brushes",
  "brushsides",
  "pop",
  "areas",
  "areaportals",
] as const;

/** ident + version + 19 (fileofs, filelen) pairs. */
export const HEADER_SIZE = 8 + HEADER_LUMPS * 8;

/**
 * Bytes per record for lumps that are arrays of fixed-size structs.
 * Lumps absent here (entities, visibility, lighting, pop) are opaque byte blobs.
 */
export const RECORD_SIZE: Partial<Record<number, number>> = {
  [LUMP_PLANES]: 20, // float normal[3], float dist, int type
  [LUMP_VERTEXES]: 12, // float point[3]
  [LUMP_NODES]: 28, // int planenum, int children[2], short mins[3], short maxs[3], ushort firstface, ushort numfaces
  [LUMP_TEXINFO]: 76, // float vecs[2][4], int flags, int value, char texture[32], int nexttexinfo
  [LUMP_FACES]: 20, // ushort planenum, short side, int firstedge, short numedges, short texinfo, byte styles[4], int lightofs
  [LUMP_LEAFS]: 28, // int contents, short cluster, short area, short mins[3], short maxs[3], ushort x4
  [LUMP_LEAFFACES]: 2, // ushort
  [LUMP_LEAFBRUSHES]: 2, // ushort
  [LUMP_EDGES]: 4, // ushort v[2]
  [LUMP_SURFEDGES]: 4, // int, negative means the edge is walked backwards
  [LUMP_MODELS]: 48, // float mins[3], maxs[3], origin[3], int headnode, int firstface, int numfaces
  [LUMP_BRUSHES]: 12, // int firstside, int numsides, int contents
  [LUMP_BRUSHSIDES]: 4, // ushort planenum, short texinfo
  [LUMP_AREAS]: 8, // int numareaportals, int firstareaportal
  [LUMP_AREAPORTALS]: 8, // int portalnum, int otherarea
};

export const TEXTURE_NAME_LENGTH = 32;
export const MAX_LIGHTMAPS = 4;

// Plane types: 0-2 are axial (normal along X, Y, Z); 3-5 are "mostly" that axis.
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
export const PLANE_ANYX = 3;
export const PLANE_ANYY = 4;
export const PLANE_ANYZ = 5;

// Content flags (subset most code needs; values from q_shared.h).
export const CONTENTS_SOLID = 1;
export const CONTENTS_WINDOW = 2;
export const CONTENTS_LAVA = 8;
export const CONTENTS_SLIME = 16;
export const CONTENTS_WATER = 32;
export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_MONSTERCLIP = 0x20000;
export const CONTENTS_DETAIL = 0x8000000;

// Surface flags (texinfo.flags).
export const SURF_LIGHT = 0x1;
export const SURF_SLICK = 0x2;
export const SURF_SKY = 0x4;
export const SURF_WARP = 0x8;
export const SURF_TRANS33 = 0x10;
export const SURF_TRANS66 = 0x20;
export const SURF_FLOWING = 0x40;
export const SURF_NODRAW = 0x80;

/** Visibility offsets index the second dimension of `visibility.offsets`. */
export const DVIS_PVS = 0;
export const DVIS_PHS = 1;
