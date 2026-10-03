// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBsp, parseEntities } from "@quack2/sim";
import { describe, expect, it } from "vitest";
import { brushModelInstances, visibleAtSpawn } from "../src/bmodels.js";

const bsp = parseBsp(new Uint8Array(readFileSync(fileURLToPath(new URL("../../../fixtures/maps/test_arena.bsp", import.meta.url)))));

describe("brush model instances", () => {
  it("places the fixture's func_wall (model 1) at the origin, nothing else", () => {
    expect(brushModelInstances(bsp, parseEntities(bsp.entityString))).toEqual({
      instances: [{ model: 1, origin: [0, 0, 0], classname: "func_wall" }],
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
      instances: [{ model: 1, origin: [16, -32, 8], classname: "func_door" }],
      errors: [],
    });
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
});
