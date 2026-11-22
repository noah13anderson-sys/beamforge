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
// cross(inside, outside) (optional): where the outline crosses between two neighbouring pixels, as a fraction 0–1 of
// the way from the inside pixel's centre (index) to the outside one's; without it the outline runs along pixel borders.
export function traceMask(mask, w, h, cross) {
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
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const frac = (x1, y1, x2, y2) => { // from pixel 1 towards pixel 2 (its right or lower neighbour)
    if (x1 < 0 || y1 < 0 || x2 >= w || y2 >= h) return 0.5; // the picture's edge
    const in1 = inside(x1, y1);
    if (in1 === inside(x2, y2)) return 0.5;
    const a = y1 * w + x1, b = y2 * w + x2, f = in1 ? cross(a, b) : 1 - cross(b, a);
    return f > 0.01 ? (f < 0.99 ? f : 0.99) : 0.01;
  };
  const decode = k => {
    const Y2 = Math.floor(k / W2) - 2, X2 = (k % W2) - 2;
    if (!cross) return [X2 / 2 + 0.5, Y2 / 2 + 0.5];
    if (X2 & 1) { const x = (X2 - 1) / 2, y = Y2 / 2; return [x + 0.5 + frac(x, y, x + 1, y), y + 0.5]; } // between columns
    const x = X2 / 2, y = (Y2 - 1) / 2;
    return [x + 0.5, y + 0.5 + frac(x, y, x, y + 1)]; // between rows
  };
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
// Browsers without canvas filters (WebKitGTK, the BeamForge app window, ignores ctx.filter) get the rest of
// imageFilter — grey, brightness, contrast, invert — applied here too; drawing code still sets ctx.filter, which they
// ignore, so nothing is applied twice.
export const CANVAS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
const adjusted = new Map(); // key → canvas, least recently used first
let adjustedPx = 0;
export function imageSource(o) {
  const img = getImage(o);
  const g = o.gamma ?? 1, bake = !CANVAS_FILTER;
  if (!img || (!bake && Math.abs(g - 1) < 1e-3)) return img;
  const key = `${o.imgKey}|${g}` + (bake ? `|${o.brightness ?? 100}|${o.contrast ?? 100}|${o.invert ? 1 : 0}` : '');
  const hit = adjusted.get(key);
  if (hit) { adjusted.delete(key); adjusted.set(key, hit); return hit; }
  const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(1, Math.round(img.naturalWidth * k)), H = Math.max(1, Math.round(img.naturalHeight * k));
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H), d = id.data, lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 1 / g);
  if (bake) {
    const adj = adjustLut(o);
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = adj[Math.round(0.2126 * lut[d[i]] + 0.7152 * lut[d[i + 1]] + 0.0722 * lut[d[i + 2]])];
  } else {
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  ctx.putImageData(id, 0, 0);
  adjusted.set(key, c); adjustedPx += W * H;
  for (const [k2, c2] of adjusted) { // keep about 40 megapixels of adjusted copies
    if (adjustedPx <= 40e6 || k2 === key) break;
    adjusted.delete(k2); adjustedPx -= c2.width * c2.height;
  }
  return c;
}

// The grey levels imageFilter's brightness, contrast and invert give (CSS filter maths), as a 256-entry table.
export function adjustLut(o) {
  const b = (o.brightness ?? 100) / 100, c = (o.contrast ?? 100) / 100, lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.min(1, i / 255 * b);
    v = Math.min(1, Math.max(0, (v - 0.5) * c + 0.5));
    lut[i] = Math.round((o.invert ? 1 - v : v) * 255);
  }
  return lut;
}

export function imageFilter(o) {
  return `grayscale(1) brightness(${o.brightness ?? 100}%) contrast(${o.contrast ?? 100}%)${o.invert ? ' invert(1)' : ''}`;
}

// ---------------------------------------------------------------- image trace
// Settings in the spirit of Potrace's: Ignore = smallest shape kept (pixels²), Optimize = how far (pixels) an outline
// may stray to save points, Smoothness = how much curves are rounded and how sharp a corner must be to stay sharp.
// "Pixels" are those of the final trace raster (res px per mm, longest side at most TRACE_MAX_PX), so a quick
// low-detail preview behaves like the real trace.
export const TRACE_MAX_PX = 3000;

// Raster size [W, H] for tracing image object o at res px/mm, longest side ≤ maxPx.
export function traceSize(o, res = 10, maxPx = TRACE_MAX_PX) {
  const W = Math.ceil(o.w * res), H = Math.ceil(o.h * res);
  const k = Math.min(1, maxPx / Math.max(W, H));
  return [Math.max(2, Math.ceil(W * k)), Math.max(2, Math.ceil(H * k))];
}

// One byte per pixel, as the tracer sees the image: brightness after the image's own adjustments, over white
// (modes 'brightness' and 'sketch'), or opacity (mode 'transparency').
export function traceRaster(o, mode, W, H) {
  const img = imageSource(o);
  if (!img) throw new Error('Image not loaded yet');
  const c = makeCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  if (mode !== 'transparency') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.filter = imageFilter(o); }
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data, n = W * H, v = new Uint8Array(n), ch = mode === 'transparency' ? 3 : 0;
  for (let i = 0; i < n; i++) v[i] = d[i * 4 + ch];
  return v;
}

const sobel = (g, i, W) => {
  const gx = -g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1] + g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1];
  const gy = -g[i - W - 1] - 2 * g[i - W] - g[i - W + 1] + g[i + W - 1] + 2 * g[i + W] + g[i + W + 1];
  return Math.hypot(gx, gy) / 4;
};

// Which pixels of a traceRaster are inside the traced shapes (mask: 1 = inside) for these settings, and where an
// outline crosses between an inside and an outside pixel (cross, see traceMask) so edges land between pixels:
//   mode 'brightness'   — brightness between cutoff and threshold
//   mode 'transparency' — the opaque parts of a PNG
//   mode 'sketch'       — edges (outlines of lines/drawings) found with a Sobel filter
export function traceField(v, W, H, { mode = 'brightness', cutoff = 0, threshold = 128, edge = 60 } = {}) {
  const n = W * H, mask = new Uint8Array(n);
  if (mode === 'transparency') {
    for (let i = 0; i < n; i++) mask[i] = v[i] >= 128 ? 1 : 0;
    return { mask, cross: (a, b) => (127.5 - v[a]) / (v[b] - v[a]) };
  }
  if (mode === 'sketch') {
    const t = 255 - edge, mag = new Float32Array(n);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; mag[i] = sobel(v, i, W); if (mag[i] > t) mask[i] = 1; }
    return { mask, cross: (a, b) => (mag[a] - t) / (mag[a] - mag[b]) };
  }
  const lo = Math.min(cutoff, threshold), hi = Math.max(cutoff, threshold);
  for (let i = 0; i < n; i++) mask[i] = v[i] >= lo && v[i] <= hi ? 1 : 0;
  return { mask, cross: (a, b) => { const va = v[a], vb = v[b]; return ((vb > hi ? hi + 0.5 : lo - 0.5) - va) / (vb - va); } };
}
export const traceMaskFor = (v, W, H, opts) => traceField(v, W, H, opts).mask;

// Simplify a closed outline (Ramer–Douglas–Peucker, tolerance tol), then put each kept corner where the straight
// runs on either side of it meet: lines fitted through all their points, so edges keep their true position instead
// of leaning on the cut-off corner points of the pixel grid. A corner moves at most maxMove.
export function simplifyLoop(pts, tol, maxMove = 2) {
  const n = pts.length, idx = new Map(pts.map((p, i) => [p, i]));
  let keep = simplify([...pts, pts[0]], tol).slice(0, -1).map(p => idx.get(p)); // as a closed loop
  if (keep.length > 3) { // the start point is only there because the loop has to start somewhere
    const a = pts[keep[keep.length - 1]], b = pts[keep[1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    let straight = L > 1e-9;
    for (let i = keep[keep.length - 1]; straight && i <= keep[1] + n; i++) {
      const p = pts[i % n];
      if (Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L > tol) straight = false;
    }
    if (straight) keep = keep.slice(1);
  }
  const m = keep.length;
  if (m < 3) return keep.map(i => pts[i]);
  const lines = keep.map((a, j) => { // run from keep[j] to keep[j + 1]: centroid + main direction
    const b = j + 1 < m ? keep[j + 1] : keep[0] + n;
    let sx = 0, sy = 0;
    for (let i = a; i <= b; i++) { const p = pts[i % n]; sx += p[0]; sy += p[1]; }
    const c = b - a + 1, mx = sx / c, my = sy / c;
    let xx = 0, xy = 0, yy = 0;
    for (let i = a; i <= b; i++) { const p = pts[i % n], dx = p[0] - mx, dy = p[1] - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
    return [mx, my, Math.cos(ang), Math.sin(ang)];
  });
  return keep.map((i, j) => {
    const A = lines[(j + m - 1) % m], B = lines[j], p = pts[i];
    const den = A[2] * B[3] - A[3] * B[2]; // sine of the angle between the runs
    if (Math.abs(den) < 0.17) return p; // nearly straight on: keep the point
    const t = ((B[0] - A[0]) * B[3] - (B[1] - A[1]) * B[2]) / den, x = A[0] + t * A[2], y = A[1] + t * A[3];
    return Math.hypot(x - p[0], y - p[1]) <= maxMove ? [x, y] : p;
  });
}

// Corner cutting (Chaikin) that leaves corners sharp. As with Potrace's alphamax, a point is a corner when it sticks
// out far (in final-raster pixels) from the line joining the middles of its two edges: alphaMax 0 keeps every
// corner, 4/3 rounds them all.
export function smoothLoop(pts, iterations, alphaMax = 4 / 3, unit = 1) {
  if (!iterations || pts.length < 4) return pts;
  const n = pts.length;
  let fixed = pts.map((v, i) => {
    const p = pts[(i + n - 1) % n], q = pts[(i + 1) % n];
    const ax = (p[0] + v[0]) / 2, ay = (p[1] + v[1]) / 2, bx = (v[0] + q[0]) / 2, by = (v[1] + q[1]) / 2;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-9) return true; // a spike
    const d = Math.abs((bx - ax) * (v[1] - ay) - (by - ay) * (v[0] - ax)) / L * unit;
    return (d > 1 ? (1 - 1 / d) / 0.75 : 0) >= alphaMax;
  });
  for (let it = 0; it < iterations; it++) {
    const m = pts.length, out = [], fx = [];
    for (let i = 0; i < m; i++) {
      const v = pts[i];
      if (fixed[i]) { out.push(v); fx.push(true); continue; }
      const p = pts[(i + m - 1) % m], q = pts[(i + 1) % m];
      out.push([0.75 * v[0] + 0.25 * p[0], 0.75 * v[1] + 0.25 * p[1]], [0.75 * v[0] + 0.25 * q[0], 0.75 * v[1] + 0.25 * q[1]]);
      fx.push(false, false);
    }
    pts = out; fixed = fx;
  }
  return pts;
}

// Trace a traceRaster into closed loops, in pixels of that raster. unit = final-raster pixels per pixel of this
// raster (> 1 for a quick, reduced-detail preview), so ignore/optimize/smooth mean the same at any preview size.
export function traceValues(v, W, H, opts = {}) {
  const { ignore = 6, optimize = 0.6, smooth = 0.4, unit = 1 } = opts;
  const s = Math.max(0, Math.min(1, smooth)), iters = Math.round(s * 3);
  const minArea = Math.max(1, ignore) / (unit * unit), tol = Math.max(0.05, optimize) / unit;
  const { mask, cross } = traceField(v, W, H, opts);
  return traceMask(mask, W, H, cross)
    .filter(l => Math.abs(polyArea(l)) >= minArea)
    .map(l => smoothLoop(simplifyLoop(l, tol, 2 / unit), iters, s * 4 / 3, unit))
    .filter(l => l.length >= 3);
}

// Loops in raster pixels → shapes in the image's local mm (centred), ready for a path object.
export function loopsToLocal(loops, o, W, H) {
  return loops.map(l => ({ closed: true, pts: l.map(([x, y]) => [x / W * o.w - o.w / 2, y / H * o.h - o.h / 2]) }));
}

// Trace an image object into outlines (local mm, centred). Options: mode, cutoff, threshold, edge (see traceMaskFor),
// ignore, optimize, smooth (see above), res (px per mm); maxPx below TRACE_MAX_PX gives a faster, rougher preview.
export function traceImage(o, opts = {}) {
  const { mode = 'brightness', res = 10, maxPx = TRACE_MAX_PX } = opts;
  const [W0] = traceSize(o, res), [W, H] = traceSize(o, res, maxPx);
  const loops = traceValues(traceRaster(o, mode, W, H), W, H, { ...opts, unit: W0 / W });
  return { polys: loopsToLocal(loops, o, W, H), W, H, pixels: W * H };
}

// ---------------------------------------------------------------- auto trace
// Otsu's method on a 256-bin histogram. Values ≤ t form the dark group; m0 / m1 are the two groups' average values;
// eta (0–1) is how cleanly the histogram splits into two groups (1 = pure two-tone).
export function otsu(hist) {
  let n = 0, sum = 0;
  for (let i = 0; i < 256; i++) { n += hist[i]; sum += i * hist[i]; }
  const mean = n ? sum / n : 127;
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i] * (i - mean) * (i - mean);
  let w0 = 0, s0 = 0, best = -1, first = 127, last = 127, open = false, m0 = mean, m1 = mean;
  for (let i = 0; i < 255; i++) {
    w0 += hist[i]; s0 += i * hist[i];
    const w1 = n - w0;
    if (!w0 || !w1) { open = false; continue; }
    const a = s0 / w0, b = (sum - s0) / w1, vb = w0 * w1 * (b - a) * (b - a);
    if (vb > best * (1 + 1e-12)) { best = vb; first = last = i; open = true; m0 = a; m1 = b; }
    else if (open && vb >= best * (1 - 1e-12)) last = i; // a run of empty bins: take its middle
    else open = false;
  }
  return { t: Math.round((first + last) / 2), eta: total > 0 && best > 0 ? best / n / total : 0, m0, m1 };
}

// Sizes in pixels of the 4-connected regions where mask[i] === val.
export function regionSizes(mask, W, H, val = 1) {
  const n = W * H, seen = new Uint8Array(n), stack = new Int32Array(n), sizes = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || mask[s] !== val) continue;
    let top = 0, size = 0;
    seen[s] = 1; stack[top++] = s;
    while (top) {
      const i = stack[--top], x = i % W;
      size++;
      if (x > 0 && !seen[i - 1] && mask[i - 1] === val) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && mask[i + 1] === val) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (i >= W && !seen[i - W] && mask[i - W] === val) { seen[i - W] = 1; stack[top++] = i - W; }
      if (i + W < n && !seen[i + W] && mask[i + W] === val) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    sizes.push(size);
  }
  return sizes;
}

// Choose trace settings for a picture. gray/alpha: traceRaster values (brightness over white, opacity) at the final
// trace size W×H; pxPerMm: pixels per mm of that raster; sketch: tune Sketch mode instead of choosing a mode.
// Returns settings plus what was found ({ none: 'flat' | 'faint' } when there is nothing to trace).
export function autoTraceSettings(gray, alpha, W, H, pxPerMm, { sketch = false } = {}) {
  const n = W * H, hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const { t, eta, m0, m1 } = otsu(hist), gap = m1 - m0;
  // a photo has lots of in-between greys; artwork is mostly its two tones plus some anti-aliasing
  let mid = 0;
  for (let i = 0; i < 256; i++) if (i > m0 + gap / 4 && i < m1 - gap / 4) mid += hist[i];
  // the background is whichever group covers most of the picture's border
  const b = Math.max(1, Math.round(Math.min(W, H) * 0.01));
  let dark = 0, light = 0;
  const tally = i => { if (gray[i] <= t) dark++; else light++; };
  for (let y = 0; y < H; y++) {
    if (y < b || y >= H - b) for (let x = 0; x < W; x++) tally(y * W + x);
    else { for (let x = 0; x < b; x++) tally(y * W + x); for (let x = W - b; x < W; x++) tally(y * W + x); }
  }
  const lightBg = light >= dark;
  // A transparent PNG whose artwork is about as light as the background (e.g. a white logo) only shows up by its
  // transparency, so trace that instead.
  let clear = 0, opaque = 0, caught = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 128) clear++;
    else { opaque++; if (lightBg ? gray[i] <= t : gray[i] > t) caught++; }
  }
  const useAlpha = !sketch && clear >= n * 0.05 && opaque >= n * 0.005 && caught < opaque * 0.5;
  const out = { lightBg, photo: !useAlpha && mid > n * 0.2 };
  if (useAlpha) out.mode = 'transparency';
  else if (sketch) {
    const mh = new Float64Array(256);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) mh[Math.min(255, Math.round(sobel(gray, y * W + x, W)))]++;
    // Otsu's split between flat areas and edges, but never more than 15 % of the picture as edges
    const inner = Math.max(1, (W - 2) * (H - 2));
    let acc = 0, p85 = 0;
    for (let i = 0; i < 256; i++) { acc += mh[i]; if (acc >= inner * 0.85) { p85 = i; break; } }
    if (!otsu(mh).eta) return { none: 'flat' };
    Object.assign(out, { mode: 'sketch', edge: Math.max(1, Math.min(254, 255 - Math.max(otsu(mh).t, p85))) });
  } else {
    if (!eta) return { none: 'flat' };
    if (gap < 20) return { none: 'faint' };
    Object.assign(out, lightBg ? { mode: 'brightness', cutoff: 0, threshold: t } : { mode: 'brightness', cutoff: Math.min(255, t + 1), threshold: 255 });
  }
  // Speckled scans and photos get bigger specks ignored and more smoothing; clean artwork keeps its fine detail.
  const mask = traceMaskFor(useAlpha ? alpha : gray, W, H, out), speck = 0.1 * pxPerMm * pxPerMm;
  let specks = 0, parts = 0;
  for (const val of [1, 0]) for (const s of regionSizes(mask, W, H, val)) { if (s < speck) specks++; else parts++; }
  out.noisy = specks >= 20 && specks > parts * 1.5;
  out.ignore = Math.round(Math.max(2, Math.min(400, (out.noisy ? 0.12 : 0.02) * pxPerMm * pxPerMm)));
  out.smooth = out.noisy ? 0.6 : 0.4;
  out.optimize = out.noisy ? 0.8 : 0.6;
  return out;
}

// Auto trace settings for image object o, including the detail (px/mm): the picture's own resolution, 10–20 px/mm.
// rasterOf(mode, W, H) can supply cached traceRaster values.
export function autoTrace(o, current = {}, rasterOf = (mode, W, H) => traceRaster(o, mode, W, H)) {
  const img = getImage(o);
  if (!img) throw new Error('Image not loaded yet');
  const cap = Math.floor(TRACE_MAX_PX / Math.max(o.w, o.h));
  const res = Math.max(2, Math.min(cap, Math.round(Math.max(10, Math.min(20, img.naturalWidth / o.w)))));
  const [W, H] = traceSize(o, res);
  const a = autoTraceSettings(rasterOf('brightness', W, H), rasterOf('transparency', W, H), W, H, W / o.w, { sketch: current.mode === 'sketch' });
  return a.none ? a : { ...a, res };
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
