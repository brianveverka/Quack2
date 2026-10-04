// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import {
  buttonFire,
  calcMoveSpeed,
  doorGoDown,
  doorGoUp,
  levelTimeAt,
  brushMover,
  platGoDown,
  platGoUp,
  stepPusher,
  trainNext,
  trainUse,
  type BrushMover,
  type BrushMoverInit,
  type PathCorner,
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

// A func_button with its defaults moving up: 50 high less lip 4, speed, accel and decel 40, wait 3.
const button = (over: Partial<BrushMoverInit> = {}): BrushMover =>
  brushMover({
    origin: [0, 0, 0],
    startOrigin: [0, 0, 0],
    endOrigin: [0, 0, 46],
    distance: 0,
    speed: 40,
    accel: 40,
    decel: 40,
    wait: 3,
    toggle: false,
    state: "bottom",
    ...over,
  });

describe("button mover", () => {
  it("goes up, waits, and comes back (button_fire, button_wait, button_return, button_done)", () => {
    const b = button();
    buttonFire(b, levelTimeAt(2), false);
    expect([b.state, b.endfunc, b.think]).toEqual(["up", "buttonWait", "moveBegin"]);
    const r = run([b], 2, 70);
    // Move_Begin in frame 3: 11 frames of 4 units, then Move_Final's 2 in frame 15,
    // where Move_Done runs button_wait.
    expect([3, 4, 5, 14, 15].map((f) => r[f]!.z[0])).toEqual([0, 4, 8, 44, 46]);
    expect([14, 15].map((f) => r[f]!.state[0])).toEqual(["up", "top"]);
    // button_return is due at 1.5 + 3, frame 45, and starts moving at once.
    expect([44, 45].map((f) => r[f]!.state[0])).toEqual(["top", "down"]);
    expect([45, 46, 47, 56, 57].map((f) => r[f]!.z[0])).toEqual([46, 42, 38, 2, 0]);
    expect([56, 57, 70].map((f) => r[f]!.state[0])).toEqual(["down", "bottom", "bottom"]);
    expect([b.nextthink, [...b.velocity]]).toEqual([0, [0, 0, 0]]);
  });

  it("ignores a fire while going up or at the top, and stays up with a negative wait", () => {
    // Accelerating (per-frame speed 4, accel 1): a second Move_Calc mid-move would set
    // current_speed back to 0.
    const b = button({ wait: -1, speed: 4, accel: 1, decel: 1 });
    buttonFire(b, levelTimeAt(2), false);
    run([b], 2, 8);
    const moving = [b.think, b.nextthink, b.currentSpeed, b.remainingDistance];
    expect(b.currentSpeed).toBeGreaterThan(0);
    buttonFire(b, levelTimeAt(8), true);
    expect([b.think, b.nextthink, b.currentSpeed, b.remainingDistance]).toEqual(moving);
    const r = run([b], 8, 100);
    expect([r[100]!.state[0], b.nextthink]).toEqual(["top", 0]);
    buttonFire(b, levelTimeAt(100), true);
    expect([b.state, b.nextthink]).toEqual(["top", 0]);
  });

  it("fires again once back at the bottom, moving at once from its own frame", () => {
    const b = button();
    buttonFire(b, levelTimeAt(2), false);
    run([b], 2, 57);
    buttonFire(b, levelTimeAt(57), true);
    expect([b.state, b.think, [...b.velocity]]).toEqual(["up", "moveFinal", [0, 0, 40]]);
  });

  it("reports nothing to stepPusher's caller when it comes back down", () => {
    const b = button();
    buttonFire(b, levelTimeAt(2), false);
    for (let f = 3; f <= 70; f++) expect(stepPusher([b], levelTimeAt(f))).toEqual([]);
    expect(b.state).toBe("bottom");
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

describe("train mover", () => {
  type Corner = [name: string, origin: [number, number, number], target?: string, wait?: number, teleport?: boolean, pathtarget?: string];
  const f = Math.fround;
  /**
   * A func_train as SP_func_train and func_train_find leave it in the first frame: its
   * mins on the first corner, train_next due in the second frame when START_ON (a train
   * with no targetname gets it). The values below are a gcc (SSE) build of g_func.c's.
   */
  function train(corners: Corner[], opts: { mins?: number[]; speed?: number; startOn?: boolean; toggle?: boolean; fired?: string[]; freedBy?: string } = {}) {
    const list: PathCorner[] = corners.map(([, o, target, wait = 0, teleport = false, pathtarget], entity) => ({
      entity,
      origin: [f(o[0]), f(o[1]), f(o[2])],
      target,
      wait: f(wait),
      teleport,
      pathtarget,
    }));
    const mins = (opts.mins ?? [0, 0, 0]).map(f) as [number, number, number];
    const first = list[0]!;
    const origin = [0, 1, 2].map((k) => first.origin[k]! - mins[k]!) as [number, number, number];
    const speed = opts.speed ?? 100;
    const m = brushMover({ origin, startOrigin: origin, endOrigin: origin, distance: 0, speed, accel: speed, decel: speed, wait: 0, toggle: false, state: "top",
      train: {
        mins,
        target: first.target,
        targetEnt: undefined,
        startOn: opts.startOn ?? true,
        toggle: opts.toggle ?? false,
        pick: (name) => list.find((_, i) => corners[i]![0] === name),
        usePathtarget: (c) => {
          opts.fired?.push(c.pathtarget!);
          return c.pathtarget !== opts.freedBy;
        },
      },
    });
    if (m.train!.startOn) {
      m.think = "trainNext";
      m.nextthink = levelTimeAt(2);
    }
    return m;
  }
  const frames = (m: BrushMover, from: number, to: number) => {
    const out: [number[], boolean][] = [];
    for (let fr = from + 1; fr <= to; fr++) {
      stepPusher([m], levelTimeAt(fr));
      out[fr] = [[...m.origin], m.teleported];
    }
    return out;
  };

  const LOOP: Corner[] = [
    ["c1", [0, 0, 0], "c2"],
    ["c2", [200, 0, 0], "c3"],
    ["c3", [1000, 1000, 0], "c4", 0, true],
    ["c4", [1000, 1100, 37.3], "c5", 1.5, false, "pt"],
    ["c5", [1000, 1100, 37.3], "c1", -1],
  ];

  it("moves its mins from corner to corner at speed, jumps to a TELEPORT corner, waits and stops (train_next, train_wait)", () => {
    const fired: string[] = [];
    const m = train(LOOP, { mins: [-33, -17, -1], fired });
    const r = frames(m, 1, 80);
    // train_next in frame 2 heads for c2 less mins, 10 units a frame from frame 3.
    expect(r[2]).toEqual([[33, 17, 1], false]);
    expect([3, 4, 21].map((fr) => r[fr]![0][0])).toEqual([43, 53, 223]);
    expect(m.train!.target).toBe("c1");
    // Frame 22 arrives (Move_Final had nothing left), train_wait with no wait runs
    // train_next, which jumps to c3 and heads for c4: EV_OTHER_TELEPORT that frame only.
    const after = frames(train(LOOP, { mins: [-33, -17, -1] }), 1, 23);
    expect(after[22]).toEqual([[1033, 1017, 1], true]);
    expect(after[23]).toEqual([[1033, 1026.375, 4.5], false]);
    // At c4 (frame 33) its pathtarget fires and train_next is due 1.5 s later; c5 lies at
    // no distance, so the train finishes there at once and its wait -1 stops it.
    expect(fired).toEqual(["pt"]);
    expect(r[35]![0]).toEqual([1033, 1117, 38.375]);
    expect(r[50]![0]).toEqual([1033, 1117, 38.25]);
    expect(r[80]![0]).toEqual([1033, 1117, 38.25]);
    expect([m.nextthink, m.wait, m.train!.startOn, m.train!.targetEnt!.entity]).toEqual([0, -1, true, 4]);
    // Still START_ON and not TOGGLE: a use does nothing.
    trainUse(m, levelTimeAt(81), false);
    expect([m.nextthink, [...m.velocity]]).toEqual([0, [0, 0, 0]]);
  });

  it("stops a TOGGLE train at a negative wait after train_next, and resumes it on a use", () => {
    const corners: Corner[] = [
      ["a", [0, 0, 0], "b"],
      ["b", [13.1, -50.7, 7.9], "a", -1],
    ];
    const m = train(corners, { mins: [-16.5, -3.25, -64.75], speed: f(37.7), toggle: true });
    const r = frames(m, 1, 39);
    expect([2, 3, 4].map((fr) => r[fr]![0])).toEqual([
      [16.5, 3.25, 64.75],
      [17.375, -0.375, 65.25],
      [18.25, -4, 65.75],
    ]);
    // At b it ran train_next towards a, then stopped: START_ON clear, nothing pending.
    expect(r[39]![0]).toEqual([28.75, -47.625, 71.75]);
    expect([m.train!.startOn, m.train!.targetEnt!.entity, m.nextthink, [...m.velocity]]).toEqual([false, 0, 0, [0, 0, 0]]);
    // A use from another slot in frame 40 resumes towards a: Move_Begin a frame later.
    trainUse(m, levelTimeAt(40), false);
    expect([m.train!.startOn, m.think, m.nextthink]).toEqual([true, "moveBegin", levelTimeAt(41)]);
    const s = frames(m, 39, 60);
    expect([s[40]![0], s[41]![0], s[42]![0]]).toEqual([
      [28.75, -47.625, 71.75],
      [28.75, -47.625, 71.75],
      [27.875, -44, 71.25],
    ]);
    // Back at a (wait 0) in frame 56, on towards b again.
    expect([s[55]![0], s[56]![0], s[57]![0]]).toEqual([
      [16.5, 3.125, 64.75],
      [16.5, 3.125, 64.75],
      [17.375, -0.5, 65.375],
    ]);
    // A TOGGLE train that is running stops on a use, where it is.
    trainUse(m, levelTimeAt(61), false);
    expect([m.train!.startOn, m.nextthink, [...m.velocity]]).toEqual([false, 0, [0, 0, 0]]);
  });

  it("stays at the first of two TELEPORT corners in a row, its target stepped past the second", () => {
    const m = train([
      ["c1", [0, 0, 0], "t1"],
      ["t1", [100, 0, 0], "t2", 0, true],
      ["t2", [300, 0, 0], "c3", 0, true],
      ["c3", [400, 0, 0]],
    ], { mins: [-1, -1, -1] });
    const r = frames(m, 1, 10);
    expect(r[2]).toEqual([[101, 1, 1], true]);
    expect(r[10]).toEqual([[101, 1, 1], false]);
    expect([m.train!.target, m.train!.targetEnt, m.nextthink]).toEqual(["c3", undefined, 0]);
  });

  it("waits a positive wait at a corner, then goes on, and ignores a use while START_ON", () => {
    const m = train([
      ["a", [0, 0, 0], "b"],
      ["b", [0.7, 123.45, -9.9], "a", 0.25],
    ], { mins: [-1, -1, -1], speed: f(300) });
    trainUse(m, levelTimeAt(5), false);
    const r = frames(m, 1, 25);
    // 30 a frame, then the rest of the 123 units in frame 7, where train_wait has
    // train_next due 0.25 s later (frame 10).
    expect([2, 3, 6, 7, 9, 10, 14, 15].map((fr) => r[fr]![0])).toEqual([
      [1, 1, 1],
      [1.125, 30.875, -1.375],
      [1.5, 120.5, -8.5],
      [1.5, 124.375, -8.75],
      [1.5, 124.375, -8.75],
      [1.5, 124.375, -8.75],
      [1, 4.875, 0.75],
      [1, 1.125, 1],
    ]);
    expect(r[16]![0]).toEqual([1.125, 31, -1.375]);
  });

  it("does nothing past a corner whose pathtarget freed the train", () => {
    const fired: string[] = [];
    const m = train([
      ["a", [0, 0, 0], "b"],
      ["b", [0, 0, 0], "c", 0, false, "kill"],
      ["c", [50, 0, 0]],
    ], { fired, freedBy: "kill" });
    frames(m, 1, 10);
    expect(fired).toEqual(["kill"]);
    expect([[...m.origin], m.train!.targetEnt!.entity, m.nextthink]).toEqual([[0, 0, 0], 1, 0]);
  });

  it("cuts off a loop of corners at no distance, where the game recurses until it crashes", () => {
    const m = train([
      ["a", [0, 0, 0], "a"],
    ]);
    expect(() => frames(m, 1, 3)).not.toThrow();
    expect([[...m.origin], m.nextthink]).toEqual([[0, 0, 0], 0]);
  });

  it("runs train_next from a use, starting a frame later from another slot, and returns without a target", () => {
    const m = train([
      ["a", [0, 0, 0], "b"],
      ["b", [0, 0, 100]],
    ], { startOn: false });
    trainNext(m, levelTimeAt(2), false);
    expect([m.think, m.nextthink, m.train!.startOn, m.train!.target]).toEqual(["moveBegin", levelTimeAt(3), true, undefined]);
    const r = frames(m, 2, 14);
    expect([r[3]![0][2], r[4]![0][2], r[13]![0][2]]).toEqual([0, 10, 100]);
    // At b with no wait: train_next finds no target and leaves it there.
    expect([m.nextthink, [...m.velocity]]).toEqual([0, [0, 0, 0]]);
  });
});

describe("teams Think_CalcMoveSpeed gives non-finite speeds", () => {
  // From a gcc (SSE) build of Think_CalcMoveSpeed, door_go_up/down, Move_Calc,
  // AngleMove_Calc and their thinks, Think_AccelMove, SV_Push's clamp and SV_RunThink:
  // a master with a negative speed and a member at no distance make the team's time -0.
  const team = (third: Partial<BrushMoverInit>): BrushMover[] => {
    const t = [
      door({ distance: 42, endOrigin: [0, 0, 42], speed: -100, accel: -100, decel: -100 }),
      door({ distance: 0, endOrigin: [0, 0, 0], speed: 40, accel: 40, decel: 40 }),
      door({ distance: 58, endOrigin: [58, 0, 0], speed: 100, accel: 100, decel: 100, ...third }),
    ];
    calcMoveSpeed(t);
    for (const m of t) doorGoUp(m, levelTimeAt(2), false);
    return t;
  };
  const step = Math.fround(-2147483648 / 8);

  it("pushes an infinite velocity INT_MIN / 8 on every axis, as x86's (int) gives", () => {
    const t = team({});
    expect(t[0]!.speed).toBe(-Infinity);
    const r: { o: number[][]; s: string[] }[] = [];
    for (let f = 3; f <= 37; f++) {
      stepPusher(t, levelTimeAt(f));
      r[f] = { o: t.map((m) => [...m.origin]), s: t.map((m) => m.state) };
    }
    const all = (v: number): number[] => [v, v, v];
    // -Infinity along the move, NaN (-Infinity * 0) on the other axes: both move.
    expect(r[4]!.o).toEqual([all(step), [0, 0, 0], all(step)]);
    expect(r[4]!.s).toEqual(["up", "top", "up"]);
    expect(r[5]!.o).toEqual([all(2 * step), [0, 0, 0], all(2 * step)]);
    expect(r[5]!.s).toEqual(["top", "top", "top"]);
    // Going down moves further the same way, and is home at STATE_BOTTOM.
    expect(r[35]!.s).toEqual(["down", "bottom", "down"]);
    expect(r[36]!.o[0]).toEqual(all(3 * step));
    expect(r[37]!.o).toEqual([all(4 * step), [0, 0, 0], all(4 * step)]);
    expect(r[37]!.s).toEqual(["bottom", "bottom", "bottom"]);
  });

  it("moves a member whose accel gives Think_AccelMove a NaN velocity", () => {
    // accel 50 (not its speed) times the infinite ratio is -Infinity.
    const t = team({ accel: 50 });
    expect([t[2]!.speed, t[2]!.accel]).toEqual([-Infinity, -Infinity]);
    stepPusher(t, levelTimeAt(3));
    stepPusher(t, levelTimeAt(4));
    expect(t[2]!.velocity.every(Number.isNaN)).toBe(true);
    expect([...t[2]!.origin]).toEqual([step, step, step]);
    stepPusher(t, levelTimeAt(5));
    expect([...t[2]!.origin]).toEqual([2 * step, 2 * step, 2 * step]);
    expect(t[2]!.state).toBe("top");
  });

  it("turns a rotating member at no distance to NaN angles, and AngleMove_Final reads them as unfinished", () => {
    const t = [door({ distance: 42, endOrigin: [0, 0, 42], speed: 100, accel: 100, decel: 100 }), door({ rotating: true, distance: 0, endOrigin: [0, 0, 0] })];
    calcMoveSpeed(t);
    for (const m of t) doorGoUp(m, levelTimeAt(2), false);
    stepPusher(t, levelTimeAt(3));
    stepPusher(t, levelTimeAt(4));
    expect(t[1]!.angles.every(Number.isNaN)).toBe(true);
    // A NaN move is not vec3_origin to VectorCompare, so AngleMove_Done is a frame later.
    expect(t[1]!.state).toBe("up");
    stepPusher(t, levelTimeAt(5));
    expect(t[1]!.state).toBe("top");
  });

  it("normalizes a NaN direction to NaN on every axis, as VectorNormalize's if (length) does", () => {
    // Not reachable from spawn: a NaN origin, as the C would treat it.
    const d = door({ distance: 42, endOrigin: [0, 0, 42] });
    d.origin[0] = Number.NaN;
    doorGoUp(d, levelTimeAt(2), false);
    stepPusher([d], levelTimeAt(3));
    stepPusher([d], levelTimeAt(4));
    expect([...d.origin]).toEqual([Number.NaN, step, step]);
  });
});
