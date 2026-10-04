// SPDX-License-Identifier: GPL-2.0-or-later
// Brush entity motion as a client sees it: the movers (`doorMovers`) stepped a game frame
// at a time by the sim, each frame's origins sent at the network's 1/8 unit
// (MSG_WriteCoord, MSG_ReadCoord), and drawn blended between the last two frames as
// CL_AddEntities and CL_AddPacketEntities (client/cl_ents.c) do. DOM-free.

import { levelTimeAt, stepPusher } from "@quack2/sim";
import type { MovingDoor } from "./bmodels.js";

type Vec3 = [number, number, number];

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
 * The origins of the moving brush entities at client time `ms` after the map loaded.
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
 * the slave where this lerps it.
 */
export class BrushMotion {
  private teams: readonly (readonly MovingDoor[])[] = [];
  /** The last game frame stepped. */
  private framenum = SETTLE_FRAMES;
  /** Networked origins at framenum - 1 and framenum, by entity index. */
  private prev = new Map<number, Vec3>();
  private cur = new Map<number, Vec3>();

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

  private snapshot(): Map<number, Vec3> {
    const out = new Map<number, Vec3>();
    for (const team of this.teams) {
      for (const { entity, mover } of team) out.set(entity, mover.origin.map(networkCoord) as Vec3);
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
   * entity index: the origin the server links it at (SV_LinkEdict) and so decides by
   * whether to send it, where the drawn origin is blended towards it. The arrays are the
   * caller's.
   */
  linkedOrigins(ms: number): Map<number, Vec3> {
    this.stepTo(ms);
    const out = new Map<number, Vec3>();
    for (const team of this.teams) {
      for (const { entity, mover } of team) out.set(entity, [mover.origin[0], mover.origin[1], mover.origin[2]]);
    }
    return out;
  }

  /** The drawn origin of every moving entity at `ms`, by entity index; the arrays are the caller's. */
  originsAt(ms: number): Map<number, Vec3> {
    const time = this.stepTo(ms);
    if (this.framenum === SETTLE_FRAMES) return new Map([...this.cur].map(([e, o]) => [e, [...o] as Vec3]));
    const serverframe = this.framenum - SETTLE_FRAMES;
    const frac = Math.fround(1 - (serverframe * 100 - time) * 0.01);
    const out = new Map<number, Vec3>();
    for (const [entity, cur] of this.cur) {
      const prev = this.prev.get(entity)!;
      out.set(entity, cur.map((c, k) => Math.fround(prev[k]! + Math.fround(frac * Math.fround(c - prev[k]!)))) as Vec3);
    }
    return out;
  }
}
