// SPDX-License-Identifier: GPL-2.0-or-later
// Brush entity motion as a client sees it: the movers (`doorMovers`) stepped a game frame
// at a time by the sim, each frame's origins sent at the network's 1/8 unit
// (MSG_WriteCoord, MSG_ReadCoord) and angles at its 360/256 degrees (MSG_WriteAngle,
// MSG_ReadAngle), and drawn blended between the last two frames as CL_AddEntities and
// CL_AddPacketEntities (client/cl_ents.c) do. DOM-free.

import { levelTimeAt, stepPusher } from "@quack2/sim";
import type { MovingDoor } from "./bmodels.js";

type Vec3 = [number, number, number];

/** An entity's origin and angles (pitch, yaw, roll); the arrays are the holder's. */
export interface MoverPose {
  origin: Vec3;
  angles: Vec3;
}

/** Game frames SV_SpawnServer runs before any client is sent one. */
const SETTLE_FRAMES = 2;

/**
 * A float coordinate after the network: MSG_WriteCoord writes (int)(f*8) as a short,
 * MSG_ReadCoord reads it back times 1/8 into a float.
 */
export function networkCoord(f: number): number {
  return Math.fround(((Math.trunc(Math.fround(f * 8)) << 16) >> 16) * (1 / 8));
}

/**
 * A float angle after the network: MSG_WriteAngle writes (int)(f*256/360) & 255 as a
 * byte, in float arithmetic; MSG_ReadAngle reads it as a signed char times 360.0/256
 * into a float, so 180 comes back -180.
 */
export function networkAngle(f: number): number {
  const b = Math.trunc(Math.fround(Math.fround(f * 256) / 360)) & 255;
  return Math.fround(((b << 24) >> 24) * (360 / 256));
}

/** q_shared.c LerpAngle, in float: from a2 to a1 the short way round, by frac. */
export function lerpAngle(a2: number, a1: number, frac: number): number {
  if (Math.fround(a1 - a2) > 180) a1 = Math.fround(a1 - 360);
  if (Math.fround(a1 - a2) < -180) a1 = Math.fround(a1 + 360);
  return Math.fround(a2 + Math.fround(frac * Math.fround(a1 - a2)));
}

/**
 * The poses of the moving brush entities at client time `ms` after the map loaded.
 *
 * Server frame k (sv.framenum, which counts from 1 after the settle frames) runs game
 * frame k + 2 and is sent with servertime k * 100 ms. At client time t the client lerps
 * from the frame before towards the one at servertime ceil(t / 100) * 100, by
 * lerpfrac = 1 - (servertime - t) * 0.01; cl.time and servertime are integer ms, so t is
 * floored. At t = 0 that is the second settle frame, where the map loads.
 * Assumes every frame arrives on time, as on a local server, and that every door is
 * sent every frame. The server sends only what the client's PVS holds, and a door coming
 * back into it arrives as a new entity whose prev origin is its old_origin: for a team
 * slave that is where the master's push already left it, so that frame the game snaps
 * the slave where this lerps it; its prev angles are its current ones, so it snaps to
 * those too.
 */
export class BrushMotion {
  private teams: readonly (readonly MovingDoor[])[] = [];
  /** The last game frame stepped. */
  private framenum = SETTLE_FRAMES;
  /** Networked poses at framenum - 1 and framenum, by entity index. */
  private prev = new Map<number, MoverPose>();
  private cur = new Map<number, MoverPose>();

  /** `spawn` builds the movers as the settle frames leave them; it runs again to go back in time. */
  constructor(private readonly spawn: () => readonly (readonly MovingDoor[])[]) {
    this.reset();
  }

  private reset(): void {
    this.teams = this.spawn();
    this.framenum = SETTLE_FRAMES;
    this.cur = this.snapshot();
    this.prev = this.cur;
  }

  private snapshot(): Map<number, MoverPose> {
    const out = new Map<number, MoverPose>();
    for (const team of this.teams) {
      for (const { entity, mover } of team) {
        out.set(entity, { origin: mover.origin.map(networkCoord) as Vec3, angles: mover.angles.map(networkAngle) as Vec3 });
      }
    }
    return out;
  }

  /** Step the movers to the game frame client time `ms` draws towards; returns that time, floored and at least 0. */
  private stepTo(ms: number): number {
    // Steps one game frame per 100 ms: an infinite time never ends (a huge one takes as long).
    if (!Number.isFinite(ms)) throw new RangeError(`level time ${ms} ms is not finite`);
    const time = Math.max(0, Math.floor(ms));
    const target = SETTLE_FRAMES + Math.ceil(time / 100);
    if (target < this.framenum) this.reset();
    while (this.framenum < target) {
      this.framenum++;
      const levelTime = levelTimeAt(this.framenum);
      for (const team of this.teams) stepPusher(team.map((d) => d.mover), levelTime);
      this.prev = this.cur;
      this.cur = this.snapshot();
    }
    return time;
  }

  /**
   * Where the game frame client time `ms` draws towards left every moving entity, by
   * entity index: the exact origin and angles the server links it at (SV_LinkEdict) and
   * so decides by whether to send it, where the drawn pose is blended towards it. The
   * poses are the caller's.
   */
  linkedPoses(ms: number): Map<number, MoverPose> {
    this.stepTo(ms);
    const out = new Map<number, MoverPose>();
    for (const team of this.teams) {
      for (const { entity, mover } of team) out.set(entity, { origin: [...mover.origin], angles: [...mover.angles] });
    }
    return out;
  }

  /**
   * The drawn pose of every moving entity at `ms`, by entity index: origins blended
   * linearly, angles by LerpAngle. The poses are the caller's.
   */
  posesAt(ms: number): Map<number, MoverPose> {
    const time = this.stepTo(ms);
    const copy = (p: MoverPose): MoverPose => ({ origin: [...p.origin], angles: [...p.angles] });
    if (this.framenum === SETTLE_FRAMES) return new Map([...this.cur].map(([e, p]) => [e, copy(p)]));
    const serverframe = this.framenum - SETTLE_FRAMES;
    const frac = Math.fround(1 - (serverframe * 100 - time) * 0.01);
    const out = new Map<number, MoverPose>();
    for (const [entity, cur] of this.cur) {
      const prev = this.prev.get(entity)!;
      out.set(entity, {
        origin: cur.origin.map((c, k) => Math.fround(prev.origin[k]! + Math.fround(frac * Math.fround(c - prev.origin[k]!)))) as Vec3,
        angles: cur.angles.map((c, k) => lerpAngle(prev.angles[k]!, c, frac)) as Vec3,
      });
    }
    return out;
  }
}
