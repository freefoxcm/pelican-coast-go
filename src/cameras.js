// ============================================================================
// cameras.js — 5 camera modes: chase / cinematic / pov / side / drone
// 鹈鹕海岸 · 追鱼 (camera-hud owned, per src/CONTRACT.md §4.4)
//
// Design notes:
//  - Only the supplied PerspectiveCamera is touched (position/quaternion/fov/near).
//    Renderer / scene / fog are never modified.
//  - No per-frame allocations: every vector/quaternion is preallocated here.
//  - World: forward = -Z, +X = sea, road y=0, pelican group at (laneX, jumpY, bikeZ).
//  - prefers-reduced-motion: swaying/shake/orbit speed are reduced.
// ============================================================================
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, smootherstep, noise1, TAU } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const MODES = [
  { id: 'chase', label: '追尾', hint: '后上方 3/4 跟拍 · 速度越快视野越广' },
  { id: 'cinematic', label: '电影运镜', hint: '自动机位 · 硬切 + 缓慢推拉摇移' },
  { id: 'pov', label: '鹈鹕视角', hint: '第一人称 · 看得到喙尖与车把' },
  { id: 'side', label: '侧面长焦', hint: '海侧横移跟拍 · 长焦压缩纵深' },
  { id: 'drone', label: '航拍', hint: '高空缓慢环绕 · 海岸线大全景' },
];

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------------------
// cinematic shot list (>= 6 shots, 3.5s .. 7s each, hard cuts)
// every shot writes into the closure targetPos / targetQuat / targetFov and
// uses the pre-read points bikePos / chest / head.
// ---------------------------------------------------------------------------
export function createCameras(camera, domElement) {
  // ---------------------------------------------------------------- scratch
  const bikePos = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const head = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const look = new THREE.Vector3();
  const targetPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const fromPos = new THREE.Vector3();
  const fromQuat = new THREE.Quaternion();
  const prevQuat = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4();
  const qTmp = new THREE.Quaternion();
  const vTmp = new THREE.Vector3();
  const vTmp2 = new THREE.Vector3();
  const shakeRight = new THREE.Vector3();
  const shakeUp = new THREE.Vector3();

  // ---------------------------------------------------------------- state
  let mode = 'chase';
  let initialized = false;
  let reduceMotion = false;
  let mq = null;
  let mqFn = null;

  // smooth transition between modes (cinematic cuts internally are hard cuts)
  let transT = 1;
  let transDur = 0.35;
  let fromFov = num(camera.fov, 62);

  // fov / near
  let targetFov = num(camera.fov, 62);
  let fovNow = num(camera.fov, 62);
  const baseNear = num(camera.near, 0.3);
  let nearNow = baseNear;

  // cinematic
  let shotIndex = 0;
  let shotTime = 0;
  let shotDur = 4.6;
  let cineIn = false;

  // chase critically-ish damped spring (inertia on lane changes + speed lag)
  const chasePos = new THREE.Vector3();
  const chaseVel = new THREE.Vector3();
  let chaseInit = false;

  // side / drone smoothing
  const sidePos = new THREE.Vector3();
  let sideInit = false;
  const dronePos = new THREE.Vector3();
  let droneInit = false;
  let droneAngle = 0.25;
  let droneAngleExtra = 0;

  // pov
  let povPitch = -0.16;
  // virtual eye offset (tunable): +Z = backwards from the eye, in metres.
  // pelican-rig moved the eye anchor to the front of the face, so the rig
  // sits a little behind it (and is then pushed 0.12m forward along the view).
  let povOffX = 0;
  let povOffY = 0.04;
  let povOffZ = 0.12;
  let povPitchBase = -0.165;
  // shake
  let shakeAmp = 0;
  let shakeT = 0;
  let shakeDur = 0.3;

  // telemetry for auto-feedback (landing / catch)
  let prevAirborne = false;
  let prevFish = 0;
  let clock = 0;

  // ---------------------------------------------------------------- reduced motion
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      reduceMotion = !!mq.matches;
      mqFn = (e) => { reduceMotion = !!(e && e.matches); };
      if (mq.addEventListener) mq.addEventListener('change', mqFn);
      else if (mq.addListener) mq.addListener(mqFn);
    }
  } catch (err) {
    /* ignore */
  }
  const motionScale = () => (reduceMotion ? 0.25 : 1);

  // ---------------------------------------------------------------- helpers
  function readPoint(state, method, out, fallbackY) {
    const pel = state && state.pelican;
    if (pel && typeof pel[method] === 'function') {
      try {
        const r = pel[method](out);
        if (r && typeof r.x === 'number' && Number.isFinite(r.x)) {
          out.copy(r);
          return out;
        }
      } catch (err) {
        /* fall through to fallback */
      }
    }
    return out.set(
      num(state && state.laneX, 0),
      num(state && state.jumpY, 0) + fallbackY,
      num(state && state.bikeZ, 0)
    );
  }

  // aim camera at `target` with optional local-frame offsets, write quaternion
  function aimAt(pos, target, yaw, pitch, roll) {
    mat4.lookAt(pos, target, UP);
    targetQuat.setFromRotationMatrix(mat4);
    if (yaw) targetQuat.multiply(qTmp.setFromAxisAngle(AXIS_Y, yaw));
    if (pitch) targetQuat.multiply(qTmp.setFromAxisAngle(AXIS_X, pitch));
    if (roll) targetQuat.multiply(qTmp.setFromAxisAngle(AXIS_Z, roll));
  }

  // keep low shots on the road corridor (never inside cliff / guardrail posts)
  function safeLowX(x, y) {
    const lim = y < 1.4 ? 5.35 : 6.45;
    return clamp(x, -lim, lim);
  }

  // do not let a rig end up inside the bird
  function enforceMinDist(minDist) {
    vTmp.subVectors(targetPos, chest);
    const d = vTmp.length();
    if (d < minDist && d > 1e-4) targetPos.copy(chest).addScaledVector(vTmp, minDist / d);
  }

  // spring integration (2 substeps for stability at large dt)
  function springTo(pos, vel, tx, ty, tz, dt, stiffness, damping) {
    const h = dt * 0.5;
    for (let i = 0; i < 2; i++) {
      vel.x += ((tx - pos.x) * stiffness - vel.x * damping) * h;
      vel.y += ((ty - pos.y) * stiffness - vel.y * damping) * h;
      vel.z += ((tz - pos.z) * stiffness - vel.z * damping) * h;
      const sp = vel.length();
      if (sp > 80) vel.multiplyScalar(80 / sp);
      pos.x += vel.x * h;
      pos.y += vel.y * h;
      pos.z += vel.z * h;
    }
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      pos.set(tx, ty, tz);
      vel.set(0, 0, 0);
    }
  }

  // ---------------------------------------------------------------- modes
  function updateChase(st, dt, s, time) {
    const jump = num(st.jumpY, 0);
    const lean = clamp(num(st.lean, 0), -1, 1);
    const laneX = num(st.laneX, 0);
    const bikeZ = num(st.bikeZ, 0);

    const back = 3.95 + s * 2.15;
    const high = 1.97 + s * 0.5 + jump * 0.42;
    const side = -1.45 - lean * 0.85;
    const swayX = noise1(time * 0.31 + 4.0) * 0.16 * motionScale();
    const targetX = laneX + side + swayX;
    const targetY = high + Math.sin(time * 1.7) * 0.045 * (1 - s * 0.5) * motionScale();
    const targetZ = bikeZ + back;

    if (!chaseInit) {
      chasePos.set(targetX, targetY, targetZ);
      chaseVel.set(0, 0, 0);
      chaseInit = true;
    }
    springTo(chasePos, chaseVel, targetX, targetY, targetZ, dt, 175, 15.5);

    targetPos.copy(chasePos);
    if (targetPos.y < 1.18) targetPos.y = 1.18;

    // look ahead so the bird sits low in frame and the road opens up
    const lead = 2.4 + s * 5.4 + jump * 1.5;
    look.set(
      laneX + lean * 0.55,
      num(chest.y, 1.35) + 0.24 + jump * 0.22,
      bikeZ - lead
    );
    const roll = -lean * 0.055 - clamp(num(st.wheelie, 0), 0, 1) * 0.01;
    aimAt(targetPos, look, 0, 0, roll * motionScale());

    targetFov = lerp(58, 75, smootherstep(0, 1, s));
  }

  function updateSide(st, dt, s, time) {
    const jump = num(st.jumpY, 0);
    const lean = clamp(num(st.lean, 0), -1, 1);
    const laneX = num(st.laneX, 0);
    const bikeZ = num(st.bikeZ, 0);
    const drift = reduceMotion ? 0 : Math.sin(time * 0.33);

    const lateral = 5.55 + drift * 0.45 + s * 0.55;
    // faster -> the rig is carried slightly forward along the road so the
    // pelican stays on the left golden point and the coast opens up
    const behind = 5.7 - s * 0.9;
    const tx = laneX + lateral;
    const ty = 1.62 + jump * 0.34 + drift * 0.1;
    const tz = bikeZ + behind;
    if (!sideInit) {
      sidePos.set(tx, ty, tz);
      sideInit = true;
    }
    sidePos.x = damp(sidePos.x, tx, 3.4, dt);
    sidePos.y = damp(sidePos.y, ty, 4.5, dt);
    sidePos.z = damp(sidePos.z, tz, 5.6, dt);
    targetPos.copy(sidePos);
    if (targetPos.y < 1.15) targetPos.y = 1.15;

    // pelican to lower-left golden point: aim above/behind him a touch
    look.copy(chest);
    look.y += 0.36 + jump * 0.1;
    look.x += lean * 0.25;
    look.z -= 0.7 + s * 0.8;
    aimAt(targetPos, look, -0.062, 0.008, -lean * 0.03 * motionScale());
    targetFov = lerp(34.5, 29.5, smoothstep(0, 1, s));
  }

  function updatePov(st, dt, s, time) {
    const jumpY = num(st.jumpY, 0);
    const lean = clamp(num(st.lean, 0), -1, 1);
    const cad = clamp01(num(st.cadence, 0) / 1.8);
    const ms = motionScale();

    readPoint(st, 'getEyeWorldPosition', eye, 1.98);
    targetPos.copy(eye);
    // virtual eye: nudged back/up from the anchor so the beak tip and the
    // handlebar read as foreground instead of clipping the near plane.
    targetPos.x += povOffX;
    targetPos.y += povOffY;
    targetPos.z += povOffZ;

    // pedal bob & side sway, head tilt on turns
    const phase = time * TAU * (0.85 + cad * 1.15);
    const bobY = Math.sin(phase * 2) * 0.014 * cad * ms;
    const swayY = Math.sin(phase) * 0.006 * cad * ms;
    const vib = (noise1(time * 21.0) * 0.0035 + Math.sin(time * 47.0) * 0.0012) * s * ms;
    targetPos.y += bobY + vib;
    targetPos.x += swayY + vib * 0.5;

    // pitch: look forward and a little down so beak + handlebar are in frame;
    // airborne -> dive, wheelie -> look up
    const dive = st.airborne ? clamp01(jumpY / 1.3) : 0;
    const wantPitch = povPitchBase - dive * 0.22 + clamp(num(st.wheelie, 0), 0, 1) * 0.06;
    povPitch = damp(povPitch, reduceMotion ? Math.min(wantPitch, povPitchBase + 0.05) : wantPitch, 7.5, dt);

    look.set(targetPos.x, targetPos.y, targetPos.z - 10);
    const roll = -lean * 0.105 + Math.sin(phase) * 0.005 * cad * ms;
    const yaw = -lean * 0.065;
    aimAt(targetPos, look, yaw, povPitch, roll * ms);
    targetFov = lerp(72, 76, smoothstep(0, 1, s)) + dive * 1.4;
  }

  function updateDrone(st, dt, s, time) {
    const jump = num(st.jumpY, 0);
    const laneX = num(st.laneX, 0);
    const bikeZ = num(st.bikeZ, 0);

    droneAngle += dt * (reduceMotion ? 0.028 : 0.072);
    if (droneAngle > TAU) droneAngle -= TAU;
    const radius = 18 + Math.sin(time * 0.11) * 1.4;
    const high = 12 + Math.sin(time * 0.17 + 1.2) * 1.3;
    const cx = laneX;
    const cz = bikeZ - 4.5;

    const tx = cx + Math.sin(droneAngle) * radius;
    const ty = high + jump * 0.15;
    const tz = cz + Math.cos(droneAngle) * radius;
    if (!droneInit) {
      dronePos.set(tx, ty, tz);
      droneInit = true;
    }
    dronePos.x = damp(dronePos.x, tx, 2.2, dt);
    dronePos.y = damp(dronePos.y, ty, 2.2, dt);
    dronePos.z = damp(dronePos.z, tz, 2.2, dt);
    targetPos.copy(dronePos);
    if (targetPos.y < 8.5) targetPos.y = 8.5;

    look.set(cx, 1.1 + jump * 0.5, cz);
    const roll = Math.sin(droneAngle) * 0.01 * motionScale();
    aimAt(targetPos, look, 0, 0, roll);
    targetFov = lerp(48, 54, smoothstep(0, 1, s * 0.9));
  }

  // ---------------------------------------------------------------- cinematic shots
  function shotLowAngle(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const lean = clamp(num(st.lean, 0), -1, 1);
    const e = smoothstep(0, 1, tau);
    const ahead = lerp(3.7, 0.5, e) * (0.92 + s * 0.22);
    const lateral = lerp(-4.75, -3.35, e);
    targetPos.set(
      safeLowX(num(st.laneX, 0) + lateral, 0.9),
      0.84 + jump * 0.34,
      num(st.bikeZ, 0) - ahead
    );
    look.copy(chest);
    look.y += 0.46 + jump * 0.08;
    look.x += lean * 0.35;
    look.z -= 0.4;
    aimAt(targetPos, look, -0.035, 0.018, -lean * 0.02 * motionScale());
    targetFov = lerp(42, 35, e);
  }

  function shotFrontLow(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const dist = lerp(6.9, 4.2, e) * (0.94 + s * 0.14);
    const side = lerp(2.5, 0.85, e);
    targetPos.set(
      safeLowX(num(st.laneX, 0) + side, 0.7),
      0.6 + jump * 0.3,
      num(st.bikeZ, 0) - dist
    );
    look.copy(head);
    look.y += 0.34 + jump * 0.1;
    aimAt(targetPos, look, 0.02, 0.012, -clamp(num(st.lean, 0), -1, 1) * 0.015);
    targetFov = lerp(50, 42, e);
  }

  function shotOrbit(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const ang = 0.55 + e * 2.15;
    const radius = lerp(13.5, 8.6, e) * (0.94 + s * 0.12);
    const high = lerp(7.4, 3.7, e) + jump * 0.3;
    targetPos.set(
      num(st.laneX, 0) + Math.sin(ang) * radius,
      high,
      num(st.bikeZ, 0) + Math.cos(ang) * radius
    );
    look.copy(chest);
    look.y += 0.34;
    look.z -= 1.1;
    aimAt(targetPos, look, 0, 0, Math.sin(e * Math.PI) * 0.012 * motionScale());
    targetFov = lerp(57, 44, e);
  }

  function shotCrane(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const back = lerp(3.2, 15.5, e) * (0.93 + s * 0.2);
    const high = lerp(2.35, 8.9, e);
    const side = lerp(-0.85, 2.65, e);
    targetPos.set(num(st.laneX, 0) + side, high + jump * 0.42, num(st.bikeZ, 0) + back);
    look.set(num(st.laneX, 0) + side * 0.25, 1.0 + jump * 0.3, num(st.bikeZ, 0) - 3.2);
    aimAt(targetPos, look, 0, 0, -clamp(num(st.lean, 0), -1, 1) * 0.02 * motionScale());
    targetFov = lerp(52, 32, e);
  }

  function shotWheel(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    targetPos.set(
      safeLowX(num(st.laneX, 0) + 1.38 - e * 0.2, 0.55),
      0.52 + jump * 0.55,
      num(st.bikeZ, 0) + 1.22 - e * 0.2
    );
    look.set(num(st.laneX, 0) + 0.05, 0.46 + jump * 0.55, num(st.bikeZ, 0) + 0.5);
    aimAt(targetPos, look, 0.03, 0.0, -clamp(num(st.lean, 0), -1, 1) * 0.03 + Math.sin(e * Math.PI) * 0.014 * motionScale());
    targetFov = lerp(46, 38, e) * (0.97 + s * 0.05);
  }

  function shotScarf(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const hy = num(head.y, 1.95 + jump);
    const hz = num(head.z, num(st.bikeZ, 0) - 0.1);
    const back = lerp(2.35, 1.85, e) * (0.96 + s * 0.1);
    targetPos.set(num(st.laneX, 0) - 1.62, hy + 0.04, hz + back);
    // aim at the neck / scarf knot, slightly behind the head so the helmet
    // profile, the sunglasses and the streaming scarf all read in one frame
    look.set(num(st.laneX, 0) - 0.16, hy - 0.12, hz + 0.2);
    aimAt(targetPos, look, -0.035, 0.01, -clamp(num(st.lean, 0), -1, 1) * 0.02 * motionScale());
    targetFov = lerp(37, 32, e);
  }

  function shotTop(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const x = num(st.laneX, 0) + lerp(-3.6, 4.4, e);
    const y = lerp(26, 19, e);
    const back = lerp(11, 7.5, e) * (0.96 + s * 0.1);
    targetPos.set(x, y + jump * 0.1, num(st.bikeZ, 0) + back);
    look.set(num(st.laneX, 0) + 1.4, 0.55 + jump * 0.2, num(st.bikeZ, 0) - 5.0);
    aimAt(targetPos, look, 0, 0, lerp(-0.02, 0.02, e) * motionScale());
    targetFov = lerp(54, 46, e);
  }

  function shotFrontTele(st, tau, s) {
    const jump = num(st.jumpY, 0);
    const e = smoothstep(0, 1, tau);
    const dist = lerp(13.5, 10.2, e) * (0.95 + s * 0.12);
    const side = lerp(0.95, -0.55, e);
    targetPos.set(num(st.laneX, 0) + side, 1.78 + jump * 0.24, num(st.bikeZ, 0) - dist);
    look.copy(chest);
    look.y += 0.26 + jump * 0.08;
    aimAt(targetPos, look, lerp(0.02, -0.02, e), 0, 0);
    targetFov = lerp(26, 21, e);
  }

  const SHOTS = [
    { name: '低角度侧向', dur: 4.6, fn: shotLowAngle },
    { name: '正面仰拍', dur: 5.4, fn: shotFrontLow },
    { name: '环绕推近', dur: 6.4, fn: shotOrbit },
    { name: '后拉摇臂', dur: 6.2, fn: shotCrane },
    { name: '车轮特写', dur: 3.8, fn: shotWheel },
    { name: '围巾特写', dur: 4.2, fn: shotScarf },
    { name: '俯视全景', dur: 6.8, fn: shotTop },
    { name: '正面长焦', dur: 4.6, fn: shotFrontTele },
  ];

  function updateCinematic(st, dt, s, time) {
    shotTime += dt;
    // hard cut when a shot runs out
    let guard = 0;
    while (shotTime >= shotDur && guard++ < 4) {
      shotTime -= shotDur;
      shotIndex = (shotIndex + 1) % SHOTS.length;
      shotDur = SHOTS[shotIndex].dur;
      cineIn = false; // new shot starts from its own first frame
    }
    const shot = SHOTS[shotIndex];
    const tau = clamp01(shotTime / shotDur);
    cineIn = true;
    shot.fn(st, tau, s, time);
    // safety: never under the road / inside the bird (a close-up may not enter the body)
    if (targetPos.y < 0.42) targetPos.y = 0.42;
    enforceMinDist(2.15);
  }

  // ---------------------------------------------------------------- dispatch
  function computeMode(st, dt, s, time) {
    switch (mode) {
      case 'chase': updateChase(st, dt, s, time); break;
      case 'cinematic': updateCinematic(st, dt, s, time); break;
      case 'pov': updatePov(st, dt, s, time); break;
      case 'side': updateSide(st, dt, s, time); break;
      case 'drone': updateDrone(st, dt, s, time); break;
      default: updateChase(st, dt, s, time); break;
    }
    if (mode === 'pov') {
      const eyeMin = 0.4;
      if (targetPos.y < eyeMin) targetPos.y = eyeMin;
    } else {
      if (targetPos.y < 0.42) targetPos.y = 0.42;
      enforceMinDist(mode === 'cinematic' ? 2.15 : 1.8);
    }
  }

  // ---------------------------------------------------------------- shake
  function applyShake(dt, time) {
    if (shakeT <= 0) return;
    shakeT -= dt;
    const k = Math.max(0, shakeT / shakeDur);
    const amp = shakeAmp * k * k * motionScale();
    if (shakeT <= 0) shakeAmp = 0;
    if (amp <= 1e-5) return;
    // distance-based falloff so close-ups do not jitter wildly
    vTmp2.subVectors(camera.position, chest);
    const dist = vTmp2.length();
    const falloff = clamp(dist / 6, 0.35, 1);
    const a = amp * falloff;
    shakeRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    shakeUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const n1 = noise1(time * 33.0 + 2.0);
    const n2 = noise1(time * 41.0 + 9.0);
    const n3 = noise1(time * 27.0 + 5.0);
    camera.position.addScaledVector(shakeRight, n1 * a * 0.16);
    camera.position.addScaledVector(shakeUp, n2 * a * 0.13);
    camera.quaternion.multiply(qTmp.setFromAxisAngle(AXIS_Z, n3 * a * 0.05));
  }

  // ---------------------------------------------------------------- transitions
  function graphicStart(id) {
    fromPos.copy(camera.position);
    fromQuat.copy(camera.quaternion);
    fromFov = num(camera.fov, fovNow);
    transT = 0;
    // pov / cinematic get a snappier blend; classic rigs ease over .35s
    if (id === 'cinematic' || id === 'pov' || mode === 'cinematic' || mode === 'pov') transDur = 0.18;
    else transDur = 0.35;
    mode = id;
    if (id === 'cinematic') {
      shotIndex = 0;
      shotTime = 0;
      shotDur = SHOTS[0].dur;
      cineIn = false;
    }
    if (id === 'chase') { chaseInit = false; }
    if (id === 'side') { sideInit = false; }
    if (id === 'drone') { droneInit = false; }
    nearNow = id === 'pov' ? Math.min(baseNear, 0.06) : baseNear;
  }

  // ---------------------------------------------------------------- public
  function setMode(id) {
    if (!id || id === mode) return;
    if (!MODES.some((m) => m.id === id)) return;
    graphicStart(id);
  }

  function next() {
    const i = MODES.findIndex((m) => m.id === mode);
    setMode(MODES[(i + 1) % MODES.length].id);
  }
  function prev() {
    const i = MODES.findIndex((m) => m.id === mode);
    setMode(MODES[(i + MODES.length - 1) % MODES.length].id);
  }

  function update(dt, state) {
    if (!state) return;
    dt = clamp(num(dt, 0.016), 0.0001, 0.05);
    clock += dt;
    const time = num(state.time, clock);

    // ---- read the world
    bikePos.set(num(state.laneX, 0), num(state.jumpY, 0), num(state.bikeZ, 0));
    readPoint(state, 'getChestWorldPosition', chest, 1.35);
    readPoint(state, 'getHeadWorldPosition', head, 1.95);
    const s = clamp01(num(state.speedRatio, num(state.speed, 0) / num(state.speedMax, 34)));

    // ---- automatic micro-feedback (main/game may also call shake(); max() wins)
    const air = !!state.airborne;
    if (prevAirborne && !air) shakeNow(0.16, 0.24);
    const fish = num(state.fishCount, 0);
    if (fish > prevFish) shakeNow(0.09, 0.22);
    prevAirborne = air;
    prevFish = fish;

    // ---- desired camera for current mode
    computeMode(state, dt, s, time);

    // ---- first frame snaps
    if (!initialized) {
      initialized = true;
      chaseInit = chaseInit;
      camera.position.copy(targetPos);
      camera.quaternion.copy(targetQuat);
      fovNow = targetFov;
      fromPos.copy(targetPos);
      fromQuat.copy(targetQuat);
      fromFov = targetFov;
      transT = 1;
    }

    // ---- transition blend (mode changes only; cinematic cuts are instant)
    if (transT < 1) {
      transT = Math.min(1, transT + dt / Math.max(0.05, transDur));
      const k = smootherstep(0, 1, transT);
      camera.position.copy(fromPos).lerp(targetPos, k);
      prevQuat.copy(fromQuat);
      camera.quaternion.copy(prevQuat).slerp(targetQuat, k);
      fovNow = lerp(fromFov, targetFov, k);
    } else {
      camera.position.copy(targetPos);
      camera.quaternion.copy(targetQuat);
      fovNow = targetFov;
    }

    // ---- projection
    let projDirty = false;
    const wantNear = mode === 'pov' ? Math.min(baseNear, 0.06) : baseNear;
    if (Math.abs(nearNow - wantNear) > 1e-4) {
      nearNow = wantNear;
      camera.near = nearNow;
      projDirty = true;
    }
    if (Math.abs(fovNow - num(camera.fov, -999)) > 0.001) {
      camera.fov = fovNow;
      projDirty = true;
    }

    // ---- shake last (so blending never eats it)
    applyShake(dt, time);
    if (projDirty) camera.updateProjectionMatrix();
  }

  function shakeNow(amount, duration) {
    const a = clamp(num(amount, 0), 0, 2);
    if (a <= 0) return;
    shakeAmp = Math.max(shakeAmp, a);
    shakeDur = Math.max(0.06, num(duration, 0.3));
    shakeT = shakeDur;
  }

  function dispose() {
    try {
      if (mq && mqFn) {
        if (mq.removeEventListener) mq.removeEventListener('change', mqFn);
        else if (mq.removeListener) mq.removeListener(mqFn);
      }
    } catch (err) {
      /* ignore */
    }
  }

  const handle = {
    modes: MODES,
    get mode() { return mode; },
    get currentLabel() {
      for (let i = 0; i < MODES.length; i++) if (MODES[i].id === mode) return MODES[i].label;
      return '';
    },
    // extra: current cinematic shot label (HUD may show it as the camera hint)
    get shotLabel() {
      return mode === 'cinematic' && cineIn ? SHOTS[shotIndex].name : '';
    },
    setMode,
    next,
    prev,
    update,
    shake: shakeNow,
    dispose,
    // extra convenience for HUD/touch UI: pure state helpers
    get reducedMotion() { return reduceMotion; },
    // QA helper: jump straight to a cinematic shot (i = 0..SHOTS.length-1)
    debugShot(i) {
      if (mode !== 'cinematic') setMode('cinematic');
      const n = SHOTS.length;
      const k = ((Math.round(num(i, 0)) % n) + n) % n;
      shotIndex = k;
      shotTime = 0;
      shotDur = SHOTS[k].dur;
      cineIn = true;
      // snap next update straight to the shot (no cross-fade between cuts)
      transT = 1;
      return SHOTS[k].name;
    },
    get shotCount() { return SHOTS.length; },
    // QA helper: tune the virtual-eye rig live (x,y,z = offset from the eye, pitch in rad)
    debugPov(x, y, z, pitch) {
      if (typeof x === 'number') povOffX = x;
      if (typeof y === 'number') povOffY = y;
      if (typeof z === 'number') povOffZ = z;
      if (typeof pitch === 'number') povPitchBase = pitch;
      if (typeof pitch === 'number') povPitch = pitch;
      if (mode !== 'pov') setMode('pov');
      return { x: povOffX, y: povOffY, z: povOffZ, pitch: povPitchBase };
    },
  };
  return handle;
}
