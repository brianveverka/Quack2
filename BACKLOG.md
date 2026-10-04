# Backlog

Milestones in order; each bullet is roughly one session. Chain sessions take them in
order (see CLAUDE.md, Orchestration).

## 1. Game data and renderer completeness
The WebGL2 world renderer is in `packages/client` (faces, lightmaps sized in float as
the win32 CalcSurfaceExtents does, with the deathmatch light styles animated at 10 Hz,
warped surfaces moved per vertex as EmitWaterPolys does, translucent surfaces blended in
R_DrawAlphaSurfaces' order, no lightmap on sky, warp or translucent faces, the
worldspawn sky box drawn where the world's sky faces bound it (R_DrawSkyBox, with
skyrotate/skyaxis, .tga or .pcx images, r_notexture without), PVS (with R_SetupFrame's
second view cluster 16 units below or above the eye), area portals (closed except those
the two settle frames open: START_OPEN doors, and trigger_always firing portals, doors,
secret doors and relays) culling world leafs and brush models, the world walked per
frame as R_RecursiveWorldNode does (R_CullBox on nodes and leafs, so the sky box is
bounded by the sky faces in view), inline brush models where the game has them after
spawn (untargeted plats lowered, START_OPEN doors open, trains at their first
path_corner or a teleport one after it, turrets turned to rest in their pitch/yaw range
with their teams), culled by area, PVS and frustum, free-fly camera, `.wal` textures and
`?map=` BSPs from mounted pak/zip data (zip64 and self-extractor stubs included), picked
archives read by range, checker fallback, `pnpm smoke`).
Remaining:
- A targeted func_train that a trigger_always fires (DelayedUse at 0.2 s, the second
  settle frame) also runs train_next before clients see it, so it too jumps on to a
  TELEPORT path_corner after its first; only untargeted and START_ON trains do here.
  `openAreaPortals` (bmodels.ts) already walks the second frame's use chains; add a
  func_train case to its `use` dispatch and share that walk with `brushModelInstances`.
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
- `updateLightmapAtlas` recomposes every face on a changed light style, map-wide;
  ref_gl rebuilds only surfaces it draws. Measured 2026-10-04 in Node 22 on the fixture,
  warmed up: 33-34 ns per luxel with one style per face, about 73 with four, so 50k
  animated luxels cost 2-4 ms per 10 Hz step. Limit it to visible
  faces if large maps show it.
- SURF_FLOWING scrolls only warped faces; ref_gl also scrolls unwarped opaque ones
  (DrawGLFlowingPoly, GL_RenderLightmappedPoly), though not unwarped translucent ones
  (R_DrawAlphaSurfaces uses DrawGLPoly).
- Translucent faces of brush models move with their entity here; ref_gl draws the alpha
  chain with the world matrix, so they stay at their compiled spot. Kept as intended
  (the engine's is a draw bug); revisit if matching it matters. The alpha chain's brush
  models come in instance (map) order; ref_gl uses entity numbers, which differ where
  G_Spawn reused a freed slot.
- `faceVertexIndices` reads surfedge 0 as forward (`e >= 0`); ref_gl's
  GL_BuildPolygonFromSurface and GL_SubdivideSurface read it as reversed (`lindex > 0`).
  Only corrupt maps use edge 0. Likewise `pointLeaf` and `boxLeafs` (sim vis.ts) start at
  `models.headNode[0]`, Mod_PointInLeaf and R_RecursiveWorldNode at node 0; qbsp output
  has both 0.
- `buildWorldMesh` drops SURF_NODRAW faces; ref_gl has no NODRAW test, so a SKY|NODRAW
  face a compiler emits would bound the sky box there and not here. Check whether qbsp
  or ericw-tools emit such faces before changing it.
- The world walk (`walkWorld`, `WorldDraws.update`) runs every frame and allocates its
  marks and face lists each time; the opaque index list is rebuilt and uploaded whenever
  the walked face set changes. Measured 2026-10-04 in Node 22 on the fixture (25 nodes,
  111 faces), turning so every frame rebuilds: 11.4 us per frame. Measure on a large map.
- The second settle frame's use chains change only area portals here. A brush entity a
  killtarget frees is still drawn, and a door they send up is drawn at rest although it
  starts moving the next frame. Only func_areaportal, doors, func_door_secret and
  trigger_relay uses are modeled, and a door's or relay's own "delay" always defers its
  targets (a tiny or negative one can come due within the second frame in the game).
- win32 Quake 2 runs every frame at x87 24-bit precision (`_controlfp(_PC_24)` in
  sys_win.c WinMain), which rounds the C's `double` steps to a 24-bit mantissa too.
  Ports that follow the C's double (warp.ts, renderer.ts, skyimage.ts, bmodels.ts) match
  SSE builds instead; decide which build is the reference, then audit them.

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
  Compare a screenshot of a real map against the engine before tuning. Warped and
  translucent faces draw as their texture; ref_gl draws min(texture * gl_intensity, 255)
  * inverse_intensity, which caps every channel at 127 at the default intensity 2. Needs a real
  map and the engine running to compare against; the sandbox has neither.
