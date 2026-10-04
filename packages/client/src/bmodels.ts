// SPDX-License-Identifier: GPL-2.0-or-later
// Inline brush model instances (func_wall, doors, plats: entities with "model" "*N")
// at their compiled position rotated by the entity's spawn angles and moved by its
// "origin", then moved as the game moves it during spawn (lowered plats, doors that
// start open, trains at their first path_corner or the teleport one after it), from the
// entity string alone, and turret breaches (with their teams) turned to where they
// come to rest in their pitch/yaw range. DOM-free.

import { asciiLower, entityVec3, type Bsp, type BspEntity } from "@quack2/sim";
import { angleVectors } from "./math.js";

/** game/g_local.h: entities with this flag are freed at spawn in deathmatch. */
const SPAWNFLAG_NOT_DEATHMATCH = 0x800;
/** NOT_EASY | NOT_MEDIUM | NOT_HARD | NOT_DEATHMATCH | NOT_COOP: g_spawn.c clears these before the spawn function runs. */
const SPAWNFLAG_SKILL_MASK = 0x1f00;

/**
 * Classnames whose spawn function (g_spawn.c spawns table) shows the brush model to
 * clients. Everything else with a "*N" model is never sent: triggers and func_killbox
 * set SVF_NOCLIENT, func_areaportal never sets a model, func_explosive frees itself in
 * deathmatch, and a classname with no spawn function is not spawned at all.
 */
const SHOWN_BRUSH_CLASSES = new Set([
  "func_plat",
  "func_button",
  "func_door",
  "func_door_secret",
  "func_door_rotating",
  "func_rotating",
  "func_train",
  "func_water",
  "func_conveyor",
  "func_wall",
  "func_object",
  "target_character",
  "turret_breach",
  "turret_base",
]);

/**
 * Classnames whose spawn function leaves s.angles as the map set them. The rest clear
 * them: G_SetMovedir (doors, buttons, water) turns them into a move direction, and
 * func_plat, func_train, func_door_secret and func_door_rotating clear them directly (a
 * START_OPEN func_door_rotating then turns to its open angles, in `spawnMove`).
 */
const KEEPS_ANGLES = new Set([
  "func_rotating",
  "func_conveyor",
  "func_wall",
  "func_object",
  "target_character",
  "turret_breach",
  "turret_base",
]);

/** atoi as ED_ParseField uses it: optional whitespace and sign, leading digits, else 0. Out of range clamps (MSVC). */
function atoi(s: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s);
  return m ? Math.min(Math.max(Number(m[1]), -0x80000000), 0x7fffffff) : 0;
}

/** atof's leading-number prefix, else 0. Decimal forms only. */
function atof(s: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/**
 * Entity angles (pitch, yaw, roll): "angle" is a yaw alone, "angles" all three, and
 * whichever key comes later wins, as in ED_ParseField (parseEntities folds key case and
 * orders keys by last assignment). Unlike the game, an "angles" that is not exactly three
 * numbers counts as none, as a malformed "origin" does.
 */
export function entityAngles(ent: BspEntity): [number, number, number] {
  const keys = Object.keys(ent).filter((k) => k === "angle" || k === "angles");
  const last = keys[keys.length - 1];
  if (last === "angle") return [0, atof(ent.angle!), 0];
  if (last === "angles") return entityVec3(ent, "angles") ?? [0, 0, 0];
  return [0, 0, 0];
}

type Vec3 = [number, number, number];

/** g_func.c spawnflags. */
const DOOR_START_OPEN = 1;
const DOOR_REVERSE = 2;
const DOOR_X_AXIS = 64;
const DOOR_Y_AXIS = 128;
const TRAIN_START_ON = 1;
const PATH_CORNER_TELEPORT = 1;

/** Q_stricmp equality (see `asciiLower`). */
function stricmpEqual(a: string, b: string): boolean {
  return asciiLower(a) === asciiLower(b);
}

/**
 * G_PickTarget: an entity whose "targetname" matches `target` case insensitively (G_Find,
 * Q_stricmp), among entities still in the game. With several, the game picks one at
 * random; this takes the first. Only NOT_DEATHMATCH entities count as gone: entities
 * whose spawn function frees itself in deathmatch (monsters, some items) still match.
 */
function pickTarget(entities: readonly BspEntity[], target: string | undefined): BspEntity | undefined {
  if (target === undefined) return undefined;
  return entities.find(
    (e) =>
      e.targetname !== undefined && stricmpEqual(e.targetname, target) && !(atoi(e.spawnflags ?? "0") & SPAWNFLAG_NOT_DEATHMATCH),
  );
}

/** G_SetMovedir: angles 0 -1 0 mean up, 0 -2 0 down, anything else the forward vector. */
function moveDir(angles: readonly [number, number, number]): Vec3 {
  if (angles[0] === 0 && angles[2] === 0 && angles[1] === -1) return [0, 0, 1];
  if (angles[0] === 0 && angles[2] === 0 && angles[1] === -2) return [0, 0, -1];
  const f = angleVectors(angles[0], angles[1], angles[2]).forward;
  return [f[0], f[1], f[2]];
}

/**
 * Where the game has put a brush entity after the two frames SV_SpawnServer runs to
 * settle, from its spawn "origin" (and angles, 0 0 0 for every class moved here), per g_func.c.
 * `mins`/`maxs` are the entity's bounds as gi.setmodel sets them: the model's bounds
 * spread by a unit (CMod_LoadSubmodels). "lip", "height" and "distance" are integer
 * spawn fields (atoi), 0 when absent. Positions are computed in double; the game uses float.
 */
function spawnMove(
  ent: BspEntity,
  entities: readonly BspEntity[],
  mins: readonly number[],
  maxs: readonly number[],
  origin: Vec3,
  angles: Vec3,
): { origin: Vec3; angles: Vec3 } {
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  const size = [0, 1, 2].map((k) => maxs[k]! - mins[k]!);
  switch (ent.classname) {
    // SP_func_plat: pos2 is the bottom, "height" below the top or the plat's height less
    // "lip" (default 8). Only a plat something targets starts at the top.
    case "func_plat": {
      if (ent.targetname !== undefined) break;
      const height = atoi(ent.height ?? "0");
      const lip = atoi(ent.lip ?? "0") || 8;
      return { origin: [origin[0], origin[1], origin[2] - (height || size[2]! - lip)], angles };
    }
    // SP_func_door / SP_func_water: START_OPEN swaps pos1 and pos2, which lies the size
    // of the entity along the move direction, less "lip" (8 by default for doors only).
    case "func_door":
    case "func_water": {
      if (!(flags & DOOR_START_OPEN)) break;
      const dir = moveDir(entityAngles(ent));
      const lip = atoi(ent.lip ?? "0") || (ent.classname === "func_door" ? 8 : 0);
      const distance = Math.abs(dir[0]) * size[0]! + Math.abs(dir[1]) * size[1]! + Math.abs(dir[2]) * size[2]! - lip;
      return { origin: [0, 1, 2].map((k) => origin[k]! + distance * dir[k]!) as Vec3, angles };
    }
    // SP_func_door_rotating: START_OPEN starts at "distance" degrees (default 90) about
    // the door's axis: yaw, or roll for X_AXIS, pitch for Y_AXIS; REVERSE negates it.
    case "func_door_rotating": {
      if (!(flags & DOOR_START_OPEN)) break;
      const axis = flags & DOOR_X_AXIS ? 2 : flags & DOOR_Y_AXIS ? 0 : 1;
      const distance = atoi(ent.distance ?? "0") || 90;
      const open: Vec3 = [0, 0, 0];
      open[axis] = flags & DOOR_REVERSE ? -distance : distance;
      return { origin, angles: open };
    }
    // func_train_find, the train's first think: its mins go to the origin of the entity
    // its "target" names. A train nothing targets, or one with START_ON, runs train_next
    // in the second settle frame (SV_SpawnServer runs two before any client is sent the
    // entity); it jumps on at once only if that next entity is a TELEPORT path_corner.
    case "func_train": {
      const first = pickTarget(entities, ent.target);
      if (!first) break;
      let at = entityVec3(first, "origin") ?? [0, 0, 0];
      if (ent.targetname === undefined || flags & TRAIN_START_ON) {
        const next = pickTarget(entities, first.target);
        if (next && atoi(next.spawnflags ?? "0") & PATH_CORNER_TELEPORT) at = entityVec3(next, "origin") ?? [0, 0, 0];
      }
      return { origin: [0, 1, 2].map((k) => at[k]! - mins[k]!) as Vec3, angles };
    }
  }
  return { origin, angles };
}

/** g_local.h: seconds per server frame. */
const FRAMETIME = 0.1;
/** Classes whose spawn function frees them in deathmatch before G_FindTeams (SP_light, SP_func_explosive). */
const FREED_IN_DEATHMATCH = new Set(["light", "func_explosive"]);
/** Frames a turret team is run for at most (1000 s); one that never settles is drawn as it is then. */
const MAX_SETTLE_FRAMES = 10000;
/** A turn per frame below this (degrees) counts as settled; a double never quite reaches zero. */
const SETTLED = 1e-9;

/**
 * g_turret.c AnglesNormalize on one angle: `while (a > 360) a -= 360; while (a < 0) a += 360;`
 * in closed form, so a huge angle does not spin here as the game's loop would.
 */
function normalizeAngle(a: number): number {
  if (a > 360) return a - 360 * Math.ceil((a - 360) / 360);
  if (a < 0) return a + 360 * Math.ceil(-a / 360);
  return a;
}

/** The wrap turret_breach_think applies once to each delta. */
function wrap180(d: number): number {
  return d < -180 ? d + 360 : d > 180 ? d - 360 : d;
}

interface Breach {
  readonly index: number;
  /** s.angles, turned each frame by the pitch and the team's yaw velocity. */
  readonly angles: Vec3;
  /** move_angles: where the breach turns to, clamped into its range each frame. */
  readonly move: Vec3;
  readonly pos1: readonly [number, number];
  readonly pos2: readonly [number, number];
  readonly speed: number;
  pitchVel: number;
}

/** SP_turret_breach's fields: speed default 50, minpitch -30, maxpitch 30, maxyaw 360; a 0 means the default. */
function breachState(ent: BspEntity, index: number): Breach {
  const field = (key: string, fallback: number) => atof(ent[key] ?? "0") || fallback;
  const angles = entityAngles(ent);
  return {
    index,
    angles,
    move: [0, angles[1], 0],
    pos1: [-field("minpitch", -30), atof(ent.minyaw ?? "0")],
    pos2: [-field("maxpitch", 30), field("maxyaw", 360)],
    speed: field("speed", 50),
    pitchVel: 0,
  };
}

/** turret_breach_think up to its avelocity: the pitch and yaw turned this frame, at most speed * FRAMETIME each. */
function breachThink(b: Breach): [number, number] {
  const move = b.move;
  move[0] = normalizeAngle(move[0]);
  move[1] = normalizeAngle(move[1]);
  if (move[0] > 180) move[0] -= 360;
  if (move[0] > b.pos1[0]) move[0] = b.pos1[0];
  else if (move[0] < b.pos2[0]) move[0] = b.pos2[0];
  if (move[1] < b.pos1[1] || move[1] > b.pos2[1]) {
    // The game takes fabs before wrapping, so the < -180 case never applies.
    const dmin = wrap180(Math.abs(b.pos1[1] - move[1]));
    const dmax = wrap180(Math.abs(b.pos2[1] - move[1]));
    move[1] = Math.abs(dmin) < Math.abs(dmax) ? b.pos1[1] : b.pos2[1];
  }
  const step = b.speed * FRAMETIME;
  const clamp = (d: number) => {
    if (d > step) d = step;
    if (d < -step) d = -step;
    return d;
  };
  return [clamp(wrap180(move[0] - normalizeAngle(b.angles[0]))), clamp(wrap180(move[1] - normalizeAngle(b.angles[1])))];
}

/**
 * Turret breaches turned to rest, as the game does over the first seconds: each frame
 * SV_Physics_Pusher turns every member of a team by its avelocity, then runs the
 * breaches' thinks in team order. A breach's think sets its own pitch velocity and the
 * yaw velocity of every member of its team (G_FindTeams: the in-game entities with the
 * same "team", compared case sensitively, in entity order), so the last breach in a team
 * sets the yaw every member turns by. A breach with no team turns alone here; the stock
 * game crashes on it (turret_breach_finish_init writes through its NULL teammaster).
 *
 * Returns, per entity index, the breach's angles at rest, or for any other team member
 * the yaw it has turned by. Only teams whose master (first member) is a turret are run:
 * any other master runs the team under its own movetype, which is not modeled, and its
 * members keep their spawn angles. So does a team with a non-finite angle or field.
 */
function settleTurrets(entities: readonly BspEntity[]): Map<number, { angles?: Vec3; yaw?: number }> {
  const inGame = (e: BspEntity) =>
    !(atoi(e.spawnflags ?? "0") & SPAWNFLAG_NOT_DEATHMATCH) && !FREED_IN_DEATHMATCH.has(e.classname ?? "");
  const groups: number[][] = [];
  const teams = new Map<string, number[]>();
  entities.forEach((e, i) => {
    if (i === 0 || !inGame(e)) return; // edict 0 (worldspawn) is never in a team
    if (e.team !== undefined) {
      const members = teams.get(e.team);
      if (members) members.push(i);
      else teams.set(e.team, [i]);
    } else if (e.classname === "turret_breach") groups.push([i]);
  });
  for (const members of teams.values()) {
    const master = entities[members[0]!]!.classname;
    if (master === "turret_breach" || master === "turret_base") groups.push(members);
  }

  const result = new Map<number, { angles?: Vec3; yaw?: number }>();
  for (const members of groups) {
    const breaches = members.filter((i) => entities[i]!.classname === "turret_breach").map((i) => breachState(entities[i]!, i));
    if (breaches.length === 0) continue;
    const values = breaches.flatMap((b) => [...b.angles, ...b.pos1, ...b.pos2, b.speed]);
    if (!values.every(Number.isFinite)) continue;
    let yawVel = 0;
    let turned = 0;
    for (let frame = 0; frame < MAX_SETTLE_FRAMES; frame++) {
      for (const b of breaches) {
        b.angles[0] += b.pitchVel * FRAMETIME;
        b.angles[1] += yawVel * FRAMETIME;
      }
      turned += yawVel * FRAMETIME;
      for (const b of breaches) {
        const [pitch, yaw] = breachThink(b);
        b.pitchVel = pitch / FRAMETIME;
        yawVel = yaw / FRAMETIME;
      }
      // Only the last breach's yaw is kept, so an earlier one may never reach its own.
      const step = Math.max(Math.abs(yawVel), ...breaches.map((b) => Math.abs(b.pitchVel))) * FRAMETIME;
      if (step <= SETTLED) break;
    }
    for (const i of members) result.set(i, { yaw: turned });
    for (const b of breaches) result.set(b.index, { angles: b.angles });
  }
  return result;
}

/** An inline model's bounds as the game and renderer use them: spread by a unit (CMod_LoadSubmodels, Mod_LoadSubmodels). */
export function modelBounds(bsp: Bsp, model: number): { mins: Vec3; maxs: Vec3 } {
  const m = model * 3;
  const { mins, maxs } = bsp.models;
  return {
    mins: [mins[m]! - 1, mins[m + 1]! - 1, mins[m + 2]! - 1],
    maxs: [maxs[m]! + 1, maxs[m + 1]! + 1, maxs[m + 2]! + 1],
  };
}

export interface BrushModelInstance {
  /** Index into bsp.models, 1 or more. */
  readonly model: number;
  /** World translation of the model's faces: the entity's "origin", default 0 0 0, after any spawn move. */
  readonly origin: readonly [number, number, number];
  /** Rotation (pitch, yaw, roll) about the model-space origin, applied before `origin`: the spawn angles for classes that keep them, a START_OPEN func_door_rotating's open angles, else 0 0 0; a turret breach at rest, and the members of its team turned by its yaw. */
  readonly angles: readonly [number, number, number];
  readonly classname: string;
}

export interface BrushModelInstances {
  readonly instances: readonly BrushModelInstance[];
  /** Entities whose "model" names no inline model of this map. Not drawn. */
  readonly errors: readonly string[];
}

/**
 * Whether the deathmatch game sends this brush entity to clients right after spawning,
 * per the SP_ spawn functions in id's game source (g_spawn.c, g_misc.c, g_func.c,
 * g_trigger.c).
 */
export function visibleAtSpawn(ent: BspEntity): boolean {
  const classname = ent.classname ?? "";
  const raw = atoi(ent.spawnflags ?? "0");
  if (raw & SPAWNFLAG_NOT_DEATHMATCH || !SHOWN_BRUSH_CLASSES.has(classname)) return false;
  const flags = raw & ~SPAWNFLAG_SKILL_MASK;
  switch (classname) {
    // SP_func_wall: any of TRIGGER_SPAWN | TOGGLE | START_ON makes it triggerable, and it
    // starts hidden unless START_ON.
    case "func_wall":
      return !(flags & 7) || (flags & 4) !== 0;
    // SP_func_object: any remaining spawnflag (even the animation ones) leaves it hidden until used.
    case "func_object":
      return flags === 0;
  }
  return true;
}

export function brushModelInstances(bsp: Bsp, entities: readonly BspEntity[]): BrushModelInstances {
  const instances: BrushModelInstance[] = [];
  const errors: string[] = [];
  const turrets = settleTurrets(entities);
  entities.forEach((ent, i) => {
    const ref = ent.model;
    // Point entities carry model paths ("models/..."); only "*N" is an inline model.
    if (ref === undefined || !ref.startsWith("*")) return;
    const classname = ent.classname ?? "";
    const model = /^\*\d+$/.test(ref) ? Number(ref.slice(1)) : Number.NaN;
    // *0 is the world itself, drawn separately.
    if (!(model >= 1 && model < bsp.models.count)) {
      errors.push(`entity ${i} (${classname}): model "${ref}" is not an inline model of this map`);
      return;
    }
    if (!visibleAtSpawn(ent)) return;
    const { mins, maxs } = modelBounds(bsp, model);
    const spawn = entityVec3(ent, "origin") ?? [0, 0, 0];
    const { origin, angles } = spawnMove(ent, entities, mins, maxs, spawn, KEEPS_ANGLES.has(classname) ? entityAngles(ent) : [0, 0, 0]);
    const turn = turrets.get(i);
    const turned: Vec3 = turn?.angles ?? (turn?.yaw ? [angles[0], angles[1] + turn.yaw, angles[2]] : angles);
    instances.push({ model, origin, angles: turned, classname });
  });
  return { instances, errors };
}
