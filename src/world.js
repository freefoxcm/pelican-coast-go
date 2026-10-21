// ============================================================================
// world.js — 天空 / 海洋 / 海岸地形 / 公路与路边道具 / 昼夜氛围
// 鹈鹕海岸 · 追鱼 (owner: world-env, per src/CONTRACT.md §4.1)
//
//  - 纯程序化：所有贴图 CanvasTexture，无外部资源。
//  - 世界坐标：前进 -Z，+X = 大海，路面 y=0，海面基准 y=-9，岸线 x≈27（带起伏）。
//  - 天空/星辰每帧跟随相机；海面平面每帧跟随相机，但波相位锁世界坐标。
//  - 所有路边道具按 bikeZ 池化回收；每帧不新建对象。
//  - 通过 renderer 的 tone mapping：shader 末尾 include 标准 chunk，兼容 composer。
// ============================================================================
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, makeRng, noise1, TAU } from './util.js';

const D2R = Math.PI / 180;
const OCEAN_Y = -9;
const ROAD_HALF = 6;
const GUARD_X = 6.78;
const SHORE = { base: 27.5, a1: 4.2, f1: 0.045, a2: 2.0, f2: 0.085, p2: 2.0 };
const Z_START = 240;
const Z_END = -9200;
const Z_STEP = 22;

// ---------------------------------------------------------------- math utils
const wrap01 = (v) => ((v % 1) + 1) % 1;

function shoreX(z) {
  return SHORE.base + SHORE.a1 * Math.sin(z * SHORE.f1) + SHORE.a2 * Math.sin(z * SHORE.f2 + SHORE.p2);
}

// 沙滩 / 海底剖面：y 从路肩 -0.18 平滑落到水下
function beachY(x, z) {
  const sx = shoreX(z);
  const edge = 6.1;
  if (x <= sx) {
    const u = clamp01((x - edge) / Math.max(4, sx - edge));
    return -0.18 - 8.82 * Math.pow(u, 0.85);
  }
  const d = x - sx;
  return -9 - 13 * (1 - Math.exp(-d * 0.06)) - 6 * smoothstep(0, 80, d);
}

// 左侧山崖剖面：路边留平缓草坡，9m 外开始抬升；最高约 34m 的连绵海崖
function cliffY(x, z) {
  const a = clamp01((-x - 9) / 140);
  const ridge =
    noise1(z * 0.011 + 3.1) * 4.2 +
    noise1(z * 0.032 + 8.7) * 1.7 +
    noise1(z * 0.09 + 1.3) * 0.65;
  const swell = Math.sin(z * 0.0047 + 1.1) * 2.4;
  const rise = 31 * Math.pow(a, 1.18);
  const h = -0.04 + rise + (ridge + swell) * (0.02 + a * 1.02);
  return Math.max(-0.12, h);
}

// ---------------------------------------------------------------- palette
const COLOR_KEYS = [
  'zenith', 'horizon', 'skyMid', 'ground', 'haze', 'fog', 'hemiSky', 'hemiGround',
  'sunLight', 'moonLight', 'sunGlow', 'moonGlow',
  'waterDeep', 'waterShallow', 'foam', 'cloud', 'lamp',
];
const NUM_KEYS = [
  'hemiInt', 'sunInt', 'moonInt', 'sunGlowAmt', 'moonGlowAmt',
  'sunDiscInt', 'moonDiscInt', 'sunSpecInt', 'moonSpecInt',
  'starAmt', 'milkyAmt', 'lampAmt', 'fogNear', 'fogFar', 'cloudEmit', 'oceanDetail',
];

// t: phase。0.00 金色黄昏 → 0.12 日落 → 0.30 蓝调 → 0.50 深夜 → 0.90 拂晓。
const PALETTE_RAW = [
  { t: 0.0,
    zenith: 0x2f5797, horizon: 0xffb066, skyMid: 0x9a86b0, ground: 0x352c4a, haze: 0xffd39a, fog: 0xe79a63,
    hemiSky: 0xffcf9e, hemiGround: 0x463850, sunLight: 0xffb169, moonLight: 0xa8c0e8,
    sunGlow: 0xffd9a0, moonGlow: 0xcfe0ff,
    waterDeep: 0x0a2536, waterShallow: 0x2f8f8a, foam: 0xfff1e0, cloud: 0xffe0c4, lamp: 0xffc07a,
    hemiInt: 1.0, sunInt: 2.3, moonInt: 0.05, sunGlowAmt: 1.0, moonGlowAmt: 0.0,
    sunDiscInt: 2.6, moonDiscInt: 0.0, sunSpecInt: 2.4, moonSpecInt: 0.0,
    starAmt: 0.0, milkyAmt: 0.0, lampAmt: 0.18, fogNear: 55, fogFar: 520, cloudEmit: 0.18, oceanDetail: 1.0 },
  { t: 0.06,    zenith: 0x3f3c78, horizon: 0xff7a45, skyMid: 0xc4708e, ground: 0x2a2242, haze: 0xffb083, fog: 0xdb7a5c,
    hemiSky: 0xffa47e, hemiGround: 0x382a46, sunLight: 0xff8a4f, moonLight: 0x9fb8e0,
    sunGlow: 0xff9d6a, moonGlow: 0xbfd4ff,
    waterDeep: 0x0f2234, waterShallow: 0x2f6f79, foam: 0xffe9dc, cloud: 0xffc2a4, lamp: 0xffbd76,
    hemiInt: 0.92, sunInt: 1.9, moonInt: 0.06, sunGlowAmt: 1.3, moonGlowAmt: 0.05,
    sunDiscInt: 2.8, moonDiscInt: 0.1, sunSpecInt: 3.0, moonSpecInt: 0.1,
    starAmt: 0.0, milkyAmt: 0.0, lampAmt: 0.45, fogNear: 50, fogFar: 500, cloudEmit: 0.25, oceanDetail: 1.0 },
  { t: 0.13,
    zenith: 0x211d48, horizon: 0xff6070, skyMid: 0x8e4372, ground: 0x221a38, haze: 0xc46a8c, fog: 0x8a5272,
    hemiSky: 0xb06a8a, hemiGround: 0x241a36, sunLight: 0xff7a72, moonLight: 0xa8c4f0,
    sunGlow: 0xff7a86, moonGlow: 0xc0d6ff,
    waterDeep: 0x101c30, waterShallow: 0x2a5f78, foam: 0xf3e2dc, cloud: 0xe8a2b2, lamp: 0xffb973,
    hemiInt: 0.8, sunInt: 0.6, moonInt: 0.1, sunGlowAmt: 0.8, moonGlowAmt: 0.1,
    sunDiscInt: 0.9, moonDiscInt: 0.2, sunSpecInt: 1.4, moonSpecInt: 0.25,
    starAmt: 0.06, milkyAmt: 0.01, lampAmt: 0.82, fogNear: 45, fogFar: 470, cloudEmit: 0.2, oceanDetail: 1.0 },
  { t: 0.23,
    zenith: 0x172652, horizon: 0x5a5896, skyMid: 0x44488a, ground: 0x11182e, haze: 0x4a4e8c, fog: 0x333d68,
    hemiSky: 0x5c6396, hemiGround: 0x101220, sunLight: 0x8a92c8, moonLight: 0xbcd0ff,
    sunGlow: 0x8a7ab0, moonGlow: 0xcfe0ff,
    waterDeep: 0x0a1a30, waterShallow: 0x1e4d63, foam: 0xe2ebf2, cloud: 0x6e6d98, lamp: 0xffc27a,
    hemiInt: 0.52, sunInt: 0.2, moonInt: 0.32, sunGlowAmt: 0.28, moonGlowAmt: 0.4,
    sunDiscInt: 0.3, moonDiscInt: 0.8, sunSpecInt: 0.25, moonSpecInt: 0.9,
    starAmt: 0.42, milkyAmt: 0.2, lampAmt: 1.0, fogNear: 42, fogFar: 440, cloudEmit: 0.1, oceanDetail: 0.95 },
  { t: 0.34,
    zenith: 0x0c1838, horizon: 0x223258, skyMid: 0x1c2a50, ground: 0x070b1a, haze: 0x1e2e52, fog: 0x18233f,
    hemiSky: 0x3a4f86, hemiGround: 0x070a14, sunLight: 0x7a88b8, moonLight: 0xc8dcff,
    sunGlow: 0x2a3458, moonGlow: 0xd4e4ff,
    waterDeep: 0x051326, waterShallow: 0x17445c, foam: 0xd8e6f0, cloud: 0x40496e, lamp: 0xffc580,
    hemiInt: 0.42, sunInt: 0.06, moonInt: 0.64, sunGlowAmt: 0.06, moonGlowAmt: 0.75,
    sunDiscInt: 0.0, moonDiscInt: 1.0, sunSpecInt: 0.0, moonSpecInt: 1.5,
    starAmt: 0.85, milkyAmt: 0.75, lampAmt: 1.0, fogNear: 38, fogFar: 420, cloudEmit: 0.05, oceanDetail: 0.9 },
  { t: 0.5,
    zenith: 0x060c24, horizon: 0x16214a, skyMid: 0x101a38, ground: 0x050813, haze: 0x16213f, fog: 0x131d3b,
    hemiSky: 0x30437e, hemiGround: 0x05060d, sunLight: 0x60709c, moonLight: 0xd0e0ff,
    sunGlow: 0x1a2340, moonGlow: 0xdcebff,
    waterDeep: 0x030d1a, waterShallow: 0x123c50, foam: 0xcfe0ea, cloud: 0x2e3656, lamp: 0xffc98a,
    hemiInt: 0.37, sunInt: 0.0, moonInt: 0.74, sunGlowAmt: 0.0, moonGlowAmt: 1.0,
    sunDiscInt: 0.0, moonDiscInt: 1.1, sunSpecInt: 0.0, moonSpecInt: 2.0,
    starAmt: 1.0, milkyAmt: 1.0, lampAmt: 1.0, fogNear: 35, fogFar: 410, cloudEmit: 0.035, oceanDetail: 0.9 },
  { t: 0.68,
    zenith: 0x081230, horizon: 0x1c2650, skyMid: 0x142040, ground: 0x060a16, haze: 0x1a2444, fog: 0x172146,
    hemiSky: 0x30447e, hemiGround: 0x05070f, sunLight: 0x60709c, moonLight: 0xc0d4f8,
    sunGlow: 0x1a2340, moonGlow: 0xcfe0ff,
    waterDeep: 0x040f1e, waterShallow: 0x143f54, foam: 0xd2e2ec, cloud: 0x343c5e, lamp: 0xffc98a,
    hemiInt: 0.37, sunInt: 0.0, moonInt: 0.6, sunGlowAmt: 0.0, moonGlowAmt: 0.8,
    sunDiscInt: 0.0, moonDiscInt: 0.95, sunSpecInt: 0.0, moonSpecInt: 1.5,
    starAmt: 0.95, milkyAmt: 0.92, lampAmt: 0.95, fogNear: 36, fogFar: 415, cloudEmit: 0.04, oceanDetail: 0.9 },
  { t: 0.82,
    zenith: 0x142850, horizon: 0x3e4a80, skyMid: 0x33406e, ground: 0x0f1426, haze: 0x3c4a78, fog: 0x2c3560,
    hemiSky: 0x4a5c8c, hemiGround: 0x0c0f1c, sunLight: 0x9aa6cc, moonLight: 0xb0c8f0,
    sunGlow: 0x7a6a90, moonGlow: 0xbcd0f0,
    waterDeep: 0x08203a, waterShallow: 0x1b4a62, foam: 0xdbe8ee, cloud: 0x6a6a92, lamp: 0xffc27a,
    hemiInt: 0.5, sunInt: 0.05, moonInt: 0.2, sunGlowAmt: 0.12, moonGlowAmt: 0.25,
    sunDiscInt: 0.0, moonDiscInt: 0.4, sunSpecInt: 0.05, moonSpecInt: 0.5,
    starAmt: 0.5, milkyAmt: 0.4, lampAmt: 0.8, fogNear: 40, fogFar: 450, cloudEmit: 0.08, oceanDetail: 0.95 },
  { t: 0.92,
    zenith: 0x3c5c94, horizon: 0xffa06e, skyMid: 0xc98a92, ground: 0x2f2a44, haze: 0xffc9a4, fog: 0xcb8a76,
    hemiSky: 0xffc3a0, hemiGround: 0x2a2438, sunLight: 0xffb07c, moonLight: 0xa8c0e0,
    sunGlow: 0xffbe88, moonGlow: 0xa8c0e8,
    waterDeep: 0x0c2638, waterShallow: 0x2c7f86, foam: 0xffeada, cloud: 0xffcdb0, lamp: 0xffc07a,
    hemiInt: 0.85, sunInt: 1.7, moonInt: 0.02, sunGlowAmt: 0.9, moonGlowAmt: 0.0,
    sunDiscInt: 1.8, moonDiscInt: 0.0, sunSpecInt: 2.0, moonSpecInt: 0.0,
    starAmt: 0.06, milkyAmt: 0.02, lampAmt: 0.25, fogNear: 55, fogFar: 510, cloudEmit: 0.2, oceanDetail: 1.0 },
];

function compilePalette() {
  const stops = PALETTE_RAW.map((raw) => {
    const o = { t: raw.t };
    for (let i = 0; i < COLOR_KEYS.length; i++) o[COLOR_KEYS[i]] = new THREE.Color(raw[COLOR_KEYS[i]]);
    for (let i = 0; i < NUM_KEYS.length; i++) o[NUM_KEYS[i]] = raw[NUM_KEYS[i]];
    return o;
  });
  const first = stops[0];
  const last = { t: 1 };
  for (let i = 0; i < COLOR_KEYS.length; i++) last[COLOR_KEYS[i]] = first[COLOR_KEYS[i]].clone();
  for (let i = 0; i < NUM_KEYS.length; i++) last[NUM_KEYS[i]] = first[NUM_KEYS[i]];
  stops.push(last);
  const out = {};
  for (let i = 0; i < COLOR_KEYS.length; i++) out[COLOR_KEYS[i]] = new THREE.Color();
  for (let i = 0; i < NUM_KEYS.length; i++) out[NUM_KEYS[i]] = 0;
  return { stops, out };
}

// ---------------------------------------------------------------- small helpers
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(w, h, draw, { srgb = true, repeat = false, aniso = 8 } = {}) {
  const c = makeCanvas(w, h);
  draw(c.getContext('2d'), w, h, c);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}

// 合并低模零件（烘焙顶点色 + 平面法线），用于一次 draw 的路边道具。
class MeshBaker {
  constructor() {
    this.pos = [];
    this.col = [];
    this.tmpColor = new THREE.Color();
  }
  add(geo, color, matrix) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    const p = g.attributes.position;
    const c = this.tmpColor.set(color);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.col.push(c.r, c.g, c.b);
    }
    if (g !== geo) g.dispose();
    return this;
  }
  build() {
    return finalizeGeometry(this.pos, this.col);
  }
  get empty() {
    return this.pos.length === 0;
  }
}

const _mtx = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _eul = new THREE.Euler();
function compose(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _pos.set(x, y, z);
  _eul.set(rx, ry, rz);
  _quat.setFromEuler(_eul);
  _scl.set(sx, sy, sz);
  return _mtx.compose(_pos, _quat, _scl);
}

const _dummy = new THREE.Object3D();
function setInstance(mesh, i, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _dummy.position.set(x, y, z);
  _dummy.rotation.set(rx, ry, rz);
  _dummy.scale.set(sx, sy, sz);
  _dummy.updateMatrix();
  mesh.setMatrixAt(i, _dummy.matrix);
}

// 非索引几何收尾：剔除零面积/含 NaN 的三角形；可选强制朝上的绕序；
// 归一化法线并兜底 NaN —— 这是避免 Bloom 被 NaN 污染的关键。
function finalizeGeometry(posArr, colArr, { upward = false, uvScale = 0 } = {}) {
  const pos = [];
  const col = colArr ? [] : null;
  const uvs = uvScale > 0 ? [] : null;
  for (let i = 0; i + 8 < posArr.length; i += 9) {
    let ax = posArr[i], ay = posArr[i + 1], az = posArr[i + 2];
    let bx = posArr[i + 3], by = posArr[i + 4], bz = posArr[i + 5];
    let cx = posArr[i + 6], cy = posArr[i + 7], cz = posArr[i + 8];
    if (!(
      Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az) &&
      Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz) &&
      Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz)
    )) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-10) continue;
    if (upward && ny < 0) {
      let t = bx; bx = cx; cx = t;
      t = by; by = cy; cy = t;
      t = bz; bz = cz; cz = t;
      if (colArr) {
        for (let k = 0; k < 3; k++) {
          const tmp = colArr[i + 3 + k];
          colArr[i + 3 + k] = colArr[i + 6 + k];
          colArr[i + 6 + k] = tmp;
        }
      }
    }
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (col) {
      col.push(
        colArr[i], colArr[i + 1], colArr[i + 2],
        colArr[i + 3], colArr[i + 4], colArr[i + 5],
        colArr[i + 6], colArr[i + 7], colArr[i + 8]
      );
    }
    if (uvs) {
      uvs.push(ax * uvScale, az * uvScale, bx * uvScale, bz * uvScale, cx * uvScale, cz * uvScale);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  const n = g.attributes.normal;
  if (n) {
    for (let i = 0; i < n.count; i++) {
      const x = n.getX(i), y = n.getY(i), z = n.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z);
      if (!Number.isFinite(l) || l < 1e-6) n.setXYZ(i, 0, 1, 0);
    }
  }
  g.computeBoundingSphere();
  return g;
}

// 沿 -Z 无限循环的道具轨道：每帧回收，绝不 new。
class RailPool {
  constructor(period, count, behind = 60) {
    this.period = period;
    this.count = count;
    this.behind = behind;
    this.span = period * count;
    this.z = new Float64Array(count);
    this.ready = false;
  }
  reset(bikeZ) {
    for (let i = 0; i < this.count; i++) this.z[i] = bikeZ + this.behind - (i + 1) * this.period;
    this.ready = true;
  }
  update(bikeZ) {
    if (!this.ready) this.reset(bikeZ);
    const behind = bikeZ + this.behind;
    const ahead = bikeZ - (this.span - this.behind);
    for (let i = 0; i < this.count; i++) {
      let z = this.z[i];
      let guard = 0;
      while (z > behind + this.period && guard++ < 8) z -= this.span;
      guard = 0;
      while (z < ahead && guard++ < 8) z += this.span;
      this.z[i] = z;
    }
  }
}

// world 里的所有可释放资源
function makeDisposer() {
  const geos = [];
  const mats = [];
  const texs = [];
  return {
    geo(g) { geos.push(g); return g; },
    mat(m) { mats.push(m); return m; },
    tex(t) { texs.push(t); return t; },
    dispose() {
      for (let i = 0; i < texs.length; i++) texs[i].dispose();
      for (let i = 0; i < mats.length; i++) mats[i].dispose();
      for (let i = 0; i < geos.length; i++) geos[i].dispose();
      texs.length = geos.length = mats.length = 0;
    },
  };
}

// ============================================================================
//  moon / sign / glow textures
// ============================================================================
function makeMoonTexture(D) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const rng = makeRng(4242);
    const g = ctx.createRadialGradient(w * 0.44, h * 0.42, w * 0.06, w * 0.5, h * 0.5, w * 0.5);
    g.addColorStop(0.0, '#fffdf4');
    g.addColorStop(0.55, '#eef0e8');
    g.addColorStop(0.85, '#cfd4dd');
    g.addColorStop(1.0, '#b6bcc9');
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.5, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    // 环形山
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.5, 0, TAU);
    ctx.clip();
    for (let i = 0; i < 34; i++) {
      const a = rng() * TAU;
      const r = Math.sqrt(rng()) * w * 0.46;
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r;
      const cr = 2 + rng() * w * 0.075;
      const gg = ctx.createRadialGradient(x - cr * 0.3, y - cr * 0.3, cr * 0.1, x, y, cr);
      gg.addColorStop(0, 'rgba(150,155,168,0.55)');
      gg.addColorStop(0.7, 'rgba(175,180,192,0.35)');
      gg.addColorStop(1, 'rgba(235,238,240,0.12)');
      ctx.beginPath();
      ctx.arc(x, y, cr, 0, TAU);
      ctx.fillStyle = gg;
      ctx.fill();
    }
    // 月海暗斑
    for (let i = 0; i < 7; i++) {
      const a = rng() * TAU;
      const r = Math.sqrt(rng()) * w * 0.3;
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r;
      const rr = w * (0.05 + rng() * 0.1);
      ctx.beginPath();
      ctx.ellipse(x, y, rr, rr * (0.6 + rng() * 0.5), rng() * TAU, 0, TAU);
      ctx.fillStyle = `rgba(140,148,165,${0.10 + rng() * 0.12})`;
      ctx.fill();
    }
    ctx.restore();
    // 边缘柔化
    const vign = ctx.createRadialGradient(w / 2, h / 2, w * 0.42, w / 2, h / 2, w * 0.5);
    vign.addColorStop(0, 'rgba(0,0,0,0)');
    vign.addColorStop(1, 'rgba(0,0,0,0.9)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.5, 0, TAU);
    ctx.fillStyle = vign;
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }, { srgb: true, repeat: false, aniso: 2 });
}

function makeGlowTexture(inner = '#fff6dd', mid = 'rgba(255,214,140,0.55)') {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.25, mid);
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { srgb: true, aniso: 1 });
}

// 公路指示牌贴图
const SIGN_DEFS = {
  route: { w: 2.6, h: 1.35, y: 2.25, canvas: 512, draw: drawRouteSign },
  warn: { w: 1.7, h: 1.7, y: 2.25, canvas: 512, draw: drawWarnSign },
};

function signFont(ctx, px) {
  ctx.font = `700 ${px}px "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif`;
}

function drawRouteSign(ctx, w, h) {
  ctx.fillStyle = '#16477f';
  roundRect(ctx, 6, 6, w - 12, h - 12, 26);
  ctx.fill();
  ctx.strokeStyle = '#f2f5f7';
  ctx.lineWidth = 9;
  roundRect(ctx, 14, 14, w - 28, h - 28, 20);
  ctx.stroke();
  // 盾牌
  ctx.fillStyle = '#f3f6f8';
  ctx.beginPath();
  ctx.moveTo(78, 62);
  ctx.lineTo(152, 62);
  ctx.lineTo(152, 150);
  ctx.quadraticCurveTo(115, 200, 78, 150);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#16477f';
  signFont(ctx, 78);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('1', 115, 132);
  // 文字
  ctx.fillStyle = '#f6f8fa';
  ctx.textAlign = 'left';
  signFont(ctx, 58);
  ctx.fillText('海岸公路', 190, 108);
  signFont(ctx, 30);
  ctx.fillStyle = '#cfe3f3';
  ctx.fillText('PELICAN COAST HWY', 192, 158);
  ctx.fillStyle = '#ffd98c';
  ctx.fillText('慢行 · 注意海风', 192, 200);
}

function drawWarnSign(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  // 黄底菱形
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(Math.PI / 4);
  const s = w * 0.64;
  ctx.fillStyle = '#f6c945';
  roundRect(ctx, -s / 2, -s / 2, s, s, 18);
  ctx.fill();
  ctx.strokeStyle = '#2a2a28';
  ctx.lineWidth = 13;
  roundRect(ctx, -s / 2 + 10, -s / 2 + 10, s - 20, s - 20, 12);
  ctx.stroke();
  ctx.restore();
  // 鱼群
  ctx.save();
  ctx.translate(w / 2, h / 2 - 6);
  ctx.fillStyle = '#26261f';
  for (let i = 0; i < 3; i++) {
    const ox = -52 + i * 52;
    const oy = i === 1 ? -18 : 12;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(i === 1 ? 0.5 : -0.18);
    ctx.beginPath();
    ctx.ellipse(0, 0, 26, 13, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(24, 0);
    ctx.lineTo(40, -12);
    ctx.lineTo(40, 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  signFont(ctx, 34);
  ctx.fillStyle = '#26261f';
  ctx.textAlign = 'center';
  ctx.fillText('鱼群横穿', w / 2, h - 62);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 地面细节贴图（沙砾/岩石颗粒），与地形顶点色相乘
function makeGroundTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const rng = makeRng(31415);
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let v = 210 +
          Math.sin(x * 0.045 + y * 0.031) * 3.5 +
          Math.sin(x * 0.17 - y * 0.11 + 1.3) * 2.5 +
          (rng() - 0.5) * 34;
        const g = rng();
        if (g < 0.02) v -= 48 + rng() * 46;
        else if (g < 0.028) v += 26;
        v = clamp(v, 96, 255);
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v * 0.97;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 细裂纹
    for (let k = 0; k < 26; k++) {
      ctx.strokeStyle = `rgba(58,54,48,${0.05 + rng() * 0.08})`;
      ctx.lineWidth = 0.8 + rng() * 1.4;
      ctx.beginPath();
      let x = rng() * w;
      let y = rng() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        x += (rng() - 0.5) * 42;
        y += rng() * 30;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 浅色碎石点
    for (let k = 0; k < 420; k++) {
      const v = rng() < 0.5 ? 40 : 235;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.08 + rng() * 0.14})`;
      const s = 1 + rng() * 2.6;
      ctx.fillRect(rng() * w, rng() * h, s, s);
    }
  }, { srgb: true, repeat: true, aniso: 8 });
}

// 沥青 + 车道线（12m 宽 × 8m 长的贴图，沿 z 重复）
function makeAsphaltTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    const rng = makeRng(777);
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // 低频大块斑驳
        const patched =
          Math.sin(x * 0.012 + y * 0.004) * 3.2 +
          Math.sin(x * 0.004 - y * 0.02 + 1.7) * 2.4 +
          Math.sin((x + y) * 0.033) * 1.3;
        // 车道轮迹（三条车道中心 x = -4/0/+4 → u = 1/6, 1/2, 5/6）
        const u = x / w;
        let wear = 0;
        for (let l = 0; l < 3; l++) {
          const uc = (l + 0.5) / 3;
          const d = Math.abs(u - uc) * 12;
          wear += Math.exp(-d * d * 1.1) * 7; // 轮迹略亮
          wear += Math.exp(-Math.pow(Math.abs(d - 1.05) * 1.6, 2)) * 3.5;
        }
        const edge = Math.min(u, 1 - u);
        const edgeDark = edge < 0.06 ? (0.06 - edge) * 160 : 0;
        let v = 82 + patched + wear - edgeDark + (rng() - 0.5) * 15;
        v = clamp(v, 34, 132);
        data[i] = v;
        data[i + 1] = v + 1;
        data[i + 2] = v + 4;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 骨料颗粒
    for (let i = 0; i < 5200; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const l = rng() < 0.5 ? 255 : 0;
      ctx.fillStyle = `rgba(${l},${l},${l},${0.025 + rng() * 0.06})`;
      ctx.fillRect(x, y, 1 + rng() * 2.4, 1 + rng() * 2.4);
    }
    // 车道虚线（x=-2 / +2 → u=1/3, 2/3），3m 实 + 5m 空
    const lineW = (0.18 / 12) * w;
    for (const uc of [1 / 3, 2 / 3]) {
      const cx = uc * w;
      ctx.fillStyle = 'rgba(238,236,222,0.88)';
      ctx.fillRect(cx - lineW / 2, 0, lineW, h * 0.375);
      // 磨损
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(60,62,64,${0.12 + rng() * 0.3})`;
        ctx.fillRect(cx - lineW / 2 + rng() * lineW, rng() * h * 0.375, 1 + rng() * 3, 1 + rng() * 3);
      }
    }
    // 路肩实线
    for (const uc of [0.0165, 0.9835]) {
      const cx = uc * w;
      ctx.fillStyle = 'rgba(232,230,218,0.8)';
      ctx.fillRect(cx - lineW / 2, 0, lineW, h);
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = `rgba(58,60,62,${0.1 + rng() * 0.3})`;
        ctx.fillRect(cx - lineW / 2 + rng() * lineW, rng() * h, 1 + rng() * 2.5, 1 + rng() * 2.5);
      }
    }
    // 纵向补丁裂缝
    for (let i = 0; i < 7; i++) {
      ctx.strokeStyle = `rgba(30,31,34,${0.25 + rng() * 0.3})`;
      ctx.lineWidth = 1 + rng() * 2;
      ctx.beginPath();
      let x = rng() * w;
      let y = rng() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        x += (rng() - 0.5) * 70;
        y += rng() * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 横向接缝
    ctx.fillStyle = 'rgba(26,27,30,0.55)';
    ctx.fillRect(0, h * 0.53, w, 2.5);
  }, { srgb: true, repeat: true, aniso: 8 });
}

// ============================================================================
//  shaders
// ============================================================================
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SKY_FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHorizonCool;
uniform vec3 uWarmHorizon;
uniform vec3 uSkyMid;
uniform vec3 uGround;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunGlowColor;
uniform vec3 uMoonGlowColor;
uniform vec3 uSunDiscColor;
uniform vec3 uMoonColor;
uniform vec3 uMilkyColor;
uniform float uMilkyAmt;
uniform vec3 uGalacticN;
uniform vec3 uGalacticCore;
uniform float uSunGlowAmt;
uniform float uMoonGlowAmt;
uniform float uSunDiscInt;
uniform float uMoonDiscInt;
uniform vec3 uMoonRight;
uniform vec3 uMoonUp;
uniform float uMoonTanR;
uniform sampler2D uMoonTex;
uniform float uTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float hUp = clamp(h, 0.0, 1.0);

  // 方向性晚霞：朝太阳一侧地平线亮金/橙，背向一侧冷蓝紫
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float az = max(dot(dh, sh), 0.0);
  float toward = az * 0.5 + 0.5;
  float warmW = pow(toward, 1.8) * smoothstep(0.02, 0.45, uSunGlowAmt);
  vec3 horizonCol = mix(uHorizonCool, uWarmHorizon, clamp(warmW * 1.3, 0.0, 1.0));
  vec3 midCol = mix(mix(uSkyMid, uZenith, 0.35), uSkyMid, clamp(warmW * 1.5, 0.0, 1.0));
  // 三段式垂直渐变：方向性地平线 → 中空 → 天顶深蓝紫
  vec3 col = mix(horizonCol, midCol, smoothstep(0.0, 0.34, hUp));
  col = mix(col, uZenith, smoothstep(0.1, 0.72, hUp));
  // 地平线薄雾（朝太阳侧偏暖）
  vec3 hazeCol = mix(uHorizonCool, uHaze, clamp(warmW * 1.2, 0.0, 1.0));
  col = mix(col, hazeCol, exp(-hUp * 9.0) * 0.4);
  // 地平线以下（海面被遮住时作为背景色）
  col = mix(col, uGround, smoothstep(0.0, -0.3, h));

  // 太阳光晕
  float cs = max(dot(d, uSunDir), 0.0);
  float sunGlow = pow(cs, 6.0) * 0.34 + pow(cs, 48.0) * 0.9 + pow(cs, 700.0) * 3.2;
  col += uSunGlowColor * sunGlow * uSunGlowAmt;
  // 朝太阳方向的地平线暖带
  col += uSunGlowColor * pow(az, 2.5) * exp(-hUp * 7.0) * uSunGlowAmt * 0.28;

  // 太阳盘
  float cosR = 0.99966;
  float disc = smoothstep(cosR - 0.00028, cosR + 0.00012, cs);
  col += uSunDiscColor * disc * uSunDiscInt;

  // 月亮光晕与月盘
  float cm = max(dot(d, uMoonDir), 0.0);
  float moonGlow = pow(cm, 150.0) * 0.22 + pow(cm, 1200.0) * 0.6;
  col += uMoonGlowColor * moonGlow * uMoonGlowAmt;
  if (uMoonDiscInt > 0.002 && cm > 0.99) {
    float denom = max(cm, 0.2);
    vec2 luv = vec2(dot(d, uMoonRight), dot(d, uMoonUp)) / (denom * uMoonTanR) * 0.5 + 0.5;
    vec4 mt = texture2D(uMoonTex, luv);
    float edge = smoothstep(0.52, 0.43, length(luv - 0.5));
    float alpha = mt.a * edge * clamp(uMoonDiscInt, 0.0, 1.2);
    col = mix(col, uMoonColor * mt.rgb * 0.78, alpha * 0.78);
  }

  // 银河带（低频柔和光带，再叠加点到点星团）
  float mw = dot(d, uGalacticN);
  float band = exp(-mw * mw * 30.0);
  float coreGlow = pow(max(dot(d, uGalacticCore), 0.0), 6.0);
  float mwAmt = uMilkyAmt * (band * (0.014 + 0.012 * coreGlow) + band * band * 0.008);
  col += uMilkyColor * mwAmt;

  // 抖动，避免色带
  col += (hash12(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.003;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const OCEAN_VERT = `
uniform float uTime;
uniform float uWaveAmp;
uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vWaveH;

vec3 gerstner(vec4 w, vec2 p, float t, inout vec3 tang, inout vec3 bin) {
  vec2 d = normalize(w.xy);
  float k = w.z;
  float amp = w.w;
  float st = clamp(amp * k, 0.0, 0.6);
  float omega = sqrt(9.8 * k);
  float f = k * dot(d, p) - omega * t;
  float c = cos(f);
  float s = sin(f);
  float a = amp;
  tang += vec3(-d.x * d.x * st * s, d.x * st * c, -d.x * d.y * st * s);
  bin += vec3(-d.x * d.y * st * s, d.y * st * c, -d.y * d.y * st * s);
  return vec3(d.x * a * c, a * s, d.y * a * c);
}

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 tang = vec3(1.0, 0.0, 0.0);
  vec3 bin = vec3(0.0, 0.0, 1.0);
  vec3 off = vec3(0.0);
  off += gerstner(uWave0, wp.xz, uTime, tang, bin);
  off += gerstner(uWave1, wp.xz, uTime, tang, bin);
  off += gerstner(uWave2, wp.xz, uTime, tang, bin);
  off += gerstner(uWave3, wp.xz, uTime, tang, bin);
  off *= uWaveAmp;
  tang = mix(vec3(1.0, 0.0, 0.0), tang, uWaveAmp);
  bin = mix(vec3(0.0, 0.0, 1.0), bin, uWaveAmp);

  vec3 posW = wp + off;
  vWorldPos = posW;
  vWaveH = off.y;
  vNormalW = normalize(cross(bin, tang));
  gl_Position = projectionMatrix * viewMatrix * vec4(posW, 1.0);
}
`;

const OCEAN_FRAG = `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vWaveH;

uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunGlowColor;
uniform vec3 uMoonGlowColor;
uniform float uSunGlowAmt;
uniform float uMoonGlowAmt;
uniform vec3 uSunSpecColor;
uniform vec3 uMoonSpecColor;
uniform float uSunSpecInt;
uniform float uMoonSpecInt;
uniform float uSunUp;
uniform float uMoonUp;
uniform float uNight;
uniform vec4 uShoreA;
uniform vec4 uShoreB;
uniform float uDetail;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float shoreLineZ(float z) {
  return uShoreA.x + uShoreA.y * sin(z * uShoreB.x) + uShoreA.z * sin(z * uShoreB.y + uShoreA.w);
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);
  float detailFade = smoothstep(260.0, 35.0, dist);

  vec2 p = vWorldPos.xz;
  float t = uTime;

  // 碎片级细浪法线（世界坐标锁相）
  vec2 q1 = p * 0.34 + vec2(t * 0.16, t * 0.09);
  vec2 q2 = p * 1.15 - vec2(t * 0.26, t * 0.18);
  float h0 = vnoise(q1) * 0.66 + vnoise(q2) * 0.34;
  float hx = vnoise(q1 + vec2(0.3, 0.0)) * 0.66 + vnoise(q2 + vec2(0.3, 0.0)) * 0.34;
  float hz = vnoise(q1 + vec2(0.0, 0.3)) * 0.66 + vnoise(q2 + vec2(0.0, 0.3)) * 0.34;
  N.x += (h0 - hx) * 1.15 * uDetail * detailFade;
  N.z += (h0 - hz) * 1.15 * uDetail * detailFade;
  N = normalize(N);

  // 菲涅尔
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.5);
  fres = 0.035 + 0.965 * fres;
  vec3 R = reflect(-V, N);
  vec3 refl = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));

  // 太阳 / 月亮在反射方向上的光带
  float rs = max(dot(R, uSunDir), 0.0);
  refl += uSunGlowColor * (pow(rs, 9.0) * 0.34 + pow(rs, 140.0) * 1.9) * uSunGlowAmt * uSunUp;
  float rm = max(dot(R, uMoonDir), 0.0);
  refl += uMoonGlowColor * (pow(rm, 11.0) * 0.05 + pow(rm, 320.0) * 0.5) * uMoonGlowAmt * uMoonUp;

  // 水体颜色（近岸浅水）
  float shoreD = vWorldPos.x - shoreLineZ(vWorldPos.z);
  float shallow = smoothstep(26.0, 0.0, shoreD);
  vec3 body = mix(uDeepColor, uShallowColor, smoothstep(0.0, 1.0, shallow * 1.1));
  body *= 0.97 + 0.06 * vnoise(p * 0.12 + vec2(t * 0.02, -t * 0.015));
  vec3 col = mix(body, refl, fres * 0.92);

  // 波光粼粼：高频噪声调制的尖锐高光
  float sp1 = vnoise(p * 1.9 + vec2(t * 0.42, -t * 0.26));
  float sp2 = vnoise(p * 4.3 - vec2(t * 0.7, t * 0.33));
  float glit = smoothstep(0.46, 0.82, sp1 * 0.62 + sp2 * 0.38);
  vec3 Hs = normalize(uSunDir + V);
  float nhs = max(dot(N, Hs), 0.0);
  float sunSpec = (pow(nhs, 190.0) * 8.0 + pow(nhs, 30.0) * 0.2) * (0.12 + 1.8 * glit);
  sunSpec *= uSunSpecInt * uSunUp;
  vec3 Hm = normalize(uMoonDir + V);
  float nhm = max(dot(N, Hm), 0.0);
  float moonSpec = (pow(nhm, 650.0) * 7.0 + pow(nhm, 90.0) * 0.12) * (0.08 + 0.85 * glit);
  moonSpec *= uMoonSpecInt * uMoonUp;
  sunSpec = min(sunSpec, 2.2);
  moonSpec = min(moonSpec, 1.1);
  col += uSunSpecColor * sunSpec + uMoonSpecColor * moonSpec;

  // 近岸碎浪 / 泡沫
  float foamN = vnoise(p * 0.62 + vec2(0.0, t * 0.28));
  float foamN2 = vnoise(p * 2.2 - vec2(t * 0.42, t * 0.16));
  float band = smoothstep(11.0, 0.0, shoreD) * smoothstep(-2.0, 0.5, shoreD);
  float advance = 0.5 + 0.5 * sin(shoreD * 0.95 - t * 1.9 + foamN * 6.0);
  float breakLine = pow(advance, 6.0) * exp(-max(shoreD, 0.0) * 0.2);
  float wash = smoothstep(0.36, 0.74, foamN * 0.74 + foamN2 * 0.26) * smoothstep(6.0, 0.0, shoreD);
  float foam = clamp(band * (breakLine * 1.35 + wash * 1.0), 0.0, 1.0);
  // 离岸碎浪白帽（克制）
  float crestN = smoothstep(0.8, 0.97, vnoise(p * 0.17 + vec2(t * 0.08, -t * 0.05)) * 0.68 + foamN2 * 0.32);
  float crest = crestN * smoothstep(45.0, 150.0, shoreD) * 0.16;
  foam = clamp(foam + crest, 0.0, 1.0);
  vec3 foamCol = uFoamColor * (0.62 + 0.34 * max(dot(N, uSunDir), 0.0));
  foamCol += uSunGlowColor * uSunGlowAmt * 0.18;
  col = mix(col, foamCol, foam * 0.9 * (1.0 - uNight * 0.5));

  // 夜间生物荧光
  float bio = smoothstep(0.52, 0.86, vnoise(p * 0.085 + vec2(t * 0.02, -t * 0.014))) * smoothstep(130.0, 8.0, shoreD);
  col += vec3(0.01, 0.07, 0.085) * bio * uNight * 0.3;

  // 雾
  float fogF = smoothstep(uFogRange.x, uFogRange.y, dist);
  col = mix(col, uFogColor, fogF);

  col += (hash12(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.004;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERT = `
uniform float uTime;
uniform float uPR;
uniform float uStarAmt;
uniform float uSizeMul;
attribute float aSize;
attribute float aPhase;
attribute float aAlpha;
attribute vec3 aColor;
varying vec3 vColor;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 dir = normalize(position);
  float horizonFade = smoothstep(-0.02, 0.1, dir.y);
  gl_Position = projectionMatrix * mv;
  float tw = 0.74 + 0.26 * sin(uTime * 1.35 + aPhase * 6.2831853);
  vA = aAlpha * uStarAmt * horizonFade * tw;
  vColor = aColor;
  gl_PointSize = aSize * uSizeMul * uPR * (420.0 / max(1.0, -mv.z));
}
`;

const STAR_FRAG = `
varying vec3 vColor;
varying float vA;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.4) * vA;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HALO_VERT = `
uniform float uPR;
uniform float uSize;
uniform float uOpacity;
uniform float uFogNear;
uniform float uFogFar;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(20.0, -mv.z);
  float grow = pow(45.0 / d, 0.55);
  gl_PointSize = uSize * uPR * clamp(grow, 0.16, 2.6);
  float fogF = smoothstep(uFogNear, uFogFar, -mv.z);
  vA = uOpacity * (1.0 - fogF);
}
`;

const HALO_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);
  float a = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(uColor, a * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPRAY_VERT = `
uniform float uPxPerUnit;
attribute float aSize;
attribute float aAlpha;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = aAlpha;
  gl_PointSize = clamp(aSize * uPxPerUnit / max(1.0, -mv.z), 0.7, 46.0);
}
`;

const SPRAY_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 2.8) * vA;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FLY_VERT = `
uniform float uTime;
uniform float uPR;
uniform float uOpacity;
attribute float aSize;
attribute float aPhase;
varying float vA;
varying float vGlow;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(6.0, -mv.z);
  gl_PointSize = clamp(aSize * uPR * (70.0 / d), 1.0, 22.0);
  vGlow = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2.1 + aPhase * 6.2831853));
  float fogF = smoothstep(120.0, 340.0, -mv.z);
  vA = uOpacity * (1.0 - fogF);
}
`;

const FLY_FRAG = `
uniform vec3 uColor;
varying float vA;
varying float vGlow;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 4.0) * vA * vGlow;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ============================================================================
//  geometry builders
// ============================================================================
function makeOceanGeometry(size, seg) {
  const n = seg + 1;
  const pos = new Float32Array(n * n * 3);
  const half = size * 0.5;
  const coord = (t) => half * t * (0.18 + 0.82 * t * t);
  let k = 0;
  for (let j = 0; j < n; j++) {
    const tz = -1 + (2 * j) / seg;
    const z = coord(tz);
    for (let i = 0; i < n; i++) {
      const tx = -1 + (2 * i) / seg;
      pos[k++] = coord(tx);
      pos[k++] = 0;
      pos[k++] = z;
    }
  }
  const idx = new Uint32Array(seg * seg * 6);
  let m = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[m++] = a; idx[m++] = c; idx[m++] = b;
      idx[m++] = b; idx[m++] = c; idx[m++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

const TERRAIN_COLORS = {
  sandDry: new THREE.Color(0xcfb389),
  sandMid: new THREE.Color(0xb89b74),
  sandWet: new THREE.Color(0x87735a),
  pebble: new THREE.Color(0x877f72),
  rock: new THREE.Color(0x6b635a),
  rockDark: new THREE.Color(0x47423c),
  grass: new THREE.Color(0x5c6c42),
  grassDark: new THREE.Color(0x3a4c33),
  soil: new THREE.Color(0x665748),
  under: new THREE.Color(0x364744),
};

function buildTerrain(disposer) {
  const pos = [];
  const col = [];

  function pushTri(a, b, c, ca, cb, cc) {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }

  const beachX = [6.1, 7.5, 9.0, 10.7, 12.6, 14.7, 16.8, 18.5, 20.0, 21.4, 22.7, 24.0, 25.2, 26.4, 27.6, 28.8, 30.0, 31.2, 32.5, 33.8, 35.2, 36.8, 38.8, 41.2, 44.0, 47.5];
  const cliffX = [-6.1, -7.2, -8.5, -10.1, -12.0, -15.0, -18.5, -23, -28, -34, -41, -50, -61, -74, -90, -110, -135, -165, -200, -245, -300, -370, -460];
  const nz = Math.ceil((Z_START - Z_END) / Z_STEP) + 1;
  const zs = new Float32Array(nz);
  for (let j = 0; j < nz; j++) zs[j] = Z_START - j * Z_STEP;

  function beachColor(x, z, y, out) {
    const sx = shoreX(z);
    const wet = smoothstep(-2.5, -8.4, y);
    const n = noise1(x * 0.21 + z * 0.05) * 0.5 + 0.5;
    const n2 = noise1(x * 0.9 - z * 0.12) * 0.5 + 0.5;
    out.copy(TERRAIN_COLORS.sandDry).lerp(TERRAIN_COLORS.sandMid, n2 * 0.7);
    out.lerp(TERRAIN_COLORS.sandWet, wet);
    if (n > 0.62) out.lerp(TERRAIN_COLORS.pebble, (n - 0.62) * 1.8);
    const nearWater = smoothstep(-8.6, -9.6, y);
    out.lerp(TERRAIN_COLORS.under, nearWater * 0.8);
    if (y < -9.2) out.lerp(TERRAIN_COLORS.rockDark, 0.4);
    return out;
  }

  function cliffColor(x, z, y, out) {
    const n = noise1(x * 0.16 + z * 0.08 + 4.2) * 0.5 + 0.5;
    const strata = 0.5 + 0.5 * Math.sin(y * 0.55 + noise1(z * 0.05) * 2.5);
    out.copy(TERRAIN_COLORS.rock).lerp(TERRAIN_COLORS.rockDark, strata * 0.5);
    out.lerp(TERRAIN_COLORS.soil, n * 0.3);
    const green = smoothstep(22, 1.5, y) * (0.4 + n * 0.6);
    out.lerp(TERRAIN_COLORS.grass, clamp01(green) * 0.72);
    out.lerp(TERRAIN_COLORS.grassDark, smoothstep(0.5, 0.9, n) * smoothstep(26, 3, y) * 0.55);
    return out;
  }

  const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const c = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];

  // 沙滩（+X 侧）
  for (let j = 0; j < nz - 1; j++) {
    const z0 = zs[j];
    const z1 = zs[j + 1];
    for (let i = 0; i < beachX.length - 1; i++) {
      const x0 = beachX[i];
      const x1 = beachX[i + 1];
      const y00 = beachY(x0, z0);
      const y10 = beachY(x1, z0);
      const y01 = beachY(x0, z1);
      const y11 = beachY(x1, z1);
      beachColor(x0, z0, y00, c[0]);
      beachColor(x1, z0, y10, c[1]);
      beachColor(x1, z1, y11, c[2]);
      beachColor(x0, z1, y01, c[3]);
      v[0][0] = x0; v[0][1] = y00; v[0][2] = z0;
      v[1][0] = x1; v[1][1] = y10; v[1][2] = z0;
      v[2][0] = x1; v[2][1] = y11; v[2][2] = z1;
      v[3][0] = x0; v[3][1] = y01; v[3][2] = z1;
      pushTri(v[0], v[3], v[1], c[0], c[3], c[1]);
      pushTri(v[1], v[3], v[2], c[1], c[3], c[2]);
    }
  }

  // 左侧山崖（-X 侧）
  for (let j = 0; j < nz - 1; j++) {
    const z0 = zs[j];
    const z1 = zs[j + 1];
    for (let i = 0; i < cliffX.length - 1; i++) {
      const x0 = cliffX[i];
      const x1 = cliffX[i + 1];
      // 顶面起伏，强调低模切面
      const jitter = (xx, zz) => {
        const amp = 0.5 + clamp01((-xx) / 80) * 1.1;
        return (noise1(xx * 0.33 + zz * 0.17 + 9.1) * 1.15 + noise1(xx * 1.1 - zz * 0.4) * 0.32) * amp;
      };
      const y00 = cliffY(x0, z0) + jitter(x0, z0);
      const y10 = cliffY(x1, z0) + jitter(x1, z0);
      const y01 = cliffY(x0, z1) + jitter(x0, z1);
      const y11 = cliffY(x1, z1) + jitter(x1, z1);
      cliffColor(x0, z0, y00, c[0]);
      cliffColor(x1, z0, y10, c[1]);
      cliffColor(x1, z1, y11, c[2]);
      cliffColor(x0, z1, y01, c[3]);
      v[0][0] = x0; v[0][1] = y00; v[0][2] = z0;
      v[1][0] = x1; v[1][1] = y10; v[1][2] = z0;
      v[2][0] = x1; v[2][1] = y11; v[2][2] = z1;
      v[3][0] = x0; v[3][1] = y01; v[3][2] = z1;
      pushTri(v[0], v[1], v[3], c[0], c[1], c[3]);
      pushTri(v[1], v[2], v[3], c[1], c[2], c[3]);
    }
  }

  const g = finalizeGeometry(pos, col, { upward: true, uvScale: 0.11 });
  return disposer.geo(g);
}

// ============================================================================
//  createWorld
// ============================================================================
export function createWorld(scene, { quality = 0 } = {}) {
  const dispatcher = makeDisposer();
  const group = new THREE.Group();
  group.name = 'world';

  let level = clamp(quality | 0, 0, 2);
  let elapsed = 0;
  let ready = false;
  const pal = compilePalette();
  const pr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

  // ------------------------------------------------------------ shared uniforms
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x2f5797) },
    uHorizon: { value: new THREE.Color(0xffb066) },
    uHorizonCool: { value: new THREE.Color(0x4a5a90) },
    uWarmHorizon: { value: new THREE.Color(0xffc078) },
    uSkyMid: { value: new THREE.Color(0x9a86b0) },
    uGround: { value: new THREE.Color(0x352c4a) },
    uHaze: { value: new THREE.Color(0xffd39a) },
    uSunDir: { value: new THREE.Vector3(0.9, 0.1, -0.3) },
    uMoonDir: { value: new THREE.Vector3(-0.6, 0.5, -0.5) },
    uSunGlowColor: { value: new THREE.Color(0xffd9a0) },
    uMoonGlowColor: { value: new THREE.Color(0xcfe0ff) },
    uSunDiscColor: { value: new THREE.Color(0xfff1c8) },
    uMoonColor: { value: new THREE.Color(0xf6f3e8) },
    uSunGlowAmt: { value: 1 },
    uMoonGlowAmt: { value: 0 },
    uSunDiscInt: { value: 2.6 },
    uMoonDiscInt: { value: 0 },
    uMilkyColor: { value: new THREE.Color(0xbcd0ff) },
    uMilkyAmt: { value: 0 },
    uGalacticN: { value: new THREE.Vector3(0.72, 0.45, 0.52).normalize() },
    uGalacticCore: { value: new THREE.Vector3(-0.35, 0.38, -0.86).normalize() },
    uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
    uMoonUp: { value: new THREE.Vector3(0, 1, 0) },
    uMoonTanR: { value: 0.03 },
    uMoonTex: { value: null },
    uTime: { value: 0 },
  };

  const oceanUniforms = {
    uTime: { value: 0 },
    uWaveAmp: { value: 1 },
    uWave0: { value: new THREE.Vector4(0.85, -0.53, 0.1208, 0.78) },
    uWave1: { value: new THREE.Vector4(0.66, -0.75, 0.2027, 0.42) },
    uWave2: { value: new THREE.Vector4(0.93, -0.37, 0.3491, 0.22) },
    uWave3: { value: new THREE.Vector4(0.55, -0.83, 0.6614, 0.1) },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFogColor: { value: new THREE.Color() },
    uFogRange: { value: new THREE.Vector2(50, 480) },
    uDeepColor: { value: new THREE.Color() },
    uShallowColor: { value: new THREE.Color() },
    uFoamColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() },
    uMoonDir: { value: new THREE.Vector3() },
    uSunGlowColor: { value: new THREE.Color() },
    uMoonGlowColor: { value: new THREE.Color() },
    uSunGlowAmt: { value: 1 },
    uMoonGlowAmt: { value: 0 },
    uSunSpecColor: { value: new THREE.Color() },
    uMoonSpecColor: { value: new THREE.Color() },
    uSunSpecInt: { value: 2 },
    uMoonSpecInt: { value: 0 },
    uSunUp: { value: 1 },
    uMoonUp: { value: 0 },
    uNight: { value: 0 },
    uShoreA: { value: new THREE.Vector4(SHORE.base, SHORE.a1, SHORE.a2, SHORE.p2) },
    uShoreB: { value: new THREE.Vector4(SHORE.f1, SHORE.f2, 0, 0) },
    uDetail: { value: 1 },
  };

  // ------------------------------------------------------------ sky
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  });
  const skyGeo = dispatcher.geo(new THREE.SphereGeometry(60, 48, 28));
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  skyMesh.name = 'sky';
  group.add(skyMesh);

  const moonTex = dispatcher.tex(makeMoonTexture(256));
  moonTex.minFilter = THREE.LinearFilter;
  moonTex.magFilter = THREE.LinearFilter;
  moonTex.generateMipmaps = false;
  skyUniforms.uMoonTex.value = moonTex;

  // ------------------------------------------------------------ stars + milky way
  function buildStars(count, radius, band, rngSeed, colorMix) {
    const rng = makeRng(rngSeed);
    const pos = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const alphas = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color();
    const normal = new THREE.Vector3(0.78, 0.34, 0.26).normalize();
    const bandDir = new THREE.Vector3(-0.3, 0.3, -0.9).normalize();
    const dir = new THREE.Vector3();
    let i = 0;
    let guard = 0;
    while (i < count && guard++ < count * 40) {
      dir.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
      if (dir.lengthSq() < 0.05) continue;
      dir.normalize();
      if (band && Math.abs(dir.dot(normal)) > 0.28) continue;
      if (dir.y < -0.06) continue;
      pos[i * 3] = dir.x * radius;
      pos[i * 3 + 1] = dir.y * radius;
      pos[i * 3 + 2] = dir.z * radius;
      if (band) {
        const core = Math.max(0, dir.dot(bandDir));
        sizes[i] = 2.6 + rng() * 5.5 + core * 7 * rng();
        alphas[i] = 0.05 + rng() * 0.08 + core * 0.06;
        c.setRGB(0.72 + rng() * 0.2, 0.78 + rng() * 0.18, 1.0);
      } else {
        sizes[i] = 1.4 + Math.pow(rng(), 2.4) * 5.2;
        alphas[i] = 0.35 + rng() * 0.65;
        const t = rng();
        if (t < 0.14) c.setRGB(1.0, 0.86, 0.68);
        else if (t < 0.4) c.setRGB(0.8, 0.88, 1.0);
        else c.setRGB(0.94, 0.96, 1.0);
      }
      if (colorMix) c.lerp(colorMix, 0.2);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      phases[i] = rng();
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes.subarray(0, i), 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phases.subarray(0, i), 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alphas.subarray(0, i), 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors.subarray(0, i * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 1);
    return { geo: g, count: i };
  }

  const starData = buildStars(2500, 700, false, 20241, null);
  const milkyData = buildStars(950, 690, true, 5150, new THREE.Color(0.8, 0.86, 1.0));

  function makeStarMat(sizeMul) {
    return dispatcher.mat(new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPR: { value: pr },
        uStarAmt: { value: 0 },
        uSizeMul: { value: sizeMul },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    }));
  }
  const starMat = makeStarMat(1.0);
  const starMesh = new THREE.Points(dispatcher.geo(starData.geo), starMat);
  starMesh.frustumCulled = false;
  starMesh.renderOrder = 2;
  starMesh.name = 'stars';
  group.add(starMesh);

  const milkyMat = makeStarMat(1.0);
  const milkyMesh = new THREE.Points(dispatcher.geo(milkyData.geo), milkyMat);
  milkyMesh.frustumCulled = false;
  milkyMesh.renderOrder = 1;
  milkyMesh.name = 'milkyway';
  group.add(milkyMesh);

  // ------------------------------------------------------------ clouds
  function makeCloudGeometry(seed) {
    const rng = makeRng(seed);
    const baker = new MeshBaker();
    const blobs = 18 + Math.floor(rng() * 6);
    for (let i = 0; i < blobs; i++) {
      const r = 0.36 + rng() * 0.34;
      const px = (rng() - 0.5) * 2.6;
      const pz = (rng() - 0.5) * 1.25;
      const py = (rng() - 0.5) * 0.5 + (i % 4 === 0 ? 0.26 : 0);
      const shade = clamp(0.9 + py * 0.13 + rng() * 0.05, 0, 1);
      const m = compose(
        px, py, pz,
        rng() * 0.3, rng() * TAU, rng() * 0.25,
        r * 1.4, r * 1.0, r * 1.2
      ).clone();
      baker.add(new THREE.IcosahedronGeometry(1, 0), new THREE.Color(shade, shade, Math.min(1, shade + 0.02)), m);
    }
    return dispatcher.geo(baker.build());
  }
  const cloudGeo = makeCloudGeometry(9091);
  const cloudMat = dispatcher.mat(new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    fog: false,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    emissive: new THREE.Color(0xffdcc0),
    emissiveIntensity: 0.2,
  }));
  const CLOUD_COUNT = 9;
  const cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, CLOUD_COUNT);
  cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cloudMesh.frustumCulled = false;
  cloudMesh.name = 'clouds';
  group.add(cloudMesh);
  const cloudPool = new RailPool(230, CLOUD_COUNT, 80);
  const cloudData = [];
  {
    const rng = makeRng(3131);
    for (let i = 0; i < CLOUD_COUNT; i++) {
      cloudData.push({
        x: -460 + rng() * 920,
        y: 100 + rng() * 78,
        s: 34 + rng() * 44,
        ry: rng() * TAU,
        sy: 0.72 + rng() * 0.3,
        phase: rng() * TAU,
      });
      cloudMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    if (cloudMesh.instanceColor) cloudMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ ocean
  const oceanMat = dispatcher.mat(new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: true,
  }));
  let oceanSeg = 0;
  let oceanGeo = null;
  const oceanMesh = new THREE.Mesh(new THREE.BufferGeometry(), oceanMat);
  oceanMesh.frustumCulled = false;
  oceanMesh.name = 'ocean';
  group.add(oceanMesh);
  function rebuildOcean(segs) {
    if (segs === oceanSeg) return;
    const old = oceanMesh.geometry;
    const g = dispatcher.geo(makeOceanGeometry(1400, segs));
    oceanMesh.geometry = g;
    if (oceanGeo && old !== g) old.dispose();
    oceanGeo = g;
    oceanSeg = segs;
  }
  const OCEAN_SEGS = [220, 140, 80];

  // ------------------------------------------------------------ terrain
  const terrainMat = dispatcher.mat(new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: dispatcher.tex(makeGroundTexture()),
    roughness: 0.97,
    metalness: 0,
  }));
  const terrainGeo = buildTerrain(dispatcher);
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.name = 'terrain';
  group.add(terrainMesh);

  // ------------------------------------------------------------ road
  const asphaltTex = dispatcher.tex(makeAsphaltTexture());
  asphaltTex.repeat.set(1, (Z_START - Z_END) / 8);
  const roadMat = dispatcher.mat(new THREE.MeshStandardMaterial({
    map: asphaltTex,
    roughness: 0.94,
    metalness: 0.0,
    color: 0xffffff,
  }));
  const roadLen = Z_START - Z_END;
  const roadGeo = dispatcher.geo(new THREE.PlaneGeometry(ROAD_HALF * 2, roadLen, 1, 1));
  roadGeo.rotateX(-Math.PI / 2);
  roadGeo.translate(0, 0.02, (Z_START + Z_END) * 0.5);
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'road';
  group.add(roadMesh);

  // 路缘石 / 碎石路肩（合并成一个 mesh）
  {
    const baker = new MeshBaker();
    baker.add(new THREE.BoxGeometry(0.5, 0.17, roadLen), 0x898f8e, compose(6.12, 0.075, (Z_START + Z_END) * 0.5));
    baker.add(new THREE.BoxGeometry(0.5, 0.15, roadLen), 0x7f8483, compose(-6.12, 0.065, (Z_START + Z_END) * 0.5));
    baker.add(new THREE.BoxGeometry(1.0, 0.08, roadLen), 0x6d706c, compose(7.0, -0.02, (Z_START + Z_END) * 0.5));
    baker.add(new THREE.BoxGeometry(0.8, 0.08, roadLen), 0x64675f, compose(-6.7, -0.03, (Z_START + Z_END) * 0.5));
    const g = dispatcher.geo(baker.build());
    const m = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.9, metalness: 0 }));
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.name = 'shoulders';
    group.add(mesh);
  }

  // ------------------------------------------------------------ guardrail (dense pool)
  const GR_PERIOD = 4.2;
  const GR_COUNT = Math.ceil((340 + 70) / GR_PERIOD) + 1;
  const guardBaker = new MeshBaker();
  guardBaker.add(new THREE.BoxGeometry(0.15, 1.02, 0.16), 0x3f464c, compose(0, 0.51, 0));
  guardBaker.add(new THREE.BoxGeometry(0.07, 0.34, GR_PERIOD + 0.06), 0x9aa4ab, compose(0.02, 0.83, 0));
  guardBaker.add(new THREE.BoxGeometry(0.09, 0.09, GR_PERIOD + 0.02), 0x77818a, compose(0.05, 0.62, 0));
  const guardGeo = dispatcher.geo(guardBaker.build());
  const guardMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.55, metalness: 0.15 }));
  const guardMesh = new THREE.InstancedMesh(guardGeo, guardMat, GR_COUNT);
  guardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  guardMesh.frustumCulled = false;
  guardMesh.castShadow = level < 2;
  guardMesh.receiveShadow = true;
  guardMesh.name = 'guardrail';
  group.add(guardMesh);
  const guardPool = new RailPool(GR_PERIOD, GR_COUNT, 70);

  // 反光柱 cat's eye
  const eyeGeo = dispatcher.geo(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  const eyeMat = dispatcher.mat(new THREE.MeshBasicMaterial({ color: 0xfff0b8 }));
  const EYE_PERIOD = 8.4;
  const EYE_COUNT = Math.ceil((340 + 70) / EYE_PERIOD) + 1;
  const eyeMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, EYE_COUNT);
  eyeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  eyeMesh.frustumCulled = false;
  eyeMesh.name = 'reflectors';
  group.add(eyeMesh);
  const eyePool = new RailPool(EYE_PERIOD, EYE_COUNT, 70);

  // 路侧反光柱（陆地侧）
  const postBaker = new MeshBaker();
  postBaker.add(new THREE.BoxGeometry(0.1, 1.05, 0.1), 0xe8e6de, compose(0, 0.525, 0));
  postBaker.add(new THREE.BoxGeometry(0.1, 0.16, 0.11), 0xd24a3a, compose(0, 0.9, 0));
  const delinGeo = dispatcher.geo(postBaker.build());
  const delinMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.8 }));
  const DELIN_PERIOD = 24;
  const DELIN_COUNT = Math.ceil((300 + 70) / DELIN_PERIOD) + 1;
  const delinMesh = new THREE.InstancedMesh(delinGeo, delinMat, DELIN_COUNT);
  delinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  delinMesh.frustumCulled = false;
  delinMesh.name = 'delineators';
  group.add(delinMesh);
  const delinPool = new RailPool(DELIN_PERIOD, DELIN_COUNT, 70);

  // ------------------------------------------------------------ street lamps
  const lampBaker = new MeshBaker();
  lampBaker.add(new THREE.CylinderGeometry(0.09, 0.14, 7.4, 6), 0x2f3840, compose(0, 3.7, 0));
  lampBaker.add(new THREE.CylinderGeometry(0.24, 0.28, 0.6, 6), 0x333b42, compose(0, 0.3, 0));
  lampBaker.add(new THREE.BoxGeometry(2.7, 0.11, 0.11), 0x39434b, compose(-1.35, 7.04, 0));
  lampBaker.add(new THREE.BoxGeometry(0.6, 0.2, 0.36), 0x2c343b, compose(-2.62, 6.95, 0));
  const lampGeo = dispatcher.geo(lampBaker.build());
  const lampMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.6, metalness: 0.2 }));
  const LAMP_PERIOD = 44;
  const LAMP_COUNT = Math.ceil((330 + 70) / LAMP_PERIOD) + 1;
  const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, LAMP_COUNT);
  lampMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  lampMesh.frustumCulled = false;
  lampMesh.castShadow = level < 2;
  lampMesh.name = 'lamps';
  group.add(lampMesh);
  const lampPool = new RailPool(LAMP_PERIOD, LAMP_COUNT, 70);

  const headGeo = dispatcher.geo(new THREE.BoxGeometry(0.5, 0.06, 0.3));
  const headMat = dispatcher.mat(new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, LAMP_COUNT);
  headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  headMesh.frustumCulled = false;
  headMesh.name = 'lampheads';
  group.add(headMesh);

  const haloGeo = dispatcher.geo(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(LAMP_COUNT * 3);
    haloGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    haloGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 800);
  }
  const haloMat = dispatcher.mat(new THREE.ShaderMaterial({
    uniforms: {
      uPR: { value: pr },
      uSize: { value: 11 },
      uOpacity: { value: 0 },
      uFogNear: { value: 60 },
      uFogFar: { value: 460 },
      uColor: { value: new THREE.Color(0xffcf8a) },
    },
    vertexShader: HALO_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  }));
  const haloMesh = new THREE.Points(haloGeo, haloMat);
  haloMesh.frustumCulled = false;
  haloMesh.name = 'lamphalos';
  group.add(haloMesh);
  const haloPosAttr = haloGeo.attributes.position;
  const LAMP_X = 7.55;
  const HEAD_X = LAMP_X - 2.62;
  const HEAD_Y = 6.9;

  // 灯下真实点光（最多 3 个）
  const lampLights = [];
  for (let i = 0; i < 3; i++) {
    const pl = new THREE.PointLight(0xffb86b, 30, 26, 1.8);
    pl.position.set(HEAD_X, HEAD_Y, 0);
    pl.visible = false;
    scene.add(pl);
    lampLights.push(pl);
  }

  // ------------------------------------------------------------ signs
  const signPools = [];
  {
    const rng = makeRng(606);
    const postBaker2 = new MeshBaker();
    postBaker2.add(new THREE.BoxGeometry(0.1, 2.5, 0.1), 0x8d9196, compose(-0.95, 1.25, 0));
    postBaker2.add(new THREE.BoxGeometry(0.1, 2.5, 0.1), 0x8d9196, compose(0.95, 1.25, 0));
    const postGeo = dispatcher.geo(postBaker2.build());
    const postMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.75, metalness: 0.1 }));
    for (const key of ['route', 'warn']) {
      const def = SIGN_DEFS[key];
      const texW = def.canvas;
      const texH = key === 'route' ? Math.round(def.canvas * 0.5) : def.canvas;
      const tex = dispatcher.tex(canvasTexture(texW, texH, (ctx, w, h) => {
        if (key === 'route') drawRouteSign(ctx, w, h);
        else drawWarnSign(ctx, w, h);
      }, { srgb: true, aniso: 4 }));
      const mat = dispatcher.mat(new THREE.MeshStandardMaterial({
        map: tex,
        transparent: key === 'warn',
        alphaTest: key === 'warn' ? 0.4 : 0,
        roughness: 0.7,
        metalness: 0.05,
        side: THREE.DoubleSide,
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: 0.05,
      }));
      const panelGeo = dispatcher.geo(new THREE.PlaneGeometry(def.w, def.h));
      const count = 2;
      const group2 = [];
      for (let i = 0; i < count; i++) {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(postGeo, postMat));
        const panel = new THREE.Mesh(panelGeo, mat);
        panel.position.set(0, def.y, 0.02);
        g.add(panel);
        g.visible = false;
        group2.push(g);
        group.add(g);
      }
      signPools.push({ pool: new RailPool(290, count, 80), groups: group2, mat, offset: key === 'warn' ? 150 : 0, rng });
    }
  }

  // ------------------------------------------------------------ vegetation
  function makePalmGeometry(seed) {
    const rng = makeRng(seed);
    const baker = new MeshBaker();
    const h = 5.4;
    const lean = (rng() - 0.5) * 0.22;
    // 树干：两段，微弯
    baker.add(new THREE.CylinderGeometry(0.17, 0.27, h * 0.56, 5), 0x7c6142, compose(lean * h * 0.14, h * 0.28, 0, 0, 0, lean * 0.45));
    baker.add(new THREE.CylinderGeometry(0.12, 0.17, h * 0.48, 5), 0x866b4b, compose(lean * h * 0.36, h * 0.75, 0, 0, 0, lean * 0.95));
    const topX = lean * h * 0.46;
    const upAxis = new THREE.Vector3(0, 1, 0);
    // 冠：两圈放射状叶片
    for (let ring = 0; ring < 2; ring++) {
      const n = ring === 0 ? 8 : 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + ring * 0.42 + rng() * 0.18;
        const droop = ring === 0 ? 0.6 + rng() * 0.22 : 1.0 + rng() * 0.16;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 - droop, 0, 0));
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(upAxis, a));
        const p = new THREE.Vector3(topX, h + (ring === 0 ? 0.16 : 0.0), 0);
        const s = new THREE.Vector3(0.9, 3.0 + rng() * 0.9, 0.17);
        const m = new THREE.Matrix4().compose(p, q, s);
        baker.add(new THREE.ConeGeometry(1, 1, 3, 1), ring === 0 ? 0x3f6b38 : 0x4c7c40, m);
      }
    }
    // 椰子
    for (let i = 0; i < 3; i++) {
      const a = rng() * TAU;
      baker.add(new THREE.IcosahedronGeometry(0.17, 0), 0x7a6337, compose(topX + Math.cos(a) * 0.28, h - 0.05, Math.sin(a) * 0.28));
    }
    return dispatcher.geo(baker.build());
  }

  function makeCypressGeometry() {
    const baker = new MeshBaker();
    baker.add(new THREE.CylinderGeometry(0.12, 0.2, 2.2, 5), 0x5b4632, compose(0, 1.1, 0));
    baker.add(new THREE.ConeGeometry(1.15, 3.4, 6), 0x2f4a35, compose(0, 2.7, 0, 0, 0.4, 0));
    baker.add(new THREE.ConeGeometry(0.9, 2.8, 6), 0x35523a, compose(0, 4.3, 0, 0, 1.1, 0));
    baker.add(new THREE.ConeGeometry(0.58, 2.0, 6), 0x3b5b40, compose(0, 5.7, 0, 0, 2.0, 0));
    return dispatcher.geo(baker.build());
  }

  function makeBushGeometry(seed) {
    const rng = makeRng(seed);
    const baker = new MeshBaker();
    for (let i = 0; i < 3; i++) {
      const r = 0.5 + rng() * 0.5;
      baker.add(new THREE.IcosahedronGeometry(1, 0), i === 0 ? 0x4a6338 : 0x557040, compose(
        (rng() - 0.5) * 1.4, r * 0.55, (rng() - 0.5) * 1.4,
        rng(), rng() * TAU, rng(), r * 1.4, r * 0.85, r * 1.2
      ));
    }
    return dispatcher.geo(baker.build());
  }

  const propMatShared = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0 }));

  function makePropInstanced(geo, count, name) {
    const mesh = new THREE.InstancedMesh(geo, propMatShared, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = level < 2;
    mesh.receiveShadow = false;
    mesh.name = name;
    group.add(mesh);
    return mesh;
  }

  const PALM_COUNT = 8;
  const palmMesh = makePropInstanced(makePalmGeometry(111), PALM_COUNT, 'palms');
  const palmPool = new RailPool(58, PALM_COUNT, 60);
  const palmData = [];
  {
    const rng = makeRng(222);
    for (let i = 0; i < PALM_COUNT; i++) {
      palmData.push({ x: -10.5 - rng() * 12, s: 0.8 + rng() * 0.5, ry: rng() * TAU, tilt: (rng() - 0.5) * 0.14 });
      palmMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    if (palmMesh.instanceColor) palmMesh.instanceColor.needsUpdate = true;
  }

  const CYP_COUNT = 12;
  const cypMesh = makePropInstanced(makeCypressGeometry(), CYP_COUNT, 'cypress');
  const cypPool = new RailPool(36, CYP_COUNT, 60);
  const cypData = [];
  {
    const rng = makeRng(333);
    for (let i = 0; i < CYP_COUNT; i++) {
      cypData.push({ x: -13 - rng() * 26, s: 0.85 + rng() * 0.85, ry: rng() * TAU });
      cypMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    if (cypMesh.instanceColor) cypMesh.instanceColor.needsUpdate = true;
  }

  const BUSH_COUNT = 22;
  const bushMesh = makePropInstanced(makeBushGeometry(444), BUSH_COUNT, 'bushes');
  const bushPool = new RailPool(19, BUSH_COUNT, 60);
  const bushData = [];
  {
    const rng = makeRng(555);
    for (let i = 0; i < BUSH_COUNT; i++) {
      bushData.push({ x: -8.4 - rng() * 16, s: 0.55 + rng() * 0.85, ry: rng() * TAU });
      const g = 0.82 + rng() * 0.28;
      bushMesh.setColorAt(i, new THREE.Color(g * 0.9, g, g * 0.82));
    }
    if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ rocks / breakwater
  const rockGeoSmall = dispatcher.geo(new THREE.IcosahedronGeometry(1, 0));
  const rockGeoBig = dispatcher.geo((() => {
    const baker = new MeshBaker();
    baker.add(new THREE.IcosahedronGeometry(1, 1), 0x7d766b, compose(0, 0, 0, 0.3, 0.6, 0.2, 1.2, 0.75, 1.0));
    baker.add(new THREE.IcosahedronGeometry(0.7, 0), 0x6a6258, compose(0.8, 0.15, 0.4, 0.7, 0.3, 0.5));
    return baker.build();
  })());
  const rockMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: false, color: 0x8a8177, flatShading: false, roughness: 0.95, metalness: 0 }));

  const ROCK_COUNT = 30;
  const rockMesh = new THREE.InstancedMesh(rockGeoSmall, rockMat, ROCK_COUNT);
  rockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rockMesh.frustumCulled = false;
  rockMesh.castShadow = level < 2;
  rockMesh.name = 'rocks';
  group.add(rockMesh);
  const rockPool = new RailPool(13, ROCK_COUNT, 80);
  const rockData = [];
  {
    const rng = makeRng(666);
    for (let i = 0; i < ROCK_COUNT; i++) {
      rockData.push({
        dx: -7 + rng() * 13,
        s: 0.5 + rng() * 1.7,
        ry: rng() * TAU,
        rx: rng() * TAU,
        tone: 0.68 + rng() * 0.4,
      });
      rockMesh.setColorAt(i, new THREE.Color(0.7, 0.68, 0.64));
    }
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  }

  const BIGROCK_COUNT = 8;
  const bigRockMat = dispatcher.mat(new THREE.MeshStandardMaterial({ color: 0x6f675d, flatShading: false, roughness: 0.97, metalness: 0 }));
  const bigRockMesh = new THREE.InstancedMesh(rockGeoBig, bigRockMat, BIGROCK_COUNT);
  bigRockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bigRockMesh.frustumCulled = false;
  bigRockMesh.castShadow = level < 2;
  bigRockMesh.name = 'bigrocks';
  group.add(bigRockMesh);
  const bigRockPool = new RailPool(74, BIGROCK_COUNT, 80);
  const bigRockData = [];
  {
    const rng = makeRng(777);
    for (let i = 0; i < BIGROCK_COUNT; i++) {
      bigRockData.push({ dx: -6 + rng() * 12, s: 1.8 + rng() * 3.4, ry: rng() * TAU });
    }
  }

  const BOULDER_COUNT = 20;
  const boulderMesh = new THREE.InstancedMesh(rockGeoSmall, rockMat, BOULDER_COUNT);
  boulderMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boulderMesh.frustumCulled = false;
  boulderMesh.castShadow = level < 2;
  boulderMesh.name = 'boulders';
  group.add(boulderMesh);
  const boulderPool = new RailPool(21, BOULDER_COUNT, 70);
  const boulderData = [];
  {
    const rng = makeRng(888);
    for (let i = 0; i < BOULDER_COUNT; i++) {
      boulderData.push({ x: -10 - rng() * 40, s: 0.9 + rng() * 2.4, ry: rng() * TAU });
      boulderMesh.setColorAt(i, new THREE.Color(0.72, 0.7, 0.66));
    }
    if (boulderMesh.instanceColor) boulderMesh.instanceColor.needsUpdate = true;
  }

  // 路边草丛
  function makeGrassGeometry(seed) {
    const rng = makeRng(seed);
    const baker = new MeshBaker();
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU;
      const tilt = 0.25 + rng() * 0.45;
      baker.add(
        new THREE.ConeGeometry(0.06 + rng() * 0.05, 0.45 + rng() * 0.4, 3),
        i % 2 ? 0x6d7f4a : 0x7e8f58,
        compose(Math.cos(a) * 0.14, 0.22, Math.sin(a) * 0.14, tilt * Math.cos(a), rng() * TAU, tilt * Math.sin(a))
      );
    }
    return dispatcher.geo(baker.build());
  }
  const GRASS_COUNT = 44;
  const grassMesh = makePropInstanced(makeGrassGeometry(4242), GRASS_COUNT, 'grass');
  const grassPool = new RailPool(9, GRASS_COUNT, 60);
  const grassData = [];
  {
    const rng = makeRng(8888);
    for (let i = 0; i < GRASS_COUNT; i++) {
      grassData.push({ x: -6.9 - rng() * 5.0, s: 0.7 + rng() * 0.8, ry: rng() * TAU });
      const g = 0.8 + rng() * 0.3;
      grassMesh.setColorAt(i, new THREE.Color(g * 0.95, g, g * 0.75));
    }
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  }

  // 防波堤混凝土块
  const breakGeo = dispatcher.geo((() => {
    const baker = new MeshBaker();
    baker.add(new THREE.BoxGeometry(3.4, 1.7, 2.3), 0x8b8d88, compose(0, 0.85, 0));
    baker.add(new THREE.BoxGeometry(2.6, 1.2, 1.7), 0x7c7e7a, compose(0.2, 1.9, 0.1, 0.2, 0.5, 0.15));
    return baker.build();
  })());
  const breakMat = dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0 }));
  const BREAK_COUNT = 14;
  const breakMesh = new THREE.InstancedMesh(breakGeo, breakMat, BREAK_COUNT);
  breakMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  breakMesh.frustumCulled = false;
  breakMesh.name = 'breakwater';
  group.add(breakMesh);
  const breakPool = new RailPool(34, BREAK_COUNT, 80);

  // ------------------------------------------------------------ distant islands + lighthouse
  function makeIslandGeometry(seed, withLighthouse, scale) {
    const rng = makeRng(seed);
    const baker = new MeshBaker();
    baker.add(new THREE.IcosahedronGeometry(1, 1), 0x5a5f57, compose(0, -6, 0, 0, rng() * TAU, 0, 52 * scale, 19 * scale, 34 * scale));
    baker.add(new THREE.IcosahedronGeometry(1, 1), 0x4b5148, compose(-16 * scale, -1, 6 * scale, 0, 1.2, 0, 24 * scale, 13 * scale, 18 * scale));
    baker.add(new THREE.IcosahedronGeometry(1, 0), 0x3f4d3c, compose(8 * scale, 10 * scale, -4 * scale, 0, 0.4, 0, 22 * scale, 6 * scale, 14 * scale));
    baker.add(new THREE.ConeGeometry(1, 1, 5), 0x3a4938, compose(-4 * scale, 13 * scale, 4 * scale, 0.1, 0.4, 0.2, 10 * scale, 9 * scale, 8 * scale));
    if (withLighthouse) {
      const lx = 4 * scale;
      const ly = 12 * scale;
      const lz = -2 * scale;
      const towerH = 17 * scale;
      const towerR = 1.9 * scale;
      baker.add(new THREE.CylinderGeometry(towerR * 0.72, towerR, towerH, 8), 0xe6e2d6, compose(lx, ly + towerH * 0.5, lz));
      baker.add(new THREE.CylinderGeometry(towerR * 0.8, towerR * 0.8, towerH * 0.18, 8), 0xb84a3c, compose(lx, ly + towerH * 0.72, lz));
      baker.add(new THREE.CylinderGeometry(towerR * 0.92, towerR * 0.92, towerH * 0.1, 8), 0x2f3438, compose(lx, ly + towerH * 1.0, lz));
      baker.add(new THREE.ConeGeometry(towerR * 1.15, towerH * 0.22, 8), 0xb84a3c, compose(lx, ly + towerH * 1.14, lz));
    }
    return dispatcher.geo(baker.build());
  }

  const islandGroup = new THREE.Group();
  islandGroup.name = 'islands';
  group.add(islandGroup);
  const lightHouseIsland = new THREE.Mesh(
    makeIslandGeometry(1234, true, 1.0),
    dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0 }))
  );
  lightHouseIsland.name = 'lighthouse-island';
  islandGroup.add(lightHouseIsland);
  const farIsland = new THREE.Mesh(
    makeIslandGeometry(4321, false, 1.5),
    dispatcher.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0 }))
  );
  farIsland.name = 'far-island';
  islandGroup.add(farIsland);

  // 灯塔光束（两根，合并一次 draw；顶点固定在灯室，光束水平扫射）
  const beamGeo = dispatcher.geo((() => {
    const g1 = new THREE.ConeGeometry(6.5, 150, 8, 1, true);
    g1.rotateX(Math.PI / 2);
    g1.translate(0, 0, -75);
    const g2 = g1.clone();
    g2.rotateY(Math.PI);
    const baker = new MeshBaker();
    baker.add(g1, 0xffffff);
    baker.add(g2, 0xffffff);
    g1.dispose();
    g2.dispose();
    return baker.build();
  })());
  const beamMat = dispatcher.mat(new THREE.MeshBasicMaterial({
    vertexColors: true,
    color: 0xfff2c0,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  }));
  const beamMesh = new THREE.Mesh(beamGeo, beamMat);
  beamMesh.name = 'lighthouse-beam';
  beamMesh.frustumCulled = false;
  beamMesh.visible = false; // 长光锥在后处理下容易变成「白色光管」，关闭，改用脉冲光晕
  const beamPivot = new THREE.Object3D();
  beamPivot.add(beamMesh);
  islandGroup.add(beamPivot);

  const glowTex = dispatcher.tex(makeGlowTexture('#fff4cd', 'rgba(255,220,150,0.5)'));
  const islandGlowMat = dispatcher.mat(new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xffe6b0,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.0,
    toneMapped: true,
  }));
  const islandGlow = new THREE.Sprite(islandGlowMat);
  islandGlow.scale.set(16, 16, 1);
  islandGroup.add(islandGlow);

  // 灯塔脉冲光（billboard，随扫光节奏呼吸）
  const beaconMat = dispatcher.mat(new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xfff6d8,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
    toneMapped: true,
  }));
  const islandBeacon = new THREE.Sprite(beaconMat);
  islandBeacon.scale.setScalar(5);
  islandGroup.add(islandBeacon);

  const ISLAND = {
    a: { x: 128, zOff: -262, scale: 1.0, lighthouse: true },
    b: { x: 260, zOff: -430, scale: 1.5, lighthouse: false },
  };

  // ------------------------------------------------------------ sea spray / fireflies
  const SPRAY_COUNT = 130;
  const sprayGeo = dispatcher.geo(new THREE.BufferGeometry());
  {
    const g = sprayGeo;
    const pos = new Float32Array(SPRAY_COUNT * 3);
    const size = new Float32Array(SPRAY_COUNT);
    const alpha = new Float32Array(SPRAY_COUNT);
    const rng = makeRng(1357);
    g.userData = { data: [] };
    for (let i = 0; i < SPRAY_COUNT; i++) {
      g.userData.data.push({
        zoff: -80 + rng() * 130,
        side: rng(),
        rise: rng() * 2.2,
        speed: 0.5 + rng() * 1.8,
        phase: rng() * TAU,
        size: 0.22 + rng() * 0.7,
        life: 0.4 + rng() * 1.4,
      });
      size[i] = 0.2 + rng() * 0.7;
      alpha[i] = 0;
      pos[i * 3 + 2] = 0;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
  }
  const sprayMat = dispatcher.mat(new THREE.ShaderMaterial({
    uniforms: {
      uPxPerUnit: { value: 700 },
      uColor: { value: new THREE.Color(0xffffff) },
    },
    vertexShader: SPRAY_VERT,
    fragmentShader: SPRAY_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  }));
  const sprayMesh = new THREE.Points(sprayGeo, sprayMat);
  sprayMesh.frustumCulled = false;
  sprayMesh.name = 'spray';
  group.add(sprayMesh);
  const sprayPos = sprayGeo.attributes.position;
  const sprayAlpha = sprayGeo.attributes.aAlpha;
  const sprayData = sprayGeo.userData.data;

  const FLY_COUNT = 64;
  const flyGeo = dispatcher.geo(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(FLY_COUNT * 3);
    const size = new Float32Array(FLY_COUNT);
    const phase = new Float32Array(FLY_COUNT);
    const rng = makeRng(2468);
    flyGeo.userData = { data: [] };
    for (let i = 0; i < FLY_COUNT; i++) {
      flyGeo.userData.data.push({
        x: -9 - rng() * 26,
        zoff: -70 + rng() * 120,
        y: 0.7 + rng() * 3.8,
        phase: rng() * TAU,
        drift: 0.4 + rng() * 1.4,
      });
      size[i] = 0.35 + rng() * 0.8;
      phase[i] = rng();
    }
    flyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    flyGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    flyGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    flyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
  }
  const flyMat = dispatcher.mat(new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPR: { value: pr },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0xffe89a) },
    },
    vertexShader: FLY_VERT,
    fragmentShader: FLY_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  }));
  const flyMesh = new THREE.Points(flyGeo, flyMat);
  flyMesh.frustumCulled = false;
  flyMesh.name = 'fireflies';
  group.add(flyMesh);
  const flyPos = flyGeo.attributes.position;
  const flyData = flyGeo.userData.data;

  // ------------------------------------------------------------ lights
  const hemi = new THREE.HemisphereLight(0xffcf9e, 0x463850, 1.0);
  hemi.name = 'world-hemi';
  scene.add(hemi);

  const sunLight = new THREE.DirectionalLight(0xffb169, 2.3);
  sunLight.name = 'world-sun';
  sunLight.position.set(80, 40, -30);
  sunLight.target.position.set(0, 0, 0);
  sunLight.castShadow = level < 2;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const moonLight = new THREE.DirectionalLight(0xa8c0e8, 0.05);
  moonLight.name = 'world-moon';
  moonLight.position.set(-60, 50, -40);
  moonLight.target.position.set(0, 0, 0);
  scene.add(moonLight);
  scene.add(moonLight.target);

  // scene fog（天空 shader 自己处理）
  if (!scene.fog) scene.fog = new THREE.Fog(0xe79a63, 55, 520);
  const fog = scene.fog;

  // ------------------------------------------------------------ fallback day/night
  const _sunDir = new THREE.Vector3(0.93, 0.1, -0.34);
  const _moonDir = new THREE.Vector3(-0.62, 0.5, -0.6);
  const _camPos = new THREE.Vector3(0, 3.4, 9);
  const _moonRight = new THREE.Vector3();
  const _moonUp = new THREE.Vector3();
  const _tmpV = new THREE.Vector3();
  const _fwd = new THREE.Vector3(0, 0, -1);

  const SUN_EL = [
    { t: 0.0, v: 5.5 }, { t: 0.06, v: 1.4 }, { t: 0.13, v: -6.5 }, { t: 0.3, v: -26 },
    { t: 0.7, v: -30 }, { t: 0.85, v: -16 }, { t: 0.94, v: -2 }, { t: 1.0, v: 5.5 },
  ];
  const MOON_EL = [
    { t: 0.0, v: -22 }, { t: 0.14, v: -2 }, { t: 0.3, v: 14 }, { t: 0.5, v: 46 },
    { t: 0.66, v: 30 }, { t: 0.8, v: 8 }, { t: 0.9, v: -10 }, { t: 1.0, v: -22 },
  ];
  function sampleKeys(p, keys) {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (p >= a.t && p <= b.t) {
        const u = (p - a.t) / (b.t - a.t || 1);
        const s = u * u * (3 - 2 * u);
        return lerp(a.v, b.v, s);
      }
    }
    return keys[0].v;
  }

  // ------------------------------------------------------------ per-frame temp
  const lampNearest = [];
  const _lightTarget = new THREE.Vector3();
  const _discTint = new THREE.Color(0xfff7dd);
  const _specTint = new THREE.Color(0xfff0c0);
  const _eyeTint = new THREE.Color(0xfff6d0);
  const _goldTint = new THREE.Color(0xffa24a);

  function applyPalette(phase, night, sunDir, moonDir) {
    const { stops, out } = pal;
    let i = 0;
    for (; i < stops.length - 1; i++) {
      if (phase >= stops[i].t && phase <= stops[i + 1].t) break;
    }
    if (i >= stops.length - 1) i = stops.length - 2;
    const a = stops[i];
    const b = stops[i + 1];
    const u = clamp01((phase - a.t) / (b.t - a.t || 1));
    const s = u * u * (3 - 2 * u);
    for (let k = 0; k < COLOR_KEYS.length; k++) {
      out[COLOR_KEYS[k]].copy(a[COLOR_KEYS[k]]).lerp(b[COLOR_KEYS[k]], s);
    }
    for (let k = 0; k < NUM_KEYS.length; k++) {
      const key = NUM_KEYS[k];
      out[key] = lerp(a[key], b[key], s);
    }
    return out;
  }

  function updateSkyAndOcean(palette, sunDir, moonDir, night, dt) {
    const u = skyUniforms;
    u.uZenith.value.copy(palette.zenith);
    u.uHorizon.value.copy(palette.horizon);
    u.uHorizonCool.value.copy(palette.zenith).lerp(palette.skyMid, 0.55).multiplyScalar(0.9);
    u.uWarmHorizon.value.copy(palette.sunGlow).lerp(_goldTint, 0.5);
    u.uSkyMid.value.copy(palette.skyMid);
    u.uGround.value.copy(palette.ground);
    u.uHaze.value.copy(palette.haze);
    u.uSunDir.value.copy(sunDir);
    u.uMoonDir.value.copy(moonDir);
    u.uSunGlowColor.value.copy(palette.sunGlow);
    u.uMoonGlowColor.value.copy(palette.moonGlow);
    u.uSunDiscColor.value.copy(palette.sunGlow).lerp(_discTint, 0.5);
    u.uSunGlowAmt.value = palette.sunGlowAmt;
    u.uMoonGlowAmt.value = palette.moonGlowAmt;
    u.uSunDiscInt.value = palette.sunDiscInt;
    u.uMoonDiscInt.value = palette.moonDiscInt * 0.35;
    u.uMilkyColor.value.copy(palette.moonGlow).lerp(_discTint, 0.25);
    u.uMilkyAmt.value = palette.milkyAmt * 0.85;
    u.uTime.value = elapsed;

    // moon basis (for the textured moon disc)
    _moonRight.set(0, 1, 0).cross(moonDir);
    if (_moonRight.lengthSq() < 1e-4) _moonRight.set(1, 0, 0);
    _moonRight.normalize();
    _moonUp.copy(moonDir).cross(_moonRight).normalize();
    u.uMoonRight.value.copy(_moonRight);
    u.uMoonUp.value.copy(_moonUp);
    u.uMoonTanR.value = 0.033;

    const o = oceanUniforms;
    o.uTime.value = elapsed;
    o.uZenith.value.copy(palette.zenith);
    o.uHorizon.value.copy(palette.horizon);
    o.uFogColor.value.copy(palette.fog).lerp(palette.horizon, 0.35);
    o.uFogRange.value.set(palette.fogNear, palette.fogFar);
    o.uDeepColor.value.copy(palette.waterDeep).multiplyScalar(0.9);
    o.uShallowColor.value.copy(palette.waterShallow).lerp(palette.waterDeep, 0.52).multiplyScalar(0.95);
    o.uFoamColor.value.copy(palette.foam);
    o.uSunDir.value.copy(sunDir);
    o.uMoonDir.value.copy(moonDir);
    o.uSunGlowColor.value.copy(palette.sunGlow);
    o.uMoonGlowColor.value.copy(palette.moonGlow);
    o.uSunGlowAmt.value = palette.sunGlowAmt;
    o.uMoonGlowAmt.value = palette.moonGlowAmt;
    o.uSunSpecColor.value.copy(palette.sunGlow).lerp(_specTint, 0.4);
    o.uMoonSpecColor.value.copy(palette.moonGlow);
    o.uSunSpecInt.value = palette.sunSpecInt;
    o.uMoonSpecInt.value = palette.moonSpecInt * 0.2;
    o.uSunUp.value = smoothstep(-0.02, 0.12, sunDir.y);
    o.uMoonUp.value = smoothstep(-0.02, 0.14, moonDir.y);
    o.uNight.value = night;
    o.uDetail.value = palette.oceanDetail * (level === 2 ? 0.55 : 1);
    o.uWaveAmp.value = level === 2 ? 0.75 : 1;

    const stars = starMat.uniforms;
    stars.uTime.value = elapsed;
    stars.uStarAmt.value = palette.starAmt;
    const milky = milkyMat.uniforms;
    milky.uTime.value = elapsed;
    milky.uStarAmt.value = palette.milkyAmt;

    // clouds
    cloudMat.color.copy(palette.cloud).lerp(palette.zenith, night * 0.6).lerp(palette.horizon, 0.18);
    cloudMat.emissive.copy(palette.cloud);
    cloudMat.emissiveIntensity = 0.16 + palette.cloudEmit * 1.2 + night * 0.05;
    cloudMat.opacity = 0.92 - night * 0.84;

    // lights
    hemi.color.copy(palette.hemiSky);
    hemi.groundColor.copy(palette.hemiGround);
    hemi.intensity = palette.hemiInt;
    sunLight.color.copy(palette.sunLight);
    sunLight.intensity = palette.sunInt;
    moonLight.color.copy(palette.moonLight);
    moonLight.intensity = palette.moonInt;
    sunLight.visible = palette.sunInt > 0.015 && level < 2;
    moonLight.visible = palette.moonInt > 0.015;
    sunLight.castShadow = level < 2 && sunLight.visible;

    // fog
    fog.color.copy(palette.fog);
    fog.near = palette.fogNear;
    fog.far = palette.fogFar;

    // lamp / emissive强度
    headMat.color.copy(palette.lamp).multiplyScalar(0.3 + night * 1.9);
    eyeMat.color.copy(palette.lamp).lerp(_eyeTint, 0.5).multiplyScalar(0.16 + night * 1.35 + palette.sunGlowAmt * 0.1);
    haloMat.uniforms.uOpacity.value = palette.lampAmt * (0.08 + night * 0.7);
    haloMat.uniforms.uColor.value.copy(palette.lamp);
    haloMat.uniforms.uFogNear.value = palette.fogNear;
    haloMat.uniforms.uFogFar.value = palette.fogFar;
    for (let i = 0; i < lampLights.length; i++) {
      const pl = lampLights[i];
      pl.color.copy(palette.lamp);
      pl.intensity = (level < 2 ? 26 : 0) * (0.25 + night * 1.6) * palette.lampAmt;
      pl.visible = level < 2 && pl.intensity > 0.2;
    }

    // signs 夜里微亮
    for (let i = 0; i < signPools.length; i++) signPools[i].mat.emissiveIntensity = 0.04 + night * 0.16;

    // island / beam
    islandGlowMat.opacity = clamp01(palette.lampAmt * night * 0.9);
    beamMat.opacity = clamp01(night * 0.07 * (level < 2 ? 1 : 0.4));
  }

  function updateCameraFollow(state) {
    const cam = state && state.camera;
    if (cam && cam.position && Number.isFinite(cam.position.x)) {
      _camPos.copy(cam.position);
    } else {
      const bikeX = state && Number.isFinite(state.laneX) ? state.laneX : 0;
      const bikeZ = state && Number.isFinite(state.bikeZ) ? state.bikeZ : 0;
      _camPos.set(bikeX, 3.4, bikeZ + 6);
    }
    group.position.set(0, 0, 0);
    skyMesh.position.copy(_camPos);
    starMesh.position.copy(_camPos);
    milkyMesh.position.copy(_camPos);
    oceanMesh.position.set(_camPos.x, OCEAN_Y, _camPos.z);
    // spray / fireflies 的世界坐标已在 updateParticles 里算好，保持原点
    sprayMesh.position.set(0, 0, 0);
    flyMesh.position.set(0, 0, 0);
  }

  function updateGuardrail(bikeZ) {
    guardPool.update(bikeZ);
    eyePool.update(bikeZ);
    delinPool.update(bikeZ);
    for (let i = 0; i < guardPool.count; i++) {
      setInstance(guardMesh, i, GUARD_X, 0, guardPool.z[i]);
    }
    guardMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < eyePool.count; i++) {
      setInstance(eyeMesh, i, GUARD_X - 0.02, 0.86, eyePool.z[i]);
    }
    eyeMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < delinPool.count; i++) {
      setInstance(delinMesh, i, -6.52, -0.02, delinPool.z[i]);
    }
    delinMesh.instanceMatrix.needsUpdate = true;
  }

  function updateLamps(bikeZ, palette) {
    lampPool.update(bikeZ);
    lampNearest.length = 0;
    for (let i = 0; i < lampPool.count; i++) {
      const z = lampPool.z[i];
      setInstance(lampMesh, i, LAMP_X, 0, z);
      setInstance(headMesh, i, LAMP_X - 2.62, HEAD_Y, z);
      haloPosAttr.setXYZ(i, LAMP_X - 2.62, HEAD_Y, z);
      const rel = bikeZ - z; // >0 ahead
      if (rel > -12 && rel < 150) lampNearest.push({ i, z, rel });
    }
    lampMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    haloPosAttr.needsUpdate = true;
    lampNearest.sort((a, b) => a.rel - b.rel);
    for (let i = 0; i < lampLights.length; i++) {
      const pl = lampLights[i];
      const near = lampNearest[i];
      if (near) {
        pl.visible = level < 2 && pl.intensity > 0.2 && near.rel < 110;
        pl.position.set(LAMP_X - 2.62, HEAD_Y - 0.4, near.z);
      } else {
        pl.visible = false;
      }
    }
  }

  function updateSigns(bikeZ) {
    for (let s = 0; s < signPools.length; s++) {
      const sp = signPools[s];
      sp.pool.update(bikeZ);
      for (let i = 0; i < sp.pool.count; i++) {
        const z = sp.pool.z[i];
        const g = sp.groups[i];
        g.visible = true;
        g.position.set(-8.35, cliffY(-8.35, z) - 0.02, z);
        g.rotation.y = 0;
      }
    }
  }

  function updateVegetation(bikeZ) {
    palmPool.update(bikeZ);
    for (let i = 0; i < palmPool.count; i++) {
      const z = palmPool.z[i];
      const d = palmData[i];
      const gy = cliffY(d.x, z);
      setInstance(palmMesh, i, d.x, gy, z, d.ry, d.s, d.s, d.s, 0, d.tilt);
    }
    palmMesh.instanceMatrix.needsUpdate = true;

    cypPool.update(bikeZ);
    for (let i = 0; i < cypPool.count; i++) {
      const z = cypPool.z[i];
      const d = cypData[i];
      const gy = cliffY(d.x, z);
      setInstance(cypMesh, i, d.x, gy, z, d.ry, d.s, d.s, d.s);
    }
    cypMesh.instanceMatrix.needsUpdate = true;

    bushPool.update(bikeZ);
    for (let i = 0; i < bushPool.count; i++) {
      const z = bushPool.z[i];
      const d = bushData[i];
      const gy = cliffY(d.x, z);
      setInstance(bushMesh, i, d.x, gy, z, d.ry, d.s, d.s * 0.8, d.s);
    }
    bushMesh.instanceMatrix.needsUpdate = true;

    rockPool.update(bikeZ);
    for (let i = 0; i < rockPool.count; i++) {
      const z = rockPool.z[i];
      const d = rockData[i];
      const x = shoreX(z) + d.dx;
      const y = beachY(x, z) + d.s * 0.34;
      setInstance(rockMesh, i, x, y, z, d.ry, d.s, d.s * 0.7, d.s * 1.15, d.rx);
    }
    rockMesh.instanceMatrix.needsUpdate = true;

    bigRockPool.update(bikeZ);
    for (let i = 0; i < bigRockPool.count; i++) {
      const z = bigRockPool.z[i];
      const d = bigRockData[i];
      const x = shoreX(z) + d.dx;
      const y = beachY(x, z) + d.s * 0.08;
      setInstance(bigRockMesh, i, x, y, z, d.ry, d.s, d.s * 0.8, d.s * 0.9);
    }
    bigRockMesh.instanceMatrix.needsUpdate = true;

    grassPool.update(bikeZ);
    for (let i = 0; i < grassPool.count; i++) {
      const z = grassPool.z[i];
      const d = grassData[i];
      const gy = cliffY(d.x, z);
      setInstance(grassMesh, i, d.x, gy, z, d.ry, d.s, d.s, d.s);
    }
    grassMesh.instanceMatrix.needsUpdate = true;

    boulderPool.update(bikeZ);
    for (let i = 0; i < boulderPool.count; i++) {
      const z = boulderPool.z[i];
      const d = boulderData[i];
      const gy = cliffY(d.x, z);
      setInstance(boulderMesh, i, d.x, gy + d.s * 0.22, z, d.ry, d.s, d.s * 0.75, d.s * 1.1);
    }
    boulderMesh.instanceMatrix.needsUpdate = true;

    breakPool.update(bikeZ);
    for (let i = 0; i < breakPool.count; i++) {
      const z = breakPool.z[i];
      const x = shoreX(z) + 1.5;
      const y = beachY(x, z) + 0.8;
      setInstance(breakMesh, i, x, y, z, (i * 0.7) % TAU, 1, 1, 1);
    }
    breakMesh.instanceMatrix.needsUpdate = true;
  }

  function updateIslands(bikeZ, palette, night) {
    const a = ISLAND.a;
    lightHouseIsland.position.set(a.x, -4, bikeZ + a.zOff);
    lightHouseIsland.rotation.y = 0.4;
    const b = ISLAND.b;
    farIsland.position.set(b.x, -6, bikeZ + b.zOff);
    farIsland.rotation.y = -0.7;

    // 灯塔光束旋转（灯室高度 ≈ 岛基座 -4 + 12 + 17）
    beamPivot.position.set(a.x + 4 * a.scale, 25.5, bikeZ + a.zOff - 2 * a.scale);
    beamPivot.rotation.y = elapsed * 0.55;
    islandGlow.position.set(a.x + 4 * a.scale, 25.5, bikeZ + a.zOff - 2 * a.scale);
    islandGlow.scale.setScalar(14 + 4 * Math.sin(elapsed * 2.1));
    const beaconPulse = Math.pow(0.5 + 0.5 * Math.sin(elapsed * 0.9), 8);
    islandBeacon.position.set(a.x + 4 * a.scale, 25.6, bikeZ + a.zOff - 2 * a.scale);
    islandBeacon.scale.setScalar(3.5 + beaconPulse * 6.5);
    beaconMat.opacity = clamp01(night * (0.12 + 0.6 * beaconPulse) * (0.35 + palette.lampAmt * 0.65));
    islandGroup.visible = level < 2;
  }

  function updateParticles(dt, bikeZ, palette, night, camera) {
    // sea spray：贴着岸线拍岸飞沫
    sprayPos.needsUpdate = true;
    sprayAlpha.needsUpdate = true;
    const sprayOn = level < 2 && night < 0.35;
    sprayMesh.visible = sprayOn;
    flyMesh.visible = level < 2;
    if (!sprayOn) return;
    const pxPerUnit = (typeof window !== 'undefined' ? window.innerHeight * pr : 720) / (2 * Math.tan((camera && camera.fov ? camera.fov : 62) * 0.5 * D2R));
    sprayMat.uniforms.uPxPerUnit.value = pxPerUnit;
    sprayMat.uniforms.uColor.value.copy(palette.foam).lerp(palette.sunGlow, 0.25).lerp(palette.moonGlow, night * 0.6).multiplyScalar(1 - night * 0.45);
    const cx = camera && camera.position ? camera.position.x : 0;
    for (let i = 0; i < SPRAY_COUNT; i++) {
      const d = sprayData[i];
      d.phase += dt * d.speed * 1.7;
      const worldZ = bikeZ + d.zoff;
      const sx = shoreX(worldZ);
      const px = sx + 1.0 + d.side * 4.5 + Math.sin(d.phase * 0.4) * 0.4;
      const surf = -9 + Math.sin(worldZ * 0.9 - elapsed * 1.9) * 0.4;
      const cycle = (d.phase % (Math.PI * 2)) / (Math.PI * 2);
      const py = surf + d.rise * Math.sin(cycle * Math.PI) * (0.6 + 0.4 * Math.sin(i * 2.7));
      const pz = worldZ + Math.cos(d.phase * 0.31) * 1.2;
      sprayPos.setXYZ(i, px, py, pz);
      sprayAlpha.setX(i, Math.sin(cycle * Math.PI) * 0.55 * (1 - night * 0.82) * (0.4 + 0.6 * Math.min(1, Math.abs(cx - px) / 40 + 0.2)));
    }
    flyMat.uniforms.uTime.value = elapsed;
    flyMat.uniforms.uOpacity.value = night * 0.5 * (level < 2 ? 1 : 0);
    for (let i = 0; i < FLY_COUNT; i++) {
      const d = flyData[i];
      const fz = bikeZ + d.zoff;
      const fx = d.x + Math.sin(elapsed * d.drift + d.phase) * 1.8;
      const fy = cliffY(d.x, fz) + d.y + Math.sin(elapsed * 0.9 + d.phase * 2) * 0.5;
      flyPos.setXYZ(i, fx, Math.max(0.6, fy), fz);
    }
    flyPos.needsUpdate = true;
  }

  // ------------------------------------------------------------ main update
  let lastPalette = null;
  let lastNight = 0;

  function update(dt, state) {
    if (!ready) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0.016, 0, 0.1);
    elapsed += dt;
    const s = state || {};
    const phase = wrap01(Number.isFinite(s.dayPhase) ? s.dayPhase : 0.02);
    const fallbackNight = smoothstep(0.075, 0.32, phase) * (1 - smoothstep(0.82, 0.985, phase));
    const night = clamp01(Number.isFinite(s.night) ? s.night : fallbackNight);
    const bikeZ = Number.isFinite(s.bikeZ) ? s.bikeZ : 0;

    // 太阳/月亮方向（main 提供，缺省时按相位回退）
    const sd = s.sunDir;
    if (sd && Number.isFinite(sd.x) && Number.isFinite(sd.y) && sd.lengthSq() > 0.5) {
      _sunDir.copy(sd).normalize();
    } else {
      const el = sampleKeys(phase, SUN_EL) * D2R;
      _sunDir.set(Math.cos(el) * 0.94, Math.sin(el), -Math.cos(el) * 0.34).normalize();
    }
    const md = s.moonDir;
    if (md && Number.isFinite(md.x) && Number.isFinite(md.y) && md.lengthSq() > 0.5) {
      _moonDir.copy(md).normalize();
    } else {
      const el = sampleKeys(phase, MOON_EL) * D2R;
      _moonDir.set(Math.cos(el) * 0.8, Math.sin(el), -Math.cos(el) * 0.6).normalize();
    }

    const palette = applyPalette(phase, night, _sunDir, _moonDir);
    lastPalette = palette;
    lastNight = night;

    updateCameraFollow(s);
    updateSkyAndOcean(palette, _sunDir, _moonDir, night, dt);
    updateGuardrail(bikeZ);
    updateLamps(bikeZ, palette);
    updateSigns(bikeZ);
    updateVegetation(bikeZ);
    updateIslands(bikeZ, palette, night);
    updateParticles(dt, bikeZ, palette, night, s.camera);
    updateClouds(bikeZ);
    updateShadows(bikeZ, s);
  }

  function updateClouds(bikeZ) {
    cloudPool.update(bikeZ);
    const sway = Math.sin(elapsed * 0.03) * 6;
    for (let i = 0; i < cloudPool.count; i++) {
      const d = cloudData[i];
      const bob = Math.sin(elapsed * 0.05 + d.phase) * 1.6;
      setInstance(cloudMesh, i, d.x + sway, d.y + bob, cloudPool.z[i], d.ry, d.s, d.s * d.sy, d.s);
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
    cloudMesh.count = level === 2 ? 5 : CLOUD_COUNT;
  }

  function updateShadows(bikeZ, state) {
    const bikeX = Number.isFinite(state.laneX) ? state.laneX : 0;
    _lightTarget.set(bikeX, 0.6, bikeZ - 6);
    sunLight.target.position.copy(_lightTarget);
    sunLight.target.updateMatrixWorld();
    sunLight.position.copy(_lightTarget).addScaledVector(_sunDir, 95);
    moonLight.target.position.copy(_lightTarget);
    moonLight.target.updateMatrixWorld();
    moonLight.position.copy(_lightTarget).addScaledVector(_moonDir, 80);
  }

  // ------------------------------------------------------------ quality
  const _qTried = new Set();
  function setQuality(levelIn) {
    try {
      const l = clamp(levelIn | 0, 0, 2);
      if (l === level) {
        applyQualityFlags();
        return;
      }
      level = l;
      rebuildOcean(OCEAN_SEGS[level]);
      applyQualityFlags();
    } catch (e) {
      if (!_qTried.has('err')) {
        _qTried.add('err');
        console.warn('[world] setQuality failed', e);
      }
    }
  }

  function applyQualityFlags() {
    const high = level === 0;
    const mid = level === 1;
    guardMesh.castShadow = level < 2;
    lampMesh.castShadow = level < 2;
    palmMesh.castShadow = level < 2;
    cypMesh.castShadow = level < 2;
    rockMesh.castShadow = level < 2;
    bigRockMesh.castShadow = level < 2;
    boulderMesh.castShadow = level < 2;
    islandGroup.visible = level < 2;
    sprayMesh.visible = level < 2;
    flyMesh.visible = level < 2;
    starMesh.geometry.setDrawRange(0, level === 0 ? starData.count : level === 1 ? Math.min(1200, starData.count) : Math.min(500, starData.count));
    milkyMesh.geometry.setDrawRange(0, level === 0 ? milkyData.count : level === 1 ? Math.min(420, milkyData.count) : 0);
    milkyMesh.visible = level < 2;
    cloudMesh.count = level === 2 ? 5 : CLOUD_COUNT;
    haloTexScale(level);
    if (oceanUniforms) {
      oceanUniforms.uDetail.value = (level === 2 ? 0.55 : 1) * (lastPalette ? lastPalette.oceanDetail : 1);
      oceanUniforms.uWaveAmp.value = level === 2 ? 0.75 : 1;
    }
    void high; void mid;
  }

  function haloTexScale(l) {
    haloMat.uniforms.uSize.value = l === 0 ? 16 : l === 1 ? 13 : 11;
    sprayMat.uniforms.uPxPerUnit.value = 700;
  }

  // ------------------------------------------------------------ init
  rebuildOcean(OCEAN_SEGS[level]);
  applyQualityFlags();
  ready = true;
  // 首帧把状态摆好，避免第一帧道具乱飞
  update(0.016, { bikeZ: 0, dayPhase: 0.02, night: 0, camera: null });

  function dispose() {
    try {
      scene.remove(group);
      scene.remove(hemi);
      scene.remove(sunLight);
      scene.remove(sunLight.target);
      scene.remove(moonLight);
      scene.remove(moonLight.target);
      for (let i = 0; i < lampLights.length; i++) scene.remove(lampLights[i]);
      if (scene.fog === fog) scene.fog = null;
      skyMat.dispose();
      oceanMat.dispose();
      starMat.dispose();
      milkyMat.dispose();
      cloudMat.dispose();
      terrainMat.dispose();
      roadMat.dispose();
      guardMat.dispose();
      eyeMat.dispose();
      delinMat.dispose();
      lampMat.dispose();
      headMat.dispose();
      haloMat.dispose();
      sprayMat.dispose();
      flyMat.dispose();
      beamMat.dispose();
      islandGlowMat.dispose();
      propMatShared.dispose();
      rockMat.dispose();
      bigRockMat.dispose();
      breakMat.dispose();
      dispatcher.dispose();
    } catch (e) {
      console.warn('[world] dispose error', e);
    }
  }

  const handle = {
    group,
    sunLight,
    moonLight,
    hemi,
    ocean: oceanMesh,
    sky: skyMesh,
    update,
    setQuality,
    dispose,
    get quality() { return level; },
    get stats() {
      let draws = 0;
      let tris = 0;
      group.traverse((o) => {
        if (o.isMesh || o.isPoints) {
          draws++;
          const g = o.geometry;
          if (g && g.index) tris += g.index.count / 3;
          else if (g && g.attributes.position) tris += g.attributes.position.count / 3;
        }
      });
      return { draws, tris: Math.round(tris), level, night: lastNight };
    },
  };
  return handle;
}
