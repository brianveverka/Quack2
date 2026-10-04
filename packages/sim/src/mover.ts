// SPDX-License-Identifier: GPL-2.0-or-later
// Linear brush movers stepped at the game's 10 Hz frame, ported from id's game source:
// Move_Calc and its thinks, the func_door state functions and Think_CalcMoveSpeed
// (game/g_func.c), and the move and think order of SV_Physics_Pusher and SV_RunThink
// (game/g_phys.c). Shared so the server and the client step movers the same way.
//
// Fields the C keeps as float are rounded with Math.fround where it stores them; the
// C's double intermediates stay double, so this matches SSE builds (see BACKLOG.md on
// x87). Not modeled yet: the accelerative move (Think_AccelMove: such a mover stays
// put), rotating movers
// (AngleMove_Calc), and anything that blocks a push (that needs the box trace).

/** Seconds per game frame (g_local.h); level.time is framenum * FRAMETIME. */
export const FRAMETIME = 0.1;
// VectorScale takes its scale as a float, so the pusher's per-frame move uses 0.1f.
const FRAMETIME_F = Math.fround(FRAMETIME);

export type Vec3f = [number, number, number];

/** moveinfo.state: STATE_TOP, STATE_BOTTOM, STATE_UP, STATE_DOWN. */
export type MoverState = "top" | "bottom" | "up" | "down";

/** The think a mover runs when level.time reaches `nextthink`. */
export type MoverThink = "moveBegin" | "moveFinal" | "moveDone" | "doorGoDown" | "thinkAccelMove";

export interface LinearMover {
  /** s.origin: where the brush model is now. */
  readonly origin: Vec3f;
  readonly velocity: Vec3f;
  /** moveinfo.start_origin (pos1) and end_origin (pos2). */
  readonly startOrigin: Vec3f;
  readonly endOrigin: Vec3f;
  /** moveinfo.distance: how far pos2 lies from pos1 along the move direction. */
  distance: number;
  speed: number;
  accel: number;
  decel: number;
  /** moveinfo.wait: seconds at the top before going down; negative stays up. */
  wait: number;
  /** DOOR_TOGGLE: stays at the top until used again. */
  toggle: boolean;
  state: MoverState;
  /** moveinfo.dir and remaining_distance of the move under way. */
  readonly dir: Vec3f;
  remainingDistance: number;
  /** moveinfo.endfunc: the door function Move_Done calls. */
  endfunc: "doorHitTop" | "doorHitBottom" | undefined;
  think: MoverThink | undefined;
  /** 0 when no think is pending. */
  nextthink: number;
}

export interface LinearMoverInit {
  readonly origin: readonly [number, number, number];
  readonly startOrigin: readonly [number, number, number];
  readonly endOrigin: readonly [number, number, number];
  readonly distance: number;
  readonly speed: number;
  readonly accel: number;
  readonly decel: number;
  readonly wait: number;
  readonly toggle: boolean;
  readonly state: MoverState;
}

const f3 = (v: readonly [number, number, number]): Vec3f => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])];

export function linearMover(init: LinearMoverInit): LinearMover {
  return {
    origin: f3(init.origin),
    velocity: [0, 0, 0],
    startOrigin: f3(init.startOrigin),
    endOrigin: f3(init.endOrigin),
    distance: Math.fround(init.distance),
    speed: Math.fround(init.speed),
    accel: Math.fround(init.accel),
    decel: Math.fround(init.decel),
    wait: Math.fround(init.wait),
    toggle: init.toggle,
    state: init.state,
    dir: [0, 0, 0],
    remainingDistance: 0,
    endfunc: undefined,
    think: undefined,
    nextthink: 0,
  };
}

/** level.time at a frame: framenum * FRAMETIME, stored as a float (G_RunFrame). */
export function levelTimeAt(framenum: number): number {
  return Math.fround(framenum * FRAMETIME);
}

/**
 * Think_CalcMoveSpeed, run by the team master (the first member): every member's speed
 * is set so all of them finish their move together, in the time the member with the
 * shortest distance takes at the master's speed. accel and decel follow speed.
 */
export function calcMoveSpeed(team: readonly LinearMover[]): void {
  const master = team[0];
  if (!master) return;
  let min = Math.fround(Math.abs(master.distance));
  for (const m of team.slice(1)) {
    const dist = Math.fround(Math.abs(m.distance));
    if (dist < min) min = dist;
  }
  const time = Math.fround(min / master.speed);
  for (const m of team) {
    const newspeed = Math.fround(Math.abs(m.distance) / time);
    const ratio = Math.fround(newspeed / m.speed);
    m.accel = m.accel === m.speed ? newspeed : Math.fround(m.accel * ratio);
    m.decel = m.decel === m.speed ? newspeed : Math.fround(m.decel * ratio);
    m.speed = newspeed;
  }
}

/**
 * door_go_up for a linear door. `current` says whether the game is running this
 * mover's team now (level.current_entity is its master): a door going up from its own
 * think starts moving this frame, one sent up by another entity's use starts the next
 * frame (Move_Calc defers Move_Begin). Targets and portals are the caller's.
 */
export function doorGoUp(m: LinearMover, levelTime: number, current: boolean): void {
  if (m.state === "up") return;
  if (m.state === "top") {
    // Reset the top wait time.
    if (m.wait >= 0) m.nextthink = Math.fround(levelTime + m.wait);
    return;
  }
  m.state = "up";
  moveCalc(m, m.endOrigin, "doorHitTop", levelTime, current);
}

/** door_go_down for a linear door; `current` as for `doorGoUp`. */
export function doorGoDown(m: LinearMover, levelTime: number, current: boolean): void {
  m.state = "down";
  moveCalc(m, m.startOrigin, "doorHitBottom", levelTime, current);
}

function moveCalc(m: LinearMover, dest: Vec3f, endfunc: LinearMover["endfunc"], levelTime: number, current: boolean): void {
  m.velocity.fill(0);
  for (let i = 0; i < 3; i++) m.dir[i] = Math.fround(dest[i]! - m.origin[i]!);
  m.remainingDistance = vectorNormalize(m.dir);
  m.endfunc = endfunc;
  if (m.speed !== m.accel || m.speed !== m.decel) {
    // Think_AccelMove is not ported: the mover stays where it is.
    m.think = "thinkAccelMove";
    m.nextthink = Math.fround(levelTime + FRAMETIME);
  } else if (current) {
    moveBegin(m, levelTime);
  } else {
    m.nextthink = Math.fround(levelTime + FRAMETIME);
    m.think = "moveBegin";
  }
}

/** q_shared.c VectorNormalize: normalizes in place and returns the length (0 leaves it). */
function vectorNormalize(v: Vec3f): number {
  const sq = Math.fround(Math.fround(Math.fround(v[0] * v[0]) + Math.fround(v[1] * v[1])) + Math.fround(v[2] * v[2]));
  const length = Math.fround(Math.sqrt(sq));
  if (length) {
    const ilength = Math.fround(1 / length);
    for (let i = 0; i < 3; i++) v[i] = Math.fround(v[i]! * ilength);
  }
  return length;
}

function moveBegin(m: LinearMover, levelTime: number): void {
  if (m.speed * FRAMETIME >= m.remainingDistance) {
    moveFinal(m, levelTime);
    return;
  }
  vectorScale(m.dir, m.speed, m.velocity);
  const frames = Math.fround(Math.floor(Math.fround(m.remainingDistance / m.speed) / FRAMETIME));
  m.remainingDistance = Math.fround(m.remainingDistance - Math.fround(frames * m.speed) * FRAMETIME);
  m.nextthink = Math.fround(levelTime + frames * FRAMETIME);
  m.think = "moveFinal";
}

function moveFinal(m: LinearMover, levelTime: number): void {
  if (m.remainingDistance === 0) {
    moveDone(m, levelTime);
    return;
  }
  vectorScale(m.dir, m.remainingDistance / FRAMETIME, m.velocity);
  m.think = "moveDone";
  m.nextthink = Math.fround(levelTime + FRAMETIME);
}

function moveDone(m: LinearMover, levelTime: number): void {
  m.velocity.fill(0);
  if (m.endfunc === "doorHitTop") doorHitTop(m, levelTime);
  else if (m.endfunc === "doorHitBottom") m.state = "bottom";
}

function doorHitTop(m: LinearMover, levelTime: number): void {
  m.state = "top";
  if (m.toggle) return;
  if (m.wait >= 0) {
    m.think = "doorGoDown";
    m.nextthink = Math.fround(levelTime + m.wait);
  }
}

/** VectorScale: the scale is a float parameter. */
function vectorScale(v: Vec3f, scale: number, out: Vec3f): void {
  const s = Math.fround(scale);
  for (let i = 0; i < 3; i++) out[i] = Math.fround(v[i]! * s);
}

/**
 * One game frame of SV_Physics_Pusher for a team (master first) at `levelTime`: every
 * moving member is pushed by velocity * FRAMETIME, clamped to 1/8 unit as SV_Push does,
 * then each member runs its think if due (SV_RunThink). Nothing blocks a push here.
 */
export function stepPusher(team: readonly LinearMover[], levelTime: number): void {
  for (const m of team) {
    const v = m.velocity;
    if (!v[0] && !v[1] && !v[2]) continue;
    for (let i = 0; i < 3; i++) {
      const move = Math.fround(v[i]! * FRAMETIME_F);
      let temp = move * 8.0;
      temp += temp > 0 ? 0.5 : -0.5;
      m.origin[i] = Math.fround(m.origin[i]! + Math.fround(0.125 * Math.trunc(temp)));
    }
  }
  for (const m of team) runThink(m, levelTime);
}

function runThink(m: LinearMover, levelTime: number): void {
  const thinktime = m.nextthink;
  if (thinktime <= 0 || thinktime > levelTime + 0.001) return;
  m.nextthink = 0;
  const think = m.think;
  if (think === undefined) throw new Error("NULL ent->think");
  switch (think) {
    case "moveBegin":
      return moveBegin(m, levelTime);
    case "moveFinal":
      return moveFinal(m, levelTime);
    case "moveDone":
      return moveDone(m, levelTime);
    case "thinkAccelMove":
      return;
    case "doorGoDown":
      // Run from the door's own think, so its master is level.current_entity: unless
      // it is a team slave, whose think runs inside its master's SV_Physics_Pusher with
      // the master current too. Either way Move_Begin runs now.
      return doorGoDown(m, levelTime, true);
  }
}
