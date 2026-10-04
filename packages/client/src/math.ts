// SPDX-License-Identifier: GPL-2.0-or-later
// Column-major 4x4 matrices for WebGL, and Quake 2 angle conventions: Z up, yaw about
// Z from +X, positive pitch looks down.

export type Mat4 = Float32Array;

const DEG = Math.PI / 180;

/** forward, right, up for (pitch, yaw, roll) in degrees, as AngleVectors in q_shared.c. */
export function angleVectors(pitch: number, yaw: number, roll = 0) {
  const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
  const sy = Math.sin(yaw * DEG), cy = Math.cos(yaw * DEG);
  const sr = Math.sin(roll * DEG), cr = Math.cos(roll * DEG);
  return {
    forward: [cp * cy, cp * sy, -sp] as const,
    right: [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp] as const,
    up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp] as const,
  };
}

/**
 * Model-to-world matrix of a brush entity: rotate by its angles, then translate to its
 * origin. The GL renderer negates pitch and roll around R_RotateForEntity ("stupid quake
 * bug", gl_rsurf.c R_DrawBrushModel), which makes the model axes forward, -right and up
 * of AngleVectors: the same frame the collision code (CM_TransformedBoxTrace) uses.
 * The engine's client draws angles after the network has rounded them to 360/256
 * degree steps (MSG_WriteAngle): the doors `BrushMotion` steps are drawn with those,
 * every other instance with its exact angles, as server collision sees them.
 */
export function modelMatrix(origin: readonly [number, number, number], angles: readonly [number, number, number]): Mat4 {
  const { forward: f, right: r, up: u } = angleVectors(angles[0], angles[1], angles[2]);
  // prettier-ignore
  return new Float32Array([
    f[0], f[1], f[2], 0,
    -r[0], -r[1], -r[2], 0,
    u[0], u[1], u[2], 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

/** OpenGL perspective projection, depth to [-1, 1]. */
export function perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovYDeg * DEG) / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** Vertical field of view giving `fovXDeg` horizontally at this aspect (Q2 fixes fov_x). */
export function fovY(fovXDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((fovXDeg * DEG) / 2) / aspect)) / DEG;
}

/** World-to-eye matrix: GL eye space looks down -Z with +Y up, so rows are right, up, -forward. */
export function viewMatrix(eye: readonly [number, number, number], pitch: number, yaw: number): Mat4 {
  const { forward: f, right: r, up: u } = angleVectors(pitch, yaw);
  const dot = (a: readonly number[]) => a[0]! * eye[0] + a[1]! * eye[1] + a[2]! * eye[2];
  // prettier-ignore
  return new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r), -dot(u), dot(f), 1,
  ]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** a * (x, y, z, 1), returned as clip-space xyzw. */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  return [0, 1, 2, 3].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!) as [number, number, number, number];
}
