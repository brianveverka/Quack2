# Quack2

A browser arena shooter that plays Quake 2 deathmatch maps from an open community map
pool. Planned shape: a WebGL2 browser client and an authoritative Node server running a
shared simulation.

Status: early. The BSP parser, pak/zip readers, and a WebGL2 world renderer (lightmaps
with animated light styles, warped and translucent surfaces, the sky box, PVS and area portal culling, inline brush models such as doors and plats
drawn where the game has them after spawn and culled by area portal, PVS and view frustum, free-fly camera,
`.wal` textures from game data you mount, checker placeholders for anything missing) are
implemented and tested.
Movement, the server, and netcode are not written yet. See [BACKLOG.md](BACKLOG.md).

## Layout

| Path | What |
| --- | --- |
| `packages/sim` | Shared simulation, runs in browser and Node. BSP v38 parser, entity parser, integrity checks, face/lightmap math, PVS, area portal connectivity, light style table, pak and zip readers, constants. |
| `packages/client` | Browser client: WebGL2 world renderer, free-fly camera, `.wal` and palette decoding, game data mounting. |
| `packages/server` | Game server (Node, `ws`). Stub. |
| `fixtures/maps` | Test map source (`.map`), its compiled `.bsp`, and a golden dump from ericw-tools. |
| `scripts` | Build ericw-tools, recompile fixtures, the smoke test, and writers for the synthetic pak/zip/`.wal`/BSP data tests use. |

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck + tests
pnpm dev          # serve the client at http://localhost:8000/ (rebuilds on change)
pnpm smoke        # headless Chromium render test, screenshots in packages/client/dist/smoke
```

The client loads `maps/test_arena.bsp` by default; `?map=<path or url>` loads another
BSP (see below for maps inside mounted archives). Click the view to capture the mouse,
WASD to fly, Space/C up and down, Shift to go fast.
`pnpm smoke` needs Playwright's Chromium (`pnpm exec playwright install chromium` where
it is not preinstalled).

Rebuilding the fixture BSP needs the ericw-tools map compilers, built locally from a
pinned commit:

```sh
sudo apt-get install cmake g++ libtbb-dev libembree-dev
scripts/build-fixture.sh          # builds .tools/bin on first run
```

## Game data

The repo contains no id Software assets and never will. Quake 2 textures and models
are not redistributable, and that includes the palette. Nothing may require game
data: the parser, fixtures, tests, and renderer all work without it, and tests build
their own synthetic archives and textures.

To see real textures, mount your own `pak0.pak` (or any pak, zip, or pk3) in the
client, either way:

- the file picker at the bottom of the page (mounts on the running page; several files
  mount in name order, pak9 before pak10, later ones overriding earlier ones; a picked
  file is not loaded whole: its directory is read on mount, entries as needed);
- `?pak=<url>`, repeatable, mounted in URL order before the map loads. Files under the
  repo's `assets/` (gitignored) are served at `assets/` by `pnpm dev`, so
  `http://localhost:8000/?pak=assets/pak0.pak` works.

A `?map=` path (no `http:`-style scheme) is looked up in the `?pak=` archives first,
newest mount first, and fetched from the server only if none has it, so
`?pak=assets/pak0.pak&map=maps/q2dm1.bsp` loads the map from the pak. A map found in
neither is reported on the status line. Archives picked with the file picker mount
after the map has loaded, so they only supply textures.

World textures come from `textures/<name>.wal`, the palette from `pics/colormap.pcx`.
A missing `.wal` draws the checker; a `.wal` with no palette mounted draws a checker at
the texture's real size. The sky box comes from the worldspawn `sky` key (default
`unit1_`): `env/<sky><side>.tga`, else `.pcx` (through the palette), for sides `rt`, `bk`,
`lf`, `ft`, `up`, `dn`; a side with neither draws the engine's red-dot `r_notexture`. Problems (unreachable URL, corrupt file) are reported in the
game data line at the bottom of the page and in the console, and never stop the map
from rendering, unless the map itself was to come from the broken archive: then the
map fails on the status line, naming the archive it came from, or listing the
archives that did not mount.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
