# Backlog

Milestones in order. Each is roughly one session; split further when starting it.

## 1. Renderer
- WebGL2 world renderer in `packages/client`: faces from the BSP (surfedges -> polygons),
  lightmaps from the lighting lump, PVS culling from the visibility lump.
- Asset loading: pak and zip archives, `.wal` textures with the Q2 palette.
  Missing textures fall back to a placeholder, never an error.
- Free-fly camera, loads `fixtures/maps/test_arena.bsp`.
- Headless Chromium + SwiftShader smoke test (WebGL2 worked in the cloud sandbox,
  Playwright 1.56.1 / Chromium 141, measured 2026-10-03).
- Integrity check that each face's lightmap (extents x styles) fits in the lighting lump;
  needs the face extent math the renderer adds anyway.

## 2. Box trace + pmove
- Port `CM_BoxTrace` / `CM_PointContents` against the parsed brushes into `packages/sim`.
- Port `Pmove` (walk, jump, step, crouch, water) using the player box constants.
- Test against fixture geometry: spawn points not in solid, walls stop the box.

## 3. Server and netcode
- Authoritative server in `packages/server` over `ws`, fixed tick.
- Client prediction and reconciliation using the shared pmove.
- Snapshot delta compression, entity interpolation.

## 4. Weapons
- Hitscan and projectile weapons, damage, armor, item pickups and respawn.
- Spawn selection from `info_player_deathmatch`.

## 5. Map pool and rotation
- Fetch maps from the open community pool at runtime, with license metadata per map.
- Map rotation and voting on the server.
