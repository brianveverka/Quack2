// SPDX-License-Identifier: GPL-2.0-or-later
// Port of ref_gl/gl_warp.c's water-surface subdivision (BoundPoly, SubdividePolygon,
// GL_SubdivideSurface) and the EmitWaterPolys texture-coordinate warp, with gl_rsurf.c's
// scroll for unwarped SURF_FLOWING faces beside it. DOM-free so tests
// can import it under Node. The C stores vec3_t, verts and locals as `float`; every store
// or float-only operation is rounded with Math.fround so results match the engine bit for
// bit where JS allows. Comments mark where the C mixes in `double`.

const f = Math.fround;

/** r_turbsin from warpsin.h, the 256 values copied verbatim. */
export const TURBSIN = new Float32Array([
  0, 0.19633, 0.392541, 0.588517, 0.784137, 0.979285, 1.17384, 1.3677,
  1.56072, 1.75281, 1.94384, 2.1337, 2.32228, 2.50945, 2.69512, 2.87916,
  3.06147, 3.24193, 3.42044, 3.59689, 3.77117, 3.94319, 4.11282, 4.27998,
  4.44456, 4.60647, 4.76559, 4.92185, 5.07515, 5.22538, 5.37247, 5.51632,
  5.65685, 5.79398, 5.92761, 6.05767, 6.18408, 6.30677, 6.42566, 6.54068,
  6.65176, 6.75883, 6.86183, 6.9607, 7.05537, 7.14579, 7.23191, 7.31368,
  7.39104, 7.46394, 7.53235, 7.59623, 7.65552, 7.71021, 7.76025, 7.80562,
  7.84628, 7.88222, 7.91341, 7.93984, 7.96148, 7.97832, 7.99036, 7.99759,
  8, 7.99759, 7.99036, 7.97832, 7.96148, 7.93984, 7.91341, 7.88222,
  7.84628, 7.80562, 7.76025, 7.71021, 7.65552, 7.59623, 7.53235, 7.46394,
  7.39104, 7.31368, 7.23191, 7.14579, 7.05537, 6.9607, 6.86183, 6.75883,
  6.65176, 6.54068, 6.42566, 6.30677, 6.18408, 6.05767, 5.92761, 5.79398,
  5.65685, 5.51632, 5.37247, 5.22538, 5.07515, 4.92185, 4.76559, 4.60647,
  4.44456, 4.27998, 4.11282, 3.94319, 3.77117, 3.59689, 3.42044, 3.24193,
  3.06147, 2.87916, 2.69512, 2.50945, 2.32228, 2.1337, 1.94384, 1.75281,
  1.56072, 1.3677, 1.17384, 0.979285, 0.784137, 0.588517, 0.392541, 0.19633,
  9.79717e-16, -0.19633, -0.392541, -0.588517, -0.784137, -0.979285, -1.17384, -1.3677,
  -1.56072, -1.75281, -1.94384, -2.1337, -2.32228, -2.50945, -2.69512, -2.87916,
  -3.06147, -3.24193, -3.42044, -3.59689, -3.77117, -3.94319, -4.11282, -4.27998,
  -4.44456, -4.60647, -4.76559, -4.92185, -5.07515, -5.22538, -5.37247, -5.51632,
  -5.65685, -5.79398, -5.92761, -6.05767, -6.18408, -6.30677, -6.42566, -6.54068,
  -6.65176, -6.75883, -6.86183, -6.9607, -7.05537, -7.14579, -7.23191, -7.31368,
  -7.39104, -7.46394, -7.53235, -7.59623, -7.65552, -7.71021, -7.76025, -7.80562,
  -7.84628, -7.88222, -7.91341, -7.93984, -7.96148, -7.97832, -7.99036, -7.99759,
  -8, -7.99759, -7.99036, -7.97832, -7.96148, -7.93984, -7.91341, -7.88222,
  -7.84628, -7.80562, -7.76025, -7.71021, -7.65552, -7.59623, -7.53235, -7.46394,
  -7.39104, -7.31368, -7.23191, -7.14579, -7.05537, -6.9607, -6.86183, -6.75883,
  -6.65176, -6.54068, -6.42566, -6.30677, -6.18408, -6.05767, -5.92761, -5.79398,
  -5.65685, -5.51632, -5.37247, -5.22538, -5.07515, -4.92185, -4.76559, -4.60647,
  -4.44456, -4.27998, -4.11282, -3.94319, -3.77117, -3.59689, -3.42044, -3.24193,
  -3.06147, -2.87916, -2.69512, -2.50945, -2.32228, -2.1337, -1.94384, -1.75281,
  -1.56072, -1.3677, -1.17384, -0.979285, -0.784137, -0.588517, -0.392541, -0.19633,
]);

/** 256 / (2 * M_PI): maps radians onto the 256-entry TURBSIN table (a double constant in C). */
const TURBSCALE = 256 / (2 * Math.PI);

export const SUBDIVIDE_SIZE = 64;

/** SubdividePolygon errors (ERR_DROP) above this many vertices. */
const MAX_SUBDIVIDE_VERTS = 60;

export interface WarpPoly {
  /** xyz per vertex: the centre first, then the face corners, then the first corner again (a closed triangle fan). */
  readonly position: Float32Array;
  /** Untransformed texture s, t per vertex (dot product with texinfo vecs, no offset term, as SubdividePolygon computes). */
  readonly st: Float32Array;
}

/** DotProduct macro on floats: each product and each sum is a float operation, left to right. */
function dot(v: ArrayLike<number>, o: number, vec: ArrayLike<number>): number {
  return f(f(f(v[o]! * vec[0]!) + f(v[o + 1]! * vec[1]!)) + f(v[o + 2]! * vec[2]!));
}

/** The glpoly_t SubdividePolygon builds once a piece needs no further cut. */
function makePoly(numverts: number, verts: Float32Array, sVec: ArrayLike<number>, tVec: ArrayLike<number>): WarpPoly {
  const n = numverts + 2;
  const position = new Float32Array(n * 3);
  const st = new Float32Array(n * 2);
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let totalS = 0;
  let totalT = 0;
  for (let i = 0; i < numverts; i++) {
    const o = i * 3;
    position[(i + 1) * 3] = verts[o]!;
    position[(i + 1) * 3 + 1] = verts[o + 1]!;
    position[(i + 1) * 3 + 2] = verts[o + 2]!;
    const s = dot(verts, o, sVec);
    const t = dot(verts, o, tVec);
    totalS = f(totalS + s);
    totalT = f(totalT + t);
    tx = f(tx + verts[o]!);
    ty = f(ty + verts[o + 1]!);
    tz = f(tz + verts[o + 2]!);
    st[(i + 1) * 2] = s;
    st[(i + 1) * 2 + 1] = t;
  }
  // VectorScale takes `vec_t scale`, so the double 1.0/numverts is rounded to float before
  // the float multiply.
  const scale = f(1 / numverts);
  position[0] = f(tx * scale);
  position[1] = f(ty * scale);
  position[2] = f(tz * scale);
  // float / int: a float division.
  st[0] = f(totalS / numverts);
  st[1] = f(totalT / numverts);
  // Copy first corner to last, closing the fan.
  const last = numverts + 1;
  position[last * 3] = position[3]!;
  position[last * 3 + 1] = position[4]!;
  position[last * 3 + 2] = position[5]!;
  st[last * 2] = st[2]!;
  st[last * 2 + 1] = st[3]!;
  return { position, st };
}

/**
 * SubdividePolygon. `verts` is float-rounded, numverts*3 long, and owned by this call.
 * Appends polys to `out` in creation order.
 */
function subdivide(numverts: number, verts: Float32Array, sVec: ArrayLike<number>, tVec: ArrayLike<number>, out: WarpPoly[]): void {
  // The engine drops the map (ERR_DROP) here. Corrupt or unusual input is never fatal in
  // this repo, so the piece is emitted whole as one fan instead: it still renders, just
  // with a coarser warp.
  if (numverts > MAX_SUBDIVIDE_VERTS) {
    out.push(makePoly(numverts, verts, sVec, tVec));
    return;
  }

  // BoundPoly, including its 9999 / -9999 starting bounds: a polygon lying entirely beyond
  // +-9999 on an axis gets a phantom bound there.
  const mins = [9999, 9999, 9999];
  const maxs = [-9999, -9999, -9999];
  for (let i = 0; i < numverts; i++) {
    for (let j = 0; j < 3; j++) {
      const v = verts[i * 3 + j]!;
      if (v < mins[j]!) mins[j] = v;
      if (v > maxs[j]!) maxs[j] = v;
    }
  }

  for (let i = 0; i < 3; i++) {
    // float + float, then times the double 0.5, stored to float m.
    let m = f(f(mins[i]! + maxs[i]!) * 0.5);
    // m/SUBDIVIDE_SIZE is float / int (float); + 0.5 and floor() are double; the double
    // product is stored to float m.
    m = f(SUBDIVIDE_SIZE * Math.floor(f(m / SUBDIVIDE_SIZE) + 0.5));
    if (f(maxs[i]! - m) < 8) continue;
    if (f(m - mins[i]!) < 8) continue;

    // Cut it. The C writes dist[numverts] = dist[0] and copies verts[0] past the end of the
    // caller's buffer (the wrap case); this works on a local copy one vertex longer instead.
    const v = new Float32Array((numverts + 1) * 3);
    v.set(verts.subarray(0, numverts * 3));
    v[numverts * 3] = v[0]!;
    v[numverts * 3 + 1] = v[1]!;
    v[numverts * 3 + 2] = v[2]!;
    const dist = new Float32Array(numverts + 1);
    for (let j = 0; j < numverts; j++) dist[j] = v[j * 3 + i]! - m;
    dist[numverts] = dist[0]!;
    // With real bounds the min vertex is at least 8 behind m and the max at least 8 ahead.
    // Only the phantom 9999 bound can leave no vertex strictly on one side; the engine then
    // recurses forever on the same polygon (the other side holds only on-plane vertices or
    // nothing). Skipping the axis keeps that input finite and changes nothing else.
    let ahead = false, behind = false;
    for (let j = 0; j < numverts; j++) {
      if (dist[j]! > 0) ahead = true;
      else if (dist[j]! < 0) behind = true;
    }
    if (!ahead || !behind) continue;

    // The C front/back are vec3_t[64]; a non-convex input could overrun them (undefined
    // behaviour). Plain arrays grow, and the >60 check above catches the oversized piece.
    const front: number[] = [];
    const back: number[] = [];
    for (let j = 0; j < numverts; j++) {
      const o = j * 3;
      const dj = dist[j]!;
      const dn = dist[j + 1]!;
      if (dj >= 0) front.push(v[o]!, v[o + 1]!, v[o + 2]!);
      if (dj <= 0) back.push(v[o]!, v[o + 1]!, v[o + 2]!);
      if (dj === 0 || dn === 0) continue;
      if (dj > 0 !== dn > 0) {
        // Clip point: all float arithmetic.
        const frac = f(dj / f(dj - dn));
        for (let k = 0; k < 3; k++) {
          const p = f(v[o + k]! + f(frac * f(v[o + 3 + k]! - v[o + k]!)));
          front.push(p);
          back.push(p);
        }
      }
    }

    subdivide(front.length / 3, Float32Array.from(front), sVec, tVec, out);
    subdivide(back.length / 3, Float32Array.from(back), sVec, tVec, out);
    return;
  }

  // Add a point in the centre to help keep the warp valid.
  out.push(makePoly(numverts, verts, sVec, tVec));
}

/**
 * GL_SubdivideSurface/SubdividePolygon: cut a face polygon (xyz triples, winding order as the
 * face's edges give it) along axial SUBDIVIDE_SIZE boundaries. Returns polys in the order
 * the engine's fa->polys list holds them (it prepends each new poly, so the last created comes first).
 * sVec/tVec are texinfo vecs[0][0..2] and vecs[1][0..2].
 *
 * A polygon of fewer than 3 vertices returns no polys (the engine would divide by zero or
 * read uninitialised memory). Trailing values short of a full xyz triple are ignored.
 */
export function subdivideWarpPolygon(points: ArrayLike<number>, sVec: ArrayLike<number>, tVec: ArrayLike<number>): WarpPoly[] {
  const numverts = Math.floor(points.length / 3);
  if (numverts < 3) return [];
  // GL_SubdivideSurface copies the vertexes into a local float vec3_t buffer.
  const verts = new Float32Array(numverts * 3);
  for (let i = 0; i < numverts * 3; i++) verts[i] = points[i]!;
  const created: WarpPoly[] = [];
  subdivide(numverts, verts, sVec, tVec, created);
  return created.reverse();
}

/**
 * EmitWaterPolys texture coordinate for one vertex (already divided by 64), time in seconds,
 * flowing = SURF_FLOWING. Reference for the GPU shader and tests.
 *
 * os/ot are a poly vertex's st. r_newrefdef.time is float seconds, so `time` is rounded to
 * float first. The non-id386 path is ported: a C (int) cast truncates toward zero, and
 * `& 255` on a negative int is two's complement, which JS `| 0` then `& 255` matches for
 * values in int range.
 */
export function warpTexCoord(os: number, ot: number, time: number, flowing: boolean): [number, number] {
  const rdt = f(time);
  os = f(os);
  ot = f(ot);
  // Double arithmetic (0.5 is double) stored to float scroll.
  const half = rdt * 0.5;
  const scroll = flowing ? f(-64 * (half - Math.trunc(half))) : 0;
  // ot*0.125 + time and the TURBSCALE product are double; the sum with os is float.
  let s = f(os + TURBSIN[(((ot * 0.125 + rdt) * TURBSCALE) | 0) & 255]!);
  s = f(s + scroll);
  // s *= (1.0/64): double multiply stored to float.
  s = f(s * (1 / 64));
  let t = f(ot + TURBSIN[(((os * 0.125 + rdt) * TURBSCALE) | 0) & 255]!);
  t = f(t * (1 / 64));
  return [s, t];
}

/**
 * Scroll added to an unwarped SURF_FLOWING face's s, in texture widths (v[3] is already
 * divided by the image width), time in seconds. DrawGLFlowingPoly and
 * GL_RenderLightmappedPoly apply it to opaque faces; R_DrawAlphaSurfaces draws unwarped
 * translucent ones with DrawGLPoly, unscrolled.
 */
export function flowingScroll(time: number): number {
  const rdt = f(time);
  // time / 40.0 is double; the product is stored to float scroll.
  const q = rdt / 40;
  const scroll = f(-64 * (q - Math.trunc(q)));
  // The C's `scroll == 0.0` swap: a whole number of 40 s periods scrolls by -64.
  return scroll === 0 ? -64 : scroll;
}
