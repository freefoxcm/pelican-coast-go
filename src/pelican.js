// ============================================================================
// 鹈鹕海岸 · 追鱼 — pelican.js   (owner: pelican-rig)   ART PASS 2
//
// 程序化「戴青绿头盔 + 运动墨镜 + 红围巾的鹈鹕」+ 复古自行车 + Verlet 布料围巾。
// 设计：主体平滑着色（Lathe / 扫掠曲面），少量硬边配件（车架 / 头盔外壳）；
//       羽片、喙、蹼足用参数化扫掠几何；围巾尾部为真实 Verlet 布料。
//
// 坐标约定（见 src/CONTRACT.md §1）：
//   · 车头 / 喙尖朝 -Z；前进方向 = -Z
//   · 路面 y = 0，轮胎接触面贴 y = 0
//   · group 根节点的 position / rotation.y 由 main.js 每帧设置 —— 本模块绝不移动 group
//
// 性能：≤ 35k 三角形 / ≤ 80 mesh / ≤ 12 材质；update() 内零对象分配。
// ============================================================================
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, TAU, smoothstep, makeRng } from './util.js';

// ---------------------------------------------------------------- 比例常量
const BIKE_SCALE = 1.06; // 自行车整体缩放
const WHEEL_R = 0.348;
const AXLE_Y = WHEEL_R;
const REAR_Z = 0.585;
const FRONT_Z = -0.615;
const BB_Y = 0.30;
const BB_Z = 0.075;
const CRANK_R = 0.105;
const HIP_X = 0.135;
const HIP_Y = 0.885;
const HIP_Z = 0.165;
const THIGH_L = 0.34;
const SHIN_L = 0.355;
const HEAD_PIVOT_Y = 1.50; // 脖子根 / 头节点 pivot（torsoInner 空间）
const BASKET_Y = 0.86;
const BASKET_Z = -0.72;

// 围巾布料参数（加宽加长版：0.34m × 1.36m）
const SCARF = {
  width: 0.34,
  length: 1.36,
  anchorY: 1.485,
  anchorZ: 0.155,
  gravity: 9.8,
  damp: 0.984,
  windBase: 2.4,
  windSpeed: 20.0,
  liftBase: 0.9,
  liftSpeed: 6.0,
  turbBase: 3.2,
  turbSpeed: 10.0,
  iterations: 4,
  collideMargin: 0.015,
};

// ---------------------------------------------------------------- 模块级临时变量
const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

// ============================================================================
// 构建期辅助（只在 createPelican 构建时使用，允许分配）
// ============================================================================
function boxGeo(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function sphGeo(r, ws = 12, hs = 9) { return new THREE.SphereGeometry(r, ws, hs); }
function cylGeo(rt, rb, h, seg = 8) { return new THREE.CylinderGeometry(rt, rb, h, seg, 1, false); }
function coneGeo(r, h, seg = 6) { return new THREE.ConeGeometry(r, h, seg); }
function torusGeo(r, t, rs = 6, ts = 16) { return new THREE.TorusGeometry(r, t, rs, ts); }

function put(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// 几何体：缩放 → 旋转 → 平移
function gTRS(geo, sx, sy, sz, rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0) {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (rx || ry || rz) geo.applyMatrix4(_m1.makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  if (x || y || z) geo.translate(x, y, z);
  return geo;
}

// 两点间圆柱
function geoBetween(ax, ay, az, bx, by, bz, rA, rB, seg = 6) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const geo = new THREE.CylinderGeometry(rB, rA, len, seg, 1, false);
  geo.translate(0, len / 2, 0);
  _v1.set(dx, dy, dz).normalize();
  _q1.setFromUnitVectors(UP, _v1);
  geo.applyMatrix4(_m1.makeRotationFromQuaternion(_q1));
  geo.translate(ax, ay, az);
  return geo;
}

// 合并同材质几何体（position / normal / uv）
function mergeGeos(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i];
    pos.set(g.attributes.position.array, off * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, off * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (let i = 0; i < parts.length; i++) if (parts[i] !== list[i]) parts[i].dispose();
  for (let i = 0; i < list.length; i++) if (list[i]) list[i].dispose();
  return out;
}

// 参数曲面：fn(u,v,out{x,y,z})，u/v ∈ [0,1]
function buildSurface(nu, nv, fn) {
  const cols = nu + 1;
  const rows = nv + 1;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const o = { x: 0, y: 0, z: 0 };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / nu;
      const v = j / nv;
      fn(u, v, o);
      const k = j * cols + i;
      pos[k * 3] = o.x;
      pos[k * 3 + 1] = o.y;
      pos[k * 3 + 2] = o.z;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 羽片：沿 +X 的薄椭圆柱扫掠，宽度为 Z，厚度为 Y；可分两段材质（羽根 / 羽尖）
function featherGeo(length, width, thick, opts = {}) {
  const N = opts.sections || 12;
  const K = opts.radial || 8;
  const droop = opts.droop || 0;
  const camber = opts.camber || 0;
  const split = opts.split == null ? 0.74 : opts.split;
  const pos = [];
  const uvs = [];
  const idxBase = [];
  const idxTip = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const prof = Math.pow(Math.sin(Math.PI * (0.15 + 0.85 * u)), 0.7);
    const halfW = Math.max(0.003, width * 0.5 * prof);
    const halfT = Math.max(0.0018, thick * 0.5 * (0.3 + 0.7 * prof));
    const cx = u * length;
    const cy = -droop * u * u;
    const cz = camber * Math.sin(Math.PI * u);
    for (let k = 0; k < K; k++) {
      const th = (k / K) * TAU;
      pos.push(cx, cy + Math.sin(th) * halfT, cz + Math.cos(th) * halfW);
      uvs.push(u, (k / K));
    }
  }
  for (let i = 0; i < N; i++) {
    const uMid = (i + 0.5) / N;
    const dst = uMid <= split ? idxBase : idxTip;
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      const a = i * K + k;
      const b = i * K + k2;
      const c = (i + 1) * K + k;
      const d = (i + 1) * K + k2;
      dst.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  const all = idxBase.concat(idxTip);
  g.setIndex(all);
  g.computeVertexNormals();
  return { geo: g, baseCount: idxBase.length };
}

// 圆角矩形平板（镜片），带 UV 与向后弯曲
function roundedPanelGeo(w, h, r, bend) {
  const corners = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
    [w / 2 - r, -h / 2 + r, Math.PI * 1.5],
  ];
  const outline = [];
  const seg = 4;
  for (let ci = 0; ci < 4; ci++) {
    const cx = corners[ci][0];
    const cy = corners[ci][1];
    const a0 = corners[ci][2];
    for (let s = 0; s <= seg; s++) {
      const a = a0 + (s / seg) * (Math.PI / 2);
      outline.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  const pos = [0, 0, 0];
  const uv = [0.5, 0.5];
  const idx = [];
  for (let i = 0; i < outline.length; i++) {
    const x = outline[i][0];
    const y = outline[i][1];
    const t = x / (w * 0.5);
    pos.push(x, y, bend * t * t);
    uv.push(x / w + 0.5, y / h + 0.5);
  }
  for (let i = 0; i < outline.length; i++) {
    idx.push(0, 1 + i, 1 + ((i + 1) % outline.length));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 圆角矩形形状（含内孔用），给镜框用
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, h / 2 - r);
  s.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, h / 2);
  s.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -h / 2 + r);
  s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// 把平面几何体按 x 弯曲（镜框跟随镜片弧度）
function bendFlatGeo(geo, halfW, bend) {
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const t = p[i] / halfW;
    p[i + 2] += bend * t * t;
  }
  geo.computeVertexNormals();
  return geo;
}

// 喙：沿 -Z 扫掠的超椭圆截面，末端微微下钩
function beakGeo(base, tip, wBase, hBase, wTip, hTip, sections = 14) {
  const pos = [];
  const uvs = [];
  const idx = [];
  const K = 14;
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const cx = 0;
    const cy = lerp(base[1], tip[1], t) - 0.05 * Math.pow(smoothstep(0.82, 1, t), 2);
    const cz = lerp(base[2], tip[2], t);
    const hw = lerp(wBase * 0.5, wTip * 0.5, Math.pow(t, 0.82));
    const hh = lerp(hBase * 0.5, hTip * 0.5, Math.pow(t, 0.7));
    for (let k = 0; k < K; k++) {
      const th = (k / K) * TAU;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // 超椭圆：顶部/底部更平
      const px = cx + Math.sign(cs) * Math.pow(Math.abs(cs), 0.72) * hw;
      const py = cy + Math.sign(sn) * Math.pow(Math.abs(sn), 0.72) * hh;
      pos.push(px, py, cz);
      uvs.push(t, k / K);
    }
  }
  for (let i = 0; i < sections; i++) {
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      const a = i * K + k;
      const b = i * K + k2;
      const c = (i + 1) * K + k;
      const d = (i + 1) * K + k2;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 围巾绕颈布带：宽布带 + 自然褶皱（半径/高度随角度起伏）
function scarfBandGeo(r0, hgt, y0, tilt, phase) {
  const g = buildSurface(48, 6, (u, v, o) => {
    const th = u * TAU;
    const wob = Math.sin(th * 3 + phase) * 0.012 + Math.sin(th * 7 + phase * 1.7) * 0.005;
    const r = r0 + wob + Math.sin(Math.PI * v) * 0.008;
    const yc = y0 + Math.sin(th * 2 + phase * 0.7) * 0.012 + Math.cos(th) * tilt;
    const yy = yc + (v - 0.5) * hgt * (1 + 0.06 * Math.sin(th * 4 + phase));
    o.x = Math.sin(th) * r;
    o.y = yy;
    o.z = Math.cos(th) * r;
  });
  // 交换 UV：让条纹绕颈方向走，避免出现"轮胎纹"式同心环
  const uv = g.attributes.uv.array;
  for (let i = 0; i < uv.length; i += 2) {
    const a = uv[i];
    uv[i] = uv[i + 1] * 2.2;
    uv[i + 1] = a;
  }
  return g;
}

// ---------------------------------------------------------------- 纹理
function makeScarfTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#cf1f26';
  g.fillRect(0, 0, 128, 128);
  // 布料噪点
  for (let i = 0; i < 520; i++) {
    const x = (i * 37.7) % 128;
    const y = (i * 71.3) % 128;
    g.fillStyle = `rgba(150,16,22,${0.10 + ((i * 7) % 9) / 70})`;
    g.fillRect(x, y, 1.6, 1.6);
  }
  // 奶白条纹（沿长度方向等距 → 围巾横向条纹）
  g.fillStyle = '#fbf4e4';
  g.fillRect(0, 12, 128, 6);
  g.fillRect(0, 38, 128, 5);
  g.fillRect(0, 62, 128, 6);
  g.fillRect(0, 86, 128, 5);
  g.fillRect(0, 108, 128, 6);
  g.fillRect(0, 126, 128, 2);
  // 边缘明暗（布料卷边感）
  const edge = g.createLinearGradient(0, 0, 128, 0);
  edge.addColorStop(0, 'rgba(90,8,14,0.55)');
  edge.addColorStop(0.06, 'rgba(90,8,14,0.0)');
  edge.addColorStop(0.94, 'rgba(90,8,14,0.0)');
  edge.addColorStop(1, 'rgba(90,8,14,0.55)');
  g.fillStyle = edge;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeLensTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0.0, '#05070d');
  grad.addColorStop(0.34, '#0a1526');
  grad.addColorStop(0.55, '#1d3f66');
  grad.addColorStop(0.70, '#5c9ad0');
  grad.addColorStop(0.78, '#cfeaff');
  grad.addColorStop(0.86, '#5f9ed2');
  grad.addColorStop(1.0, '#132843');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // 斜向高光
  g.save();
  g.globalAlpha = 0.55;
  g.strokeStyle = '#eaf7ff';
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(-10, 104);
  g.lineTo(92, -12);
  g.stroke();
  g.globalAlpha = 0.25;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(18, 128);
  g.lineTo(128, 18);
  g.stroke();
  g.restore();
  // 星点高光
  const rad = g.createRadialGradient(94, 30, 0, 94, 30, 12);
  rad.addColorStop(0, 'rgba(255,255,255,0.95)');
  rad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rad;
  g.fillRect(82, 18, 30, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makePouchTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, '#f7b24a');
  grad.addColorStop(0.45, '#f2943f');
  grad.addColorStop(0.8, '#e97c36');
  grad.addColorStop(1.0, '#dd6a30');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================================
// 主函数
// ============================================================================
export function createPelican(scene) {
  const rng = makeRng(20241020);
  const disposables = [];

  // ---------------------------------------------------------------- 材质（12 个）
  const matFeather = new THREE.MeshStandardMaterial({
    color: 0xfbf6ec, roughness: 0.93, metalness: 0.0, flatShading: false, side: THREE.DoubleSide,
  });
  const matFeatherTip = new THREE.MeshStandardMaterial({
    color: 0xe8e2d6, roughness: 0.95, metalness: 0.0, flatShading: false, side: THREE.DoubleSide,
  });
  const matBeak = new THREE.MeshStandardMaterial({
    color: 0xf5a63c, roughness: 0.42, metalness: 0.05, flatShading: false, side: THREE.DoubleSide,
  });
  const pouchTex = makePouchTexture();
  const matPouch = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: pouchTex, roughness: 0.55, metalness: 0.0, flatShading: false, side: THREE.DoubleSide,
  });
  const matHelmet = new THREE.MeshStandardMaterial({
    color: 0xd8342c, roughness: 0.3, metalness: 0.18, flatShading: false, side: THREE.DoubleSide,
  });
  const matHelmetDark = new THREE.MeshStandardMaterial({
    color: 0x2f2b26, roughness: 0.62, metalness: 0.1, flatShading: false, side: THREE.DoubleSide,
  });
  const matBlack = new THREE.MeshStandardMaterial({
    color: 0x17181d, roughness: 0.52, metalness: 0.22, flatShading: false, side: THREE.DoubleSide,
  });
  const lensTex = makeLensTexture();
  const matGlasses = new THREE.MeshStandardMaterial({
    color: 0x0a0e15, roughness: 0.12, metalness: 0.62,
    map: lensTex, emissive: 0xffffff, emissiveMap: lensTex, emissiveIntensity: 0.38,
    flatShading: false, side: THREE.DoubleSide,
  });
  const matMetal = new THREE.MeshStandardMaterial({
    color: 0xd7dfe4, roughness: 0.26, metalness: 0.55, flatShading: false,
  });
  const matWicker = new THREE.MeshStandardMaterial({
    color: 0xefe6d8, roughness: 0.86, metalness: 0.0, flatShading: false,
  });
  const scarfTex = makeScarfTexture();
  const matScarf = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: scarfTex, roughness: 0.9, metalness: 0.0,
    flatShading: false, side: THREE.DoubleSide,
  });
  const matLamp = new THREE.MeshStandardMaterial({
    color: 0xfff2cc, emissive: 0xffd98a, emissiveIntensity: 1.0, roughness: 0.3, metalness: 0.0,
  });
  disposables.push(
    matFeather, matFeatherTip, matBeak, matPouch, matHelmet, matHelmetDark,
    matBlack, matGlasses, matMetal, matWicker, matScarf, matLamp, lensTex, scarfTex, pouchTex
  );

  // ---------------------------------------------------------------- 根层级
  const group = new THREE.Group();
  group.name = 'PelicanRig';
  const leanPivot = new THREE.Group();
  group.add(leanPivot);
  const wheeliePivot = new THREE.Group();
  wheeliePivot.position.set(0, 0, REAR_Z);
  leanPivot.add(wheeliePivot);
  const axleOffset = new THREE.Group();
  axleOffset.position.set(0, 0, -REAR_Z);
  wheeliePivot.add(axleOffset);
  const bike = new THREE.Group();
  bike.name = 'Bike';
  bike.scale.setScalar(BIKE_SCALE);
  axleOffset.add(bike);
  const rider = new THREE.Group();
  rider.name = 'Rider';
  axleOffset.add(rider);
  const torso = new THREE.Group();
  torso.name = 'Torso';
  torso.position.set(0, HIP_Y, HIP_Z);
  rider.add(torso);
  const torsoInner = new THREE.Group();
  torsoInner.position.set(0, -HIP_Y, -HIP_Z);
  torso.add(torsoInner);

  // ================================================================
  // 自行车（奶油色复古车 + 藤编车筐 + 铬件 + 深色胎）
  // ================================================================
  const wickerParts = [];
  const chromeParts = [];
  const darkParts = [];

  function buildWheel(z) {
    const spin = new THREE.Group();
    spin.position.set(0, AXLE_Y, z);
    bike.add(spin);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.046, 8, 22), matBlack);
    tire.rotation.y = Math.PI / 2;
    spin.add(tire);
    disposables.push(tire.geometry);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.254, 0.015, 5, 20), matMetal);
    rim.rotation.y = Math.PI / 2;
    spin.add(rim);
    disposables.push(rim.geometry);
    const hub = new THREE.Mesh(cylGeo(0.032, 0.032, 0.112, 10), matMetal);
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);
    disposables.push(hub.geometry);
    const spokeGeo = new THREE.CylinderGeometry(0.0042, 0.0042, 0.236, 4, 1, false);
    const spokes = new THREE.InstancedMesh(spokeGeo, matMetal, 12);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      dummy.position.set(0, 0.12 * Math.cos(a), 0.12 * Math.sin(a));
      dummy.rotation.set(a, 0, 0);
      dummy.updateMatrix();
      spokes.setMatrixAt(i, dummy.matrix);
    }
    spokes.instanceMatrix.needsUpdate = true;
    spin.add(spokes);
    disposables.push(spokeGeo);
    return { spin, spokes };
  }
  const frontWheel = buildWheel(FRONT_Z);
  const rearWheel = buildWheel(REAR_Z);

  // 车架
  wickerParts.push(geoBetween(0, 0.645, -0.445, 0, 0.825, -0.428, 0.036, 0.032, 8));
  wickerParts.push(geoBetween(0, 0.79, 0.185, 0, 0.805, -0.42, 0.027, 0.023, 6));
  wickerParts.push(geoBetween(0, 0.315, 0.075, 0, 0.665, -0.448, 0.032, 0.027, 6));
  wickerParts.push(geoBetween(0, 0.305, 0.075, 0, 0.79, 0.185, 0.030, 0.025, 6));
  for (let s = -1; s <= 1; s += 2) {
    wickerParts.push(geoBetween(s * 0.045, 0.305, 0.095, s * 0.055, AXLE_Y, 0.572, 0.014, 0.012, 4));
    wickerParts.push(geoBetween(s * 0.028, 0.775, 0.19, s * 0.05, AXLE_Y, 0.572, 0.012, 0.010, 4));
    wickerParts.push(geoBetween(s * 0.055, 0.635, -0.442, s * 0.052, AXLE_Y, -0.605, 0.016, 0.013, 5));
  }
  wickerParts.push(gTRS(boxGeo(0.155, 0.05, 0.08), 1, 1, 1, 0, 0, 0, 0, 0.638, -0.44));
  chromeParts.push(gTRS(cylGeo(0.046, 0.046, 0.13, 10), 1, 1, 1, 0, 0, Math.PI / 2, 0, BB_Y, BB_Z));
  // 座杆 + 车座
  chromeParts.push(geoBetween(0, 0.785, 0.19, 0, 0.915, 0.275, 0.019, 0.019, 6));
  darkParts.push(gTRS(sphGeo(1, 12, 8), 0.112, 0.05, 0.245, 0, 0, 0, 0, 0.948, 0.335));
  darkParts.push(gTRS(sphGeo(1, 10, 7), 0.068, 0.036, 0.115, 0, 0, 0, 0, 0.941, 0.158));

  // 挡泥板（沿圆周的短管段）
  function fender(z, a0, a1, tubeR) {
    const segs = 7;
    const R = 0.372;
    for (let i = 0; i < segs; i++) {
      const t0 = a0 + ((a1 - a0) * i) / segs;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / segs;
      const p0 = [0, AXLE_Y + R * Math.sin(t0), z - R * Math.cos(t0)];
      const p1 = [0, AXLE_Y + R * Math.sin(t1), z - R * Math.cos(t1)];
      wickerParts.push(geoBetween(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], tubeR, tubeR, 4));
    }
  }
  fender(FRONT_Z, -0.55, 1.75, 0.021);
  fender(REAR_Z, 1.15, 3.35, 0.021);
  for (let s = -1; s <= 1; s += 2) {
    chromeParts.push(geoBetween(s * 0.05, AXLE_Y, FRONT_Z + 0.06, s * 0.075, 0.60, FRONT_Z - 0.16, 0.007, 0.007, 3));
  }

  // 车把（复古高把，抬升前伸；bike 已整体缩放，位置按世界目标反算）
  const GRIP_X = 0.282 / BIKE_SCALE;
  const GRIP_Y = 1.53 / BIKE_SCALE;
  const GRIP_Z = -0.795 / BIKE_SCALE;
  chromeParts.push(geoBetween(0, 0.815, -0.432, 0, 0.99, -0.492, 0.023, 0.020, 6));
  darkParts.push(gTRS(boxGeo(0.075, 0.032, 0.055), 1, 1, 1, 0, 0, 0, 0, 1.005, -0.5));
  for (let s = -1; s <= 1; s += 2) {
    chromeParts.push(geoBetween(s * 0.03, 1.0, -0.492, s * 0.115, 1.13, -0.555, 0.019, 0.019, 6));
    chromeParts.push(geoBetween(s * 0.115, 1.13, -0.555, s * 0.21, 1.29, -0.655, 0.018, 0.018, 6));
    chromeParts.push(geoBetween(s * 0.21, 1.29, -0.655, s * (GRIP_X - 0.011), GRIP_Y - 0.006, GRIP_Z + 0.012, 0.017, 0.017, 6));
    darkParts.push(geoBetween(s * (GRIP_X - 0.028), GRIP_Y - 0.035, GRIP_Z + 0.044, s * (GRIP_X + 0.028), GRIP_Y + 0.001, GRIP_Z - 0.027, 0.025, 0.026, 8));
    chromeParts.push(geoBetween(s * 0.115, 1.13, -0.555, s * 0.03, 0.95, -0.47, 0.006, 0.006, 3));
  }
  chromeParts.push(gTRS(sphGeo(0.03, 10, 8), 1, 1, 1, 0, 0, 0, 0.055, 1.03, -0.505));
  darkParts.push(geoBetween(0.062, BB_Y + 0.09, BB_Z + 0.06, 0.062, AXLE_Y + 0.02, REAR_Z - 0.02, 0.008, 0.008, 3));
  darkParts.push(geoBetween(0.062, BB_Y - 0.09, BB_Z + 0.06, 0.062, AXLE_Y - 0.01, REAR_Z - 0.02, 0.008, 0.008, 3));

  // 车筐（藤编色 + 铬丝网格）
  const bY = BASKET_Y;
  const bZ = BASKET_Z;
  wickerParts.push(geoBetween(-0.115, 0.628, -0.455, -0.10, bY - 0.10, bZ + 0.10, 0.010, 0.010, 4));
  wickerParts.push(geoBetween(0.115, 0.628, -0.455, 0.10, bY - 0.10, bZ + 0.10, 0.010, 0.010, 4));
  wickerParts.push(gTRS(boxGeo(0.30, 0.016, 0.24), 1, 1, 1, 0, 0, 0, 0, bY - 0.105, bZ));
  wickerParts.push(gTRS(boxGeo(0.30, 0.205, 0.014), 1, 1, 1, -0.09, 0, 0, 0, bY, bZ - 0.124));
  wickerParts.push(gTRS(boxGeo(0.30, 0.205, 0.014), 1, 1, 1, 0.09, 0, 0, 0, bY, bZ + 0.124));
  wickerParts.push(gTRS(boxGeo(0.014, 0.205, 0.24), 1, 1, 1, 0, 0, 0.09, -0.154, bY, bZ));
  wickerParts.push(gTRS(boxGeo(0.014, 0.205, 0.24), 1, 1, 1, 0, 0, -0.09, 0.154, bY, bZ));
  const rimY = bY + 0.104;
  chromeParts.push(geoBetween(-0.166, rimY, bZ - 0.137, 0.166, rimY, bZ - 0.137, 0.011, 0.011, 4));
  chromeParts.push(geoBetween(-0.166, rimY, bZ + 0.137, 0.166, rimY, bZ + 0.137, 0.011, 0.011, 4));
  chromeParts.push(geoBetween(-0.166, rimY, bZ - 0.137, -0.166, rimY, bZ + 0.137, 0.011, 0.011, 4));
  chromeParts.push(geoBetween(0.166, rimY, bZ - 0.137, 0.166, rimY, bZ + 0.137, 0.011, 0.011, 4));
  const bandYs = [bY + 0.035, bY - 0.045];
  for (let bi = 0; bi < bandYs.length; bi++) {
    const by2 = bandYs[bi];
    chromeParts.push(geoBetween(-0.160, by2, bZ - 0.133, 0.160, by2, bZ - 0.133, 0.005, 0.005, 3));
    chromeParts.push(geoBetween(-0.160, by2, bZ + 0.133, 0.160, by2, bZ + 0.133, 0.005, 0.005, 3));
    for (let s = -1; s <= 1; s += 2) {
      chromeParts.push(geoBetween(s * 0.162, by2, bZ - 0.133, s * 0.162, by2, bZ + 0.133, 0.005, 0.005, 3));
    }
  }
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i++) {
      const zz = bZ - 0.09 + i * 0.09;
      chromeParts.push(geoBetween(s * 0.162, rimY - 0.006, zz, s * 0.158, bY - 0.098, zz, 0.0042, 0.0042, 3));
    }
    for (let i = -1; i <= 1; i++) {
      const xx = i * 0.09;
      chromeParts.push(geoBetween(xx, rimY - 0.006, bZ + s * 0.136, xx, bY - 0.098, bZ + s * 0.132, 0.0042, 0.0042, 3));
    }
  }

  // 车灯
  darkParts.push(gTRS(cylGeo(0.046, 0.041, 0.07, 12), 1, 1, 1, Math.PI / 2, 0, 0, 0, 0.90, bZ - 0.176));
  const lampLens = new THREE.Mesh(sphGeo(0.041, 14, 10), matLamp);
  lampLens.position.set(0, 0.90, bZ - 0.214);
  lampLens.scale.set(1, 0.92, 0.3);
  bike.add(lampLens);
  disposables.push(lampLens.geometry);
  const lampRing = new THREE.Mesh(torusGeo(0.04, 0.008, 5, 16), matMetal);
  lampRing.position.set(0, 0.90, bZ - 0.203);
  bike.add(lampRing);
  disposables.push(lampRing.geometry);
  const lampLight = new THREE.PointLight(0xffd9a0, 0.0, 8, 2);
  lampLight.position.set(0, 0.95, bZ - 0.30);
  bike.add(lampLight);

  // 曲柄 / 脚踏 / 链轮
  const chainring = new THREE.Mesh(cylGeo(0.102, 0.102, 0.014, 14), matMetal);
  chainring.position.set(0.075, BB_Y, BB_Z);
  chainring.rotation.z = Math.PI / 2;
  bike.add(chainring);
  disposables.push(chainring.geometry);
  const crankArmGeo = new THREE.CylinderGeometry(0.016, 0.013, 0.125, 6);
  crankArmGeo.translate(0, 0.0525, 0);
  const crankR = new THREE.Mesh(crankArmGeo, matMetal);
  crankR.position.set(0.082, BB_Y, BB_Z);
  bike.add(crankR);
  const crankL = new THREE.Mesh(crankArmGeo, matMetal);
  crankL.position.set(-0.082, BB_Y, BB_Z);
  bike.add(crankL);
  disposables.push(crankArmGeo);
  const pedalGeo = boxGeo(0.075, 0.022, 0.10);
  const pedalR = new THREE.Mesh(pedalGeo, matBlack);
  const pedalL = new THREE.Mesh(pedalGeo, matBlack);
  bike.add(pedalR, pedalL);
  disposables.push(pedalGeo);

  put(bike, mergeGeos(wickerParts), matWicker);
  put(bike, mergeGeos(chromeParts), matMetal);
  put(bike, mergeGeos(darkParts), matBlack);

  // ================================================================
  // 鸟体：Lathe 轮廓（圆润胸腹 / 收腰 / 尾根上翘）+ 脖子 + 胸口绒羽
  // ================================================================
  const bodyProfile = [
    [0.02, 0.80], [0.135, 0.822], [0.20, 0.856], [0.252, 0.90], [0.282, 0.955],
    [0.296, 1.015], [0.298, 1.08], [0.29, 1.145], [0.272, 1.21], [0.246, 1.275],
    [0.212, 1.335], [0.175, 1.39], [0.14, 1.435], [0.112, 1.47], [0.10, 1.50],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  const bodyGeo = new THREE.LatheGeometry(bodyProfile, 30);
  bodyGeo.scale(1.0, 1.0, 1.12);
  bodyGeo.rotateX(-0.04);
  bodyGeo.translate(0, 0, 0.02);
  const bodyParts = [bodyGeo];
  // 脖子（两段，平滑）
  bodyParts.push(geoBetween(0, 1.44, -0.07, 0, 1.535, -0.098, 0.118, 0.104, 16));
  bodyParts.push(geoBetween(0, 1.515, -0.098, 0, 1.585, -0.112, 0.102, 0.09, 16));
  // 尾根上翘
  bodyParts.push(gTRS(sphGeo(1, 14, 10), 0.155, 0.085, 0.12, -0.35, 0, 0, 0, 1.005, 0.27));
  // 胸口细小绒羽层次（平滑小绒团，半嵌入胸口）
  const fluffBases = [
    [0, 1.205, -0.292, 0.10, 0.05, 0.02],
    [-0.085, 1.165, -0.283, 0.09, 0.045, 0.019],
    [0.085, 1.165, -0.283, 0.09, 0.045, 0.019],
    [0, 1.105, -0.30, 0.095, 0.045, 0.019],
    [-0.062, 1.05, -0.29, 0.075, 0.038, 0.017],
    [0.062, 1.05, -0.29, 0.075, 0.038, 0.017],
  ];
  for (let i = 0; i < fluffBases.length; i++) {
    const f = fluffBases[i];
    bodyParts.push(gTRS(sphGeo(1, 12, 8), f[3], f[4], f[5], 0, 0, 0, f[0], f[1], f[2]));
  }
  put(torsoInner, mergeGeos(bodyParts), matFeather);

  // ================================================================
  // 尾羽（6 片扇形，平滑羽片 + 略深羽尖）
  // ================================================================
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 1.10, 0.335);
  torsoInner.add(tailPivot);
  const tailSpecs = [
    [-0.78, 0.28, 0.165], [-0.47, 0.33, 0.18], [-0.16, 0.35, 0.185],
    [0.16, 0.35, 0.185], [0.47, 0.33, 0.18], [0.78, 0.28, 0.165],
  ];
  for (let i = 0; i < tailSpecs.length; i++) {
    const spec = tailSpecs[i];
    const f = featherGeo(spec[1], spec[2], 0.016, { sections: 10, radial: 8, split: 0.7, droop: 0.03 });
    f.geo.addGroup(0, f.baseCount, 0);
    f.geo.addGroup(f.baseCount, f.geo.index.count - f.baseCount, 1);
    const mesh = new THREE.Mesh(f.geo, [matFeather, matFeatherTip]);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = -Math.PI / 2 + spec[0];
    mesh.rotation.z = 0.42;
    tailPivot.add(mesh);
    disposables.push(f.geo);
  }

  // ================================================================
  // 头部
  // ================================================================
  const headGroup = new THREE.Group();
  headGroup.position.set(0, HEAD_PIVOT_Y, 0);
  torsoInner.add(headGroup);

  // ---- 头（后脑略圆、脸颊略收）+ 眉骨 + 下巴喉部过渡
  const headCream = [];
  headCream.push(gTRS(sphGeo(1, 24, 18), 0.228, 0.234, 0.252, 0, 0, 0, 0, 0.21, -0.095));
  // 喙根 / 脸颊过渡羽环（遮住喙与头球的硬切边）
  const beakCollar = new THREE.TorusGeometry(0.102, 0.028, 6, 16);
  beakCollar.scale(1.22, 0.72, 0.90);
  beakCollar.translate(0, 0.098, -0.206);
  headCream.push(beakCollar);
  // （去掉额头的眉骨体块，保持脸部干净）
  // 下巴 / 喉部过渡（避免脖子像直接插进球里）
  headCream.push(gTRS(sphGeo(1, 14, 10), 0.090, 0.064, 0.078, 0.18, 0, 0, 0, 0.058, -0.168));
  // 眼睛高光（奶白小点，落在深色眼珠左上；眼睛在镜片后方，高光自然也藏起来）
  for (let s = -1; s <= 1; s += 2) {
    headCream.push(gTRS(sphGeo(1, 8, 6), 0.0052, 0.0052, 0.005, 0, 0, 0, s * 0.066 - 0.0062, 0.2325, -0.3365));
  }
  const headCreamMesh = new THREE.Mesh(mergeGeos(headCream), matFeather);
  headGroup.add(headCreamMesh);

  // ---- 喙（上颌 + 脊线 + 下颌 + 喉囊 + 嘴缝 + 鼻孔）
  const beakParts = [];
  // 上颌：根窄尖细的长扁喙，末端下钩
  const upperBeak = beakGeo([0, 0.092, -0.212], [0, -0.018, -0.900], 0.215, 0.072, 0.042, 0.020, 20);
  beakParts.push(upperBeak);
  // 上颌脊线（抬起的窄棱，靠光照形成浅色高光）
  const ridgeSpecs = [
    [[0, 0.130, -0.245], [0, 0.107, -0.45], 0.0105, 0.0085],
    [[0, 0.107, -0.45], [0, 0.070, -0.645], 0.0085, 0.0060],
    [[0, 0.070, -0.645], [0, 0.030, -0.805], 0.0060, 0.0038],
  ];
  for (let i = 0; i < ridgeSpecs.length; i++) {
    const r = ridgeSpecs[i];
    beakParts.push(geoBetween(r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2], r[3], 5));
  }
  // 喙尖下钩
  beakParts.push(beakGeo([0, -0.006, -0.876], [0, -0.052, -0.916], 0.042, 0.024, 0.014, 0.009, 8));
  // 下颌（薄片，兜在喉囊上沿）
  const lowerBeak = beakGeo([0, 0.048, -0.212], [0, -0.030, -0.862], 0.17, 0.020, 0.04, 0.009, 14);
  beakParts.push(lowerBeak);
  // 喙根的肉色过渡
  beakParts.push(gTRS(sphGeo(1, 14, 10), 0.104, 0.050, 0.070, -0.10, 0, 0, 0, 0.096, -0.232));
  const beakRoot = new THREE.Group();
  beakRoot.position.set(0, 0.006, -0.032);
  beakRoot.rotation.x = 0.06;
  headGroup.add(beakRoot);
  const beakMesh = new THREE.Mesh(mergeGeos(beakParts), matBeak);
  beakRoot.add(beakMesh);

  // 喉囊（可动，下垂的囊袋，橙黄→橙红渐变）
  const pouchGeo = sphGeo(1, 20, 14);
  const pouch = new THREE.Mesh(pouchGeo, matPouch);
  pouch.position.set(0, -0.072, -0.535);
  pouch.rotation.x = -0.07;
  pouch.scale.set(0.104, 0.090, 0.282);
  beakRoot.add(pouch);
  disposables.push(pouchGeo);
  const throat = new THREE.Mesh(sphGeo(1, 14, 10), matPouch);
  throat.position.set(0, 0.006, -0.268);
  throat.scale.set(0.074, 0.046, 0.078);
  beakRoot.add(throat);
  disposables.push(throat.geometry);

  // ---- 深色配件（小黑豆眼睛 / 嘴缝 / 鼻孔凹陷 / 头盔扣带等）
  const darkDetails = [];
  const beakDarkParts = [];
  for (let s = -1; s <= 1; s += 2) {
    // 小黑豆眼睛（藏在镜片后方：墨镜必须挡住眼睛，不再露在镜片上沿）
    darkDetails.push(gTRS(sphGeo(1, 14, 10), 0.019, 0.019, 0.019, 0, 0, 0, s * 0.066, 0.226, -0.330));
    // 嘴缝（沿喙两侧贯通到尖端；起点从喙根前移到喙身上，避免看起来像脸颊裂纹）
    beakDarkParts.push(geoBetween(s * 0.101, 0.068, -0.302, s * 0.086, 0.030, -0.530, 0.0036, 0.0032, 4));
    beakDarkParts.push(geoBetween(s * 0.086, 0.030, -0.530, s * 0.036, -0.012, -0.790, 0.0032, 0.0028, 4));
    // 鼻孔（小凹陷：扁平深色点，半嵌入脊线两侧）
    beakDarkParts.push(gTRS(sphGeo(1, 8, 6), 0.0075, 0.0042, 0.011, 0, 0, 0, s * 0.030, 0.118, -0.300));
  }

  const beakDarkMesh = new THREE.Mesh(mergeGeos(beakDarkParts), matBlack);
  beakRoot.add(beakDarkMesh);
  disposables.push(beakDarkMesh.geometry);

  // ================================================================
  // 运动会墨镜：两片大圆角镜片（眼睛位置）+ 加厚深色镜框 + 鼻梁 + 镜腿
  // ================================================================
  const lensGeos = [];
  const frameGeos = [];
  for (let s = -1; s <= 1; s += 2) {
    const lens = roundedPanelGeo(0.130, 0.078, 0.030, 0.030);
    lens.rotateY(s * 0.30);
    lens.rotateX(-0.12);
    lens.translate(s * 0.100, 0.206, -0.356);
    lensGeos.push(lens);
    // 镜框（环，明显加厚；整体前移到脸面之外，看起来是"戴"上去而不是"嵌"进去）
    const outer = roundedRectShape(0.146, 0.092, 0.034);
    outer.holes.push(roundedRectShape(0.122, 0.073, 0.026));
    const fg = new THREE.ShapeGeometry(outer, 12);
    bendFlatGeo(fg, 0.073, 0.032);
    fg.rotateY(s * 0.30);
    fg.rotateX(-0.12);
    fg.translate(s * 0.100, 0.206, -0.366);
    frameGeos.push(fg);
    // 镜腿：从镜框外上角斜向耳后
    frameGeos.push(geoBetween(s * 0.170, 0.246, -0.336, s * 0.232, 0.216, -0.03, 0.0050, 0.0044, 5));
    frameGeos.push(geoBetween(s * 0.232, 0.216, -0.03, s * 0.222, 0.202, 0.055, 0.0048, 0.004, 5));
  }
  frameGeos.push(gTRS(boxGeo(0.076, 0.005, 0.010), 1, 1, 1, 0, 0, 0, 0, 0.234, -0.368)); // 鼻梁连接（细）
  const lensMesh = new THREE.Mesh(mergeGeos(lensGeos), matGlasses);
  headGroup.add(lensMesh);
  const frameMesh = new THREE.Mesh(mergeGeos(frameGeos), matBlack);
  headGroup.add(frameMesh);
  disposables.push(lensMesh.geometry, frameMesh.geometry);

  // ================================================================
  // 头盔：贴合头骨的外壳（分段通风槽 + 白色中脊 + 白帽圈/帽檐 + 后调节扣）
  // ================================================================
  const helmetGroup = new THREE.Group();
  helmetGroup.position.set(0, 0.256, -0.09);
  helmetGroup.rotation.x = 0.22; // 前檐抬高、后檐下压 → 露出眼睛，像真正的骑行头盔
  helmetGroup.scale.set(1.0, 0.82, 1.18);
  headGroup.add(helmetGroup);

  const HR = 0.264; // 头盔基准半径（≈ 头宽 × 1.12 / 2）
  const shellBands = [
    [0.0, 0.092], [0.102, 0.092], [0.204, 0.092], [0.306, 0.244],
  ];
  const tealGeos = [];
  for (let i = 0; i < shellBands.length; i++) {
    const start = shellBands[i][0] * Math.PI;
    const len = shellBands[i][1] * Math.PI;
    tealGeos.push(new THREE.SphereGeometry(HR, 26, 3, 0, TAU, start, len));
  }
  // 后部气动小尾翼
  tealGeos.push(gTRS(sphGeo(1, 12, 8), 0.072, 0.034, 0.10, -0.15, 0, 0, 0, -0.058, 0.212));
  const helmetShell = new THREE.Mesh(mergeGeos(tealGeos), matHelmet);
  helmetGroup.add(helmetShell);
  disposables.push(helmetShell.geometry);

  // 内层深色衬里（从通风槽缝隙透出）
  const innerShell = new THREE.Mesh(new THREE.SphereGeometry(HR * 0.972, 22, 8, 0, TAU, 0, 0.55 * Math.PI), matHelmetDark);
  helmetGroup.add(innerShell);
  disposables.push(innerShell.geometry);

  // 白色中脊（前后两条经线窄带）
  const ridgeGeos = [
    new THREE.SphereGeometry(HR * 1.009, 3, 12, Math.PI * 0.5 - 0.035, 0.07, 0.004, 0.55 * Math.PI),
    new THREE.SphereGeometry(HR * 1.009, 3, 12, Math.PI * 1.5 - 0.035, 0.07, 0.004, 0.55 * Math.PI),
  ];
  // 白色帽圈 + 前帽檐（前部略微外扩）
  const rimGeo = buildSurface(44, 4, (u, v, o) => {
    const th = (0.528 + v * 0.030) * Math.PI;
    const phi = u * TAU;
    const front = Math.max(0, Math.cos(phi - Math.PI * 1.5));
    const flare = 1 + 0.16 * Math.pow(front, 3) * Math.pow(v, 0.7);
    const r = HR * 1.006 * flare;
    const st = Math.sin(th);
    o.x = -r * Math.cos(phi) * st;
    o.y = r * Math.cos(th) * 0.985;
    o.z = r * Math.sin(phi) * st;
  });
  // 前帽檐：从帽圈前缘外伸、略向下压
  const visorGeo = buildSurface(14, 3, (u, v, o) => {
    const phi = Math.PI * 1.5 + (u - 0.5) * 1.15;
    const th = Math.PI * 0.545;
    const st = Math.sin(th);
    const bx = -HR * Math.cos(phi) * st;
    const by = HR * Math.cos(th) * 0.985;
    const bz = HR * Math.sin(phi) * st;
    const taper = Math.pow(Math.sin(Math.PI * u), 0.55);
    const out = 0.070 * taper * v;
    const rl = Math.hypot(bx, bz) || 1;
    o.x = bx + (bx / rl) * out;
    o.y = by - 0.040 * v * Math.min(1, taper + 0.35);
    o.z = bz + (bz / rl) * out;
  });
  const whiteHelmetMesh = new THREE.Mesh(mergeGeos(ridgeGeos.concat([rimGeo])), matFeather);
  helmetGroup.add(whiteHelmetMesh);
  disposables.push(whiteHelmetMesh.geometry);

  // 后调节扣 + 侧扣（深色）
  const visorMesh = new THREE.Mesh(visorGeo, matHelmet);
  helmetGroup.add(visorMesh);
  disposables.push(visorMesh.geometry);

  const helmetDarkParts = [];
  helmetDarkParts.push(gTRS(boxGeo(0.115, 0.05, 0.035), 1, 1, 1, 0.1, 0, 0, 0, 0.005, 0.253));
  helmetDarkParts.push(gTRS(cylGeo(0.027, 0.027, 0.018, 10), 1, 1, 1, Math.PI / 2, 0, 0, 0, 0.005, 0.272));
  const helmetDarkMesh = new THREE.Mesh(mergeGeos(helmetDarkParts), matBlack);
  helmetGroup.add(helmetDarkMesh);
  disposables.push(helmetDarkMesh.geometry);

  // 下巴扣带：从正面/侧面看会在脸颊上留下两条黑线，与长喙造型冲突 → 移除，
  // 头盔改为「无带」的简洁外观（下巴卡扣也一并去掉）。
  void 0;
  const darkMesh = new THREE.Mesh(mergeGeos(darkDetails), matBlack);
  headGroup.add(darkMesh);
  disposables.push(darkMesh.geometry);

  // ================================================================
  // 翅膀：收拢时贴身的平滑翼壳，展开成 4 层扇形飞羽
  // ================================================================
  const shoulderPositions = [0.285, -0.285];
  const wings = [];
  const featherSpecs = [
    { len: 0.70, wid: 0.300, droop: 0.050, camber: 0.020 },
    { len: 0.64, wid: 0.285, droop: 0.048, camber: 0.018 },
    { len: 0.55, wid: 0.260, droop: 0.044, camber: 0.016 },
    { len: 0.46, wid: 0.235, droop: 0.040, camber: 0.014 },
    { len: 0.38, wid: 0.265, droop: 0.038, camber: 0.012 },
    { len: 0.32, wid: 0.245, droop: 0.034, camber: 0.011 },
    { len: 0.27, wid: 0.215, droop: 0.030, camber: 0.010 },
    { len: 0.22, wid: 0.185, droop: 0.026, camber: 0.009 },
  ];
  for (let w = 0; w < 2; w++) {
    const sign = w === 0 ? 1 : -1;
    const wingRoot = new THREE.Group();
    wingRoot.position.set(sign * 0.225, 1.272, 0.015);
    torsoInner.add(wingRoot);
    const feathers = [];
    for (let i = 0; i < featherSpecs.length; i++) {
      const spec = featherSpecs[i];
      const pivot = new THREE.Group();
      pivot.position.set(0.01 + i * 0.016, -i * 0.009, i * 0.013 - 0.008);
      const twist = new THREE.Group();
      pivot.add(twist);
      const f = featherGeo(spec.len, spec.wid, 0.018, {
        sections: 14, radial: 8, split: 0.72, droop: spec.droop, camber: spec.camber,
      });
      if (sign < 0) {
        // 镜像：x 取负 + 反转绕序
        const arr = f.geo.attributes.position.array;
        for (let k = 0; k < arr.length; k += 3) arr[k] = -arr[k];
        const idx = f.geo.index.array;
        for (let t = 0; t < idx.length; t += 9) {
          for (let q = 0; q < 3; q++) {
            const a = t + 3 + q;
            const b = t + 6 + q;
            const tmp = idx[a];
            idx[a] = idx[b];
            idx[b] = tmp;
          }
        }
        f.geo.index.needsUpdate = true;
        f.geo.computeVertexNormals();
      }
      f.geo.addGroup(0, f.baseCount, 0);
      f.geo.addGroup(f.baseCount, f.geo.index.count - f.baseCount, 1);
      const mesh = new THREE.Mesh(f.geo, [matFeather, matFeatherTip]);
      twist.add(mesh);
      wingRoot.add(pivot);
      feathers.push({ pivot, twist });
      disposables.push(f.geo);
    }
    wings.push({ sign, root: wingRoot, feathers });
  }

  // ================================================================
  // 翅手：抓着车把的两段式手臂 + 蹼手（每帧双骨 IK）
  // ================================================================
  const ARM_L1 = 0.42; // 上臂
  const ARM_L2 = 0.43; // 前臂
  const SHOULDER_X = 0.245;
  const SHOULDER_Y = 1.440;
  const SHOULDER_Z = 0.030;

  // 上臂：沿 +Y 的胶囊（肩点 = 原点）
  const armUpperGeo = mergeGeos([
    gTRS(cylGeo(0.047, 0.039, ARM_L1, 10), 1, 1, 1, 0, 0, 0, 0, ARM_L1 * 0.5, 0),
    gTRS(sphGeo(0.047, 10, 8), 1, 1, 1, 0, 0, 0, 0, 0, 0),
  ]);
  // 前臂：胶囊 + 后缘小覆羽（肘部 = 原点）
  const armFeather = featherGeo(0.20, 0.085, 0.016, { sections: 8, radial: 6, split: 2 });
  armFeather.geo.rotateZ(Math.PI / 2 - 0.18);
  armFeather.geo.translate(0, ARM_L2 * 0.44, 0.030);
  const armForeGeo = mergeGeos([
    gTRS(cylGeo(0.038, 0.030, ARM_L2, 10), 1, 1, 1, 0, 0, 0, 0, ARM_L2 * 0.5, 0),
    armFeather.geo,
  ]);
  // 肘 / 腕关节（略深羽色）
  const armJointGeo = mergeGeos([
    gTRS(sphGeo(0.040, 10, 8), 1, 1, 1, 0, 0, 0, 0, 0, 0),
    gTRS(sphGeo(0.031, 8, 6), 1, 1, 1, 0, 0, 0, 0, ARM_L2, 0),
  ]);
  // 手：局部 X = 把套轴，Y = 上；掌心奶白 + 三指节 + 拇指（暖橙）
  const handPalmGeo = gTRS(sphGeo(1, 10, 8), 0.052, 0.028, 0.058, 0, 0, 0, 0, 0.021, 0.004);
  const handFingerGeos = [];
  for (let fi = -1; fi <= 1; fi++) {
    const tor = new THREE.TorusGeometry(0.033, 0.0088, 5, 6, Math.PI * 1.25);
    tor.rotateY(Math.PI / 2);
    tor.rotateX(-0.35 + fi * 0.07);
    tor.translate(fi * 0.019, 0.0, 0.0);
    handFingerGeos.push(tor);
  }
  handFingerGeos.push(gTRS(sphGeo(1, 8, 6), 0.013, 0.015, 0.026, 0, 0, 0, 0.014, -0.006, 0.030));
  const handFingersGeo = mergeGeos(handFingerGeos);
  const palmVerts = handPalmGeo.index ? handPalmGeo.index.count : handPalmGeo.attributes.position.count;
  const handGeo = mergeGeos([handPalmGeo, handFingersGeo]);
  handGeo.addGroup(0, palmVerts, 0);
  handGeo.addGroup(palmVerts, handGeo.attributes.position.count - palmVerts, 1);
  disposables.push(armUpperGeo, armForeGeo, armJointGeo, handGeo);

  const arms = [];
  for (let ai = 0; ai < 2; ai++) {
    const sign = ai === 0 ? 1 : -1;
    const upperArm = new THREE.Mesh(armUpperGeo, matFeather);
    const foreGroup = new THREE.Group();
    const foreArm = new THREE.Mesh(armForeGeo, matFeather);
    const jointTips = new THREE.Mesh(armJointGeo, matFeatherTip);
    foreGroup.add(foreArm, jointTips);
    const hand = new THREE.Mesh(handGeo, [matFeather, matBeak]);
    torsoInner.add(upperArm, foreGroup, hand);
    arms.push({ sign, upperArm, foreGroup, hand });
  }
  // 肩部羽垫：把抬高的肩点与身体/脖子自然接起来（避免手臂悬空）
  for (let ai2 = 0; ai2 < 2; ai2++) {
    const sign = ai2 === 0 ? 1 : -1;
    const pad = new THREE.Mesh(mergeGeos([
      gTRS(sphGeo(1, 14, 10), 0.075, 0.060, 0.090, 0, 0, 0, sign * 0.220, 1.447, 0.018),
      geoBetween(sign * 0.085, 1.398, 0.005, sign * 0.220, 1.440, 0.016, 0.085, 0.048, 8),
    ]), matFeather);
    torsoInner.add(pad);
    disposables.push(pad.geometry);
  }

  // ================================================================
  // 腿：两段式 + 蹼足三趾
  // ================================================================
  const thighGeo = cylGeo(0.062, 0.047, THIGH_L, 12);
  const shinParts = [
    gTRS(cylGeo(0.045, 0.032, SHIN_L, 12), 1, 1, 1, 0, 0, 0, 0, 0, 0),
    gTRS(sphGeo(0.05, 12, 9), 1, 1, 1, 0, 0, 0, 0, SHIN_L * 0.5, 0),
  ];
  const shinGeo = mergeGeos(shinParts);
  const footGeo = (() => {
    const parts = [];
    // 蹼掌（圆角扁片，朝 -Z）
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.018);
    shape.quadraticCurveTo(0.082, -0.02, 0.092, -0.155);
    shape.quadraticCurveTo(0.05, -0.185, 0, -0.172);
    shape.quadraticCurveTo(-0.05, -0.185, -0.092, -0.155);
    shape.quadraticCurveTo(-0.082, -0.02, 0, 0.018);
    const web = new THREE.ShapeGeometry(shape, 8);
    web.rotateX(Math.PI / 2);
    web.translate(0, -0.024, 0.0);
    parts.push(web);
    // 三趾隆起
    for (let t = -1; t <= 1; t++) {
      const toe = cylGeo(0.012, 0.02, 0.15, 6);
      toe.rotateX(Math.PI / 2);
      toe.rotateY(t * 0.34);
      toe.scale(1, 0.55, 1);
      toe.translate(t * 0.03, -0.012, -0.085);
      parts.push(toe);
    }
    return mergeGeos(parts);
  })();
  disposables.push(thighGeo, shinGeo, footGeo);
  const legs = [];
  for (let s = -1; s <= 1; s += 2) {
    const thigh = new THREE.Mesh(thighGeo, matBeak);
    const shin = new THREE.Mesh(shinGeo, matBeak);
    const foot = new THREE.Mesh(footGeo, matBeak);
    rider.add(thigh, shin, foot);
    legs.push({ sign: s, thigh, shin, foot });
  }

  // ================================================================
  // 围巾：颈部两圈宽布带（有褶皱）+ 结 + Verlet 布料尾部
  // ================================================================
  const wrapParts = [];
  const band1 = scarfBandGeo(0.135, 0.15, 1.455, 0.018, 0.6);
  const band2 = scarfBandGeo(0.142, 0.115, 1.512, -0.014, 2.3);
  wrapParts.push(band1, band2);
  // 结
  wrapParts.push(gTRS(sphGeo(1, 14, 10), 0.078, 0.058, 0.062, 0, 0, 0, 0.012, 1.495, 0.092));
  wrapParts.push(gTRS(sphGeo(1, 12, 9), 0.048, 0.042, 0.046, 0, 0, 0, 0.09, 1.468, 0.105));
  // 结下垂的一小片布
  const drop = buildSurface(6, 4, (u, v, o) => {
    const xx = (u - 0.5) * 0.11;
    o.x = 0.02 + xx;
    o.y = 1.448 - v * 0.155 + Math.sin(u * Math.PI) * 0.012;
    o.z = 0.148 + v * 0.02 + Math.abs(xx) * 0.32;
  });
  wrapParts.push(drop);
  const wrapMesh = new THREE.Mesh(mergeGeos(wrapParts), matScarf);
  torsoInner.add(wrapMesh);
  disposables.push(wrapMesh.geometry);

  // ---- 布料网格
  const scarf = {
    cols: 0, rows: 0, count: 0,
    pos: null, prev: null,
    restH: 0.04, restV: 0.05, restD: 0.064,
    mesh: null, fringe: null, strand: null,
    fringePos: null, fringeCount: 0, strandPos: null, strandCount: 0,
  };
  const scarfMesh = new THREE.Mesh(new THREE.BufferGeometry(), matScarf);
  scarfMesh.frustumCulled = false;
  scarfMesh.name = 'ScarfCloth';
  torsoInner.add(scarfMesh);
  scarf.mesh = scarfMesh;
  const fringeMesh = new THREE.Mesh(new THREE.BufferGeometry(), matScarf);
  fringeMesh.frustumCulled = false;
  fringeMesh.name = 'ScarfFringe';
  torsoInner.add(fringeMesh);
  scarf.fringe = fringeMesh;
  const strandMesh = new THREE.Mesh(new THREE.BufferGeometry(), matFeather);
  strandMesh.frustumCulled = false;
  strandMesh.name = 'ScarfStrands';
  torsoInner.add(strandMesh);
  scarf.strand = strandMesh;

  function buildScarf(cols, rows) {
    const count = cols * rows;
    const pos = new Float32Array(count * 3);
    const prev = new Float32Array(count * 3);
    const restH = SCARF.width / Math.max(1, cols - 1);
    const restV = SCARF.length / Math.max(1, rows - 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i3 = (r * cols + c) * 3;
        const x = -SCARF.width * 0.5 + c * restH;
        const edge = Math.abs(x) / (SCARF.width * 0.5 || 1);
        pos[i3] = x;
        pos[i3 + 1] = SCARF.anchorY - edge * edge * 0.004 - r * restV * 0.99;
        pos[i3 + 2] = SCARF.anchorZ - edge * edge * 0.03 + r * restV * 0.02;
        prev[i3] = pos[i3];
        prev[i3 + 1] = pos[i3 + 1];
        prev[i3 + 2] = pos[i3 + 2];
      }
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const nrmAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    nrmAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('normal', nrmAttr);
    const uv = new Float32Array(count * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i2 = (r * cols + c) * 2;
        uv[i2] = cols > 1 ? c / (cols - 1) : 0.5;
        uv[i2 + 1] = rows > 1 ? r / (rows - 1) : 0;
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const cc = a + cols;
        const d = cc + 1;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    geo.setIndex(idx);
    scarfMesh.geometry.dispose();
    scarfMesh.geometry = geo;

    // 燕尾流苏片：每列 1 条宽三角（正反两面）
    const fCount = cols * 6;
    const fPos = new Float32Array(fCount * 3);
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3).setUsage(THREE.DynamicDrawUsage));
    fGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(fCount * 3), 3));
    fringeMesh.geometry.dispose();
    fringeMesh.geometry = fGeo;

    // 细流苏条（奶白）：cols-1 根
    const sCount = (cols - 1) * 6;
    const sPos = new Float32Array(sCount * 3);
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(sCount * 3), 3));
    strandMesh.geometry.dispose();
    strandMesh.geometry = sGeo;

    scarf.cols = cols;
    scarf.rows = rows;
    scarf.count = count;
    scarf.pos = pos;
    scarf.prev = prev;
    scarf.restH = restH;
    scarf.restV = restV;
    scarf.restD = Math.sqrt(restH * restH + restV * restV);
    scarf.fringePos = fPos;
    scarf.fringeCount = fCount;
    scarf.strandPos = sPos;
    scarf.strandCount = sCount;
    handle.scarfVertexCount = count;
  }

  // ---- 布料物理
  function pinTopRow() {
    const cols = scarf.cols;
    const pos = scarf.pos;
    const half = SCARF.width * 0.5;
    for (let c = 0; c < cols; c++) {
      const i3 = c * 3;
      const x = -half + (SCARF.width * c) / Math.max(1, cols - 1);
      const edge = Math.abs(x) / (half || 1);
      pos[i3] = x;
      pos[i3 + 1] = SCARF.anchorY - edge * edge * 0.004;
      pos[i3 + 2] = SCARF.anchorZ - edge * edge * 0.03;
    }
  }

  function linkPair(a, b, rest) {
    const pos = scarf.pos;
    const cols = scarf.cols;
    const a3 = a * 3;
    const b3 = b * 3;
    const aPin = a < cols;
    const bPin = b < cols;
    if (aPin && bPin) return;
    const dx = pos[b3] - pos[a3];
    const dy = pos[b3 + 1] - pos[a3 + 1];
    const dz = pos[b3 + 2] - pos[a3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-12) return;
    const dist = Math.sqrt(d2);
    const diff = (dist - rest) / dist;
    if (aPin) {
      pos[b3] -= dx * diff;
      pos[b3 + 1] -= dy * diff;
      pos[b3 + 2] -= dz * diff;
    } else if (bPin) {
      pos[a3] += dx * diff;
      pos[a3 + 1] += dy * diff;
      pos[a3 + 2] += dz * diff;
    } else {
      const h = diff * 0.5;
      pos[a3] += dx * h;
      pos[a3 + 1] += dy * h;
      pos[a3 + 2] += dz * h;
      pos[b3] -= dx * h;
      pos[b3 + 1] -= dy * h;
      pos[b3 + 2] -= dz * h;
    }
  }

  function resolveSphere(i3, cx, cy, cz, r) {
    const pos = scarf.pos;
    const dx = pos[i3] - cx;
    const dy = pos[i3 + 1] - cy;
    const dz = pos[i3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r * r || d2 < 1e-12) return;
    const k = r / Math.sqrt(d2);
    pos[i3] = cx + dx * k;
    pos[i3 + 1] = cy + dy * k;
    pos[i3 + 2] = cz + dz * k;
  }

  function resolveEllipsoid(i3, cx, cy, cz, rx, ry, rz) {
    const pos = scarf.pos;
    const dx = (pos[i3] - cx) / rx;
    const dy = (pos[i3 + 1] - cy) / ry;
    const dz = (pos[i3 + 2] - cz) / rz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= 1 || d2 < 1e-12) return;
    const k = 1 / Math.sqrt(d2);
    pos[i3] = cx + dx * k * rx;
    pos[i3 + 1] = cy + dy * k * ry;
    pos[i3 + 2] = cz + dz * k * rz;
  }

  function collideScarf() {
    const pos = scarf.pos;
    const cols = scarf.cols;
    const count = scarf.count;
    const m = SCARF.collideMargin;
    for (let i = cols; i < count; i++) {
      const i3 = i * 3;
      if (pos[i3 + 1] < 0.03) pos[i3 + 1] = 0.03;
      resolveEllipsoid(i3, 0, 1.075, 0.06, 0.315 + m, 0.345 + m, 0.375 + m);
      resolveSphere(i3, 0, 1.73, -0.09, 0.28 + m);
      resolveSphere(i3, 0, 0.95, 0.30, 0.23 + m);
    }
  }

  function isFiniteScarf() {
    const p = scarf.pos;
    if (!p) return false;
    const n = scarf.count;
    for (let k = 0; k < 5; k++) {
      const i = ((k * 41) % n) * 3;
      if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2])) return false;
    }
    const last = (n - 1) * 3;
    return Number.isFinite(p[last]) && Number.isFinite(p[last + 1]) && Number.isFinite(p[last + 2]);
  }

  function stepScarf(h, t, speedRatio, lean, cadence, airLift, accel) {
    const pos = scarf.pos;
    const prev = scarf.prev;
    const cols = scarf.cols;
    const rows = scarf.rows;
    const count = scarf.count;
    if (!pos) return;
    const restH = scarf.restH;
    const restV = scarf.restV;
    const restD = scarf.restD;
    const windZ = SCARF.windBase + speedRatio * SCARF.windSpeed + clamp(accel, -8, 12) * 0.22;
    const windY = SCARF.liftBase + speedRatio * SCARF.liftSpeed + airLift + cadence * 0.6;
    const windX = -lean * (4.0 + speedRatio * 12.0) + Math.sin(t * 1.9) * 1.1;
    const turb = SCARF.turbBase + speedRatio * SCARF.turbSpeed;
    const h2 = h * h;
    const dampK = SCARF.damp;
    for (let i = cols; i < count; i++) {
      const i3 = i * 3;
      const c = i % cols;
      const r = (i / cols) | 0;
      const rowK = 0.55 + (0.45 * r) / (rows - 1);
      const ph = t * 7.2 + r * 0.55 + c * 0.8;
      const waveA = (3.2 + speedRatio * 8.5) * rowK;
      const wave1 = Math.sin(t * 10.5 - r * 0.72 + c * 0.42);
      const wave2 = Math.cos(t * 7.6 - r * 0.55 + c * 0.22);
      const ax = windX + Math.sin(ph * 1.7 + 1.1) * turb + wave1 * waveA * 0.9;
      const ay = -SCARF.gravity + windY + Math.cos(ph * 2.1) * turb * 0.8 + wave2 * waveA * 0.75;
      const az = windZ + Math.sin(ph * 1.3 + 2.2) * turb * 0.65 + wave1 * waveA * 0.35;
      const vx = (pos[i3] - prev[i3]) * dampK;
      const vy = (pos[i3 + 1] - prev[i3 + 1]) * dampK;
      const vz = (pos[i3 + 2] - prev[i3 + 2]) * dampK;
      prev[i3] = pos[i3];
      prev[i3 + 1] = pos[i3 + 1];
      prev[i3 + 2] = pos[i3 + 2];
      pos[i3] += vx + ax * h2 * rowK;
      pos[i3 + 1] += vy + ay * h2 * rowK;
      pos[i3 + 2] += vz + az * h2 * rowK;
    }
    pinTopRow();
    const iters = SCARF.iterations;
    for (let it = 0; it < iters; it++) {
      for (let r = 0; r < rows; r++) {
        const base = r * cols;
        for (let c = 0; c < cols - 1; c++) linkPair(base + c, base + c + 1, restH);
      }
      for (let r = 0; r < rows - 1; r++) {
        const base = r * cols;
        for (let c = 0; c < cols; c++) linkPair(base + c, base + c + cols, restV);
      }
      for (let r = 0; r < rows - 1; r++) {
        const base = r * cols;
        for (let c = 0; c < cols - 1; c++) {
          linkPair(base + c, base + c + cols + 1, restD);
          linkPair(base + c + 1, base + c + cols, restD);
        }
      }
      if (it === 0) {
        const restV2 = restV * 2;
        const restH2 = restH * 2;
        for (let r = 0; r < rows - 2; r++) {
          const base = r * cols;
          for (let c = 0; c < cols; c++) linkPair(base + c, base + c + cols * 2, restV2);
        }
        for (let r = 0; r < rows; r++) {
          const base = r * cols;
          for (let c = 0; c < cols - 2; c++) linkPair(base + c, base + c + 2, restH2);
        }
        collideScarf();
      }
    }
    collideScarf();
    pinTopRow();
    if (!isFiniteScarf()) resetScarf();
  }

  function resetScarf() {
    const pos = scarf.pos;
    const prev = scarf.prev;
    const cols = scarf.cols;
    const rows = scarf.rows;
    if (!pos) return;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i3 = (r * cols + c) * 3;
        const x = -SCARF.width * 0.5 + (SCARF.width * c) / Math.max(1, cols - 1);
        const edge = Math.abs(x) / (SCARF.width * 0.5 || 1);
        pos[i3] = x;
        pos[i3 + 1] = SCARF.anchorY - edge * edge * 0.004 - r * scarf.restV * 0.99;
        pos[i3 + 2] = SCARF.anchorZ - edge * edge * 0.03 + r * scarf.restV * 0.03;
        prev[i3] = pos[i3];
        prev[i3 + 1] = pos[i3 + 1];
        prev[i3 + 2] = pos[i3 + 2];
      }
    }
  }

  function updateScarfGeometry(t) {
    const pos = scarf.pos;
    const cols = scarf.cols;
    const rows = scarf.rows;
    const geo = scarfMesh.geometry;
    const nrm = geo.attributes.normal.array;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i3 = (r * cols + c) * 3;
        const cL = c > 0 ? i3 - 3 : i3;
        const cR = c < cols - 1 ? i3 + 3 : i3;
        const rU = r > 0 ? i3 - cols * 3 : i3;
        const rD = r < rows - 1 ? i3 + cols * 3 : i3;
        const ux = pos[cR] - pos[cL];
        const uy = pos[cR + 1] - pos[cL + 1];
        const uz = pos[cR + 2] - pos[cL + 2];
        const vx = pos[rD] - pos[rU];
        const vy = pos[rD + 1] - pos[rU + 1];
        const vz = pos[rD + 2] - pos[rU + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-8) {
          nx /= len;
          ny /= len;
          nz /= len;
        } else {
          nx = 0;
          ny = 0;
          nz = 1;
        }
        nrm[i3] = nx;
        nrm[i3 + 1] = ny;
        nrm[i3 + 2] = nz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;

    // 燕尾流苏：宽片（红布）+ 细条（奶白）
    const fPos = scarf.fringePos;
    const sPos = scarf.strandPos;
    if (!fPos) return;
    const lastRow = (rows - 1) * cols;
    const dropPattern = [0.07, 0.11, 0.16, 0.1, 0.05, 0.1, 0.16, 0.11, 0.07, 0.1, 0.15];
    for (let c = 0; c < cols; c++) {
      const i3 = (lastRow + c) * 3;
      const up3 = (lastRow - cols + c) * 3;
      let dx = pos[i3] - pos[up3];
      let dy = pos[i3 + 1] - pos[up3 + 1];
      let dz = pos[i3 + 2] - pos[up3 + 2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const flutter = Math.sin(t * 15 + c * 1.3) * 0.018;
      const dropL = dropPattern[c % dropPattern.length];
      const tipX = pos[i3] + dx * dropL + flutter;
      const tipY = pos[i3 + 1] + dy * dropL;
      const tipZ = pos[i3 + 2] + dz * dropL + flutter * 0.5;
      const sx = 0.0105;
      const o = c * 18;
      fPos[o] = pos[i3] - sx;
      fPos[o + 1] = pos[i3 + 1];
      fPos[o + 2] = pos[i3 + 2];
      fPos[o + 3] = pos[i3] + sx;
      fPos[o + 4] = pos[i3 + 1];
      fPos[o + 5] = pos[i3 + 2];
      fPos[o + 6] = tipX;
      fPos[o + 7] = tipY;
      fPos[o + 8] = tipZ;
      fPos[o + 9] = tipX;
      fPos[o + 10] = tipY;
      fPos[o + 11] = tipZ;
      fPos[o + 12] = pos[i3] + sx;
      fPos[o + 13] = pos[i3 + 1];
      fPos[o + 14] = pos[i3 + 2];
      fPos[o + 15] = pos[i3] - sx;
      fPos[o + 16] = pos[i3 + 1];
      fPos[o + 17] = pos[i3 + 2];
    }
    for (let c = 0; c < cols - 1; c++) {
      const i3 = (lastRow + c) * 3;
      const i3b = (lastRow + c + 1) * 3;
      const up3 = (lastRow - cols + c) * 3;
      let dx = (pos[i3] + pos[i3b]) * 0.5 - pos[up3];
      let dy = (pos[i3 + 1] + pos[i3b + 1]) * 0.5 - pos[up3 + 1];
      let dz = (pos[i3 + 2] + pos[i3b + 2]) * 0.5 - pos[up3 + 2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const len = 0.055 + 0.03 * Math.sin(c * 1.7 + t * 9);
      const o = c * 18;
      const mx = (pos[i3] + pos[i3b]) * 0.5;
      const my = (pos[i3 + 1] + pos[i3b + 1]) * 0.5;
      const mz = (pos[i3 + 2] + pos[i3b + 2]) * 0.5;
      sPos[o] = mx - 0.0016;
      sPos[o + 1] = my;
      sPos[o + 2] = mz;
      sPos[o + 3] = mx + dx * len;
      sPos[o + 4] = my + dy * len;
      sPos[o + 5] = mz + dz * len;
      sPos[o + 6] = mx + 0.0016;
      sPos[o + 7] = my;
      sPos[o + 8] = mz;
      sPos[o + 9] = mx + 0.0016;
      sPos[o + 10] = my;
      sPos[o + 11] = mz;
      sPos[o + 12] = mx + dx * len;
      sPos[o + 13] = my + dy * len;
      sPos[o + 14] = mz + dz * len;
      sPos[o + 15] = mx - 0.0016;
      sPos[o + 16] = my;
      sPos[o + 17] = mz;
    }
    fringeMesh.geometry.attributes.position.needsUpdate = true;
    strandMesh.geometry.attributes.position.needsUpdate = true;
  }

  // ================================================================
  // 车筐里的鱼
  // ================================================================
  const FISH_SLOTS = [
    [0.070, 0.825, -0.665, 0.35],
    [-0.070, 0.825, -0.782, -0.5],
    [0.070, 0.825, -0.782, 2.4],
    [-0.070, 0.825, -0.665, -2.2],
    [0.0, 0.94, -0.725, 0.9],
  ];
  const fishGeo = (() => {
    const parts = [];
    parts.push(gTRS(sphGeo(0.5, 10, 8), 0.19, 0.115, 0.32, 0, 0, 0, 0, 0, 0));
    parts.push(gTRS(coneGeo(0.16, 0.24, 5), 0.55, 1, 0.4, Math.PI / 2, 0, 0, 0, 0, 0.34));
    parts.push(gTRS(coneGeo(0.105, 0.19, 5), 0.4, 1, 0.35, Math.PI / 2, 0, 0, 0, 0.15, 0.06));
    return mergeGeos(parts);
  })();
  disposables.push(fishGeo);
  const fishes = [];
  for (let i = 0; i < 5; i++) {
    const mesh = new THREE.Mesh(fishGeo, matBeak);
    mesh.visible = false;
    bike.add(mesh);
    const slot = FISH_SLOTS[i];
    fishes.push({
      mesh, mode: 0, t: 0, dur: 0.55,
      from: new THREE.Vector3(), ctrl: new THREE.Vector3(),
      to: new THREE.Vector3(slot[0], slot[1], slot[2]),
      yaw: slot[3], landT: 0, spin: 0,
    });
  }
  let fishCursor = 0;

  // ================================================================
  // 动画状态
  // ================================================================
  let time = 0;
  let wheelAngle = 0;
  let crankAngle = 0;
  let prevSpeed = 0;
  let leanS = 0;
  let wheelieS = 0;
  let wingsS = 0;
  let airS = 0;
  let prevAirborne = false;
  let airPeak = 0;
  let landY = 0;
  let landV = 0;
  let catchPulse = 0;
  let qualityLevel = 0;
  let physAccum = 0;
  const EMPTY_STATE = {};

  function finite(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  }

  function placeLimb(mesh, ax, ay, az, bx, by, bz) {
    mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _v1.set(bx - ax, by - ay, bz - az).normalize();
    mesh.quaternion.setFromUnitVectors(UP, _v1);
  }

  // ---- 翅手 IK：每帧把两只手钉在把套上（把套位置经世界矩阵换算到 torsoInner 局部）
  function updateArms() {
    bike.updateWorldMatrix(true, false);
    torsoInner.updateWorldMatrix(true, false);
    _m1.extractRotation(torsoInner.matrixWorld);
    _q1.setFromRotationMatrix(_m1).invert(); // 世界 → torsoInner 局部旋转
    // 把套轴方向（bike 局部 +X）→ torsoInner 局部
    _v3.set(1, 0, 0).transformDirection(bike.matrixWorld).applyQuaternion(_q1);
    for (let ai = 0; ai < arms.length; ai++) {
      const arm = arms[ai];
      const sign = arm.sign;
      // 1) 手目标 = 把套中心
      _v1.set(sign * GRIP_X, GRIP_Y, GRIP_Z);
      bike.localToWorld(_v1);
      torsoInner.worldToLocal(_v1);
      const tx = _v1.x;
      const ty = _v1.y;
      const tz = _v1.z;
      // 2) 肩点
      const sx = sign * SHOULDER_X;
      const sy = SHOULDER_Y;
      const sz = SHOULDER_Z;
      const dx = tx - sx;
      const dy = ty - sy;
      const dz = tz - sz;
      const rawD = Math.hypot(dx, dy, dz) || 1e-4;
      const maxD = (ARM_L1 + ARM_L2) * 0.995;
      const minD = Math.abs(ARM_L1 - ARM_L2) + 0.04;
      let d = rawD;
      if (d > maxD) d = maxD;
      else if (d < minD) d = minD;
      const nx = dx / rawD;
      const ny = dy / rawD;
      const nz = dz / rawD;
      // 3) 余弦定理 + 外向 pole（带一点点呼吸/踏频弹性）
      const cosA = clamp((ARM_L1 * ARM_L1 + d * d - ARM_L2 * ARM_L2) / (2 * ARM_L1 * d), -1, 1);
      const aa = ARM_L1 * cosA;
      const hh = ARM_L1 * Math.sqrt(Math.max(0, 1 - cosA * cosA));
      let px = sign * (0.55 + Math.sin(time * 2.1 + sign * 1.7) * 0.05);
      let py = -0.84 + Math.sin(time * 3.3 + sign) * 0.04;
      let pz = 0.12;
      const pd = px * nx + py * ny + pz * nz;
      px -= nx * pd;
      py -= ny * pd;
      pz -= nz * pd;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl;
      py /= pl;
      pz /= pl;
      const ex2 = sx + nx * aa + px * hh;
      const ey2 = sy + ny * aa + py * hh;
      const ez2 = sz + nz * aa + pz * hh;
      // 4) 上臂 / 前臂朝向
      arm.upperArm.position.set(sx, sy, sz);
      _v1.set(ex2 - sx, ey2 - sy, ez2 - sz).normalize();
      arm.upperArm.quaternion.setFromUnitVectors(UP, _v1);
      arm.foreGroup.position.set(ex2, ey2, ez2);
      _v1.set(tx - ex2, ty - ey2, tz - ez2).normalize();
      arm.foreGroup.quaternion.setFromUnitVectors(UP, _v1);
      // 5) 手：位置严格在把套上，朝向随把套轴 + 上方向
      arm.hand.position.set(tx, ty, tz);
      let ax = _v3.x;
      let ay = _v3.y;
      let az = _v3.z;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      if (ax * sign < 0) {
        ax = -ax;
        ay = -ay;
        az = -az;
      }
      _v2.set(0, 1, 0).applyQuaternion(_q1);
      const ud = ax * _v2.x + ay * _v2.y + az * _v2.z;
      let ux = _v2.x - ax * ud;
      let uy = _v2.y - ay * ud;
      let uz = _v2.z - az * ud;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const zx2 = ay * uz - az * uy;
      const zy2 = az * ux - ax * uz;
      const zz2 = ax * uy - ay * ux;
      _v4.set(ax, ay, az);
      _v5.set(ux, uy, uz);
      _v2.set(zx2, zy2, zz2);
      _m1.makeBasis(_v4, _v5, _v2);
      _q2.setFromRotationMatrix(_m1);
      arm.hand.quaternion.copy(_q2);
      arm.hand.rotateX(1.05); // 掌心转向身体一侧，指节包住把套前侧
    }
  }

  function updatePosture(dt, st) {
    const speed = clamp(finite(st.speed, 0), 0, 40);
    const speedRatio = clamp01(finite(st.speedRatio, speed / 34));
    const cadence = clamp(finite(st.cadence, 0.12), 0, 2);
    const leanT = clamp(finite(st.lean, 0), -1, 1);
    const wheelieT = clamp01(finite(st.wheelie, 0));
    const wingsT = clamp01(finite(st.wingsOut, 0));
    const airborne = !!st.airborne;
    const night = clamp01(finite(st.night, 0));

    leanS = damp(leanS, leanT, 10, dt);
    wheelieS = damp(wheelieS, wheelieT, 8, dt);
    wingsS = damp(wingsS, wingsT, 7, dt);
    airS = damp(airS, airborne ? 1 : 0, 9, dt);

    // 车轮 / 曲柄
    wheelAngle -= (speed / WHEEL_R) * dt;
    if (wheelAngle < -1000) wheelAngle += 1000;
    if (wheelAngle > 1000) wheelAngle -= 1000;
    frontWheel.spin.rotation.x = wheelAngle;
    rearWheel.spin.rotation.x = wheelAngle;
    const groundFactor = airborne ? 0.12 : 1;
    crankAngle += (0.9 + cadence * 7.2) * dt * groundFactor;
    if (crankAngle > TAU) crankAngle -= TAU;
    if (crankAngle < 0) crankAngle += TAU;
    crankR.rotation.x = crankAngle;
    crankL.rotation.x = crankAngle + Math.PI;

    // 车体倾斜 / 抬轮
    leanPivot.rotation.z = -leanS * 0.33;
    wheeliePivot.rotation.x = wheelieS * 0.42;

    // 落地缓冲
    if (airborne) airPeak = Math.max(airPeak, finite(st.jumpY, 0));
    if (prevAirborne && !airborne) {
      const impact = clamp(0.35 + airPeak * 0.9, 0.3, 1.5);
      landV = -impact * 1.55;
      catchPulse = Math.min(1.4, catchPulse + 0.25);
      airPeak = 0;
    }
    if (airborne) {
      landY = damp(landY, clamp(finite(st.jumpY, 0) * 0.05, 0, 0.08), 14, dt);
      landV = 0;
    } else {
      landV += (-70 * landY - 12 * landV) * dt;
      landY += landV * dt;
      landY = clamp(landY, -0.085, 0.055);
    }
    prevAirborne = airborne;

    const bob = Math.sin(crankAngle * 2) * 0.016 * clamp01(cadence / 1.4);
    const breathe = Math.sin(time * 1.7) * 0.006;
    rider.position.y = landY * 0.18;
    rider.position.x = Math.sin(crankAngle) * 0.008 * clamp01(cadence * 0.8);
    torso.position.y = HIP_Y + landY * 0.62 + bob + breathe * (1 - 0.5 * speedRatio);
    torso.position.x = Math.sin(crankAngle) * 0.014 * clamp01(cadence * 0.8);
    torso.position.z = HIP_Z;
    torso.rotation.z = -leanS * 0.15 + Math.sin(crankAngle) * 0.02 * cadence;
    torso.rotation.x = -0.10 + wheelieS * 0.17 + airS * 0.06 + landY * 0.55 - speedRatio * 0.02;
    torso.rotation.y = leanS * 0.07;

    // 头
    headGroup.rotation.x =
      0.05 + Math.sin(crankAngle * 2 + 0.8) * 0.026 * cadence - wheelieS * 0.07 +
      airS * -0.12 + landY * 0.9 + catchPulse * 0.06;
    headGroup.rotation.z = leanS * 0.18 + Math.sin(time * 0.8) * 0.012;
    headGroup.rotation.y = -leanS * 0.14 + Math.sin(time * 0.37) * 0.10 * (1 - speedRatio) * (airborne ? 0.2 : 1);

    // 翅膀：收拢（贴身翼壳，羽片下垂叠起）→ 展开（4 层扇形飞羽）
    const spread = clamp01(wingsS + airS * 0.82 + catchPulse * 0.28);
    const easy = smoothstep(0, 1, spread);
    const flap = Math.sin(time * 9.5) * 0.4 * spread;
    for (let w = 0; w < 2; w++) {
      const wing = wings[w];
      const sign = wing.sign;
      const ry = lerp(-1.18, 0.10, easy);
      const rz = lerp(0.05, 0.55 + flap, easy);
      const rx = lerp(0.52, 0.0, easy) + Math.sin(time * 9.5 + 0.6) * 0.14 * spread;
      wing.root.rotation.x = rx;
      wing.root.rotation.y = sign * ry;
      wing.root.rotation.z = sign * rz;
      const spanScale = lerp(0.72, 1.0, easy);
      wing.root.scale.set(spanScale, 1, 1);
      for (let i = 0; i < wing.feathers.length; i++) {
        const f = wing.feathers[i];
        const fc = i - (wing.feathers.length - 1) * 0.5;
        const fanY = lerp(fc * 0.02, fc * 0.09, easy);
        const fanZ = lerp(-0.05 - i * 0.02, fc * 0.045, easy);
        f.pivot.rotation.y = sign * (fanY + Math.sin(time * 9.5 + i * 0.5) * 0.02 * spread);
        f.pivot.rotation.z = sign * (fanZ + flap * 0.05 * (i / 3));
        const twist = lerp(1.22, 0, easy) + Math.sin(time * 9.5 + 0.4) * 0.14 * spread;
        f.twist.rotation.x = twist;
      }
    }

    // 尾羽
    tailPivot.rotation.x = Math.sin(time * 2.1) * 0.03 + cadence * 0.02 + spread * 0.06;
    tailPivot.rotation.y = leanS * 0.12;

    // 脚踏
    const cC = Math.cos(crankAngle);
    const sC = Math.sin(crankAngle);
    const px = 0.118;
    const prX = px;
    const prY = BB_Y + CRANK_R * cC;
    const prZ = BB_Z + CRANK_R * sC;
    const plX = -px;
    const plY = BB_Y - CRANK_R * cC;
    const plZ = BB_Z - CRANK_R * sC;
    pedalR.position.set(prX, prY, prZ);
    pedalL.position.set(plX, plY, plZ);

    // 腿 IK
    const tuck = airS;
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      const s = leg.sign;
      const pedalX = (s > 0 ? prX : plX) * BIKE_SCALE;
      const pedalY = (s > 0 ? prY : plY) * BIKE_SCALE;
      const pedalZ = (s > 0 ? prZ : plZ) * BIKE_SCALE;
      const ankleX = pedalX + s * 0.006;
      const ankleY = pedalY + 0.042;
      const ankleZ = pedalZ + 0.012;
      const tuckX = s * 0.16;
      const tuckY = 0.60;
      const tuckZ = 0.26;
      const fx = lerp(ankleX, tuckX, tuck);
      const fy = lerp(ankleY, tuckY, tuck);
      const fz = lerp(ankleZ, tuckZ, tuck);
      const hx = s * HIP_X;
      const hy = HIP_Y;
      const hz = HIP_Z;
      let dx = fx - hx;
      let dy = fy - hy;
      let dz = fz - hz;
      let dist = Math.hypot(dx, dy, dz);
      const maxD = (THIGH_L + SHIN_L) * 0.995;
      const minD = Math.abs(THIGH_L - SHIN_L) + 0.02;
      if (dist > maxD) {
        const k = maxD / dist;
        dx *= k;
        dy *= k;
        dz *= k;
        dist = maxD;
      } else if (dist < minD) {
        const k = minD / (dist || 1e-4);
        dx *= k;
        dy *= k;
        dz *= k;
        dist = minD;
      }
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const a = (THIGH_L * THIGH_L - SHIN_L * SHIN_L + dist * dist) / (2 * dist);
      const hh = Math.sqrt(Math.max(0, THIGH_L * THIGH_L - a * a));
      let bx = 0;
      let by = -0.22;
      let bz = -1;
      const dot = bx * nx + by * ny + bz * nz;
      bx -= nx * dot;
      by -= ny * dot;
      bz -= nz * dot;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;
      const kx = hx + nx * a + bx * hh;
      const ky = hy + ny * a + by * hh;
      const kz = hz + nz * a + bz * hh;
      const ex = hx + dx;
      const ey = hy + dy;
      const ez = hz + dz;
      placeLimb(leg.thigh, hx, hy, hz, kx, ky, kz);
      placeLimb(leg.shin, kx, ky, kz, ex, ey, ez);
      leg.foot.position.set(ex, ey - 0.028, ez);
      leg.foot.rotation.set(0.05 + Math.sin(crankAngle + (s > 0 ? 0 : Math.PI)) * 0.1, s * 0.06, 0);
    }

    // 翅手：把手目标每帧解算（lean / wheelie / 跳跃 / 展翅时手始终在把上）
    updateArms();

    // 喉囊 / 抓鱼反馈
    if (catchPulse > 0) catchPulse = Math.max(0, catchPulse - dt * 2.4);
    const pouchWiggle = Math.sin(time * 5.5) * 0.008 + Math.sin(crankAngle * 2) * 0.007 * cadence + speedRatio * 0.004;
    pouch.scale.set(
      0.104 + pouchWiggle + catchPulse * 0.030,
      0.090 + pouchWiggle * 0.6 + catchPulse * 0.055,
      0.282 + pouchWiggle * 0.4 + catchPulse * 0.02
    );
    pouch.rotation.x = -0.07 + Math.sin(time * 4.2) * 0.02 + catchPulse * 0.05 + speedRatio * 0.03;
    pouch.rotation.z = Math.sin(time * 3.1) * 0.015 + leanS * 0.02;

    // 夜间灯光（温和）
    matLamp.emissiveIntensity = 0.20 + night * 0.60;
    lampLight.intensity = night * 1.0;
    matGlasses.emissiveIntensity = 0.38 + night * 0.22;
    matHelmet.emissiveIntensity = night * 0.08;

    // 围巾布料物理
    const t = finite(st.time, time);
    const accel = (speed - prevSpeed) / Math.max(dt, 1e-3);
    prevSpeed = speed;
    const substep = 1 / 60;
    physAccum += dt;
    let steps = 0;
    while (physAccum >= substep && steps < 3) {
      physAccum -= substep;
      stepScarf(substep, t, speedRatio, leanS, cadence, airS * 5.0, accel);
      steps++;
    }
    if (steps === 0) pinTopRow();
    if (physAccum > substep * 3) physAccum = 0;
    updateScarfGeometry(t);

    updateFish(dt);
  }

  function updateFish(dt) {
    for (let i = 0; i < fishes.length; i++) {
      const f = fishes[i];
      if (f.mode === 0) continue;
      if (f.mode === 1) {
        f.t += dt / f.dur;
        if (f.t >= 1) {
          f.t = 1;
          f.mode = 2;
          f.landT = 0;
          f.mesh.position.copy(f.to);
          f.mesh.rotation.set(0.1, f.yaw, 0.15);
          f.mesh.scale.set(1, 1, 1);
        } else {
          const u = f.t;
          const iu = 1 - u;
          const b0 = iu * iu;
          const b1 = 2 * iu * u;
          const b2 = u * u;
          f.mesh.position.set(
            b0 * f.from.x + b1 * f.ctrl.x + b2 * f.to.x,
            b0 * f.from.y + b1 * f.ctrl.y + b2 * f.to.y,
            b0 * f.from.z + b1 * f.ctrl.z + b2 * f.to.z
          );
          f.spin += dt * 13;
          f.mesh.rotation.set(f.spin, f.yaw + f.spin * 0.5, Math.sin(f.spin) * 0.3);
        }
      }
      if (f.mode === 2) {
        f.landT += dt;
        const decay = Math.exp(-f.landT * 7);
        const squash = Math.sin(f.landT * 20) * 0.28 * decay;
        f.mesh.scale.set(1 + squash * 0.35, 1 - squash, 1 + squash * 0.35);
        if (f.landT > 1.4) {
          f.mesh.scale.set(1, 1, 1);
          f.mode = 3;
        }
      }
    }
  }

  // ================================================================
  // 相机锚点
  // ================================================================
  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.position.set(0, 0.20, -0.40);
  headGroup.add(eyeAnchor);
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.21, -0.10);
  headGroup.add(headAnchor);
  const chestAnchor = new THREE.Object3D();
  chestAnchor.position.set(0, 1.10, -0.02);
  torsoInner.add(chestAnchor);

  // ================================================================
  // 公共句柄
  // ================================================================
  const handle = {
    group,
    scarfVertexCount: 0,
    update(dt, state) {
      updatePosture(clamp(finite(dt, 1 / 60), 0.0001, 0.05), state || EMPTY_STATE);
    },
    getEyeWorldPosition(out) {
      const o = out || _v1;
      eyeAnchor.getWorldPosition(o);
      return o;
    },
    getHeadWorldPosition(out) {
      const o = out || _v2;
      headAnchor.getWorldPosition(o);
      return o;
    },
    getChestWorldPosition(out) {
      const o = out || _v3;
      chestAnchor.getWorldPosition(o);
      return o;
    },
    catchFish() {
      const f = fishes[fishCursor % fishes.length];
      fishCursor++;
      const side = rng() < 0.5 ? -1 : 1;
      f.from.set(side * (0.55 + rng() * 0.55), 0.52 + rng() * 0.3, -0.85 - rng() * 0.45);
      f.ctrl.set((f.from.x + f.to.x) * 0.5, Math.max(f.from.y, f.to.y) + 0.42, (f.from.z + f.to.z) * 0.5);
      f.t = 0;
      f.mode = 1;
      f.spin = 0;
      f.mesh.visible = true;
      f.mesh.position.copy(f.from);
      f.mesh.scale.set(1, 1, 1);
      catchPulse = 1.25;
    },
    setQuality(level) {
      try {
        const lv = clamp((level | 0) || 0, 0, 2);
        if (lv === qualityLevel) return;
        qualityLevel = lv;
        if (lv === 0) {
          SCARF.iterations = 4;
          buildScarf(9, 24);
          frontWheel.spokes.count = 12;
          rearWheel.spokes.count = 12;
        } else if (lv === 1) {
          SCARF.iterations = 2;
          buildScarf(8, 18);
          frontWheel.spokes.count = 10;
          rearWheel.spokes.count = 10;
        } else {
          SCARF.iterations = 2;
          buildScarf(6, 14);
          frontWheel.spokes.count = 8;
          rearWheel.spokes.count = 8;
        }
        physAccum = 0;
      } catch (e) {
        /* 降级失败不中断游戏 */
      }
    },
    reset() {
      try {
        wheelAngle = 0;
        crankAngle = 0;
        prevSpeed = 0;
        leanS = 0;
        wheelieS = 0;
        wingsS = 0;
        airS = 0;
        prevAirborne = false;
        airPeak = 0;
        landY = 0;
        landV = 0;
        catchPulse = 0;
        physAccum = 0;
        resetScarf();
        for (let i = 0; i < fishes.length; i++) {
          fishes[i].mode = 0;
          fishes[i].mesh.visible = false;
          fishes[i].mesh.scale.set(1, 1, 1);
        }
        fishCursor = 0;
        updateScarfGeometry(0);
      } catch (e) {
        /* ignore */
      }
    },
    dispose() {
      try {
        if (scene && scene.remove) scene.remove(group);
        for (let i = 0; i < disposables.length; i++) {
          const d = disposables[i];
          if (d && d.dispose) d.dispose();
        }
      } catch (e) {
        /* ignore */
      }
    },
  };

  // ---- 初始化围巾
  buildScarf(9, 24);
  for (let i = 0; i < 60; i++) stepScarf(1 / 60, 0, 0.12, 0, 0.2, 0, 0);
  updateScarfGeometry(0);

  if (scene && scene.add) scene.add(group);
  return handle;
}
