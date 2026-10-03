#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Headless render smoke test: builds the client, loads the test arena in Chromium
// (WebGL2 through ANGLE/SwiftShader worked without flags, measured 2026-10-03 with
// Chromium 141; the run prints the renderer it got), checks three views by reading back
// pixels, and saves a screenshot of each. It checks the fixture's func_wall is drawn,
// and drawn at a moved entity origin in a copy of the map. Another load mounts synthetic
// game data (a pak and a deflated zip built here, never id data) and checks the textures
// arrive.
// Usage: node scripts/smoke-render.mjs [outdir]   (default packages/client/dist/smoke)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { syntheticPalette, withEntityString, writePak, writePalettePcx, writeWal, writeZip } from "./synthetic-data.mjs";

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
  // Chromium logs every failed fetch as a console error; the deliberate 404 below is expected.
  page.on("console", (m) => m.type() === "error" && !m.location().url.includes("/data/absent-") && errors.push(m.text()));
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
      let clear = 0;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 64 && data[i + 1] === 0 && data[i + 2] === 64) clear++;
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return { ...window.quack.stats, worldFaces: window.quack.worldFaces, clearFraction: clear / (width * height), colors: colors.size };
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

  // Outside the map: cluster -1 draws every face, and the void shows the background.
  const outside = await shoot("outside", { origin: [1200, 0, 400], pitch: 20, yaw: 180 });
  check(outside.cluster === -1 && outside.visibleFaces === outside.worldFaces, "outside the map, every world face is drawn");
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
  /** Stats and the RGB of a 31x31 pixel box around the projected point, per wall view. */
  const wallBoxes = async (prefix) => {
    const out = [];
    for (const { name, view, point } of WALL_VIEWS) {
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
  console.log(`  brush models: ${JSON.stringify(compiled[0].brushModels)}, stats ${JSON.stringify(compiled[0].stats)}`);
  check(
    JSON.stringify(compiled[0].brushModels) === JSON.stringify(["func_wall *1 at 0 0 0"]) && compiled.every((r) => r.stats.brushModels === 1),
    "the fixture's func_wall is placed from the entity string and drawn",
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

  // The file picker mounts on a running page, in numeric name order, and re-textures.
  // It ships disabled and is enabled only once its listener exists.
  const html = readFileSync(join(dist, "index.html"), "utf8");
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.quack?.ready || window.quack?.error, null, { timeout: 30000 });
  const enabled = await page.evaluate(() => !document.getElementById("pak").disabled);
  check(/id="pak"[^>]*disabled/.test(html) && enabled, "file picker ships disabled and is enabled once the world is up");
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

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
console.log(`screenshots in ${outDir}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
