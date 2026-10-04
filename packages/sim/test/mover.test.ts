// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { calcMoveSpeed, doorGoUp, levelTimeAt, linearMover, stepPusher, type LinearMover, type LinearMoverInit } from "../src/mover.js";

// A deathmatch func_door: speed 100 doubled, accel and decel default to it, wait 3.
const door = (over: Partial<LinearMoverInit> = {}): LinearMover =>
  linearMover({
    origin: [0, 0, 0],
    startOrigin: [0, 0, 0],
    endOrigin: [0, 0, 120],
    distance: 120,
    speed: 200,
    accel: 200,
    decel: 200,
    wait: 3,
    toggle: false,
    state: "bottom",
    ...over,
  });

/** Steps frames from+1 .. to, recording each frame's z and state after it ran. */
function run(team: LinearMover[], from: number, to: number): { z: number[]; state: string[] }[] {
  const out: { z: number[]; state: string[] }[] = [];
  for (let f = from + 1; f <= to; f++) {
    stepPusher(team, levelTimeAt(f));
    out[f] = { z: team.map((m) => m.origin[2]), state: team.map((m) => m.state) };
  }
  return out;
}

describe("linear door mover", () => {
  it("starts a frame late when another entity's use sends it up, and goes back down after wait", () => {
    const d = door();
    doorGoUp(d, levelTimeAt(2), false);
    const r = run([d], 2, 50);
    // Frame 3 runs Move_Begin after the push, so the first move is frame 4: 20 units a frame.
    expect(r[3]!.z[0]).toBe(0);
    expect([4, 5, 6, 7, 8, 9].map((f) => r[f]!.z[0])).toEqual([20, 40, 60, 80, 100, 120]);
    // Move_Begin left no remaining distance (6 frames of 20), so Move_Final runs
    // Move_Done in the frame the door arrives.
    expect(r[8]!.state[0]).toBe("up");
    expect(r[9]!.state[0]).toBe("top");
    // door_hit_top at 0.9 sets door_go_down for 3.9 (frame 39); it starts at once.
    expect(r[38]!.state[0]).toBe("top");
    expect(r[39]!.state[0]).toBe("down");
    expect(r[39]!.z[0]).toBe(120);
    expect([40, 45].map((f) => r[f]!.z[0])).toEqual([100, 0]);
    expect(r[44]!.state[0]).toBe("down");
    expect(r[45]!.state[0]).toBe("bottom");
    expect(r[50]!.z[0]).toBe(0);
  });

  it("moves a remainder under one frame's move in one more frame", () => {
    // 130 at 20 a frame: 6 whole frames, then Move_Final sets the last 10 for the next
    // frame's push, and Move_Done runs after it.
    const d = door({ distance: 130, endOrigin: [0, 0, 130] });
    doorGoUp(d, levelTimeAt(2), false);
    const r = run([d], 2, 12);
    expect([9, 10].map((f) => r[f]!.z[0])).toEqual([120, 130]);
    expect([9, 10, 11].map((f) => r[f]!.state[0])).toEqual(["up", "top", "top"]);
  });

  it("moves the next frame when its own team is running (Move_Begin at once)", () => {
    const d = door();
    doorGoUp(d, levelTimeAt(2), true);
    const r = run([d], 2, 3);
    expect(r[3]!.z[0]).toBe(20);
  });

  it("stays at the top when DOOR_TOGGLE or a negative wait", () => {
    for (const over of [{ toggle: true }, { wait: -1 }]) {
      const d = door(over);
      doorGoUp(d, levelTimeAt(1), false);
      const r = run([d], 1, 100);
      expect(r[100]!.state[0]).toBe("top");
      expect(r[100]!.z[0]).toBe(120);
    }
  });

  it("resets the top wait when sent up again at the top", () => {
    const d = door();
    doorGoUp(d, levelTimeAt(1), false);
    run([d], 1, 20);
    expect(d.state).toBe("top");
    const due = d.nextthink;
    doorGoUp(d, levelTimeAt(20), false);
    expect(d.nextthink).toBe(Math.fround(levelTimeAt(20) + 3));
    expect(d.nextthink).not.toBe(due);
    expect(d.state).toBe("top");
  });

  it("ignores a second go up while going up", () => {
    const d = door();
    doorGoUp(d, levelTimeAt(1), false);
    run([d], 1, 4);
    const before = { nextthink: d.nextthink, think: d.think, v: [...d.velocity] };
    doorGoUp(d, levelTimeAt(4), false);
    expect({ nextthink: d.nextthink, think: d.think, v: [...d.velocity] }).toEqual(before);
  });

  it("clamps each push to 1/8 unit as SV_Push does", () => {
    // 33 * 0.1f = 3.3: 26.4 eighths, truncated after adding 0.5, is 26.
    const d = door({ speed: 33, accel: 33, decel: 33, distance: 100, endOrigin: [0, 0, 100] });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 3);
    expect([r[2]!.z[0], r[3]!.z[0]]).toEqual([3.25, 6.5]);
  });

  // SP_func_door turns wait 0 into 3; a mover can still hold 0, and door_hit_top takes it.
  it("goes down the frame after reaching the top with wait 0", () => {
    const d = door({ wait: 0 });
    doorGoUp(d, levelTimeAt(2), false);
    const r = run([d], 2, 11);
    expect([9, 10, 11].map((f) => r[f]!.state[0])).toEqual(["top", "down", "down"]);
    expect(r[11]!.z[0]).toBe(100);
  });

  it("rounds the move as floats the way the C stores them", () => {
    // Move_Begin's (remaining / speed) is a float: 224.4 / 20.4 rounds to 11 s as a float,
    // so 110 frames; as a double it is a hair under 11, and 109.
    const a = door({ speed: 20.4, accel: 20.4, decel: 20.4, distance: 224.4, endOrigin: [0, 0, 224.4] });
    doorGoUp(a, levelTimeAt(1), true);
    expect(a.nextthink).toBe(Math.fround(levelTimeAt(1) + 110 * 0.1));
    // Move_Final's velocity is the float remaining / FRAMETIME, scaled by the float dir.
    const b = door({ endOrigin: [8.36, 0, 4.19] });
    doorGoUp(b, levelTimeAt(1), true);
    expect([...b.velocity]).toEqual([83.5999984741211, 0, 41.900001525878906]);
    // SV_Push: 0.62499994 * 0.1f is 0.0625 - 2^-28 as a float, temp 0.5 - 2^-25, and
    // temp + 0.5 lies halfway between floats and rounds to 1.0f (a double truncates to 0).
    const c = door({ distance: 0.0625, endOrigin: [0, 0, 0.0624999925494194] });
    doorGoUp(c, levelTimeAt(1), true);
    expect(c.velocity[2]).toBe(0.6249999403953552);
    stepPusher([c], levelTimeAt(2));
    expect(c.origin[2]).toBe(0.125);
  });

  it("leaves an accelerative mover where it is (Think_AccelMove is not ported)", () => {
    const d = door({ accel: 50 });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 30);
    expect(r[30]!.z[0]).toBe(0);
    expect(r[30]!.state[0]).toBe("up");
  });
});

describe("calcMoveSpeed", () => {
  it("gives infinite speeds when a member has no distance, and that member NaN", () => {
    const team = [
      { distance: 42, speed: 200, accel: 200, decel: 100 },
      { distance: 0, speed: 40, accel: 40, decel: 40 },
    ];
    calcMoveSpeed(team);
    expect(team.map((m) => [m.speed, m.accel, m.decel])).toEqual([
      [Infinity, Infinity, Infinity],
      [NaN, NaN, NaN],
    ]);
  });

  it("gives every member the speed that ends the team's moves together", () => {
    const master = door();
    const slave = door({ distance: 60, endOrigin: [0, 0, 60] });
    calcMoveSpeed([master, slave]);
    // Shortest move 60 at 200 takes 0.3 s; 120 in that time is 400 (as floats).
    expect(slave.speed).toBe(Math.fround(60 / Math.fround(60 / 200)));
    expect(master.speed).toBe(Math.fround(120 / Math.fround(60 / 200)));
    expect(master.speed).toBeCloseTo(400, 3);
    expect([master.accel, master.decel]).toEqual([master.speed, master.speed]);
    doorGoUp(master, levelTimeAt(1), true);
    doorGoUp(slave, levelTimeAt(1), true);
    const r = run([master, slave], 1, 10);
    expect(r[4]!.z).toEqual([120, 60]);
  });

  it("scales an accel that differs from speed by the speed ratio", () => {
    const master = door({ accel: 100 });
    const slave = door({ distance: 60, endOrigin: [0, 0, 60] });
    calcMoveSpeed([master, slave]);
    expect(master.accel).toBe(Math.fround(100 * Math.fround(master.speed / 200)));
    expect(master.decel).toBe(master.speed);
  });
});
