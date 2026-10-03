// SPDX-License-Identifier: GPL-2.0-or-later
// Browser entry: loads a BSP (?map=, default the bundled test arena), spawns a free-fly
// camera at the player start, and renders until the page closes. Click to capture the
// mouse; WASD to fly, Space/C up/down, Shift fast.

import { checkBspIntegrity, entityVec3, parseBsp, parseEntities, type Bsp } from "@quack2/sim";
import { FlyCamera } from "./camera.js";
import { WorldRenderer, type FrameStats, type View } from "./renderer.js";
import { noTextures } from "./textures.js";

/** Eye height above the player origin (Q2 viewheight while standing). */
const VIEW_HEIGHT = 22;
const MOUSE_SENSITIVITY = 0.15;

/** Debug surface for the headless smoke test and the console. */
export interface QuackDebug {
  ready: boolean;
  error?: string;
  map?: string;
  frames: number;
  stats?: FrameStats;
  missingTextures?: readonly string[];
  /** Drawable faces in the world model: what a view with no PVS culling draws. */
  worldFaces?: number;
  integrityErrors?: readonly string[];
  view(): View;
  setView(view: View): void;
  /** Render one frame now and return its RGBA pixels, bottom row first. */
  readPixels(): { width: number; height: number; data: Uint8Array };
}

declare global {
  interface Window {
    quack: QuackDebug;
  }
}

function spawnPoint(bsp: Bsp): FlyCamera {
  const ents = parseEntities(bsp.entityString);
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
    view: () => ({ origin: [0, 0, 0], pitch: 0, yaw: 0 }),
    setView: () => {},
    readPixels: () => ({ width: 0, height: 0, data: new Uint8Array(0) }),
  });
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) return showError("WebGL2 is not available in this browser.");

  const mapUrl = new URLSearchParams(location.search).get("map") ?? "maps/test_arena.bsp";
  debug.map = mapUrl;
  const res = await fetch(mapUrl);
  if (!res.ok) return showError(`Could not load ${mapUrl}: HTTP ${res.status}`);
  const bsp = parseBsp(await res.arrayBuffer());
  debug.integrityErrors = checkBspIntegrity(bsp);
  if (debug.integrityErrors.length > 0) {
    return showError(`${mapUrl} failed integrity checks:\n${debug.integrityErrors.slice(0, 10).join("\n")}`);
  }

  const renderer = new WorldRenderer(gl, bsp, noTextures);
  debug.missingTextures = renderer.missingTextures;
  debug.worldFaces = renderer.mesh.faceTexture.filter((t) => t >= 0).length;
  const camera = spawnPoint(bsp);

  const keys = new Set<string>();
  addEventListener("keydown", (e) => keys.add(e.code));
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
  canvas.addEventListener("click", () => void canvas.requestPointerLock());
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
    debug.stats = renderer.render(camera, canvas.width, canvas.height);
    debug.frames++;
  };
  debug.view = () => ({ origin: [...camera.origin], pitch: camera.pitch, yaw: camera.yaw });
  debug.setView = (v) => {
    camera.origin = [v.origin[0], v.origin[1], v.origin[2]];
    camera.pitch = v.pitch;
    camera.yaw = v.yaw;
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
