// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBsp, parseEntities } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { brushModelInstances, entityAngles, openAreaPortals, visibleAtSpawn } from "../src/bmodels.js";

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

    describe("a targeted func_train a trigger_always uses in the second frame (train_use)", () => {
      const path = `
        { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "10 0 0" }
        { "classname" "path_corner" "targetname" "b" "target" "c" "origin" "20 0 0" "spawnflags" "1" }
        { "classname" "path_corner" "targetname" "c" "target" "d" "origin" "30 0 0" "spawnflags" "1" }
        { "classname" "path_corner" "targetname" "d" "origin" "40 0 0" "spawnflags" "1" }`;
      const x = (src: string) => place(`{ "classname" "worldspawn" }` + src + path).map((b) => b.origin[0] - 385);

      it("runs train_next: jumps on to a TELEPORT corner after its first, once", () => {
        expect(x(`{ "classname" "trigger_always" "target" "t" } { "classname" "func_train" "model" "*1" "target" "a" "targetname" "T" }`)).toEqual([20]);
        // Through a relay, and as a door's target.
        expect(
          x(`{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "target" "t" }
            { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }`),
        ).toEqual([20]);
        expect(
          x(`{ "classname" "trigger_always" "target" "door" } { "classname" "func_door" "targetname" "door" "target" "t" }
            { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }`),
        ).toEqual([20]);
      });

      it("only if due in the second frame, and not past a corner a killtarget freed first", () => {
        expect(x(`{ "classname" "trigger_always" "target" "t" "delay" "0.3" } { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }`)).toEqual([10]);
        expect(x(`{ "classname" "trigger_always" "target" "t" "killtarget" "b" } { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }`)).toEqual([10]);
      });

      it("steps self->target on past connected teleports, so a second use jumps again", () => {
        // First use: a -> b jumps, c stops it with self->target at d. Second: d jumps, no target after.
        const train = `{ "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }`;
        expect(x(`{ "classname" "trigger_always" "target" "t" } { "classname" "trigger_always" "target" "t" }` + train)).toEqual([40]);
        // A train that found a corner to move to resumes instead (no move), or ignores it while running.
        const moving = `{ "classname" "path_corner" "targetname" "m" "target" "n" "origin" "50 0 0" }
          { "classname" "path_corner" "targetname" "n" "target" "b" "origin" "60 0 0" }`;
        expect(
          x(`{ "classname" "trigger_always" "target" "t" } { "classname" "trigger_always" "target" "t" } { "classname" "trigger_always" "target" "t" }
            { "classname" "func_train" "model" "*1" "target" "m" "targetname" "t" "spawnflags" "2" }` + moving),
        ).toEqual([50]);
      });

      it("a train freed by a killtarget before its own think does not run train_next", () => {
        expect(x(`{ "classname" "trigger_always" "killtarget" "t" } { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }`)).toEqual([10]);
      });

      it("a START_ON TOGGLE train it stops keeps its first corner only if stopped before its own think", () => {
        const train = `{ "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "3" }`;
        const always = `{ "classname" "trigger_always" "target" "t" }`;
        expect(x(always + train)).toEqual([10]);
        expect(x(train + always)).toEqual([20]);
        // Without TOGGLE the use is ignored either way.
        expect(x(always + `{ "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }`)).toEqual([20]);
      });
    });

    it("finishes a train's own-think move to a corner at no distance at once (Move_Final -> train_wait)", () => {
      const corners = (zb: string) => `{ "classname" "worldspawn" }
        { "classname" "func_train" "model" "*1" "target" "za" }
        { "classname" "path_corner" "targetname" "za" "target" "zb" "origin" "10 0 0" }
        { "classname" "path_corner" "targetname" "zb" "target" "zc" ${zb} }
        { "classname" "path_corner" "targetname" "zc" "origin" "30 0 0" "spawnflags" "1" }`;
      const x = (zb: string) => place(corners(zb)).map((b) => b.origin[0] - 385);
      expect(x(`"origin" "10 0 0"`)).toEqual([30]); // wait 0: train_next again, through the teleport
      expect(x(`"origin" "10.0000001 0 0"`)).toEqual([30]); // equal as floats
      expect(x(`"origin" "10.001 0 0"`)).toEqual([10]); // some distance: moves next frame
      expect(x(`"origin" "10 0 0" "wait" "2"`)).toEqual([10]); // waits past the settle frames
      expect(x(`"origin" "10 0 0" "wait" "-1"`)).toEqual([10]); // not TOGGLE: stays
      // A loop of coincident corners is cut off, not run forever.
      expect(
        place(`{ "classname" "worldspawn" } { "classname" "func_train" "model" "*1" "target" "l1" }
          { "classname" "path_corner" "targetname" "l1" "target" "l2" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "l2" "target" "l1" "origin" "10 0 0" }`).map((b) => b.origin[0] - 385),
      ).toEqual([10]);
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

describe("area portals open at spawn", () => {
  const portals = `{ "classname" "worldspawn" }
    { "classname" "func_areaportal" "targetname" "p" "style" "1" }
    { "classname" "func_areaportal" "targetname" "P" "style" "2" }
    { "classname" "func_areaportal" "targetname" "q" "style" "3" }`;
  const open = (doors: string) => [...openAreaPortals(parseEntities(portals + doors))].sort((a, b) => a - b);

  it("start closed (SP_func_areaportal)", () => {
    expect(open("")).toEqual([]);
    expect(open(`{ "classname" "func_door" "model" "*1" "target" "q" }`)).toEqual([]);
  });

  it("a START_OPEN door with no health or targetname opens every portal it targets, matched case insensitively", () => {
    expect(open(`{ "classname" "func_door" "model" "*1" "target" "p" "spawnflags" "1" }`)).toEqual([1, 2]);
    expect(open(`{ "classname" "func_door_rotating" "model" "*1" "target" "Q" "spawnflags" "1" }`)).toEqual([3]);
    expect(open(`{ "classname" "func_door" "model" "*1" "target" "q" "spawnflags" "257" }`)).toEqual([3]);
  });

  it("a START_OPEN door with health or a targetname waits to be used (Think_CalcMoveSpeed)", () => {
    expect(open(`{ "classname" "func_door" "target" "q" "spawnflags" "1" "health" "10" }`)).toEqual([]);
    expect(open(`{ "classname" "func_door" "target" "q" "spawnflags" "1" "targetname" "d" }`)).toEqual([]);
    expect(open(`{ "classname" "func_door" "target" "q" "spawnflags" "1" "health" "x" }`)).toEqual([3]);
  });

  it("only doors open portals, and only spawned ones", () => {
    expect(open(`{ "classname" "func_water" "target" "q" "spawnflags" "1" }`)).toEqual([]);
    expect(open(`{ "classname" "FUNC_DOOR" "target" "q" "spawnflags" "1" }`)).toEqual([]);
    expect(open(`{ "classname" "func_door" "target" "q" "spawnflags" "2049" }`)).toEqual([]);
  });

  it("a team slave does not; its master does if it is a START_OPEN door itself (G_FindTeams)", () => {
    const team = (masterFlags: string, slaveTarget: string) =>
      open(`{ "classname" "func_door" "team" "t" "target" "p" "spawnflags" "${masterFlags}" }
        { "classname" "func_door" "team" "t" "target" "${slaveTarget}" "spawnflags" "1" }`);
    expect(team("0", "q")).toEqual([]);
    expect(team("1", "q")).toEqual([1, 2]);
    // A master freed in deathmatch is not in the team; the next member leads it.
    expect(
      open(`{ "classname" "func_door" "team" "t" "spawnflags" "2048" }
        { "classname" "func_door" "team" "t" "target" "q" "spawnflags" "1" }`),
    ).toEqual([3]);
  });

  it("finds portals by classname case insensitively, and not ones freed in deathmatch", () => {
    const ents = parseEntities(`{ "classname" "worldspawn" }
      { "classname" "FUNC_AREAPORTAL" "targetname" "p" "style" "4" }
      { "classname" "func_areaportal" "targetname" "p" "style" "5" "spawnflags" "2048" }
      { "classname" "func_door" "target" "p" "spawnflags" "1" }`);
    expect([...openAreaPortals(ents)]).toEqual([4]);
  });

  describe("a trigger_always in the second settle frame", () => {
    it("toggles a func_areaportal open, and back closed if fired twice", () => {
      expect(open(`{ "classname" "trigger_always" "target" "q" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "p" }`)).toEqual([1, 2]);
      expect(open(`{ "classname" "trigger_always" "target" "q" } { "classname" "trigger_always" "target" "q" }`)).toEqual([]);
      expect(open(`{ "classname" "trigger_always" "target" "q" "spawnflags" "2048" }`)).toEqual([]);
    });

    it("toggles the entity's count, not the portal's state (Use_Areaportal)", () => {
      // The START_OPEN door opened portal 3 in the first frame; the toggle writes count 1, still open.
      expect(open(`{ "classname" "func_door" "target" "q" "spawnflags" "1" } { "classname" "trigger_always" "target" "q" }`)).toEqual([3]);
      // Two entities on one portal: each toggles its own count, the last write wins.
      const shared = parseEntities(`{ "classname" "worldspawn" }
        { "classname" "func_areaportal" "targetname" "a" "style" "1" }
        { "classname" "func_areaportal" "targetname" "b" "style" "1" }
        { "classname" "trigger_always" "target" "a" }
        { "classname" "trigger_always" "target" "a" }
        { "classname" "trigger_always" "target" "b" }`);
      expect([...openAreaPortals(shared)]).toEqual([1]);
    });

    it("a train's own think fires a coincident corner's pathtarget (train_wait)", () => {
      const train = (wait: string) => `{ "classname" "func_train" "target" "a" }
        { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "1 2 3" }
        { "classname" "path_corner" "targetname" "b" "pathtarget" "q" "origin" "1 2 3" ${wait} }`;
      expect(open(train(""))).toEqual([3]);
      expect(open(train(`"wait" "5"`))).toEqual([3]);
      expect(open(train(`"delay" "1"`))).toEqual([]);
    });

    it("fires only if due by the second frame: delay up to 0.2 s, as SP_trigger_always raises it", () => {
      expect(open(`{ "classname" "trigger_always" "target" "q" "delay" "0.2" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "q" "delay" "-5" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "q" "delay" "0.2009" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "q" "delay" "0.25" }`)).toEqual([]);
    });

    it("opens a door's portals as it goes up, and the portals of its team", () => {
      expect(open(`{ "classname" "trigger_always" "target" "d" } { "classname" "func_door" "targetname" "d" "target" "q" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "D" } { "classname" "func_door_rotating" "targetname" "d" "target" "p" }`)).toEqual([1, 2]);
      // A START_OPEN door with a targetname goes up to its closed position, and still opens them.
      expect(open(`{ "classname" "trigger_always" "target" "d" } { "classname" "func_door" "targetname" "d" "target" "q" "spawnflags" "1" }`)).toEqual([3]);
      expect(
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "team" "t" "target" "q" }
          { "classname" "func_door" "team" "t" "target" "p" }`),
      ).toEqual([1, 2, 3]);
      // A slave ignores the use.
      expect(
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "team" "t" "target" "q" }
          { "classname" "func_door" "targetname" "d" "team" "t" "target" "p" }`),
      ).toEqual([]);
    });

    it("a door's portals are set open, not toggled, and a door targeting a portal does not toggle it (G_UseTargets)", () => {
      // The door both targets portal 3 and has it toggled by its own use: set open, never toggled back.
      expect(
        open(`{ "classname" "trigger_always" "target" "d" } { "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "target" "q" }`),
      ).toEqual([3]);
      // The second use of a DOOR_TOGGLE door sends it down, which writes nothing yet.
      expect(
        open(`{ "classname" "trigger_always" "target" "d" } { "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "target" "q" "spawnflags" "32" }`),
      ).toEqual([3]);
    });

    it("a door fires its other targets as it goes up; one with a delay fires later", () => {
      const chain = (delay: string) =>
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "target" "e" ${delay} }
          { "classname" "func_door" "targetname" "e" "target" "q" }`);
      expect(chain("")).toEqual([3]);
      expect(chain(`"delay" "0.1"`)).toEqual([]);
    });

    it("func_water is a door named func_door after spawn, toggling unless it has a wait", () => {
      const water = `{ "classname" "func_water" "targetname" "w" "target" "q" }`;
      expect(open(`{ "classname" "trigger_always" "target" "w" } ${water}`)).toEqual([3]);
      // As a func_door, it does not toggle the portal it targets; its second use (DOOR_TOGGLE) only sends it down.
      expect(open(`{ "classname" "trigger_always" "target" "w" } { "classname" "trigger_always" "target" "w" } ${water}`)).toEqual([3]);
    });

    it("a func_door_secret at origin 0 0 0 opens its portals; a trigger_relay passes the use on", () => {
      expect(open(`{ "classname" "trigger_always" "target" "s" } { "classname" "func_door_secret" "targetname" "s" "target" "q" }`)).toEqual([3]);
      expect(
        open(`{ "classname" "trigger_always" "target" "s" } { "classname" "func_door_secret" "targetname" "s" "target" "q" "origin" "0 0 8" }`),
      ).toEqual([]);
      expect(open(`{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "target" "q" }`)).toEqual([3]);
      expect(open(`{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "target" "r" }`)).toEqual([]);
    });

    it("sends every team member at the bottom up, whatever its class (door_go_up)", () => {
      const member = (m: string) =>
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "team" "t" }
          { ${m} "team" "t" "target" "q" }`);
      expect(member(`"classname" "func_button"`)).toEqual([3]);
      expect(member(`"classname" "func_plat"`)).toEqual([3]);
      // A targeted plat starts at STATE_UP: door_go_up returns.
      expect(member(`"classname" "func_plat" "targetname" "x"`)).toEqual([]);
    });

    it("a member sent down by a DOOR_TOGGLE master goes up on the next use, from any state", () => {
      // The targeted plat starts at STATE_UP; the second use sends it down, the third up.
      const uses = (n: number) =>
        open(`${`{ "classname" "trigger_always" "target" "d" } `.repeat(n)}
          { "classname" "func_door" "targetname" "d" "team" "t" "spawnflags" "32" }
          { "classname" "func_plat" "targetname" "x" "team" "t" "target" "q" }`);
      expect(uses(2)).toEqual([]);
      expect(uses(3)).toEqual([3]);
    });

    it("a button or plat used first is no longer at the bottom when its team's door goes up", () => {
      const team = (member: string) =>
        open(`{ "classname" "trigger_always" "target" "x" } { "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "team" "t" }
          { ${member} "targetname" "x" "team" "t" "target" "q" }`);
      // button_fire leaves it at STATE_UP: door_go_up returns.
      expect(team(`"classname" "func_button"`)).toEqual([]);
      // plat_go_down leaves a targeted plat at STATE_DOWN: door_go_up sends it up.
      expect(team(`"classname" "func_plat"`)).toEqual([3]);
    });

    it("ends a trigger_relay loop that branches with a use budget per trigger_always", () => {
      // Without the budget this hangs (synchronously, past any vitest timeout).
      const relays = `{ "classname" "trigger_relay" "targetname" "r" "target" "r" } `.repeat(3);
      const nulls = `{ "classname" "info_null" "targetname" "n" } `.repeat(3000);
      const start = performance.now();
      // The loop's budget does not starve the next trigger_always.
      expect(open(`{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_always" "target" "q" } ${relays} ${nulls}`)).toEqual([3]);
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it("frees killtargets before using targets", () => {
      expect(open(`{ "classname" "trigger_always" "target" "q" "killtarget" "q" }`)).toEqual([]);
      expect(
        open(`{ "classname" "trigger_always" "target" "d" "killtarget" "d" } { "classname" "func_door" "targetname" "d" "target" "q" }`),
      ).toEqual([]);
      // A door that kills itself is a zeroed edict: no target to open portals by, no teamchain to follow.
      expect(open(`{ "classname" "trigger_always" "target" "d" } { "classname" "func_door" "targetname" "d" "target" "q" "killtarget" "d" }`)).toEqual([]);
      expect(
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "team" "t" "target" "q" "killtarget" "d" }
          { "classname" "func_door" "team" "t" "target" "p" }`),
      ).toEqual([]);
      // A member freed before its turn ends the chain too; the master's portals stay open.
      expect(
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "team" "t" "target" "q" "killtarget" "m" }
          { "classname" "func_door" "targetname" "m" "team" "t" "target" "p" }`),
      ).toEqual([3]);
    });
  });
});
