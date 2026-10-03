// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { angleVectors, modelMatrix, multiply, transformPoint, type Mat4 } from "../src/math.js";

/** glRotatef(deg, x, y, z) for a unit axis, column-major, as the GL spec defines it. */
function glRotate(deg: number, x: number, y: number, z: number): Mat4 {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180), k = 1 - c;
  // prettier-ignore
  return new Float32Array([
    x * x * k + c, y * x * k + z * s, x * z * k - y * s, 0,
    x * y * k - z * s, y * y * k + c, y * z * k + x * s, 0,
    x * z * k + y * s, y * z * k - x * s, z * z * k + c, 0,
    0, 0, 0, 1,
  ]);
}

function glTranslate(x: number, y: number, z: number): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** gl_rsurf.c R_DrawBrushModel: pitch and roll negated, then R_RotateForEntity (gl_rmain.c). */
function engineBrushMatrix(origin: readonly [number, number, number], angles: readonly [number, number, number]): Mat4 {
  const [pitch, yaw, roll] = [-angles[0], angles[1], -angles[2]];
  let m = glTranslate(origin[0], origin[1], origin[2]);
  m = multiply(m, glRotate(yaw, 0, 0, 1));
  m = multiply(m, glRotate(-pitch, 0, 1, 0));
  return multiply(m, glRotate(-roll, 1, 0, 0));
}

const ANGLES: [number, number, number][] = [
  [0, 0, 0],
  [0, 90, 0],
  [0, -135, 0],
  [30, 0, 0],
  [0, 0, 45],
  [-20, 70, 10],
  [80, 200, -60],
];

describe("angleVectors", () => {
  it("keeps the roll-free vectors the camera uses", () => {
    const { right, up } = angleVectors(30, 60);
    const sp = Math.sin(Math.PI / 6), cp = Math.cos(Math.PI / 6), sy = Math.sin(Math.PI / 3), cy = Math.cos(Math.PI / 3);
    [sy, -cy, 0].forEach((v, i) => expect(right[i]).toBeCloseTo(v, 12));
    [sp * cy, sp * sy, cp].forEach((v, i) => expect(up[i]).toBeCloseTo(v, 12));
  });

  it("is orthonormal with forward x left = up for any roll", () => {
    for (const [p, y, r] of ANGLES) {
      const { forward: f, right: rt, up: u } = angleVectors(p, y, r);
      const left = [-rt[0], -rt[1], -rt[2]] as const;
      const cross = [f[1] * left[2] - f[2] * left[1], f[2] * left[0] - f[0] * left[2], f[0] * left[1] - f[1] * left[0]];
      cross.forEach((v, i) => expect(v).toBeCloseTo(u[i]!, 12));
      for (const v of [f, rt, u]) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    }
  });
});

describe("modelMatrix", () => {
  it("matches the GL renderer's brush model transform", () => {
    const origin = [16, -32, 8] as const;
    for (const angles of ANGLES) {
      const want = engineBrushMatrix(origin, angles);
      modelMatrix(origin, angles).forEach((v, i) => expect(v, `${angles} [${i}]`).toBeCloseTo(want[i]!, 5));
    }
  });

  it("turns +X toward +Y for yaw 90, then translates", () => {
    const p = transformPoint(modelMatrix([100, 0, 0], [0, 90, 0]), 10, 0, 0);
    [100, 10, 0, 1].forEach((v, i) => expect(p[i]).toBeCloseTo(v, 5));
  });

  it("tips +X down for positive pitch, as forward does", () => {
    const p = transformPoint(modelMatrix([0, 0, 0], [90, 0, 0]), 10, 0, 0);
    [0, 0, -10].forEach((v, i) => expect(p[i]).toBeCloseTo(v, 5));
  });

  it("keeps handedness, so clockwise front faces stay front faces", () => {
    for (const angles of ANGLES) {
      const m = modelMatrix([0, 0, 0], angles);
      const det =
        m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
      expect(det).toBeCloseTo(1, 5);
    }
  });
});
