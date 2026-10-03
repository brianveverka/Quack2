# Quack2

A browser arena shooter that plays Quake 2 deathmatch maps from an open community map
pool. Planned shape: a WebGL2 browser client and an authoritative Node server running a
shared simulation.

Status: early. The BSP parser and a WebGL2 world renderer (lightmaps, PVS culling,
free-fly camera, checker placeholders for every texture) are implemented and tested.
Game data loading, movement, the server, and netcode are not written yet. See
[BACKLOG.md](BACKLOG.md).

## Layout

| Path | What |
| --- | --- |
| `packages/sim` | Shared simulation, runs in browser and Node. BSP v38 parser, entity parser, integrity checks, face/lightmap math, PVS, constants. |
| `packages/client` | Browser client: WebGL2 world renderer and free-fly camera. |
| `packages/server` | Game server (Node, `ws`). Stub. |
| `fixtures/maps` | Test map source (`.map`), its compiled `.bsp`, and a golden dump from ericw-tools. |
| `scripts` | Build ericw-tools and recompile fixtures. |

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck + tests
pnpm dev          # serve the client at http://localhost:8000/ (rebuilds on change)
pnpm smoke        # headless Chromium render test, screenshots in packages/client/dist/smoke
```

The client loads `maps/test_arena.bsp` by default; `?map=<url>` loads another BSP. Click
the view to capture the mouse, WASD to fly, Space/C up and down, Shift to go fast.
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
are not redistributable. Put your own game data under `assets/` (gitignored). Nothing
may require it: the parser, fixtures, and renderer all work without it, and the
renderer draws a checker placeholder for any texture it cannot find.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
