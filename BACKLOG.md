# Backlog

Milestones in order. Each is roughly one session; split further when starting it.

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps, PVS, free-fly
camera, `.wal` textures from mounted pak/zip data, checker fallback, `pnpm smoke`).
Remaining:
- `?map=` only fetches a URL; it does not look inside mounted archives, so
  `maps/q2dm1.bsp` from a mounted pak0 cannot be loaded yet.
- Brightness is not checked against the engine: GL Quake 2 scales textures by
  `gl_intensity` (default 2) and the lightmap blend differs from a plain multiply.
  Compare a screenshot of a real map against the engine before tuning.
- Archives are read whole into memory (a full pak0.pak is a few hundred MB). Reading
  entries lazily from a `Blob` would avoid that for the file picker.
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
