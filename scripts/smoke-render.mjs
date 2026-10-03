#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Headless render smoke test: builds the client, loads the test arena in Chromium
// (WebGL2 through ANGLE/SwiftShader worked without flags, measured 2026-10-03 with
// Chromium 141; the run prints the renderer it got), checks three views by reading back
// pixels, and saves a screenshot of each.
// Usage: node scripts/smoke-render.mjs [outdir]   (default packages/client/dist/smoke)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages/client/dist");
const outDir = resolve(process.argv[2] ?? join(dist, "smoke"));
const ORIGIN = "http://quack.test";
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
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
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
  const floor = await page.evaluate(() => {
    window.quack.setView({ origin: [-448, 0, 46], pitch: 0, yaw: 0 });
    const { width, data } = window.quack.readPixels();
    const box = (wx, wy) => {
      const p = window.quack.project(wx, wy, 0);
      if (!p) return NaN;
      let sum = 0, n = 0;
      for (let y = Math.round(p[1]) - 15; y <= Math.round(p[1]) + 15; y++) {
        for (let x = Math.round(p[0]) - 15; x <= Math.round(p[0]) + 15; x++) {
          const i = (y * width + x) * 4;
          sum += data[i] + data[i + 1] + data[i + 2];
          n++;
        }
      }
      return sum / n;
    };
    return { shadow: box(-312, 0), lit: box(-256, -112) };
  });
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

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
console.log(`screenshots in ${outDir}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
