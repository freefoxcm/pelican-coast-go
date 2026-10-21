// ============================================================================
// 鹈鹕海岸 · 追鱼 — game.js  (Lead-owned: speed, lanes, jump, fish, combos,
// 14 achievements, autopilot, distance/score)
// ============================================================================
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, makeRng, randRange, TAU } from './util.js';

export const ACHIEVEMENTS = [
  { id: 'first_flap', name: '初次展翅', desc: '按下 T 展翅抬前轮' },
  { id: 'first_jump', name: '一跃而起', desc: '完成第一次跳跃' },
  { id: 'aerial_fish', name: '空中飞鱼', desc: '滞空时抓到一条鱼' },
  { id: 'fish_10', name: '大胃王', desc: '累计抓到 10 条鱼' },
  { id: 'triple_combo', name: '鱼贯而入', desc: '6 秒内连抓 3 条鱼' },
  { id: 'max_speed', name: '风驰电掣', desc: '速度突破 108 km/h' },
  { id: 'night_rider', name: '夜行者', desc: '骑进星空月夜' },
  { id: 'star_gazer', name: '星空漫游', desc: '在星空下骑行 20 秒' },
  { id: 'scarf_dance', name: '围巾狂舞', desc: '以 72 km/h 以上飞驰 10 秒' },
  { id: 'clean_landing', name: '完美落地', desc: '从 0.8 秒以上滞空平稳落地' },
  { id: 'film_star', name: '电影明星', desc: '在电影运镜下骑行 25 秒' },
  { id: 'photographer', name: '摄影指导', desc: '5 种镜头各用一次' },
  { id: 'autopilot_20', name: '自动驾驶', desc: '让鹈鹕自动追鱼 20 秒' },
  { id: 'marathon', name: '海岸马拉松', desc: '累计骑行 2000 米' },
];

const LANE_X = [-4, 0, 4];
const SEA_X = 25;
const GRAVITY = 17;
const JUMP_V = 8.6;
const MAX_FISH_POOL = 9;

export function createGame({ scene, state, input, hud, audio, cameras }) {
  const rng = makeRng(20241020);

  // ---------------------------------------------------------------- visuals
  const fishGroup = new THREE.Group();
  fishGroup.name = 'FishGroup';
  scene.add(fishGroup);

  const fishMats = {
    body: new THREE.MeshStandardMaterial({
      color: 0x9fd9ea, roughness: 0.42, metalness: 0.25, flatShading: true,
      emissive: 0x0e2b36, emissiveIntensity: 0.35,
    }),
    fin: new THREE.MeshStandardMaterial({
      color: 0x6fb9d6, roughness: 0.55, metalness: 0.15, flatShading: true, side: THREE.DoubleSide,
      emissive: 0x0a222c, emissiveIntensity: 0.4,
    }),
    eye: new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.2, metalness: 0.1 }),
  };
  const fishGeo = {
    body: new THREE.SphereGeometry(0.34, 9, 7),
    tail: new THREE.ConeGeometry(0.19, 0.42, 5),
    dorsal: new THREE.ConeGeometry(0.11, 0.3, 4),
    eye: new THREE.SphereGeometry(0.05, 6, 5),
  };

  function makeFishMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(fishGeo.body, fishMats.body);
    body.scale.set(2.05, 0.85, 0.62);
    g.add(body);
    const tail = new THREE.Mesh(fishGeo.tail, fishMats.fin);
    tail.rotation.z = Math.PI / 2;
    tail.position.x = 0.72;
    tail.scale.set(1, 1, 0.45);
    g.add(tail);
    const dorsal = new THREE.Mesh(fishGeo.dorsal, fishMats.fin);
    dorsal.position.set(-0.05, 0.3, 0);
    dorsal.rotation.z = -0.25;
    dorsal.scale.set(1, 1, 0.4);
    g.add(dorsal);
    const eyeL = new THREE.Mesh(fishGeo.eye, fishMats.eye);
    eyeL.position.set(-0.5, 0.1, 0.18);
    g.add(eyeL);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.18;
    g.add(eyeR);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = true; } });
    return g;
  }

  const fishes = [];
  for (let i = 0; i < MAX_FISH_POOL; i++) {
    const mesh = makeFishMesh();
    mesh.visible = false;
    fishGroup.add(mesh);
    fishes.push({
      mesh, active: false, age: 0, life: 3, x0: SEA_X, tx: 0, peakY: 1.2, high: false,
      relZ: 0, startRel: 16, caught: false, bob: 0, x: SEA_X, y: -7,
    });
  }

  // splash rings (pooled)
  const splashMat = new THREE.MeshBasicMaterial({
    color: 0xe8fbff, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false,
  });
  const splashGeo = new THREE.RingGeometry(0.3, 0.52, 18);
  const splashes = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(splashGeo, splashMat.clone());
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    fishGroup.add(m);
    splashes.push({ mesh: m, life: 0, max: 0.7, active: false });
  }
  function spawnSplash(x, y, z, size = 1) {
    const s = splashes.find((v) => !v.active) || splashes[0];
    s.active = true;
    s.life = 0;
    s.max = 0.7;
    s.mesh.visible = true;
    s.mesh.position.set(x, y, z);
    s.mesh.scale.setScalar(size);
    s.mesh.material.opacity = 0.7;
  }

  // ---------------------------------------------------------------- progress
  const achievements = ACHIEVEMENTS.map((a) => ({ ...a, unlocked: false, at: 0 }));
  const byId = new Map(achievements.map((a) => [a.id, a]));
  const prog = {
    airTime: 0, jumpSpeed: 0, cine: 0, auto: 0, starry: 0, scarf: 0,
    cams: new Set(), streak: 0, lastCatch: -99,
  };

  let speed = 0;
  let boost = 0;
  let lane = 1;
  let laneX = 0;
  let lean = 0;
  let jumpY = 0;
  let jumpVy = 0;
  let airborne = false;
  let wheelie = 0;
  let wingsOut = 0;
  let wingTimer = 0;
  let spawnTimer = 1.2;
  let time = 0;
  let fishCount = 0;
  let score = 0;
  let started = false;
  let lastLaneShift = -99;
  let lastCamera = 'chase';

  // ---------------------------------------------------------------- helpers
  function toast(title, desc, kind) { try { hud?.toast?.(title, desc, kind); } catch (e) { /* ignore */ } }
  function flash(kind) { try { hud?.flash?.(kind); } catch (e) { /* ignore */ } }
  function sfx(n) { try { audio?.sfx?.(n); } catch (e) { /* ignore */ } }
  function shake(a, b) { try { cameras?.shake?.(a, b); } catch (e) { /* ignore */ } }

  function unlock(id) {
    const a = byId.get(id);
    if (!a || a.unlocked) return false;
    a.unlocked = true;
    a.at = time;
    sfx('achievement');
    toast(a.name, a.desc, 'ach');
    flash('ach');
    console.log('[achievement]', id);
    return true;
  }

  function deactivateFish(f) {
    f.active = false;
    f.mesh.visible = false;
  }

  function spawnFish() {
    const activeCount = fishes.reduce((n, f) => n + (f.active ? 1 : 0), 0);
    if (activeCount >= 4) return;
    const f = fishes.find((v) => !v.active);
    if (!f) return;
    const laneIdx = Math.floor(rng() * 3);
    const high = rng() < 0.34;
    f.active = true;
    f.caught = false;
    f.age = 0;
    f.life = randRange(rng, 2.7, 3.8);
    f.startRel = randRange(rng, 15, 20);
    f.relZ = f.startRel;
    f.x0 = SEA_X;
    f.tx = LANE_X[laneIdx] + randRange(rng, -0.6, 0.6);
    f.lane = laneIdx;
    f.peakY = high ? randRange(rng, 3.15, 4.35) : randRange(rng, 0.95, 1.75);
    f.high = high;
    f.bob = rng() * TAU;
    f.y = -7;
    f.x = SEA_X;
    f.mesh.visible = true;
    f.mesh.scale.setScalar(high ? 0.68 : 0.6);
    spawnSplash(SEA_X - 1.5, -8.4, state.bikeZ - f.startRel, 1.4);
  }

  function doJump() {
    if (airborne) return false;
    jumpVy = JUMP_V;
    airborne = true;
    prog.airTime = 0;
    prog.jumpSpeed = speed;
    sfx('jump');
    flash('jump');
    unlock('first_jump');
    if (!started) started = true;
    return true;
  }

  function land() {
    jumpY = 0;
    airborne = false;
    const air = prog.airTime;
    prog.airTime = 0;
    sfx('land');
    shake(0.1, 0.28);
    if (air > 0.78 && speed >= prog.jumpSpeed * 0.92 - 0.5) unlock('clean_landing');
  }

  function catchFish(f) {
    deactivateFish(f);
    f.caught = true;
    fishCount++;
    const fresh = time - prog.lastCatch < 6;
    prog.streak = fresh ? prog.streak + 1 : 1;
    prog.lastCatch = time;
    const combo = clamp(prog.streak, 1, 5);
    const pts = Math.round(100 * combo * (1 + state.speedRatio * 0.6));
    score += pts;
    boost = Math.min(9, boost + 2.4);
    speed = Math.min(state.speedMax, speed + 0.7);
    sfx('catch');
    flash('catch');
    shake(0.09, 0.22);
    try { state.pelican?.catchFish?.(); } catch (e) { /* ignore */ }
    if (airborne) unlock('aerial_fish');
    if (fishCount >= 10) unlock('fish_10');
    if (prog.streak >= 3) unlock('triple_combo');
  }

  // ---------------------------------------------------------------- autopilot
  function autopilotDrive(dt) {
    let best = null;
    let bestScore = 1e9;
    for (const f of fishes) {
      if (!f.active) continue;
      if (f.relZ < -8 || f.relZ > 26) continue;
      const s = Math.abs(f.relZ) * 1.0 + Math.abs(f.x - laneX) * 0.35;
      if (s < bestScore) { bestScore = s; best = f; }
    }
    if (best) {
      const desiredLane = clamp(Math.round((best.tx + 4) / 4), 0, 2);
      if (time - lastLaneShift > 0.5 && desiredLane !== lane) {
        lane += Math.sign(desiredLane - lane);
        lastLaneShift = time;
      }
      if (best.high && best.relZ < 6.5 && best.relZ > 0.5 && jumpY <= 0.02) doJump();
      if (!best.high && best.relZ < 9 && best.relZ > 2 && rng() < dt * 0.55) doJump();
    } else if (lane !== 1 && time - lastLaneShift > 1.5) {
      lane += Math.sign(1 - lane);
      lastLaneShift = time;
    }
    if (wingTimer <= 0 && rng() < dt * 0.05) {
      wingTimer = 2.0;
      sfx('flap');
      unlock('first_flap');
    }
  }

  // ---------------------------------------------------------------- update
  function update(dt, st) {
    if (!started) return;
    time += dt;

    // ---- input / autopilot
    const idleFor = st.time - input.lastManual;
    if (idleFor > 1.8 && !st.autopilot) st.autopilot = true;
    if (idleFor < 1.8 && st.autopilot) st.autopilot = false;

    let jumpPressed = input.consume('jump');
    let wingPressed = input.consume('wing');
    if (input.consume('left')) { lane = clamp(lane - 1, 0, 2); lastLaneShift = time; }
    if (input.consume('right')) { lane = clamp(lane + 1, 0, 2); lastLaneShift = time; }
    if (st.autopilot) {
      autopilotDrive(dt);
      jumpPressed = jumpPressed || false;
    }

    // ---- jump
    if (jumpPressed) doJump();
    if (airborne) {
      jumpVy -= GRAVITY * dt;
      jumpY += jumpVy * dt;
      prog.airTime += dt;
      if (jumpY <= 0) land();
    } else {
      jumpY = 0;
    }

    // ---- show-off (T: wings + wheelie)
    if (wingPressed && wingTimer < 0.35) {
      wingTimer = 2.5;
      sfx('flap');
      unlock('first_flap');
      speed = Math.min(st.speedMax, speed + 0.4);
    }
    wingTimer = Math.max(0, wingTimer - dt);
    wheelie = damp(wheelie, wingTimer > 0 ? 1 : 0, 6, dt);
    wingsOut = damp(wingsOut, wingTimer > 0 ? 1 : 0, 5, dt);

    // ---- speed
    let target;
    if (st.autopilot) target = 17 + (airborne ? 0 : 1.5);
    else if (input.brake) target = 0;
    else if (input.accel) target = 26;
    else target = 13;
    target += boost;
    boost = Math.max(0, boost - dt * 1.5);
    const lambda = input.brake ? 3.4 : speed < target ? 1.15 : 0.5;
    speed = damp(speed, target, lambda, dt);
    speed = clamp(speed, 0, st.speedMax);

    // ---- lane lateral motion
    const targetX = LANE_X[lane];
    const prevX = laneX;
    laneX = damp(laneX, targetX, 7.5, dt);
    const lateral = (laneX - prevX) / Math.max(dt, 0.0001);
    lean = damp(lean, clamp(lateral * 0.17, -1, 1), 8, dt);

    // ---- advance along the coast
    st.bikeZ -= speed * dt;
    const dist = speed * dt;
    st.distance += dist;

    // ---- cadence
    st.cadence = clamp(0.3 + (speed / st.speedMax) * 1.3 + (input.accel ? 0.18 : 0) - (input.brake ? 0.3 : 0), 0.12, 1.85);

    // ---- fish
    spawnTimer -= dt * (0.8 + st.speedRatio * 1.1);
    if (spawnTimer <= 0) {
      spawnTimer = randRange(rng, 1.15, 2.2) / (1 + st.speedRatio * 0.4);
      spawnFish();
    }
    const catchY = 1.3 + jumpY * 1.0;
    for (const f of fishes) {
      if (!f.active) continue;
      f.age += dt;
      const u = clamp01(f.age / f.life);
      const s = Math.sin(Math.PI * u);
      f.relZ = f.startRel * Math.cos(Math.PI * u);
      f.x = f.x0 + (f.tx - f.x0) * Math.pow(s, 1.1);
      f.y = -7 + (f.peakY + 7) * Math.pow(s, 1.35);
      const wobble = Math.sin(f.age * 11 + f.bob) * 0.1;
      f.mesh.position.set(f.x, f.y + wobble, st.bikeZ - f.relZ);
      f.mesh.rotation.z = Math.sin(f.age * 14 + f.bob) * 0.28;
      f.mesh.rotation.y = (f.x - f.tx) > 0 ? 0.35 : -0.35;
      if (f.y < -8.5 && u > 0.55) {
        spawnSplash(f.x, -8.4, st.bikeZ - f.relZ, 1.1);
        deactivateFish(f);
        continue;
      }
      if (u >= 1) { deactivateFish(f); continue; }
      // catch test
      if (f.x < 11.5) {
        const dx = Math.abs(f.x - laneX);
        const dz = Math.abs(f.relZ);
        const dy = Math.abs(f.y - catchY);
        if (dx < 2.85 && dz < 4.2 && dy < 1.8) catchFish(f);
      }
    }

    // fish emissive at night (subtle: they must read as fish, not as lamps)
    fishMats.body.emissiveIntensity = 0.3 + st.night * 0.55;
    fishMats.fin.emissiveIntensity = 0.35 + st.night * 0.5;

    // splashes
    for (const sp of splashes) {
      if (!sp.active) continue;
      sp.life += dt;
      const u = sp.life / sp.max;
      if (u >= 1) { sp.active = false; sp.mesh.visible = false; continue; }
      sp.mesh.scale.setScalar(1 + u * 3.4);
      sp.mesh.material.opacity = 0.7 * (1 - u);
    }

    // ---- combo decay
    if (time - prog.lastCatch > 4.5) {
      if (prog.streak > 0) prog.streak = 0;
    }
    const combo = clamp(prog.streak, 1, 5);

    // ---- publish state
    st.speed = speed;
    st.speedRatio = clamp01(speed / st.speedMax);
    st.lane = lane;
    st.laneX = laneX;
    st.lean = lean;
    st.jumpY = jumpY;
    st.airborne = airborne;
    st.grounded = !airborne;
    st.wheelie = wheelie;
    st.wingsOut = wingsOut;
    st.fishCount = fishCount;
    st.score = score;
    st.combo = combo;

    // ---- achievements
    if (st.night > 0.85) unlock('night_rider');
    if (st.dayPhase > 0.4 && st.dayPhase < 0.7 && st.night > 0.65) prog.starry += dt;
    if (prog.starry > 20) unlock('star_gazer');
    if (speed > 20) prog.scarf += dt;
    else prog.scarf = Math.max(0, prog.scarf - dt * 2.5);
    if (prog.scarf > 10) unlock('scarf_dance');
    if (speed > 30) unlock('max_speed');
    if (st.cameraMode === 'cinematic') prog.cine += dt;
    if (prog.cine > 25) unlock('film_star');
    if (st.cameraMode !== lastCamera) { lastCamera = st.cameraMode; prog.cams.add(st.cameraMode); }
    else prog.cams.add(st.cameraMode);
    if (prog.cams.size >= 5) unlock('photographer');
    if (st.autopilot) prog.auto += dt;
    if (prog.auto > 20) unlock('autopilot_20');
    if (st.distance >= 2000) unlock('marathon');
  }

  // ---------------------------------------------------------------- lifecycle
  function begin() {
    started = true;
    state.autopilot = true;
    input.lastManual = -99;
    lane = 1;
    laneX = 0;
    speed = 7;
    spawnTimer = 0.6;
    toast('出发！', 'W 加速 · A/D 变道抓鱼 · 空格跳跃 · T 展翅', 'info');
  }

  function reset() {
    for (const f of fishes) deactivateFish(f);
    for (const sp of splashes) { sp.active = false; sp.mesh.visible = false; }
    speed = 0; boost = 0; lane = 1; laneX = 0; lean = 0;
    jumpY = 0; jumpVy = 0; airborne = false; wheelie = 0; wingsOut = 0; wingTimer = 0;
    spawnTimer = 1.2; time = 0; fishCount = 0; score = 0;
    prog.airTime = 0; prog.cine = 0; prog.auto = 0; prog.starry = 0; prog.scarf = 0;
    prog.streak = 0; prog.lastCatch = -99; prog.cams = new Set(); lastCamera = 'chase';
    started = true;
    state.autopilot = true;
    input.lastManual = -99;
  }

  function debugUnlock(i) {
    if (typeof i === 'string') return unlock(i);
    const a = achievements[i];
    if (!a) return false;
    return unlock(a.id);
  }
  function debugUnlockAll() {
    for (const a of achievements) unlock(a.id);
    return achievements.every((a) => a.unlocked);
  }

  return {
    update,
    begin,
    reset,
    achievements,
    debugUnlock,
    debugUnlockAll,
    fishes,
    get started() { return started; },
    dispose() { scene.remove(fishGroup); },
  };
}
