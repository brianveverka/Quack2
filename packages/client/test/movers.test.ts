// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { levelTimeAt, parseBsp, parseEntities, stepPusher } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { doorMovers } from "../src/bmodels.js";
import { BrushMotion, networkCoord } from "../src/movers.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));

// Fixture model 1 spreads to a 66 66 50 entity: a door moving up travels 50 - lip 8 = 42,
// one along +X 66 - 8 = 58.
const motion = (src: string) => {
  const ents = parseEntities(src);
  return new BrushMotion(() => doorMovers(bsp, ents));
};
const at = (m: BrushMotion, ms: number) => Object.fromEntries(m.originsAt(ms));

describe("door movers", () => {
  // A team the second settle frame's trigger_always sends up: the master up 42 at speed
  // 200 (100 doubled in deathmatch), the slave 58 along +X, its speed matched to finish
  // together (Think_CalcMoveSpeed).
  const TEAM = `
    { "classname" "worldspawn" }
    { "classname" "trigger_always" "target" "d" }
    { "classname" "func_door" "model" "*1" "targetname" "d" "angle" "-1" "team" "t" }
    { "classname" "func_door" "model" "*1" "angle" "0" "speed" "50" "team" "t" }
  `;

  it("sets up a team as SP_func_door and Think_CalcMoveSpeed do, and sends it up", () => {
    const teams = doorMovers(bsp, parseEntities(TEAM));
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[2, 3]]);
    const [master, slave] = teams[0]!.map((d) => d.mover);
    expect([master!.distance, master!.speed, master!.wait, master!.toggle]).toEqual([42, 200, 3, false]);
    expect([...master!.endOrigin]).toEqual([0, 0, 42]);
    expect([slave!.distance, slave!.speed, slave!.accel, slave!.decel]).toEqual([58, Math.fround(276.190491), Math.fround(276.190491), Math.fround(276.190491)]);
    // Sent up from the DelayedUse's slot in the second frame: Move_Begin is due in the third.
    expect([master!.state, master!.think, master!.nextthink]).toEqual(["up", "moveBegin", Math.fround(Math.fround(0.2) + 0.1)]);
    expect(slave!.state).toBe("up");
  });

  it("draws the team blended between game frames as the client does", () => {
    // From a gcc (SSE) mirror of SP_func_door, Think_CalcMoveSpeed, Move_Calc and its
    // thinks, SV_Push, MSG_WriteCoord/ReadCoord and CL_AddPacketEntities' lerp. Game
    // frame n is sent with servertime (n - 2) * 100 ms; the team starts moving in frame 3
    // and reaches the top in frame 6, goes down in frame 36 (wait 3) and is home in 39.
    const m = motion(TEAM);
    const want: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [100, 0, 0],
      [150, 10, 13.8125],
      [155, 11, 15.1937504],
      [250, 30, 41.4375],
      [333, 40.6599998, 56.1575012],
      [400, 42, 58],
      [3500, 22, 30.375],
      [3550, 12, 16.5625],
      [3700, 0, 0],
    ];
    for (const [ms, z, x] of want) {
      expect(at(m, ms), `at ${ms} ms`).toEqual({ 2: [0, 0, Math.fround(z)], 3: [Math.fround(x), 0, 0] });
    }
    // cl.time is whole milliseconds.
    expect(at(m, 150.9)).toEqual({ 2: [0, 0, 10], 3: [13.8125, 0, 0] });
    // Going back in time steps again from the settle frames.
    expect(at(m, 150)).toEqual({ 2: [0, 0, 10], 3: [13.8125, 0, 0] });
    expect(at(m, -50)).toEqual({ 2: [0, 0, 0], 3: [0, 0, 0] });
  });

  it("links each door where the frame it draws towards left it", () => {
    const m = motion(TEAM);
    const linked = () => Object.fromEntries(m.linkedOrigins());
    // Stepped by hand to the frame each time draws towards: frame 2 + ceil(ms / 100).
    const frames = (n: number) => {
      const team = doorMovers(bsp, parseEntities(TEAM))[0]!;
      for (let k = 3; k <= n; k++) stepPusher(team.map((d) => d.mover), levelTimeAt(k));
      return Object.fromEntries(team.map((d) => [d.entity, [...d.mover.origin]]));
    };
    m.originsAt(0);
    expect(linked()).toEqual(frames(2));
    m.originsAt(150);
    const frame4 = frames(4);
    expect(linked()).toEqual(frame4);
    // Between frames the drawn origin is blended; at frame 4's own time it is the linked
    // one as sent (SV_Push moves by whole 1/8 units, so the network leaves it as it is).
    expect(at(m, 150)).not.toEqual(frame4);
    expect(at(m, 200)).toEqual(Object.fromEntries(Object.entries(frame4).map(([e, o]) => [e, o.map(networkCoord)])));
    expect(linked()).toEqual(frame4);
    // Going back in time links where the earlier frame left it; the arrays are the caller's.
    m.originsAt(50);
    expect(linked()).toEqual(frames(3));
    m.linkedOrigins().get(2)![2] = 99;
    expect(linked()).toEqual(frames(3));
  });

  it("leaves a door nothing uses at rest", () => {
    const m = motion(`
      { "classname" "worldspawn" }
      { "classname" "func_door" "model" "*1" "angle" "-1" }
    `);
    expect(at(m, 0)).toEqual({ 1: [0, 0, 0] });
    expect(at(m, 5000)).toEqual({ 1: [0, 0, 0] });
  });

  it("starts a START_OPEN door at pos2's far end and sends it back down when toggled", () => {
    // DOOR_TOGGLE (32) | START_OPEN (1): door_use sends a door at STATE_BOTTOM up, to pos2,
    // which START_OPEN made the spawn origin; a toggled func_water is the same.
    const m = motion(`
      { "classname" "worldspawn" }
      { "classname" "trigger_always" "target" "d" }
      { "classname" "func_door" "model" "*1" "targetname" "d" "angle" "-1" "spawnflags" "33" }
    `);
    expect(at(m, 0)).toEqual({ 2: [0, 0, 42] });
    expect(at(m, 200)).toEqual({ 2: [0, 0, 22] });
    expect(at(m, 400)).toEqual({ 2: [0, 0, 0] });
    // DOOR_TOGGLE stays at the top: no wait brings it back.
    expect(at(m, 10000)).toEqual({ 2: [0, 0, 0] });
  });

  it("records a door's move before the targets it fires: a toggle door its own targets use again goes up, then down", () => {
    // door_go_up's Move_Calc runs before G_UseTargets, whose relay uses the door again:
    // DOOR_TOGGLE at STATE_UP then sends it down, from where it already is.
    const src = `
      { "classname" "worldspawn" }
      { "classname" "trigger_always" "target" "d" }
      { "classname" "func_door" "model" "*1" "targetname" "d" "target" "r" "angle" "-1" "spawnflags" "32" }
      { "classname" "trigger_relay" "targetname" "r" "target" "d" }
    `;
    const m = motion(src);
    expect(at(m, 0)).toEqual({ 2: [0, 0, 0] });
    expect(at(m, 5000)).toEqual({ 2: [0, 0, 0] });
    const [door] = doorMovers(bsp, parseEntities(src))[0]!;
    expect(door!.mover.state).toBe("down");
    // Frame 3: Move_Begin finds no distance left and door_hit_bottom runs.
    stepPusher([door!.mover], levelTimeAt(3));
    expect(door!.mover.state).toBe("bottom");
  });

  it("refuses a level time that is not finite, and hands out its own arrays", () => {
    const m = motion(TEAM);
    expect(() => m.originsAt(Infinity)).toThrow(RangeError);
    expect(() => m.originsAt(Number.NaN)).toThrow(RangeError);
    m.originsAt(0).get(2)![2] = 99;
    expect(at(m, 0)).toEqual({ 2: [0, 0, 0], 3: [0, 0, 0] });
  });

  it("takes func_water's speed (default 25, not doubled) and no team speed matching", () => {
    const teams = doorMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_water" "model" "*1" "angle" "-1" "team" "w" }
        { "classname" "func_door" "model" "*1" "angle" "0" "team" "w" "accel" "50" }
      `),
    );
    const [water, door] = teams[0]!.map((d) => d.mover);
    expect([water!.speed, water!.accel, water!.wait, water!.toggle, water!.distance]).toEqual([25, 25, -1, true, 50]);
    expect([door!.speed, door!.accel, door!.decel]).toEqual([200, 50, 200]);
  });

  it("matches speeds for a func_door master, keeping accel's ratio when it differs from speed", () => {
    const teams = doorMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "angle" "-1" "team" "t" }
        { "classname" "func_door" "model" "*1" "angle" "0" "team" "t" "accel" "100" }
      `),
    );
    const slave = teams[0]![1]!.mover;
    const speed = Math.fround(58 / Math.fround(42 / 200));
    expect([slave.speed, slave.accel, slave.decel]).toEqual([speed, Math.fround(100 * Math.fround(speed / 200)), speed]);
  });

  it("leaves out a team with a member that is not a linear door, or a freed master", () => {
    const teams = doorMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "mixed" }
        { "classname" "func_wall" "model" "*1" "team" "mixed" }
        { "classname" "func_door" "model" "*1" "team" "rot" }
        { "classname" "func_door_rotating" "model" "*1" "team" "rot" }
        { "classname" "func_door" "model" "*1" "targetname" "k" "team" "freed" }
        { "classname" "func_door" "model" "*1" "team" "freed" }
        { "classname" "trigger_always" "killtarget" "k" }
        { "classname" "func_door" "model" "*9999" }
        { "classname" "func_door" "model" "*1" "spawnflags" "2048" }
        { "classname" "func_door" "model" "*1" }
      `),
    );
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[10]]);
  });

  it("ends a team's chain at a member a killtarget freed", () => {
    const teams = doorMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "func_door" "model" "*1" "team" "t" "targetname" "k" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "trigger_always" "killtarget" "k" }
      `),
    );
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[1]]);
  });
});

describe("network coordinates", () => {
  it("truncates to 1/8 unit and wraps at 16 bits, as MSG_WriteCoord and MSG_ReadCoord do", () => {
    // gcc mirror: (short)(int)(f*8) * (1.0/8).
    expect([2.762, -2.3, 4096, -4096.1, 0.12, -0.12].map(networkCoord)).toEqual([2.75, -2.25, -4096, -4096, 0, 0]);
  });
});
