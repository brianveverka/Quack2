// SPDX-License-Identifier: GPL-2.0-or-later
// Bundles the client into dist/ with the fixture maps beside it, and links dist/assets
// to the repo's gitignored assets/ when present so ?pak=assets/<file> works when served.
// Usage: node build.mjs [--serve [port]]   (--serve rebuilds on change and serves dist/)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = here + "dist/";
const maps = fileURLToPath(new URL("../../fixtures/maps/", import.meta.url));
const assets = fileURLToPath(new URL("../../assets", import.meta.url));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist + "maps", { recursive: true });
cpSync(here + "index.html", dist + "index.html");
for (const f of readdirSync(maps)) if (f.endsWith(".bsp")) cpSync(maps + f, dist + "maps/" + f);
// A link, not a copy: game data can be hundreds of MB.
if (existsSync(assets)) symlinkSync(assets, dist + "assets", "junction");

const options = {
  entryPoints: [here + "src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  outfile: dist + "main.js",
  logLevel: "info",
};
const serve = process.argv.indexOf("--serve");
if (serve < 0) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const port = Number(process.argv[serve + 1]) || 8000;
  const { hosts } = await ctx.serve({ servedir: dist, port });
  console.log(`serving http://${hosts[0] ?? "localhost"}:${port}/`);
}
