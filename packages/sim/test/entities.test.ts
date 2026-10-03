// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";
import { EntityParseError, entityVec3, parseBsp, parseEntities } from "../src/index.js";
import { loadFixtureBytes } from "./fixture.js";

describe("test_arena.bsp entities", () => {
  const bsp = parseBsp(loadFixtureBytes("test_arena.bsp"));
  const ents = parseEntities(bsp.entityString);

  it("parses every entity with worldspawn first", () => {
    expect(ents.map((e) => e.classname)).toEqual([
      "worldspawn",
      "func_wall",
      "info_player_start",
      "info_player_deathmatch",
      "info_player_deathmatch",
      "info_player_deathmatch",
      "info_player_deathmatch",
      "weapon_shotgun",
      "light",
      "light",
    ]);
    expect(ents[0]!.message).toBe("Quack2 test arena");
  });

  it("has four info_player_deathmatch spawns at the map's origins", () => {
    const spawns = ents.filter((e) => e.classname === "info_player_deathmatch");
    expect(spawns).toHaveLength(4);
    expect(spawns.map((e) => entityVec3(e, "origin"))).toEqual([
      [-448, -192, 24],
      [-448, 192, 24],
      [448, -192, 24],
      [448, 192, 24],
    ]);
    expect(spawns.map((e) => e.angle)).toEqual(["45", "315", "135", "225"]);
  });

  it("links the func_wall to inline model *1", () => {
    const wall = ents.find((e) => e.classname === "func_wall")!;
    expect(wall.model).toBe("*1");
    expect(bsp.models.count).toBe(2);
  });
});

describe("parseEntities", () => {
  it("handles comments, bare words, empty values and spaces in values", () => {
    const src = `// header comment
{
"classname" "worldspawn" // trailing comment
"message" "two words"
"_empty" ""
}
{ classname light origin "1 2 3" }`;
    const ents = parseEntities(src);
    expect(ents).toHaveLength(2);
    expect({ ...ents[0] }).toEqual({ classname: "worldspawn", message: "two words", _empty: "" });
    expect(entityVec3(ents[1]!, "origin")).toEqual([1, 2, 3]);
  });

  it("returns no entities for an empty string", () => {
    expect(parseEntities("")).toEqual([]);
    expect(parseEntities(" \n\t")).toEqual([]);
  });

  it("keeps a __proto__ key as data", () => {
    const [ent] = parseEntities('{ "__proto__" "x" "classname" "info_null" }');
    expect(Object.keys(ent!)).toEqual(["__proto__", "classname"]);
    expect(Object.getPrototypeOf(ent)).toBeNull();
  });

  it("later duplicate keys win", () => {
    expect(parseEntities('{ "a" "1" "a" "2" }')[0]!.a).toBe("2");
  });

  it.each([
    ['"classname" "x"', /expected "\{" at line 1/],
    ['{ "classname" "x"', /unexpected end of entity string/],
    ['{ "classname" }', /key "classname" has no value/],
    ['{ "classname" "x', /unterminated quoted string at line 1/],
    ['{ "a" "b" { }', /unexpected "\{"/],
  ])("rejects %j", (src, msg) => {
    expect(() => parseEntities(src)).toThrow(EntityParseError);
    expect(() => parseEntities(src)).toThrow(msg);
  });

  it("entityVec3 rejects malformed vectors", () => {
    expect(entityVec3({ origin: "1 2" }, "origin")).toBeUndefined();
    expect(entityVec3({ origin: "1 2 x" }, "origin")).toBeUndefined();
    expect(entityVec3({}, "origin")).toBeUndefined();
  });
});
