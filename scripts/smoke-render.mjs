#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Headless render smoke test: builds the client, loads the test arena in Chromium
// (WebGL2 through ANGLE/SwiftShader worked without flags, measured 2026-10-03 with
// Chromium 141; the run prints the renderer it got), checks three views by reading back
// pixels, and saves a screenshot of each. It checks the fixture's func_wall is drawn,
// and drawn at a moved entity origin, and rotated, in copies of the map, and that culled
// brush models leave the frame unchanged. Another load mounts synthetic
// game data (a pak and a deflated zip built here, never id data) and checks the textures
// arrive, and that ?map= finds a BSP packed into a mounted pak. A copy of the map with
// every face on an animated light style checks lightmaps are uploaded as styles change.
// Copies with surface flags set check warps move with level time and draw unlit, that
// SURF_FLOWING scrolls unwarped opaque faces (still lit) but not unwarped translucent
// ones, and translucent faces blend with what is behind them at their alpha. A copy
// whose walls and ceiling are sky checks the sky box: r_notexture without data, each
// side's synthetic image in its direction and orientation with it, and skyrotate. A copy
// split into two areas by an area portal checks that a closed portal hides the world and
// brush models beyond it, and that a START_OPEN door that targets it opens it. A copy
// whose func_wall is a door a trigger_always sends up checks the debug origins move, and
// one whose func_wall is a START_ON func_rotating checks it is drawn turning.
// Usage: node scripts/smoke-render.mjs [outdir]   (default packages/client/dist/smoke)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { syntheticPalette, withEntityString, withLump, writePak, writePalettePcx, writeTga, writeWal, writeZip } from "./synthetic-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages/client/dist");
const outDir = resolve(process.argv[2] ?? join(dist, "smoke"));
const ORIGIN = "http://quack.test";
// Synthetic game data, served from memory: the floor is solid pure red (index 1) from
// the pak, the walls solid blue (index 2) from the zip, the trim absent.
const palette = syntheticPalette();
palette.set([255, 0, 0], 3);
palette.set([0, 0, 255], 6);
const SYNTHETIC = {
  "/data/synthetic.pak": writePak({
    "pics/colormap.pcx": writePalettePcx(palette),
    "textures/quack/floor.wal": writeWal("quack/floor", 64, 64, () => 1),
  }),
  "/data/synthetic.zip": writeZip({ "textures/quack/wall.wal": writeWal("quack/wall", 32, 64, () => 2) }),
};
// The fixture with its func_wall given "origin" "0 -320 0": compiled at y 128..192, it
// must draw at y -192..-128, the mirror-image spot in the y-symmetric arena.
const fixtureBsp = readFileSync(join(root, "fixtures/maps/test_arena.bsp"));
const fixtureEntities = fixtureBsp
  .subarray(fixtureBsp.readInt32LE(8), fixtureBsp.readInt32LE(8) + fixtureBsp.readInt32LE(12))
  .toString("latin1")
  .replace(/\0+$/, "");
const movedEntities = fixtureEntities.replace('"model" "*1"', '"model" "*1"\n"origin" "0 -320 0"');
if (movedEntities === fixtureEntities) throw new Error("fixture has no func_wall \"model\" \"*1\" to move");
SYNTHETIC["/data/moved.bsp"] = withEntityString(fixtureBsp, movedEntities);
// Rotated: yaw 90 about the model-space origin turns x -384..-320, y 128..192 into
// x -192..-128, y -384..-320, and the origin lifts it to y -192..-128. Yaw -90 (a sign
// error) would put it outside the map.
SYNTHETIC["/data/rotated.bsp"] = withEntityString(
  fixtureBsp,
  fixtureEntities.replace('"model" "*1"', '"model" "*1"\n"origin" "0 192 0"\n"angle" "90"'),
);
// Door: the func_wall made a func_door moving up (50 - lip 8 = 42 at speed 200) that a
// trigger_always sends up in the second settle frame.
const doorEntities = fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_door"\n"targetname" "smokedoor"\n"angle" "-1"');
if (doorEntities === fixtureEntities) throw new Error("fixture has no func_wall to make a door");
SYNTHETIC["/data/door.bsp"] = withEntityString(fixtureBsp, `${doorEntities}{\n"classname" "trigger_always"\n"target" "smokedoor"\n}\n`);
// The func_wall placed where the door is drawn at 150 ms and at 400 ms.
for (const z of [10, 42]) {
  SYNTHETIC[`/data/door-at-${z}.bsp`] = withEntityString(fixtureBsp, fixtureEntities.replace('"model" "*1"', `"model" "*1"\n"origin" "0 0 ${z}"`));
}
// Plat: the func_wall made a func_plat (50 - lip 8 = 42 down, per-frame speed 20,
// accel 5, decel 5) that a trigger_always sends down in the second settle frame, and
// the func_wall placed where it is drawn at 250 ms and at 450 ms.
const platEntities = fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_plat"\n"targetname" "smokeplat"');
SYNTHETIC["/data/plat.bsp"] = withEntityString(fixtureBsp, `${platEntities}{\n"classname" "trigger_always"\n"target" "smokeplat"\n}\n`);
for (const z of [-10, -31.5]) {
  SYNTHETIC[`/data/plat-at-${z}.bsp`] = withEntityString(fixtureBsp, fixtureEntities.replace('"model" "*1"', `"model" "*1"\n"origin" "0 0 ${z}"`));
}
// Button: the func_wall made a func_button moving up (50 - lip 4 = 46 at 40 a second)
// that a trigger_always fires in the second settle frame, and the func_wall placed where
// it is drawn at 250 ms and at 1300 ms.
const buttonEntities = fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_button"\n"targetname" "smokebutton"\n"angle" "-1"');
SYNTHETIC["/data/button.bsp"] = withEntityString(fixtureBsp, `${buttonEntities}{\n"classname" "trigger_always"\n"target" "smokebutton"\n}\n`);
for (const z of [6, 46]) {
  SYNTHETIC[`/data/button-at-${z}.bsp`] = withEntityString(fixtureBsp, fixtureEntities.replace('"model" "*1"', `"model" "*1"\n"origin" "0 0 ${z}"`));
}
// Train: the func_wall made a func_train (speed 100) whose mins (-385 127 -1) start on
// c1, so at 0 0 0; it goes up 40 to c2, jumps back through the TELEPORT corner t3 and
// stops 10 up at c4. The func_wall placed where it is drawn at 250 ms.
const trainEntities = fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_train"\n"target" "smokec1"');
const trainCorners = [
  ["smokec1", "-385 127 -1", '"target" "smokec2"'],
  ["smokec2", "-385 127 39", '"target" "smoket3"'],
  ["smoket3", "-385 127 -1", '"target" "smokec4"\n"spawnflags" "1"'],
  ["smokec4", "-385 127 9", '"wait" "-1"'],
].map(([name, origin, rest]) => `{\n"classname" "path_corner"\n"targetname" "${name}"\n"origin" "${origin}"\n${rest}\n}\n`);
SYNTHETIC["/data/train.bsp"] = withEntityString(fixtureBsp, trainEntities + trainCorners.join(""));
SYNTHETIC["/data/train-at-25.bsp"] = withEntityString(fixtureBsp, fixtureEntities.replace('"model" "*1"', '"model" "*1"\n"origin" "0 0 25"'));
// Rotating door: the func_wall made a func_door_rotating (90 degrees of yaw at 100 a
// second about the world origin) that a trigger_always sends round in the second settle
// frame. The func_wall placed at the angles it is drawn with at 150 ms and at 250 ms.
const rotatingEntities = fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_door_rotating"\n"targetname" "smokedoor"');
SYNTHETIC["/data/door-rotating.bsp"] = withEntityString(fixtureBsp, `${rotatingEntities}{\n"classname" "trigger_always"\n"target" "smokedoor"\n}\n`);
// func_rotating: the func_wall made a START_ON func_rotating (yaw at 100 a second) from
// yaw -30, turned 20 degrees by the settle frames and on 10 a frame after, sent in
// 360/256 degree steps; it swings about the world origin, so from -30 it stays in the
// door view. The func_wall placed at the angles it is drawn with at 0, 150 and 250 ms.
SYNTHETIC["/data/rotating.bsp"] = withEntityString(
  fixtureBsp,
  fixtureEntities.replace('"classname" "func_wall"', '"classname" "func_rotating"\n"spawnflags" "1"\n"angles" "0 -30 0"'),
);
for (const yaw of ["4.921875", "14.765625", "-9.84375"]) {
  SYNTHETIC[`/data/door-yaw-${yaw}.bsp`] = withEntityString(fixtureBsp, fixtureEntities.replace('"model" "*1"', `"model" "*1"\n"angles" "0 ${yaw} 0"`));
}
// Culling: the func_wall at its compiled spot, again at the south spot, and again outside
// the map, where its box touches only solid leafs (no PVS cluster, and area 0, which
// the server's area test drops before the PVS one is reached).
SYNTHETIC["/data/culled.bsp"] = withEntityString(
  fixtureBsp,
  `${fixtureEntities}{\n"classname" "func_wall"\n"model" "*1"\n"origin" "0 -320 0"\n}\n{\n"classname" "func_wall"\n"model" "*1"\n"origin" "2000 0 0"\n}\n`,
);
// Every face's single lightmap on style 2 (the slow pulse: 'a' at 0 ms, 'm' at 1200 ms,
// 'z' at 2500 ms). Lump 6 is faces, 20 bytes each, styles at byte 12; every fixture face
// has a lightmap.
const FIXTURE_FACES = fixtureBsp.readInt32LE(12 + 6 * 8) / 20;
{
  const styled = Uint8Array.from(fixtureBsp);
  const ofs = fixtureBsp.readInt32LE(8 + 6 * 8);
  for (let f = 0; f < FIXTURE_FACES; f++) styled[ofs + f * 20 + 12] = 2;
  SYNTHETIC["/data/styled.bsp"] = styled;
}
/** A copy of `bsp` with `flags` set on every texinfo (lump 5, 76 bytes each, flags at 32, name at 40) of the named texture. */
const withTextureFlags = (bsp, texture, flags) => {
  const out = Uint8Array.from(bsp);
  const view = Buffer.from(out.buffer);
  const ofs = view.readInt32LE(8 + 5 * 8);
  let n = 0;
  for (let o = ofs; o < ofs + view.readInt32LE(12 + 5 * 8); o += 76) {
    if (view.toString("latin1", o + 40, o + 72).replace(/\0.*$/s, "") !== texture) continue;
    view.writeInt32LE(view.readInt32LE(o + 32) | flags, o + 32);
    n++;
  }
  if (n === 0) throw new Error(`fixture has no texinfo for ${texture}`);
  return out;
};
const SURF_WARP = 0x8, SURF_TRANS33 = 0x10, SURF_TRANS66 = 0x20;
SYNTHETIC["/data/warp.bsp"] = withTextureFlags(fixtureBsp, "quack/floor", SURF_WARP);
// Unwarped SURF_FLOWING: an opaque floor, and translucent trim (the func_wall's included).
const SURF_FLOWING = 0x40;
SYNTHETIC["/data/flowing.bsp"] = withTextureFlags(fixtureBsp, "quack/floor", SURF_FLOWING);
SYNTHETIC["/data/flowing-trans.bsp"] = withTextureFlags(fixtureBsp, "quack/trim", SURF_FLOWING | SURF_TRANS33);
// Every trim face translucent, the func_wall's included; the moved copies take the
// func_wall away from its compiled spot to show what is behind it there.
for (const [name, flags] of [["trans33", SURF_TRANS33], ["trans66", SURF_TRANS66]]) {
  SYNTHETIC[`/data/${name}.bsp`] = withTextureFlags(fixtureBsp, "quack/trim", flags);
  SYNTHETIC[`/data/${name}-moved.bsp`] = withTextureFlags(SYNTHETIC["/data/moved.bsp"], "quack/trim", flags);
}
// Walls and ceiling (quack/wall) are sky. "sky.bsp" uses the default unit1_ sky; the
// rotating copy turns it 90 degrees a second about +z.
const SURF_SKY = 0x4;
SYNTHETIC["/data/sky.bsp"] = withTextureFlags(fixtureBsp, "quack/wall", SURF_SKY);
SYNTHETIC["/data/sky-rotate.bsp"] = withEntityString(
  SYNTHETIC["/data/sky.bsp"],
  fixtureEntities.replace('"classname" "worldspawn"', '"classname" "worldspawn"\n"sky" "spin_"\n"skyrotate" "90"\n"skyaxis" "0 0 1"'),
);
// One solid colour per side, except rt (seen looking along +x), whose quadrants differ
// so its orientation shows: top left, top right, bottom left, bottom right.
const SKY_COLORS = { bk: [0, 255, 255], lf: [255, 0, 255], ft: [255, 128, 0], up: [128, 255, 128], dn: [64, 64, 64] };
const RT_QUADRANTS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
const skyImages = (name) => ({
  [`env/${name}rt.tga`]: writeTga(16, 16, (x, y) => RT_QUADRANTS[(y < 8 ? 0 : 2) + (x < 8 ? 0 : 1)], { rle: true }),
  ...Object.fromEntries(Object.entries(SKY_COLORS).map(([side, rgb]) => [`env/${name}${side}.tga`, writeTga(16, 16, () => rgb)])),
});
SYNTHETIC["/data/sky.pak"] = writePak({ ...skyImages("unit1_"), ...skyImages("spin_") });
if (!SYNTHETIC["/data/sky-rotate.bsp"]) throw new Error("no sky-rotate map");
// Two areas: leafs wholly east of the dividing wall (x 8 up) are area 2, the rest keep
// area 1, joined by area portal 1 (lumps 17 areas and 18 areaportals; leafs are lump 8,
// 28 bytes each, area at byte 6, mins x at 8). A func_wall stands in the east. The
// portal is closed in "areas.bsp"; in "areas-open.bsp" a START_OPEN door (outside the
// map, where nothing sees it) targets the func_areaportal and so opens it at spawn. In
// "areas-closing.bsp" a door there that a trigger_always sends up opens it, and closes
// it again when it is back down (42 up at 200, wait 3: home in game frame 39, which
// client times 3601 to 3700 draw towards).
{
  const split = Uint8Array.from(fixtureBsp);
  const view = Buffer.from(split.buffer);
  const ofs = view.readInt32LE(8 + 8 * 8);
  let east = 0;
  for (let o = ofs; o < ofs + view.readInt32LE(12 + 8 * 8); o += 28) {
    if (view.readInt16LE(o + 6) && view.readInt16LE(o + 8) >= 8) {
      view.writeInt16LE(2, o + 6);
      east++;
    }
  }
  if (east === 0) throw new Error("fixture has no leafs east of x 8");
  const ints = (...v) => new Uint8Array(Int32Array.from(v).buffer);
  const lumps = withLump(withLump(split, 17, ints(0, 0, 1, 0, 1, 1)), 18, ints(1, 2, 1, 1));
  const portal = `{\n"classname" "func_areaportal"\n"targetname" "p"\n"style" "1"\n}\n`;
  const eastWall = `{\n"classname" "func_wall"\n"model" "*1"\n"origin" "700 0 0"\n}\n`;
  const door = `{\n"classname" "func_door"\n"model" "*1"\n"origin" "2000 0 0"\n"target" "p"\n"spawnflags" "1"\n}\n`;
  SYNTHETIC["/data/areas.bsp"] = withEntityString(lumps, fixtureEntities + eastWall + portal);
  SYNTHETIC["/data/areas-open.bsp"] = withEntityString(lumps, fixtureEntities + eastWall + portal + door);
  const closing = `{\n"classname" "func_door"\n"model" "*1"\n"origin" "2000 0 0"\n"angle" "-1"\n"targetname" "dc"\n"target" "p"\n}\n{\n"classname" "trigger_always"\n"target" "dc"\n}\n`;
  SYNTHETIC["/data/areas-closing.bsp"] = withEntityString(lumps, fixtureEntities + eastWall + portal + closing);
}
// The moved map packed at a path the server does not have, so only the pak can supply it.
SYNTHETIC["/data/maps.pak"] = writePak({
  "maps/packed.bsp": SYNTHETIC["/data/moved.bsp"],
  "maps/truncated.bsp": SYNTHETIC["/data/moved.bsp"].subarray(0, 100),
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".bsp": "application/octet-stream" };

execFileSync(process.execPath, [join(root, "packages/client/build.mjs")], { stdio: "inherit" });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Chromium logs every failed fetch as a console error, and the client logs the error
  // it shows; the deliberate 404s below, and the map that is missing everywhere, are expected.
  const ABSENT_MAP_ERROR = "Could not load data/absent-map.bsp: not in data/maps.pak and HTTP 404";
  const TRUNCATED_MAP_ERROR = "Could not load maps/truncated.bsp from data/maps.pak: BSP too small: 100 bytes, header alone is 160";
  page.on(
    "console",
    (m) => m.type() === "error" && !m.location().url.includes("/data/absent-") && m.text() !== ABSENT_MAP_ERROR && m.text() !== TRUNCATED_MAP_ERROR && errors.push(m.text()),
  );
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    // Delayed so it finishes last: mount errors must still be reported in URL order.
    if (path === "/data/absent-1.pak") return void setTimeout(() => route.fulfill({ status: 404, body: "not found" }), 300);
    if (SYNTHETIC[path]) return route.fulfill({ body: Buffer.from(SYNTHETIC[path]), contentType: "application/octet-stream" });
    const file = join(dist, path === "/" ? "index.html" : path);
    try {
      route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    } catch {
      route.fulfill({ status: 404, body: "not found" });
    }
  });

  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const boot = await page.evaluate(() => ({
    error: window.quack.error,
    missing: window.quack.missingTextures,
    integrity: window.quack.integrityErrors,
    renderer: (() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
    })(),
  }));
  console.log(`browser ${browser.version()}, ${boot.renderer}`);
  check(!boot.error, `client booted${boot.error ? `: ${boot.error}` : ""}`);
  if (boot.error) throw new Error(boot.error);
  check(boot.integrity.length === 0, "fixture passes checkBspIntegrity in the browser");
  check(
    JSON.stringify([...boot.missing].sort()) === JSON.stringify(["quack/floor", "quack/trim", "quack/wall"]),
    `every fixture texture fell back to a checker: ${boot.missing.join(", ")}`,
  );

  /** Render a view, read pixels back, and summarize them in the page. */
  const shoot = async (name, view) => {
    const r = await page.evaluate((view) => {
      window.quack.setView(view);
      const { width, height, data } = window.quack.readPixels();
      let clear = 0, seeThrough = 0;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) seeThrough++;
        if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return { ...window.quack.stats, worldFaces: window.quack.worldFaces, clearFraction: clear / (width * height), colors: colors.size, seeThrough };
    }, view);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    console.log(`  ${name}: ${JSON.stringify(r)}`);
    return r;
  };

  // Player start (-448 0 24) + viewheight 22, facing east down the arena.
  const spawn = await shoot("spawn", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  check(spawn.cluster >= 0, "spawn view is inside a cluster");
  check(spawn.clearFraction === 0, "spawn view has no background pixels (closed room, no cracks)");
  check(spawn.colors > 100, "spawn view shows textured, lit surfaces (>100 distinct colors)");
  // R_RecursiveWorldNode's R_CullBox: the walk passes only faces in leafs inside the side
  // planes, so facing the west wall from the spawn passes far fewer than facing east.
  const west = await shoot("spawn-west", { origin: [-448, 0, 46], pitch: 0, yaw: 180 });
  check(
    spawn.drawnFaces > 0 && spawn.drawnFaces < spawn.visibleFaces && west.drawnFaces < spawn.drawnFaces && west.visibleFaces === spawn.visibleFaces,
    `the view frustum culls world faces (${spawn.drawnFaces} east, ${west.drawnFaces} west, of ${spawn.visibleFaces} in the PVS)`,
  );
  check(west.clearFraction === 0, "the west view has no background pixels");

  // Lightmaps reach the screen: the floor in the pillar's shadow is far darker than the
  // floor beside it (luxel RGB sums 21 vs 243, measured 2026-10-03). Averaging a box
  // spanning several checker cells keeps the 2:1 checker contrast from deciding this.
  /** Mean RGB of a 31x31 pixel box around each floor point, from the player start view. */
  const floorBoxes = (points) =>
    page.evaluate((points) => {
      window.quack.setView({ origin: [-448, 0, 46], pitch: 0, yaw: 0 });
      const { width, data } = window.quack.readPixels();
      return points.map(([wx, wy]) => {
        const p = window.quack.project(wx, wy, 0);
        if (!p) return [NaN, NaN, NaN];
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = Math.round(p[1]) - 15; y <= Math.round(p[1]) + 15; y++) {
          for (let x = Math.round(p[0]) - 15; x <= Math.round(p[0]) + 15; x++) {
            const i = (y * width + x) * 4;
            for (let c = 0; c < 3; c++) sum[c] += data[i + c];
            n++;
          }
        }
        return sum.map((v) => v / n);
      });
    }, points);
  const brightness = (rgb) => rgb[0] + rgb[1] + rgb[2];
  const [shadowRgb, litRgb] = await floorBoxes([[-312, 0], [-256, -112]]);
  const floor = { shadow: brightness(shadowRgb), lit: brightness(litRgb) };
  console.log(`  floor brightness: ${JSON.stringify(floor)}`);
  check(floor.lit > 4 * floor.shadow, "lightmap shadow shows on screen (lit floor > 4x shadowed floor)");

  // The player start is in cluster 6 (below the pillar tops, west of the pillar), whose
  // PVS excludes the clusters between the other pillars. The east half sees everything.
  check(spawn.visibleFaces < spawn.worldFaces, `PVS culls faces at the player start (${spawn.visibleFaces} of ${spawn.worldFaces})`);
  const east = await shoot("east", { origin: [300, -150, 46], pitch: 0, yaw: 180 });
  check(
    east.cluster >= 0 && east.cluster !== spawn.cluster && east.visibleFaces > spawn.visibleFaces,
    `a different cluster draws a different face set (${east.visibleFaces} faces in cluster ${east.cluster})`,
  );
  check(east.clearFraction === 0, "east view has no background pixels");

  // R_SetupFrame's second view cluster: from an empty leaf the eye looks 16 units down, so
  // just above the leaf split at z 128 west of the pillars cluster 3 is joined by 6.
  const split = await page.evaluate(() => {
    window.quack.setView({ origin: [-496, -16, 136], pitch: 0, yaw: 0 });
    window.quack.readPixels();
    return window.quack.stats;
  });
  check(
    split.cluster === 3 && split.cluster2 === 6 && spawn.cluster2 === spawn.cluster,
    `the cluster 16 units below the eye joins its own (${split.cluster} and ${split.cluster2}; spawn ${spawn.cluster} alone)`,
  );

  // Outside the map: cluster -1 draws every face, and the void shows the background.
  const outside = await shoot("outside", { origin: [1200, 0, 400], pitch: 20, yaw: 180 });
  check(outside.cluster === -1 && outside.visibleFaces === outside.worldFaces, "outside the map, every world face is in the PVS");
  check(outside.clearFraction > 0 && outside.clearFraction < 1, "outside view shows both geometry and background");

  // The interactive loop: frames advance on their own, and holding W flies forward.
  await page.evaluate(() => window.quack.setView({ origin: [-448, 0, 46], pitch: 0, yaw: 0 }));
  const before = await page.evaluate(() => window.quack.frames);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(500);
  await page.keyboard.up("KeyW");
  const after = await page.evaluate(() => ({ frames: window.quack.frames, view: window.quack.view() }));
  const [x, y, z] = after.view.origin;
  check(after.frames > before, `animation loop is running (${after.frames - before} frames in 0.5 s)`);
  check(x > -448 && Math.abs(y) < 1e-6 && z === 46, `holding W flies along +X (x ${x.toFixed(1)})`);

  // Brush models. The func_wall's east face (x -320) is looked at head-on from 160 units
  // east, once at its compiled spot (y +160) and once at the moved spot (y -160). A
  // 31x31 box around the face centre must change between the two maps at both spots:
  // the wall leaves one and appears at the other, while the rest of the frame (every
  // 16th pixel) stays put: only the wall moved, not the scene. The wall's checker averages RGB
  // (13 18 13) there and the shadowed far wall behind it (2 3 4); every box pixel
  // changed by at least 14 (measured 2026-10-03), so the threshold is 8.
  const WALL_VIEWS = [
    { name: "wall-north", view: { origin: [-160, 160, 24], pitch: 0, yaw: 180 }, point: [-320, 160, 24] },
    { name: "wall-south", view: { origin: [-160, -160, 24], pitch: 0, yaw: 180 }, point: [-320, -160, 24] },
  ];
  // The rotated wall's north face (y -128, the compiled east face turned by yaw 90) seen
  // head-on from 160 units north, and the compiled spot it leaves.
  const ROTATED_VIEWS = [
    WALL_VIEWS[0],
    { name: "wall-rotated", view: { origin: [-160, 32, 24], pitch: 0, yaw: 270 }, point: [-160, -128, 24] },
  ];
  /** Stats and the RGB of a 31x31 pixel box around the projected point, per wall view. */
  const wallBoxes = async (prefix, views = WALL_VIEWS) => {
    const out = [];
    for (const { name, view, point } of views) {
      const r = await page.evaluate(
        ([view, point]) => {
          window.quack.setView(view);
          const { width, data } = window.quack.readPixels();
          const p = window.quack.project(...point);
          const box = [];
          const frame = [];
          for (let i = 0; i < data.length; i += 16 * 4) frame.push(data[i], data[i + 1], data[i + 2]);
          for (let y = Math.round(p[1]) - 15; y <= Math.round(p[1]) + 15; y++) {
            for (let x = Math.round(p[0]) - 15; x <= Math.round(p[0]) + 15; x++) {
              const i = (y * width + x) * 4;
              box.push(data[i], data[i + 1], data[i + 2]);
            }
          }
          return { stats: window.quack.stats, brushModels: window.quack.brushModels, box, frame };
        },
        [view, point],
      );
      await page.screenshot({ path: join(outDir, `${prefix}-${name}.png`) });
      out.push(r);
    }
    return out;
  };
  /** Fraction of box pixels whose RGB differs by more than 8 in total. */
  const changed = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 3) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
    }
    return n / (a.length / 3);
  };
  const compiled = await wallBoxes("compiled");
  const compiledRotated = await wallBoxes("compiled", ROTATED_VIEWS.slice(1));
  console.log(`  brush models: ${JSON.stringify(compiled[0].brushModels)}, stats ${JSON.stringify(compiled[0].stats)}`);
  check(
    JSON.stringify(compiled[0].brushModels) === JSON.stringify(["func_wall *1 at 0 0 0"]) &&
      compiled[0].stats.brushModels === 1 &&
      compiled[1].stats.brushModels === 0 &&
      compiled[1].stats.frustumCulled === 1,
    "the fixture's func_wall is placed from the entity string, drawn, and culled when beside the view",
  );
  await page.goto(`${ORIGIN}/?map=data/moved.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const moved = await wallBoxes("moved");
  console.log(`  moved brush models: ${JSON.stringify(moved[0].brushModels)}`);
  check(JSON.stringify(moved[0].brushModels) === JSON.stringify(["func_wall *1 at 0 -320 0"]), "moved map places the func_wall at its origin key");
  const [north, south] = [0, 1].map((i) => changed(compiled[i].box, moved[i].box));
  const frames = [0, 1].map((i) => changed(compiled[i].frame, moved[i].frame));
  console.log(`  changed pixels: compiled spot ${north.toFixed(3)}, moved spot ${south.toFixed(3)}, whole frames ${frames.map((f) => f.toFixed(3))}`);
  // The wall covers 160x120 of the 800x600 frame head-on, 4% (measured 2026-10-03).
  check(frames.every((f) => f < 0.06), "moving the func_wall changes only the wall's own pixels");
  check(north > 0.9, "the func_wall's pixels show at its compiled spot and leave it when moved");
  check(south > 0.9, "the moved func_wall's pixels show at its entity origin");
  await page.goto(`${ORIGIN}/?map=data/rotated.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const rotated = await wallBoxes("rotated", ROTATED_VIEWS);
  console.log(`  rotated brush models: ${JSON.stringify(rotated[0].brushModels)}`);
  check(
    JSON.stringify(rotated[0].brushModels) === JSON.stringify(["func_wall *1 at 0 192 0 angles 0 90 0"]),
    "rotated map gives the func_wall its angle key",
  );
  const unrotated = [compiled[0], compiledRotated[0]];
  const [left, arrived] = [0, 1].map((i) => changed(unrotated[i].box, rotated[i].box));
  const rotatedFrames = [0, 1].map((i) => changed(unrotated[i].frame, rotated[i].frame));
  console.log(`  changed pixels: compiled spot ${left.toFixed(3)}, rotated spot ${arrived.toFixed(3)}, whole frames ${rotatedFrames.map((f) => f.toFixed(3))}`);
  check(rotatedFrames.every((f) => f < 0.06), "rotating the func_wall changes only the wall's own pixels");
  check(left > 0.9, "the rotated func_wall leaves its compiled spot");
  check(arrived > 0.9, "the rotated func_wall shows where yaw 90 then its origin put it");

  // Door motion: brushOrigins steps the door from the settle frames and blends game
  // frames as the client does (frame 3 starts it, 4 at 20, 6 at the top, 42; frame n is
  // sent at (n - 2) * 100 ms), and each frame is drawn with those origins.
  await page.goto(`${ORIGIN}/?map=data/door.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const doorMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    origins: [0, 150, 400, 150].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  door: ${JSON.stringify(doorMotion)}`);
  check(
    JSON.stringify(doorMotion.brushModels) === JSON.stringify(["func_door *1 at 0 0 0"]) &&
      JSON.stringify(doorMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, 10]], [[0, 0, 42]], [[0, 0, 10]]]),
    "a door the settle frames send up moves in brushOrigins: at rest, half way to frame 4's 20 at 150 ms, at the top by 400 ms",
  );
  // Facing the door's west face (x -384, z 0..48 at rest) from 64 units, each frame of
  // the moving door matches, pixel for pixel, the func_wall placed where it is drawn
  // then: the fixture's at rest, z 10 at 150 ms, z 42 at 400 ms.
  const doorView = { origin: [-448, 160, 24], pitch: 0, yaw: 0 };
  /** Every third pixel's RGB, and the stats, of a frame of `map` at level time `ms`. */
  const doorFrame = async (map, ms) => {
    await page.goto(`${ORIGIN}/?map=${map}`);
    await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
    const r = await page.evaluate(
      ([view, ms]) => {
        window.quack.setView(view);
        window.quack.setLevelTime(ms);
        const { data } = window.quack.readPixels();
        const frame = [];
        for (let i = 0; i < data.length; i += 3 * 4) frame.push(data[i], data[i + 1], data[i + 2]);
        return { frame, stats: window.quack.stats, error: window.quack.error };
      },
      [doorView, ms],
    );
    await page.screenshot({ path: join(outDir, `door-${map.replace(/\W+/g, "-")}-${ms}.png`) });
    return r;
  };
  const doorFrames = [];
  for (const [ms, ref] of [[0, "maps/test_arena.bsp"], [150, "data/door-at-10.bsp"], [400, "data/door-at-42.bsp"]]) {
    const [moving, placed] = [await doorFrame("data/door.bsp", ms), await doorFrame(ref, ms)];
    doorFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const doorRestTop = changed(doorFrames[0].moving.frame, doorFrames[2].moving.frame);
  console.log(
    `  door drawn: ${doorFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; rest to top changes ${doorRestTop.toFixed(3)}`,
  );
  check(doorFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the moving door is drawn at every time");
  check(doorRestTop > 0.02, "the door's frames at rest and at the top differ");
  check(doorFrames.every((d) => d.diff === 0), "the moving door draws as a func_wall placed where brushOrigins puts it: at rest, z 10 at 150 ms, z 42 at 400 ms");

  // Plat motion: the accelerative move down (Think_AccelMove from frame 3: -5 in frame
  // 4, -15 in 5, -26.625 in 6, -36.375 in 7, stopping 1/8 short at -41.875), blended as
  // the door's is; each frame draws as the func_wall placed there.
  await page.goto(`${ORIGIN}/?map=data/plat.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const platMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    origins: [0, 250, 450, 1000].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  plat: ${JSON.stringify(platMotion)}`);
  check(
    JSON.stringify(platMotion.brushModels) === JSON.stringify(["func_plat *1 at 0 0 0"]) &&
      JSON.stringify(platMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, -10]], [[0, 0, -31.5]], [[0, 0, -41.875]]]),
    "a plat the settle frames send down moves in brushOrigins: at the top, z -10 at 250 ms, -31.5 at 450 ms, -41.875 by 1000 ms",
  );
  const platFrames = [];
  for (const [ms, ref] of [[0, "maps/test_arena.bsp"], [250, "data/plat-at--10.bsp"], [450, "data/plat-at--31.5.bsp"]]) {
    const [moving, placed] = [await doorFrame("data/plat.bsp", ms), await doorFrame(ref, ms)];
    platFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const platRestLow = changed(platFrames[0].moving.frame, platFrames[2].moving.frame);
  console.log(
    `  plat drawn: ${platFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; top to 450 ms changes ${platRestLow.toFixed(3)}`,
  );
  check(platFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the moving plat is drawn at every time");
  check(platRestLow > 0.02, "the plat's frames at the top and lowered differ");
  check(platFrames.every((d) => d.diff === 0), "the moving plat draws as a func_wall placed where brushOrigins puts it: at the top, z -10 at 250 ms, z -31.5 at 450 ms");

  // Button motion: Move_Begin from frame 3, 4 units a frame from frame 4, 2 more in frame
  // 15 to the top (1300 ms); button_return in frame 45 brings it back from frame 46.
  await page.goto(`${ORIGIN}/?map=data/button.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const buttonMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    origins: [0, 250, 1300, 4450, 6000].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  button: ${JSON.stringify(buttonMotion)}`);
  check(
    JSON.stringify(buttonMotion.brushModels) === JSON.stringify(["func_button *1 at 0 0 0"]) &&
      JSON.stringify(buttonMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, 6]], [[0, 0, 46]], [[0, 0, 40]], [[0, 0, 0]]]),
    "a button the settle frames fire moves in brushOrigins: at rest, z 6 at 250 ms, at the top at 1300 ms, z 40 on the way back at 4450 ms, home by 6000 ms",
  );
  const buttonFrames = [];
  for (const [ms, ref] of [[0, "maps/test_arena.bsp"], [250, "data/button-at-6.bsp"], [1300, "data/button-at-46.bsp"]]) {
    const [moving, placed] = [await doorFrame("data/button.bsp", ms), await doorFrame(ref, ms)];
    buttonFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const buttonRestTop = changed(buttonFrames[0].moving.frame, buttonFrames[2].moving.frame);
  console.log(
    `  button drawn: ${buttonFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; rest to top changes ${buttonRestTop.toFixed(3)}`,
  );
  check(buttonFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the moving button is drawn at every time");
  check(buttonRestTop > 0.02, "the button's frames at rest and at the top differ");
  check(buttonFrames.every((d) => d.diff === 0), "the moving button draws as a func_wall placed where brushOrigins puts it: at rest, z 6 at 250 ms, z 46 at 1300 ms");

  // Train motion: train_next in frame 2 heads up at 10 a frame (z 20 in frame 4, 30 in
  // frame 5); frame 6 reaches c2 and teleports to t3 (z 0), drawn there unblended for all
  // of 301 to 400 ms; frame 7 reaches c4 at z 10, where it stays.
  await page.goto(`${ORIGIN}/?map=data/train.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const trainMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    origins: [0, 250, 350, 450, 1000].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  train: ${JSON.stringify(trainMotion)}`);
  check(
    JSON.stringify(trainMotion.brushModels) === JSON.stringify(["func_train *1 at 0 0 0"]) &&
      JSON.stringify(trainMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, 25]], [[0, 0, 0]], [[0, 0, 5]], [[0, 0, 10]]]),
    "a train moves in brushOrigins: at c1, z 25 at 250 ms, teleported to z 0 unblended at 350 ms, z 5 at 450 ms, at c4 by 1000 ms",
  );
  const trainFrames = [];
  for (const [ms, ref] of [[0, "maps/test_arena.bsp"], [250, "data/train-at-25.bsp"], [350, "maps/test_arena.bsp"], [1000, "data/door-at-10.bsp"]]) {
    const [moving, placed] = [await doorFrame("data/train.bsp", ms), await doorFrame(ref, ms)];
    trainFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const trainTeleported = changed(trainFrames[1].moving.frame, trainFrames[2].moving.frame);
  console.log(
    `  train drawn: ${trainFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; 250 to 350 ms changes ${trainTeleported.toFixed(3)}`,
  );
  check(trainFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the moving train is drawn at every time");
  check(trainTeleported > 0.02, "the train's frames before and after its teleport differ");
  check(trainFrames.every((d) => d.diff === 0), "the moving train draws as a func_wall placed where brushOrigins puts it: z 0, 25, 0 (teleported) and 10");

  // Rotating door: brushAngles steps it as AngleMove_Calc does (frame 4 at 10 degrees,
  // frame 5 at 20, sent in 360/256 degree steps: 9.84375 and 19.6875) and blends them;
  // its origin stays. Each frame draws as the func_wall turned to those angles.
  await page.goto(`${ORIGIN}/?map=data/door-rotating.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const rotatingMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    angles: [0, 150, 250, 1000].map((ms) => window.quack.brushAngles(ms)),
    origins: [0, 150].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  rotating door: ${JSON.stringify(rotatingMotion)}`);
  check(
    JSON.stringify(rotatingMotion.brushModels) === JSON.stringify(["func_door_rotating *1 at 0 0 0"]) &&
      JSON.stringify(rotatingMotion.angles) === JSON.stringify([[[0, 0, 0]], [[0, 4.921875, 0]], [[0, 14.765625, 0]], [[0, 90, 0]]]) &&
      JSON.stringify(rotatingMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, 0]]]),
    "a rotating door the settle frames send round turns in brushAngles: at rest, 4.921875 at 150 ms, 14.765625 at 250 ms, 90 by 1000 ms",
  );
  const rotatingFrames = [];
  for (const [ms, ref] of [[0, "maps/test_arena.bsp"], [150, "data/door-yaw-4.921875.bsp"], [250, "data/door-yaw-14.765625.bsp"]]) {
    const [moving, placed] = [await doorFrame("data/door-rotating.bsp", ms), await doorFrame(ref, ms)];
    rotatingFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const rotatingRestTurned = changed(rotatingFrames[0].moving.frame, rotatingFrames[2].moving.frame);
  console.log(
    `  rotating door drawn: ${rotatingFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; rest to 250 ms changes ${rotatingRestTurned.toFixed(3)}`,
  );
  check(rotatingFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the rotating door is drawn at every time");
  check(rotatingRestTurned > 0.02, "the rotating door's frames at rest and turned differ");
  check(rotatingFrames.every((d) => d.diff === 0), "the rotating door draws as a func_wall turned to the angles brushAngles gives: at rest, 4.921875 at 150 ms, 14.765625 at 250 ms");

  // func_rotating: brushAngles turns it 10 degrees a frame from the -10 the settle frames
  // left it at (sent as -9.84375, 0, 9.84375, 19.6875) and blends the frames; its
  // origin stays. Each frame draws as the func_wall turned to those angles.
  await page.goto(`${ORIGIN}/?map=data/rotating.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const spinMotion = await page.evaluate(() => ({
    brushModels: window.quack.brushModels,
    angles: [0, 150, 250, 1000].map((ms) => window.quack.brushAngles(ms)),
    origins: [0, 1000].map((ms) => window.quack.brushOrigins(ms)),
  }));
  console.log(`  func_rotating: ${JSON.stringify(spinMotion)}`);
  check(
    JSON.stringify(spinMotion.brushModels) === JSON.stringify(["func_rotating *1 at 0 0 0 angles 0 -10 0"]) &&
      JSON.stringify(spinMotion.angles) === JSON.stringify([[[0, -9.84375, 0]], [[0, 4.921875, 0]], [[0, 14.765625, 0]], [[0, 90, 0]]]) &&
      JSON.stringify(spinMotion.origins) === JSON.stringify([[[0, 0, 0]], [[0, 0, 0]]]),
    "a START_ON func_rotating turns in brushAngles: -9.84375 at 0 ms, 4.921875 at 150 ms, 14.765625 at 250 ms, 90 at 1000 ms",
  );
  const spinFrames = [];
  for (const [ms, yaw] of [[0, "-9.84375"], [150, "4.921875"], [250, "14.765625"]]) {
    const [moving, placed] = [await doorFrame("data/rotating.bsp", ms), await doorFrame(`data/door-yaw-${yaw}.bsp`, ms)];
    spinFrames.push({ ms, moving, placed, diff: changed(moving.frame, placed.frame) });
  }
  const spinTurned = changed(spinFrames[0].moving.frame, spinFrames[2].moving.frame);
  console.log(
    `  func_rotating drawn: ${spinFrames.map((d) => `${d.ms} ms ${d.diff.toFixed(4)} off its placed wall (brush models ${d.moving.stats.brushModels})`).join(", ")}; 0 to 250 ms changes ${spinTurned.toFixed(3)}`,
  );
  check(spinFrames.every((d) => !d.moving.error && !d.placed.error && d.moving.stats.brushModels === 1), "the func_rotating is drawn at every time");
  check(spinTurned > 0.02, "the func_rotating's frames at 0 and 250 ms differ");
  check(spinFrames.every((d) => d.diff === 0), "the func_rotating draws as a func_wall turned to the angles brushAngles gives at 0, 150 and 250 ms");

  // Culling never changes a pixel: each view renders the same with culling off. From the
  // north spot the south wall is beside the view and the one outside the map is in no
  // cluster; outside the map the PVS is not used, and that wall is behind the eye.
  await page.goto(`${ORIGIN}/?map=data/culled.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const CULL_VIEWS = [
    { ...WALL_VIEWS[0], expect: { brushModels: 1, areaCulled: 1, pvsCulled: 0, frustumCulled: 1 } },
    { ...WALL_VIEWS[1], expect: { brushModels: 1, areaCulled: 1, pvsCulled: 0, frustumCulled: 1 } },
    { name: "spawn", view: { origin: [-448, 0, 46], pitch: 0, yaw: 0 }, expect: { brushModels: 2, areaCulled: 1, pvsCulled: 0, frustumCulled: 0 } },
    { name: "outside", view: { origin: [1200, 0, 400], pitch: 20, yaw: 180 }, expect: { brushModels: 2, areaCulled: 0, pvsCulled: 0, frustumCulled: 1 } },
  ];
  for (const { name, view, expect } of CULL_VIEWS) {
    const r = await page.evaluate((view) => {
      const frame = (cull) => {
        window.quack.setCull(cull);
        window.quack.setView(view);
        const { data } = window.quack.readPixels();
        const { brushModels, areaCulled, pvsCulled, frustumCulled } = window.quack.stats;
        return { stats: { brushModels, areaCulled, pvsCulled, frustumCulled }, data };
      };
      const on = frame(true);
      const off = frame(false);
      window.quack.setCull(true);
      let differ = 0;
      for (let i = 0; i < on.data.length; i++) if (on.data[i] !== off.data[i]) differ++;
      return { on: on.stats, off: off.stats, differ };
    }, view);
    console.log(`  culled ${name}: ${JSON.stringify(r)}`);
    check(
      JSON.stringify(r.on) === JSON.stringify(expect) && JSON.stringify(r.off) === JSON.stringify({ brushModels: 3, areaCulled: 0, pvsCulled: 0, frustumCulled: 0 }),
      `${name} view culls ${expect.areaCulled} brush model(s) by area, ${expect.pvsCulled} by PVS and ${expect.frustumCulled} by frustum, draws ${expect.brushModels}`,
    );
    check(r.differ === 0, `${name} view: culling changes no pixel (${r.differ} bytes differ)`);
  }

  // Light styles: the world goes black with style 2 at 'a', brighter than style 0's
  // normal light at 'z', and back at 'm' renders byte for byte as the unstyled map, so
  // every drawn face's lightmap was uploaded to its own rect. A change uploads only the
  // faces drawn; one not drawn then is composed when it comes into view.
  const lightAhead = { origin: [-448, 0, 46], pitch: 0, yaw: 0 };
  const lightFar = { origin: [448, 0, 46], pitch: 0, yaw: 180 };
  // Facing the func_wall (box x -384..-320, y 128..192). Its box touches the first view's
  // frustum edge, so the first view composes it; without the brush model refresh this
  // view draws it black, as composed at load.
  const lightWall = { origin: [-448, 0, 46], pitch: 0, yaw: 60 };
  const lightFrame = (ms, view = lightAhead) =>
    page.evaluate(
      ([ms, view]) => {
        window.quack.setView(view);
        window.quack.setLevelTime(ms);
        const { width, height, data } = window.quack.readPixels();
        const uploads = window.quack.lightmapUploads;
        // Centre of the func_wall's west face, which the wall view looks at.
        const p = window.quack.project(-384, 160, 24);
        const onScreen = !!p && p[0] >= 0 && p[0] < width && p[1] >= 0 && p[1] < height;
        const wallPixel = onScreen ? Array.from(data.subarray(...[0, 4].map((k) => (Math.floor(p[1]) * width + Math.floor(p[0])) * 4 + k))) : undefined;
        // A second frame at the same time uploads nothing.
        window.quack.readPixels();
        let sum = 0, clear = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
          else sum += data[i] + data[i + 1] + data[i + 2];
        }
        return { uploads, again: window.quack.lightmapUploads, brushModels: window.quack.stats.brushModels, wallPixel, mean: sum / (data.length / 4), clear, data: Array.from(data) };
      },
      [ms, view],
    );
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const normal = await lightFrame(0);
  const normalFar = await lightFrame(0, lightFar);
  const normalWall = await lightFrame(0, lightWall);
  await page.goto(`${ORIGIN}/?map=data/styled.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const styledError = await page.evaluate(() => window.quack.error);
  const off = await lightFrame(0);
  const doubled = await lightFrame(2500);
  const back = await lightFrame(1200);
  // From the far side at the same time: faces never drawn from the first view, last composed at load.
  const lightFarFrame = await lightFrame(1200, lightFar);
  const lightReturned = await lightFrame(1200);
  const lightWallFrame = await lightFrame(1200, lightWall);
  const differ = back.data.reduce((n, b, i) => n + (b !== normal.data[i] ? 1 : 0), 0);
  const differFar = lightFarFrame.data.reduce((n, b, i) => n + (b !== normalFar.data[i] ? 1 : 0), 0);
  const differWall = lightWallFrame.data.reduce((n, b, i) => n + (b !== normalWall.data[i] ? 1 : 0), 0);
  const brief = ({ data, ...r }) => JSON.stringify(r);
  console.log(
    `  light styles: normal ${brief(normal)}, a ${brief(off)}, z ${brief(doubled)}, m ${brief(back)}, far ${brief(lightFarFrame)}, returned ${brief(lightReturned)}, wall ${brief(lightWallFrame)}, ${differ} bytes differ at m, ${differFar} far, ${differWall} wall`,
  );
  check(!styledError && off.clear === 0 && off.mean === 0, "faces on a light style at 'a' draw black");
  check(doubled.mean > normal.mean * 1.3, "faces on a light style at 'z' draw brighter than normal light");
  check(
    back.data.length === normal.data.length && differ === 0,
    "faces on a light style at 'm' draw exactly as unstyled faces, after style changes",
  );
  check(
    doubled.uploads > 0 && doubled.uploads < FIXTURE_FACES && back.uploads === doubled.uploads && doubled.again === 0 && back.again === 0,
    `a style change uploads only the faces drawn (${doubled.uploads} of ${FIXTURE_FACES}), once; an unchanged frame none`,
  );
  check(
    lightFarFrame.uploads > 0 && lightReturned.uploads === 0 && lightFarFrame.data.length === normalFar.data.length && differFar === 0,
    "faces coming into view after a style change are composed then, and draw as unstyled faces at 'm'",
  );
  check(
    lightWallFrame.brushModels === 1 && !!normalWall.wallPixel && normalWall.wallPixel.slice(0, 3).some((c) => c > 0) &&
      lightWallFrame.data.length === normalWall.data.length && differWall === 0,
    `a brush model drawn after a style change draws as unstyled at 'm' (wall face centre ${JSON.stringify(normalWall.wallPixel)})`,
  );

  // Warps: the floor moves with level time and has no lightmap, so the pillar's shadow
  // is gone. The unwarped map does not change with time (style 0 is constant).
  const timeFrames = (map) =>
    page.evaluate(async (map) => {
      const frame = (ms) => {
        window.quack.setView({ origin: [-448, 0, 46], pitch: 0, yaw: 0 });
        window.quack.setLevelTime(ms);
        return window.quack.readPixels().data;
      };
      const diff = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
        return n / (a.length / 4);
      };
      const t0 = frame(0), again = frame(0), t1 = frame(1000);
      return { map, moved: diff(t0, t1), repeat: diff(t0, again), stats: window.quack.stats };
    }, map);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const still = await timeFrames("fixture");
  await page.goto(`${ORIGIN}/?map=data/warp.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const warped = await timeFrames("warp");
  await page.evaluate(() => window.quack.setLevelTime(0));
  await shoot("warp", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  const transView = await page.goto(`${ORIGIN}/?map=data/trans33.bsp`).then(() =>
    page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 }),
  ).then(() => shoot("trans33", WALL_VIEWS[0].view));
  check(transView.alphaFaces > 0 && transView.seeThrough === 0, "the canvas stays opaque under the alpha pass (no pixel alpha below 255)");
  await page.goto(`${ORIGIN}/?map=data/warp.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  await page.evaluate(() => window.quack.setLevelTime(0));
  const [warpShadowRgb, warpLitRgb] = await floorBoxes([[-312, 0], [-256, -112]]);
  const warpFloor = { shadow: brightness(warpShadowRgb), lit: brightness(warpLitRgb) };
  console.log(`  warp: ${JSON.stringify({ still, warped, warpFloor })}`);
  check(still.moved === 0 && still.repeat === 0, "without warps, level time changes no pixel");
  check(warped.repeat === 0 && warped.moved > 0.05, `warped floor moves with level time (${(warped.moved * 100).toFixed(1)}% of pixels)`);
  check(warpFloor.lit < 1.5 * warpFloor.shadow, "warped floor has no lightmap: no shadow under the pillar");

  // SURF_FLOWING without a warp: the scroll is -64 * frac(t / 40) texture widths, so 1 s
  // moves the floor 1.6 widths, while 2.5 s (-4 widths, against -64 at 0 s) is a whole
  // number of widths and so of the checker's 16-texel period: no visible shift, where a
  // scroll in texels would shift it 4 texels. -4 and -64 round differently in float, so
  // a few edge pixels may still differ. The translucent trim goes through
  // R_DrawAlphaSurfaces' DrawGLPoly and does not move.
  const flowFrames = (map, view) =>
    page.evaluate(async ({ map, view }) => {
      const frame = (ms) => {
        window.quack.setView(view);
        window.quack.setLevelTime(ms);
        return window.quack.readPixels().data;
      };
      const diff = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
        return n / (a.length / 4);
      };
      const t0 = frame(0), t1 = frame(1000), whole = frame(2500);
      return { map, moved: diff(t0, t1), whole: diff(t0, whole), stats: window.quack.stats };
    }, { map, view });
  await page.goto(`${ORIGIN}/?map=data/flowing.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const flowFloor = await flowFrames("flowing", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  await page.evaluate(() => window.quack.setLevelTime(500));
  const [flowShadowRgb, flowLitRgb] = await floorBoxes([[-312, 0], [-256, -112]]);
  const flowLight = { shadow: brightness(flowShadowRgb), lit: brightness(flowLitRgb) };
  await shoot("flowing", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  await page.goto(`${ORIGIN}/?map=data/flowing-trans.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const flowTrans = await flowFrames("flowing-trans", WALL_VIEWS[0].view);
  console.log(`  flowing: ${JSON.stringify({ flowFloor, flowLight, flowTrans })}`);
  check(flowFloor.moved > 0.05, `flowing floor scrolls with level time (${(flowFloor.moved * 100).toFixed(1)}% of pixels)`);
  check(flowFloor.whole < 0.005, `flowing floor scrolls in texture widths (${(flowFloor.whole * 100).toFixed(2)}% of pixels differ at a whole-width scroll)`);
  check(flowLight.lit > 4 * flowLight.shadow, "flowing floor keeps its lightmap");
  check(flowTrans.stats.alphaFaces > 0 && flowTrans.moved === 0 && flowTrans.whole === 0, "flowing translucent faces do not scroll");

  // Translucent faces: the func_wall's box, with and without the wall, at alpha 0.33 and
  // 0.66. Solving P = a A + (1 - a) B for the wall's own colour A must give the same A
  // at both alphas, and A is the unlit texture, at least as bright as the lit wall.
  const transBox = async (map) => {
    await page.goto(`${ORIGIN}/?map=data/${map}.bsp`);
    await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
    const [r] = await wallBoxes(map, WALL_VIEWS.slice(0, 1));
    return r;
  };
  const mean = (box) => box.reduce((a, v) => a + v, 0) / box.length;
  const trans = {};
  for (const map of ["trans33", "trans33-moved", "trans66", "trans66-moved"]) trans[map] = await transBox(map);
  const wallColor = (a, map) => (mean(trans[map].box) - (1 - a) * mean(trans[`${map}-moved`].box)) / a;
  const a33 = wallColor(0.33, "trans33"), a66 = wallColor(0.66, "trans66");
  const behind = mean(trans["trans33-moved"].box), opaque = mean(compiled[0].box);
  console.log(
    `  translucent: mean box ${["trans33", "trans66"].map((m) => mean(trans[m].box).toFixed(1))}, behind ${behind.toFixed(1)}, opaque lit ${opaque.toFixed(1)}, wall colour at 0.33 ${a33.toFixed(1)} at 0.66 ${a66.toFixed(1)}, stats ${JSON.stringify(trans.trans33.stats)}`,
  );
  check(trans.trans33.stats.alphaFaces > 0 && trans.trans33.stats.brushModels === 1, "translucent faces go through the alpha pass");
  // Measured 0.4 apart (2026-10-04). Behind the wall is dark (mean 3.1), so a blend that
  // dropped the destination would still land only about 4.7 apart: the bound is 1.5.
  check(Math.abs(a33 - a66) < 1.5, "translucent faces blend at 0.33 and 0.66 alpha over what is behind them");
  check(a33 >= opaque - 1, "translucent faces draw unlit");

  // Sky: the walls and ceiling are not drawn; the box is, behind them. Directions from an
  // eye in the west half's open space, each well inside one box side and one quadrant.
  const SKY_EYE = { origin: [-256, -128, 128], pitch: 0, yaw: 0 };
  const skyAt = (view, dirs, ms) =>
    page.evaluate(
      ({ view, dirs, ms }) => {
        window.quack.setView(view);
        window.quack.setLevelTime(ms);
        const { width, height, data } = window.quack.readPixels();
        let clear = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
        const colors = dirs.map(([x, y, z]) => {
          const p = window.quack.project(view.origin[0] + x * 100, view.origin[1] + y * 100, view.origin[2] + z * 100);
          if (!p || p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height) return null;
          const i = (Math.floor(p[1]) * width + Math.floor(p[0])) * 4;
          return [data[i], data[i + 1], data[i + 2]];
        });
        return { stats: window.quack.stats, sky: window.quack.sky, clear, colors };
      },
      { view, dirs, ms },
    );
  const loadMap = async (query) => {
    await page.goto(`${ORIGIN}/?${query}`);
    await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
    return page.evaluate(() => window.quack.error);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Left/right is +y/-y looking along +x; up/down is +z/-z. Picked clear of the pillars
  // (trim) that stand in this view.
  const RT_DIRS = [[1, 0.6, 0.6], [1, -0.6, 0.6], [1, 0.5, -0.12], [1, -0.75, -0.35]];
  const SIDE_VIEWS = [
    ["bk", { ...SKY_EYE, yaw: 90 }, [0, 1, 0.1]],
    ["lf", { ...SKY_EYE, yaw: 180 }, [-1, 0, 0.1]],
    ["ft", { ...SKY_EYE, yaw: 270 }, [0, -1, 0.1]],
    ["up", { ...SKY_EYE, pitch: -89 }, [0.05, 0, 1]],
  ];
  const noSkyError = await loadMap("map=data/sky.bsp");
  const bare = await skyAt(SKY_EYE, RT_DIRS, 0);
  await page.screenshot({ path: join(outDir, "sky-notexture.png") });
  console.log(`  sky, no data: ${JSON.stringify(bare)}`);
  check(!noSkyError && bare.sky?.name === "unit1_" && bare.sky.loaded.length === 0, "sky.bsp loads with the default unit1_ sky and no images");
  check(bare.stats.skyPolygons > 0 && bare.stats.skySides > 0 && bare.clear === 0, "world sky faces bound a sky box that covers them (no background pixels)");
  // Looking down at the floor, most of the walls and the ceiling are outside the view.
  const skyCull = await page.evaluate((view) => {
    const at = (cull) => {
      window.quack.setCull(cull);
      window.quack.setView(view);
      const { data } = window.quack.readPixels();
      let clear = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
      const { skyPolygons, skySides, drawnFaces } = window.quack.stats;
      return { skyPolygons, skySides, drawnFaces, clear };
    };
    const on = at(true);
    const off = at(false);
    window.quack.setCull(true);
    return { on, off };
  }, { ...SKY_EYE, pitch: 89 });
  console.log(`  sky culling: ${JSON.stringify(skyCull)}`);
  check(
    skyCull.on.skyPolygons > 0 && skyCull.on.skyPolygons < skyCull.off.skyPolygons && skyCull.on.drawnFaces < skyCull.off.drawnFaces && skyCull.on.clear === 0,
    "sky faces outside the view frustum do not bound the sky box, which still covers those in it (R_CullBox in the world walk)",
  );
  check(
    bare.colors.every((c) => c && c[1] === 0 && c[2] === 0),
    "without sky images the box draws r_notexture (red on black) where the sky faces are",
  );

  const skyError = await loadMap("pak=data/sky.pak&map=data/sky.bsp");
  const rt = await skyAt(SKY_EYE, RT_DIRS, 0);
  await page.screenshot({ path: join(outDir, "sky-rt.png") });
  console.log(`  sky rt: ${JSON.stringify(rt)}`);
  check(!skyError && rt.sky.loaded.length === 6 && rt.clear === 0, "sky images load from the pak");
  check(same(rt.colors, RT_QUADRANTS), "looking along +x shows rt, upright and unmirrored (quadrants in place)");
  const sides = [];
  for (const [side, view, dir] of SIDE_VIEWS) {
    const r = await skyAt(view, [dir], 0);
    sides.push([side, r.colors[0]]);
    if (side === "up") await page.screenshot({ path: join(outDir, "sky-up.png") });
  }
  console.log(`  sky sides: ${JSON.stringify(sides)}`);
  check(sides.every(([side, c]) => same(c, SKY_COLORS[side])), "+y shows bk, -x lf, -y ft, up up (R_SetSky suffixes through skytexorder)");

  const rotError = await loadMap("pak=data/sky.pak&map=data/sky-rotate.bsp");
  const still0 = await skyAt({ ...SKY_EYE, yaw: 90 }, [[0, 1, 0.1]], 0);
  const turned = await skyAt({ ...SKY_EYE, yaw: 90 }, [[-0.25, 1, 0.25], [0.25, 1, 0.25]], 1000);
  console.log(`  sky rotate: ${JSON.stringify({ still0, turned })}`);
  check(!rotError && turned.sky.rotate === 90 && same(turned.sky.axis, [0, 0, 1]), "skyrotate and skyaxis reach R_SetSky");
  check(same(still0.colors[0], SKY_COLORS.bk) && still0.stats.skySides === 6, "a rotating sky draws all six sides, unturned at level time 0");
  // 90 degrees counterclockwise about +z after 1 s: rt now faces +y, its left edge toward -x.
  check(same(turned.colors, RT_QUADRANTS.slice(0, 2)), "after 1 s at 90 degrees a second about +z, rt faces +y");

  // Area portals. From the north-west room (area 1) looking east through the doorway in
  // the dividing wall: the closed portal leaves the east half's world faces and its
  // func_wall undrawn (the background shows through the doorway); opened by the door, or
  // ignored (map_noareas), the frame is the same as with no areas at all.
  const areaFrame = (view, noAreas) =>
    page.evaluate(
      ({ view, noAreas }) => {
        window.quack.setNoAreas(noAreas);
        window.quack.setView(view);
        const { width, height, data } = window.quack.readPixels();
        window.quack.setNoAreas(false);
        let clear = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
        const { area, visibleFaces, brushModels, areaCulled, pvsCulled } = window.quack.stats;
        return { stats: { area, visibleFaces, brushModels, areaCulled, pvsCulled }, clearFraction: clear / (width * height), open: window.quack.openPortals, data: Array.from(data) };
      },
      { view, noAreas },
    );
  const AREA_WEST = { origin: [-160, 48, 64], pitch: 0, yaw: 0 };
  const AREA_EAST = { origin: [160, 48, 64], pitch: 0, yaw: 180 };
  const strip = ({ data, ...r }) => r;
  const areasError = await loadMap("map=data/areas.bsp");
  const closedWest = await areaFrame(AREA_WEST, false);
  await page.screenshot({ path: join(outDir, "areas-closed.png") });
  const ignoredWest = await areaFrame(AREA_WEST, true);
  const closedEast = await areaFrame(AREA_EAST, false);
  const openError = await loadMap("map=data/areas-open.bsp");
  const openWest = await areaFrame(AREA_WEST, false);
  console.log(`  areas: ${JSON.stringify({ closedWest: strip(closedWest), ignoredWest: strip(ignoredWest), closedEast: strip(closedEast), openWest: strip(openWest) })}`);
  check(!areasError && !openError && same(closedWest.open, []) && same(openWest.open, [1]), "func_areaportal starts closed; a START_OPEN door that targets it opens it");
  check(closedWest.stats.area === 1 && closedEast.stats.area === 2, "the eye's leaf area is reported");
  check(
    closedWest.clearFraction > 0.01 && closedWest.stats.visibleFaces < ignoredWest.stats.visibleFaces,
    `a closed portal hides the world beyond it (${closedWest.stats.visibleFaces} of ${ignoredWest.stats.visibleFaces} faces, ${(closedWest.clearFraction * 100).toFixed(1)}% background)`,
  );
  check(
    closedWest.stats.areaCulled === 1 && ignoredWest.stats.brushModels === 1 && closedWest.stats.brushModels === 0,
    "a closed portal hides the brush model beyond it",
  );
  check(closedEast.clearFraction > 0.01 && closedEast.stats.areaCulled === 1, "from the east, the west's world and func_wall are hidden instead");
  check(
    openWest.clearFraction === 0 && same(openWest.data, ignoredWest.data),
    "an open portal draws as if there were no areas (map_noareas), pixel for pixel",
  );
  // The door outside the map is in area 0; the east func_wall is drawn.
  check(openWest.stats.brushModels === 1 && openWest.stats.areaCulled === 1, "an open portal lets the brush model beyond it draw");

  // A door coming back down closes its portal (door_hit_bottom): before, the frame is the
  // open one; from the frame it is home, the closed one.
  const closingAt = (ms) =>
    page.evaluate(
      ({ view, ms }) => {
        window.quack.setLevelTime(ms);
        window.quack.setView(view);
        const { data } = window.quack.readPixels();
        const { brushModels, areaCulled } = window.quack.stats;
        return { stats: { brushModels, areaCulled }, open: window.quack.openPortalsAt(), spawn: window.quack.openPortals, data: Array.from(data) };
      },
      { view: AREA_WEST, ms },
    );
  const closingError = await loadMap("map=data/areas-closing.bsp");
  const closingFrames = [];
  for (const ms of [1000, 3600, 3601, 5000, 1000]) closingFrames.push({ ms, ...(await closingAt(ms)) });
  await page.screenshot({ path: join(outDir, "areas-closing.png") });
  console.log(`  areas closing: ${JSON.stringify(closingFrames.map(strip))}`);
  const [beforeHome, lastOpen, home, later, reopened] = closingFrames;
  check(
    !closingError && same(beforeHome.spawn, [1]) && [beforeHome, lastOpen, reopened].every((f) => same(f.open, [1])) && [home, later].every((f) => same(f.open, [])),
    "a door the settle frames sent up opens its portal, and closes it in the frame it is back down (3601 ms); going back in time opens it again",
  );
  check(
    [beforeHome, lastOpen, reopened].every((f) => same(f.data, ignoredWest.data) && f.stats.brushModels === 1),
    "while the portal is open the frame is the open one, pixel for pixel",
  );
  check(
    [home, later].every((f) => same(f.data, closedWest.data) && f.stats.brushModels === 0 && f.stats.areaCulled === 2),
    "once the door is home the frame is the closed one, pixel for pixel, and the east func_wall is culled by area",
  );

  // Game data: ?pak= mounts in order; 404s are reported, in URL order, and skipped.
  await page.goto(`${ORIGIN}/?pak=data/absent-1.pak&pak=data/synthetic.pak&pak=data/absent-2.pak&pak=data/synthetic.zip`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const data = await page.evaluate(() => ({
    error: window.quack.error,
    archives: window.quack.archives,
    palette: window.quack.palette,
    assetErrors: window.quack.assetErrors,
    missing: window.quack.missingTextures,
    hud: document.getElementById("data")?.textContent,
  }));
  console.log(`  game data: ${JSON.stringify(data)}`);
  check(!data.error, "client boots with game data mounted");
  check(
    JSON.stringify(data.archives) === JSON.stringify(["data/synthetic.pak", "data/synthetic.zip"]) && data.palette,
    "pak and zip mounted in URL order, palette found",
  );
  check(
    JSON.stringify(data.assetErrors) === JSON.stringify(["data/absent-1.pak: HTTP 404", "data/absent-2.pak: HTTP 404"]),
    "unreachable paks are reported in URL order, not fatal",
  );
  check(JSON.stringify(data.missing) === JSON.stringify(["quack/trim"]), "floor (pak) and wall (deflated zip) textures decoded; trim falls back");
  await shoot("textured", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  // Pure red floor times a white-ish lightmap: green and blue stay near zero (red 79,
  // green and blue 0, measured 2026-10-03). Checker tints never go below 48 per channel,
  // so a fallback cannot pass this.
  const [redFloor] = await floorBoxes([[-256, -112]]);
  console.log(`  textured floor rgb: ${JSON.stringify(redFloor.map(Math.round))}`);
  check(redFloor[0] > 40 && redFloor[1] < 8 && redFloor[2] < 8, "floor shows the pak's palette color (red, lit)");

  // ?map= with a path looks in the mounted archives before the server: maps/packed.bsp
  // exists only inside data/maps.pak. A path in neither fails on the status line.
  await page.goto(`${ORIGIN}/?pak=data/maps.pak&map=maps/packed.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const packed = await page.evaluate(() => ({
    error: window.quack.error,
    map: window.quack.map,
    mapSource: window.quack.mapSource,
    brushModels: window.quack.brushModels,
    integrity: window.quack.integrityErrors,
  }));
  console.log(`  packed map: ${JSON.stringify(packed)}`);
  check(
    !packed.error &&
      packed.mapSource === "data/maps.pak" &&
      packed.integrity.length === 0 &&
      JSON.stringify(packed.brushModels) === JSON.stringify(["func_wall *1 at 0 -320 0"]),
    "?map=maps/packed.bsp loads the BSP from the mounted pak",
  );
  const packedView = await shoot("packed", { origin: [-448, 0, 46], pitch: 0, yaw: 0 });
  check(packedView.clearFraction === 0 && packedView.colors > 100, "the map from the pak renders");
  await page.goto(`${ORIGIN}/?pak=data/maps.pak&map=data/absent-map.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const absent = await page.evaluate(() => ({ error: window.quack.error, status: document.getElementById("status")?.textContent }));
  console.log(`  absent map: ${JSON.stringify(absent)}`);
  check(
    absent.error === ABSENT_MAP_ERROR && absent.status === absent.error,
    "a map in neither the archives nor the server is reported on the status line",
  );

  // A BSP that fails to parse names the archive it came from.
  await page.goto(`${ORIGIN}/?pak=data/maps.pak&map=maps/truncated.bsp`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const truncated = await page.evaluate(() => window.quack.error);
  console.log(`  truncated map: ${JSON.stringify(truncated)}`);
  check(truncated === TRUNCATED_MAP_ERROR, "a corrupt BSP from a pak is reported with the archive's name");

  // The file picker mounts on a running page, in numeric name order, and re-textures.
  // It ships disabled and is enabled only once its listener exists.
  const html = readFileSync(join(dist, "index.html"), "utf8");
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const enabled = await page.evaluate(() => !document.getElementById("pak").disabled);
  check(/id="pak"[^>]*disabled/.test(html) && enabled, "file picker ships disabled and is enabled once the world is up");
  // A slice of a File is a plain Blob, so this counts only reads of a whole picked file.
  await page.evaluate(() => {
    window.wholeFileReads = 0;
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      window.wholeFileReads++;
      return read.call(this);
    };
  });
  await page.setInputFiles("#pak", [
    { name: "pak10.zip", mimeType: "application/zip", buffer: Buffer.from(SYNTHETIC["/data/synthetic.zip"]) },
    { name: "pak9.pak", mimeType: "application/octet-stream", buffer: Buffer.from(SYNTHETIC["/data/synthetic.pak"]) },
  ]);
  await page.waitForFunction(() => window.quack.archives.length === 2, null, { timeout: 10000 });
  const picked = await page.evaluate(() => ({ archives: window.quack.archives, missing: window.quack.missingTextures }));
  console.log(`  picked: ${JSON.stringify(picked)}`);
  check(
    JSON.stringify(picked) === JSON.stringify({ archives: ["pak9.pak", "pak10.zip"], missing: ["quack/trim"] }),
    "file picker mounts in numeric name order and re-textures the running world",
  );
  const wholeFileReads = await page.evaluate(() => window.wholeFileReads);
  check(wholeFileReads === 0, `picked files are read by range, not through File.arrayBuffer (${wholeFileReads} calls)`);

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
console.log(`screenshots in ${outDir}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
