# Backlog

Milestones in order; each bullet is roughly one session. Chain sessions take them in
order (see CLAUDE.md, Orchestration).

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps, PVS, inline brush
models where the game has them after spawn (untargeted plats lowered, START_OPEN
doors open, trains at their first path_corner or a teleport one after it, turrets
turned to rest in their pitch/yaw range with their teams), culled by
PVS and frustum, free-fly camera, `.wal` textures and `?map=` BSPs from mounted pak/zip
data (zip64 and self-extractor stubs included), picked archives read by range, checker
fallback, `pnpm smoke`).
Remaining:
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
- A turret team whose master (first member) is not a turret keeps its spawn angles here;
  the game runs it under the master's movetype (a MOVETYPE_NONE or TOSS master never
  runs the slaves' thinks, a PUSH one does). Needs the movetype per spawn function. Of
  the entities their spawn function frees in deathmatch, team membership leaves out only
  lights and func_explosive; monsters, misc_explobox, target_secret/goal/help and
  dmflags-removed items still count, and pickTarget counts all of them. An inverted
  pitch range (minpitch > maxpitch) makes the game's clamp flip move_angles between the
  two limits every frame, forever; here it runs to the frame cap (pitch by parity) or
  stops on a zero-step frame.
- The free-fly camera's spawn yaw (main.ts `spawnPoint`) reads only "angle", through
  Number() rather than atof; it ignores "angles" and the later-key rule that
  `entityAngles` implements.

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
