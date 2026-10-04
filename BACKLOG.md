# Backlog

Milestones in order. Each is roughly one session; split further when starting it.

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps, PVS, inline brush
models at their entity origin and spawn angles, culled by PVS and frustum, free-fly
camera, `.wal` textures and `?map=` BSPs from mounted pak/zip data, picked archives read
by range, checker fallback, `pnpm smoke`).
Remaining:
- Brightness is not checked against the engine: GL Quake 2 scales textures by
  `gl_intensity` (default 2) and the lightmap blend differs from a plain multiply.
  Compare a screenshot of a real map against the engine before tuning.
- Zips with a prepended stub whose offsets were not adjusted (unfixed SFX) and zip64
  archives (Info-ZIP `-fz`, stdin) are rejected; Python's zipfile opens the former.
- Brush models are placed by their spawn "origin" and angles, but the game moves
  some at spawn: an untargeted func_plat starts lowered (g_func.c SP_func_plat), a
  START_OPEN door or func_water starts open (a START_OPEN func_door_rotating starts
  turned to its open angles), a func_train snaps to its first path_corner, a
  turret_breach (and its turret_base) turns from its spawn angles into its
  minpitch/maxpitch and minyaw/maxyaw range over the first seconds
  (turret_breach_think). Needs entity spawn state, with movers.
- Entity keys match case sensitively; the game's ED_ParseField uses Q_stricmp, so a
  map with "Origin" or "Angle" places the entity differently here, and one with
  "Model" is not drawn.
- Only light style 0 is drawn; styles 1-3 (switchable and animated lights) are ignored.
- Surface flags: SURF_SKY, SURF_WARP, SURF_TRANS33/66 draw as ordinary opaque faces
  (NODRAW is skipped). Needs a sky box, warp shader, and a sorted translucent pass.
- No area portal (areabits) culling, for the world or brush models (the server also
  drops entities behind a closed door's area portal); no frustum culling of the world.
  The engine's second view cluster near water surfaces (R_MarkLeaves `viewcluster2`) is
  not handled either.
- The world's PVS is the eye's own cluster; brush models use a fat PVS reaching past
  the near plane. An eye within a few units of a thin wall can show world faces of a
  cluster the eye's one does not see. Use the same fat PVS for the world.
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
- Entity angle precision: the engine sends angles as one byte (MSG_WriteAngle, 360/256
  degree steps, truncated), so brush models draw up to one step off their exact
  angles, which the renderer uses now. Decide whether to match it.

## 4. Weapons
- Hitscan and projectile weapons, damage, armor, item pickups and respawn.
- Spawn selection from `info_player_deathmatch`.

## 5. Map pool and rotation
- Fetch maps from the open community pool at runtime, with license metadata per map.
- Map rotation and voting on the server.
