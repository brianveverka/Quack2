// SPDX-License-Identifier: GPL-2.0-or-later
// Brush movers stepped at the game's 10 Hz frame, ported from id's game source:
// Move_Calc and its thinks, the accelerative move (Think_AccelMove and the plat_
// functions it calls), AngleMove_Calc and its thinks for a func_door_rotating, the
// func_door state functions and Think_CalcMoveSpeed (game/g_func.c), and the move and
// think order of SV_Physics_Pusher and SV_RunThink (game/g_phys.c). Shared so the
// server and the client step movers the same way.
//
// Fields the C keeps as float are rounded with Math.fround where it stores them, and
// float-only arithmetic is rounded at each operation; the C's double intermediates stay
// double, so this matches SSE builds (see BACKLOG.md on x87). Not modeled yet: anything
// that blocks a push (that needs the box trace).

/** Seconds per game frame (g_local.h); level.time is framenum * FRAMETIME. */
export const FRAMETIME = 0.1;
// VectorScale takes its scale as a float, so the pusher's per-frame move uses 0.1f.
const FRAMETIME_F = Math.fround(FRAMETIME);

export type Vec3f = [number, number, number];

/** moveinfo.state: STATE_TOP, STATE_BOTTOM, STATE_UP, STATE_DOWN. */
export type MoverState = "top" | "bottom" | "up" | "down";

/** The think a mover runs when level.time reaches `nextthink`. */
export type MoverThink =
  | "moveBegin"
  | "moveFinal"
  | "moveDone"
  | "doorGoDown"
  | "thinkAccelMove"
  | "angleMoveBegin"
  | "angleMoveFinal"
  | "angleMoveDone";

export interface BrushMover {
  /**
   * A func_door_rotating: door_go_up and door_go_down turn it with AngleMove_Calc
   * between `startAngles` and `endAngles`, where any other door moves with Move_Calc.
   */
  readonly rotating: boolean;
  /** s.origin: where the brush model is now. */
  readonly origin: Vec3f;
  readonly velocity: Vec3f;
  /** s.angles and avelocity, in degrees and degrees per second. */
  readonly angles: Vec3f;
  readonly avelocity: Vec3f;
  /** moveinfo.start_angles (pos1) and end_angles (pos2) of a rotating door. */
  readonly startAngles: Vec3f;
  readonly endAngles: Vec3f;
  /** moveinfo.start_origin (pos1) and end_origin (pos2). */
  readonly startOrigin: Vec3f;
  readonly endOrigin: Vec3f;
  /** moveinfo.distance: how far pos2 lies from pos1 along the move direction (a rotating door's "distance" in degrees). */
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
  /**
   * The accelerative move's moveinfo fields, in units per frame: Think_AccelMove moves
   * current_speed a frame, and treats speed, accel and decel as per-frame amounts too
   * (a func_door's are per second, so an accelerative door reaches ten times its speed).
   * Move_Calc resets only current_speed.
   */
  currentSpeed: number;
  moveSpeed: number;
  nextSpeed: number;
  decelDistance: number;
  /** moveinfo.endfunc: the door function Move_Done calls. */
  endfunc: "doorHitTop" | "doorHitBottom" | undefined;
  think: MoverThink | undefined;
  /** 0 when no think is pending. */
  nextthink: number;
}

export interface BrushMoverInit {
  /** Default false. */
  readonly rotating?: boolean;
  readonly origin: readonly [number, number, number];
  /** Default 0 0 0, as are `startAngles` and `endAngles`. */
  readonly angles?: readonly [number, number, number];
  readonly startAngles?: readonly [number, number, number];
  readonly endAngles?: readonly [number, number, number];
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

export function brushMover(init: BrushMoverInit): BrushMover {
  return {
    rotating: init.rotating ?? false,
    origin: f3(init.origin),
    velocity: [0, 0, 0],
    angles: f3(init.angles ?? [0, 0, 0]),
    avelocity: [0, 0, 0],
    startAngles: f3(init.startAngles ?? [0, 0, 0]),
    endAngles: f3(init.endAngles ?? [0, 0, 0]),
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
    currentSpeed: 0,
    moveSpeed: 0,
    nextSpeed: 0,
    decelDistance: 0,
    endfunc: undefined,
    think: undefined,
    nextthink: 0,
  };
}

/** level.time at a frame: framenum * FRAMETIME, stored as a float (G_RunFrame). */
export function levelTimeAt(framenum: number): number {
  return Math.fround(framenum * FRAMETIME);
}

/** The moveinfo fields Think_CalcMoveSpeed reads and sets, which every team member has. */
export interface MoveSpeeds {
  distance: number;
  speed: number;
  accel: number;
  decel: number;
}

/**
 * Think_CalcMoveSpeed, run by the team master (the first member): every member's speed
 * is set so all of them finish their move together, in the time the member with the
 * shortest distance takes at the master's speed. accel and decel follow speed. A member
 * at no distance makes that time 0, so every other member's speed becomes infinite (and
 * its own 0 / 0, NaN), as the C's float division gives.
 */
export function calcMoveSpeed(team: readonly MoveSpeeds[]): void {
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
 * door_go_up. `current` says whether the game is running this mover's team now
 * (level.current_entity is its master): a door going up from its own think starts
 * moving this frame, one sent up by another entity's use starts the next frame
 * (Move_Calc and AngleMove_Calc defer their Begin). Targets and portals are the caller's.
 */
export function doorGoUp(m: BrushMover, levelTime: number, current: boolean): void {
  if (m.state === "up") return;
  if (m.state === "top") {
    // Reset the top wait time.
    if (m.wait >= 0) m.nextthink = Math.fround(levelTime + m.wait);
    return;
  }
  m.state = "up";
  if (m.rotating) angleMoveCalc(m, "doorHitTop", levelTime, current);
  else moveCalc(m, m.endOrigin, "doorHitTop", levelTime, current);
}

/** door_go_down; `current` as for `doorGoUp`. */
export function doorGoDown(m: BrushMover, levelTime: number, current: boolean): void {
  m.state = "down";
  if (m.rotating) angleMoveCalc(m, "doorHitBottom", levelTime, current);
  else moveCalc(m, m.startOrigin, "doorHitBottom", levelTime, current);
}

function moveCalc(m: BrushMover, dest: Vec3f, endfunc: BrushMover["endfunc"], levelTime: number, current: boolean): void {
  m.velocity.fill(0);
  for (let i = 0; i < 3; i++) m.dir[i] = Math.fround(dest[i]! - m.origin[i]!);
  m.remainingDistance = vectorNormalize(m.dir);
  m.endfunc = endfunc;
  if (m.speed !== m.accel || m.speed !== m.decel) {
    m.currentSpeed = 0;
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

function moveBegin(m: BrushMover, levelTime: number): void {
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

function moveFinal(m: BrushMover, levelTime: number): void {
  if (m.remainingDistance === 0) {
    moveDone(m, levelTime);
    return;
  }
  vectorScale(m.dir, m.remainingDistance / FRAMETIME, m.velocity);
  m.think = "moveDone";
  m.nextthink = Math.fround(levelTime + FRAMETIME);
}

function moveDone(m: BrushMover, levelTime: number): void {
  m.velocity.fill(0);
  endfunc(m, levelTime);
}

function endfunc(m: BrushMover, levelTime: number): void {
  if (m.endfunc === "doorHitTop") doorHitTop(m, levelTime);
  else if (m.endfunc === "doorHitBottom") m.state = "bottom";
}

/** AngleMove_Calc: unlike Move_Calc it has no accelerative move. */
function angleMoveCalc(m: BrushMover, endfunc: BrushMover["endfunc"], levelTime: number, current: boolean): void {
  m.avelocity.fill(0);
  m.endfunc = endfunc;
  if (current) {
    angleMoveBegin(m, levelTime);
  } else {
    m.nextthink = Math.fround(levelTime + FRAMETIME);
    m.think = "angleMoveBegin";
  }
}

/** The angles still to turn: to end_angles going up, else to start_angles. */
function angleDelta(m: BrushMover): Vec3f {
  const dest = m.state === "up" ? m.endAngles : m.startAngles;
  return [0, 1, 2].map((i) => Math.fround(dest[i]! - m.angles[i]!)) as Vec3f;
}

function angleMoveBegin(m: BrushMover, levelTime: number): void {
  const destdelta = angleDelta(m);
  const len = vectorLength(destdelta);
  const traveltime = Math.fround(len / m.speed);
  if (traveltime < FRAMETIME) {
    angleMoveFinal(m, levelTime);
    return;
  }
  // traveltime / FRAMETIME is double, so a traveltime of 0.9f floors to 8 frames.
  const frames = Math.fround(Math.floor(traveltime / FRAMETIME));
  vectorScale(destdelta, 1.0 / traveltime, m.avelocity);
  m.nextthink = Math.fround(levelTime + frames * FRAMETIME);
  m.think = "angleMoveFinal";
}

function angleMoveFinal(m: BrushMover, levelTime: number): void {
  const move = angleDelta(m);
  if (!move[0] && !move[1] && !move[2]) {
    angleMoveDone(m, levelTime);
    return;
  }
  vectorScale(move, 1.0 / FRAMETIME, m.avelocity);
  m.think = "angleMoveDone";
  m.nextthink = Math.fround(levelTime + FRAMETIME);
}

function angleMoveDone(m: BrushMover, levelTime: number): void {
  m.avelocity.fill(0);
  endfunc(m, levelTime);
}

/** q_shared.c VectorLength: the sum of squares is a float, its sqrt stored as one. */
function vectorLength(v: Vec3f): number {
  let length = 0;
  for (let i = 0; i < 3; i++) length = Math.fround(length + Math.fround(v[i]! * v[i]!));
  return Math.fround(Math.sqrt(length));
}

function doorHitTop(m: BrushMover, levelTime: number): void {
  m.state = "top";
  if (m.toggle) return;
  if (m.wait >= 0) {
    m.think = "doorGoDown";
    m.nextthink = Math.fround(levelTime + m.wait);
  }
}

/** AccelerationDistance: a float macro, rounded at each operation. */
function accelerationDistance(target: number, rate: number): number {
  return Math.fround(Math.fround(target * Math.fround(Math.fround(target / rate) + 1)) / 2);
}

function calcAcceleratedMove(m: BrushMover): void {
  m.moveSpeed = m.speed;
  if (m.remainingDistance < m.accel) {
    m.currentSpeed = m.remainingDistance;
    return;
  }
  const accelDist = accelerationDistance(m.speed, m.accel);
  let decelDist = accelerationDistance(m.speed, m.decel);
  if (Math.fround(Math.fround(m.remainingDistance - accelDist) - decelDist) < 0) {
    const f = Math.fround(Math.fround(m.accel + m.decel) / Math.fround(m.accel * m.decel));
    // sqrt takes and returns double, so the numerator and the division are double.
    const disc = Math.fround(4 - Math.fround(Math.fround(4 * f) * Math.fround(-2 * m.remainingDistance)));
    m.moveSpeed = Math.fround((-2 + Math.sqrt(disc)) / Math.fround(2 * f));
    decelDist = accelerationDistance(m.moveSpeed, m.decel);
  }
  m.decelDistance = decelDist;
}

function accelerate(m: BrushMover): void {
  // Decelerating?
  if (m.remainingDistance <= m.decelDistance) {
    if (m.remainingDistance < m.decelDistance) {
      if (m.nextSpeed) {
        m.currentSpeed = m.nextSpeed;
        m.nextSpeed = 0;
        return;
      }
      if (m.currentSpeed > m.decel) m.currentSpeed = Math.fround(m.currentSpeed - m.decel);
    }
    return;
  }
  // At full speed and starting to decelerate during this move?
  if (m.currentSpeed === m.moveSpeed && Math.fround(m.remainingDistance - m.currentSpeed) < m.decelDistance) {
    const p1Distance = Math.fround(m.remainingDistance - m.decelDistance);
    const p2Distance = Math.fround(m.moveSpeed * (1.0 - Math.fround(p1Distance / m.moveSpeed)));
    const distance = Math.fround(p1Distance + p2Distance);
    m.currentSpeed = m.moveSpeed;
    m.nextSpeed = Math.fround(m.moveSpeed - Math.fround(m.decel * Math.fround(p2Distance / distance)));
    return;
  }
  // Accelerating?
  if (m.currentSpeed < m.speed) {
    const oldSpeed = m.currentSpeed;
    m.currentSpeed = Math.fround(m.currentSpeed + m.accel);
    if (m.currentSpeed > m.speed) m.currentSpeed = m.speed;
    // Accelerating throughout this move?
    if (Math.fround(m.remainingDistance - m.currentSpeed) >= m.decelDistance) return;
    // Accelerating to move_speed and crossing decel_distance during this move: the
    // average speed over the whole move.
    const p1Distance = Math.fround(m.remainingDistance - m.decelDistance);
    const p1Speed = Math.fround(Math.fround(oldSpeed + m.moveSpeed) / 2.0);
    const p2Distance = Math.fround(m.moveSpeed * (1.0 - Math.fround(p1Distance / p1Speed)));
    const distance = Math.fround(p1Distance + p2Distance);
    m.currentSpeed = Math.fround(
      Math.fround(p1Speed * Math.fround(p1Distance / distance)) + Math.fround(m.moveSpeed * Math.fround(p2Distance / distance)),
    );
    m.nextSpeed = Math.fround(m.moveSpeed - Math.fround(m.decel * Math.fround(p2Distance / distance)));
  }
  // Otherwise at constant speed (move_speed).
}

/** Think_AccelMove: the team has moved a frame, so set the speed for the next. */
function thinkAccelMove(m: BrushMover, levelTime: number): void {
  m.remainingDistance = Math.fround(m.remainingDistance - m.currentSpeed);
  // Starting, or restarted after door_blocked sends it back through Move_Calc (blocking
  // is not modeled).
  if (m.currentSpeed === 0) calcAcceleratedMove(m);
  accelerate(m);
  // Will the whole move complete in the next frame?
  if (m.remainingDistance <= m.currentSpeed) {
    moveFinal(m, levelTime);
    return;
  }
  vectorScale(m.dir, Math.fround(m.currentSpeed * 10), m.velocity);
  m.nextthink = Math.fround(levelTime + FRAMETIME);
  m.think = "thinkAccelMove";
}

/** VectorScale: the scale is a float parameter. */
function vectorScale(v: Vec3f, scale: number, out: Vec3f): void {
  const s = Math.fround(scale);
  for (let i = 0; i < 3; i++) out[i] = Math.fround(v[i]! * s);
}

/**
 * One game frame of SV_Physics_Pusher for a team (master first) at `levelTime`: every
 * moving member is pushed by velocity * FRAMETIME, clamped to 1/8 unit as SV_Push does,
 * and turned by avelocity * FRAMETIME, which is not clamped; then each member runs its
 * think if due (SV_RunThink). Nothing blocks a push here.
 */
export function stepPusher(team: readonly BrushMover[], levelTime: number): void {
  for (const m of team) {
    const v = m.velocity;
    const av = m.avelocity;
    if (!v[0] && !v[1] && !v[2] && !av[0] && !av[1] && !av[2]) continue;
    for (let i = 0; i < 3; i++) {
      const move = Math.fround(v[i]! * FRAMETIME_F);
      // temp is a float in the C, stored after each step.
      let temp = Math.fround(move * 8.0);
      temp = Math.fround(temp + (temp > 0 ? 0.5 : -0.5));
      m.origin[i] = Math.fround(m.origin[i]! + Math.fround(0.125 * Math.trunc(temp)));
    }
    for (let i = 0; i < 3; i++) m.angles[i] = Math.fround(m.angles[i]! + Math.fround(av[i]! * FRAMETIME_F));
  }
  for (const m of team) runThink(m, levelTime);
}

function runThink(m: BrushMover, levelTime: number): void {
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
      return thinkAccelMove(m, levelTime);
    case "angleMoveBegin":
      return angleMoveBegin(m, levelTime);
    case "angleMoveFinal":
      return angleMoveFinal(m, levelTime);
    case "angleMoveDone":
      return angleMoveDone(m, levelTime);
    case "doorGoDown":
      // Run from the door's own think, so its master is level.current_entity: unless
      // it is a team slave, whose think runs inside its master's SV_Physics_Pusher with
      // the master current too. Either way Move_Begin (AngleMove_Begin) runs now.
      return doorGoDown(m, levelTime, true);
  }
}
