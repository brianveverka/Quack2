// SPDX-License-Identifier: GPL-2.0-or-later
// Inline brush model instances (func_wall, doors, plats: entities with "model" "*N")
// at their compiled position rotated by the entity's spawn angles and moved by its
// "origin", then moved as the game moves it during spawn (lowered plats, doors that
// start open, trains at their first path_corner or the teleport one after it), from the
// entity string alone, and turret breaches (with their teams) turned to where they
// come to rest in their pitch/yaw range. Those a killtarget frees in the settle frames
// are left out, and func_wall and func_object entities a use there shows or hides are
// drawn or left out to match. Also the movers of doors (linear and rotating), plats,
// buttons, trains and func_rotating entities as the settle frames leave them
// (`brushMovers`), for `BrushMotion` to step. DOM-free.

import {
  FRAMETIME,
  asciiLower,
  brushMover,
  calcMoveSpeed,
  doorGoDown,
  doorGoUp,
  entityVec3,
  levelTimeAt,
  platGoDown,
  buttonFire,
  rotatingUse,
  stepPusher,
  trainResume,
  trainUse,
  type Bsp,
  type BspEntity,
  type BrushMover,
  type BrushMoverInit,
  type MoveSpeeds,
  type PathCorner,
} from "@quack2/sim";

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
const ROTATING_START_ON = 1;
const ROTATING_REVERSE = 2;
const ROTATING_X_AXIS = 4;
const ROTATING_Y_AXIS = 8;

/** Q_stricmp equality (see `asciiLower`). */
function stricmpEqual(a: string, b: string): boolean {
  return asciiLower(a) === asciiLower(b);
}

const f32 = Math.fround;

/**
 * G_SetMovedir on the float angles ED_ParseField stores: 0 -1 0 means up, 0 -2 0 down,
 * anything else AngleVectors' forward vector, with its float angle, sines and products.
 */
function moveDir(ent: BspEntity): Vec3 {
  const angles = entityAngles(ent).map(f32);
  if (angles[0] === 0 && angles[2] === 0 && angles[1] === -1) return [0, 0, 1];
  if (angles[0] === 0 && angles[2] === 0 && angles[1] === -2) return [0, 0, -1];
  // angle = angles[i] * (M_PI*2 / 360), a float; sin and cos of it stored as floats.
  const rad = (a: number) => f32(a * ((Math.PI * 2) / 360));
  const sy = f32(Math.sin(rad(angles[1]!)));
  const cy = f32(Math.cos(rad(angles[1]!)));
  const sp = f32(Math.sin(rad(angles[0]!)));
  const cp = f32(Math.cos(rad(angles[0]!)));
  return [f32(cp * cy), f32(cp * sy), -sp];
}

/** pos1 and pos2 (moveinfo.start_origin and end_origin) and moveinfo.distance of a linear door. */
interface DoorPositions {
  readonly pos1: Vec3;
  readonly pos2: Vec3;
  readonly distance: number;
}

/**
 * SP_func_door, SP_func_water and SP_func_button, in float as the game stores and
 * computes them: pos2 lies the entity's size along the move direction, less "lip" (an
 * int; `defaultLip` when 0), from pos1, the spawn origin. `mins`/`maxs` as for `spawnMove`.
 */
function linearPositions(ent: BspEntity, mins: readonly number[], maxs: readonly number[], origin: Vec3, defaultLip: number): DoorPositions {
  const dir = moveDir(ent);
  const size = [0, 1, 2].map((k) => f32(f32(maxs[k]!) - f32(mins[k]!)));
  const lip = atoi(ent.lip ?? "0") || defaultLip;
  let distance = f32(Math.abs(dir[0]) * size[0]!);
  distance = f32(distance + f32(Math.abs(dir[1]) * size[1]!));
  distance = f32(distance + f32(Math.abs(dir[2]) * size[2]!));
  distance = f32(distance - lip);
  const near = origin.map(f32) as Vec3;
  // VectorMA, float throughout.
  const far = near.map((o, k) => f32(o + f32(distance * dir[k]!))) as Vec3;
  return { pos1: near, pos2: far, distance };
}

/**
 * A linear door's `linearPositions` ("lip" defaults to 8 for func_door, 0 for
 * func_water); START_OPEN swaps pos1 and pos2, and the door starts at pos1.
 */
function doorPositions(ent: BspEntity, mins: readonly number[], maxs: readonly number[], origin: Vec3): DoorPositions {
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  const p = linearPositions(ent, mins, maxs, origin, ent.classname === "func_door" ? 8 : 0);
  return flags & DOOR_START_OPEN ? { pos1: p.pos2, pos2: p.pos1, distance: p.distance } : p;
}

/**
 * Where the game has put a brush entity after the two frames SV_SpawnServer runs to
 * settle, from its spawn "origin" (and angles, 0 0 0 for every class moved here), per g_func.c.
 * `mins`/`maxs` are the entity's bounds as gi.setmodel sets them: the model's bounds
 * spread by a unit (CMod_LoadSubmodels). "lip", "height" and "distance" are integer
 * spawn fields (atoi), 0 when absent. Positions are float, as the game computes them.
 */
function spawnMove(
  ent: BspEntity,
  mins: readonly number[],
  maxs: readonly number[],
  origin: Vec3,
  angles: Vec3,
): { origin: Vec3; angles: Vec3 } {
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  const at = origin.map(f32) as Vec3;
  switch (ent.classname) {
    // SP_func_plat: pos2 is the bottom, "height" below the top or the plat's height less
    // "lip" (default 8). Only a plat something targets starts at the top.
    case "func_plat": {
      if (ent.targetname !== undefined) break;
      return { origin: platPositions(ent, mins, maxs, origin).pos2, angles };
    }
    // SP_func_door / SP_func_water: a START_OPEN door starts at the far end.
    case "func_door":
    case "func_water": {
      if (!(flags & DOOR_START_OPEN)) break;
      return { origin: doorPositions(ent, mins, maxs, origin).pos1, angles };
    }
    // SP_func_door_rotating: START_OPEN starts at "distance" degrees (default 90) about
    // the door's axis: yaw, or roll for X_AXIS, pitch for Y_AXIS; REVERSE negates it.
    case "func_door_rotating": {
      if (!(flags & DOOR_START_OPEN)) break;
      const axis = flags & DOOR_X_AXIS ? 2 : flags & DOOR_Y_AXIS ? 0 : 1;
      const distance = atoi(ent.distance ?? "0") || 90;
      const open: Vec3 = [0, 0, 0];
      open[axis] = flags & DOOR_REVERSE ? -distance : distance;
      return { origin: at, angles: open };
    }
  }
  return { origin: at, angles };
}

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
/** VectorScale's float scales: 1.0/FRAMETIME in turret_breach_think, FRAMETIME in SV_Physics_Pusher and SV_Physics_Toss. */
const PER_SECOND = f32(1 / FRAMETIME);
const PER_FRAME = f32(FRAMETIME);
/**
 * Below this, every step of AnglesNormalize's loop but the last into [0, 360] is exact
 * (a float's spacing there is at most 8, which divides 360), so `normalizeAngle` takes
 * them at once. Above it the game's loop rounds, takes 370000 steps a frame or more,
 * and above 2^33 never ends.
 */
const NORMALIZE_LIMIT = 2 ** 27;

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
 * g_turret.c AnglesNormalize on one float angle below NORMALIZE_LIMIT:
 * `while (a > 360) a -= 360; while (a < 0) a += 360;`, the exact steps taken at once and
 * the last, which can round, in float.
 */
function normalizeAngle(a: number): number {
  if (a > 360) a -= 360 * (Math.ceil((a - 360) / 360) - 1);
  while (a > 360) a = f32(a - 360);
  if (a < 0) a += 360 * (Math.ceil(-a / 360) - 1);
  while (a < 0) a = f32(a + 360);
  return a;
}

/** The wrap turret_breach_think applies once to each float delta. */
function wrap180(d: number): number {
  return d < -180 ? f32(d + 360) : d > 180 ? f32(d - 360) : d;
}

/** A turret_breach's float fields. */
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

/** SP_turret_breach's fields: speed default 50, minpitch -30, maxpitch 30, maxyaw 360; a float 0 means the default. */
function breachState(ent: BspEntity, index: number): Breach {
  const field = (key: string, fallback: number) => f32(atof(ent[key] ?? "0")) || fallback;
  const angles = entityAngles(ent).map(f32) as Vec3;
  return {
    index,
    angles,
    move: [0, angles[1], 0],
    pos1: [-field("minpitch", -30), f32(atof(ent.minyaw ?? "0"))],
    pos2: [-field("maxpitch", 30), field("maxyaw", 360)],
    speed: field("speed", 50),
    pitchVel: 0,
  };
}

/**
 * turret_breach_think up to its avelocity, in float: the pitch and yaw to turn this
 * frame, at most speed * FRAMETIME each. Undefined, and nothing changed, for an angle
 * `normalizeAngle` does not take.
 */
function breachThink(b: Breach): [number, number] | undefined {
  const move = b.move;
  if (![b.angles[0], b.angles[1], move[0], move[1]].every((a) => Math.abs(a) < NORMALIZE_LIMIT)) return undefined;
  const current = [normalizeAngle(b.angles[0]), normalizeAngle(b.angles[1])];
  move[0] = normalizeAngle(move[0]);
  move[1] = normalizeAngle(move[1]);
  if (move[0] > 180) move[0] = f32(move[0] - 360);
  if (move[0] > b.pos1[0]) move[0] = b.pos1[0];
  else if (move[0] < b.pos2[0]) move[0] = b.pos2[0];
  if (move[1] < b.pos1[1] || move[1] > b.pos2[1]) {
    // The game takes fabs before wrapping, so the < -180 case never applies.
    const dmin = wrap180(Math.abs(f32(b.pos1[1] - move[1])));
    const dmax = wrap180(Math.abs(f32(b.pos2[1] - move[1])));
    move[1] = Math.abs(dmin) < Math.abs(dmax) ? b.pos1[1] : b.pos2[1];
  }
  // speed * FRAMETIME is a double (FRAMETIME is a double literal), stored into the float
  // delta. A negative speed passes both tests, so the delta ends at -speed * FRAMETIME.
  const step = b.speed * FRAMETIME;
  const clamp = (d: number) => {
    if (d > step) d = f32(step);
    if (d < -step) d = f32(-step);
    return d;
  };
  return [clamp(wrap180(f32(move[0] - current[0]!))), clamp(wrap180(f32(move[1] - current[1]!)))];
}

/**
 * A turret team turning to rest, as the game does over the first seconds: each frame, at
 * the master's slot, SV_Physics_Pusher turns every member on the master's teamchain by its
 * avelocity (`turretPush`), then runs the members' thinks in team order. A breach's think
 * (`turretThink`) sets its own pitch velocity and the yaw velocity of every member of its
 * team (G_FindTeams: the in-game entities with the same "team", compared case sensitively,
 * in entity order), so the last breach in a team sets the yaw every member turns by. A
 * breach with no team turns alone here; the stock game crashes on it
 * (turret_breach_finish_init writes through its NULL teammaster).
 *
 * Only a master in PUSHER_CLASSES runs its slaves' thinks; under any other the team keeps
 * its spawn angles. The two settle frames step the team in their slot walk
 * (`settleSpawnFrames`), and `settleTurrets` runs it on from the third. A spawnflags-0
 * func_object master turns MOVETYPE_TOSS in its think in the second frame
 * (func_object_release), so its team runs for two frames only (turning in the second), and
 * the master alone turns once more in the third: SV_Physics_Toss turns it by the
 * avelocity the breaches last set until it lands (later frames need the trace).
 *
 * A settle-frame free (a killtarget, turret_breach_finish_init freeing its target) stops
 * the team from the point in the slot walk where it happens: G_RunFrame skips a freed
 * master and SV_Physics_Pusher returns for its slaves, so the members keep their angles;
 * a freed member ends the chain (`turretChain`), so the members after it are neither
 * pushed nor thought for, in the rest of that frame's walk if it is still ahead, and in
 * every later frame. A use that releases a triggered func_object is not modeled, nor is
 * droptofloor freeing an item that starts in solid (it needs the trace).
 */
interface TurretTeam {
  readonly members: readonly number[];
  readonly breachAt: readonly (Breach | undefined)[];
  /**
   * Members [0, chain) are on the master's teamchain unless a freed member ends it
   * sooner (`turretChain`): an item on the team cuts the chain after itself in its
   * droptofloor, in the second frame.
   */
  chain: number;
  /** The yaw steps (amove) SV_Push has turned each member by, in order (`addStep`). */
  readonly steps: number[][];
  yawVel: number;
  /** Whether a push or think since it was last cleared changed a breach or the yaw velocity. */
  changed: boolean;
  readonly released: boolean;
  /** Set when a breach's angle reaches NORMALIZE_LIMIT: the team is not run on from there. */
  halted: boolean;
}

/**
 * The turret teams, by master (a breach with no team is its own): the teams with a
 * turret_breach under a PUSHER_CLASSES master. A team is not run from the first think
 * that meets a breach angle of NORMALIZE_LIMIT or more, or an infinite one, where the
 * game's AnglesNormalize loops for 370000 steps or more, or forever.
 */
function turretTeams(entities: readonly BspEntity[]): Map<number, TurretTeam> {
  const groups: number[][] = [];
  entities.forEach((e, i) => {
    if (i > 0 && inGame(e) && e.team === undefined && e.classname === "turret_breach") groups.push([i]);
  });
  for (const members of findTeams(entities).values()) {
    if (PUSHER_CLASSES.has(entities[members[0]!]!.classname ?? "")) groups.push(members);
  }
  const teams = new Map<number, TurretTeam>();
  for (const members of groups) {
    const breachAt = members.map((i) => (entities[i]!.classname === "turret_breach" ? breachState(entities[i]!, i) : undefined));
    if (breachAt.every((b) => b === undefined)) continue;
    const master = entities[members[0]!]!;
    const released = master.classname === "func_object" && (atoi(master.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK) === 0;
    const steps = members.map((): number[] => []);
    teams.set(members[0]!, { members, breachAt, chain: members.length, steps, yawVel: 0, changed: false, released, halted: false });
  }
  return teams;
}

/**
 * How many members the master's teamchain walk reaches: G_FreeEdict zeroes a freed
 * member's teamchain (and its avelocity), so the walk ends at it, and a freed master is
 * no longer run at all.
 */
function turretChain(team: TurretTeam, freed: ReadonlySet<number>): number {
  if (team.halted) return 0;
  for (let p = 0; p < team.chain; p++) if (freed.has(team.members[p]!)) return p;
  return team.chain;
}

/** Appends a yaw step to a member's steps, kept as [step, count] runs. */
function addStep(steps: number[], step: number): void {
  const n = steps.length;
  if (n > 0 && Object.is(steps[n - 2], step)) steps[n - 1]!++;
  else steps.push(step, 1);
}

/** Stores a turret float, noting on the team whether it changed. */
function store(team: TurretTeam, values: number[], k: number, value: number): void {
  if (Object.is(values[k], value)) return;
  values[k] = value;
  team.changed = true;
}

/**
 * SV_Physics_Pusher's push, in float: every member on the teamchain with an avelocity
 * turned by avelocity * FRAMETIME (SV_Push). A member's pitch and roll take a 0 step too.
 */
function turretPush(team: TurretTeam, freed: ReadonlySet<number>): void {
  const chain = turretChain(team, freed);
  const yaw = f32(team.yawVel * PER_FRAME);
  for (let p = 0; p < chain; p++) {
    const b = team.breachAt[p];
    if (b && (b.pitchVel || team.yawVel)) {
      store(team, b.angles, 0, f32(b.angles[0] + f32(b.pitchVel * PER_FRAME)));
      store(team, b.angles, 1, f32(b.angles[1] + yaw));
      store(team, b.angles, 2, f32(b.angles[2] + 0));
    }
    if (team.yawVel) addStep(team.steps[p]!, yaw);
  }
}

/** turret_breach_think on the breach at team position p, if it is one: its avelocity, in float. */
function turretThink(team: TurretTeam, p: number): void {
  const b = team.breachAt[p];
  if (!b || team.halted) return;
  const [move0, move1] = b.move;
  const turn = breachThink(b);
  if (!turn) {
    team.halted = true;
    return;
  }
  const pitchVel = f32(turn[0] * PER_SECOND);
  const yawVel = f32(turn[1] * PER_SECOND);
  if (!Object.is(move0, b.move[0]) || !Object.is(move1, b.move[1]) || !Object.is(pitchVel, b.pitchVel) || !Object.is(yawVel, team.yawVel)) {
    team.changed = true;
  }
  b.pitchVel = pitchVel;
  team.yawVel = yawVel;
}

/**
 * A member's angles after the yaw steps SV_Push turned it by, from its float s.angles,
 * or `angles` unchanged when it never turned.
 */
function turnedAngles(angles: readonly number[], steps: readonly number[]): Vec3 {
  if (steps.length === 0) return [angles[0]!, angles[1]!, angles[2]!];
  let yaw = f32(angles[1]!);
  for (let k = 0; k < steps.length; k += 2) for (let n = 0; n < steps[k + 1]!; n++) yaw = f32(yaw + steps[k]!);
  return [f32(angles[0]! + 0), yaw, f32(angles[2]! + 0)];
}

/**
 * The turret teams run on from the third frame, as `settleSpawnFrames` left them, with
 * the entities it freed: each frame pushes the members on the chain and runs their
 * breaches' thinks, up to MAX_SETTLE_FRAMES in all, or until a frame changes nothing and
 * leaves no yaw step to push (then no later frame changes anything). An inverted pitch
 * range (minpitch > maxpitch) flips move_angles between the limits every frame, forever,
 * so it runs to the cap. So does a team with a yaw velocity whose chain an item or a free
 * has cut ahead of every breach: nothing on the chain sets it again, and the game spins
 * those members forever. In float a breach can also stop short of its target: a delta
 * that turned into avelocity and back no longer moves the angle it is added to (below
 * half its spacing), so the avelocity stays, and the team runs to the cap with its other
 * members turning by that step every frame. A turned member's own spin (a START_ON
 * func_rotating) is not added, nor are frees after the settle frames. It changes the
 * teams in place, so each map's teams are settled once.
 *
 * Returns, per entity index, the breach's angles at rest, or for any other team member
 * the yaw steps it was turned by (`turnedAngles`).
 */
function settleTurrets(
  teams: ReadonlyMap<number, TurretTeam>,
  freed: ReadonlySet<number>,
): Map<number, { angles?: Vec3; steps?: readonly number[] }> {
  const result = new Map<number, { angles?: Vec3; steps?: readonly number[] }>();
  for (const team of teams.values()) {
    if (team.released) {
      // SV_Physics_Toss: VectorMA(s.angles, FRAMETIME, avelocity), a float step.
      if (!freed.has(team.members[0]!)) addStep(team.steps[0]!, f32(team.yawVel * PER_FRAME));
    } else {
      for (let frame = 2; frame < MAX_SETTLE_FRAMES; frame++) {
        const chain = turretChain(team, freed);
        if (chain === 0) break;
        team.changed = false;
        turretPush(team, freed);
        // Only the last breach's yaw is kept, so an earlier one may never reach its own.
        for (let p = 0; p < chain; p++) turretThink(team, p);
        if (f32(team.yawVel * PER_FRAME) === 0 && !team.changed) break;
      }
    }
    team.members.forEach((i, p) => result.set(i, { steps: team.steps[p]! }));
    for (const b of team.breachAt) if (b) result.set(b.index, { angles: b.angles });
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
  /** Index of the entity in the entity string. */
  readonly entity: number;
  /** World translation of the model's faces: the entity's "origin", default 0 0 0, after any spawn move. */
  readonly origin: readonly [number, number, number];
  /** Rotation (pitch, yaw, roll) about the model-space origin, applied before `origin`: the spawn angles for classes that keep them, a START_OPEN func_door_rotating's open angles, else 0 0 0; a func_rotating turned as the settle frames leave it (`rotatingMover`); a turret breach at rest, and the members of its team turned by its yaw. */
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

/** The inline model a "model" value names ("*N", N from 1: *0 is the world itself, drawn separately), else undefined. */
function inlineModel(bsp: Bsp, ref: string | undefined): number | undefined {
  const model = ref !== undefined && /^\*\d+$/.test(ref) ? Number(ref.slice(1)) : Number.NaN;
  return model >= 1 && model < bsp.models.count ? model : undefined;
}

export function brushModelInstances(bsp: Bsp, entities: readonly BspEntity[]): BrushModelInstances {
  const instances: BrushModelInstance[] = [];
  const errors: string[] = [];
  const frames = settleSpawnFrames(entities, bsp);
  const { trains, rotating, freed, shown } = frames;
  const turrets = settleTurrets(frames.turrets, freed);
  entities.forEach((ent, i) => {
    const ref = ent.model;
    // Point entities carry model paths ("models/..."); only "*N" is an inline model.
    if (ref === undefined || !ref.startsWith("*")) return;
    const classname = ent.classname ?? "";
    const model = inlineModel(bsp, ref);
    if (model === undefined) {
      errors.push(`entity ${i} (${classname}): model "${ref}" is not an inline model of this map`);
      return;
    }
    if (freed.has(i) || !(shown.get(i) ?? visibleAtSpawn(ent))) return;
    const { mins, maxs } = modelBounds(bsp, model);
    const spawn = entityVec3(ent, "origin") ?? [0, 0, 0];
    const keep = KEEPS_ANGLES.has(classname) ? entityAngles(ent) : ([0, 0, 0] as Vec3);
    const moved = spawnMove(ent, mins, maxs, spawn, keep);
    // A train is where the settle frames left it: its mins on a corner, or at its spawn origin.
    const train = trains.get(i);
    // A func_rotating is turned as far as the settle frames turned it.
    const rotor = rotating.get(i);
    const { origin, angles } = train
      ? { origin: [...train.origin] as Vec3, angles: moved.angles }
      : rotor
        ? { origin: moved.origin, angles: [...rotor.angles] as Vec3 }
        : moved;
    const turn = turrets.get(i);
    const turned: Vec3 = turn?.angles ?? (turn?.steps ? turnedAngles(angles, turn.steps) : angles);
    instances.push({ model, entity: i, origin, angles: turned, classname });
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
/** The same in the first settle frame, at level.time FRAMETIME. */
const FIRST_FRAME_DUE = Math.fround(FRAMETIME) + 0.001;
/**
 * Edicts G_Spawn may append in the settle frames (door triggers, DelayedUses); the rest are
 * dropped, which ends a chain of tiny delays that spawns faster than it frees. The game errors
 * ("ED_Alloc: no free edicts") sooner, when all its edicts (1024 by default, counting
 * clients, the body queue and spawned triggers) are in use.
 */
const MAX_SPAWNED = 1024;
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

/** G_UseTargets' temp edict: Think_Delay fires its target and killtarget at nextthink, then frees it. */
interface DelayedUse {
  nextthink: number;
  /** Spawned in the second frame: such DelayedUses share one use budget (`Settle.spawnedBudget`). */
  inFrame: boolean;
  target: string | undefined;
  killtarget: string | undefined;
}

/**
 * An edict slot in the settle frames: a map entity by index, a DelayedUse, a door's
 * trigger (Think_SpawnDoorTrigger's, which never thinks), or free (null).
 */
type Slot = number | DelayedUse | "doorTrigger" | null;

/** Game state the settle frames' use chains read and change. */
interface Settle {
  entities: readonly BspEntity[];
  /** Entity indices by lowercased "targetname", in entity order. */
  byTargetname: Map<string, number[]>;
  /** Entities a killtarget freed. */
  freed: Set<number>;
  /** The edicts G_RunFrame walks in both frames, in slot order (`settleSpawnFrames`). */
  slots: Slot[];
  /** Each in-game entity's index in `slots`. */
  slotOf: Map<number, number>;
  /** Edicts appended to `slots` so far (MAX_SPAWNED). */
  spawned: number;
  /**
   * Whether a func_wall or func_object used so far is sent to clients (SVF_NOCLIENT
   * clear); the rest are as `visibleAtSpawn` says.
   */
  shown: Map<number, boolean>;
  /** func_wall and func_object entities whose use function their own use cleared. */
  useCleared: Set<number>;
  /** Team members, master first, by master index. */
  teams: Map<number, number[]>;
  slaves: Set<number>;
  /** moveinfo.state of the entities used so far; the rest are at `spawnState`. */
  moveState: Map<number, MoveState>;
  /**
   * door_go_up (up) and door_go_down calls on doors, plat_go_down calls from Use_Plat
   * and button_fire calls (up) from button_use, in the order the game makes them.
   */
  moves: { index: number; up: boolean }[];
  /** Plats Use_Plat sent down: Move_Calc gave them a think, so later uses return. */
  platsMoving: Set<number>;
  /**
   * nextthink of the entities whose think the walk models (`runThink`): a trigger_once,
   * trigger_multiple or trigger_counter's from multi_trigger (while nonzero its later uses
   * return), a func_timer's, a target_explosion's and a trigger_elevator's
   * (trigger_elevator_init).
   */
  nextthink: Map<number, number>;
  /** target_explosion entities in target_explosion_explode, whose "delay" it has cleared. */
  exploding: Set<number>;
  /** trigger_counter_use's count, by entity, once a use changed it. */
  counterCount: Map<number, number>;
  /** TRIGGERED trigger_once and trigger_multiple entities trigger_enable gave Use_Multi. */
  multiEnabled: Set<number>;
  /** Use_Areaportal's per-entity toggle (ent->count). */
  portalCount: Map<number, number>;
  /** gi.SetAreaPortalState writes, last one wins; portals never written stay closed. */
  portals: Map<number, boolean>;
  /** Every in-game func_train's mover, by entity index. */
  trains: Map<number, BrushMover>;
  /** The mover of every in-game func_rotating that is no team's slave and on no turret_breach's team, by entity index. */
  rotating: Map<number, BrushMover>;
  /** The func_train (movetarget) of each trigger_elevator whose trigger_elevator_init gave it its use. */
  elevators: Map<number, number>;
  /**
   * level.current_entity: the entity G_RunFrame is running (a team master during its
   * teamchain walk, whichever member's think runs), -1 for a DelayedUse.
   */
  current: number;
  /**
   * Uses left before MAX_USES cuts the walk off: per entity run, and for every DelayedUse
   * the second frame spawns together (`spawnedBudget`), so a chain of them cannot
   * multiply the work by MAX_SPAWNED.
   */
  budget: number;
  spawnedBudget: number;
  depth: number;
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

/** The portals door_use_areaportals sets for an entity: those of the func_areaportal entities (by classname, any case) its "target" names, in G_Find order. */
function areaportalsOf(s: Settle, index: number): number[] {
  const target = s.entities[index]!.target;
  if (target === undefined) return [];
  const out: number[] = [];
  for (const t of findTargets(s, target)) {
    if (stricmpEqual(s.entities[t]!.classname ?? "", "func_areaportal")) out.push(atoi(s.entities[t]!.style ?? "0"));
  }
  return out;
}

/** door_use_areaportals: set every portal the entity's "target" names (`areaportalsOf`). */
function doorUseAreaportals(s: Settle, index: number, open: boolean): void {
  for (const p of areaportalsOf(s, index)) s.portals.set(p, open);
}

/** G_FreeEdict on a map entity: freed, and its slot free for G_Spawn (freetime < 2). */
function freeEdict(s: Settle, index: number): void {
  s.freed.add(index);
  s.slots[s.slotOf.get(index)!] = null;
}

/**
 * G_Spawn in the settle frames: the first free slot (every slot freed so far is reusable,
 * as freetime < 2), else a new one at the end, which G_RunFrame still reaches this frame.
 */
function spawnEdict(s: Settle, d: DelayedUse | "doorTrigger"): void {
  const free = s.slots.indexOf(null);
  if (free >= 0) s.slots[free] = d;
  else if (s.spawned < MAX_SPAWNED) {
    s.spawned++;
    s.slots.push(d);
  }
}

/**
 * G_UseTargets within the settle frames, which run uses only in the second. A user with a
 * nonzero "delay" spawns a DelayedUse due at level.time + delay (in float) and fires
 * nothing here; `settleSpawnFrames` runs it if it is due in that frame and lies after
 * the edict being run. Messages and sounds do not change the map.
 */
function useTargets(s: Settle, user: User): void {
  if (user.delay !== 0) {
    spawnEdict(s, { nextthink: f32(levelTimeAt(2) + user.delay), inFrame: true, target: user.target, killtarget: user.killtarget });
    return;
  }
  const gone = () => user.index >= 0 && s.freed.has(user.index);
  if (user.killtarget !== undefined) {
    for (const t of findTargets(s, user.killtarget)) {
      // G_FreeEdict refuses worldspawn (and the client and body queue edicts before the map's).
      if (t !== 0) freeEdict(s, t);
      if (gone()) return;
    }
  }
  if (user.target === undefined) return;
  const isDoor = stricmpEqual(user.classname, "func_door") || stricmpEqual(user.classname, "func_door_rotating");
  for (const t of findTargets(s, user.target)) {
    // Doors set their portals in door_use_areaportals instead.
    if (isDoor && stricmpEqual(s.entities[t]!.classname ?? "", "func_areaportal")) continue;
    if (t !== user.index) use(s, t, user.index);
    if (gone()) return;
  }
}

/**
 * An entity's use function, used by `other` (G_UseTargets' ent: a map entity, or -1 for
 * a DelayedUse), for the classes whose use changes area portals, a train's
 * position, a func_rotating's turning or whether a brush entity is drawn now, or the
 * moveinfo.state door_go_up reads. The rest are not modeled and do nothing here.
 */
function use(s: Settle, index: number, other: number): void {
  if (s.budget <= 0 || s.depth >= MAX_USE_DEPTH) return;
  s.budget--;
  s.depth++;
  try {
    useOne(s, index, other);
  } finally {
    s.depth--;
  }
}

function useOne(s: Settle, index: number, other: number): void {
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
    case "trigger_once":
    case "trigger_multiple":
      // A TRIGGERED one has trigger_enable as its use, which gives it Use_Multi.
      if (multiTriggered(ent) && !s.multiEnabled.has(index)) s.multiEnabled.add(index);
      else multiTrigger(s, index);
      return;
    case "trigger_counter": {
      // trigger_counter_use: a count already 0 returns; else it counts down and fires at 0.
      const count = s.counterCount.get(index) ?? (atoi(ent.count ?? "0") || 2);
      if (count === 0) return;
      s.counterCount.set(index, count - 1);
      if (count - 1 === 0) multiTrigger(s, index);
      return;
    }
    case "target_crosslevel_trigger":
      // trigger_crosslevel_trigger_use sets serverflags and frees itself (G_FreeEdict refuses worldspawn).
      if (index !== 0) freeEdict(s, index);
      return;
    case "func_wall":
    case "func_object":
      wallUse(s, index);
      return;
    case "func_train":
      trainUseIn(s, index);
      return;
    case "func_rotating": {
      // rotating_use; a team slave, or a member of a turret_breach's team, is not modeled turning.
      const m = s.rotating.get(index);
      if (m) rotatingUse(m);
      return;
    }
    case "trigger_elevator":
      elevatorUse(s, index, other);
      return;
    case "func_button": {
      // button_use -> button_fire: returns if up or at the top, else starts up. Its
      // targets fire at the top (button_wait), after the settle frames.
      const state = moveState(s, index);
      if (state !== "up" && state !== "top") {
        s.moveState.set(index, "up");
        s.moves.push({ index, up: true });
      }
      return;
    }
    case "func_timer":
      timerUse(s, index);
      return;
    case "target_explosion": {
      // use_target_explosion explodes now without a "delay", else thinks it at level.time + delay.
      const delay = s.exploding.has(index) ? 0 : f32(atof(ent.delay ?? "0"));
      if (delay === 0) explode(s, index);
      else s.nextthink.set(index, f32(levelTimeAt(2) + delay));
      return;
    }
    case "func_plat":
      // Use_Plat returns once Move_Calc has given the plat a think, else plat_go_down.
      if (!s.platsMoving.has(index)) {
        s.platsMoving.add(index);
        s.moveState.set(index, "down");
        s.moves.push({ index, up: false });
      }
      return;
  }
}

/**
 * Whether a trigger_once or trigger_multiple spawned TRIGGERED (spawnflags 4), with
 * trigger_enable as its use. SP_trigger_once moves a spawnflags 1 there.
 */
function multiTriggered(ent: BspEntity): boolean {
  return (atoi(ent.spawnflags ?? "0") & (ent.classname === "trigger_once" ? 5 : 4)) !== 0;
}

/**
 * multi_trigger in the second settle frame: returns while the trigger has a nextthink,
 * else fires its targets and sets one. A positive "wait" (trigger_multiple's 0.2 if
 * unset or 0) thinks multi_wait at level.time + wait, in float, which zeroes it again
 * if that comes due in this frame. trigger_once and trigger_counter wait -1, and with
 * no positive wait it thinks G_FreeEdict a frame later, after the settle frames.
 */
function multiTrigger(s: Settle, index: number): void {
  if ((s.nextthink.get(index) ?? 0) !== 0) return;
  useTargets(s, userOf(s, index));
  const ent = s.entities[index]!;
  const wait = ent.classname === "trigger_multiple" ? Math.fround(atof(ent.wait ?? "0")) || Math.fround(0.2) : -1;
  s.nextthink.set(index, f32(levelTimeAt(2) + (wait > 0 ? wait : FRAMETIME)));
}

/** A func_timer's "wait" as SP_func_timer leaves it: 1 if unset or 0. */
function timerWait(ent: BspEntity): number {
  const wait = f32(atof(ent.wait ?? "0"));
  return wait === 0 ? 1 : wait;
}

/**
 * crandom() * random for a func_timer, taking crandom() as 0 where the game draws it in
 * [-1, 1], never exactly 0 (`pickTarget` likewise takes the first match). SP_func_timer
 * lowers a random at or above wait to wait - FRAMETIME. One still infinite gives an
 * infinite product of either sign in the game, taken as +Infinity; with another infinite
 * summand the game's nextthink is then infinite or NaN by the draw, and this picks one.
 */
function timerJitter(ent: BspEntity, wait: number): number {
  const r = f32(atof(ent.random ?? "0"));
  const random = r >= wait ? f32(wait - FRAMETIME) : r;
  return random === Infinity || random === -Infinity ? Infinity : 0 * random;
}

/**
 * A START_ON func_timer's nextthink after SP_func_timer, at level.time 0:
 * 1.0 + pausetime + delay + wait + crandom() * random, summed in double and stored as a
 * float. 0 for one not START_ON.
 */
function timerSpawnThink(ent: BspEntity): number {
  if ((atoi(ent.spawnflags ?? "0") & 1) === 0) return 0;
  const wait = timerWait(ent);
  return f32(1.0 + f32(atof(ent.pausetime ?? "0")) + f32(atof(ent.delay ?? "0")) + wait + timerJitter(ent, wait));
}

/**
 * func_timer_think at level.time `time`: fire its targets (through a DelayedUse if it has
 * a "delay"), then think again at level.time + wait + crandom() * random. Uses run only
 * in the second frame: one due in the first fires nothing here (BACKLOG.md).
 */
function timerThink(s: Settle, index: number, time: number): void {
  if (time === levelTimeAt(2)) useTargets(s, userOf(s, index));
  const ent = s.entities[index]!;
  const wait = timerWait(ent);
  s.nextthink.set(index, f32(f32(time + wait) + timerJitter(ent, wait)));
}

/**
 * func_timer_use: a timer that has a nextthink is turned off; else it thinks at
 * level.time + delay with a "delay", or at once without.
 */
function timerUse(s: Settle, index: number): void {
  if ((s.nextthink.get(index) ?? 0) !== 0) {
    s.nextthink.set(index, 0);
    return;
  }
  const delay = f32(atof(s.entities[index]!.delay ?? "0"));
  if (delay !== 0) s.nextthink.set(index, f32(levelTimeAt(2) + delay));
  else timerThink(s, index, levelTimeAt(2));
}

/**
 * target_explosion_explode: fires its targets with its "delay" cleared, so a use that
 * reaches it meanwhile explodes it again at once. Its T_RadiusDamage (a "dmg" above 0)
 * needs the entities' bounds and is not modeled.
 */
function explode(s: Settle, index: number): void {
  // A nested explode saves and restores the cleared 0: the delay stays cleared until the outer one returns.
  const outer = s.exploding.has(index);
  s.exploding.add(index);
  try {
    useTargets(s, { ...userOf(s, index), delay: 0 });
  } finally {
    if (!outer) s.exploding.delete(index);
  }
}

/**
 * SV_RunThink in a settle frame for an entity whose think the walk models: none at or
 * below 0 or past level.time + 0.001 (compared as the C does, so a NaN runs), and
 * nextthink is zeroed before the think. multi_wait does nothing more. `slot` is the
 * entity G_RunFrame is running (level.current_entity): a team member's think run in its
 * master's teamchain walk (SV_Physics_Pusher) runs with the master current.
 */
function runThink(s: Settle, index: number, frame: 1 | 2, slot: number = index): void {
  const think = s.nextthink.get(index) ?? 0;
  if (think <= 0 || think > (frame === 1 ? FIRST_FRAME_DUE : SECOND_FRAME_DUE)) return;
  s.nextthink.set(index, 0);
  const current = s.current;
  s.current = slot;
  switch (s.entities[index]!.classname) {
    case "func_timer":
      timerThink(s, index, levelTimeAt(frame));
      break;
    case "target_explosion":
      explode(s, index);
      break;
    case "trigger_elevator":
      elevatorInit(s, index);
      break;
  }
  s.current = current;
}

/** G_PickTarget, taking the first of several matches where the game picks one at random. */
function pickTarget(s: Settle, name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  for (const t of findTargets(s, name)) return t;
  return undefined;
}

/**
 * An entity as train_next reads it when a train's "target" names it (`pickTarget`): a
 * train's live s.origin and target, and its spawnflags bit 1 is TRAIN_START_ON, which
 * train_next reads as TELEPORT; any other entity's spawn origin, target and spawnflags
 * (not where its spawn function or later moves put it: BACKLOG.md).
 */
function pathCorner(s: Settle, name: string): PathCorner | undefined {
  const t = pickTarget(s, name);
  if (t === undefined) return undefined;
  const ent = s.entities[t]!;
  const train = s.trains.get(t);
  // ED_ParseField reads origin and "wait" with sscanf and atof into floats.
  const origin = train ? train.origin : (entityVec3(ent, "origin") ?? [0, 0, 0]);
  return {
    entity: t,
    origin: [f32(origin[0]), f32(origin[1]), f32(origin[2])],
    target: train ? train.train!.target : ent.target,
    wait: f32(atof(ent.wait ?? "0")),
    teleport: train ? train.train!.startOn : (atoi(ent.spawnflags ?? "0") & PATH_CORNER_TELEPORT) !== 0,
    pathtarget: ent.pathtarget,
  };
}

/**
 * SP_func_train's mover, at its spawn origin and STATE_TOP (0): "speed" defaults to 100,
 * and "accel" and "decel" are set to it. Its train_wait fires a corner's "pathtarget"
 * through G_UseTargets with the corner's own delay and killtarget, in the settle frames
 * only (`settleSpawnFrames` drops it after).
 */
function trainMover(s: Settle, index: number, mins: Vec3): BrushMover {
  const ent = s.entities[index]!;
  const flags = atoi(ent.spawnflags ?? "0");
  const origin = entityVec3(ent, "origin") ?? [0, 0, 0];
  const speed = f32(atof(ent.speed ?? "0")) || 100;
  const mover: BrushMover = brushMover({
    origin,
    startOrigin: origin,
    endOrigin: origin,
    distance: 0,
    speed,
    accel: speed,
    decel: speed,
    wait: 0,
    toggle: false,
    state: "top",
    train: {
      mins: [f32(mins[0]), f32(mins[1]), f32(mins[2])],
      target: ent.target,
      targetEnt: undefined,
      startOn: (flags & TRAIN_START_ON) !== 0,
      toggle: (flags & TRAIN_TOGGLE) !== 0,
      pick: (name) => pathCorner(s, name),
      usePathtarget: (corner) => trainPathtarget(s, index, corner),
    },
  });
  return mover;
}

/**
 * func_train_find, the train's first think (first frame): its mins go to the corner its
 * "target" names, and a train with no "targetname" gets START_ON; with START_ON it
 * thinks train_next in the second frame. One with no "target" never gets this think.
 */
function trainFind(s: Settle, index: number, m: BrushMover): void {
  const t = m.train!;
  if (t.target === undefined) return;
  const corner = t.pick(t.target);
  if (!corner) return;
  t.target = corner.target;
  for (let k = 0; k < 3; k++) m.origin[k] = f32(corner.origin[k]! - t.mins[k]!);
  if (s.entities[index]!.targetname === undefined) t.startOn = true;
  if (t.startOn) {
    m.nextthink = levelTimeAt(2);
    m.think = "trainNext";
  }
}

/**
 * train_wait's pathtarget: G_UseTargets from the corner, with the corner's own delay and
 * killtarget; returns whether the train is still in use. A loop of coincident corners
 * recurses in the game until it crashes; the use budget and depth cut it off, leaving
 * the train where it is (as if freed).
 */
function trainPathtarget(s: Settle, index: number, corner: PathCorner): boolean {
  if (s.budget <= 0 || s.depth >= MAX_USE_DEPTH) return false;
  s.budget--;
  s.depth++;
  try {
    const ent = s.entities[corner.entity]!;
    useTargets(s, {
      index: corner.entity,
      classname: liveClassname(ent),
      target: corner.pathtarget,
      killtarget: ent.killtarget,
      delay: f32(atof(ent.delay ?? "0")),
    });
    return !s.freed.has(index);
  } finally {
    s.depth--;
  }
}

/**
 * train_use (`trainUse`). Move_Calc begins the move at once only when the train is
 * level.current_entity (`Settle.current`): from its own think, by a pathtarget of its
 * own, or from a team member's think in its teamchain walk; from any other slot (a
 * DelayedUse, another train's think) it defers Move_Begin a frame.
 */
function trainUseIn(s: Settle, index: number): void {
  const m = s.trains.get(index);
  if (m) trainUse(m, levelTimeAt(2), s.current === index);
}

/**
 * trigger_elevator_init, its think in the first frame: the use is given only when its
 * "target" picks an entity whose classname is exactly func_train.
 */
function elevatorInit(s: Settle, index: number): void {
  const t = pickTarget(s, s.entities[index]!.target);
  if (t !== undefined && s.entities[t]!.classname === "func_train") s.elevators.set(index, t);
}

/**
 * trigger_elevator_use: returns while its train has a nextthink (moving or waiting), or
 * when the user (`other`) has no "pathtarget" naming an entity (a DelayedUse has none);
 * else that entity becomes the train's target_ent and the train resumes towards it
 * (train_resume), its move begun at once only while the train is current, as in
 * `trainUseIn`. A train freed since init is left alone: the game moves its freed edict,
 * or returns on the nextthink of a DelayedUse G_Spawn put there; neither is drawn or
 * opens a portal.
 */
function elevatorUse(s: Settle, index: number, other: number): void {
  const train = s.elevators.get(index);
  if (train === undefined || s.freed.has(train)) return;
  const m = s.trains.get(train)!;
  if (m.nextthink !== 0) return;
  const pathtarget = other >= 0 ? s.entities[other]!.pathtarget : undefined;
  const corner = pathtarget === undefined ? undefined : pathCorner(s, pathtarget);
  if (!corner) return;
  m.train!.targetEnt = corner;
  trainResume(m, levelTimeAt(2), s.current === train);
}

/**
 * func_wall_use and func_object_use. SP_func_wall gives a use only to a wall with any of
 * TRIGGER_SPAWN, TOGGLE or START_ON, and SP_func_object to an object with any spawnflag;
 * the use shows a hidden one and hides a shown wall. An object's use then clears itself,
 * and a wall's does unless it has TOGGLE (which START_ON forces). The KillBox a shown
 * one runs needs the trace and is not modeled, nor the fall a used func_object starts
 * (MOVETYPE_TOSS).
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
      s.moves.push({ index: m, up: false });
      continue;
    }
    const ms = moveState(s, m);
    if (ms === "up" || ms === "top") continue;
    s.moveState.set(m, "up");
    // Move_Calc runs before the door fires its targets.
    s.moves.push({ index: m, up: true });
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
 * Edict slots: SpawnEntities refills a slot an entity freed at spawn with the next one, so
 * the in-game entities lie in entity order, each trigger_always's DelayedUse right after
 * it. Both frames run them in slot order, skipping slots freed earlier in the frame.
 *
 * First frame: a func_door or func_door_rotating with no "health" and no "targetname"
 * that is no team slave runs Think_SpawnDoorTrigger: it G_Spawns its trigger (`spawnEdict`)
 * and, if START_OPEN, opens every portal door_use_areaportals finds: in-game entities
 * whose classname is func_areaportal and whose "targetname" is the door's "target",
 * compared case insensitively (G_Find, Q_stricmp). Every train not yet freed runs
 * func_train_find (`trainFind`) at its own slot, a team slave's included (BACKLOG.md). A train's mins are its inline model's in `bsp`, else 0 0 0 (without
 * `bsp`, or a train with no inline model). A breach on a team whose master is in
 * PUSHER_CLASSES runs turret_breach_finish_init in the master's slot, along the
 * teamchain up to a freed member, freeing its target, then turret_breach_think
 * (`turretThink`); a member trigger_elevator's init runs there too (`runThink`). A START_ON func_timer due by then
 * thinks again at level.time + wait, its targets unfired (uses here are not modeled), and
 * a trigger_elevator runs trigger_elevator_init (`elevatorInit`).
 *
 * Second frame: a train runs its think if due
 * (SV_Physics_Pusher: train_next for a START_ON one, or what a use earlier in the frame
 * left it). Every
 * in-game trigger_always fires its targets through a DelayedUse (SP_trigger_always
 * raises "delay" to at least 0.2 s; one above that comes due later and is skipped),
 * which G_Spawn placed right after it: freed slots are refilled by the next spawn, so
 * none lies earlier. A use with a "delay" spawns a DelayedUse into the first slot freed
 * so far in this frame (a killtarget's, or a DelayedUse's that ran), else after every
 * slot; it fires in this frame if it is due and its slot lies ahead (`useTargets`).
 * Likewise a think due in this frame (`runThink`: multi_wait, func_timer_think,
 * target_explosion_explode) runs at the entity's slot, and earlier at a PUSHER_CLASSES
 * master's along its teamchain, after the master's turret team is pushed (`turretPush`)
 * and up to an item, whose droptofloor ends the chain after itself.
 * Slots droptofloor frees (a start-solid item, in the second frame) need the trace and
 * are not modeled, nor is a target_crosslevel_target with a "delay" up to about 0.2
 * firing and freeing itself in either frame. G_UseTargets first frees its killtargets, then uses its targets: a
 * func_areaportal toggles, a door goes up with its team (each member at the bottom fires
 * its own targets, except portals, and opens its portals), a func_door_secret at origin
 * 0 0 0 opens its portals, a trigger_relay fires its targets, a trigger_once,
 * trigger_multiple or trigger_counter passes it on as multi_trigger does (`multiTrigger`;
 * a TRIGGERED one is armed by its first, a counter fires as its count runs out), a train runs train_use
 * (`trainUseIn`), a trigger_elevator sends its train on toward its user's "pathtarget"
 * (`elevatorUse`), a func_timer is turned off, or on (`timerUse`), a target_explosion fires
 * its targets or thinks them at level.time + delay (its radius damage is not modeled),
 * a func_wall or func_object is shown or hidden (`wallUse`); an entity a killtarget
 * freed is not drawn, a func_rotating starts or stops turning (`rotatingUse`). Other use
 * functions are not modeled, nor are a team slave train's
 * thinks (both func_train_find and train_next) running in its master's slot.
 *
 * Both frames turn each func_rotating `rotatingMover` models (one that is no team's slave
 * and on no team with a turret_breach, whose think sets every member's yaw velocity) by
 * its avelocity at its slot (SV_Physics_Pusher), before the thinks there: START_ON gave
 * it one at spawn, and a use earlier in the second frame has toggled it.
 *
 * The trains' and func_rotating entities' movers are left as the second frame leaves
 * them, to go on moving; the trains' train_wait fires no pathtarget after it.
 */
function settleSpawnFrames(
  entities: readonly BspEntity[],
  bsp?: Bsp,
): {
  portals: Set<number>;
  trains: Map<number, BrushMover>;
  rotating: Map<number, BrushMover>;
  freed: Set<number>;
  shown: Map<number, boolean>;
  /** The turret teams as the second frame leaves them, for one `settleTurrets` call (with `freed`). */
  turrets: Map<number, TurretTeam>;
  moves: readonly { index: number; up: boolean }[];
  /** `areaportalsOf` as the settle frames leave the map: nothing is freed after them. */
  areaportalsOf: (index: number) => number[];
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
  // SP_trigger_always raises "delay" to at least 0.2 s, at level.time 0.
  const slots: Slot[] = [];
  const slotOf = new Map<number, number>();
  entities.forEach((e, i) => {
    if (i !== 0 && !inGame(e)) return;
    slotOf.set(i, slots.length);
    slots.push(i);
    if (i === 0 || e.classname !== "trigger_always") return;
    const delay = Math.fround(atof(e.delay ?? "0"));
    slots.push({ nextthink: Math.max(delay, Math.fround(0.2)), inFrame: false, target: e.target, killtarget: e.killtarget });
  });
  const s: Settle = {
    entities,
    byTargetname,
    freed: new Set(),
    slots,
    slotOf,
    spawned: 0,
    shown: new Map(),
    useCleared: new Set(),
    teams,
    slaves,
    moveState: new Map(),
    moves: [],
    platsMoving: new Set(),
    nextthink: new Map(),
    exploding: new Set(),
    counterCount: new Map(),
    multiEnabled: new Set(),
    portalCount: new Map(),
    portals: new Map(),
    trains: new Map(),
    rotating: new Map(),
    elevators: new Map(),
    current: -1,
    budget: MAX_USES,
    spawnedBudget: MAX_USES,
    depth: 0,
  };
  entities.forEach((e, i) => {
    if (e.classname !== "func_train" || !inGame(e)) return;
    const model = bsp && inlineModel(bsp, e.model);
    const mins: Vec3 = bsp && model !== undefined ? modelBounds(bsp, model).mins : [0, 0, 0];
    s.trains.set(i, trainMover(s, i, mins));
  });
  const breachTeams = new Set(
    [...teams.values()].filter((m) => m.some((i) => entities[i]!.classname === "turret_breach")).flat(),
  );
  entities.forEach((e, i) => {
    if (e.classname !== "func_rotating" || !inGame(e) || slaves.has(i) || breachTeams.has(i)) return;
    const m = brushMover(rotatingMover(e));
    if (atoi(e.spawnflags ?? "0") & ROTATING_START_ON) rotatingUse(m);
    s.rotating.set(i, m);
  });
  entities.forEach((e, i) => {
    if (!inGame(e)) return;
    if (e.classname === "func_timer") {
      const think = timerSpawnThink(e);
      if (think !== 0) s.nextthink.set(i, think);
    }
    // SP_trigger_elevator thinks trigger_elevator_init at level.time + FRAMETIME.
    if (e.classname === "trigger_elevator") s.nextthink.set(i, f32(FRAMETIME));
  });
  const turrets = turretTeams(entities);
  // The first frame, in slot order (a slot freed earlier in it is skipped).
  const first = levelTimeAt(1);
  for (const slot of [...s.slots]) {
    if (typeof slot !== "number" || s.freed.has(slot)) continue;
    const ent = entities[slot]!;
    // Nothing turns yet: turret_breach_finish_init sets the first velocities below.
    const turret = turrets.get(slot);
    if (turret) turretPush(turret, s.freed);
    // SV_Physics_Pusher turns a func_rotating before any think on its team runs.
    const rotor = s.rotating.get(slot);
    if (rotor) stepPusher([rotor], first);
    const train = s.trains.get(slot);
    if (train) trainFind(s, slot, train);
    runThink(s, slot, 1);
    if (
      (ent.classname === "func_door" || ent.classname === "func_door_rotating") &&
      !slaves.has(slot) &&
      !atoi(ent.health ?? "0") &&
      ent.targetname === undefined
    ) {
      // Think_SpawnDoorTrigger: G_Spawn the door's trigger, then open its portals if START_OPEN.
      spawnEdict(s, "doorTrigger");
      if (atoi(ent.spawnflags ?? "0") & DOOR_START_OPEN) doorUseAreaportals(s, slot, true);
    }
    // SV_Physics_Pusher runs a PUSH or STOP master's team thinks along its teamchain, which
    // ends at a freed member (G_FreeEdict clears its teamchain). turret_breach_finish_init
    // frees the breach's target (G_PickTarget; the game crashes on a target that names nothing).
    // It then runs turret_breach_think.
    const members = teams.get(slot);
    if (!members || !PUSHER_CLASSES.has(ent.classname ?? "")) {
      if (turret) turretThink(turret, 0);
      continue;
    }
    for (const [p, m] of members.entries()) {
      if (s.freed.has(m)) break;
      runThink(s, m, 1, slot);
      if (s.freed.has(m)) break;
      if (entities[m]!.classname !== "turret_breach") continue;
      const t = pickTarget(s, entities[m]!.target);
      if (t !== undefined && t !== 0) freeEdict(s, t);
      if (s.freed.has(m)) break;
      if (turret) turretThink(turret, p);
    }
  }
  const second = levelTimeAt(2);
  // G_RunFrame reads num_edicts each pass, so a slot appended in this frame is run too.
  for (let p = 0; p < s.slots.length; p++) {
    const slot = s.slots[p]!;
    s.budget = MAX_USES;
    if (typeof slot === "number") {
      // A func_rotating turns by the avelocity uses in earlier slots left it, a turret
      // team by what its breaches' thinks set in the first frame.
      const rotor = s.rotating.get(slot);
      if (rotor) stepPusher([rotor], second);
      const turret = turrets.get(slot);
      if (turret) turretPush(turret, s.freed);
      // A modeled think due in this frame (`runThink`): in the entity's own slot, and also
      // in a PUSH or STOP master's slot (earlier) for each teamchain member, after the
      // master's push and own think (SV_Physics_Pusher).
      runThink(s, slot, 2);
      const train = s.trains.get(slot);
      if (train) {
        s.current = slot;
        stepPusher([train], second);
        s.current = -1;
      }
      // An item's droptofloor, due now, ends the teamchain after the item.
      const members = teams.get(slot);
      if (members && PUSHER_CLASSES.has(entities[slot]!.classname ?? "")) {
        for (const [p, m] of members.entries()) {
          if (s.freed.has(m)) break;
          runThink(s, m, 2, slot);
          if (s.freed.has(m)) break;
          if (turret) turretThink(turret, p);
          if (ITEM_CLASSES.has(entities[m]!.classname ?? "")) {
            if (turret) turret.chain = p + 1;
            break;
          }
        }
      } else if (turret) turretThink(turret, 0);
    } else if (slot !== null && slot !== "doorTrigger" && slot.nextthink > 0 && slot.nextthink <= SECOND_FRAME_DUE) {
      // SV_RunThink: a nextthink at or below 0 never runs. Think_Delay frees the slot after its uses.
      if (slot.inFrame) s.budget = s.spawnedBudget;
      useTargets(s, { index: -1, classname: "DelayedUse", target: slot.target, killtarget: slot.killtarget, delay: 0 });
      if (slot.inFrame) s.spawnedBudget = s.budget;
      s.slots[p] = null;
    }
  }
  for (const m of s.trains.values()) m.train!.usePathtarget = undefined;
  return {
    portals: new Set([...s.portals].filter(([, open]) => open).map(([p]) => p)),
    trains: s.trains,
    rotating: s.rotating,
    freed: s.freed,
    shown: s.shown,
    turrets,
    moves: s.moves,
    areaportalsOf: (index) => areaportalsOf(s, index),
  };
}

/**
 * The area portals open after the settle frames (`settleSpawnFrames`). Without `bsp`
 * every train's mins are 0 0 0, which can change which corners lie at no distance.
 */
export function openAreaPortals(entities: readonly BspEntity[], bsp?: Bsp): Set<number> {
  return settleSpawnFrames(entities, bsp).portals;
}

/** A door, plat, button or train, the entity it is, and the area portals its door_hit_bottom closes. */
export interface MovingBrush {
  readonly entity: number;
  readonly mover: BrushMover;
  /**
   * The portals door_use_areaportals finds for a door's "target" (`areaportalsOf`), in
   * the order it sets them; none for a plat, a button or a train.
   */
  readonly portals: readonly number[];
}

/** The classes door_go_up moves: func_door (func_water is one after spawn) and func_door_rotating. */
function movingDoor(ent: BspEntity): boolean {
  return ent.classname === "func_door" || ent.classname === "func_water" || ent.classname === "func_door_rotating";
}

/** The moveinfo Think_CalcMoveSpeed reads from a team member that is not a door: every other spawn function leaves moveinfo.distance 0. */
const NO_MOVE: MoveSpeeds = { distance: 0, speed: 0, accel: 0, decel: 0 };

/**
 * SP_func_door_rotating's mover: it turns about the axis its spawnflags pick (yaw, or
 * roll for X_AXIS, pitch for Y_AXIS; REVERSE negates it) by "distance" degrees (an int,
 * default 90), at "speed" (default 100, not doubled; "accel" and "decel" default to it
 * and are unused, as AngleMove_Calc has no accelerative move), "wait" 0 becoming 3. A
 * START_OPEN door starts at the open angles and turns back to 0 0 0 going up. Its
 * origin never moves.
 */
function rotatingDoor(ent: BspEntity, origin: Vec3): BrushMoverInit {
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  const axis = flags & DOOR_X_AXIS ? 2 : flags & DOOR_Y_AXIS ? 0 : 1;
  const distance = atoi(ent.distance ?? "0") || 90;
  // pos2 = VectorMA(0 0 0, distance, movedir), a float.
  const open: Vec3 = [0, 0, 0];
  open[axis] = f32(flags & DOOR_REVERSE ? -distance : distance);
  const closed: Vec3 = [0, 0, 0];
  const [start, end] = flags & DOOR_START_OPEN ? [open, closed] : [closed, open];
  const field = (key: string) => f32(atof(ent[key] ?? "0"));
  const speed = field("speed") || 100;
  return {
    rotating: true,
    origin,
    startOrigin: origin,
    endOrigin: origin,
    angles: start,
    startAngles: start,
    endAngles: end,
    distance,
    speed,
    accel: field("accel") || speed,
    decel: field("decel") || speed,
    wait: field("wait") || 3,
    toggle: doorToggles(ent),
    state: "bottom",
  };
}

/**
 * SP_func_rotating's mover, at its spawn origin and angles (it keeps them), turning about
 * the axis its spawnflags pick (yaw, or roll for X_AXIS, pitch for Y_AXIS; REVERSE
 * negates it) at "speed" degrees a second (default 100) once used (`rotatingUse`).
 * START_ON uses it at spawn. STOP makes it MOVETYPE_STOP, which moves the same unless
 * blocked (not modeled). Its moveinfo is left 0.
 */
function rotatingMover(ent: BspEntity): BrushMoverInit {
  const flags = atoi(ent.spawnflags ?? "0") & ~SPAWNFLAG_SKILL_MASK;
  const movedir: Vec3 = [0, 0, 0];
  movedir[flags & ROTATING_X_AXIS ? 2 : flags & ROTATING_Y_AXIS ? 0 : 1] = 1;
  // VectorNegate: the other axes become -0.
  if (flags & ROTATING_REVERSE) for (let k = 0; k < 3; k++) movedir[k] = -movedir[k]!;
  const origin = entityVec3(ent, "origin") ?? [0, 0, 0];
  return {
    origin,
    angles: entityAngles(ent),
    startOrigin: origin,
    endOrigin: origin,
    distance: 0,
    speed: 0,
    accel: 0,
    decel: 0,
    wait: 0,
    toggle: false,
    state: "top",
    spin: { movedir, speed: f32(atof(ent.speed ?? "0")) || 100 },
  };
}

/** SP_func_plat's pos1 (the spawn origin) and pos2 (`platMover`), in float. */
function platPositions(ent: BspEntity, mins: readonly number[], maxs: readonly number[], origin: Vec3): { pos1: Vec3; pos2: Vec3 } {
  const pos1 = origin.map(f32) as Vec3;
  const height = atoi(ent.height ?? "0");
  const lip = atoi(ent.lip ?? "0") || 8;
  const drop = height ? f32(height) : f32(f32(f32(maxs[2]!) - f32(mins[2]!)) - lip);
  return { pos1, pos2: [pos1[0], pos1[1], f32(pos1[2] - drop)] };
}

/**
 * SP_func_plat's mover: pos1, the top, is its spawn origin, and pos2 lies "height" (an
 * int) below it, or the plat's height less "lip" (an int, default 8), in float. "speed",
 * "accel" and "decel" (default 20, 5 and 5, else a tenth of the value given) are per
 * frame where Think_AccelMove takes them (Move_Begin, when all three are equal, takes
 * "speed" per second), and "speed" is not doubled. A plat with a
 * "targetname" starts at the top at STATE_UP, any other at the bottom.
 * moveinfo.distance is left 0 and "wait" is unused: plat_hit_top always waits 3 s.
 */
function platMover(ent: BspEntity, mins: Vec3, maxs: Vec3, origin: Vec3): BrushMoverInit {
  const { pos1, pos2 } = platPositions(ent, mins, maxs, origin);
  // ent->speed *= 0.1: the float times a double, stored as a float.
  const field = (key: string, absent: number) => {
    const v = f32(atof(ent[key] ?? "0"));
    return v ? f32(v * 0.1) : absent;
  };
  const top = ent.targetname !== undefined;
  return {
    origin: top ? pos1 : pos2,
    startOrigin: pos1,
    endOrigin: pos2,
    distance: 0,
    speed: field("speed", 20),
    accel: field("accel", 5),
    decel: field("decel", 5),
    wait: f32(atof(ent.wait ?? "0")),
    toggle: false,
    state: top ? "up" : "bottom",
  };
}

/**
 * SP_func_button's mover: pos1 is its spawn origin, and pos2 lies its size along the
 * move direction (G_SetMovedir) less "lip" (an int, default 4) from it, in float as a
 * door's (`linearPositions`); no spawnflag changes them. "speed" defaults to 40 and is not doubled; "accel" and
 * "decel" default to it, and "wait" 0 becomes 3 (negative stays at the top). It starts
 * at STATE_BOTTOM, and moveinfo.distance is left 0.
 */
function buttonMover(ent: BspEntity, mins: Vec3, maxs: Vec3, origin: Vec3): BrushMoverInit {
  const { pos1, pos2 } = linearPositions(ent, mins, maxs, origin, 4);
  const field = (key: string) => f32(atof(ent[key] ?? "0"));
  const speed = field("speed") || 40;
  return {
    origin: pos1,
    startOrigin: pos1,
    endOrigin: pos2,
    distance: 0,
    speed,
    accel: field("accel") || speed,
    decel: field("decel") || speed,
    wait: field("wait") || 3,
    toggle: false,
    state: "bottom",
  };
}

/**
 * The doors (func_door, func_water, which SP_func_water renames func_door, and
 * func_door_rotating) and the plats, buttons, trains and func_rotating entities that are
 * no team's slave as the two settle frames leave them:
 * teams in master entity order, each team's doors in team order (the master first when
 * it is a door); a door, plat, button, train or func_rotating with no team is a team of one. SP_func_door and SP_func_water set up each linear door
 * (`doorPositions`; a door's "speed", default 100, is doubled in deathmatch, and its
 * "accel" and "decel" default to that, "wait" 0 becomes 3; func_water takes "speed",
 * default 25, for all three, and "wait" 0 becomes -1, which makes it DOOR_TOGGLE), and
 * SP_func_door_rotating each rotating one (`rotatingDoor`). In the first frame a
 * func_door or func_door_rotating master's think (Think_CalcMoveSpeed, also at the end
 * of Think_SpawnDoorTrigger) matches its team's speeds; a func_water has no think. In
 * the second the settle frames' uses send doors up or down (`doorUse`), from a
 * DelayedUse's slot, so each starts moving a frame later; a use sends a plat down
 * (Use_Plat, `platMover`) and a button up (button_fire, `buttonMover`) the same way.
 * A train's or func_rotating's mover is the one the settle frames ran (`trainMover`,
 * `rotatingMover`), moving on from where they left it.
 *
 * Think_CalcMoveSpeed reads every member of the chain: a func_door_rotating's distance
 * is in degrees, and every other class (a func_button, a func_wall) leaves
 * moveinfo.distance 0, which makes the doors' speeds infinite, so a linear door moves
 * all the way in one frame (Move_Final) and a rotating one turns all the way in one
 * (AngleMove_Final). A team keeps only its doors and a plat, button, train or
 * func_rotating master: the other members, slave plats, buttons, trains and func_rotating
 * entities included, stay where `brushModelInstances` puts them. A func_door_secret, which SP_func_door_secret also
 * renames, is not modeled moving. A team with a door that has no inline model is left
 * out. A team's chain ends at the first member a killtarget freed (G_FreeEdict zeroes
 * its teamchain), and a team whose master was freed never moves again
 * (SV_Physics_Pusher returns for the slaves).
 */
export function brushMovers(bsp: Bsp, entities: readonly BspEntity[]): MovingBrush[][] {
  const frames = settleSpawnFrames(entities, bsp);
  const { freed, moves, areaportalsOf, trains, rotating } = frames;
  const turrets = settleTurrets(frames.turrets, freed);
  const groups = [...findTeams(entities).values()];
  const teamed = new Set(groups.flat());
  // A team's master, a team of one included, is not a FL_TEAMSLAVE: Use_Plat or
  // button_use moves it.
  const slaves = new Set(groups.flatMap((g) => g.slice(1)));
  const doors = new Map<number, MovingBrush>();
  entities.forEach((ent, i) => {
    if (i === 0 || !inGame(ent)) return;
    const plat = ent.classname === "func_plat" && !slaves.has(i);
    const button = ent.classname === "func_button" && !slaves.has(i);
    const train = ent.classname === "func_train" && !slaves.has(i);
    const rotor = rotating.get(i);
    if (!plat && !button && !train && !rotor && !movingDoor(ent)) return;
    const model = inlineModel(bsp, ent.model);
    if (model === undefined) return;
    if (train || rotor) {
      doors.set(i, { entity: i, mover: rotor ?? trains.get(i)!, portals: [] });
      return;
    }
    const origin = entityVec3(ent, "origin") ?? [0, 0, 0];
    if (plat) {
      const { mins, maxs } = modelBounds(bsp, model);
      doors.set(i, { entity: i, mover: brushMover(platMover(ent, mins, maxs, origin)), portals: [] });
      return;
    }
    if (button) {
      const { mins, maxs } = modelBounds(bsp, model);
      doors.set(i, { entity: i, mover: brushMover(buttonMover(ent, mins, maxs, origin)), portals: [] });
      return;
    }
    // A door in a turret's team starts turned by the yaw steps that bring its breach to
    // rest, as `brushModelInstances` draws it (the game takes them after the settle frames
    // when the breach is slow). Move_Calc leaves s.angles alone; AngleMove turns towards
    // absolute start or end angles, so a rotating door turns the yaw back as it moves (BACKLOG.md).
    const steps = turrets.get(i)?.steps ?? [];
    if (ent.classname === "func_door_rotating") {
      const init = rotatingDoor(ent, origin);
      doors.set(i, { entity: i, mover: brushMover({ ...init, angles: turnedAngles(init.angles!, steps) }), portals: areaportalsOf(i) });
      return;
    }
    const { mins, maxs } = modelBounds(bsp, model);
    const { pos1, pos2, distance } = doorPositions(ent, mins, maxs, origin);
    const field = (key: string) => f32(atof(ent[key] ?? "0"));
    let speed: number, accel: number, decel: number, wait: number;
    if (ent.classname === "func_door") {
      speed = f32((field("speed") || 100) * 2);
      accel = field("accel") || speed;
      decel = field("decel") || speed;
      wait = field("wait") || 3;
    } else {
      speed = accel = decel = field("speed") || 25;
      wait = field("wait") || -1;
    }
    const mover = brushMover({
      origin: pos1,
      angles: turnedAngles([0, 0, 0], steps),
      startOrigin: pos1,
      endOrigin: pos2,
      distance,
      speed,
      accel,
      decel,
      wait,
      toggle: doorToggles(ent),
      state: "bottom",
    });
    doors.set(i, { entity: i, mover, portals: areaportalsOf(i) });
  });

  for (const i of doors.keys()) if (!teamed.has(i)) groups.push([i]);
  groups.sort((a, b) => a[0]! - b[0]!);
  const teams: MovingBrush[][] = [];
  const moving = new Map<number, BrushMover>();
  for (const members of groups) {
    if (members.some((i) => movingDoor(entities[i]!) && !doors.has(i))) continue;
    const master = entities[members[0]!]!.classname;
    if (master === "func_door" || master === "func_door_rotating") {
      calcMoveSpeed(members.map((i) => doors.get(i)?.mover ?? NO_MOVE));
    }
    const cut = members.findIndex((i) => freed.has(i));
    const live = (cut < 0 ? members : members.slice(0, cut)).flatMap((i) => doors.get(i) ?? []);
    if (live.length === 0) continue;
    teams.push(live);
    for (const d of live) moving.set(d.entity, d.mover);
  }
  const settled = levelTimeAt(2);
  for (const { index, up } of moves) {
    const m = moving.get(index);
    if (!m) continue;
    // Only a plat or button that is no team's slave moves here, and only Use_Plat or
    // button_use moves it.
    const classname = entities[index]!.classname;
    if (classname === "func_plat") platGoDown(m, settled, false);
    else if (classname === "func_button") buttonFire(m, settled, false);
    else if (up) doorGoUp(m, settled, false);
    else doorGoDown(m, settled, false);
  }
  return teams;
}
