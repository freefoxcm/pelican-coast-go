// ============================================================================
// 鹈鹕海岸 · 追鱼 — main.js  (Lead-owned: renderer, loop, input, quality, wiring)
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createWorld } from './world.js';
import { createPelican } from './pelican.js';
import { createCameras } from './cameras.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createGame } from './game.js';
import { clamp, clamp01, lerp, smoothstep, damp } from './util.js';

const CYCLE = 240; // seconds of a full dusk→night→dawn loop

// ---------------------------------------------------------------- config/url
const params = new URLSearchParams(location.search);
const qp = (k, d = null) => (params.has(k) ? params.get(k) : d);
const numParam = (k, d) => {
  const v = parseFloat(params.get(k));
  return Number.isFinite(v) ? v : d;
};
const forcedQuality = params.has('quality') ? clamp(parseInt(qp('quality'), 10) || 0, 0, 2) : null;
// ---------------------------------------------------------------- post-processing policy
// EffectComposer + UnrealBloomPass produce a giant black rectangle on some macOS
// Chrome/ANGLE(Metal) builds (the composer's HDR render targets resolve badly there).
// Everything else renders fine, so on macOS we simply skip post-processing and keep
// full resolution + shadows. Override with ?pp=1 (force on) / ?pp=0 (force off).
const uaPlatform =
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
const isMacOS = /mac/i.test(uaPlatform) && (navigator.maxTouchPoints || 0) <= 1;
const postParam = qp('pp');
const POST_ALLOWED = postParam === '1' ? true : postParam === '0' ? false : !isMacOS;
const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const isSmall = Math.min(window.innerWidth, window.innerHeight) < 700;
const bootQuality = forcedQuality ?? (isCoarse || isSmall ? 1 : 0);
const autoStart = qp('autostart') === '1';
const startDay = clamp01(numParam('day', 0.03));
const hideUI = qp('ui') === '0';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: bootQuality === 0,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
} catch (err) {
  const s = document.getElementById('boot-status');
  if (s) s.textContent = '无法初始化 WebGL，请更新浏览器或开启硬件加速';
  throw err;
}
renderer.setClearColor(0x0a1024, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = bootQuality < 2;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// keep cumulative stats across all composer passes (reset once per frame)
renderer.info.autoReset = false;
let pxScale = 1;
function basePixelRatio(level) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return level === 0 ? dpr : level === 1 ? Math.min(dpr, 1.5) : 1;
}
function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  pxScale = basePixelRatio(state.quality);
  renderer.setPixelRatio(pxScale);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) {
    // EffectComposer already forwards the (device-pixel) size to every pass, so the
    // bloom pass must NOT be resized separately (that used to desync its mips).
    composer.setPixelRatio(pxScale);
    composer.setSize(w, h);
  }
}

// Post-processing is skipped on macOS Chrome (composer HDR targets black out there).
function postEnabled() {
  return POST_ALLOWED && state.quality < 2;
}

function buildComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.55, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  resize();
}

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 1600);
camera.position.set(0, 3, 9);

// ---------------------------------------------------------------- state
const input = {
  accel: false,
  brake: false,
  edges: { left: 0, right: 0, jump: 0, wing: 0 },
  lastManual: -99,
  consume(k) {
    const v = this.edges[k] || 0;
    this.edges[k] = 0;
    return v > 0;
  },
};

const clock = { dayPhase: startDay, elapsed: 0 };
const state = {
  time: 0,
  dt: 0,
  paused: false,
  started: false,
  quality: bootQuality,
  bikeZ: 0,
  distance: 0,
  speed: 0,
  speedMax: 34,
  speedRatio: 0,
  cadence: 0,
  lean: 0,
  lane: 1,
  laneX: 0,
  jumpY: 0,
  airborne: false,
  grounded: true,
  wheelie: 0,
  wingsOut: 0,
  dayPhase: startDay,
  night: 0,
  sunDir: new THREE.Vector3(0.8, 0.1, -0.3),
  moonDir: new THREE.Vector3(-0.6, 0.5, -0.5),
  camera,
  pelican: null,
  autopilot: true,
  fishCount: 0,
  score: 0,
  combo: 1,
  achievements: [],
  fps: 60,
  input,
  cameraMode: 'chase',
  cameraLabel: '',
};

// ---------------------------------------------------------------- day cycle
const SUN_EL = [
  { t: 0.0, v: 5.5 }, { t: 0.07, v: 1.5 }, { t: 0.15, v: -6.5 }, { t: 0.32, v: -26 },
  { t: 0.7, v: -30 }, { t: 0.85, v: -16 }, { t: 0.94, v: -2 }, { t: 1.0, v: 5.5 },
];
const MOON_EL = [
  { t: 0.0, v: -22 }, { t: 0.14, v: -2 }, { t: 0.3, v: 14 }, { t: 0.5, v: 46 },
  { t: 0.66, v: 30 }, { t: 0.8, v: 8 }, { t: 0.9, v: -10 }, { t: 1.0, v: -22 },
];
function sampleKeys(phase, keys) {
  const p = ((phase % 1) + 1) % 1;
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i];
    const b = keys[(i + 1) % keys.length];
    const ta = a.t;
    const tb = b.t > ta ? b.t : b.t + 1;
    const pp = p < ta ? p + 1 : p;
    if (pp >= ta && pp <= tb) {
      const u = (pp - ta) / (tb - ta || 1);
      const s = u * u * (3 - 2 * u);
      return lerp(a.v, b.v, s);
    }
  }
  return keys[0].v;
}
const D2R = Math.PI / 180;
function updateDayState() {
  state.dayPhase = clock.dayPhase;
  const sunEl = sampleKeys(clock.dayPhase, SUN_EL);
  const moonEl = sampleKeys(clock.dayPhase, MOON_EL);
  // sun sets over the sea (+X, slightly ahead -Z)
  state.sunDir.set(Math.cos(sunEl * D2R) * 0.94, Math.sin(sunEl * D2R), -Math.cos(sunEl * D2R) * 0.34).normalize();
  state.moonDir.set(Math.cos(moonEl * D2R) * 0.8, Math.sin(moonEl * D2R), -Math.cos(moonEl * D2R) * 0.6).normalize();
  const dark = smoothstep(0.075, 0.32, clock.dayPhase);
  const dawn = smoothstep(0.82, 0.985, clock.dayPhase);
  state.night = clamp01(dark * (1 - dawn));
}
updateDayState();

// ---------------------------------------------------------------- modules
let world, pelican, cameras, hud, audio, game, composer, bloom;

function safe(label, fn) {
  try {
    fn();
  } catch (e) {
    if (!safe._seen) safe._seen = new Set();
    if (!safe._seen.has(label)) {
      safe._seen.add(label);
      console.error(`[${label}] update failed:`, e);
    }
  }
}

function build() {
  world = createWorld(scene, { quality: state.quality });
  if (world.group && world.group.parent !== scene) scene.add(world.group);

  // shadows: main configures the light once; world updates its transform.
  const sun = world.sunLight;
  if (sun && sun.isDirectionalLight) {
    sun.castShadow = state.quality < 2;
    const ms = state.quality === 0 ? 2048 : 1024;
    sun.shadow.mapSize.set(ms, ms);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 220;
    sun.shadow.camera.left = -42;
    sun.shadow.camera.right = 42;
    sun.shadow.camera.top = 42;
    sun.shadow.camera.bottom = -42;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
  }

  pelican = createPelican(scene);
  if (pelican.group && pelican.group.parent !== scene) scene.add(pelican.group);
  pelican.group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = state.quality < 2;
      o.receiveShadow = false;
    }
  });
  setupCharacterHelpers();
  collectHelmetGroups();
  audio = createAudio();
  cameras = createCameras(camera, renderer.domElement);
  hud = createHud({
    onAction: applyAction,
    onCamera: (id) => {
      if (id && cameras.modes.some((m) => m.id === id)) cameras.setMode(id);
      else cameras.next();
      syncCameraHud();
    },
    onMute: () => {
      audio.setMuted(!audio.muted);
      hud?.toast?.(audio.muted ? '静音' : '声音已开', '', 'info');
    },
    onPause: () => togglePause(),
    onRestart: () => restart(),
  });
  if (hud.element) {
    hud.element.style.display = hideUI ? 'none' : '';
  }

  state.pelican = pelican;
  state.achievements = [];
  game = createGame({ scene, state, input, hud, audio, cameras });
  state.achievements = game.achievements;
  state.pelican = pelican;

  // post processing
  composer = null;
  bloom = null;
  if (postEnabled()) buildComposer();
  resize();
  syncCameraHud();
}

// ---------------------------------------------------------------- character helpers
// A cheap ground blob keeps the bike anchored to the road (shadow maps are off at
// low quality / at night), and a soft "hero" light keeps the rider readable in the
// starry-night phase without washing out the environment.
let blobShadow = null;
let heroLight = null;
// First-person trick: hide the rider's own helmet in the POV camera so the shell
// can never block the view during wheelies / jumps. Collected via the helmet colour.
const helmetGroups = [];
function collectHelmetGroups() {
  helmetGroups.length = 0;
  const seen = new Set();
  pelican?.group?.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (m && m.color && m.color.getHex && m.color.getHex() === 0xd8342c && o.parent && !seen.has(o.parent)) {
        seen.add(o.parent);
        helmetGroups.push(o.parent);
      }
    }
  });
}
function setupCharacterHelpers() {
  if (!blobShadow) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.24)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    blobShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 3.6),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.66, toneMapped: false })
    );
    blobShadow.rotation.x = -Math.PI / 2;
    blobShadow.renderOrder = 3;
    blobShadow.frustumCulled = false;
    scene.add(blobShadow);
  }
  if (!heroLight) {
    heroLight = new THREE.PointLight(0xffd6a8, 0.2, 7, 2);
    heroLight.castShadow = false;
    scene.add(heroLight);
  }
}
function updateCharacterHelpers() {
  const hideHelmet = state.cameraMode === 'pov' && !studio.enabled;
  for (let i = 0; i < helmetGroups.length; i++) helmetGroups[i].visible = !hideHelmet;
  if (blobShadow) {
    blobShadow.position.set(state.laneX, 0.02, state.bikeZ + 0.1);
    const h = clamp01(state.jumpY / 2.4);
    blobShadow.material.opacity = 0.66 * (1 - h * 0.82) * (1 - state.night * 0.3);
    const s = 1 + h * 0.42;
    blobShadow.scale.set(s, s, s);
  }
  if (heroLight) {
    heroLight.position.set(state.laneX - 0.7, 2.15 + state.jumpY * 0.9, state.bikeZ + 1.15);
    heroLight.color.setHex(state.night > 0.55 ? 0xa9c4ff : 0xffd6a8);
    heroLight.intensity = (0.16 + state.night * 0.7) * (state.quality === 2 ? 0.75 : 1);
  }
}

function syncCameraHud() {  state.cameraMode = cameras ? cameras.mode : 'chase';
  state.cameraLabel = cameras ? cameras.currentLabel : '';
  try {
    hud?.setCameraModes?.(cameras.modes, cameras.mode);
  } catch (e) {
    /* ignore */
  }
}

function applyQuality(level) {
  level = clamp(level, 0, 2);
  if (level === state.quality) {
    if (hud?.setQualityLabel) hud.setQualityLabel(['高', '中', '低'][level]);
    return;
  }
  const hadComposer = state.quality < 2;
  state.quality = level;
  renderer.shadowMap.enabled = level < 2;
  safe('world.setQuality', () => world?.setQuality?.(level));
  safe('pelican.setQuality', () => pelican?.setQuality?.(level));
  if (pelican?.group) {
    pelican.group.traverse((o) => {
      if (o.isMesh) o.castShadow = level < 2;
    });
  }
  if (!postEnabled()) {
    composer = null;
    bloom = null;
  } else if (!hadComposer) {
    buildComposer();
  }
  resize();
  try {
    hud?.setQualityLabel?.(['高', '中', '低'][level]);
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- input
const KEY_ACTIONS = {
  KeyW: 'accel', ArrowUp: 'accel',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', KeyJ: 'jump',
  KeyT: 'wing',
};

function markManual() {
  input.lastManual = state.time;
  if (state.autopilot) state.autopilot = false;
}

function applyAction(name, pressed) {
  if (!pressed) {
    if (name === 'accel') input.accel = false;
    else if (name === 'brake') input.brake = false;
    return;
  }
  markManual();
  switch (name) {
    case 'accel': input.accel = true; break;
    case 'brake': input.brake = true; break;
    case 'left': input.edges.left++; break;
    case 'right': input.edges.right++; break;
    case 'jump': input.edges.jump++; break;
    case 'wing': input.edges.wing++; break;
    default: break;
  }
}

window.addEventListener('keydown', (e) => {
  const code = e.code;
  if (code === 'Enter' && !state.started) {
    e.preventDefault();
    start();
    return;
  }
  if (code === 'KeyC') {
    if (state.started) {
      e.preventDefault();
      cameras.next();
      syncCameraHud();
    }
    return;
  }
  if (code === 'KeyM') {
    if (state.started) {
      audio.setMuted(!audio.muted);
      hud?.toast?.(audio.muted ? '静音' : '声音已开', '', 'info');
    }
    return;
  }
  if (code === 'KeyP' || code === 'Escape') {
    if (state.started) {
      e.preventDefault();
      togglePause();
    }
    return;
  }
  if (code === 'KeyR') {
    if (state.started) restart();
    return;
  }
  const action = KEY_ACTIONS[code];
  if (!action) return;
  e.preventDefault();
  if (!state.started) {
    start();
    return;
  }
  if ((action === 'left' || action === 'right' || action === 'jump' || action === 'wing') && e.repeat) return;
  applyAction(action, true);
});
window.addEventListener('keyup', (e) => {
  const action = KEY_ACTIONS[e.code];
  if (!action) return;
  if (action === 'accel' || action === 'brake') applyAction(action, false);
});
window.addEventListener('blur', () => {
  input.accel = false;
  input.brake = false;
});
canvas.addEventListener('pointerdown', () => {
  if (!audio.ready) audio.unlock();
  else if (state.paused) togglePause();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- flow
const bootEl = document.getElementById('boot-screen');
const titleEl = document.getElementById('title-screen');
document.getElementById('btn-start')?.addEventListener('click', () => start());
document.getElementById('btn-touch-start')?.addEventListener('click', () => {
  document.body.classList.add('touch');
  start();
});

function start() {
  if (state.started) return;
  state.started = true;
  audio.unlock();
  document.body.classList.add('playing');
  if (titleEl) {
    titleEl.classList.add('gone');
    setTimeout(() => { titleEl.hidden = true; }, 800);
  }
  if (hud?.element) hud.element.style.display = hideUI ? 'none' : '';
  game.begin();
  const cam = qp('camera');
  if (cam && cameras.modes.some((m) => m.id === cam)) cameras.setMode(cam);
  else cameras.setMode('chase');
  syncCameraHud();
  hud?.showIntro?.();
  audio.sfx?.('flap');
}

function togglePause() {
  state.paused = !state.paused;
  hud?.toast?.(state.paused ? '已暂停' : '继续', state.paused ? '按 P 继续骑行' : '', 'info');
}

function restart() {
  game.reset();
  state.bikeZ = 0;
  state.distance = 0;
  state.speed = 0;
  state.lane = 1;
  state.laneX = 0;
  state.jumpY = 0;
  state.airborne = false;
  state.grounded = true;
  state.lean = 0;
  state.wheelie = 0;
  state.wingsOut = 0;
  state.combo = 1;
  state.fishCount = 0;
  state.score = 0;
  state.paused = false;
  pelican.reset?.();
  cameras.setMode('chase');
  syncCameraHud();
  hud?.toast?.('重新出发', '海岸线还很长', 'info');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.started) {
    if (!state.paused) togglePause();
  }
});

// ---------------------------------------------------------------- loop
let lastNow = performance.now();
let startedOnce = false;
let fpsTime = 0;
let fpsFrames = 0;
let qCool = 0;
let goodTime = 0;
let autoQuality = forcedQuality === null;

function orbitCameraPreStart() {
  const t = state.time;
  const a = t * 0.11 + 0.5;
  const R = 11.5;
  camera.position.set(
    state.laneX + Math.sin(a) * R,
    3.4 + Math.sin(t * 0.23) * 0.9,
    state.bikeZ + Math.cos(a) * R
  );
  const look = new THREE.Vector3(state.laneX, 1.55, state.bikeZ - 1.5);
  camera.up.set(0, 1, 0);
  camera.lookAt(look);
  if (Math.abs(camera.fov - 52) > 0.01) {
    camera.fov = 52;
    camera.updateProjectionMatrix();
  }
}

function render() {
  if (composer && postEnabled()) composer.render();
  else renderer.render(scene, camera);
}

// ---------------------------------------------------------------- model studio
// Freeze-frame orbit camera used to inspect / iterate on the pelican model.
//   __PELICAN__.studio.on(yaw, pitch, dist, 'body'|'head'|'bike')
const studio = { enabled: false, yaw: 0.85, pitch: 0.16, dist: 3.1, target: 'body', spin: 0, fov: 36 };
const _sv = new THREE.Vector3();
function studioTarget() {
  if (!pelican) return _sv.set(state.laneX, 1.4, state.bikeZ);
  if (studio.target === 'head') return pelican.getHeadWorldPosition(_sv);
  if (studio.target === 'eye') return pelican.getEyeWorldPosition(_sv);
  if (studio.target === 'bike') return _sv.set(state.laneX, 0.55, state.bikeZ);
  return pelican.getChestWorldPosition(_sv);
}
function studioCamera(dtOverride) {
  const tgt = studioTarget();
  const dt = typeof dtOverride === 'number' ? dtOverride : 0.016;
  if (studio.spin) studio.yaw += studio.spin * dt;
  const cp = Math.cos(studio.pitch);
  camera.position.set(
    tgt.x + Math.sin(studio.yaw) * cp * studio.dist,
    tgt.y + Math.sin(studio.pitch) * studio.dist,
    tgt.z + Math.cos(studio.yaw) * cp * studio.dist
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(tgt);
  if (Math.abs(camera.fov - studio.fov) > 0.01) {
    camera.fov = studio.fov;
    camera.updateProjectionMatrix();
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min(Math.max((now - lastNow) / 1000, 0.0005), 0.25);
  lastNow = now;
  const dt = Math.min(raw, 0.05);

  // fps meter
  fpsTime += raw;
  fpsFrames++;
  if (fpsTime >= 0.4) {
    state.fps = fpsFrames / fpsTime;
    fpsTime = 0;
    fpsFrames = 0;
  }

  state.dt = dt;
  clock.elapsed += dt;
  clock.dayPhase = (clock.dayPhase + dt / CYCLE) % 1;
  updateDayState();

  const active = state.started && !state.paused;
  if (active) {
    state.time += dt;
    safe('game', () => game.update(dt, state));
  } else if (!state.started) {
    state.time += dt * 0.6;
  }

  state.speedRatio = clamp01(state.speed / state.speedMax);

  // apply root transform (main owns position; pelican animates children)
  if (pelican?.group) {
    pelican.group.position.set(state.laneX, state.jumpY, state.bikeZ);
    pelican.group.rotation.y = 0;
  }
  updateCharacterHelpers(dt);

  safe('pelican', () => pelican?.update(state.paused ? dt * 0.25 : dt, state));
  safe('world', () => world?.update(state.paused ? dt * 0.35 : dt, state));

  if (studio.enabled) {
    safe('studio', studioCamera);
  } else if (state.started) {
    safe('cameras', () => cameras?.update(state.paused ? dt * 0.2 : dt, state));
  } else {
    orbitCameraPreStart();
  }

  if (state.started) {
    try {
      hud?.update?.(dt, state);
    } catch (e) {
      safe('hud', () => { throw e; });
    }
  }
  safe('audio', () => audio?.update(dt, state));

  // bloom / exposure mood
  if (bloom) {
    bloom.strength = lerp(0.3, 0.78, state.night) * (state.quality === 1 ? 0.7 : 1);
    bloom.threshold = lerp(0.9, 0.62, state.night);
    bloom.radius = lerp(0.45, 0.7, state.night);
  }
  renderer.toneMappingExposure = 1.0 + state.night * 0.22;

  // adaptive quality
  if (autoQuality && state.started && !state.paused) {
    qCool -= 0.4;
    if (state.fps < 42 && state.quality < 2 && qCool <= 0) {
      applyQuality(state.quality + 1);
      qCool = 6;
      goodTime = 0;
    } else if (state.fps > 57) {
      goodTime += 0.4;
      if (goodTime > 9 && state.quality > 0) {
        applyQuality(state.quality - 1);
        qCool = 6;
        goodTime = 0;
      }
    } else {
      goodTime = 0;
    }
  }

  renderer.info.reset();
  render();
  startedOnce = true;
  if (!bootEl.classList.contains('gone') && startedOnce) {
    bootEl.classList.add('gone');
    if (titleEl) titleEl.hidden = false;
    setTimeout(() => bootEl.remove(), 900);
  }
}

window.addEventListener('resize', resize);

// ---------------------------------------------------------------- boot
build();
resize();
requestAnimationFrame(frame);

// ---------------------------------------------------------------- debug hooks
window.__PELICAN__ = {
  state,
  clock,
  scene,
  camera,
  renderer,
  get world() { return world; },
  get pelican() { return pelican; },
  get cameras() { return cameras; },
  get hud() { return hud; },
  get audio() { return audio; },
  get game() { return game; },
  get composer() { return composer; },
  get bloom() { return bloom; },
  ready: true,
  start,
  restart,
  setDayPhase(v) {
    clock.dayPhase = clamp01(v);
    updateDayState();
  },
  setCamera(id) {
    if (!cameras) return false;
    if (cameras.modes.some((m) => m.id === id)) cameras.setMode(id);
    syncCameraHud();
    return cameras.mode;
  },
  nextCamera() { cameras?.next(); syncCameraHud(); return cameras?.mode; },
  // Model studio: freeze the game and orbit the pelican for close inspection.
  //   __PELICAN__.studio.on(0.9, 0.15, 3.0, 'body')   // yaw, pitch, dist, target
  //   __PELICAN__.studio.set({ yaw: 2.4, dist: 1.4, target: 'head' })
  //   __PELICAN__.studio.pose({ speed: 0, wingsOut: 1 })   // wings fully spread
  //   __PELICAN__.studio.off()
  studio: {
    on(yaw = 0.85, pitch = 0.16, dist = 3.1, target = 'body') {
      if (!state.started) start();
      state.paused = true;
      Object.assign(studio, { enabled: true, yaw, pitch, dist, target: target || 'body', spin: 0 });
      Object.assign(state, {
        speed: 9, speedRatio: 9 / state.speedMax, cadence: 0.9, lane: 1, laneX: 0,
        jumpY: 0, airborne: false, grounded: true, wheelie: 0, wingsOut: 0, lean: 0, dt: 0.016,
      });
      return true;
    },
    off() { studio.enabled = false; state.paused = false; return true; },
    set(o = {}) { Object.assign(studio, o); return { ...studio }; },
    spin(v = 0.5) { studio.spin = Number(v) || 0; return studio.spin; },
    pose(o = {}) { Object.assign(state, o); return true; },
    get enabled() { return studio.enabled; },
    get options() { return { ...studio }; },
  },
  ui(b) {
    if (hud?.element) hud.element.style.display = b ? '' : 'none';
    document.getElementById('vignette')?.style && (document.getElementById('vignette').style.display = b ? '' : 'none');
    return !!b;
  },
  quality(l) {
    autoQuality = false;
    applyQuality(clamp(parseInt(l, 10) || 0, 0, 2));
  },
  autoQuality(b) { autoQuality = !!b; },
  mute(b) { audio?.setMuted?.(!!b); },
  triggerAchievement(i) { return game?.debugUnlock ? game.debugUnlock(i) : false; },
  unlockAll() { return game?.debugUnlockAll ? game.debugUnlockAll() : false; },
  snapshot() {
    return {
      fps: state.fps, quality: state.quality, speed: state.speed, dayPhase: state.dayPhase,
      night: state.night, camera: state.cameraMode, fish: state.fishCount, distance: state.distance,
      achievements: state.achievements.filter((a) => a.unlocked).length,
      total: state.achievements.length, autopilot: state.autopilot, started: state.started,
      paused: state.paused, bpm: audio?.bpm, audioReady: audio?.ready,
      post: !!(composer && postEnabled()), mac: isMacOS, postAllowed: POST_ALLOWED,
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      programs: renderer.info.programs ? renderer.info.programs.length : null,
      paint: { laneX: state.laneX, jumpY: state.jumpY, wheelie: state.wheelie, wingsOut: state.wingsOut },
    };
  },
  presets: {
    dusk: 0.03, sunset: 0.15, blue: 0.32, night: 0.5, dawn: 0.9,
  },
};

if (autoStart) {
  setTimeout(() => start(), 60);
}
// ---------------------------------------------------------------- diagnostics
// ?diag=1 → small overlay with GPU / canvas / post-processing facts. Handy when a
// machine renders something unexpected (e.g. black regions on macOS Chrome).
// ?pp=0   → force post-processing off (same as quality=2) for A/B tests.
(function setupDiagnostics() {
  if (qp('diag') !== '1') return;
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:99999;max-width:min(560px,94vw);padding:8px 10px;' +
    'border-radius:10px;background:rgba(0,0,0,.8);color:#b6f5d8;font:11px/1.55 ui-monospace,Menlo,Consolas,monospace;' +
    'white-space:pre-wrap;pointer-events:none;';
  document.body.appendChild(el);
  let gpu = 'unknown';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { gpu = 'n/a'; }
  const canvas = renderer.domElement;
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { lost = true; e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; });
  const update = () => {
    el.textContent =
      'GPU: ' + gpu + '\n' +
      'platform: ' + uaPlatform + '   macOS: ' + isMacOS + '   post allowed: ' + POST_ALLOWED + '\n' +
      'DPR: ' + (window.devicePixelRatio || 1) + '   viewport: ' + window.innerWidth + '×' + window.innerHeight + '\n' +
      'canvas css: ' + canvas.clientWidth + '×' + canvas.clientHeight + '   buffer: ' + canvas.width + '×' + canvas.height + '\n' +
      'quality: ' + state.quality + '   postprocessing: ' + (composer ? 'ON' : 'OFF') + '   bloom: ' + (bloom ? 'ON' : 'OFF') + '\n' +
      'fps: ' + Math.round(state.fps) + '   draws: ' + renderer.info.render.calls + '   tris: ' + (renderer.info.render.triangles / 1000).toFixed(0) + 'k\n' +
      'context lost: ' + lost;
  };
  update();
  setInterval(update, 500);
})();

console.log('[pelican] booted');
