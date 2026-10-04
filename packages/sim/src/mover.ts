// SPDX-License-Identifier: GPL-2.0-or-later
// Brush movers stepped at the game's 10 Hz frame, ported from id's game source:
// Move_Calc and its thinks, the accelerative move (Think_AccelMove and the plat_
// functions it calls), AngleMove_Calc and its thinks for a func_door_rotating, the
// func_door, func_plat and func_button state functions, a func_train's train_next,
// train_wait, train_resume and train_use, and Think_CalcMoveSpeed (game/g_func.c), and the move and
// think order of SV_Physics_Pusher and SV_RunThink (game/g_phys.c). Shared so the
// server and the client step movers the same way.
//
// Fields the C keeps as float are rounded with Math.fround where it stores them, and
// float-only arithmetic is rounded at each operation; the C's double intermediates stay
// double, so this matches SSE builds (see BACKLOG.md on x87). A float the C tests for truth
// is compared with 0 here, so NaN counts as true as it does there. Not modeled yet:
// anything that blocks a push (that needs the box trace).

import { cInt } from "./cint.js";

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
  | "platGoDown"
  | "buttonReturn"
  | "trainNext"
  | "thinkAccelMove"
  | "angleMoveBegin"
  | "angleMoveFinal"
  | "angleMoveDone";

/** A path_corner (or any entity a train's "target" names) as train_next reads it. */
export interface PathCorner {
  /** The entity it is. */
  readonly entity: number;
  /** s.origin, as floats. */
  readonly origin: Vec3f;
  /** Its "target": the corner after it. */
  readonly target: string | undefined;
  /** Its "wait", a float: seconds a train waits there, negative to stop. */
  readonly wait: number;
  /** spawnflags & 1, TELEPORT: train_next puts the train there at once. */
  readonly teleport: boolean;
  readonly pathtarget: string | undefined;
}

/** A func_train's fields beyond moveinfo. */
export interface TrainInfo {
  /** self->mins: train_next moves the train's mins to a corner, so its origin to the corner less mins. */
  readonly mins: Vec3f;
  /** self->target: the next corner's name, stepped on by train_next. */
  target: string | undefined;
  /** self->target_ent: the corner train_next last sent it towards. */
  targetEnt: PathCorner | undefined;
  /** spawnflags TRAIN_START_ON (1). */
  startOn: boolean;
  /** spawnflags TRAIN_TOGGLE (2). */
  readonly toggle: boolean;
  /** G_PickTarget on "targetname"; undefined when nothing has that name. */
  readonly pick: (name: string) => PathCorner | undefined;
  /**
   * train_wait's G_UseTargets of a corner's "pathtarget"; returns whether the train is
   * still in use after it (a killtarget may free it). Without it a pathtarget fires nothing.
   */
  usePathtarget: ((corner: PathCorner) => boolean) | undefined;
}

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
  /** moveinfo.endfunc: the door, plat, button or train function Move_Done calls. */
  endfunc: "doorHitTop" | "doorHitBottom" | "platHitTop" | "platHitBottom" | "buttonWait" | "buttonDone" | "trainWait" | undefined;
  think: MoverThink | undefined;
  /** 0 when no think is pending. */
  nextthink: number;
  /**
   * s.event is EV_OTHER_TELEPORT: train_next put it on a TELEPORT corner this frame, so
   * a client does not blend its pose from the frame before (CL_DeltaEntity). Cleared as
   * its team's next frame starts (`stepPusher`); SV_PrepWorldFrame clears every event
   * before any slot runs, so a teleport from a use in an earlier slot of the same frame
   * is wiped here and kept in the game.
   */
  teleported: boolean;
  /** A func_train's fields; undefined for every other mover. */
  readonly train: TrainInfo | undefined;
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
  /** A func_train's fields (`trainInit`). */
  readonly train?: TrainInfo;
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
    teleported: false,
    train: init.train,
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

/**
 * plat_go_down: to end_origin (pos2, the bottom); `current` as for `doorGoUp`. Use_Plat
 * calls it only while the plat's think is null, which it is until the first Move_Calc
 * sets one and stays set after (SV_RunThink clears only nextthink); the caller's to check.
 */
export function platGoDown(m: BrushMover, levelTime: number, current: boolean): void {
  m.state = "down";
  moveCalc(m, m.endOrigin, "platHitBottom", levelTime, current);
}

/** plat_go_up: back to start_origin (pos1, the top); `current` as for `doorGoUp`. */
export function platGoUp(m: BrushMover, levelTime: number, current: boolean): void {
  m.state = "up";
  moveCalc(m, m.startOrigin, "platHitTop", levelTime, current);
}

/**
 * button_fire: returns while the button is going up or at the top, else moves it to
 * end_origin (pos2); `current` as for `doorGoUp`. button_wait fires its targets at the
 * top; that is the caller's.
 */
export function buttonFire(m: BrushMover, levelTime: number, current: boolean): void {
  if (m.state === "up" || m.state === "top") return;
  m.state = "up";
  moveCalc(m, m.endOrigin, "buttonWait", levelTime, current);
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
  if (length !== 0) {
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
  switch (m.endfunc) {
    case "doorHitTop":
      return doorHitTop(m, levelTime);
    case "doorHitBottom":
    case "platHitBottom":
      m.state = "bottom";
      return;
    case "platHitTop":
      return platHitTop(m, levelTime);
    case "buttonWait":
      return buttonWait(m, levelTime);
    case "buttonDone":
      m.state = "bottom";
      return;
    case "trainWait":
      return trainWait(m, levelTime);
  }
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
  // VectorCompare with vec3_origin: a NaN angle is not equal.
  if (move[0] === 0 && move[1] === 0 && move[2] === 0) {
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

/** plat_hit_top: whatever its "wait", a plat goes back down 3 seconds after reaching the top. */
function platHitTop(m: BrushMover, levelTime: number): void {
  m.state = "top";
  m.think = "platGoDown";
  m.nextthink = Math.fround(levelTime + 3);
}

/** button_wait: at the top, button_return is due after "wait" unless it is negative. */
function buttonWait(m: BrushMover, levelTime: number): void {
  m.state = "top";
  if (m.wait >= 0) {
    m.nextthink = Math.fround(levelTime + m.wait);
    m.think = "buttonReturn";
  }
}

/** button_return: back to start_origin (pos1), from the button's own think. */
function buttonReturn(m: BrushMover, levelTime: number): void {
  m.state = "down";
  moveCalc(m, m.startOrigin, "buttonDone", levelTime, true);
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
      if (m.nextSpeed !== 0) {
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
 * think if due (SV_RunThink). Nothing blocks a push here. A NaN velocity counts as moving
 * and, like an infinite one, moves INT_MIN / 8 units on that axis (`cInt`): a team whose
 * speeds Think_CalcMoveSpeed made infinite or NaN steps by about -2.7e8 a frame.
 *
 * Returns the members whose think ran door_hit_bottom this frame, in the order they ran:
 * the caller closes their area portals (door_use_areaportals). A think that leaves a
 * member at STATE_BOTTOM with door_hit_bottom as its endfunc ran it: Move_Done and
 * AngleMove_Done are the only ways there after spawn, and the endfunc stays set.
 */
export function stepPusher(team: readonly BrushMover[], levelTime: number): BrushMover[] {
  for (const m of team) m.teleported = false;
  for (const m of team) {
    const v = m.velocity;
    const av = m.avelocity;
    if (v[0] === 0 && v[1] === 0 && v[2] === 0 && av[0] === 0 && av[1] === 0 && av[2] === 0) continue;
    for (let i = 0; i < 3; i++) {
      const move = Math.fround(v[i]! * FRAMETIME_F);
      // temp is a float in the C, stored after each step.
      let temp = Math.fround(move * 8.0);
      temp = Math.fround(temp + (temp > 0 ? 0.5 : -0.5));
      m.origin[i] = Math.fround(m.origin[i]! + Math.fround(0.125 * cInt(temp)));
    }
    for (let i = 0; i < 3; i++) m.angles[i] = Math.fround(m.angles[i]! + Math.fround(av[i]! * FRAMETIME_F));
  }
  const hitBottom: BrushMover[] = [];
  for (const m of team) {
    const was = m.state;
    runThink(m, levelTime);
    if (m.state === "bottom" && was !== "bottom" && m.endfunc === "doorHitBottom") hitBottom.push(m);
  }
  return hitBottom;
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
    case "platGoDown":
      // From the plat's own think, current as for doorGoDown.
      return platGoDown(m, levelTime, true);
    case "buttonReturn":
      // From the button's own think, current as for doorGoDown.
      return buttonReturn(m, levelTime);
    case "trainNext":
      // From the train's own think, current as for doorGoDown.
      return trainNext(m, levelTime, true);
  }
}

/**
 * How deeply train_wait may run train_next, which may finish its move at once and run
 * train_wait again: a loop of corners at no distance from each other with no "wait"
 * recurses in the game until it crashes. Past this the train stays where it is.
 */
const MAX_TRAIN_WAIT_DEPTH = 256;
let trainWaitDepth = 0;

function trainOf(m: BrushMover): TrainInfo {
  if (!m.train) throw new Error("not a func_train");
  return m.train;
}

/**
 * train_next: picks the corner self->target names and steps self->target on to that
 * corner's "target". A TELEPORT corner puts the train there at once (its mins on the
 * corner, s.event EV_OTHER_TELEPORT) and steps on again; a second one in a row stops it
 * there. Any other corner becomes target_ent, its "wait" moveinfo.wait, and the train
 * moves to it (Move_Calc, train_wait at the end) with START_ON set. Without a target or
 * a corner it returns. `current` as for `doorGoUp`.
 */
export function trainNext(m: BrushMover, levelTime: number, current: boolean): void {
  const t = trainOf(m);
  let first = true;
  for (;;) {
    if (t.target === undefined) return;
    const corner = t.pick(t.target);
    if (!corner) return;
    t.target = corner.target;
    if (corner.teleport) {
      if (!first) return;
      first = false;
      cornerLessMins(corner, t, m.origin);
      m.teleported = true;
      continue;
    }
    m.wait = corner.wait;
    t.targetEnt = corner;
    trainMoveTo(m, t, corner, levelTime, current);
    return;
  }
}

/** train_resume: moves on towards target_ent, which train_next set; `current` as for `doorGoUp`. */
export function trainResume(m: BrushMover, levelTime: number, current: boolean): void {
  const t = trainOf(m);
  if (!t.targetEnt) throw new Error("train_resume without a target_ent");
  trainMoveTo(m, t, t.targetEnt, levelTime, current);
}

/**
 * train_use: a START_ON train ignores it unless TOGGLE, which stops it where it is
 * (START_ON cleared, velocity and the pending think dropped); a stopped one resumes
 * towards target_ent, or without one runs train_next. `current` as for `doorGoUp`.
 */
export function trainUse(m: BrushMover, levelTime: number, current: boolean): void {
  const t = trainOf(m);
  if (t.startOn) {
    if (!t.toggle) return;
    t.startOn = false;
    m.velocity.fill(0);
    m.nextthink = 0;
  } else if (t.targetEnt) {
    trainResume(m, levelTime, current);
  } else {
    trainNext(m, levelTime, current);
  }
}

/** VectorSubtract (corner origin, self->mins, out), in float. */
function cornerLessMins(corner: PathCorner, t: TrainInfo, out: Vec3f): void {
  for (let i = 0; i < 3; i++) out[i] = Math.fround(corner.origin[i]! - t.mins[i]!);
}

/** The end of train_next and train_resume: STATE_TOP, from where it is to the corner, then train_wait. */
function trainMoveTo(m: BrushMover, t: TrainInfo, corner: PathCorner, levelTime: number, current: boolean): void {
  const dest: Vec3f = [0, 0, 0];
  cornerLessMins(corner, t, dest);
  m.state = "top";
  for (let i = 0; i < 3; i++) {
    m.startOrigin[i] = m.origin[i]!;
    m.endOrigin[i] = dest[i]!;
  }
  moveCalc(m, dest, "trainWait", levelTime, current);
  t.startOn = true;
}

/**
 * train_wait, at target_ent: fires its "pathtarget" (`usePathtarget`) and returns if
 * that freed the train. Then a positive wait has train_next due after it; a negative one
 * stops the train there, except that a TOGGLE train runs train_next first and stops at
 * once (START_ON cleared, velocity and the pending think dropped); no wait runs train_next.
 */
function trainWait(m: BrushMover, levelTime: number): void {
  const t = trainOf(m);
  const corner = t.targetEnt!;
  if (trainWaitDepth >= MAX_TRAIN_WAIT_DEPTH) return;
  trainWaitDepth++;
  try {
    if (corner.pathtarget !== undefined && t.usePathtarget && !t.usePathtarget(corner)) return;
    if (m.wait) {
      if (m.wait > 0) {
        m.nextthink = Math.fround(levelTime + m.wait);
        m.think = "trainNext";
      } else if (t.toggle) {
        // Run from Move_Done, inside the train's own think.
        trainNext(m, levelTime, true);
        t.startOn = false;
        m.velocity.fill(0);
        m.nextthink = 0;
      }
    } else {
      trainNext(m, levelTime, true);
    }
  } finally {
    trainWaitDepth--;
  }
}
