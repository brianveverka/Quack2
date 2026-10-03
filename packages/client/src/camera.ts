// SPDX-License-Identifier: GPL-2.0-or-later
// Free-fly debug camera: no collision, moves along the view direction.

import { angleVectors } from "./math.js";

export interface FlyInput {
  /** -1..1 along forward, right, world up. */
  readonly forward: number;
  readonly right: number;
  readonly up: number;
  readonly fast: boolean;
}

export const FLY_SPEED = 320;
export const FLY_FAST_SCALE = 3;

export class FlyCamera {
  constructor(
    public origin: [number, number, number],
    public pitch = 0,
    public yaw = 0,
  ) {}

  /** Mouse look in degrees; pitch clamps short of straight up/down. */
  look(dPitch: number, dYaw: number): void {
    this.pitch = Math.max(-89, Math.min(89, this.pitch + dPitch));
    this.yaw = (((this.yaw + dYaw) % 360) + 360) % 360;
  }

  move(input: FlyInput, dt: number): void {
    const { forward: f, right: r } = angleVectors(this.pitch, this.yaw);
    const speed = FLY_SPEED * (input.fast ? FLY_FAST_SCALE : 1) * dt;
    for (let k = 0; k < 3; k++) {
      this.origin[k] = this.origin[k]! + (f[k]! * input.forward + r[k]! * input.right + (k === 2 ? input.up : 0)) * speed;
    }
  }
}
