// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBsp, parseEntities } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { brushModelInstances, entityAngles, visibleAtSpawn } from "../src/bmodels.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));

describe("brush model instances", () => {
  it("places the fixture's func_wall (model 1) at the origin, nothing else", () => {
    expect(brushModelInstances(bsp, parseEntities(bsp.entityString))).toEqual({
      instances: [{ model: 1, origin: [0, 0, 0], angles: [0, 0, 0], classname: "func_wall" }],
      errors: [],
    });
  });

  it("takes the entity origin, and skips point models and the world", () => {
    const ents = parseEntities(`
      { "classname" "worldspawn" }
      { "classname" "func_door" "model" "*1" "origin" "16 -32 8" }
      { "classname" "misc_explobox" "model" "models/objects/barrels/tris.md2" "origin" "1 2 3" }
    `);
    expect(brushModelInstances(bsp, ents)).toEqual({
      instances: [{ model: 1, origin: [16, -32, 8], angles: [0, 0, 0], classname: "func_door" }],
      errors: [],
    });
  });

  it("matches keys case insensitively, and classnames case sensitively", () => {
    const ents = parseEntities(`
      { "ClassName" "func_wall" "Model" "*1" "ORIGIN" "16 -32 8" "Angle" "90" }
      { "classname" "Func_Wall" "model" "*1" }
    `);
    expect(brushModelInstances(bsp, ents)).toEqual({
      instances: [{ model: 1, origin: [16, -32, 8], angles: [0, 90, 0], classname: "func_wall" }],
      errors: [],
    });
  });

  it("keeps spawn angles only for classes whose spawn function keeps them", () => {
    const ents = parseEntities(`
      { "classname" "func_wall" "model" "*1" "angle" "90" }
      { "classname" "func_rotating" "model" "*1" "angles" "10 20 30" }
      { "classname" "turret_base" "model" "*1" "angle" "45" }
      { "classname" "func_door" "model" "*1" "angle" "90" }
      { "classname" "func_door_rotating" "model" "*1" "angles" "0 90 0" }
      { "classname" "func_plat" "model" "*1" "angle" "180" }
      { "classname" "func_train" "model" "*1" "angle" "180" }
    `);
    expect(brushModelInstances(bsp, ents).instances.map((b) => [b.classname, b.angles])).toEqual([
      ["func_wall", [0, 90, 0]],
      ["func_rotating", [10, 20, 30]],
      ["turret_base", [0, 45, 0]],
      ["func_door", [0, 0, 0]],
      ["func_door_rotating", [0, 0, 0]],
      ["func_plat", [0, 0, 0]],
      ["func_train", [0, 0, 0]],
    ]);
  });

  it('reads "angle" and "angles"', () => {
    const angles = (src: string) => entityAngles(parseEntities(`{ ${src} }`)[0]!);
    expect(angles(`"classname" "func_wall"`)).toEqual([0, 0, 0]);
    expect(angles(`"angle" "90"`)).toEqual([0, 90, 0]);
    expect(angles(`"angle" " -22.5e1x"`)).toEqual([0, -225, 0]); // atof: leading number only
    expect(angles(`"angle" "east"`)).toEqual([0, 0, 0]);
    expect(angles(`"angles" "1 2 3"`)).toEqual([1, 2, 3]);
    expect(angles(`"angles" "1 2"`)).toEqual([0, 0, 0]); // malformed: none, as for "origin"
    expect(angles(`"angle" "90" "angles" "1 2 3"`)).toEqual([1, 2, 3]); // the later key wins
    expect(angles(`"angles" "1 2 3" "angle" "90"`)).toEqual([0, 90, 0]);
    expect(angles(`"angle" "90" "angles" "1 2 3" "angle" "45"`)).toEqual([0, 45, 0]); // a repeat counts as later
    expect(angles(`"Angle" "90"`)).toEqual([0, 90, 0]); // keys match case insensitively
    expect(angles(`"angle" "90" "ANGLES" "1 2 3"`)).toEqual([1, 2, 3]);
  });

  it("reports references to models the map does not have", () => {
    const ents = parseEntities(`
      { "classname" "func_wall" "model" "*0" }
      { "classname" "func_wall" "model" "*2" }
      { "classname" "func_wall" "model" "*1x" }
      { "classname" "func_wall" "model" "*" }
    `);
    const { instances, errors } = brushModelInstances(bsp, ents);
    expect(instances).toEqual([]);
    expect(errors).toEqual([
      'entity 0 (func_wall): model "*0" is not an inline model of this map',
      'entity 1 (func_wall): model "*2" is not an inline model of this map',
      'entity 2 (func_wall): model "*1x" is not an inline model of this map',
      'entity 3 (func_wall): model "*" is not an inline model of this map',
    ]);
  });

  it("leaves out entities the deathmatch game hides at spawn", () => {
    const vis = (src: string) => visibleAtSpawn(parseEntities(`{ ${src} }`)[0]!);
    for (const shown of [
      `"classname" "func_wall"`,
      `"classname" "func_wall" "spawnflags" "7"`, // START_ON
      `"classname" "func_door"`,
      `"classname" "func_plat"`,
      `"classname" "func_door" "spawnflags" "1"`, // START_OPEN: still drawn
      `"classname" "func_object"`,
      `"classname" "func_object" "spawnflags" "1792"`, // skill bits are cleared before SP_func_object
      `"classname" "func_wall" "spawnflags" "256"`,
      `"classname" "func_train"`,
      `"classname" "target_character"`,
      `"classname" "turret_breach"`,
      `"classname" "turret_base"`,
      `"classname" "func_door" "spawnflags" "\u00a02048"`, // C isspace does not skip NBSP: atoi gives 0
    ]) {
      expect(vis(shown), shown).toBe(true);
    }
    for (const hidden of [
      `"classname" "func_wall" "spawnflags" "1"`, // TRIGGER_SPAWN
      `"classname" "func_wall" "spawnflags" "2"`, // TOGGLE implies TRIGGER_SPAWN
      `"classname" "func_door" "spawnflags" "2048"`, // NOT_DEATHMATCH
      `"classname" "func_door" "spawnflags" "2048x"`, // atoi reads the leading digits
      `"classname" "func_door" "spawnflags" " +2048"`,
      `"classname" "func_door" "spawnflags" "99999999999999999999"`, // clamps to INT_MAX, NOT_DEATHMATCH set
      `"classname" "trigger_multiple"`,
      `"classname" "func_areaportal"`,
      `"classname" "func_killbox"`,
      `"classname" "func_object" "spawnflags" "1"`, // TRIGGER_SPAWN
      `"classname" "func_object" "spawnflags" "2"`, // ANIMATED, but any flag hides it
      `"classname" "func_explosive"`,
      `"classname" "func_group"`,
      `"classname" "no_such_class"`,
      `"model" "*1"`, // no classname
    ]) {
      expect(vis(hidden), hidden).toBe(false);
    }
  });

  describe("spawn moves", () => {
    // Fixture model 1 spans -384 128 0 to -320 192 48; setmodel spreads it a unit, so the
    // entity's mins are -385 127 -1 and its size 66 66 50.
    const place = (src: string) => {
      const ents = parseEntities(src);
      return brushModelInstances(bsp, ents).instances.map((b) => ({ origin: b.origin, angles: b.angles }));
    };
    const close = (got: readonly number[], want: readonly number[]) =>
      want.forEach((w, k) => expect(got[k], `component ${k} of ${got.join(" ")}`).toBeCloseTo(w, 9));

    it("lowers an untargeted func_plat by its height less lip, or by height", () => {
      expect(place(`
        { "classname" "func_plat" "model" "*1" "origin" "1 2 3" }
        { "classname" "func_plat" "model" "*1" "lip" "0" }
        { "classname" "func_plat" "model" "*1" "lip" "4" }
        { "classname" "func_plat" "model" "*1" "height" "32" "lip" "4" }
        { "classname" "func_plat" "model" "*1" "targetname" "" }
        { "classname" "func_plat" "model" "*1" "angle" "90" }
      `).map((b) => b.origin)).toEqual([
        [1, 2, 3 - 42], // 50 - default lip 8
        [0, 0, -42], // lip 0 means the default
        [0, 0, -46],
        [0, 0, -32],
        [0, 0, 0], // targeted: starts at the top
        [0, 0, -42],
      ]);
    });

    it("opens a START_OPEN func_door or func_water along its move direction", () => {
      const got = place(`
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "origin" "16 -32 8" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "90" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "-1" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angles" "0 -2 0" "lip" "2" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "45" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "180" }
        { "classname" "func_door" "model" "*1" "angle" "90" }
        { "classname" "func_water" "model" "*1" "spawnflags" "1" "angle" "-1" }
        { "classname" "func_water" "model" "*1" "spawnflags" "1" "angle" "-2" "lip" "10" }
        { "classname" "func_water" "model" "*1" "angle" "-1" }
      `);
      const d45 = 66 * Math.SQRT1_2 * 2 - 8;
      const want = [
        [16 + 58, -32, 8], // yaw 0: size 66 less lip 8 along +X
        [0, 58, 0],
        [0, 0, 42], // -1 is up: 50 - 8
        [0, 0, -48], // -2 is down
        [d45 * Math.SQRT1_2, d45 * Math.SQRT1_2, 0], // |dir| . size - lip
        [-58, 0, 0],
        [0, 0, 0], // not START_OPEN
        [0, 0, 50], // func_water has no default lip
        [0, 0, -40],
        [0, 0, 0],
      ];
      expect(got).toHaveLength(want.length);
      got.forEach((b, i) => {
        close(b.origin, want[i]!);
        expect(b.angles).toEqual([0, 0, 0]);
      });
    });

    it("turns a START_OPEN func_door_rotating to its open angles", () => {
      expect(place(`
        { "classname" "func_door_rotating" "model" "*1" "spawnflags" "1" "origin" "1 2 3" "angle" "30" }
        { "classname" "func_door_rotating" "model" "*1" "spawnflags" "3" "distance" "45" }
        { "classname" "func_door_rotating" "model" "*1" "spawnflags" "65" }
        { "classname" "func_door_rotating" "model" "*1" "spawnflags" "129" "distance" "-30" }
        { "classname" "func_door_rotating" "model" "*1" "spawnflags" "193" }
        { "classname" "func_door_rotating" "model" "*1" "distance" "45" }
      `)).toEqual([
        { origin: [1, 2, 3], angles: [0, 90, 0] }, // default distance 90 about yaw; spawn angles cleared
        { origin: [0, 0, 0], angles: [0, -45, 0] }, // REVERSE
        { origin: [0, 0, 0], angles: [0, 0, 90] }, // X_AXIS turns roll
        { origin: [0, 0, 0], angles: [-30, 0, 0] }, // Y_AXIS turns pitch
        { origin: [0, 0, 0], angles: [0, 0, 90] }, // X_AXIS is tested first
        { origin: [0, 0, 0], angles: [0, 0, 0] }, // not START_OPEN
      ]);
    });

    it("moves a func_train's mins to the first entity its target names", () => {
      expect(place(`
        { "classname" "func_train" "model" "*1" "origin" "5 5 5" "target" "T1" }
        { "classname" "path_corner" "targetname" "t1" "origin" "1 1 1" "spawnflags" "2048" }
        { "classname" "path_corner" "targetname" "t1" "origin" "100 200 300" }
        { "classname" "path_corner" "targetname" "T1" "origin" "9 9 9" }
        { "classname" "func_train" "model" "*1" "origin" "5 5 5" "target" "nowhere" }
        { "classname" "func_train" "model" "*1" "origin" "5 5 5" }
      `).map((b) => b.origin)).toEqual([
        [100 + 385, 200 - 127, 300 + 1], // NOT_DEATHMATCH corner is freed; case-insensitive match
        [5, 5, 5], // target not found: stays
        [5, 5, 5], // no target
      ]);
    });

    it("jumps an untargeted or START_ON func_train on to a TELEPORT path_corner after its first", () => {
      expect(place(`
        { "classname" "func_train" "model" "*1" "target" "a" }
        { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "10 0 0" }
        { "classname" "path_corner" "targetname" "b" "target" "c" "origin" "20 0 0" "spawnflags" "1" }
        { "classname" "path_corner" "targetname" "c" "origin" "30 0 0" "spawnflags" "1" }
        { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }
        { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }
        { "classname" "func_train" "model" "*1" "target" "c" }
        { "classname" "func_train" "model" "*1" "target" "b" }
        { "classname" "func_train" "model" "*1" "target" "d" }
        { "classname" "path_corner" "targetname" "d" "target" "a" "origin" "40 0 0" }
      `).map((b) => b.origin[0])).toEqual([
        20 + 385, // next corner b teleports; only one jump
        10 + 385, // targeted, not START_ON: waits at a
        20 + 385, // START_ON
        30 + 385, // c has no target: no next corner
        30 + 385, // b's next, c, teleports too
        40 + 385, // next corner a does not teleport: still at d
      ]);
    });

    it("turns a turret_breach to rest: pitch to 0 within its range, yaw into minyaw..maxyaw", () => {
      const angles = (src: string) => place(src).map((b) => b.angles);
      const [level, inRange, clampedUp, nearMin, nearMax, huge] = angles(`
        { "classname" "worldspawn" }
        { "classname" "turret_breach" "model" "*1" "angles" "20 90 5" }
        { "classname" "turret_breach" "model" "*1" "angle" "-90" "minyaw" "200" "maxyaw" "300" }
        { "classname" "turret_breach" "model" "*1" "minpitch" "10" "maxpitch" "20" "speed" "3" }
        { "classname" "turret_breach" "model" "*1" "angle" "350" "minyaw" "10" "maxyaw" "100" }
        { "classname" "turret_breach" "model" "*1" "angle" "160" "minyaw" "10" "maxyaw" "100" }
        { "classname" "turret_breach" "model" "*1" "angle" "1e999" }
      `);
      close(level!, [0, 90, 5]); // roll is never turned
      close(inRange!, [0, -90, 0]); // 270, already in range
      close(clampedUp!, [-10, 0, 0]); // pitch range -20..-10 (Quake pitch is down), at 0.3 deg a frame
      close(nearMin!, [0, 370, 0]); // 20 deg the short way, up past 360
      close(nearMax!, [0, 100, 0]);
      expect(huge).toEqual([0, Infinity, 0]); // not run: the game's AnglesNormalize would never end
    });

    it("turns a turret team by the yaw of its last breach, only under a turret master", () => {
      const yaws = (src: string) => place(src).map((b) => b.angles[1]);
      // Breach a turns from 0 to its minyaw 80, so its base, on team "a" too, turns by 80.
      const [baseA, breachA, other, breachB1, breachB2, baseB] = yaws(`
        { "classname" "worldspawn" }
        { "classname" "turret_base" "model" "*1" "angle" "30" "team" "a" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "a" }
        { "classname" "turret_base" "model" "*1" "angle" "30" "team" "A" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "90" "maxyaw" "100" "team" "b" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "180" "maxyaw" "190" "team" "b" }
        { "classname" "turret_base" "model" "*1" "team" "b" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "90" "maxyaw" "100" "team" "b" "spawnflags" "2048" }
      `);
      expect(baseA).toBeCloseTo(110, 9);
      expect(breachA).toBeCloseTo(80, 9); // 0 is nearer minyaw 80 than maxyaw 100
      expect(other).toBe(30); // team names compare case sensitively
      // The second breach turns to 190 the short way (-170) and sets the team's yaw last, so
      // the first follows it instead of its own range. The NOT_DEATHMATCH one is not in the team.
      expect(breachB1).toBeCloseTo(-170, 9);
      expect(breachB2).toBeCloseTo(-170, 9);
      expect(baseB).toBeCloseTo(-170, 9);

      expect(yaws(`
        { "classname" "worldspawn" }
        { "classname" "func_wall" "model" "*1" "team" "c" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "90" "maxyaw" "100" "team" "c" }
        { "classname" "turret_base" "model" "*1" "angle" "45" }
      `)).toEqual([0, 0, 45]); // a func_wall master: not run (known gap, see BACKLOG.md); an unteamed base never turns

      // A master its spawn function frees in deathmatch is not in the team; the base leads it.
      expect(yaws(`
        { "classname" "worldspawn" }
        { "classname" "light" "team" "d" }
        { "classname" "func_explosive" "model" "*1" "team" "d" }
        { "classname" "turret_base" "model" "*1" "team" "d" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "d" }
      `).map((y) => Math.round(y * 1e9) / 1e9)).toEqual([80, 80]);
    });
  });
});
