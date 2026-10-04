# Backlog

Milestones in order; each bullet is roughly one session. Chain sessions take them in
order (see CLAUDE.md, Orchestration).

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps sized in float as
the win32 CalcSurfaceExtents does, with the deathmatch light styles animated at 10 Hz
and a face's lightmap composed again only as it is drawn, as ref_gl rebuilds it, warped
surfaces moved per vertex as EmitWaterPolys does, SURF_FLOWING scrolled on warps and on
unwarped opaque faces (DrawGLFlowingPoly) but not unwarped translucent ones, translucent
surfaces blended in R_DrawAlphaSurfaces' order (a brush model's moving with its entity,
where ref_gl draws them at their compiled spot), no lightmap on sky, warp or translucent
faces, the worldspawn sky box drawn where the world's sky faces bound it (R_DrawSkyBox,
with skyrotate/skyaxis, .tga or .pcx images, r_notexture without), PVS (with
R_SetupFrame's second view cluster 16 units below or above the eye), area portals
(closed except those the two settle frames open: START_OPEN doors, and trigger_always
firing portals, doors, secret doors and relays) culling world leafs and brush models,
the world walked per frame as R_RecursiveWorldNode does (R_CullBox on nodes and leafs,
so the sky box is bounded by the sky faces in view), inline brush models where the game
has them after spawn (untargeted plats lowered, START_OPEN doors open, trains at their
first path_corner or a teleport one after it, also when a trigger_always uses them,
turrets turned to rest in their pitch/yaw range with their teams under a MOVETYPE_PUSH
or STOP master), culled by area, PVS and frustum, free-fly camera at the spawn spot and
yaw SelectSpawnPoint gives the first deathmatch player, `.wal` textures and `?map=` BSPs
from mounted pak/zip data (zip64 and self-extractor stubs included), picked archives
read by range, checker fallback, `pnpm smoke`).
Remaining:
- `buildWorldMesh` drops SURF_NODRAW faces; ref_gl has no NODRAW test, so a SKY|NODRAW
  face a compiler emits would bound the sky box there and not here. Check whether qbsp
  or ericw-tools emit such faces before changing it.
- The world walk (`walkWorld`, `WorldDraws.update`) runs every frame and allocates its
  marks and face lists each time; the opaque index list is rebuilt and uploaded whenever
  the walked face set changes. Measured 2026-10-04 in Node 22 on the fixture (25 nodes,
  111 faces), turning so every frame rebuilds: 11.4 us per frame. Measure on a large map.
- The second settle frame's use chains change only area portals and trains here. A
  brush entity a killtarget frees is still drawn, and a door they send up is drawn at
  rest although it starts moving the next frame. Only func_areaportal, doors,
  func_door_secret, trigger_relay and func_train uses are modeled (and a train's
  pathtarget at a corner it reaches at once), and a door's or relay's own "delay"
  always defers its targets (a tiny or negative one can come due within the second
  frame in the game).
- win32 Quake 2 runs every frame at x87 24-bit precision (`_controlfp(_PC_24)` in
  sys_win.c WinMain), which rounds the C's `double` steps to a 24-bit mantissa too
  (unless a GL driver resets it mid-frame; see `lightmapExtents`).
  Ports that follow the C's double (warp.ts, renderer.ts, skyimage.ts, bmodels.ts) match
  SSE builds instead; decide which build is the reference, then audit them.
- A func_train that is a team slave runs its thinks (func_train_find, train_next) at its
  own entity slot in `settleSpawnFrames`; the game runs them in its master's slot, and
  only under a MOVETYPE_PUSH or STOP master (SV_Physics_Pusher). Under a NONE master the
  slave never thinks and stays at its spawn origin; under a TOSS master it takes the
  master's origin (SV_Physics_Toss). `PUSHER_CLASSES` in bmodels.ts has the master
  rule `settleTurrets` uses.
- Malformed entity lumps: when the first entity is not worldspawn, InitBodyQue never runs,
  so entities 1-8 land in the body-queue slots G_FreeEdict refuses to free, and stay in
  the game whatever `inGame` says (spawn spots, teams, targets). ED_ParseEdict also ends
  an entity on any key starting with "}", quoted or not; `parseEntities` does not.
- A light style change scans every face for the styles it uses (`setLightmapStyles`):
  0.7-0.9 ms per 10 Hz step over 5461 faces, measured 2026-10-04 in Node 22 on a
  synthetic map where no face uses the changed style. A per-style face list would make it scale with the
  faces on changed styles. The renderer also composes a drawn brush model's faces that
  face away, which R_DrawInlineBModel skips; same light, extra cost.
- `brushModelInstances` draws an inline model on entity 0 of a malformed map; the engine
  puts that entity in edict 0, which SV_BuildClientFrame never sends (it starts at 1).

## 2. Box trace + pmove
- `checkBspIntegrity` does not detect node cycles; a node whose child leads back to
  itself hangs `pointLeaf`. Needed before trace walks untrusted maps.
- Port `CM_BoxTrace` / `CM_PointContents` against the parsed brushes into `packages/sim`.
- Port `Pmove` (walk, jump, step, crouch, water) using the player box constants.
- Test against fixture geometry: spawn points not in solid, walls stop the box.
- With the trace: a team under a MOVETYPE_TOSS master (misc_gib_*, or a spawnflags-0
  func_object from its third frame) takes the master's origin each frame the master starts
  off the ground (SV_Physics_Toss), so its brush models leave their spawn origin; `settleTurrets`
  keeps them there. Items cut their team chain in droptofloor first, so an item master
  moves no slave.

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
  Compare a screenshot of a real map against the engine before tuning. Warped and
  translucent faces draw as their texture; ref_gl draws min(texture * gl_intensity, 255)
  * inverse_intensity, which caps every channel at 127 at the default intensity 2. Needs a real
  map and the engine running to compare against; the sandbox has neither.
