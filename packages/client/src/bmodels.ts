// SPDX-License-Identifier: GPL-2.0-or-later
// Inline brush model instances (func_wall, doors, plats: entities with "model" "*N")
// at their compiled position rotated by the entity's spawn angles and moved by its
// "origin", then moved as the game moves it during spawn (lowered plats, doors that
// start open, trains at their first path_corner or the teleport one after it), from the
// entity string alone, and turret breaches (with their teams) turned to where they
// come to rest in their pitch/yaw range. Those a killtarget frees in the settle frames
// are left out, and func_wall and func_object entities a use there shows or hides are
// drawn or left out to match. DOM-free.

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
const TRAIN_TOGGLE = 2;
const PATH_CORNER_TELEPORT = 1;

/** Q_stricmp equality (see `asciiLower`). */
function stricmpEqual(a: string, b: string): boolean {
  return asciiLower(a) === asciiLower(b);
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
  mins: readonly number[],
  maxs: readonly number[],
  origin: Vec3,
  angles: Vec3,
  trainAt: Vec3 | undefined,
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
    // Trains: their mins sit on the corner the settle frames left them at (`settleSpawnFrames`).
    case "func_train": {
      if (!trainAt) break;
      return { origin: [0, 1, 2].map((k) => trainAt[k]! - mins[k]!) as Vec3, angles };
    }
  }
  return { origin, angles };
}

/** g_local.h: seconds per server frame. */
const FRAMETIME = 0.1;
/** Classes whose spawn function always frees them in deathmatch, before G_FindTeams (lights, monsters, single-player props and goals). */
const FREED_IN_DEATHMATCH = new Set([
  "light",
  "func_explosive",
  "info_null",
  "func_group",
  "info_player_coop",
  "point_combat",
  "misc_explobox",
  "misc_deadsoldier",
  "misc_actor",
  "misc_insane",
  "target_secret",
  "target_goal",
  "target_help",
  "target_lightramp",
  "turret_driver",
  "monster_berserk",
  "monster_gladiator",
  "monster_gunner",
  "monster_infantry",
  "monster_soldier_light",
  "monster_soldier",
  "monster_soldier_ss",
  "monster_tank",
  "monster_tank_commander",
  "monster_medic",
  "monster_flipper",
  "monster_chick",
  "monster_parasite",
  "monster_flyer",
  "monster_brain",
  "monster_floater",
  "monster_hover",
  "monster_mutant",
  "monster_supertank",
  "monster_boss2",
  "monster_boss3_stand",
  "monster_jorg",
]);
/**
 * Classes whose spawn function sets MOVETYPE_PUSH or MOVETYPE_STOP. G_RunEntity runs
 * them through SV_Physics_Pusher, which as a team master pushes every member and runs
 * every member's think each frame. Every other class that stays in a deathmatch game is
 * MOVETYPE_NONE at spawn (the G_Spawn default), except misc_gib_* (MOVETYPE_TOSS); items
 * become MOVETYPE_TOSS in droptofloor. Under any of those a master runs only its own
 * think, so a pusher slave (a turret) never thinks: SV_Physics_Pusher returns for an
 * FL_TEAMSLAVE. func_explosive and turret_driver are listed for the movetype alone; the
 * game frees both in deathmatch.
 */
const PUSHER_CLASSES = new Set([
  "func_plat",
  "func_rotating",
  "func_button",
  "func_door",
  "func_door_rotating",
  "func_water",
  "func_train",
  "func_door_secret",
  "func_wall",
  "func_object",
  "func_explosive",
  "misc_viper",
  "misc_strogg_ship",
  "target_character",
  "turret_breach",
  "turret_base",
  "turret_driver",
]);
/** Classnames ED_CallSpawn hands to SpawnItem (itemlist, and SP_item_health*), whose think is droptofloor in the second frame. */
const ITEM_CLASSES = new Set([
  "item_armor_body",
  "item_armor_combat",
  "item_armor_jacket",
  "item_armor_shard",
  "item_power_screen",
  "item_power_shield",
  "weapon_blaster",
  "weapon_shotgun",
  "weapon_supershotgun",
  "weapon_machinegun",
  "weapon_chaingun",
  "ammo_grenades",
  "weapon_grenadelauncher",
  "weapon_rocketlauncher",
  "weapon_hyperblaster",
  "weapon_railgun",
  "weapon_bfg",
  "ammo_shells",
  "ammo_bullets",
  "ammo_cells",
  "ammo_rockets",
  "ammo_slugs",
  "item_quad",
  "item_invulnerability",
  "item_silencer",
  "item_breather",
  "item_enviro",
  "item_ancient_head",
  "item_adrenaline",
  "item_bandolier",
  "item_pack",
  "key_data_cd",
  "key_power_cube",
  "key_pyramid",
  "key_data_spinner",
  "key_pass",
  "key_blue_key",
  "key_red_key",
  "key_commander_head",
  "key_airstrike_target",
  "item_health",
  "item_health_small",
  "item_health_large",
  "item_health_mega",
]);
/** Frames a turret team is run for at most (1000 s); one that never settles is drawn as it is then. */
const MAX_SETTLE_FRAMES = 10000;
/** A turn per frame below this (degrees) counts as settled; a double never quite reaches zero. */
const SETTLED = 1e-9;

/**
 * Whether an entity's spawn function frees it in deathmatch: always for the classes in
 * FREED_IN_DEATHMATCH, and for some when a key it needs is missing (an empty value is
 * still set). Items dmflags would remove stay: dmflags 0 is assumed.
 */
function freedAtSpawn(e: BspEntity): boolean {
  const classname = e.classname ?? "";
  if (FREED_IN_DEATHMATCH.has(classname)) return true;
  switch (classname) {
    case "path_corner":
      return e.targetname === undefined;
    case "misc_viper":
    case "misc_strogg_ship":
    case "misc_teleporter":
      return e.target === undefined;
    case "func_clock":
      return e.target === undefined || ((atoi(e.spawnflags ?? "0") & 2) !== 0 && atoi(e.count ?? "0") === 0);
    case "target_changelevel":
      return e.map === undefined;
    case "trigger_gravity":
      return e.gravity === undefined;
  }
  return false;
}

/** Whether an entity is still in the game after spawning in deathmatch. */
function inGame(e: BspEntity): boolean {
  return !(atoi(e.spawnflags ?? "0") & SPAWNFLAG_NOT_DEATHMATCH) && !freedAtSpawn(e);
}

/**
 * G_FindTeams: the in-game entities with the same "team", compared case sensitively, by
 * entity index in entity order; the first of each is its master, the rest are
 * FL_TEAMSLAVE. Edict 0 (worldspawn) is never in a team.
 */
function findTeams(entities: readonly BspEntity[]): Map<string, number[]> {
  const teams = new Map<string, number[]>();
  entities.forEach((e, i) => {
    if (i === 0 || !inGame(e) || e.team === undefined) return;
    const members = teams.get(e.team);
    if (members) members.push(i);
    else teams.set(e.team, [i]);
  });
  return teams;
}

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
 * members' thinks in team order. A breach's think sets its own pitch velocity and the
 * yaw velocity of every member of its team (G_FindTeams: the in-game entities with the
 * same "team", compared case sensitively, in entity order), so the last breach in a team
 * sets the yaw every member turns by. A breach with no team turns alone here; the stock
 * game crashes on it (turret_breach_finish_init writes through its NULL teammaster).
 *
 * Only a master in PUSHER_CLASSES runs its slaves' thinks; under any other the team keeps
 * its spawn angles. A spawnflags-0 func_object master turns MOVETYPE_TOSS in its think in
 * the second frame (func_object_release), so its team runs for two frames only (turning in
 * the second), and the master alone turns once more in the third: SV_Physics_Toss turns it by the avelocity the
 * breaches last set until it lands (later frames need the trace). An item on the team
 * cuts the master's chain after itself in its droptofloor, in the second frame: members
 * after it are neither turned nor thought for from then on. Other frees that cut a chain
 * the same way are not modeled (a killtarget, turret_breach_finish_init freeing its
 * target, a target_crosslevel_target firing), nor a use that releases a triggered
 * func_object. A turned member's own spin (a START_ON func_rotating) is not added. An
 * inverted pitch range (minpitch > maxpitch) flips move_angles between the limits every
 * frame, forever; it runs to MAX_SETTLE_FRAMES here, or stops on a frame that turns
 * nothing.
 *
 * Returns, per entity index, the breach's angles at rest, or for any other team member
 * the yaw it has turned by. A team with a non-finite angle or field is not run.
 */
function settleTurrets(entities: readonly BspEntity[]): Map<number, { angles?: Vec3; yaw?: number }> {
  const groups: number[][] = [];
  entities.forEach((e, i) => {
    if (i > 0 && inGame(e) && e.team === undefined && e.classname === "turret_breach") groups.push([i]);
  });
  for (const members of findTeams(entities).values()) {
    if (PUSHER_CLASSES.has(entities[members[0]!]!.classname ?? "")) groups.push(members);
  }

  const result = new Map<number, { angles?: Vec3; yaw?: number }>();
  for (const members of groups) {
    const breachAt = members.map((i) => (entities[i]!.classname === "turret_breach" ? breachState(entities[i]!, i) : undefined));
    const breaches = breachAt.filter((b) => b !== undefined);
    if (breaches.length === 0) continue;
    const values = breaches.flatMap((b) => [...b.angles, ...b.pos1, ...b.pos2, b.speed]);
    if (!values.every(Number.isFinite)) continue;
    const master = entities[members[0]!]!;
    const released = master.classname === "func_object" && (atoi(master.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK) === 0;
    const frames = released ? 2 : MAX_SETTLE_FRAMES;
    // Members [0, chain) are on the master's teamchain.
    let chain = members.length;
    const turned = members.map(() => 0);
    let yawVel = 0;
    for (let frame = 0; frame < frames; frame++) {
      for (let p = 0; p < chain; p++) {
        const b = breachAt[p];
        if (b) {
          b.angles[0] += b.pitchVel * FRAMETIME;
          b.angles[1] += yawVel * FRAMETIME;
        }
        turned[p]! += yawVel * FRAMETIME;
      }
      for (let p = 0; p < chain; p++) {
        const b = breachAt[p];
        if (b) {
          const [pitch, yaw] = breachThink(b);
          b.pitchVel = pitch / FRAMETIME;
          yawVel = yaw / FRAMETIME;
        } else if (frame === 1 && ITEM_CLASSES.has(entities[members[p]!]!.classname ?? "")) {
          chain = p + 1;
        }
      }
      // Only the last breach's yaw is kept, so an earlier one may never reach its own.
      const pitches = breachAt.slice(0, chain).map((b) => Math.abs(b?.pitchVel ?? 0));
      if (Math.max(Math.abs(yawVel), ...pitches) * FRAMETIME <= SETTLED) break;
    }
    if (released) turned[0]! += yawVel * FRAMETIME;
    members.forEach((i, p) => result.set(i, { yaw: turned[p]! }));
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
 * The spot SelectSpawnPoint (p_client.c) puts the first player on in deathmatch: an
 * info_player_deathmatch, else the first info_player_start without a "targetname" (a map
 * loaded directly has no game.spawnpoint), else the first info_player_start. G_Find
 * matches classnames case insensitively and skips freed entities, and the first entity
 * (edict 0) too unless SP_worldspawn marked it in use. With no player in the
 * game yet, SelectFarthestDeathmatchSpawnPoint takes the first deathmatch spot, and
 * SelectRandomDeathmatchSpawnPoint draws among the first count - 2 (all of them when
 * there are two or fewer), so the first is the one spot both dmflags modes can give.
 * PutClientInServer then faces the player along the spot's yaw (`entityAngles`), level.
 */
export function playerSpawnSpot(entities: readonly BspEntity[]): BspEntity | undefined {
  const spots = (classname: string) => entities.filter((e, i) => i > 0 && inGame(e) && stricmpEqual(e.classname ?? "", classname));
  const starts = spots("info_player_start");
  return spots("info_player_deathmatch")[0] ?? starts.find((e) => e.targetname === undefined) ?? starts[0];
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
  const { trains, freed, shown } = settleSpawnFrames(entities);
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
    if (freed.has(i) || !(shown.get(i) ?? visibleAtSpawn(ent))) return;
    const { mins, maxs } = modelBounds(bsp, model);
    const spawn = entityVec3(ent, "origin") ?? [0, 0, 0];
    const keep = KEEPS_ANGLES.has(classname) ? entityAngles(ent) : ([0, 0, 0] as Vec3);
    const { origin, angles } = spawnMove(ent, mins, maxs, spawn, keep, trains.get(i)?.at);
    const turn = turrets.get(i);
    const turned: Vec3 = turn?.angles ?? (turn?.yaw ? [angles[0], angles[1] + turn.yaw, angles[2]] : angles);
    instances.push({ model, origin, angles: turned, classname });
  });
  return { instances, errors };
}

/** g_func.c DOOR_TOGGLE: a used door that is up or going up goes back down. */
const DOOR_TOGGLE = 32;
/**
 * SV_RunThink in the second settle frame runs a think due by level.time (2 * FRAMETIME,
 * stored as a float) plus 0.001, in double.
 */
const SECOND_FRAME_DUE = Math.fround(2 * FRAMETIME) + 0.001;
/**
 * Uses one trigger_always may set off, and how deeply they may nest; the rest are
 * dropped. A trigger_relay loop recurses until the game crashes, and three relays that
 * each target all of them branch at every level, so the depth limit alone would not end
 * the walk.
 */
const MAX_USES = 100000;
const MAX_USE_DEPTH = 256;

/** What fires targets: a map entity, or a DelayedUse (index -1) carrying a trigger's target and killtarget. */
interface User {
  index: number;
  classname: string;
  target: string | undefined;
  killtarget: string | undefined;
  delay: number;
}

/** Game state the settle frames' use chains read and change. */
interface Settle {
  entities: readonly BspEntity[];
  /** Entity indices by lowercased "targetname", in entity order. */
  byTargetname: Map<string, number[]>;
  /** Entities a killtarget freed. */
  freed: Set<number>;
  /** Whether a func_wall or func_object used so far is sent to clients (SVF_NOCLIENT clear); the rest are as `visibleAtSpawn` says. */
  shown: Map<number, boolean>;
  /** func_wall and func_object entities whose use function their own use cleared. */
  useCleared: Set<number>;
  /** Team members, master first, by master index. */
  teams: Map<number, number[]>;
  slaves: Set<number>;
  /** moveinfo.state of the entities used so far; the rest are at `spawnState`. */
  moveState: Map<number, MoveState>;
  /** Plats Use_Plat sent down: Move_Calc gave them a think, so later uses return. */
  platsMoving: Set<number>;
  /** Use_Areaportal's per-entity toggle (ent->count). */
  portalCount: Map<number, number>;
  /** gi.SetAreaPortalState writes, last one wins; portals never written stay closed. */
  portals: Map<number, boolean>;
  /** Every in-game func_train, by entity index. */
  trains: Map<number, Train>;
  /** Uses left for the current trigger_always before MAX_USES cuts the walk off. */
  budget: number;
  depth: number;
}

/** A func_train's fields the settle frames read and change. */
interface Train {
  /** self->target: the train's own "target" until func_train_find or train_next steps it on. */
  target: string | undefined;
  /** The origin of the corner its mins were last put on (func_train_find, a TELEPORT corner); undefined while at its spawn origin. */
  at: Vec3 | undefined;
  startOn: boolean;
  readonly toggle: boolean;
  /** Whether train_next set target_ent (it found a corner to move to). */
  targetEnt: boolean;
  /** Whether func_train_find left train_next as its think, due in the second frame. */
  thinking: boolean;
}

/** g_func.c STATE_TOP (0, also every edict that never sets it), STATE_BOTTOM, STATE_UP, STATE_DOWN. */
type MoveState = "top" | "bottom" | "up" | "down";

/**
 * moveinfo.state after spawn: doors, func_water and func_button start at STATE_BOTTOM, a
 * func_plat at STATE_BOTTOM unless it has a "targetname" (STATE_UP); every other class
 * leaves it 0, STATE_TOP.
 */
function spawnState(ent: BspEntity): MoveState {
  switch (ent.classname) {
    case "func_door":
    case "func_door_rotating":
    case "func_water":
    case "func_button":
      return "bottom";
    case "func_plat":
      return ent.targetname === undefined ? "bottom" : "up";
  }
  return "top";
}

function moveState(s: Settle, index: number): MoveState {
  return s.moveState.get(index) ?? spawnState(s.entities[index]!);
}

/**
 * The classname an entity has after its spawn function ran: SP_func_water and
 * SP_func_door_secret rename themselves func_door. (A func_door_secret team member only
 * fires targets as a door after a DOOR_TOGGLE master sent it down, and its first
 * door_go_up at STATE_TOP already gave it a null think the server errors on; kept for
 * fidelity.)
 */
function liveClassname(ent: BspEntity): string {
  return ent.classname === "func_water" || ent.classname === "func_door_secret" ? "func_door" : (ent.classname ?? "");
}

/** G_Find on "targetname": in-game entities not freed, matched case insensitively, in entity order (worldspawn included). */
function* findTargets(s: Settle, name: string): Generator<number> {
  for (const i of s.byTargetname.get(asciiLower(name)) ?? []) {
    // Checked as the scan reaches each entity, so a killtarget freeing one ahead skips it.
    if (!s.freed.has(i)) yield i;
  }
}

function userOf(s: Settle, index: number): User {
  const e = s.entities[index]!;
  return { index, classname: liveClassname(e), target: e.target, killtarget: e.killtarget, delay: Math.fround(atof(e.delay ?? "0")) };
}

/** door_use_areaportals: set every portal the entity's "target" names (func_areaportal by classname, any case). */
function doorUseAreaportals(s: Settle, index: number, open: boolean): void {
  const target = s.entities[index]!.target;
  if (target === undefined) return;
  for (const t of findTargets(s, target)) {
    if (stricmpEqual(s.entities[t]!.classname ?? "", "func_areaportal")) s.portals.set(atoi(s.entities[t]!.style ?? "0"), open);
  }
}

/**
 * G_UseTargets within the settle frames. A user with a nonzero "delay" queues a
 * DelayedUse and fires nothing here. One due by the second frame's level.time + 0.001 (a
 * delay under about 0.001, or negative) still runs in that frame in the game if G_Spawn
 * places it after the edict being run; that is not modeled. Messages and sounds do not
 * change the map.
 */
function useTargets(s: Settle, user: User): void {
  if (user.delay !== 0) return;
  const gone = () => user.index >= 0 && s.freed.has(user.index);
  if (user.killtarget !== undefined) {
    for (const t of findTargets(s, user.killtarget)) {
      // G_FreeEdict refuses worldspawn (and the client and body queue edicts before the map's).
      if (t !== 0) s.freed.add(t);
      if (gone()) return;
    }
  }
  if (user.target === undefined) return;
  const isDoor = stricmpEqual(user.classname, "func_door") || stricmpEqual(user.classname, "func_door_rotating");
  for (const t of findTargets(s, user.target)) {
    // Doors set their portals in door_use_areaportals instead.
    if (isDoor && stricmpEqual(s.entities[t]!.classname ?? "", "func_areaportal")) continue;
    if (t !== user.index) use(s, t);
    if (gone()) return;
  }
}

/**
 * An entity's use function, for the classes whose use changes area portals, a train's
 * position or whether a brush entity is drawn now, or the moveinfo.state door_go_up
 * reads. The rest are not modeled and do nothing here.
 */
function use(s: Settle, index: number): void {
  if (s.budget <= 0 || s.depth >= MAX_USE_DEPTH) return;
  s.budget--;
  s.depth++;
  try {
    useOne(s, index);
  } finally {
    s.depth--;
  }
}

function useOne(s: Settle, index: number): void {
  const ent = s.entities[index]!;
  switch (ent.classname) {
    case "func_areaportal": {
      // Use_Areaportal toggles the entity's own count, not the portal's current state.
      const count = (s.portalCount.get(index) ?? 0) ^ 1;
      s.portalCount.set(index, count);
      s.portals.set(atoi(ent.style ?? "0"), count === 1);
      return;
    }
    case "func_door":
    case "func_door_rotating":
    case "func_water":
      doorUse(s, index);
      return;
    case "func_door_secret": {
      // door_secret_use runs only while the door is at its spawn origin, which must be 0 0 0.
      const o = entityVec3(ent, "origin") ?? [0, 0, 0];
      if (o[0] === 0 && o[1] === 0 && o[2] === 0) doorUseAreaportals(s, index, true);
      return;
    }
    case "trigger_relay":
      useTargets(s, userOf(s, index));
      return;
    case "func_wall":
    case "func_object":
      wallUse(s, index);
      return;
    case "func_train":
      trainUse(s, index);
      return;
    // These change no portal, but door_go_up reads the state they leave.
    case "func_button": {
      // button_use -> button_fire: returns if up or at the top, else starts up.
      const state = moveState(s, index);
      if (state !== "up" && state !== "top") s.moveState.set(index, "up");
      return;
    }
    case "func_plat":
      // Use_Plat returns once Move_Calc has given the plat a think, else plat_go_down.
      if (!s.platsMoving.has(index)) {
        s.platsMoving.add(index);
        s.moveState.set(index, "down");
      }
      return;
  }
}

/** G_PickTarget, taking the first of several matches where the game picks one at random. */
function pickTarget(s: Settle, name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  for (const t of findTargets(s, name)) return t;
  return undefined;
}

/**
 * func_train_find, the train's first think (first frame): its mins go to the corner its
 * "target" names, and a train with no "targetname" gets START_ON; with START_ON it
 * thinks train_next in the second frame. One with no "target" never gets this think.
 */
function trainFind(s: Settle, index: number): Train {
  const ent = s.entities[index]!;
  const flags = atoi(ent.spawnflags ?? "0");
  const train: Train = {
    target: ent.target,
    at: undefined,
    startOn: (flags & TRAIN_START_ON) !== 0,
    toggle: (flags & TRAIN_TOGGLE) !== 0,
    targetEnt: false,
    thinking: false,
  };
  const first = pickTarget(s, train.target);
  if (first === undefined) return train;
  train.target = s.entities[first]!.target;
  train.at = entityVec3(s.entities[first]!, "origin") ?? [0, 0, 0];
  if (ent.targetname === undefined) train.startOn = true;
  train.thinking = train.startOn;
  return train;
}

/**
 * train_next: steps self->target on to the next corner. A TELEPORT corner (spawnflag 1,
 * whatever the class) puts the train's mins on it at once and steps on again; at a
 * second one in a row the train stays put, though self->target has stepped past it.
 * Any other corner starts a Move_Calc, which moves nothing in the settle frames: run
 * from a use in another entity's slot it defers Move_Begin a frame (a use from within
 * the train's own think, by its pathtarget, only matters for maps whose resume loop
 * recurses until the game crashes); run from the train's own think (`think`) it
 * sets a velocity the next frame applies, except that a corner at no distance (with a
 * positive speed) finishes the move at once and runs train_wait.
 */
function trainNext(s: Settle, index: number, train: Train, think: boolean): void {
  let first = true;
  for (;;) {
    const t = pickTarget(s, train.target);
    if (t === undefined) return;
    const ent = s.entities[t]!;
    train.target = ent.target;
    const corner = entityVec3(ent, "origin") ?? [0, 0, 0];
    if (atoi(ent.spawnflags ?? "0") & PATH_CORNER_TELEPORT) {
      if (!first) return;
      first = false;
      train.at = corner;
      continue;
    }
    train.targetEnt = true;
    // Move_Calc -> Move_Begin -> Move_Final -> Move_Done: the origins compare as floats
    // (ED_ParseField's sscanf); the train's mins, subtracted from both, are not modeled.
    const at = train.at;
    const speed = Math.fround(atof(s.entities[index]!.speed ?? "0")) || 100;
    if (think && speed > 0 && at && corner.every((c, k) => Math.fround(c) === Math.fround(at[k]!))) trainWait(s, index, train, t);
    train.startOn = true;
    return;
  }
}

/**
 * train_wait at the corner `t`, from the train's own think: its "pathtarget" fires
 * through G_UseTargets with the corner's own delay and killtarget; then a corner with
 * no "wait" runs train_next again, a negative one on a TOGGLE train runs it and stops
 * the train, and a positive one waits past the settle frames. A loop of coincident
 * corners recurses in the game until it crashes; the use budget and depth cut it off.
 */
function trainWait(s: Settle, index: number, train: Train, t: number): void {
  if (s.budget <= 0 || s.depth >= MAX_USE_DEPTH) return;
  s.budget--;
  s.depth++;
  try {
    const corner = s.entities[t]!;
    if (corner.pathtarget !== undefined) {
      useTargets(s, {
        index: t,
        classname: liveClassname(corner),
        target: corner.pathtarget,
        killtarget: corner.killtarget,
        delay: Math.fround(atof(corner.delay ?? "0")),
      });
      if (s.freed.has(index)) return;
    }
    const wait = Math.fround(atof(corner.wait ?? "0"));
    if (wait === 0) {
      trainNext(s, index, train, true);
    } else if (wait < 0 && train.toggle) {
      trainNext(s, index, train, true);
      train.startOn = false;
    }
  } finally {
    s.depth--;
  }
}

/**
 * train_use: a running (START_ON) train ignores it unless TOGGLE, which stops it and
 * drops the train_next think it may still have due; a stopped one resumes towards its
 * target_ent (Move_Calc, nothing moves yet) or, without one, runs train_next.
 */
function trainUse(s: Settle, index: number): void {
  const train = s.trains.get(index);
  if (!train) return;
  if (train.startOn) {
    if (!train.toggle) return;
    train.startOn = false;
    train.thinking = false;
  } else if (train.targetEnt) {
    train.startOn = true;
  } else {
    trainNext(s, index, train, false);
  }
}

/**
 * func_wall_use and func_object_use. SP_func_wall gives a use only to a wall with any of
 * TRIGGER_SPAWN, TOGGLE or START_ON, and SP_func_object to an object with any spawnflag;
 * the use shows a hidden one and hides a shown wall, then clears itself unless the wall
 * has TOGGLE (which START_ON forces). The KillBox a shown one runs needs the trace and
 * is not modeled, nor the fall a used func_object starts (MOVETYPE_TOSS).
 */
function wallUse(s: Settle, index: number): void {
  if (s.useCleared.has(index)) return;
  const ent = s.entities[index]!;
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  if (ent.classname === "func_object") {
    if (flags === 0) return;
    s.shown.set(index, true);
    s.useCleared.add(index);
    return;
  }
  if (!(flags & 7)) return;
  s.shown.set(index, !(s.shown.get(index) ?? visibleAtSpawn(ent)));
  if (!(flags & 6)) s.useCleared.add(index);
}

/** Whether a door's spawn function gave it DOOR_TOGGLE: the spawnflag, or a func_water whose "wait" is -1 or unset. */
function doorToggles(ent: BspEntity): boolean {
  if (atoi(ent.spawnflags ?? "0") & DOOR_TOGGLE) return true;
  return ent.classname === "func_water" && [0, -1].includes(Math.fround(atof(ent.wait ?? "0")));
}

/**
 * door_use: a team slave ignores it; otherwise every member of the team, whatever its
 * class, goes up (door_go_up), or, for a DOOR_TOGGLE master already up or going up, down.
 * door_go_up returns for a member up, going up or at STATE_TOP (`spawnState`). A member
 * freed by a killtarget ends the walk.
 */
function doorUse(s: Settle, index: number): void {
  if (s.slaves.has(index)) return;
  const members = s.teams.get(index) ?? [index];
  const state = moveState(s, index);
  const down = doorToggles(s.entities[index]!) && (state === "up" || state === "top");
  for (const m of members) {
    // A freed member is a zeroed edict: door_go_up returns at once (STATE_TOP) and its
    // teamchain, which door_use follows next, is null.
    if (s.freed.has(m)) break;
    if (down) {
      // door_go_down writes no portal until the door reaches the bottom, after the settle frames.
      s.moveState.set(m, "down");
      continue;
    }
    const ms = moveState(s, m);
    if (ms === "up" || ms === "top") continue;
    s.moveState.set(m, "up");
    useTargets(s, userOf(s, m));
    // A door its own killtarget freed has no "target" left to find portals by.
    if (s.freed.has(m)) break;
    doorUseAreaportals(s, m, true);
  }
}

/**
 * The two frames SV_SpawnServer runs to settle the map before any client is sent an
 * entity: the area portals left open, where every in-game func_train is, the entities
 * a killtarget freed, and the func_wall and func_object entities a use showed or hid.
 *
 * Area portals start closed (CM_SetAreaPortalState; SP_func_areaportal leaves them so;
 * a portal is its entity's "style").
 *
 * First frame: a START_OPEN func_door or func_door_rotating with no "health" and no
 * "targetname" runs Think_SpawnDoorTrigger, which, unless the door is a team slave,
 * opens every portal door_use_areaportals finds: in-game entities whose classname is
 * func_areaportal and whose "targetname" is the door's "target", compared case
 * insensitively (G_Find, Q_stricmp). Every train runs func_train_find (`trainFind`).
 *
 * Second frame: edicts run in entity order. A START_ON train runs train_next. Every
 * in-game trigger_always fires its targets through a DelayedUse (SP_trigger_always
 * raises "delay" to at least 0.2 s; one above that comes due later and is skipped),
 * which G_Spawn placed right after it: freed slots are refilled by the next spawn, so
 * none lies earlier. G_UseTargets first frees its killtargets, then uses its targets: a
 * func_areaportal toggles, a door goes up with its team (each member at the bottom fires
 * its own targets, except portals, and opens its portals), a func_door_secret at origin
 * 0 0 0 opens its portals, a trigger_relay fires its targets, a train runs train_use,
 * a func_wall or func_object is shown or hidden (`wallUse`); an entity a killtarget
 * freed is not drawn. Other use functions are not modeled, nor are a team slave train's thinks (both
 * func_train_find and train_next) running in its master's slot.
 */
function settleSpawnFrames(entities: readonly BspEntity[]): {
  portals: Set<number>;
  trains: Map<number, Train>;
  freed: Set<number>;
  shown: Map<number, boolean>;
} {
  const teams = new Map<number, number[]>();
  const slaves = new Set<number>();
  for (const members of findTeams(entities).values()) {
    teams.set(members[0]!, members);
    members.slice(1).forEach((i) => slaves.add(i));
  }
  const byTargetname = new Map<string, number[]>();
  entities.forEach((e, i) => {
    if (e.targetname === undefined || !inGame(e)) return;
    const key = asciiLower(e.targetname);
    const list = byTargetname.get(key);
    if (list) list.push(i);
    else byTargetname.set(key, [i]);
  });
  const s: Settle = {
    entities,
    byTargetname,
    freed: new Set(),
    shown: new Map(),
    useCleared: new Set(),
    teams,
    slaves,
    moveState: new Map(),
    platsMoving: new Set(),
    portalCount: new Map(),
    portals: new Map(),
    trains: new Map(),
    budget: MAX_USES,
    depth: 0,
  };
  entities.forEach((e, i) => {
    if (e.classname === "func_train" && inGame(e)) s.trains.set(i, trainFind(s, i));
  });
  entities.forEach((door, i) => {
    if (door.classname !== "func_door" && door.classname !== "func_door_rotating") return;
    if (!inGame(door) || slaves.has(i)) return;
    if (!(atoi(door.spawnflags ?? "0") & DOOR_START_OPEN)) return;
    if (atoi(door.health ?? "0") || door.targetname !== undefined) return;
    doorUseAreaportals(s, i, true);
  });
  entities.forEach((e, i) => {
    const train = s.trains.get(i);
    if (train?.thinking && !s.freed.has(i)) {
      train.thinking = false;
      s.budget = MAX_USES;
      trainNext(s, i, train, true);
    }
    if (i === 0 || e.classname !== "trigger_always" || !inGame(e)) return;
    const delay = Math.fround(atof(e.delay ?? "0"));
    if (Math.max(delay, Math.fround(0.2)) > SECOND_FRAME_DUE) return;
    s.budget = MAX_USES;
    useTargets(s, { index: -1, classname: "DelayedUse", target: e.target, killtarget: e.killtarget, delay: 0 });
  });
  return {
    portals: new Set([...s.portals].filter(([, open]) => open).map(([p]) => p)),
    trains: s.trains,
    freed: s.freed,
    shown: s.shown,
  };
}

/** The area portals open after the settle frames (`settleSpawnFrames`). */
export function openAreaPortals(entities: readonly BspEntity[]): Set<number> {
  return settleSpawnFrames(entities).portals;
}
