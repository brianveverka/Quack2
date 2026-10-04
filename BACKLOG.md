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
faces, SURF_NODRAW faces drawn like any other (ref_gl has no NODRAW test), the
worldspawn sky box drawn where the world's sky faces bound it (R_DrawSkyBox, with
skyrotate/skyaxis, .tga or .pcx images, r_notexture without), PVS (with
R_SetupFrame's second view cluster 16 units below or above the eye), area portals
(closed except those the two settle frames open: START_OPEN doors, and trigger_always
firing portals, doors, secret doors and relays; a door's door_hit_bottom closes its own
again in the game frame it is back down) culling world leafs and brush models,
brush entities a killtarget frees in the settle frames left out, and func_wall and
func_object entities a use there shows or hides drawn or left out to match,
the world walked per frame as R_RecursiveWorldNode does (R_CullBox on nodes and leafs,
so the sky box is bounded by the sky faces in view), inline brush models where the game
has them after spawn (untargeted plats lowered, START_OPEN doors open, trains where the
settle frames' func_train_find and train_next leave them, also when a trigger_always uses them,
turrets turned to rest in their pitch/yaw range with their teams under a MOVETYPE_PUSH
or STOP master), the doors the settle frames send moving drawn moving (linear ones
accelerating as Think_AccelMove does when accel or decel differs from speed, rotating ones
turning as AngleMove_Calc does, their angles sent in 360/256 degree steps and blended by
LerpAngle), also in teams with other members, and the plats that are no team's slave a
use there sends down (Use_Plat, accelerating as Think_AccelMove does when accel or decel
differs from speed, else at a constant speed per second; the sim also has plat_go_up
and plat_hit_top's 3 s return), and the buttons that are no team's slave a use there
fires (button_fire up, button_wait, and button_return back down after "wait"), and
the trains that are no team's slave, from where the settle frames leave them (train_next
moving the train's mins corner to corner, train_wait's "wait", a TELEPORT corner drawn
unblended as CL_DeltaEntity does for EV_OTHER_TELEPORT)
(`brushMovers`, stepped at the 10 Hz game
frame by `BrushMotion` and blended as CL_AddPacketEntities does, re-linked each frame
they move or turn), culled by area, PVS and
frustum, free-fly camera at the spawn spot and yaw SelectSpawnPoint gives the first
deathmatch player, `.wal` textures and `?map=` BSPs from mounted pak/zip data (zip64
and self-extractor stubs included), picked archives read by range, checker fallback,
`pnpm smoke`).
Remaining:
- Only func_areaportal, doors, func_door_secret, trigger_relay, func_train, func_wall and
  func_object uses are modeled in the settle frames (and a train's pathtarget at a
  corner it reaches at once), and a door's or relay's own "delay" always defers its
  targets (a tiny or negative one can come due within the second frame in the game).
- A team whose master a settle-frame killtarget frees stops moving from that frame (its
  members move and think only through the master's SV_Physics_Pusher), but
  `settleTurrets` ignores frees: a freed breach master is left out while its team is
  drawn turned to rest.
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
  rule `settleTurrets` uses. `brushMovers` leaves a slave train out, drawn where the
  settle frames leave it.
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
- A placed brush model's clusters (`PlacedInstance.clusters`, `boxClusters` in cull.ts)
  come from `instanceBox` (the corner-radius cube when turned, no extra unit at rest);
  SV_LinkEdict takes them from absmin/absmax, which `linkBox` gives. Same on the
  fixture (360 placements, 5 origins by yaw 0..355, 2026-10-04); a larger map can send
  a door the server would not.
- turret_breach_think sets every team member's avelocity[1] to the breach's each frame,
  overriding a func_door_rotating teammate's own turn; `brushMovers` seeds such a door
  with the breach's at-rest yaw, but the mover does not model the override, so the door
  turns its yaw back to its start or end angles as it moves. The seed is also the yaw
  at rest, not after the two settle frames: a slow breach reaches it later in the game.
- A func_door_secret the settle frames open never moves, so its portals stay open: in
  the game it moves out and back (door_secret_move1..6) and door_secret_done closes
  them (door_use_areaportals false) unless its "wait" is -1, about 5 s after by default.
- A func_plat or func_button that is a team slave is left out of `brushMovers` and
  drawn where it spawned. A door master's door_use runs door_go_up on it, which moves
  only func_door and func_door_rotating: a member at STATE_BOTTOM is set to STATE_UP
  unmoved and fires its targets, so a button ignores button_fire until a DOOR_TOGGLE
  master's next door_use runs door_go_down (STATE_DOWN, again unmoved); a targeted plat
  starts at STATE_UP, so door_go_up returns at once and fires nothing; a button in its
  wait (STATE_TOP) has button_return put off by its "wait". Under a door master
  Think_CalcMoveSpeed gives it NaN speed, accel and decel (its moveinfo.distance 0
  makes the team's time 0), so a move its own Use_Plat or button_fire starts goes
  through Think_AccelMove with NaN. Any such move runs its thinks in its master's slot
  (SV_Physics_Pusher), as a slave train's would.
- button_wait fires the button's targets (G_UseTargets) when it reaches the top, and
  train_wait a corner's "pathtarget" when a train reaches it, after the settle frames:
  nothing models uses after them (a train mover's `usePathtarget` is dropped), so a
  door, plat, train or portal they target stays as the settle frames left it, and a
  train a corner's killtarget frees after them goes on moving where the game frees it.
- Texture animation is not drawn: no texinfo `nexttexinfo` chain is followed.
  R_TextureAnimation steps world faces at 2 Hz, and a brush entity's faces by the frame
  CL_AddPacketEntities picks: from EF_ANIM01 (0/1), EF_ANIM23 (2/3) or EF_ANIM_ALL at
  2 Hz, EF_ANIM_ALLFAST at 10 Hz, else s.frame. A button cycles 0/1 at rest and 2/3
  from button_wait until button_done.
- CL_DeltaEntity also skips the blend when an entity's origin moves more than 512 units
  on an axis between two frames (abs of the float difference, as an int); `BrushMotion`
  blends it (a fast train, or a door team's infinite speeds).
- A train's corner lookup (`pathCorner`) takes the first entity with the targetname,
  where G_PickTarget picks one of up to 8 at random (rand() % count), and reads a
  non-train entity's spawn origin and target, not its live ones: a START_OPEN func_door
  or func_water is at pos2 from spawn, an item droptofloor moves in frame 2, a door or
  plat moving after the settle frames. It also snapshots target_ent's origin where
  train_resume reads it live, and a slave train or one with no inline model, which
  `brushMovers` leaves out, keeps the origin the settle frames left it.

## 2. Box trace + pmove
- `checkBspIntegrity` does not detect node cycles; a node whose child leads back to
  itself hangs `pointLeaf`. Needed before trace walks untrusted maps.
- Port `CM_BoxTrace` / `CM_PointContents` against the parsed brushes into `packages/sim`.
- Port `Pmove` (walk, jump, step, crouch, water) using the player box constants.
- Test against fixture geometry: spawn points not in solid, walls stop the box.
- Nothing blocks a push: no door_blocked, plat_blocked or train_blocked, and
  Think_AccelMove's restart of a blocked move (current_speed 0) never happens. SV_Push
  finds a block with SV_TestEntityPosition, a box trace against the world and solid
  entities, the pusher among them; on one SV_Physics_Pusher bumps the team's nextthinks and runs none of its
  thinks that frame. Without clients or monsters the obstacles are items, func_objects
  and misc_explobox, which every *_blocked frees (T_Damage, BecomeExplosion1) without
  turning the move back; where they rest needs droptofloor's trace as well. Only a
  client or monster obstacle sends a door or plat back (door_go_up/down, so Move_Calc's
  restart), which needs pmove.
- With the trace: a team under a MOVETYPE_TOSS master (misc_gib_*, or a spawnflags-0
  func_object from its third frame) takes the master's origin each frame the master starts
  off the ground (SV_Physics_Toss), so its brush models leave their spawn origin; `settleTurrets`
  keeps them there. Items cut their team chain in droptofloor first, so an item master
  moves no slave. A func_object a settle-frame use shows turns MOVETYPE_TOSS and falls
  the same way, and the KillBox a func_wall or func_object runs as a use shows it damages
  what its box overlaps; neither is modeled (`wallUse`).

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
- Measure the world walk (`WorldWalk.walk`, `WorldDraws.update`) on a large real map.
  Measured 2026-10-04 only on synthetic kd-trees with no PVS (esbuild bundle, Node 22,
  cull on): 16380 faces, 130-170 us walk and 45-60 us update per frame; 65532 faces,
  570-610 us and 210-235 us (bench not committed; vitest reads 2-5x slower than plain
  node). The sandbox has no game data.
