// Raster helpers: contour tracing, text outlines, image cache, dithering.
import { simplify, polyArea } from './geom.js';

export const MAX_CANVAS_DIM = 16000;
export const MAX_CANVAS_AREA = 120e6;

export function makeCanvas(w, h) {
  if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM || w * h > MAX_CANVAS_AREA) {
    throw new Error(`Raster too large (${w}×${h} px). Use a larger line interval or a smaller area.`);
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
}

// ---------------------------------------------------------------- marching squares
// mask: Uint8Array (1 = inside), w×h. Returns closed loops in pixel coordinates.
const SEGS = [
  [], [['L', 'B']], [['B', 'R']], [['L', 'R']], [['T', 'R']], [['T', 'R'], ['L', 'B']], [['T', 'B']], [['T', 'L']],
  [['T', 'L']], [['T', 'B']], [['T', 'L'], ['B', 'R']], [['T', 'R']], [['L', 'R']], [['B', 'R']], [['L', 'B']], [],
];
export function traceMask(mask, w, h) {
  const W2 = 2 * w + 6;
  const v = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  const key = (X2, Y2) => (Y2 + 2) * W2 + (X2 + 2);
  const adj = new Map();
  const link = (a, b) => {
    let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(b);
    let m = adj.get(b); if (!m) adj.set(b, m = []); m.push(a);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const idx = v(x, y) * 8 + v(x + 1, y) * 4 + v(x + 1, y + 1) * 2 + v(x, y + 1);
      if (idx === 0 || idx === 15) continue;
      const P = {
        T: key(2 * x + 1, 2 * y), R: key(2 * x + 2, 2 * y + 1),
        B: key(2 * x + 1, 2 * y + 2), L: key(2 * x, 2 * y + 1),
      };
      for (const [a, b] of SEGS[idx]) link(P[a], P[b]);
    }
  }
  const decode = k => { const Y2 = Math.floor(k / W2) - 2, X2 = (k % W2) - 2; return [X2 / 2 + 0.5, Y2 / 2 + 0.5]; };
  const seen = new Set(), loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const pts = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur); pts.push(decode(cur));
      const nb = adj.get(cur);
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur; cur = next;
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

// ---------------------------------------------------------------- text → outlines
const textCache = new Map();
export function fontString(o, px) {
  return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${o.font || 'sans-serif'}`;
}
export function textLocal(o) {
  const k = [o.text, o.font, o.size, o.bold, o.italic, o.align].join('\u0001');
  const hit = textCache.get(k);
  if (hit) return hit;
  const size = Math.max(0.5, o.size || 10);
  const res = Math.max(3, Math.min(40, 220 / size)); // px per mm
  const fpx = size * res;
  const lines = String(o.text || ' ').split('\n');
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = fontString(o, fpx);
  const lineH = fpx * 1.2, pad = Math.ceil(fpx * 0.3);
  const width = Math.max(1, ...lines.map(l => probe.measureText(l).width));
  const W = Math.ceil(width + pad * 2), H = Math.ceil(lineH * lines.length + pad * 2);
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.font = probe.font; ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
  const align = o.align || 'center';
  ctx.textAlign = align;
  const ax = align === 'left' ? pad : align === 'right' ? W - pad : W / 2;
  lines.forEach((l, i) => ctx.fillText(l, ax, pad + lineH * (i + 0.5)));
  const data = ctx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const loops = traceMask(mask, W, H);
  const polys = loops
    .map(l => simplify(l, 0.45))
    .filter(l => l.length >= 3 && Math.abs(polyArea(l)) > 1)
    .map(l => ({ closed: true, pts: l.map(([x, y]) => [(x - W / 2) / res, (y - H / 2) / res]) }));
  const out = { polys };
  if (textCache.size > 300) textCache.clear();
  textCache.set(k, out);
  return out;
}

// ---------------------------------------------------------------- images
const images = new Map(); // imgKey -> HTMLImageElement
export function getImage(o) {
  const im = images.get(o.imgKey);
  return im && im.complete && im.naturalWidth ? im : null;
}
export function loadImage(key, src) {
  return new Promise((resolve, reject) => {
    const have = images.get(key);
    if (have && have.complete && have.naturalWidth) return resolve(have);
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not load image'));
    im.src = src;
    images.set(key, im);
  });
}
// Image with per-object gamma applied (cached). Gamma 1 returns the original image.
const gammaCache = new Map();
export function imageSource(o) {
  const img = getImage(o);
  const g = o.gamma ?? 1;
  if (!img || Math.abs(g - 1) < 1e-3) return img;
  const key = `${o.imgKey}|${g}`;
  if (gammaCache.has(key)) return gammaCache.get(key);
  const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(1, Math.round(img.naturalWidth * k)), H = Math.max(1, Math.round(img.naturalHeight * k));
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H), d = id.data, lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 1 / g);
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  ctx.putImageData(id, 0, 0);
  if (gammaCache.size > 20) gammaCache.clear();
  gammaCache.set(key, c);
  return c;
}

export function imageFilter(o) {
  return `grayscale(1) brightness(${o.brightness ?? 100}%) contrast(${o.contrast ?? 100}%)${o.invert ? ' invert(1)' : ''}`;
}

// Chaikin corner-cutting for closed loops (smooths jagged pixel edges).
function chaikin(pts, iterations) {
  for (let it = 0; it < iterations && pts.length >= 4; it++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    pts = out;
  }
  return pts;
}

// Trace an image object into outlines (local mm, centred), LightBurn-style:
//   mode 'brightness'   — trace pixels whose brightness lies between cutoff and threshold
//   mode 'transparency' — trace the opaque parts of a PNG
//   mode 'sketch'       — trace edges (outlines of lines/drawings) found with a Sobel filter
// ignore: drop shapes smaller than this many px²; optimize: simplification tolerance (px);
// smooth: 0–1 corner smoothing; res: px per mm; maxPx: longest side limit (lower = faster preview).
export function traceImage(o, { mode = 'brightness', cutoff = 0, threshold = 128, edge = 60, ignore = 6, optimize = 0.6, smooth = 0.4, res = 10, maxPx = 3000 } = {}) {
  const img = imageSource(o);
  if (!img) throw new Error('Image not loaded yet');
  let W = Math.ceil(o.w * res), H = Math.ceil(o.h * res);
  const k = Math.min(1, maxPx / Math.max(W, H)); W = Math.max(2, Math.ceil(W * k)); H = Math.max(2, Math.ceil(H * k));
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  if (mode !== 'transparency') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.filter = imageFilter(o); }
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data, n = W * H, mask = new Uint8Array(n);
  if (mode === 'transparency') {
    for (let i = 0; i < n; i++) mask[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  } else if (mode === 'sketch') {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = d[i * 4];
    const t = 255 - edge;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1] + g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1];
      const gy = -g[i - W - 1] - 2 * g[i - W] - g[i - W + 1] + g[i + W - 1] + 2 * g[i + W] + g[i + W + 1];
      if (Math.hypot(gx, gy) / 4 > t) mask[i] = 1;
    }
  } else {
    const lo = Math.min(cutoff, threshold), hi = Math.max(cutoff, threshold);
    for (let i = 0; i < n; i++) { const v = d[i * 4]; mask[i] = v >= lo && v <= hi ? 1 : 0; }
  }
  const iters = Math.round(Math.max(0, Math.min(1, smooth)) * 3);
  const polys = traceMask(mask, W, H)
    .filter(l => Math.abs(polyArea(l)) >= Math.max(1, ignore))
    .map(l => chaikin(simplify(l, Math.max(0.05, optimize)), iters))
    .filter(l => l.length >= 3)
    .map(l => ({ closed: true, pts: l.map(([x, y]) => [x / W * o.w - o.w / 2, y / H * o.h - o.h / 2]) }));
  return { polys, W, H, pixels: n };
}

// ---------------------------------------------------------------- dithering
const KERNELS = {
  floyd: { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  jarvis: { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  stucki: { div: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};
function bayer(n) {
  let m = [[0]];
  while (m.length < n) {
    const s = m.length, out = Array.from({ length: s * 2 }, () => new Array(s * 2));
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const v = m[y][x] * 4;
      out[y][x] = v; out[y][x + s] = v + 2; out[y + s][x] = v + 3; out[y + s][x + s] = v + 1;
    }
    m = out;
  }
  return m;
}
const BAYER8 = bayer(8);

// gray: Float32Array 0..255 (255 = white). Returns Uint8Array, 1 = burn.
export function dither(gray, w, h, method = 'floyd', threshold = 128, { cell = 6, angle = 45 } = {}) {
  const out = new Uint8Array(w * h);
  if (method === 'halftone') { // newspaper-style round dots on a rotated grid
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180), cs = Math.max(2, cell);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (((x * c + y * s) / cs) % 1 + 1) % 1 - 0.5, v = (((-x * s + y * c) / cs) % 1 + 1) % 1 - 0.5;
      const spot = 1 - (u * u + v * v) * 2; // 1 at dot centre, 0 at cell corners
      out[y * w + x] = (255 - gray[y * w + x]) / 255 > 1 - spot ? 1 : 0;
    }
    return out;
  }
  if (method === 'threshold') {
    for (let i = 0; i < out.length; i++) out[i] = gray[i] < threshold ? 1 : 0;
    return out;
  }
  if (method === 'ordered') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = (BAYER8[y & 7][x & 7] + 0.5) * 4;
      out[y * w + x] = gray[y * w + x] < t ? 1 : 0;
    }
    return out;
  }
  const K = KERNELS[method] || KERNELS.floyd;
  const g = Float32Array.from(gray);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, old = g[i], burn = old < 128;
      out[i] = burn ? 1 : 0;
      const err = old - (burn ? 0 : 255);
      if (!err) continue;
      for (const [dx, dy, wt] of K.k) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) g[ny * w + nx] += err * wt / K.div;
      }
    }
  }
  return out;
}
