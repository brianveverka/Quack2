// SPDX-License-Identifier: GPL-2.0-or-later
// Inline brush model instances (func_wall, doors, plats: entities with "model" "*N")
// at their compiled position rotated by the entity's spawn angles and moved by its
// "origin", from the entity string alone. Moves the game makes at spawn (lowered plats,
// open doors) are not applied. DOM-free.

import { entityVec3, type Bsp, type BspEntity } from "@quack2/sim";

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
 * START_OPEN func_door_rotating then turns to its open angles: a spawn move, not applied).
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

export interface BrushModelInstance {
  /** Index into bsp.models, 1 or more. */
  readonly model: number;
  /** World translation of the model's faces: the entity's "origin", default 0 0 0. */
  readonly origin: readonly [number, number, number];
  /** Rotation (pitch, yaw, roll) about the model-space origin, applied before `origin`; 0 0 0 for classes that clear it at spawn. */
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
    instances.push({
      model,
      origin: entityVec3(ent, "origin") ?? [0, 0, 0],
      angles: KEEPS_ANGLES.has(classname) ? entityAngles(ent) : [0, 0, 0],
      classname,
    });
  });
  return { instances, errors };
}
