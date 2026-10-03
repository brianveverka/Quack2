# Backlog

Milestones in order. Each is roughly one session; split further when starting it.

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps, PVS, free-fly
camera, checker placeholders, `pnpm smoke`). Remaining:
- Asset loading: pak and zip archives, `.wal` textures with the Q2 palette, plugged in
  as a `TextureSource` (`packages/client/src/textures.ts`). Missing textures keep falling
  back to the checker. Real texture sizes then replace the 64x64 placeholder scale.
- Inline brush models (`*1`.. on func_wall, doors, plats) are not drawn; the fixture's
  func_wall (model 1) is invisible.
- Only light style 0 is drawn; styles 1-3 (switchable and animated lights) are ignored.
- Surface flags: SURF_SKY, SURF_WARP, SURF_TRANS33/66 draw as ordinary opaque faces
  (NODRAW is skipped). Needs a sky box, warp shader, and a sorted translucent pass.
- No area portal (areabits) or frustum culling; PVS only. The engine's second view
  cluster near water surfaces (R_MarkLeaves `viewcluster2`) is not handled either.
- `lightmapExtents` computes in double, the engine in float; may differ by a luxel on
  non-axial texinfo. Check against a map with rotated or scaled textures.

## 2. Box trace + pmove
- `checkBspIntegrity` does not detect node cycles; a node whose child leads back to
  itself hangs `pointLeaf`. Needed before trace walks untrusted maps.
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
