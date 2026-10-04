// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import {
  calcMoveSpeed,
  doorGoDown,
  doorGoUp,
  levelTimeAt,
  brushMover,
  platGoDown,
  platGoUp,
  stepPusher,
  type BrushMover,
  type BrushMoverInit,
} from "../src/mover.js";

// A deathmatch func_door: speed 100 doubled, accel and decel default to it, wait 3.
const door = (over: Partial<BrushMoverInit> = {}): BrushMover =>
  brushMover({
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
function run(team: BrushMover[], from: number, to: number): { z: number[]; state: string[] }[] {
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

  // Expected values below are the original g_func.c functions compiled with gcc (SSE
  // float) and stepped through SV_Push's 1/8 unit snap, measured 2026-10-04.
  it("accelerates and decelerates a plat-like mover (Think_AccelMove)", () => {
    // A func_plat's per-frame speed 20, accel 5, decel 5 (its keys times 0.1).
    const d = door({ speed: 20, accel: 5, decel: 5, distance: 100, endOrigin: [0, 0, 100] });
    doorGoUp(d, levelTimeAt(1), true);
    expect(d.think).toBe("thinkAccelMove");
    const r = run([d], 1, 11);
    // The first think sets 5 a frame; it moves from the next frame.
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map((f) => r[f]!.z[0])).toEqual([0, 5, 15, 30, 50, 70, 85, 95, 100]);
    expect([9, 10].map((f) => r[f]!.state[0])).toEqual(["up", "top"]);
    expect(d.decelDistance).toBe(50);
  });

  it("averages the speed of a move that crosses the decel distance (next_speed)", () => {
    const d = door({ speed: 20, accel: 5, decel: 3, distance: 46, endOrigin: [0, 0, 46] });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 4);
    expect([d.moveSpeed, d.decelDistance]).toEqual([Math.fround(11.3920879), Math.fround(27.3259869)]);
    expect([d.currentSpeed, d.nextSpeed]).toEqual([Math.fround(11.1627979), Math.fround(9.38034534)]);
    r.push(...run([d], 4, 10).slice(5));
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map((f) => r[f]!.z[0])).toEqual([0, 5, 15, 26.125, 35.5, 41.875, 45.25, 45.625, 46]);
    expect(r[10]!.state[0]).toBe("top");
  });

  it("moves a distance under accel in one frame", () => {
    const d = door({ speed: 20, accel: 5, decel: 5, distance: 3, endOrigin: [0, 0, 3] });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 3);
    expect([r[2]!.z[0], r[3]!.z[0], r[3]!.state[0]]).toEqual([0, 3, "top"]);
  });

  it("runs a deathmatch door's accel per frame, overshooting as the game does", () => {
    // speed 200 and accel 50 are per second on a func_door, but Think_AccelMove takes
    // them per frame. The move too short to reach speed takes the sqrt path; its
    // next_speed goes negative, so the door overshoots, comes back and stops 1/8 short.
    const d = door({ accel: 50 });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 8);
    expect(d.moveSpeed).toBe(Math.fround(65.8300552));
    expect([2, 3, 4, 5, 6, 7, 8].map((f) => r[f]!.z[0])).toEqual([0, 50, 112.5, 62.625, 62.75, 119.875, 119.875]);
    expect([6, 7].map((f) => r[f]!.state[0])).toEqual(["up", "top"]);
  });

  it("matches the C on moves that pin its float rounding and edge tests", () => {
    // The average speed across the decel distance (p1_speed rounded to float), and a
    // distance equal to accel, which takes the full calculation and swings back first.
    const cases = [
      { speed: 158, accel: 21.916, decel: 158, distance: 259.1, z: [0, 21.875, 65.75, 131.5, 206.75, 259.125], finalSpeed: 60.8269386 },
      { speed: 383.7, accel: 263, decel: 383.7, distance: 263, z: [0, -227, -191, 108, 263], finalSpeed: 181.751801 },
    ];
    for (const { z, finalSpeed, ...c } of cases) {
      const d = door({ ...c, endOrigin: [0, 0, c.distance] });
      doorGoUp(d, levelTimeAt(1), true);
      const r = run([d], 1, 1 + z.length);
      expect(z.map((_, i) => r[2 + i]!.z[0])).toEqual(z);
      expect(r[1 + z.length]!.state[0]).toBe("top");
      expect(d.currentSpeed).toBe(Math.fround(finalSpeed));
    }
  });

  it("starts an accelerative move back down from rest (Move_Calc clears current_speed)", () => {
    const d = door({ speed: 20, accel: 5, decel: 5, distance: 100, endOrigin: [0, 0, 100], wait: 1 });
    doorGoUp(d, levelTimeAt(1), true);
    const r = run([d], 1, 30);
    // door_hit_top at frame 10 sends it down at frame 20; its first accel think runs at
    // 21 and it moves from 22, the way up mirrored.
    const z = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((f) => r[f]!.z[0]);
    expect(z).toEqual([100, 100, 95, 85, 70, 50, 30, 15, 5, 0]);
    expect([28, 29].map((f) => r[f]!.state[0])).toEqual(["down", "bottom"]);
  });
});

// A func_door_rotating at its defaults: 90 degrees of yaw at 100 a second, wait 3.
const rotating = (over: Partial<BrushMoverInit> = {}): BrushMover =>
  door({ rotating: true, endOrigin: [0, 0, 0], endAngles: [0, 90, 0], distance: 90, speed: 100, accel: 100, decel: 100, ...over });

describe("rotating door mover", () => {
  it("turns from its own think at once (AngleMove_Begin) and never moves its origin", () => {
    const d = rotating({ origin: [1, 2, 3], startOrigin: [1, 2, 3], endOrigin: [1, 2, 3], endAngles: [0, 0, -30], distance: 30 });
    doorGoUp(d, levelTimeAt(1), true);
    expect([d.think, d.nextthink, [...d.avelocity]]).toEqual(["angleMoveFinal", Math.fround(Math.fround(0.1) + 0.3), [0, 0, -100]]);
    const r = run([d], 1, 6);
    expect([2, 3, 4, 5].map((f) => r[f]!.state[0])).toEqual(["up", "up", "top", "top"]);
    // 0.3 s whole: AngleMove_Final finds nothing left and runs AngleMove_Done in frame 4.
    expect([...d.angles]).toEqual([0, 0, -30]);
    expect([...d.origin]).toEqual([1, 2, 3]);
    expect([...d.velocity, ...d.avelocity]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("ignores accel and decel (AngleMove_Calc has no accelerative move)", () => {
    const d = rotating({ accel: 10, decel: 20 });
    doorGoUp(d, levelTimeAt(2), false);
    expect(d.think).toBe("angleMoveBegin");
    stepPusher([d], levelTimeAt(3));
    expect(d.think).toBe("angleMoveFinal");
    expect(d.avelocity[1]).toBeCloseTo(100, 4);
  });

  it("turns all the way in one frame at infinite speed (AngleMove_Final)", () => {
    const d = rotating({ speed: Infinity });
    doorGoUp(d, levelTimeAt(2), false);
    stepPusher([d], levelTimeAt(3));
    expect([d.think, [...d.avelocity]]).toEqual(["angleMoveDone", [0, 900, 0]]);
    stepPusher([d], levelTimeAt(4));
    expect([d.angles[1], d.state]).toEqual([90, "top"]);
  });

  it("turns back from where it is when sent down mid-turn", () => {
    const d = rotating({ toggle: true });
    doorGoUp(d, levelTimeAt(2), false);
    run([d], 2, 6);
    const mid = d.angles[1];
    expect(mid).toBeGreaterThan(29);
    doorGoDown(d, levelTimeAt(6), false);
    expect([...d.avelocity]).toEqual([0, 0, 0]);
    const r = run([d], 6, 12);
    expect(r[7]!.state[0]).toBe("down");
    expect(d.angles[1]).toBe(0);
    expect(d.state).toBe("bottom");
  });

  it("turns alongside a linear teammate, each by its own velocity", () => {
    const rot = rotating();
    const lin = door({ distance: 120 });
    doorGoUp(rot, levelTimeAt(2), false);
    doorGoUp(lin, levelTimeAt(2), false);
    const r = run([rot, lin], 2, 12);
    expect(r[9]!.z).toEqual([0, 120]);
    expect([...rot.origin, rot.angles[1]]).toEqual([0, 0, 0, 90]);
    expect([...lin.angles]).toEqual([0, 0, 0]);
  });
});

// A targeted func_plat at the top: pos1 z 100, pos2 z 0, per-frame speed 20, accel 5,
// decel 5 (its defaults), at STATE_UP as SP_func_plat leaves it.
const plat = (over: Partial<BrushMoverInit> = {}): BrushMover =>
  brushMover({
    origin: [0, 0, 100],
    startOrigin: [0, 0, 100],
    endOrigin: [0, 0, 0],
    distance: 0,
    speed: 20,
    accel: 5,
    decel: 5,
    wait: 0,
    toggle: false,
    state: "up",
    ...over,
  });

describe("plat mover", () => {
  it("goes down to pos2 and stays there (plat_go_down, plat_hit_bottom)", () => {
    // Sent down by a use from another entity's slot in frame 2; the accelerative move
    // starts in frame 3 either way, mirroring the plat-like move up above.
    const p = plat();
    platGoDown(p, levelTimeAt(2), false);
    expect([p.state, p.endfunc, p.think, p.nextthink]).toEqual(["down", "platHitBottom", "thinkAccelMove", Math.fround(Math.fround(0.2) + 0.1)]);
    const r = run([p], 2, 30);
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11].map((f) => r[f]!.z[0])).toEqual([100, 95, 85, 70, 50, 30, 15, 5, 0]);
    expect([10, 11, 30].map((f) => r[f]!.state[0])).toEqual(["down", "bottom", "bottom"]);
    expect([p.nextthink, [...p.velocity]]).toEqual([0, [0, 0, 0]]);
  });

  it("goes up to pos1 and back down 3 seconds later whatever its wait (plat_go_up, plat_hit_top)", () => {
    const p = plat({ origin: [0, 0, 0], state: "bottom", wait: 10 });
    platGoUp(p, levelTimeAt(1), true);
    expect([p.state, p.endfunc]).toEqual(["up", "platHitTop"]);
    const r = run([p], 1, 60);
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map((f) => r[f]!.z[0])).toEqual([0, 5, 15, 30, 50, 70, 85, 95, 100]);
    expect([9, 10].map((f) => r[f]!.state[0])).toEqual(["up", "top"]);
    // At the top in frame 10 (level time 1): plat_go_down is due at 4, in frame 40, from
    // the plat's own think, and the move down starts the frame after.
    expect(r[39]!.state[0]).toBe("top");
    expect([40, 41, 42, 43, 44, 45, 46, 47, 48, 49].map((f) => r[f]!.z[0])).toEqual([100, 100, 95, 85, 70, 50, 30, 15, 5, 0]);
    expect([40, 48, 49, 60].map((f) => r[f]!.state[0])).toEqual(["down", "down", "bottom", "bottom"]);
  });
});

describe("stepPusher's door_hit_bottom report", () => {
  /** The frames, from+1 .. to, in which stepPusher reported each mover, by its index in `team`. */
  const hits = (team: BrushMover[], from: number, to: number) => {
    const out: [number, number][] = [];
    for (let f = from + 1; f <= to; f++) for (const m of stepPusher(team, levelTimeAt(f))) out.push([f, team.indexOf(m)]);
    return out;
  };

  it("reports each member in the frame it reaches the bottom, in team order, and not at the top", () => {
    // The linear door is home in frame 45 (see above), the rotating one (90 degrees at
    // 100 a second, wait 3) in frame 51; a linear door twice as far at twice the speed is
    // home in 45 too, reported after the first.
    const team = [door(), rotating(), door({ distance: 240, endOrigin: [0, 0, 240], speed: 400, accel: 400, decel: 400 })];
    for (const m of team) doorGoUp(m, levelTimeAt(2), false);
    expect(hits(team, 2, 60)).toEqual([
      [45, 0],
      [45, 2],
      [51, 1],
    ]);
  });

  it("reports a door that goes down and reaches the bottom in one think", () => {
    // No distance: door_go_down from its own think runs Move_Begin, Move_Final and
    // Move_Done at once, so the door is never seen going down.
    const d = door({ distance: 0, endOrigin: [0, 0, 0], wait: 0 });
    doorGoUp(d, levelTimeAt(2), false);
    const states: string[] = [];
    const r: [number, number][] = [];
    for (let f = 3; f <= 6; f++) {
      if (stepPusher([d], levelTimeAt(f)).includes(d)) r.push([f, 0]);
      states[f] = d.state;
    }
    expect(states.slice(3)).toEqual(["top", "bottom", "bottom", "bottom"]);
    expect(r).toEqual([[4, 0]]);
  });

  it("reports nothing for a door that stays at the bottom or the top", () => {
    const toggled = door({ toggle: true });
    doorGoUp(toggled, levelTimeAt(2), false);
    expect(hits([door(), toggled], 2, 80)).toEqual([]);
  });

  it("reports nothing for a plat reaching the bottom (plat_hit_bottom closes no portal)", () => {
    const p = plat();
    platGoDown(p, levelTimeAt(2), false);
    expect(hits([p], 2, 30)).toEqual([]);
    expect(p.state).toBe("bottom");
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
