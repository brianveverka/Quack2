// SPDX-License-Identifier: GPL-2.0-or-later
// Inline brush model instances (func_wall, doors, plats: entities with "model" "*N")
// at their compiled position rotated by the entity's spawn angles and moved by its
// "origin", then moved as the game moves it during spawn (lowered plats, doors that
// start open, trains at their first path_corner or the teleport one after it), from the
// entity string alone. Turrets turning into their pitch/yaw range afterwards are not
// applied. DOM-free.

import { entityVec3, type Bsp, type BspEntity } from "@quack2/sim";
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
 * whichever key comes later wins, as in ED_ParseField. Unlike the game, keys match case
 * sensitively (as for every key here) and an "angles" that is not exactly three numbers
 * counts as none, as a malformed "origin" does.
 */
export function entityAngles(ent: BspEntity): [number, number, number] {
  // Key order is first appearance: a key repeated after the other one is not seen as later.
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

/** Q_stricmp: case folds ASCII letters only. */
function stricmpEqual(a: string, b: string): boolean {
  const fold = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
  return fold(a) === fold(b);
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
  /** Rotation (pitch, yaw, roll) about the model-space origin, applied before `origin`: the spawn angles for classes that keep them, a START_OPEN func_door_rotating's open angles, else 0 0 0. */
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
    instances.push({ model, origin, angles, classname });
  });
  return { instances, errors };
}
