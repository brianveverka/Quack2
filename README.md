# Quack2

A browser arena shooter that plays Quake 2 deathmatch maps from an open community map
pool. Planned shape: a WebGL2 browser client and an authoritative Node server running a
shared simulation.

Status: early scaffold. The BSP parser is implemented and tested; the client, server,
renderer, movement, and netcode are not written yet. See [BACKLOG.md](BACKLOG.md).

## Layout

| Path | What |
| --- | --- |
| `packages/sim` | Shared simulation, runs in browser and Node. BSP v38 parser, entity parser, integrity checks, constants. |
| `packages/client` | Browser client (WebGL2). Stub. |
| `packages/server` | Game server (Node, `ws`). Stub. |
| `fixtures/maps` | Test map source (`.map`), its compiled `.bsp`, and a golden dump from ericw-tools. |
| `scripts` | Build ericw-tools and recompile fixtures. |

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck + tests
```

Rebuilding the fixture BSP needs the ericw-tools map compilers, built locally from a
pinned commit:

```sh
sudo apt-get install cmake g++ libtbb-dev libembree-dev
scripts/build-fixture.sh          # builds .tools/bin on first run
```

## Game data

The repo contains no id Software assets and never will. Quake 2 textures and models
are not redistributable. Put your own game data under `assets/` (gitignored). Nothing
may require it: the parser and fixtures already work without it, and the renderer
(not yet written) must fall back to a placeholder for any missing texture.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
