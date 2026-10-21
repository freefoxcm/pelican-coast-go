// Shared math / utility helpers (Lead-owned). No THREE-specific deps.
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a || 1e-6));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const mix = lerp;
// frame-rate independent exponential damping
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export const wrap = (v, n) => ((v % n) + n) % n;
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

// deterministic RNG (mulberry32)
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randRange = (rng, a, b) => a + (b - a) * rng();
export const randInt = (rng, a, b) => Math.floor(a + (b - a + 1) * rng());
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

// cheap value noise 1D
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => {
    let s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
}

// Recycle a repeating object group along -Z. Returns world z for period `period`,
// such that it is always in front of the bike (bikeZ - ahead .. bikeZ + behind).
export function railZ(bikeZ, period, offset = 0, ahead = 320, behind = 40) {
  // object k sits at k*period + offset; we want the nearest instance ahead of bikeZ
  const k = Math.floor((bikeZ - offset) / period);
  let z = k * period + offset;
  if (z > bikeZ + behind) z -= period;
  while (z < bikeZ - ahead) z += period;
  return z;
}
