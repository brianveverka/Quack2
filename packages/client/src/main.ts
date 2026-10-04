// SPDX-License-Identifier: GPL-2.0-or-later
// Browser entry: mounts game data (?pak=<url>, repeatable, later overrides earlier),
// loads a BSP (?map=<path or url>, default the bundled test arena; a path in the mounted
// archives wins over the same path on the server), spawns a free-fly camera at the
// player start, and renders until the page closes. The file picker mounts more archives
// at any time and re-textures the world and the sky. Click to capture the mouse; WASD to fly,
// Space/C up/down, Shift fast.

import { DEATHMATCH_LIGHTSTYLES, GameFs, checkBspIntegrity, lightStyleValues, entityVec3, parseBsp, parseEntities, type BspEntity } from "@quack2/sim";
import { MapLoadError, errorMessage, loadMap, loadSkyImages, loadWalTextures, openGameArchive } from "./assets.js";
import { brushModelInstances, openAreaPortals } from "./bmodels.js";
import { FlyCamera } from "./camera.js";
import { transformPoint } from "./math.js";
import { WorldRenderer, type FrameStats, type View } from "./renderer.js";
import { skySettings, type SkySettings } from "./sky.js";
import { noTextures } from "./textures.js";

/** Eye height above the player origin (Q2 viewheight while standing). */
const VIEW_HEIGHT = 22;
const MOUSE_SENSITIVITY = 0.15;

/** Debug surface for the headless smoke test and the console. */
export interface QuackDebug {
  ready: boolean;
  error?: string;
  map?: string;
  /** Where the map was read from: a mounted archive's name, or the URL fetched. */
  mapSource?: string;
  frames: number;
  stats?: FrameStats;
  missingTextures?: readonly string[];
  /** Mounted archive names, oldest (lowest priority) first. */
  archives: string[];
  /** Whether a palette (pics/colormap.pcx) was found in the mounted data. */
  palette: boolean;
  /** Non-fatal game data problems: archives that failed to mount, corrupt files. */
  assetErrors: string[];
  /** Drawable faces in the world model: what a view with no PVS culling draws. */
  worldFaces?: number;
  /** Brush model instances placed from the entity string, e.g. ["func_wall *1 at 0 0 0"], with " angles p y r" when rotated. */
  brushModels?: readonly string[];
  integrityErrors?: readonly string[];
  view(): View;
  setView(view: View): void;
  /** Pixel (x right, y up from the bottom row) of a world point in the last frame, or undefined behind the eye. */
  project(x: number, y: number, z: number): [number, number] | undefined;
  /** Render one frame now and return its RGBA pixels, bottom row first. */
  readPixels(): { width: number; height: number; data: Uint8Array };
  /** Turn brush model culling on (the default) or off. */
  setCull(on: boolean): void;
  /** Area portals the game opened at spawn (their numbers, ascending); the rest are closed. */
  openPortals?: readonly number[];
  /** Ignore area portals, connecting every area (the server's map_noareas), or not (the default). */
  setNoAreas(on: boolean): void;
  /** Hold the level clock (light styles, warps) at `ms` since the map loaded, or let it run again (undefined). */
  setLevelTime(ms: number | undefined): void;
  /** Faces whose lightmap the last frame uploaded because a light style changed. */
  lightmapUploads: number;
  /** The worldspawn sky as R_SetSky gets it, and the env/ images that loaded (the rest draw r_notexture). */
  sky?: SkySettings & { readonly loaded: readonly string[] };
}

declare global {
  interface Window {
    quack: QuackDebug;
  }
}

function spawnPoint(ents: readonly BspEntity[]): FlyCamera {
  const spawn =
    ents.find((e) => e.classname === "info_player_start") ?? ents.find((e) => e.classname === "info_player_deathmatch");
  const o = (spawn && entityVec3(spawn, "origin")) ?? [0, 0, 0];
  return new FlyCamera([o[0], o[1], o[2] + VIEW_HEIGHT], 0, Number(spawn?.angle ?? 0) || 0);
}

function showError(message: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = message;
  window.quack.error = message;
  console.error(message);
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const debug: QuackDebug = (window.quack = {
    ready: false,
    frames: 0,
    archives: [],
    palette: false,
    assetErrors: [],
    view: () => ({ origin: [0, 0, 0], pitch: 0, yaw: 0 }),
    setView: () => {},
    project: () => undefined,
    readPixels: () => ({ width: 0, height: 0, data: new Uint8Array(0) }),
    setCull: () => {},
    setNoAreas: () => {},
    setLevelTime: () => {},
    lightmapUploads: 0,
  });
  // An opaque drawing buffer: fragment alpha (texture alpha, the alpha pass's blend)
  // must not let the page show through, as the engine's window never does.
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return showError("WebGL2 is not available in this browser.");

  const params = new URLSearchParams(location.search);
  const fs = new GameFs();
  const mountErrors: string[] = [];
  const mount = async (name: string, data: Uint8Array | Blob) => {
    try {
      fs.mount(name, await openGameArchive(data));
    } catch (e) {
      mountErrors.push(`${name}: ${errorMessage(e)}`);
    }
  };
  // Fetch in parallel; mount, and report failures, in URL order so a later ?pak=
  // overrides an earlier one.
  const fetched = await Promise.all(
    params.getAll("pak").map(async (url) => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { url, bytes: new Uint8Array(await r.arrayBuffer()) };
      } catch (e) {
        return { url, error: errorMessage(e) };
      }
    }),
  );
  for (const f of fetched) {
    if ("bytes" in f) await mount(f.url, f.bytes);
    else mountErrors.push(`${f.url}: ${f.error}`);
  }

  // An empty ?map= would fetch the page itself.
  const mapUrl = params.get("map") || "maps/test_arena.bsp";
  debug.map = mapUrl;
  // The game data line is not up yet, and a pak that failed to mount may be why the map failed.
  const unmounted = mountErrors.length > 0 ? `; archives not mounted: ${mountErrors.join("; ")}` : "";
  let mapFile;
  try {
    mapFile = await loadMap(fs, mapUrl);
  } catch (e) {
    if (!(e instanceof MapLoadError)) throw e;
    return showError(e.message + unmounted);
  }
  debug.mapSource = mapFile.source;
  let bsp;
  try {
    bsp = parseBsp(mapFile.bytes);
  } catch (e) {
    // Name the archive too: a map from a mounted pak is not visible in the URL.
    const from = mapFile.source === mapUrl ? "" : ` from ${mapFile.source}`;
    return showError(`Could not load ${mapUrl}${from}: ${errorMessage(e)}${unmounted}`);
  }
  debug.integrityErrors = checkBspIntegrity(bsp);
  // The engine never runs these checks, and many (plane types, brush shape) do not
  // affect drawing; the renderer reads defensively, so warn and draw anyway.
  if (debug.integrityErrors.length > 0) {
    console.warn(`${mapUrl}: ${debug.integrityErrors.length} integrity problems`, debug.integrityErrors.slice(0, 10));
  }

  const entities = parseEntities(bsp.entityString);
  const brush = brushModelInstances(bsp, entities);
  if (brush.errors.length > 0) console.warn(`${mapUrl}: ${brush.errors.length} bad brush model references`, brush.errors);
  debug.brushModels = brush.instances.map(
    (b) => `${b.classname} *${b.model} at ${b.origin.join(" ")}${b.angles.some((a) => a !== 0) ? ` angles ${b.angles.join(" ")}` : ""}`,
  );
  // Light styles and warps animate on level time, which starts with the map here.
  const levelStart = performance.now();
  let levelTime: number | undefined;
  const styleValues = lightStyleValues(DEATHMATCH_LIGHTSTYLES, 0);
  const openPortals = openAreaPortals(entities);
  debug.openPortals = [...openPortals].sort((a, b) => a - b);
  const renderer = new WorldRenderer(gl, bsp, noTextures, brush.instances, styleValues, openPortals);
  debug.missingTextures = renderer.missingTextures;
  const sky = skySettings(entities);
  renderer.setSky(sky, []);
  debug.sky = { ...sky, loaded: [] };
  const dataStatus = document.getElementById("data");
  // Debug fields change together at the end, so a reader never sees archives mounted
  // but their textures not yet applied.
  const applyGameData = async () => {
    const errors = [...mountErrors];
    let palette = false;
    let status = "none mounted, checker textures";
    let skyLoaded: readonly string[] = [];
    if (fs.names.length > 0) {
      const [t, s] = await Promise.all([loadWalTextures(fs, renderer.mesh.textures), loadSkyImages(fs, sky.name)]);
      renderer.setTextures(t.source);
      renderer.setSky(sky, s.images);
      palette = t.palette;
      skyLoaded = s.loaded;
      errors.push(...t.errors, ...s.errors);
      status = `${fs.names.join(", ")}: ${t.loaded.length} of ${renderer.mesh.textures.length} textures`;
      if (!t.palette) status += ", no palette (pics/colormap.pcx) so checkers";
      status += `, ${s.loaded.length} of 6 sky images`;
    }
    if (errors.length > 0) {
      status += `; ${errors.length} problems, see console`;
      console.warn(`game data: ${errors.length} problems`, errors);
    }
    if (dataStatus) dataStatus.textContent = status;
    Object.assign(debug, {
      archives: fs.names,
      palette,
      assetErrors: errors,
      missingTextures: renderer.missingTextures,
      sky: { ...sky, loaded: skyLoaded },
    });
  };
  await applyGameData();
  // Picks mount on top of everything already mounted, in name order (pak0 before pak1).
  // The picker starts disabled in index.html and is enabled only here, once the world
  // exists to re-texture, so no pick is made with nothing listening.
  let picking = Promise.resolve();
  const picker = document.getElementById("pak") as HTMLInputElement | null;
  if (picker) picker.disabled = false;
  picker?.addEventListener("change", () => {
    const files = [...(picker.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    picker.value = "";
    picking = picking
      .then(async () => {
        // Only the directory is read here; entries are read from the File as needed.
        for (const file of files) await mount(file.name, file);
        await applyGameData();
      })
      .catch((e: unknown) => console.warn("mounting picked files failed", e));
  });
  const { faceTexture, firstFace, numFaces } = renderer.mesh;
  debug.worldFaces = faceTexture.subarray(firstFace, firstFace + numFaces).filter((t) => t >= 0).length;
  const camera = spawnPoint(entities);

  const keys = new Set<string>();
  addEventListener("keydown", (e) => keys.add(e.code));
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
  // Refused when the page lacks focus or the user just exited lock; clicking again retries.
  canvas.addEventListener("click", () => void canvas.requestPointerLock()?.catch(() => {}));
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas) camera.look(e.movementY * MOUSE_SENSITIVITY, -e.movementX * MOUSE_SENSITIVITY);
  });

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  };
  const draw = () => {
    resize();
    const time = levelTime ?? performance.now() - levelStart;
    lightStyleValues(DEATHMATCH_LIGHTSTYLES, time, styleValues);
    debug.lightmapUploads = renderer.setLightStyles(styleValues);
    renderer.setTime(time);
    debug.stats = renderer.render(camera, canvas.width, canvas.height);
    debug.frames++;
  };
  debug.view = () => ({ origin: [...camera.origin], pitch: camera.pitch, yaw: camera.yaw });
  debug.setView = (v) => {
    camera.origin = [v.origin[0], v.origin[1], v.origin[2]];
    camera.pitch = v.pitch;
    camera.yaw = v.yaw;
  };
  debug.project = (x, y, z) => {
    const [cx, cy, , w] = transformPoint(renderer.viewProj, x, y, z);
    if (w <= 0) return undefined;
    return [((cx / w + 1) / 2) * canvas.width, ((cy / w + 1) / 2) * canvas.height];
  };
  debug.setCull = (on) => {
    renderer.cull = on;
  };
  debug.setNoAreas = (on) => {
    renderer.noAreas = on;
  };
  debug.setLevelTime = (ms) => {
    levelTime = ms;
  };
  debug.readPixels = () => {
    draw();
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width: canvas.width, height: canvas.height, data };
  };

  const axis = (pos: string, neg: string) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    camera.move(
      {
        forward: axis("KeyW", "KeyS"),
        right: axis("KeyD", "KeyA"),
        up: axis("Space", "KeyC"),
        fast: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      },
      dt,
    );
    draw();
    requestAnimationFrame(frame);
  };
  debug.ready = true;
  document.getElementById("status")?.remove();
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => showError(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
