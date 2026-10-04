# Backlog

Milestones in order; each bullet is roughly one session. Chain sessions take them in
order (see CLAUDE.md, Orchestration).

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps, PVS, inline brush
models where the game has them after spawn (untargeted plats lowered, START_OPEN
doors open, trains at their first path_corner or a teleport one after it), culled by
PVS and frustum, free-fly camera, `.wal` textures and `?map=` BSPs from mounted pak/zip
data (zip64 and self-extractor stubs included), picked archives read by range, checker
fallback, `pnpm smoke`).
Remaining:
- turret_breach (and its teamed turret_base) turns from its spawn angles into its
  minpitch/maxpitch and minyaw/maxyaw range over the first seconds
  (g_turret.c turret_breach_think); drawn at its spawn angles here. Needs entity think
  over time, or at least the resting angles it turns to.
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
- A targeted func_train that a trigger_always fires (DelayedUse at 0.2 s, the second
  settle frame) also runs train_next before clients see it, so it too jumps on to a
  TELEPORT path_corner after its first; only untargeted and START_ON trains do here.
  Needs a search for what targets the train.

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

## Needs Brian
- Brightness is not checked against the engine: GL Quake 2 scales textures by
  `gl_intensity` (default 2) and the lightmap blend differs from a plain multiply.
  Compare a screenshot of a real map against the engine before tuning. Needs a real
  map and the engine running to compare against; the sandbox has neither.
