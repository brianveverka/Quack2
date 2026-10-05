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
firing portals, doors, secret doors, relays and the trigger_once, trigger_multiple,
trigger_counter, func_timer and target_explosion entities that pass a use on (the last
two also from their own think when due), a "delay" on the way firing in the
second frame when due by then and G_Spawn puts its DelayedUse in a slot still ahead;
a door's door_hit_bottom closes its own again in the game frame it is back down) culling world leafs and brush models,
brush entities a killtarget frees in the settle frames left out, and func_wall and
func_object entities a use there shows or hides drawn or left out to match,
the world walked per frame as R_RecursiveWorldNode does (R_CullBox on nodes and leafs,
so the sky box is bounded by the sky faces in view), inline brush models where the game
has them after spawn (untargeted plats lowered, START_OPEN doors open, trains where the
settle frames' func_train_find and train_next leave them (a team slave's run in its
MOVETYPE_PUSH or STOP master's teamchain walk, under any other master not at all), also when a trigger_always uses them
or a trigger_elevator sends them on toward its user's "pathtarget" (train_resume),
turrets turned to rest in their pitch/yaw range, in float, with their teams under a MOVETYPE_PUSH
or STOP master, until a settle-frame free stops the team or cuts its chain), the doors
the settle frames send moving drawn moving (linear ones accelerating as Think_AccelMove does when accel or decel differs from speed, rotating ones
turning as AngleMove_Calc does, their angles sent in 360/256 degree steps and blended by
LerpAngle), also in teams with other members, and the plats that are no team's slave a
use there sends down (Use_Plat, accelerating as Think_AccelMove does when accel or decel
differs from speed, else at a constant speed per second; the sim also has plat_go_up
and plat_hit_top's 3 s return), and the buttons that are no team's slave a use there
fires (button_fire up, button_wait, and button_return back down after "wait"), and
the trains that are no team's slave, from where the settle frames leave them (train_next
moving the train's mins corner to corner, train_wait's "wait", a TELEPORT corner drawn
unblended as CL_DeltaEntity does for EV_OTHER_TELEPORT), and the func_rotating entities
that are no team's slave nor on a turret_breach's team, turning by the avelocity START_ON
gives them at spawn and the settle frames' uses toggle (rotating_use), from where those
frames turned them
(`brushMovers`, stepped at the 10 Hz game
frame by `BrushMotion` and blended as CL_AddPacketEntities does, re-linked each frame
they move or turn), culled by area, PVS and
frustum, free-fly camera at the spawn spot and yaw SelectSpawnPoint gives the first
deathmatch player, `.wal` textures and `?map=` BSPs from mounted pak/zip data (zip64
and self-extractor stubs included), picked archives read by range, checker fallback,
`pnpm smoke`).
Remaining:
- Malformed entity lumps, body queue: G_FreeEdict refuses the first BODY_QUEUE_SIZE (8)
  edicts after the clients, which InitBodyQue fills when entity 0 is worldspawn. Otherwise
  the first 8 G_Spawns of SpawnEntities take them (map entities 1 on, the edicts spawn
  functions G_Spawn, such as a trigger_always's DelayedUse; list them from the source),
  and those entities stay in use whatever `inGame` says: NOT_DEATHMATCH ones whose
  spawn function never ran, and ones their spawn function frees partly spawned. G_Find and
  G_FindTeams still find them (spawn spots, teams, targets), and a killtarget cannot
  free them. An empty entity ("{ }") is zeroed by ED_ParseEdict and leaves its edict free.
- Malformed entity lumps, edict 0: entity 0 fills edict 0 whatever its classname, and
  only SP_worldspawn marks it in use, so otherwise G_RunFrame never runs it and G_Find
  skips it, though its spawn function's side effects stand (a trigger_always's
  DelayedUse). `settleSpawnFrames` runs it in slot 0 and finds it by "targetname". A
  later worldspawn entity runs SP_worldspawn (InitBodyQue, CS_SKY and the other
  configstrings), which `skySettings` ignores.
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
  door, plat, train, func_rotating or portal they target stays as the settle frames left it, and a
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
- The settle frames' use budget (MAX_USES in bmodels.ts) is per entity slot run, so a
  hostile map with many trigger_always each setting off a branching trigger_relay loop
  (which crashes the game) costs about 160 ms each to load, measured 2026-10-04 in Node 22.
  One budget for the whole frame would bound it, at the cost of starving later uses on
  such maps.
- `settleSpawnFrames` ends a pusher master's teamchain walk (turret frees, `runThink`) at
  the first freed member. In the game, the member before it still points at that edict,
  so if a G_Spawn later in the frame refills it (a DelayedUse), the master's slot runs
  the new edict's think, earlier than its own slot would.
- A `.pcx` sky side is mapped through the palette and resampled as GL_Upload8's
  non-paletted branch does, but R_SetSky loads .pcx only with gl_ext_palettedtexture on,
  where GL_Upload8 uploads the indices as GL_COLOR_INDEX8_EXT at their own size (no
  index-255 fix, no GL_ResampleTexture). Same result for a 256x256 side without index 255;
  the skyimage.ts header says otherwise.
- `main.ts` passes `setTime` fractional milliseconds (performance.now()); the client's
  cl.time is an int of ms (cl_view.c `cl.refdef.time = cl.time*0.001`), so warp and sky
  times fall between the values the engine can produce.
- Uses in the first settle frame are not modeled: a START_ON func_timer whose
  1 + pausetime + delay + wait is due by 0.1 thinks there (`runThink`), firing nothing,
  where the game fires its targets in that frame. Nor is target_explosion_explode's
  T_RadiusDamage (a "dmg" above 0), which needs the damaged entities' bounds.
- A func_rotating that is a team slave, or on a turret_breach's team, is left out of
  `brushMovers` and drawn at its spawn angles (plus the breach's yaw), and a settle-frame
  use of it does nothing. The game turns a slave by its own avelocity in its master's
  SV_Physics_Pusher (only under a PUSH or STOP master; under any other it never turns),
  and turret_breach_think sets every member's yaw velocity each frame, overriding a
  func_rotating's own spin about yaw.
- A turret team stops at the first think that meets a breach angle of 2^27 or more
  (`NORMALIZE_LIMIT` in bmodels.ts), where the game's AnglesNormalize steps round and
  run 370000 times a frame or more (forever above 2^33). Port the rounding steps if a map needs it.
- `entityAngles` parses an "angles" vector to double and then to float (Math.fround);
  ED_ParseField's sscanf "%f" rounds the decimal to float once, so a value near a
  midpoint between two floats differs ("1.00000005960464477539062501": sscanf gives the
  float above 1, the port 1; gcc, 2026-10-05).
  Every float port reading "angles" (turret breaches, moveDir) shares it.
- A func_train that is a team slave is left out of `brushMovers` and drawn where the
  settle frames leave it; in the game it moves on in its PUSH or STOP master's walk
  (SV_Physics_Pusher), pushed with the team. Under a func_door or func_door_rotating
  master its speeds are NaN (Think_CalcMoveSpeed), so each move goes through
  Think_AccelMove with NaN speeds.
- COM_Parse keeps 128 characters of a quoted token (and writes its terminator one byte
  past com_token) and discards a bare word of 128 characters or more (empty token);
  `parseEntities` keeps every token whole, so a long "targetname" or "target" matches
  differently.
- COM_Parse reads `*data` as a signed char, so it skips bytes 0x80-0xFF as whitespace
  and ends a bare word at one; `parseEntities` (on `decodeLatin1` text) keeps them in a
  word, so `{ "a" "1" }\xe9` parses in the game and throws here (gcc -O0, 2026-10-05).
  A lump ending inside a final quoted `"}...` key also closes its entity in the game (its
  first character is `}`), and the next COM_Parse starts past the lump's terminator, so
  what follows depends on memory beyond the lump; `parseEntities` throws.

## 2. Box trace + pmove
- `checkBspIntegrity` does not detect node cycles; a node whose child leads back to
  itself hangs `pointLeaf`. Needed before trace walks untrusted maps.
- Port `CM_BoxTrace` / `CM_PointContents` against the parsed brushes into `packages/sim`.
- Port `Pmove` (walk, jump, step, crouch, water) using the player box constants.
- Test against fixture geometry: spawn points not in solid, walls stop the box.
- Nothing blocks a push: no door_blocked, plat_blocked or train_blocked, and
  Think_AccelMove's restart of a blocked move (current_speed 0) never happens. SV_Push
  finds a block with SV_TestEntityPosition, a box trace against the world and solid
  entities, the pusher among them; on one SV_Physics_Pusher bumps the team's nextthinks
  and runs none of its thinks that frame. Without clients or monsters the obstacles are
  items, func_objects, target_blaster bolts and what a target_spawner spawns
  (misc_explobox frees itself in deathmatch; gibs and debris are SOLID_NOT, never linked,
  so SV_Push skips them). door_blocked, plat_blocked, train_blocked and
  door_secret_blocked free them (T_Damage, BecomeExplosion1) without turning the move
  back, while rotating_blocked and turret_blocked only damage, so an item stays and
  blocks a func_rotating or turret every frame. Only a client or monster obstacle sends
  a door back (door_go_up/down, unless DOOR_CRUSHER or a negative "wait") or a plat
  (plat_go_up/down), restarting Move_Calc or AngleMove_Calc, which needs pmove. Where
  items rest needs droptofloor's trace too.
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
