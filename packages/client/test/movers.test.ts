// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { levelTimeAt, parseBsp, parseEntities, stepPusher } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { brushModelInstances, brushMovers, openAreaPortals } from "../src/bmodels.js";
import { BrushMotion, lerpAngle, networkAngle, networkCoord, type MoverPose } from "../src/movers.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));

// Fixture model 1 spreads to a 66 66 50 entity: a door moving up travels 50 - lip 8 = 42,
// one along +X 66 - 8 = 58.
const motion = (src: string) => {
  const ents = parseEntities(src);
  return new BrushMotion(() => brushMovers(bsp, ents));
};
const origins = (poses: Map<number, MoverPose>) => Object.fromEntries([...poses].map(([e, p]) => [e, p.origin]));
const angles = (poses: Map<number, MoverPose>) => Object.fromEntries([...poses].map(([e, p]) => [e, p.angles]));
const at = (m: BrushMotion, ms: number) => origins(m.posesAt(ms));

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
    const teams = brushMovers(bsp, parseEntities(TEAM));
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
    const linked = (ms: number) => origins(m.linkedPoses(ms));
    // Stepped by hand to the frame each time draws towards: frame 2 + ceil(ms / 100).
    const frames = (n: number) => {
      const team = brushMovers(bsp, parseEntities(TEAM))[0]!;
      for (let k = 3; k <= n; k++) stepPusher(team.map((d) => d.mover), levelTimeAt(k));
      return Object.fromEntries(team.map((d) => [d.entity, [...d.mover.origin]]));
    };
    expect(linked(0)).toEqual(frames(2));
    const frame4 = frames(4);
    // Asked first or after posesAt, it is the same frame.
    expect(linked(150)).toEqual(frame4);
    m.posesAt(400);
    expect(linked(150)).toEqual(frame4);
    // Between frames the drawn origin is blended; at frame 4's own time it is the linked
    // one as sent (SV_Push moves by whole 1/8 units, so the network leaves it as it is).
    expect(at(m, 150)).not.toEqual(frame4);
    expect(at(m, 200)).toEqual(Object.fromEntries(Object.entries(frame4).map(([e, o]) => [e, o.map(networkCoord)])));
    expect(linked(200)).toEqual(frame4);
    // Going back in time links where the earlier frame left it; the arrays are the caller's.
    expect(linked(50)).toEqual(frames(3));
    m.linkedPoses(50).get(2)!.origin[2] = 99;
    expect(linked(50)).toEqual(frames(3));
    expect(() => m.linkedPoses(Number.NaN)).toThrow(RangeError);
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
    const [door] = brushMovers(bsp, parseEntities(src))[0]!;
    expect(door!.mover.state).toBe("down");
    // Frame 3: Move_Begin finds no distance left and door_hit_bottom runs.
    stepPusher([door!.mover], levelTimeAt(3));
    expect(door!.mover.state).toBe("bottom");
  });

  it("refuses a level time that is not finite, and hands out its own arrays", () => {
    const m = motion(TEAM);
    expect(() => m.posesAt(Infinity)).toThrow(RangeError);
    expect(() => m.posesAt(Number.NaN)).toThrow(RangeError);
    m.posesAt(0).get(2)!.origin[2] = 99;
    m.posesAt(0).get(2)!.angles[1] = 99;
    expect(m.posesAt(0).get(2)).toEqual({ origin: [0, 0, 0], angles: [0, 0, 0] });
    m.posesAt(150).get(2)!.angles[1] = 99;
    expect(m.posesAt(150).get(2)!.angles).toEqual([0, 0, 0]);
  });

  it("takes func_water's speed (default 25, not doubled) and no team speed matching", () => {
    const teams = brushMovers(
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
    const teams = brushMovers(
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

  it("keeps a team's doors, matching speeds over every member as Think_CalcMoveSpeed does", () => {
    const teams = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door_rotating" "model" "*1" "distance" "30.9" "speed" "50" "team" "rot" }
        { "classname" "func_door" "model" "*1" "angle" "-1" "team" "rot" }
        { "classname" "func_button" "model" "*1" "team" "btn" }
        { "classname" "func_door" "model" "*1" "angle" "-1" "team" "btn" }
        { "classname" "func_water" "model" "*1" "angle" "-1" "team" "water" }
        { "classname" "func_button" "model" "*1" "team" "water" }
        { "classname" "func_door_rotating" "model" "*1" "team" "none" }
        { "classname" "func_button" "model" "*1" "team" "none" }
      `),
    );
    // A button master moves with its door slave; button slaves stay where they spawned.
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[1, 2], [3, 4], [5], [7]]);
    const [rot, rotSlave] = teams[0]!.map((d) => d.mover);
    const [btn, btnSlave] = teams[1]!.map((d) => d.mover);
    const [water, unmoving] = teams.slice(2).map((t) => t[0]!.mover);
    // A rotating master's "distance" is an int (30) in degrees and its speed is not doubled.
    expect([rot!.distance, rot!.speed]).toEqual([30, Math.fround(30 / Math.fround(30 / 50))]);
    const speed = Math.fround(42 / Math.fround(30 / 50));
    expect([rotSlave!.speed, rotSlave!.accel, rotSlave!.decel]).toEqual([speed, speed, speed]);
    // A func_button master has no Think_CalcMoveSpeed; a func_water master neither.
    expect([btn!.speed, btnSlave!.speed]).toEqual([40, 200]);
    expect(water!.speed).toBe(25);
    // A rotating master teamed with a button: the button's distance 0 makes it infinite.
    expect(unmoving!.speed).toBe(Infinity);
  });

  it("takes a func_door_rotating master's default distance (90) and speed (100)", () => {
    const teams = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door_rotating" "model" "*1" "team" "rot" }
        { "classname" "func_door" "model" "*1" "angle" "-1" "lip" "-50" "team" "rot" }
      `),
    );
    const [master, slave] = teams[0]!.map((d) => d.mover);
    expect([master!.distance, master!.speed, master!.accel, master!.decel, master!.wait]).toEqual([90, 100, 100, 100, 3]);
    // 50 + 50 up, longer than the 90 degrees that set the team's time at 100 a second.
    expect(slave!.distance).toBe(100);
    expect(slave!.speed).toBe(Math.fround(100 / Math.fround(90 / 100)));
  });

  it("moves a door teamed with a member at no distance all the way in one frame", () => {
    const src = `
      { "classname" "worldspawn" }
      { "classname" "trigger_always" "target" "d" }
      { "classname" "func_door" "model" "*1" "targetname" "d" "angle" "-1" "team" "t" }
      { "classname" "func_button" "model" "*1" "team" "t" }
      { "classname" "func_door" "model" "*1" "angle" "0" "accel" "50" "team" "t" }
    `;
    const teams = brushMovers(bsp, parseEntities(src));
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[2, 4]]);
    const movers = teams[0]!.map((d) => d.mover);
    // The button's moveinfo.distance 0 makes the team's time 0: 42 / 0 is infinite, and
    // so is an accel unlike speed, scaled by the infinite ratio.
    expect(movers.map((m) => [m.speed, m.accel, m.decel])).toEqual([
      [Infinity, Infinity, Infinity],
      [Infinity, Infinity, Infinity],
    ]);
    // Move_Begin in frame 3 goes straight to Move_Final; frame 4 pushes the whole way.
    stepPusher(movers, levelTimeAt(3));
    expect(movers.map((m) => [...m.origin])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    stepPusher(movers, levelTimeAt(4));
    expect(movers.map((m) => [...m.origin])).toEqual([
      [0, 0, 42],
      [58, 0, 0],
    ]);
    expect(movers.map((m) => m.state)).toEqual(["top", "top"]);
  });

  it("links a team with a negative speed where SV_Push's INT_MIN / 8 steps leave it", () => {
    // The master's speed -200 over the button's distance 0 makes the team's time -0.
    const m = motion(`
      { "classname" "worldspawn" }
      { "classname" "trigger_always" "target" "d" }
      { "classname" "func_door" "model" "*1" "targetname" "d" "angle" "-1" "speed" "-100" "team" "t" }
      { "classname" "func_button" "model" "*1" "team" "t" }
      { "classname" "func_door" "model" "*1" "angle" "0" "team" "t" }
    `);
    const step = -268435456;
    expect(origins(m.linkedPoses(200))).toEqual({ 2: [step, step, step], 4: [step, step, step] });
    expect(origins(m.linkedPoses(300))).toEqual({ 2: [2 * step, 2 * step, 2 * step], 4: [2 * step, 2 * step, 2 * step] });
    // Sent as (short)INT_MIN, 0.
    expect(at(m, 250)).toEqual({ 2: [0, 0, 0], 4: [0, 0, 0] });
  });

  it("leaves out a team with a linear door that has no model, or a freed master", () => {
    const teams = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "nomodel" }
        { "classname" "func_water" "model" "*9999" "team" "nomodel" }
        { "classname" "func_door" "model" "*1" "targetname" "k" "team" "freed" }
        { "classname" "func_door" "model" "*1" "team" "freed" }
        { "classname" "trigger_always" "killtarget" "k" }
        { "classname" "func_door" "model" "*9999" }
        { "classname" "func_door" "model" "*1" "spawnflags" "2048" }
        { "classname" "func_door" "model" "*1" }
      `),
    );
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[8]]);
  });

  it("ends a team's chain at a member a killtarget freed", () => {
    const teams = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "func_door" "model" "*1" "team" "t" "targetname" "k" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "func_door" "model" "*1" "team" "u" }
        { "classname" "func_button" "model" "*1" "team" "u" "targetname" "k" }
        { "classname" "func_door" "model" "*1" "team" "u" }
        { "classname" "trigger_always" "killtarget" "k" }
      `),
    );
    expect(teams.map((t) => t.map((d) => d.entity))).toEqual([[1], [4]]);
    // Think_CalcMoveSpeed ran in the first frame, before the second frame's killtarget
    // freed the button, so its distance 0 still set the team's speeds.
    expect(teams[1]![0]!.mover.speed).toBe(Infinity);
  });
});

describe("rotating door movers", () => {
  const rotating = (keys: string) =>
    brushMovers(bsp, parseEntities(`{ "classname" "worldspawn" } { "classname" "func_door_rotating" "model" "*1" ${keys} }`))[0]![0]!.mover;

  it("sets up angles as SP_func_door_rotating does: axis by spawnflags, REVERSE negating, START_OPEN swapping", () => {
    const pose = (m: ReturnType<typeof rotating>) => [[...m.angles], [...m.startAngles], [...m.endAngles]];
    const d = rotating(`"origin" "8 16 24" "angles" "10 20 30"`);
    expect([d.rotating, [...d.origin], [...d.startOrigin], [...d.endOrigin], d.state, d.toggle]).toEqual([true, [8, 16, 24], [8, 16, 24], [8, 16, 24], "bottom", false]);
    // s.angles is cleared whatever the map set; yaw by default.
    expect(pose(d)).toEqual([[0, 0, 0], [0, 0, 0], [0, 90, 0]]);
    // X_AXIS (64) turns roll, Y_AXIS (128) pitch; REVERSE (2) negates.
    expect(pose(rotating(`"spawnflags" "64" "distance" "45"`))).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 45]]);
    expect(pose(rotating(`"spawnflags" "130" "distance" "45"`))).toEqual([[0, 0, 0], [0, 0, 0], [-45, 0, 0]]);
    // START_OPEN starts at the open angles and goes "up" to 0 0 0.
    expect(pose(rotating(`"spawnflags" "3"`))).toEqual([[0, -90, 0], [0, -90, 0], [0, 0, 0]]);
    const fast = rotating(`"speed" "30" "accel" "5" "wait" "-1" "spawnflags" "32"`);
    expect([fast.speed, fast.accel, fast.decel, fast.wait, fast.toggle]).toEqual([30, 5, 30, -1, true]);
  });

  it("starts a door in a turret's team turned by the breach's yaw, as it is drawn at rest", () => {
    // The breach (yaw 350 clamped into 10..100) turns its team 20 degrees in the settle frames.
    for (const door of [`"func_door" "angle" "-1"`, `"func_door_rotating"`]) {
      const ents = parseEntities(`
        { "classname" "worldspawn" }
        { "classname" ${door} "model" "*1" "team" "t" }
        { "classname" "turret_breach" "model" "*1" "team" "t" "angle" "350" "minyaw" "10" "maxyaw" "100" }
      `);
      const placed = brushModelInstances(bsp, ents).instances.find((b) => b.entity === 1)!;
      expect(placed.angles).toEqual([0, 20, 0]);
      const m = new BrushMotion(() => brushMovers(bsp, ents));
      expect(m.linkedPoses(0).get(1)!.angles).toEqual([0, 20, 0]);
      expect(m.posesAt(0).get(1)!.angles).toEqual([0, 19.6875, 0]);
    }
  });

  const DOOR = `
    { "classname" "worldspawn" }
    { "classname" "trigger_always" "target" "d" }
    { "classname" "func_door_rotating" "model" "*1" "targetname" "d" "origin" "8 0 0" }
  `;

  it("turns 90 degrees at 100 a second as AngleMove_Calc does, waits 3 seconds and turns back", () => {
    const team = brushMovers(bsp, parseEntities(DOOR))[0]!.map((d) => d.mover);
    const door = team[0]!;
    // Sent up from the DelayedUse's slot in the second frame: AngleMove_Begin is due in the third.
    expect([door.state, door.think, door.nextthink]).toEqual(["up", "angleMoveBegin", Math.fround(Math.fround(0.2) + 0.1)]);
    const yaw: number[] = [];
    const state: string[] = [];
    for (let f = 3; f <= 52; f++) {
      stepPusher(team, levelTimeAt(f));
      yaw[f] = door.angles[1];
      state[f] = door.state;
      expect([...door.origin]).toEqual([8, 0, 0]);
    }
    // traveltime 0.9f / FRAMETIME floors to 8 frames, so AngleMove_Final turns the last
    // 10 degrees in frame 12 and AngleMove_Done runs door_hit_top after it. avelocity is
    // 90 * (float)(1 / 0.9f), a little over 100, so the float angles drift above whole tens.
    expect(yaw.slice(3, 13)).toEqual(
      [0, 10.000000953674316, 20.000001907348633, 30.000003814697266, 40.000003814697266, 50.000003814697266, 60.000003814697266, 70.00000762939453, 80.00000762939453, 90],
    );
    expect([state[11], state[12]]).toEqual(["up", "top"]);
    // door_hit_top at 1.2 sets door_go_down for 4.2 (frame 42), which turns at once.
    expect([yaw[42], yaw[43], yaw[50], yaw[51], yaw[52]]).toEqual([90, 80, 9.999999046325684, 0, 0]);
    expect([state[41], state[42], state[50], state[51]]).toEqual(["top", "down", "down", "bottom"]);
  });

  it("draws the door's angles as sent (360/256 degree steps) and blended by LerpAngle, and links it at its exact angles", () => {
    const m = motion(DOOR);
    const drawn = (ms: number) => angles(m.posesAt(ms))[2];
    // Frame 4's 10 degrees go out as byte 7: 9.84375.
    expect([0, 100, 150, 200, 950, 1000, 5000].map(drawn)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 4.921875, 0],
      [0, 9.84375, 0],
      [0, 84.375, 0],
      [0, 90, 0],
      [0, 0, 0],
    ]);
    expect(origins(m.posesAt(150))).toEqual({ 2: [8, 0, 0] });
    expect(m.linkedPoses(150).get(2)).toEqual({ origin: [8, 0, 0], angles: [0, 10.000000953674316, 0] });
    expect(m.linkedPoses(950).get(2)!.angles).toEqual([0, 90, 0]);
  });

  it("blends the short way round where the network wraps 180 to -180", () => {
    // 200 degrees at 100 a second: 170 in frame 20, 180 in frame 21 (sent as -180), 190
    // in frame 22 (sent as -170.15625).
    const m = motion(DOOR.replace('"origin" "8 0 0"', '"distance" "200"'));
    expect([1800, 1900, 2000].map((ms) => m.linkedPoses(ms).get(2)!.angles[1])).toEqual([170, 180, 190]);
    // LerpAngle takes -180 back up to 180 coming from 168.75, and from -180 on it blends
    // between the sent angles.
    expect([1800, 1850, 1900, 1950, 2000].map((ms) => angles(m.posesAt(ms))[2]![1])).toEqual([168.75, 174.375, 180, -175.078125, -170.15625]);
  });
});

describe("area portals of doors coming back down", () => {
  const portalsMotion = (src: string) => {
    const ents = parseEntities(src);
    return new BrushMotion(() => brushMovers(bsp, ents), openAreaPortals(ents));
  };
  const open = (m: BrushMotion, ms: number) => [...m.openPortalsAt(ms)].sort((a, b) => a - b);
  // The team of "door movers" above, home in game frame 39, which client times 3601 to
  // 3700 draw towards. The master's "target" names portal 1, and portal 3 through a
  // targetname in another case, which a START_OPEN door (never moving) also opens; the
  // slave's names portal 2. A trigger_always opens portal 5, which no door names.
  const PORTALS = `
    { "classname" "worldspawn" }
    { "classname" "trigger_always" "target" "d" }
    { "classname" "func_door" "model" "*1" "targetname" "d" "target" "p" "angle" "-1" "team" "t" }
    { "classname" "func_door" "model" "*1" "target" "q" "angle" "0" "speed" "50" "team" "t" }
    { "classname" "func_areaportal" "targetname" "p" "style" "1" }
    { "classname" "func_areaportal" "targetname" "q" "style" "2" }
    { "classname" "func_door" "model" "*1" "origin" "2000 0 0" "target" "s" "spawnflags" "1" }
    { "classname" "func_areaportal" "targetname" "s" "style" "3" }
    { "classname" "func_areaportal" "targetname" "P" "style" "3" }
    { "classname" "trigger_always" "target" "s5" }
    { "classname" "func_areaportal" "targetname" "s5" "style" "5" }
  `;
  // A later trigger_always frees the master's portal entities after it opened them.
  const FREED = `${PORTALS}{ "classname" "trigger_always" "killtarget" "p" }`;

  it("gives each door the portals door_use_areaportals finds, in G_Find order", () => {
    const portals = (src: string) => brushMovers(bsp, parseEntities(src)).map((t) => t.map((d) => [d.entity, d.portals]));
    expect(portals(PORTALS)).toEqual([
      [
        [2, [1, 3]],
        [3, [2]],
      ],
      [[6, [3]]],
    ]);
    expect(portals(FREED)[0]).toEqual([
      [2, []],
      [3, [2]],
    ]);
  });

  it("closes them in the frame each door reaches the bottom, whoever opened them, and opens them again going back in time", () => {
    const m = portalsMotion(PORTALS);
    expect(open(m, 0)).toEqual([1, 2, 3, 5]);
    expect(open(m, 3600)).toEqual([1, 2, 3, 5]);
    expect(open(m, 3601)).toEqual([5]);
    expect(open(m, 60000)).toEqual([5]);
    expect(open(m, 100)).toEqual([1, 2, 3, 5]);
  });

  it("leaves open the portals whose entities a killtarget freed", () => {
    const m = portalsMotion(FREED);
    expect(open(m, 0)).toEqual([1, 2, 3, 5]);
    expect(open(m, 3601)).toEqual([1, 3, 5]);
  });

  it("hands out a set that later frames do not change", () => {
    const m = portalsMotion(PORTALS);
    const before = m.openPortalsAt(0);
    expect(m.openPortalsAt(3600)).toBe(before);
    expect(m.openPortalsAt(3601)).not.toBe(before);
    expect([...before].sort()).toEqual([1, 2, 3, 5]);
  });
});

describe("network angles", () => {
  it("send a byte of 360/256 degrees, truncated, read back signed, as MSG_WriteAngle and MSG_ReadAngle do", () => {
    expect([0, 1.4, 1.41, 10, -10, 90, 180, 270, 359, 360, 450, -180.5].map(networkAngle)).toEqual([
      0, 0, 1.40625, 9.84375, -9.84375, 90, -180, -90, -1.40625, 0, 90, -180,
    ]);
  });

  it("lerp the short way round, in float, as LerpAngle does", () => {
    expect(lerpAngle(170, -170, 0.5)).toBe(180);
    expect(lerpAngle(-170, 170, 0.5)).toBe(-180);
    expect(lerpAngle(0, 90, 0.25)).toBe(22.5);
    expect(lerpAngle(0, 0.1, 1)).toBe(Math.fround(0.1));
    // From a gcc (SSE) build of LerpAngle: every step rounds to float (all in double
    // the first would be 14.148000452041629).
    expect(lerpAngle(Math.fround(10.3), Math.fround(20.7), Math.fround(0.37))).toBe(14.148000717163086);
    expect(lerpAngle(Math.fround(170.3), Math.fround(-171.1), Math.fround(1 - (300 - 237) * 0.01))).toBe(177.1820068359375);
    // Here the double product rounds once less and lands on 30.58589744567871.
    expect(lerpAngle(34.940181732177734, 26.91077423095703, 0.5422919988632202)).toBe(30.585899353027344);
    // And here a1 - a2 left in double gives 34.180824279785156.
    expect(lerpAngle(56.886077880859375, 0.000978014781139791, 0.39914241433143616)).toBe(34.18082046508789);
  });
});

describe("network coordinates", () => {
  it("truncates to 1/8 unit and wraps at 16 bits, as MSG_WriteCoord and MSG_ReadCoord do", () => {
    // gcc mirror: (short)(int)(f*8) * (1.0/8).
    expect([2.762, -2.3, 4096, -4096.1, 0.12, -0.12].map(networkCoord)).toEqual([2.75, -2.25, -4096, -4096, 0, 0]);
  });

  it("sends 0 past int's range, where an SSE build's (int) gives INT_MIN", () => {
    // gcc (SSE) mirror as above. -536870848 * 8 wraps to 512 in ToInt32.
    expect([-536870848, Math.fround(-268435456 + 8.5), Number.NaN, -Infinity, Infinity].map(networkCoord)).toEqual([0, 16, 0, 0, 0]);
  });
});

describe("plat movers", () => {
  // Fixture model 1 spreads to 50 units high: a plat drops 50 - lip 8 = 42.
  const PLAT = `
    { "classname" "worldspawn" }
    { "classname" "trigger_always" "target" "p" }
    { "classname" "func_plat" "model" "*1" "targetname" "p" }
  `;

  it("sets up a plat as SP_func_plat does: a targeted one at the top, any other at the bottom", () => {
    const [top, low, keyed] = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_plat" "model" "*1" "targetname" "never" "origin" "0 0 8" }
        { "classname" "func_plat" "model" "*1" }
        { "classname" "func_plat" "model" "*1" "speed" "33" "accel" "10" "decel" "30" "height" "20" "lip" "4" }
      `),
    ).map((t) => t[0]!.mover);
    expect([[...top!.origin], [...top!.startOrigin], [...top!.endOrigin], top!.state]).toEqual([[0, 0, 8], [0, 0, 8], [0, 0, -34], "up"]);
    expect([top!.speed, top!.accel, top!.decel, top!.distance]).toEqual([20, 5, 5, 0]);
    expect([[...low!.origin], low!.state]).toEqual([[0, 0, -42], "bottom"]);
    // "height" wins over "lip"; the speeds are a tenth of the keys, rounded to float.
    expect([keyed!.endOrigin[2], keyed!.speed, keyed!.accel, keyed!.decel]).toEqual([-20, Math.fround(3.3), 1, 3]);
  });

  it("drops a plat a use sends down as Think_AccelMove does, stopping 1/8 short, also when used twice", () => {
    // Expected values: g_func.c's plat_CalcAcceleratedMove and plat_Accelerate compiled
    // with gcc (SSE float), stepped through SV_Push's 1/8 unit snap, measured 2026-10-04.
    for (const src of [PLAT, `${PLAT}{ "classname" "trigger_always" "target" "p" }`]) {
      const teams = brushMovers(bsp, parseEntities(src));
      expect(teams.map((t) => t.map((d) => [d.entity, d.portals]))).toEqual([[[2, []]]]);
      const p = teams[0]![0]!.mover;
      expect([p.state, p.endfunc, p.think, p.nextthink]).toEqual(["down", "platHitBottom", "thinkAccelMove", Math.fround(Math.fround(0.2) + 0.1)]);
      const m = motion(src);
      const z = (ms: number) => m.linkedPoses(ms).get(2)!.origin[2];
      expect([0, 100, 200, 300, 400, 500, 600, 700, 60000].map(z)).toEqual([0, 0, -5, -15, -26.625, -36.375, -41.125, -41.875, -41.875]);
    }
    // A second Use_Plat in the frame returns (its think is set); a second plat_go_down
    // there would give the same frames, so this checks only that nothing changes.
    // Drawn at the top where the map loads, as brushModelInstances places it.
    expect(brushModelInstances(bsp, parseEntities(PLAT)).instances.map((b) => b.origin)).toEqual([[0, 0, 0]]);
  });

  it("moves at a tenth of the speed key per second when speed, accel and decel are equal (Move_Begin)", () => {
    // 50 / 10 = 5, which Move_Begin takes per second: 0.5 a frame from frame 4.
    const src = PLAT.replace('"targetname" "p"', '"targetname" "p" "speed" "50" "accel" "50" "decel" "50"');
    const m = motion(src);
    expect([200, 300, 1000].map((ms) => m.linkedPoses(ms).get(2)!.origin[2])).toEqual([-0.5, -1, -4.5]);
    expect(m.posesAt(1050).get(2)!.origin[2]).toBe(-4.75);
  });

  it("moves a plat in a team of its own, as its own master", () => {
    const m = motion(PLAT.replace('"targetname" "p"', '"targetname" "p" "team" "solo"'));
    expect(m.linkedPoses(700).get(2)!.origin[2]).toBe(-41.875);
  });

  it("moves a plat that masters a team, alone: its slave wall stays", () => {
    const m = motion(PLAT.replace('"targetname" "p"', '"targetname" "p" "team" "t"') + `{ "classname" "func_wall" "model" "*1" "team" "t" }`);
    expect([...m.linkedPoses(700)].map(([e, p]) => [e, p.origin[2]])).toEqual([[2, -41.875]]);
  });

  it("leaves out a plat that is a team slave, and one a killtarget freed", () => {
    const teamed = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "func_plat" "model" "*1" "team" "t" }
      `),
    );
    expect(teamed.map((t) => t.map((d) => d.entity))).toEqual([[1]]);
    expect(brushMovers(bsp, parseEntities(`${PLAT}{ "classname" "trigger_always" "killtarget" "p" }`))).toEqual([]);
  });
});

describe("button movers", () => {
  // Fixture model 1 spreads to 50 units high: a button moving up goes 50 - lip 4 = 46.
  const BUTTON = `
    { "classname" "worldspawn" }
    { "classname" "trigger_always" "target" "b" }
    { "classname" "func_button" "model" "*1" "targetname" "b" "angle" "-1" }
  `;

  it("reads a button's \"lip\" as an int", () => {
    const [b] = brushMovers(bsp, parseEntities(`{ "classname" "worldspawn" }{ "classname" "func_button" "model" "*1" "angle" "-1" "lip" "5.9" }`));
    expect(b![0]!.mover.endOrigin[2]).toBe(45);
  });

  it("sets up a button as SP_func_button does, START_OPEN or not", () => {
    const [plain, keyed] = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_button" "model" "*1" "origin" "0 0 8" }
        { "classname" "func_button" "model" "*1" "angle" "-1" "lip" "10" "speed" "50" "decel" "20" "wait" "-1" "spawnflags" "1" }
      `),
    ).map((t) => t[0]!.mover);
    // Angle 0 moves along +x: 66 wide less lip 4.
    expect([[...plain!.origin], [...plain!.startOrigin], [...plain!.endOrigin], plain!.state]).toEqual([[0, 0, 8], [0, 0, 8], [62, 0, 8], "bottom"]);
    expect([plain!.speed, plain!.accel, plain!.decel, plain!.wait, plain!.distance, plain!.toggle]).toEqual([40, 40, 40, 3, 0, false]);
    expect([[...keyed!.origin], [...keyed!.endOrigin], keyed!.speed, keyed!.accel, keyed!.decel, keyed!.wait]).toEqual([[0, 0, 0], [0, 0, 40], 50, 50, 20, -1]);
  });

  it("moves a button a use fires up and back down after its wait", () => {
    for (const src of [BUTTON, `${BUTTON}{ "classname" "trigger_always" "target" "b" }`]) {
      const teams = brushMovers(bsp, parseEntities(src));
      expect(teams.map((t) => t.map((d) => [d.entity, d.portals]))).toEqual([[[2, []]]]);
      expect([teams[0]![0]!.mover.state, teams[0]![0]!.mover.endfunc]).toEqual(["up", "buttonWait"]);
      const m = motion(src);
      const z = (ms: number) => m.linkedPoses(ms).get(2)!.origin[2];
      expect([0, 100, 200, 1200, 1300, 4300, 4400, 5400, 5500, 60000].map(z)).toEqual([0, 0, 4, 44, 46, 46, 42, 2, 0, 0]);
    }
    expect(brushModelInstances(bsp, parseEntities(BUTTON)).instances.map((b) => b.origin)).toEqual([[0, 0, 0]]);
  });

  it("leaves a button no use fires at rest", () => {
    const m = motion(BUTTON.replace('"target" "b"', '"target" "other"'));
    expect(m.linkedPoses(5000).get(2)?.origin ?? [0, 0, 0]).toEqual([0, 0, 0]);
    const teams = brushMovers(bsp, parseEntities(BUTTON.replace('"target" "b"', '"target" "other"')));
    expect([teams[0]![0]!.mover.state, teams[0]![0]!.mover.think]).toEqual(["bottom", undefined]);
  });

  it("moves a button that masters a team, and leaves out one that is a team slave", () => {
    const m = motion(BUTTON.replace('"angle" "-1"', '"angle" "-1" "team" "t"') + `{ "classname" "func_wall" "model" "*1" "team" "t" }`);
    expect([...m.linkedPoses(1300)].map(([e, p]) => [e, p.origin[2]])).toEqual([[2, 46]]);
    const teamed = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_door" "model" "*1" "team" "t" }
        { "classname" "func_button" "model" "*1" "team" "t" }
      `),
    );
    expect(teamed.map((t) => t.map((d) => d.entity))).toEqual([[1]]);
  });
});

describe("train movers", () => {
  // Fixture model 1's mins are -385 127 -1, so a train's origin is its corner plus 385 -127 1.
  const TRAIN = `
    { "classname" "worldspawn" }
    { "classname" "func_train" "model" "*1" "target" "c1" }
    { "classname" "path_corner" "targetname" "c1" "target" "c2" }
    { "classname" "path_corner" "targetname" "c2" "origin" "0 0 100" "target" "t3" }
    { "classname" "path_corner" "targetname" "t3" "origin" "500 0 0" "target" "c4" "spawnflags" "1" }
    { "classname" "path_corner" "targetname" "c4" "origin" "500 0 50" "wait" "-1" }
  `;

  it("moves a train from corner to corner at its speed, as the settle frames left it", () => {
    const teams = brushMovers(bsp, parseEntities(TRAIN));
    expect(teams.map((t) => t.map((d) => [d.entity, d.portals]))).toEqual([[[1, []]]]);
    const train = teams[0]![0]!.mover;
    // train_next ran in the second frame: Move_Begin set 100 a second up towards c2.
    expect([[...train.origin], [...train.velocity], train.think, train.nextthink]).toEqual([[385, -127, 1], [0, 0, 100], "moveFinal", Math.fround(Math.fround(0.2) + 1)]);
    expect(train.train!.usePathtarget).toBeUndefined();
    const m = motion(TRAIN);
    const z = (ms: number) => m.linkedPoses(ms).get(1)!.origin;
    expect([0, 100, 900].map((ms) => z(ms)[2])).toEqual([1, 11, 91]);
    // Frame 12 arrives at c2, and train_wait's train_next puts it on t3 and heads for c4,
    // which it reaches in frame 17 and stays at.
    expect([z(1000), z(1100), z(1500), z(9000)]).toEqual([
      [885, -127, 1],
      [885, -127, 11],
      [885, -127, 51],
      [885, -127, 51],
    ]);
    expect(brushModelInstances(bsp, parseEntities(TRAIN)).instances.map((b) => b.origin)).toEqual([[385, -127, 1]]);
  });

  it("does not blend a train across the frame it teleports in (EV_OTHER_TELEPORT)", () => {
    // Client times 901 to 1000 draw towards game frame 12, where it teleports: not
    // blended from frame 11's z 91, it is drawn where it lands all through them.
    const m = motion(TRAIN);
    expect([850, 901, 950, 1000, 1050].map((ms) => at(m, ms)[1])).toEqual([
      [385, -127, 86],
      [885, -127, 1],
      [885, -127, 1],
      [885, -127, 1],
      [885, -127, 6],
    ]);
    // Going back in time and forward again draws the same.
    expect(at(m, 880)[1]).toEqual([385, -127, 89]);
    expect(at(m, 980)[1]).toEqual([885, -127, 1]);
  });

  it("leaves out a train that is a team slave, one a killtarget freed, and one with no inline model", () => {
    const ids = (src: string) => brushMovers(bsp, parseEntities(src)).map((t) => t.map((d) => d.entity));
    expect(ids(TRAIN.replace('"target" "c1"', '"target" "c1" "team" "t"') + `{ "classname" "func_wall" "model" "*1" "team" "t" }`)).toEqual([[1]]);
    expect(ids(`{ "classname" "worldspawn" }{ "classname" "func_wall" "model" "*1" "team" "t" }` + TRAIN.replace('{ "classname" "worldspawn" }', "").replace('"target" "c1"', '"target" "c1" "team" "t"'))).toEqual([]);
    expect(ids(`${TRAIN}{ "classname" "trigger_always" "killtarget" "tr" }`.replace('"target" "c1"', '"target" "c1" "targetname" "tr"'))).toEqual([]);
    expect(ids(TRAIN.replace('"model" "*1" ', ""))).toEqual([]);
  });

  it("reads a train its target names as a corner by its live origin and target", () => {
    // func_train_find left the second train on p (z 300 less mins) with its target
    // stepped on to q; the first train's train_next heads there and takes q as its next.
    const train = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "func_train" "model" "*1" "target" "a1" }
        { "classname" "path_corner" "targetname" "a1" "target" "tb" }
        { "classname" "func_train" "model" "*1" "targetname" "tb" "target" "p" }
        { "classname" "path_corner" "targetname" "p" "origin" "0 0 300" "target" "q" }
        { "classname" "path_corner" "targetname" "q" "origin" "0 0 600" }
      `),
    )[0]![0]!.mover;
    expect([[...train.train!.targetEnt!.origin], train.train!.target, [...train.endOrigin]]).toEqual([[385, -127, 301], "q", [770, -254, 302]]);
  });

  it("reads a START_ON train named as a corner as a TELEPORT one (spawnflags bit 1)", () => {
    // The trigger_always runs the second train's train_next first, setting START_ON: the
    // first train jumps to it and, its target stepped past q, stops there.
    const train = brushMovers(
      bsp,
      parseEntities(`
        { "classname" "worldspawn" }
        { "classname" "trigger_always" "target" "tb" }
        { "classname" "func_train" "model" "*1" "targetname" "tb" "target" "p" }
        { "classname" "func_train" "model" "*1" "target" "a1" }
        { "classname" "path_corner" "targetname" "a1" "target" "tb" }
        { "classname" "path_corner" "targetname" "p" "origin" "0 0 300" "target" "q" }
        { "classname" "path_corner" "targetname" "q" "origin" "0 0 600" }
      `),
    )[1]![0]!.mover;
    expect([[...train.origin], train.teleported, train.train!.target, train.train!.targetEnt, train.nextthink]).toEqual([[770, -254, 302], true, undefined, undefined, 0]);
  });

  it("puts the train's mins on the corners in float, so corners its mins round together lie at no distance", () => {
    // 385.00001 rounds to 385 in float: with the fixture's mins the second corner is
    // where the train already is, so train_wait fires its pathtarget in the second frame.
    const src = `
      { "classname" "worldspawn" }
      { "classname" "func_train" "model" "*1" "target" "a" }
      { "classname" "path_corner" "targetname" "a" "target" "b" }
      { "classname" "path_corner" "targetname" "b" "origin" "0.00001 0 0" "pathtarget" "p" }
      { "classname" "func_areaportal" "targetname" "p" "style" "1" }
    `;
    const ents = parseEntities(src);
    expect([...openAreaPortals(ents, bsp)]).toEqual([1]);
    expect([...openAreaPortals(ents)]).toEqual([]);
    const train = brushMovers(bsp, ents)[0]![0]!.mover;
    expect([[...train.origin], [...train.velocity], train.nextthink]).toEqual([[385, -127, 1], [0, 0, 0], 0]);
  });
});

describe("func_rotating movers", () => {
  const f = Math.fround;
  const W = `{ "classname" "worldspawn" }`;
  const rotor = (keys: string) => `{ "classname" "func_rotating" "model" "*1" ${keys} }`;
  const movers = (src: string) => brushMovers(bsp, parseEntities(src)).map((t) => t.map((d) => [d.entity, [...d.mover.avelocity], [...d.mover.angles]]));
  /** The yaw after `frames` frames at 10 degrees a frame (100 * 0.1f) from `yaw`, in float. */
  const turned = (yaw: number, frames: number) => {
    let a = f(yaw);
    for (let k = 0; k < frames; k++) a = f(a + f(100 * f(0.1)));
    return a;
  };

  it("spins a START_ON one from spawn, turned by both settle frames, about the axis its spawnflags pick", () => {
    expect(movers(W + rotor(`"spawnflags" "1" "angles" "0 5.5 0"`))).toEqual([[[1, [0, 100, 0], [0, turned(5.5, 2), 0]]]]);
    // X_AXIS turns the roll, Y_AXIS the pitch; REVERSE negates; "speed" sets the rate.
    expect(movers(W + rotor(`"spawnflags" "5" "speed" "45"`))).toEqual([[[1, [0, 0, 45], [0, 0, f(2 * f(45 * f(0.1)))]]]]);
    expect(movers(W + rotor(`"spawnflags" "9"`))).toEqual([[[1, [100, 0, 0], [20, 0, 0]]]]);
    expect(movers(W + rotor(`"spawnflags" "3"`))).toEqual([[[1, [-0, -100, -0], [0, -20, 0]]]]);
    // MOVETYPE_STOP moves the same.
    expect(movers(W + rotor(`"spawnflags" "33"`))).toEqual([[[1, [0, 100, 0], [0, 20, 0]]]]);
  });

  it("leaves one without START_ON at its spawn angles, a mover still", () => {
    expect(movers(W + rotor(`"angles" "1 2 3"`))).toEqual([[[1, [0, 0, 0], [1, 2, 3]]]]);
  });

  it("toggles it on a use in the second frame, before or after its own push by slot order (rotating_use)", () => {
    const use = `{ "classname" "trigger_always" "target" "r" }`;
    // The DelayedUse lies right after its trigger_always: before the rotor, it stops a
    // START_ON one before its second push, and starts another in time for it.
    expect(movers(W + use + rotor(`"targetname" "r" "spawnflags" "1"`))).toEqual([[[2, [0, 0, 0], [0, 10, 0]]]]);
    expect(movers(W + use + rotor(`"targetname" "r"`))).toEqual([[[2, [0, 100, 0], [0, 10, 0]]]]);
    // After the rotor: both frames' pushes have run.
    expect(movers(W + rotor(`"targetname" "r" "spawnflags" "1"`) + use)).toEqual([[[1, [0, 0, 0], [0, 20, 0]]]]);
    expect(movers(W + rotor(`"targetname" "r"`) + use)).toEqual([[[1, [0, 100, 0], [0, 0, 0]]]]);
    // A relay and a second use toggle it twice.
    const twice = `{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_always" "target" "r" }`;
    expect(movers(W + twice + rotor(`"targetname" "r" "spawnflags" "1"`))).toEqual([[[3, [0, 100, 0], [0, 20, 0]]]]);
 
    // A member's think in its master's slot runs after the master's push (SV_Physics_Pusher):
    // the DelayedUse sets the explosion due in this frame, and it stops the rotor a push late.
    const explode = `{ "classname" "trigger_always" "target" "e" }
      ${rotor(`"targetname" "r" "spawnflags" "1" "team" "t"`)}
      { "classname" "target_explosion" "targetname" "e" "target" "r" "delay" "0.0005" "team" "t" }`;
    expect(movers(W + explode)).toEqual([[[2, [0, 0, 0], [0, 20, 0]]]]);
  });

  it("is drawn where the settle frames turned it, then turning, blended by LerpAngle from network angles", () => {
    const ents = parseEntities(W + rotor(`"spawnflags" "1"`));
    expect(brushModelInstances(bsp, ents).instances[0]!.angles).toEqual([0, 20, 0]);
    const m = new BrushMotion(() => brushMovers(bsp, ents));
    expect(angles(m.posesAt(0))[1]).toEqual([0, networkAngle(20), 0]);
    expect(angles(m.posesAt(50))[1]![1]).toBe(lerpAngle(networkAngle(20), networkAngle(30), f(0.5)));
    expect(angles(m.posesAt(3600))[1]![1]).toBe(networkAngle(turned(0, 38)));
    expect(m.linkedPoses(3600).get(1)!.angles[1]).toBe(turned(0, 38));
  });

  it("turns a master with its door slaves, and leaves a slave or a turret team's member out", () => {
    // The trigger_always uses the slave door, which door_use ignores for a slave.
    const team =
      W + rotor(`"spawnflags" "1" "team" "t"`) + `{ "classname" "func_door" "model" "*1" "team" "t" "targetname" "d" } { "classname" "trigger_always" "target" "d" }`;
    expect(brushMovers(bsp, parseEntities(team)).map((t) => t.map((d) => d.entity))).toEqual([[1, 2]]);
    // So the door slave stays at the bottom with no think, and Think_CalcMoveSpeed runs only
    // for a door master, so it keeps its own speed (100 doubled).
    const door = brushMovers(bsp, parseEntities(team))[0]![1]!.mover;
    expect([door.state, door.speed, door.think, [...door.origin]]).toEqual(["bottom", 200, undefined, [0, 0, 0]]);
    // A slave turns only through its master's pusher walk, not modeled here.
    const slave = W + `{ "classname" "func_wall" "model" "*1" "team" "t" }` + rotor(`"spawnflags" "1" "team" "t"`);
    expect(movers(slave)).toEqual([]);
    expect(brushModelInstances(bsp, parseEntities(slave)).instances[1]!.angles).toEqual([0, 0, 0]);
    // turret_breach_think sets every member's yaw velocity.
    const breach = W + rotor(`"spawnflags" "1" "team" "t"`) + `{ "classname" "turret_breach" "model" "*1" "team" "t" "target" "x" }`;
    expect(movers(breach)).toEqual([]);
    // A killtarget frees it.
    expect(movers(W + rotor(`"spawnflags" "1" "targetname" "r"`) + `{ "classname" "trigger_always" "killtarget" "r" }`)).toEqual([]);
  });
});
