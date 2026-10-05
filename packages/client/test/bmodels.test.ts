// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBsp, parseEntities } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { brushModelInstances, brushMovers, entityAngles, openAreaPortals, playerSpawnSpot, visibleAtSpawn } from "../src/bmodels.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));

describe("brush model instances", () => {
  it("places the fixture's func_wall (model 1) at the origin, nothing else", () => {
    expect(brushModelInstances(bsp, parseEntities(bsp.entityString))).toEqual({
      instances: [{ model: 1, entity: 1, origin: [0, 0, 0], angles: [0, 0, 0], classname: "func_wall" }],
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
      instances: [{ model: 1, entity: 1, origin: [16, -32, 8], angles: [0, 0, 0], classname: "func_door" }],
      errors: [],
    });
  });

  it("matches keys case insensitively, and classnames case sensitively", () => {
    const ents = parseEntities(`
      { "ClassName" "func_wall" "Model" "*1" "ORIGIN" "16 -32 8" "Angle" "90" }
      { "classname" "Func_Wall" "model" "*1" }
    `);
    expect(brushModelInstances(bsp, ents)).toEqual({
      instances: [{ model: 1, entity: 0, origin: [16, -32, 8], angles: [0, 90, 0], classname: "func_wall" }],
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

  describe("after the settle frames' uses", () => {
    const drawn = (src: string) =>
      brushModelInstances(bsp, parseEntities(`{ "classname" "worldspawn" }` + src)).instances.map((b) => `${b.classname} ${b.origin[0]}`);

    it("leaves out brush entities a killtarget freed", () => {
      expect(
        drawn(`{ "classname" "trigger_always" "killtarget" "K" }
          { "classname" "func_wall" "model" "*1" "targetname" "k" "origin" "1 0 0" }
          { "classname" "func_door" "model" "*1" "targetname" "k" "origin" "2 0 0" }
          { "classname" "func_door" "model" "*1" "targetname" "other" "origin" "3 0 0" }`),
      ).toEqual(["func_door 3"]);
      // Only killtargets due in the second frame, and through a relay too.
      expect(drawn(`{ "classname" "trigger_always" "killtarget" "k" "delay" "0.3" } { "classname" "func_wall" "model" "*1" "targetname" "k" }`)).toEqual(["func_wall 0"]);
      expect(
        drawn(`{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "killtarget" "k" }
          { "classname" "func_wall" "model" "*1" "targetname" "k" }`),
      ).toEqual([]);
    });

    it("shows a hidden func_wall or func_object it uses, and hides a shown func_wall", () => {
      const used = (classname: string, flags: number, times = 1) =>
        drawn(`{ "classname" "trigger_always" "target" "w" } `.repeat(times) + `{ "classname" "${classname}" "model" "*1" "targetname" "w" "spawnflags" "${flags}" }`);
      expect(used("func_wall", 1)).toEqual(["func_wall 0"]); // TRIGGER_SPAWN: shown
      expect(used("func_wall", 2)).toEqual(["func_wall 0"]); // TOGGLE alone implies TRIGGER_SPAWN
      expect(used("func_wall", 6)).toEqual([]); // START_ON: hidden
      expect(used("func_wall", 4)).toEqual([]); // START_ON forces TOGGLE
      expect(used("func_wall", 0)).toEqual(["func_wall 0"]); // a plain wall has no use
      expect(used("func_wall", 1792)).toEqual(["func_wall 0"]); // skill bits cleared: plain
      expect(used("func_object", 1)).toEqual(["func_object 0"]);
      expect(used("func_object", 0)).toEqual(["func_object 0"]); // no use; shown already
      // A second use: TOGGLE hides it again; without, the first cleared the use.
      expect(used("func_wall", 3, 2)).toEqual([]);
      expect(used("func_wall", 1, 2)).toEqual(["func_wall 0"]);
      expect(used("func_wall", 4, 2)).toEqual(["func_wall 0"]);
      expect(used("func_object", 1, 2)).toEqual(["func_object 0"]);
      // Through a door sent up, and not a wall the killtarget freed first.
      expect(
        drawn(`{ "classname" "trigger_always" "target" "d" } { "classname" "func_door" "targetname" "d" "target" "w" }
          { "classname" "func_wall" "model" "*1" "targetname" "w" "spawnflags" "1" }`),
      ).toEqual(["func_wall 0"]);
      expect(drawn(`{ "classname" "trigger_always" "target" "w" "killtarget" "w" } { "classname" "func_wall" "model" "*1" "targetname" "w" "spawnflags" "1" }`)).toEqual([]);
    });
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

    it("lowers a func_plat in float, from its origin parsed to float", () => {
      // pos2[2] -= st.height on a float: 1.00000006 parses to 1.00000012, less 2 is
      // -0.999999881 (double arithmetic on the unparsed text would give -0.99999994).
      const [b] = place(`{ "classname" "func_plat" "model" "*1" "origin" "0 0 1.00000006" "height" "2" }`);
      expect(b!.origin[2]).toBe(Math.fround(Math.fround(1.00000006) - 2));
      expect(b!.origin[2]).not.toBe(1.00000006 - 2);
    });

    it("keeps an unmoved brush entity's origin as the float it parses to", () => {
      const [b] = place(`{ "classname" "func_door" "model" "*1" "origin" "0 0 1.00000006" }`);
      expect(b!.origin[2]).toBe(Math.fround(1.00000006));
      expect(b!.origin[2]).not.toBe(1.00000006);
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
      // Float, as SP_func_door computes it: yaw 90's cosine is -4.37e-8, not 0 (exact values below).
      got.forEach((b, i) => {
        want[i]!.forEach((w, k) => expect(b.origin[k], `door ${i} component ${k}`).toBeCloseTo(w, 4));
        expect(b.angles).toEqual([0, 0, 0]);
      });
    });

    it("computes a START_OPEN door's position in float, as SP_func_door does", () => {
      // From a gcc (SSE) build of SP_func_door's G_SetMovedir, distance and VectorMA.
      const got = place(`
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "90" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "45" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "180" }
        { "classname" "func_door" "model" "*1" "spawnflags" "1" "angle" "270" }
      `).map((b) => b.origin);
      expect(got).toEqual(
        [
          [-2.53526059e-6, 58, 0],
          [60.3431473, 60.3431473, 0],
          [-58.0000076, -5.07052164e-6, 0],
          [6.91643095e-7, -58, 0],
        ].map((v) => v.map(Math.fround)),
      );
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
        expect(x(`{ "classname" "trigger_always" "killtarget" "t" } { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }`)).toEqual([]);
        // Its think would reach the coincident corner b and fire b's pathtarget.
        const ents = parseEntities(`{ "classname" "worldspawn" } { "classname" "trigger_always" "killtarget" "t" }
          { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }
          { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "b" "origin" "10 0 0" "pathtarget" "p" }
          { "classname" "func_areaportal" "targetname" "p" "style" "3" }`);
        expect([...openAreaPortals(ents)]).toEqual([]);
        expect([...openAreaPortals(ents.filter((e) => e.classname !== "trigger_always"))]).toEqual([3]);
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

    describe("a trigger_elevator sends its train on toward its user's pathtarget (trigger_elevator_use)", () => {
      // Train "t" waits at a (x 10); corner z at x 50. Entities: 0 worldspawn, 1 train, 2 a, 3 z, then `src`.
      const base = `{ "classname" "worldspawn" }
        { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" }
        { "classname" "path_corner" "targetname" "a" "origin" "10 0 0" }
        { "classname" "path_corner" "targetname" "z" "origin" "50 0 0" }`;
      const train = (src: string, prefix = base) => {
        const ents = parseEntities(prefix + src);
        const i = ents.findIndex((e) => e.classname === "func_train");
        const m = brushMovers(bsp, ents).flat().find((b) => b.entity === i)!.mover;
        return { at: m.origin[0] - 385, to: m.train!.targetEnt?.entity, end: m.endOrigin[0] - 385, think: m.think, next: m.nextthink };
      };
      const relay = (keys: string) => `{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "target" "e" ${keys} }`;
      const elevator = `{ "classname" "trigger_elevator" "targetname" "e" "target" "t" }`;

      it("resumes it toward the entity the user's pathtarget names, its move begun a frame later from another slot", () => {
        expect(train(relay(`"pathtarget" "z"`) + elevator)).toEqual({ at: 10, to: 3, end: 50, think: "moveBegin", next: Math.fround(0.3) });
        // The elevator's own slot does not matter: its use was given in the first frame.
        expect(train(elevator + relay(`"pathtarget" "z"`))).toMatchObject({ to: 3, end: 50 });
        // And any entity with that targetname, read where it spawned.
        expect(train(relay(`"pathtarget" "e"`) + `{ "classname" "trigger_elevator" "targetname" "e" "target" "t" "origin" "70 0 0" }`)).toMatchObject({ to: 6, end: 70 });
      });

      it("does nothing without a pathtarget naming an entity, or for a DelayedUse", () => {
        const idle = { at: 10, to: undefined, next: 0 };
        expect(train(relay("") + elevator)).toMatchObject(idle);
        // The elevator's own pathtarget is not read.
        expect(train(relay("") + `{ "classname" "trigger_elevator" "targetname" "e" "target" "t" "pathtarget" "z" }`)).toMatchObject(idle);
        expect(train(relay(`"pathtarget" "nothing"`) + elevator)).toMatchObject(idle);
        expect(train(`{ "classname" "trigger_always" "target" "e" "pathtarget" "z" }` + elevator)).toMatchObject(idle);
      });

      it("has no use unless its target picks an entity whose classname is func_train", () => {
        const idle = { at: 10, to: undefined };
        expect(train(relay(`"pathtarget" "z"`) + `{ "classname" "trigger_elevator" "targetname" "e" "target" "a" }`)).toMatchObject(idle);
        expect(train(relay(`"pathtarget" "z"`) + `{ "classname" "trigger_elevator" "targetname" "e" }`)).toMatchObject(idle);
        // Nor when it is freed at spawn (NOT_DEATHMATCH).
        expect(train(relay(`"pathtarget" "z"`) + `{ "classname" "trigger_elevator" "targetname" "e" "target" "t" "spawnflags" "2048" }`)).toMatchObject(idle);
      });

      it("used from a team member's think in its train master's teamchain walk, has the master current", () => {
        // The explosion's think (due at 0.15) runs in train t's slot (SV_Physics_Pusher), where
        // level.current_entity is still t, so Move_Calc begins the move at once.
        const team = `{ "classname" "worldspawn" } { "classname" "trigger_always" "target" "x" }
          { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "team" "k" }
          { "classname" "path_corner" "targetname" "a" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "z" "origin" "50 0 0" }
          { "classname" "target_explosion" "targetname" "x" "team" "k" "delay" "-0.05" "pathtarget" "z" "target" "e" }`;
        expect(train(elevator, team)).toMatchObject({ at: 10, to: 4, end: 50, think: "moveFinal", next: Math.fround(0.6) });
        // Out of the team it runs at its own slot, after the train's: not current, deferred.
        expect(train(elevator, team.replace(`"team" "k" "delay"`, `"delay"`))).toMatchObject({ to: 4, think: "moveBegin", next: Math.fround(0.3) });
      });

      it("returns while the train has a nextthink", () => {
        // A START_ON train has train_next due in the second frame: after its slot its move to b
        // (at no distance, wait -1) is done and the elevator resumes it; before it, it is busy.
        const startOn = `{ "classname" "worldspawn" }
          { "classname" "func_train" "model" "*1" "target" "a" "targetname" "t" "spawnflags" "1" }
          { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "z" "origin" "50 0 0" }
          { "classname" "path_corner" "targetname" "b" "origin" "10 0 0" "wait" "-1" }`;
        expect(train(relay(`"pathtarget" "z"`) + elevator, startOn)).toMatchObject({ to: 3, end: 50, next: Math.fround(0.3) });
        expect(train(elevator, startOn.replace(`{ "classname" "func_train"`, `${relay(`"pathtarget" "z"`)} { "classname" "func_train"`))).toMatchObject({
          to: 6,
          end: 10,
          next: 0,
        });
      });

      it("from its train's own corner pathtarget begins the move at once, toward the entity the corner's pathtarget names", () => {
        // b's pathtarget names the elevator, so trigger_elevator_use picks the elevator itself.
        const own = `{ "classname" "worldspawn" }
          { "classname" "func_train" "model" "*1" "target" "a" }
          { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "b" "origin" "10 0 0" "wait" "-1" "pathtarget" "e" }
          { "classname" "trigger_elevator" "targetname" "e" "target" "t" "origin" "90 0 0" }`;
        const named = own.replace(`"target" "a" }`, `"target" "a" "targetname" "t" "spawnflags" "1" }`);
        expect(train("", named)).toEqual({ at: 10, to: 4, end: 90, think: "moveFinal", next: Math.fround(1) });
        // Without the elevator's use (no train named t) it stays at b.
        expect(train("", own)).toMatchObject({ at: 10, to: 3, end: 10, next: 0 });
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
      const train = (flags: string, zb: string, before = "") =>
        place(`{ "classname" "worldspawn" }${before}
          { "classname" "func_train" "model" "*1" "target" "za" ${flags} }
          { "classname" "path_corner" "targetname" "za" "target" "zb" "origin" "10 0 0" }
          { "classname" "path_corner" "targetname" "zb" "target" "zc" "origin" "10 0 0" ${zb} }
          { "classname" "path_corner" "targetname" "zc" "origin" "30 0 0" "spawnflags" "1" }`).map((b) => b.origin[0] - 385);
      expect(train(`"spawnflags" "2"`, `"wait" "-1"`)).toEqual([30]); // TOGGLE: train_next, then stops
      expect(train(`"speed" "-5"`, "")).toEqual([10]); // Move_Begin does not finish a negative-speed move
      expect(train(`"targetname" "tr" "spawnflags" "1"`, `"killtarget" "tr" "pathtarget" "none"`)).toEqual([]); // freed by its corner
      // A train its corner freed stops there: it does not go on to fire a later corner's pathtarget.
      const freedBy = (killtarget: string) =>
        openAreaPortals(
          parseEntities(`{ "classname" "worldspawn" } { "classname" "func_train" "model" "*1" "target" "za" "targetname" "tr" "spawnflags" "1" }
            { "classname" "path_corner" "targetname" "za" "target" "zb" "origin" "10 0 0" }
            { "classname" "path_corner" "targetname" "zb" "target" "zc" "origin" "10 0 0" "killtarget" "${killtarget}" "pathtarget" "none" }
            { "classname" "path_corner" "targetname" "zc" "origin" "10 0 0" "pathtarget" "p" }
            { "classname" "func_areaportal" "targetname" "p" "style" "3" }`),
        );
      expect([...freedBy("tr")]).toEqual([]);
      expect([...freedBy("none")]).toEqual([3]);
      // Used from a trigger_always's slot, Move_Calc defers Move_Begin: no train_wait.
      expect(train(`"targetname" "tr"`, "", `{ "classname" "trigger_always" "target" "tr" }`)).toEqual([10]);
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
      `)).toEqual([90, 90, 45]); // a func_wall master (MOVETYPE_PUSH) runs and turns with its team; an unteamed base never turns

      // A master its spawn function frees in deathmatch is not in the team; the base leads it.
      expect(yaws(`
        { "classname" "worldspawn" }
        { "classname" "light" "team" "d" }
        { "classname" "func_explosive" "model" "*1" "team" "d" }
        { "classname" "turret_base" "model" "*1" "team" "d" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "d" }
      `).map((y) => Math.round(y * 1e9) / 1e9)).toEqual([80, 80]);
    });

    it("runs a team's turrets only under a MOVETYPE_PUSH or STOP master (SV_Physics_Pusher)", () => {
      const yaws = (src: string) => place(`{ "classname" "worldspawn" }` + src).map((b) => Math.round(b.angles[1] * 1e9) / 1e9);
      const breach = (team: string) => `{ "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "${team}" }`;
      // MOVETYPE_STOP (func_button) runs like PUSH.
      expect(yaws(`{ "classname" "func_button" "model" "*1" "team" "a" } ${breach("a")}`)).toEqual([80, 80]);
      // MOVETYPE_NONE masters (func_conveyor, a classname with no spawn function) run only
      // their own think; so do an item (NONE, then TOSS) and a misc_gib (TOSS), whose origin
      // copy onto the slaves is not modeled.
      expect(yaws(`{ "classname" "func_conveyor" "model" "*1" "angle" "10" "team" "a" } ${breach("a")}`)).toEqual([10, 0]);
      expect(yaws(`{ "classname" "weapon_shotgun" "team" "a" } ${breach("a")}`)).toEqual([0]);
      expect(yaws(`{ "classname" "no_such_class" "team" "a" } ${breach("a")}`)).toEqual([0]);
      expect(yaws(`{ "classname" "misc_gib_arm" "team" "a" } ${breach("a")}`)).toEqual([0]);
      // A spawnflags-0 func_object turns MOVETYPE_TOSS in the second frame: one 5 degree
      // step (speed 50 * FRAMETIME) is pushed, in that frame, and SV_Physics_Toss turns the
      // master alone by one more in the third. A triggered one stays PUSH.
      expect(yaws(`{ "classname" "func_object" "model" "*1" "team" "a" } ${breach("a")}`)).toEqual([10, 5]);
      // A breach one 3 degree step from rest stops the team in its second-frame think.
      expect(yaws(`{ "classname" "func_object" "model" "*1" "team" "a" } ${breach("a").replace('"80"', '"3"')}`)).toEqual([3, 3]);
      expect(yaws(`{ "classname" "func_object" "model" "*1" "team" "a" "spawnflags" "1" } ${breach("a")}`)).toEqual([80]);
    });

    it("stops turning the members after an item, whose droptofloor cuts the team chain in the second frame", () => {
      const yaws = (src: string) => place(`{ "classname" "worldspawn" }` + src).map((b) => Math.round(b.angles[1] * 1e9) / 1e9);
      // The base after the item was pushed in the second frame only, by the first frame's 5 degrees.
      expect(yaws(`
        { "classname" "turret_base" "model" "*1" "team" "a" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "a" }
        { "classname" "item_health" "team" "a" }
        { "classname" "turret_base" "model" "*1" "team" "a" }
      `)).toEqual([80, 80, 5]);
      // A breach after the item no longer thinks: it stops after one step, and the team
      // before it keeps the yaw velocity that step set, spinning to the frame cap.
      const [base, cut] = yaws(`
        { "classname" "turret_base" "model" "*1" "team" "b" }
        { "classname" "ammo_shells" "team" "b" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "b" }
      `);
      expect(cut).toBe(5);
      expect(base).toBe(5 * 9999); // no push in the first frame
    });

    it("stops a turret team at a member the settle frames free, and all of it at a freed master", () => {
      const yaws = (src: string) => place(`{ "classname" "worldspawn" }` + src).map((b) => Math.round(b.angles[1] * 1e9) / 1e9);
      const breach = (keys = "") => `{ "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "a" ${keys} }`;
      const base = (keys = "") => `{ "classname" "turret_base" "model" "*1" "team" "a" ${keys} }`;
      const kill = `{ "classname" "trigger_always" "killtarget" "m" }`;
      // A killtarget in the second frame frees the master before its slot: nothing turns,
      // as turret_breach_finish_init only set the velocities in the first. After its slot,
      // the team was pushed once (5 degrees) and stops there.
      const freedMaster = `${base(`"targetname" "m"`)} ${breach()} ${base()}`;
      expect(yaws(kill + freedMaster)).toEqual([0, 0]);
      expect(yaws(freedMaster + kill)).toEqual([5, 5]);
      // A freed member ends the chain: the master and breach before it turn to rest, the
      // base after it stays where the last push left it.
      const freedMember = `${base()} ${breach()} { "classname" "func_wall" "model" "*1" "team" "a" "targetname" "m" } ${base()}`;
      expect(yaws(kill + freedMember)).toEqual([80, 80, 0]);
      expect(yaws(freedMember + kill)).toEqual([80, 80, 5]);
      // turret_breach_finish_init frees its target in the first frame, before its own
      // think: a later breach past the freed member never thinks, so the first sets the
      // team's yaw; a breach targeting its master stops the team at once.
      expect(
        yaws(`${base()} ${breach(`"target" "x"`)} { "classname" "func_wall" "model" "*1" "team" "a" "targetname" "x" }
          { "classname" "turret_breach" "model" "*1" "minyaw" "180" "maxyaw" "190" "team" "a" } ${base()}`),
      ).toEqual([80, 80, 0, 0]);
      expect(yaws(`${base(`"targetname" "x"`)} ${breach(`"target" "x"`)}`)).toEqual([0]);
    });

    it("leaves out of teams and target lookups the entities a spawn function frees in deathmatch", () => {
      const yaws = (src: string) => place(`{ "classname" "worldspawn" }` + src).map((b) => Math.round(b.angles[1] * 1e9) / 1e9);
      const team = (master: string) => yaws(`${master}
        { "classname" "func_conveyor" "model" "*1" "angle" "10" "team" "a" }
        { "classname" "turret_breach" "model" "*1" "minyaw" "80" "maxyaw" "100" "team" "a" }`);
      // Freed: the conveyor (MOVETYPE_NONE) leads, and the breach keeps its angles.
      for (const freed of [
        `{ "classname" "monster_soldier" "team" "a" }`,
        `{ "classname" "info_null" "team" "a" }`,
        `{ "classname" "func_group" "team" "a" }`,
        `{ "classname" "info_player_coop" "team" "a" }`,
        `{ "classname" "target_secret" "team" "a" }`,
        `{ "classname" "path_corner" "team" "a" }`,
        `{ "classname" "misc_teleporter" "team" "a" }`,
        `{ "classname" "func_clock" "target" "x" "spawnflags" "2" "team" "a" }`,
        `{ "classname" "trigger_gravity" "team" "a" }`,
      ]) {
        expect(team(freed)).toEqual([10, 0]);
      }
      // Kept: a func_wall leads, and turns the team.
      expect(team(`{ "classname" "func_wall" "model" "*1" "team" "a" }`)).toEqual([80, 90, 80]);
      // A train skips a freed monster with its corner's targetname.
      expect(place(`
        { "classname" "func_train" "model" "*1" "target" "c" }
        { "classname" "monster_tank_commander" "targetname" "c" "origin" "1 1 1" }
        { "classname" "path_corner" "targetname" "c" "origin" "100 200 300" }
      `).map((b) => b.origin)).toEqual([[100 + 385, 200 - 127, 300 + 1]]);
    });
  });
});

describe("player spawn spot", () => {
  const at = (src: string) => playerSpawnSpot(parseEntities(src))?.origin;
  const spot = (src: string) => at(`{ "classname" "worldspawn" }` + src);
  const start = (origin: string, extra = "") => `{ "classname" "info_player_start" "origin" "${origin}" ${extra} }`;
  const dm = (origin: string, extra = "") => `{ "classname" "info_player_deathmatch" "origin" "${origin}" ${extra} }`;

  it("takes the first deathmatch spot over any player start", () => {
    expect(spot(start("0 0 0") + dm("1 0 0") + dm("2 0 0"))).toBe("1 0 0");
    expect(spot(`{ "classname" "Info_Player_Deathmatch" "origin" "3 0 0" }` + dm("1 0 0"))).toBe("3 0 0"); // G_Find: Q_stricmp
  });

  it("skips spots the game frees in deathmatch", () => {
    expect(spot(dm("1 0 0", `"spawnflags" "2048"`) + dm("2 0 0"))).toBe("2 0 0");
    expect(spot(dm("1 0 0", `"spawnflags" "2048"`) + start("0 0 0"))).toBe("0 0 0");
    expect(at(dm("9 9 9") + dm("1 0 0"))).toBe("1 0 0"); // edict 0 is in use only as worldspawn
  });

  it("falls back to the first player start without a targetname, then the first", () => {
    expect(spot(start("1 0 0", `"targetname" "a"`) + start("2 0 0"))).toBe("2 0 0");
    expect(spot(start("1 0 0", `"targetname" ""`) + start("2 0 0"))).toBe("2 0 0"); // an empty value is still set
    expect(spot(start("1 0 0", `"targetname" "a"`) + start("2 0 0", `"targetname" "b"`))).toBe("1 0 0");
    expect(spot(`{ "classname" "info_player_coop" "origin" "1 0 0" }`)).toBeUndefined();
  });

  it("gives the fixture's first deathmatch spot, facing its yaw", () => {
    const s = playerSpawnSpot(parseEntities(bsp.entityString))!;
    expect([s.classname, s.origin, entityAngles(s)]).toEqual(["info_player_deathmatch", "-448 -192 24", [0, 45, 0]]);
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

    it("a delay due by the second frame's level.time + 0.001, in float, fires in it from a slot after the one running", () => {
      const chain = (delay: string) =>
        open(`{ "classname" "trigger_always" "target" "d" }
          { "classname" "func_door" "targetname" "d" "target" "e" "delay" "${delay}" }
          { "classname" "func_door" "targetname" "e" "target" "q" }`);
      expect(chain("0.0005")).toEqual([3]);
      expect(chain("0.0009")).toEqual([3]);
      // 0.2f + 0.001f rounds to just above the bound.
      expect(chain("0.001")).toEqual([]);
      expect(chain("-0.1")).toEqual([3]);
      expect(chain("-0.19999")).toEqual([3]);
      // SV_RunThink never runs a nextthink at or below 0.
      expect(chain("-0.2")).toEqual([]);
      expect(chain("-1")).toEqual([]);
      const relay = `{ "classname" "trigger_relay" "targetname" "r" "target" "q" "delay" "0.0005" }`;
      expect(open(`{ "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([3]);
      const train = (delay: string) => `{ "classname" "func_train" "target" "a" }
        { "classname" "path_corner" "targetname" "a" "target" "b" "origin" "1 2 3" }
        { "classname" "path_corner" "targetname" "b" "pathtarget" "q" "origin" "1 2 3" "delay" "${delay}" }`;
      expect(open(train("0.0005"))).toEqual([3]);
      expect(open(train("0.001"))).toEqual([]);
    });

    describe("trigger_once, trigger_multiple and trigger_counter pass a use on (multi_trigger)", () => {
      const always = (target: string, n = 1) => `{ "classname" "trigger_always" "target" "${target}" } `.repeat(n);

      it("fire their targets once: a nextthink set makes later uses return", () => {
        const once = `{ "classname" "trigger_once" "targetname" "o" "target" "q" }`;
        expect(open(always("o") + once)).toEqual([3]);
        expect(open(always("o", 2) + once)).toEqual([3]);
        // A trigger_relay passes every use on, toggling the portal back.
        expect(open(always("o", 2) + `{ "classname" "trigger_relay" "targetname" "o" "target" "q" }`)).toEqual([]);
        const multi = (wait: string) => `{ "classname" "trigger_multiple" "targetname" "o" "target" "q" ${wait} }`;
        expect(open(always("o", 2) + multi(""))).toEqual([3]);
        expect(open(always("o", 2) + multi(`"wait" "-1"`))).toEqual([3]);
        expect(open(always("o", 2) + multi(`"wait" "x"`))).toEqual([3]);
      });

      it("a wait due in the second frame thinks multi_wait in the trigger's slot, if it lies ahead of the use", () => {
        const multi = (wait: string) => `{ "classname" "trigger_multiple" "targetname" "m" "target" "q" "wait" "${wait}" }`;
        // The first DelayedUse fires it; multi_wait zeroes its nextthink; the second fires it again.
        expect(open(always("m") + multi("0.0005") + always("m"))).toEqual([]);
        // 0.2f + 0.001f rounds to just above the bound.
        expect(open(always("m") + multi("0.001") + always("m"))).toEqual([3]);
        // level.time + wait is stored as a float: in double this one would be due.
        expect(open(always("m") + multi("0.000999995") + always("m"))).toEqual([3]);
        // A PUSH or STOP master runs its team's thinks in its own slot, ahead of the trigger's.
        const team = (master: string) =>
          open(always("m") + `{ "classname" "${master}" "team" "x" }` + always("m") +
            `{ "classname" "trigger_multiple" "team" "x" "targetname" "m" "target" "q" "wait" "0.0005" }`);
        expect(team("func_door")).toEqual([]);
        expect(team("trigger_relay")).toEqual([3]);
        // A member a killtarget freed ends the teamchain (G_FreeEdict clears its teamchain).
        expect(
          open(`{ "classname" "trigger_always" "target" "m" "killtarget" "k" } { "classname" "func_door" "team" "x" }
            { "classname" "func_wall" "model" "*1" "team" "x" "targetname" "k" }` + always("m") +
            `{ "classname" "trigger_multiple" "team" "x" "targetname" "m" "target" "q" "wait" "0.0005" }`),
        ).toEqual([3]);
        // With no positive wait it thinks G_FreeEdict a frame later: never in this one.
        expect(open(always("m") + multi("-1") + always("m"))).toEqual([3]);
        expect(open(always("m") + `{ "classname" "trigger_once" "targetname" "m" "target" "q" }` + always("m"))).toEqual([3]);
        // trigger_once and trigger_counter set wait -1 whatever the key says.
        expect(open(always("m") + `{ "classname" "trigger_once" "targetname" "m" "target" "q" "wait" "0.0005" }` + always("m"))).toEqual([3]);
        expect(open(always("m") + `{ "classname" "trigger_counter" "targetname" "m" "target" "q" "count" "1" "wait" "0.0005" }` + always("m"))).toEqual([3]);
        // The walk has passed the trigger's slot when the first use sets its wait.
        expect(open(multi("0.0005") + always("m", 2))).toEqual([3]);
      });

      it("a TRIGGERED one takes its first use to arm (trigger_enable)", () => {
        const trig = (classname: string, flags: string) => `{ "classname" "${classname}" "targetname" "t" "target" "q" "spawnflags" "${flags}" }`;
        expect(open(always("t") + trig("trigger_multiple", "4"))).toEqual([]);
        expect(open(always("t", 2) + trig("trigger_multiple", "4"))).toEqual([3]);
        expect(open(always("t") + trig("trigger_multiple", "1"))).toEqual([3]);
        // SP_trigger_once moves spawnflags 1 to TRIGGERED.
        expect(open(always("t") + trig("trigger_once", "1"))).toEqual([]);
        expect(open(always("t", 2) + trig("trigger_once", "1"))).toEqual([3]);
        expect(open(always("t", 3) + trig("trigger_once", "4"))).toEqual([3]);
      });

      it("a trigger_counter fires once its count (default 2) runs down, then never again", () => {
        const counter = (count: string) => `{ "classname" "trigger_counter" "targetname" "c" "target" "q" ${count} }`;
        expect(open(always("c") + counter(""))).toEqual([]);
        expect(open(always("c", 2) + counter(""))).toEqual([3]);
        expect(open(always("c", 3) + counter(""))).toEqual([3]);
        expect(open(always("c", 2) + counter(`"count" "3"`))).toEqual([]);
        expect(open(always("c", 3) + counter(`"count" "3"`))).toEqual([3]);
        expect(open(always("c") + counter(`"count" "1"`))).toEqual([3]);
        // A negative count only counts further down.
        expect(open(always("c", 3) + counter(`"count" "-1"`))).toEqual([]);
      });

      it("their own delay fires through a DelayedUse, and a freed one is not found", () => {
        expect(open(always("o") + `{ "classname" "trigger_once" "targetname" "o" "target" "q" "delay" "0.0005" }`)).toEqual([3]);
        expect(open(always("o") + `{ "classname" "trigger_once" "targetname" "o" "target" "q" "delay" "0.001" }`)).toEqual([]);
        // The trigger_once frees itself with its killtarget before using its targets.
        expect(open(always("o") + `{ "classname" "trigger_once" "targetname" "o" "target" "q" "killtarget" "o" }`)).toEqual([]);
        expect(open(`{ "classname" "trigger_always" "killtarget" "o" } ` + always("o") + `{ "classname" "trigger_once" "targetname" "o" "target" "q" }`)).toEqual([]);
      });
    });

    describe("func_timer and target_explosion fire targets from their own think", () => {
      const always = (target: string, n = 1) => `{ "classname" "trigger_always" "target" "${target}" } `.repeat(n);
      const timer = (keys = "") => `{ "classname" "func_timer" "targetname" "t" "target" "q" ${keys} }`;

      it("a used func_timer thinks at once without a delay, and a second use turns it off", () => {
        expect(open(always("t") + timer())).toEqual([3]);
        expect(open(always("t", 2) + timer())).toEqual([3]);
        // A wait due in this frame thinks again in the timer's slot, if it lies ahead.
        expect(open(always("t") + timer(`"wait" "0.0005"`))).toEqual([]);
        expect(open(timer(`"wait" "0.0005"`) + always("t"))).toEqual([3]);
        expect(open(always("t") + timer(`"wait" "0.001"`))).toEqual([3]);
      });

      it("a used func_timer with a delay thinks at level.time + delay, firing through a DelayedUse", () => {
        // A START_ON timer due in this frame uses the second in its slot; no slot is free
        // yet, so the second's DelayedUse lands after every slot.
        const chain = (delay: string) =>
          open(`{ "classname" "func_timer" "target" "t" "spawnflags" "1" "pausetime" "-1.8" } ` + timer(`"delay" "${delay}"`));
        expect(chain("0.0005")).toEqual([3]);
        expect(chain("0.001")).toEqual([]);
        // After a trigger_always's DelayedUse ran, its DelayedUse lands in that freed slot,
        // which the walk has passed.
        expect(open(always("t") + timer(`"delay" "-0.1"`))).toEqual([]);
      });

      it("a START_ON func_timer thinks at 1 + pausetime + delay + wait, in float", () => {
        expect(open(timer(`"spawnflags" "1"`))).toEqual([]);
        // 1 + -1.8f + 1 rounds to just above 0.2f, still within level.time + 0.001.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8"`))).toEqual([3]);
        expect(open(timer(`"pausetime" "-1.8"`))).toEqual([]);
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.79"`))).toEqual([]);
        // pausetime is a float: with -1.799 in double the sum would round past the bound.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.799"`))).toEqual([3]);
        expect(open(timer(`"spawnflags" "1" "delay" "-0.8"`))).toEqual([]);
        expect(open(timer(`"spawnflags" "1" "delay" "-0.8" "pausetime" "-1"`))).toEqual([]);
        // Due by 0.2 with its delay; its DelayedUse lands after every slot and fires too.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8005" "delay" "0.0005"`))).toEqual([3]);
        // A random below wait counts as 0 (crandom() taken as its mean); one at or above
        // wait, even infinite, is lowered to wait - FRAMETIME.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8" "random" "0.5"`))).toEqual([3]);
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8" "random" "1e999"`))).toEqual([3]);
        // One still infinite gives an infinite nextthink, which never runs.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8" "random" "-1e999"`))).toEqual([]);
        expect(open(always("t") + timer(`"random" "-1e999"`))).toEqual([3]);
        // A nextthink at or below 0 never runs.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-2"`))).toEqual([]);
        // Due in the first frame: its think fires nothing there (not modeled) and thinks
        // again at 0.1 + wait, due in the second.
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1" "wait" "0.05"`))).toEqual([3]);
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.9"`))).toEqual([]);
        // A use before its slot turns it off.
        expect(open(always("t") + timer(`"spawnflags" "1" "pausetime" "-1.8"`))).toEqual([]);
        expect(open(timer(`"spawnflags" "1" "pausetime" "-1.8"`) + always("t"))).toEqual([3]);
      });

      it("a PUSH or STOP master runs a member's think in its slot, then the member's own slot runs it again if due", () => {
        const team = (master: string) =>
          open(always("t") + `{ "classname" "${master}" "team" "x" }` + timer(`"team" "x" "wait" "0.0005"`));
        expect(team("func_door")).toEqual([3]);
        expect(team("trigger_relay")).toEqual([]);
        // A think that frees its own entity ends the teamchain there.
        const chain = (kill: string) =>
          open(always("e") + always("t") + `{ "classname" "func_door" "team" "x" }
            { "classname" "target_explosion" "team" "x" "targetname" "e" ${kill} "delay" "0.0005" }` +
            timer(`"team" "x" "wait" "0.0005"`));
        expect(chain(`"killtarget" "e"`)).toEqual([]);
        expect(chain("")).toEqual([3]);
      });

      it("a used target_explosion fires its targets at once, or in its slot when its delay comes due", () => {
        const explosion = (keys = "") => `{ "classname" "target_explosion" "targetname" "e" "target" "q" ${keys} }`;
        expect(open(always("e") + explosion())).toEqual([3]);
        expect(open(always("e", 2) + explosion())).toEqual([]);
        // Its delay is cleared while it fires: no DelayedUse.
        expect(open(always("e") + explosion(`"delay" "0.0005"`))).toEqual([3]);
        expect(open(explosion(`"delay" "0.0005"`) + always("e"))).toEqual([]);
        expect(open(always("e") + explosion(`"delay" "0.001"`))).toEqual([]);
        // A later use only sets its nextthink again: it fires once.
        expect(open(always("e", 2) + explosion(`"delay" "0.0005"`))).toEqual([3]);
        expect(open(always("e") + explosion(`"delay" "-0.1"`))).toEqual([3]);
        expect(open(always("e") + explosion(`"delay" "-0.2"`))).toEqual([]);
        // Its delay stays cleared while it fires: a use reaching it then explodes it again at once.
        expect(
          open(always("e") + `{ "classname" "target_explosion" "targetname" "e" "target" "c" "delay" "0.0005" }
            { "classname" "trigger_counter" "targetname" "c" "target" "e" "count" "1" }
            { "classname" "trigger_relay" "targetname" "c" "target" "q" }`),
        ).toEqual([]);
        // A nested explode restores the 0 it saved: a use after it, still within the outer
        // one, explodes it once more.
        expect(
          open(always("e") + `{ "classname" "target_explosion" "targetname" "e" "target" "c" "delay" "0.0005" }
            { "classname" "trigger_counter" "targetname" "c" "target" "e" "count" "1" }
            { "classname" "trigger_relay" "targetname" "c" "target" "q" }
            { "classname" "trigger_counter" "targetname" "c" "target" "e" "count" "2" }`),
        ).toEqual([3]);
      });
    });

    it("G_Spawn puts a DelayedUse in the first free slot, and one before the edict running waits a frame", () => {
      const relay = `{ "classname" "trigger_relay" "targetname" "r" "target" "q" "delay" "0.0005" }`;
      // The first trigger_always's DelayedUse frees its slot after firing; the relay's lands there.
      expect(open(`{ "classname" "trigger_always" "target" "x" } { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([]);
      // One not yet due keeps its slot.
      expect(open(`{ "classname" "trigger_always" "target" "x" "delay" "0.3" } { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([3]);
      // A killtarget frees a slot before the relay's use: before the trigger, or after it.
      const wall = `{ "classname" "func_wall" "model" "*1" "targetname" "k" }`;
      expect(open(`${wall} { "classname" "trigger_always" "target" "r" "killtarget" "k" } ${relay}`)).toEqual([]);
      expect(open(`{ "classname" "trigger_always" "target" "r" "killtarget" "k" } ${wall} ${relay}`)).toEqual([3]);
      // turret_breach_finish_init frees the breach's target in the first frame.
      const turret = `{ "classname" "info_notnull" "targetname" "m" }
        { "classname" "turret_breach" "model" "*1" "team" "tt" "target" "m" }
        { "classname" "turret_base" "model" "*1" "team" "tt" }`;
      expect(open(`${turret} { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([]);
      expect(open(`{ "classname" "trigger_always" "target" "r" } ${turret} ${relay}`)).toEqual([3]);
      // A door after the breach G_Spawns its trigger into that slot in the first frame.
      const door = `{ "classname" "func_door" "model" "*1" }`;
      expect(open(`${turret} ${door} { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([3]);
      expect(open(`${door} ${turret} { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([]);
      // A door with a targetname or health, or a team slave, spawns no trigger.
      for (const keys of [`"targetname" "n"`, `"health" "5"`, `"team" "dt"`]) {
        const other = `{ "classname" "func_door" "model" "*1" "team" "dt" }`;
        expect(open(`${other} ${turret} { "classname" "func_door" "model" "*1" ${keys} } { "classname" "trigger_always" "target" "r" } ${relay}`)).toEqual([]);
      }
      // A breach freeing a later member of its team ends the teamchain: the next breach does not run.
      expect(
        open(`{ "classname" "turret_breach" "model" "*1" "team" "tt" "target" "b" }
          { "classname" "turret_breach" "model" "*1" "team" "tt" "targetname" "b" "target" "q" }
          { "classname" "trigger_always" "target" "q" }`),
      ).toEqual([3]);
      // A master freed earlier in the frame runs no team.
      expect(
        open(`{ "classname" "turret_breach" "model" "*1" "team" "t1" "target" "w" }
          { "classname" "func_wall" "model" "*1" "team" "t2" "targetname" "w" }
          { "classname" "turret_breach" "model" "*1" "team" "t2" "target" "q" }
          { "classname" "trigger_always" "target" "q" }`),
      ).toEqual([3]);
      // A START_OPEN door before the breach opens the portal before the breach frees it.
      const breachQ = `{ "classname" "turret_breach" "model" "*1" "team" "tt" "target" "q" } { "classname" "turret_base" "model" "*1" "team" "tt" }`;
      const openDoor = `{ "classname" "func_door" "model" "*1" "target" "q" "spawnflags" "1" }`;
      expect(open(`${openDoor} ${breachQ}`)).toEqual([3]);
      expect(open(`${breachQ} ${openDoor}`)).toEqual([]);
      // A used target_crosslevel_trigger frees itself.
      const cross = `{ "classname" "target_crosslevel_trigger" "targetname" "c" }`;
      expect(open(`${cross} { "classname" "trigger_always" "target" "c" } ${relay.replace('"r"', '"c"')}`)).toEqual([]);
      expect(open(`{ "classname" "trigger_always" "target" "c" } ${cross} ${relay.replace('"r"', '"c"')}`)).toEqual([3]);
      // G_FreeEdict refuses worldspawn.
      const worldCross = parseEntities(`{ "classname" "target_crosslevel_trigger" "targetname" "c" }
        { "classname" "func_areaportal" "targetname" "q" "style" "3" }
        { "classname" "trigger_always" "target" "c" } ${relay.replace('"r"', '"c"')}`);
      expect([...openAreaPortals(worldCross)]).toEqual([3]);
    });

    it("ends a pusher master's second-frame walk at an item, whose droptofloor cuts the teamchain", () => {
      // The timer after the item thinks in its own slot, after the trigger_always fired the
      // relay; ahead of the item, it frees the relay in the door's slot first.
      const timer = `{ "classname" "func_timer" "team" "d" "spawnflags" "1" "pausetime" "-1.8" "killtarget" "r" }`;
      const fire = `{ "classname" "trigger_always" "target" "r" } { "classname" "trigger_relay" "targetname" "r" "target" "q" }`;
      const door = `{ "classname" "func_door" "model" "*1" "team" "d" "targetname" "dd" }`;
      expect(open(`${door} { "classname" "item_health" "team" "d" } ${fire} ${timer}`)).toEqual([3]);
      expect(open(`${door} { "classname" "info_notnull" "team" "d" } ${fire} ${timer}`)).toEqual([]);
    });

    it("ends a chain of tiny delays that spawns faster than it frees (ED_Alloc errors in the game)", () => {
      const relay = `{ "classname" "trigger_relay" "targetname" "r" "target" "r" "delay" "0.0005" }`;
      expect(open(`{ "classname" "trigger_always" "target" "r" } ${relay} ${relay}`)).toEqual([]);
      // The DelayedUses it spawns share one use budget: each here sets off a branching relay loop.
      const loop = `{ "classname" "trigger_relay" "targetname" "x" "target" "x" }`;
      const start = performance.now();
      open(`{ "classname" "trigger_always" "target" "t" }
        { "classname" "trigger_relay" "targetname" "t" "target" "t" "delay" "0.0005" }
        { "classname" "trigger_relay" "targetname" "t" "target" "t" "delay" "0.0005" }
        { "classname" "trigger_relay" "targetname" "t" "target" "x" } ${loop} ${loop} ${loop}`);
      expect(performance.now() - start).toBeLessThan(3000);
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
