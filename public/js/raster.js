// Raster helpers: contour tracing, text outlines, image cache, dithering.
import { simplify, polyArea, pointInPoly } from './geom.js';

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
export function simplifyLoop(pts, tol, maxMove = 2, closed = true) {
  const n = pts.length, idx = new Map(pts.map((p, i) => [p, i]));
  let keep = closed ? simplify([...pts, pts[0]], tol).slice(0, -1).map(p => idx.get(p)) : simplify(pts, tol).map(p => idx.get(p));
  if (closed && keep.length > 3) { // the start point is only there because the loop has to start somewhere
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
  const lines = keep.slice(0, closed ? m : m - 1).map((a, j) => { // run from keep[j] to keep[j + 1]: centroid + direction
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
    if (!closed && (j === 0 || j === m - 1)) return pts[i]; // line ends stay put
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
export function smoothLoop(pts, iterations, alphaMax = 4 / 3, unit = 1, closed = true) {
  if (!iterations || pts.length < (closed ? 4 : 3)) return pts;
  const n = pts.length;
  let fixed = pts.map((v, i) => {
    if (!closed && (i === 0 || i === n - 1)) return true; // line ends stay put
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

// Trace a traceRaster into paths, in pixels of that raster: [{ pts, closed, piece }]. Outlines are closed; with
// center: true, strokes become single (mostly open) lines along their middle. Paths with the same piece number belong
// together (an outline and the holes in it, or one connected network of lines).
// unit = final-raster pixels per pixel of this raster (> 1 for a quick, reduced-detail preview), so ignore/optimize/
// smooth mean the same at any preview size.
export function traceValues(v, W, H, opts = {}) {
  const { ignore = 6, optimize = 0.6, smooth = 0.4, unit = 1, center = false } = opts;
  const s = Math.max(0, Math.min(1, smooth)), iters = Math.round(s * 3);
  const minArea = Math.max(1, ignore) / (unit * unit), tol = Math.max(0.05, optimize) / unit;
  const { mask, cross } = traceField(v, W, H, opts);
  if (center) {
    dropSmallRegions(mask, W, H, minArea);
    return centerLines(mask, W, H, cross)
      .map(l => ({ ...l, pts: smoothLoop(simplifyLoop(l.pts, tol, 2 / unit, l.closed), iters, s * 4 / 3, unit, l.closed) }))
      .filter(l => l.pts.length >= (l.closed ? 3 : 2));
  }
  const loops = traceMask(mask, W, H, cross)
    .filter(l => Math.abs(polyArea(l)) >= minArea)
    .map(l => smoothLoop(simplifyLoop(l, tol, 2 / unit), iters, s * 4 / 3, unit))
    .filter(l => l.length >= 3);
  const piece = nestPieces(loops);
  return loops.map((pts, i) => ({ pts, closed: true, piece: piece[i] }));
}

// Which piece each closed outline belongs to: an outline plus the holes directly inside it (an island inside a hole
// starts a new piece). Outlines from traceMask never cross, so one point decides what is inside what.
export function nestPieces(loops) {
  const n = loops.length, area = loops.map(l => Math.abs(polyArea(l))), box = loops.map(l => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of l) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  });
  const order = [...Array(n).keys()].sort((a, b) => area[b] - area[a]), placed = [];
  const parent = new Int32Array(n).fill(-1), depth = new Int32Array(n), piece = new Int32Array(n);
  for (const i of order) {
    const b = box[i], [x, y] = loops[i][0];
    for (let k = placed.length - 1; k >= 0; k--) { // smallest first: the first one around it is its parent
      const j = placed[k], c = box[j];
      if (b[0] < c[0] || b[2] > c[2] || b[1] < c[1] || b[3] > c[3]) continue;
      if (pointInPoly(x, y, loops[j])) { parent[i] = j; depth[i] = depth[j] + 1; break; }
    }
    placed.push(i);
  }
  let next = 0;
  for (const i of order) piece[i] = depth[i] % 2 ? piece[parent[i]] : next++;
  return piece;
}

// Clear 4-connected regions of ink smaller than minArea pixels (specks), in place.
export function dropSmallRegions(mask, W, H, minArea) {
  if (minArea <= 1) return mask;
  const n = W * H, seen = new Uint8Array(n), stack = new Int32Array(n), region = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !mask[s]) continue;
    let top = 0; region.length = 0;
    seen[s] = 1; stack[top++] = s;
    while (top) {
      const i = stack[--top], x = i % W;
      region.push(i);
      if (x > 0 && !seen[i - 1] && mask[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && mask[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (i >= W && !seen[i - W] && mask[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (i + W < n && !seen[i + W] && mask[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    if (region.length < minArea) for (const i of region) mask[i] = 0;
  }
  return mask;
}

// ---------------------------------------------------------------- center line trace
// Neighbours P2…P9 of a pixel, clockwise from north; a neighbourhood is coded as 8 bits (bit k = P(k+2)).
const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const ZS = [new Uint8Array(256), new Uint8Array(256)]; // Zhang–Suen: may this pixel go in pass 1 / pass 2?
const SIMPLE = new Uint8Array(256); // can it go without splitting the ink or the background around it?
{
  const groups = (ks, touch) => { // how many groups the ring positions ks form
    const left = new Set(ks), out = [];
    while (left.size) {
      const first = left.values().next().value, g = [first], todo = [first];
      left.delete(first);
      while (todo.length) { const a = todo.pop(); for (const b of [...left]) if (touch(a, b)) { left.delete(b); g.push(b); todo.push(b); } }
      out.push(g);
    }
    return out;
  };
  const d = (a, b) => [Math.abs(NB[a][0] - NB[b][0]), Math.abs(NB[a][1] - NB[b][1])];
  for (let c = 0; c < 256; c++) {
    const p = k => (c >> (k % 8)) & 1, ink = [], bg = [];
    let B = 0, A = 0;
    for (let k = 0; k < 8; k++) { B += p(k); if (!p(k) && p(k + 1)) A++; (p(k) ? ink : bg).push(k); }
    const ok = B >= 2 && B <= 6 && A === 1, [P2, P4, P6, P8] = [p(0), p(2), p(4), p(6)];
    ZS[0][c] = ok && !(P2 && P4 && P6) && !(P4 && P6 && P8) ? 1 : 0;
    ZS[1][c] = ok && !(P2 && P4 && P8) && !(P2 && P6 && P8) ? 1 : 0;
    const inkGroups = groups(ink, (a, b) => Math.max(...d(a, b)) === 1).length;
    const bgGroups = groups(bg, (a, b) => d(a, b)[0] + d(a, b)[1] === 1).filter(g => g.some(k => k % 2 === 0)).length;
    SIMPLE[c] = inkGroups === 1 && bgGroups === 1 ? 1 : 0;
  }
}

// Thin ink (mask 1) down to 1-pixel-wide, 8-connected lines (Zhang–Suen, then clean-up of corner pixels).
export function thinMask(mask, W, H) {
  const W2 = W + 2, img = new Uint8Array(W2 * (H + 2)), off = NB.map(([dx, dy]) => dy * W2 + dx);
  for (let y = 0; y < H; y++) img.set(mask.subarray(y * W, y * W + W), (y + 1) * W2 + 1);
  const code = i => { let c = 0; for (let k = 0; k < 8; k++) if (img[i + off[k]]) c |= 1 << k; return c; };
  const inList = new Uint8Array(img.length);
  let list = [];
  for (let y = 1; y <= H; y++) for (let x = 1; x <= W; x++) { const i = y * W2 + x; if (img[i] && code(i) !== 255) { list.push(i); inList[i] = 1; } }
  for (let changed = true; changed;) {
    changed = false;
    for (const pass of [0, 1]) {
      // Pixels go together, as in Zhang–Suen, but each is checked again just before it goes: plain Zhang–Suen wipes
      // out a 2×2 block or a 2-pixel diagonal completely (whole dots and bits of thin lines went missing).
      const del = [];
      for (const i of list.filter(i => img[i] && ZS[pass][code(i)])) if (ZS[pass][code(i)]) { img[i] = 0; del.push(i); }
      if (!del.length) continue;
      changed = true;
      const next = [];
      for (const i of list) inList[i] = 0;
      for (const i of list) if (img[i] && !inList[i]) { inList[i] = 1; next.push(i); }
      for (const i of del) for (const o of off) { const j = i + o; if (img[j] && !inList[j]) { inList[j] = 1; next.push(j); } }
      list = next;
    }
  }
  const ink = [];
  for (let y = 1; y <= H; y++) for (let x = 1; x <= W; x++) if (img[y * W2 + x]) ink.push(y * W2 + x);
  for (let again = true, pass = 0; again && pass < 4; pass++) { // staircase corners and 2×2 blobs
    again = false;
    for (const i of ink) {
      if (!img[i]) continue;
      const c = code(i);
      let B = 0;
      for (let k = 0; k < 8; k++) B += (c >> k) & 1;
      if (B >= 2 && SIMPLE[c]) { img[i] = 0; again = true; }
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) out.set(img.subarray((y + 1) * W2 + 1, (y + 1) * W2 + 1 + W), y * W);
  return out;
}

// Distance (pixels) from each ink pixel to the nearest non-ink pixel or the picture's edge (3-4 chamfer).
export function inkDistance(mask, W, H) {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 1e9 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < W * H; i++) d[i] /= 3;
  return d;
}

// The outline(s) of the patch of ink (8-connected) that pixel seed is in, in raster pixels; cross as for traceMask.
// mark (W×H, shared between calls for different patches) records the patch's pixels.
function outlineOf(mask, W, H, seed, cross, mark) {
  const part = [seed];
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  mark[seed] = 1;
  for (let k = 0; k < part.length; k++) {
    const i = part[k], x = i % W, y = (i - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const [dx, dy] of NB) {
      const X = x + dx, Y = y + dy, j = Y * W + X;
      if (X >= 0 && Y >= 0 && X < W && Y < H && mask[j] && !mark[j]) { mark[j] = 1; part.push(j); }
    }
  }
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W - 1, x1 + 1); y1 = Math.min(H - 1, y1 + 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, sub = new Uint8Array(w * h);
  for (const i of part) sub[(Math.floor(i / W) - y0) * w + (i % W) - x0] = 1;
  const full = i => (Math.floor(i / w) + y0) * W + (i % w) + x0;
  return traceMask(sub, w, h, cross && ((a, b) => cross(full(a), full(b)))).map(l => l.map(([x, y]) => [x + x0, y + y0]));
}

// Center lines of the ink in a mask, as [{ pts, closed, piece }] in raster pixels. The ink is thinned to 1-pixel
// lines, which are followed between line ends and junctions; then the short side branches thinning leaves at
// corners are dropped, junctions that thinning split in two (where lines cross) are put back together, lines that
// carry straight on through a junction are joined, and line ends are stretched back out to the ends of the strokes.
// Dots and blobs (no longer than they are thick) have no middle line worth having, so they keep their outline;
// cross (optional, as for traceMask) puts those outlines between pixels.
export function centerLines(mask, W, H, cross) {
  const skel = thinMask(mask, W, H), dist = inkDistance(mask, W, H), n = W * H;
  const nbrs = i => {
    const x = i % W, y = (i - x) / W, out = [];
    for (const [dx, dy] of NB) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H && skel[Y * W + X]) out.push(Y * W + X); }
    return out;
  };
  const out = []; // closed lines that are pieces of their own: { pts, key }
  const done = new Uint8Array(n), mark = new Uint8Array(n);
  for (let s = 0; s < n; s++) { // each patch of ink keeps at least one pixel of its thinned line
    if (!skel[s] || done[s]) continue;
    const part = [s];
    let thick = 0;
    done[s] = 1;
    for (let k = 0; k < part.length; k++) {
      thick = Math.max(thick, dist[part[k]]);
      for (const j of nbrs(part[k])) if (!done[j]) { done[j] = 1; part.push(j); }
    }
    if (part.length > 2 * thick) continue; // a line
    for (const i of part) skel[i] = 0;
    for (const pts of outlineOf(mask, W, H, s, cross, mark)) out.push({ pts, key: 'dot' + s });
  }
  const pix = [];
  for (let i = 0; i < n; i++) if (skel[i]) pix.push(i);
  const deg = new Uint8Array(n);
  for (const i of pix) deg[i] = nbrs(i).length;
  const at = i => [i % W + 0.5, Math.floor(i / W) + 0.5];
  // nodes: line ends (1 neighbour) and junctions (3+, touching junction pixels count as one)
  const nodeOf = new Int32Array(n).fill(-1), nodes = [];
  for (const i of pix) {
    if (deg[i] === 2 || nodeOf[i] >= 0) continue;
    const id = nodes.length, members = [i];
    nodeOf[i] = id;
    if (deg[i] >= 3) for (let k = 0; k < members.length; k++) for (const j of nbrs(members[k])) if (deg[j] >= 3 && nodeOf[j] < 0) { nodeOf[j] = id; members.push(j); }
    let sx = 0, sy = 0, w = 0;
    for (const m of members) { const [x, y] = at(m); sx += x; sy += y; w = Math.max(w, dist[m]); }
    nodes.push({ x: sx / members.length, y: sy / members.length, members, w, end: deg[i] === 1 });
  }
  // edges between nodes, following the 1-pixel lines
  const seen = new Uint8Array(n), edges = [], pairs = new Set();
  for (let a = 0; a < nodes.length; a++) for (const m of nodes[a].members) for (const j of nbrs(m)) {
    if (nodeOf[j] === a) continue;
    if (nodeOf[j] >= 0) { // two nodes side by side
      const key = Math.min(a, nodeOf[j]) + ':' + Math.max(a, nodeOf[j]);
      if (!pairs.has(key)) { pairs.add(key); edges.push({ a, b: nodeOf[j], pts: [[nodes[a].x, nodes[a].y], [nodes[nodeOf[j]].x, nodes[nodeOf[j]].y]] }); }
      continue;
    }
    if (seen[j]) continue;
    const pts = [[nodes[a].x, nodes[a].y]];
    let prev = m, cur = j;
    while (nodeOf[cur] < 0) {
      seen[cur] = 1; pts.push(at(cur));
      const nb = nbrs(cur), next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined || (seen[next] && nodeOf[next] < 0)) { cur = -1; break; }
      prev = cur; cur = next;
    }
    if (cur < 0) continue;
    const b = nodeOf[cur];
    pts.push([nodes[b].x, nodes[b].y]);
    edges.push({ a, b, pts });
  }
  for (const i of pix) { // closed loops with no ends or junctions (a drawn circle)
    if (deg[i] !== 2 || seen[i] || nodeOf[i] >= 0) continue;
    const pts = [];
    let prev = -1, cur = i;
    do { seen[cur] = 1; pts.push(at(cur)); const nb = nbrs(cur), next = nb[0] !== prev ? nb[0] : nb[1]; prev = cur; cur = next; }
    while (cur !== undefined && cur !== i && !seen[cur]);
    if (pts.length >= 3) out.push({ pts, key: 'ring' + i });
  }
  const len = pts => { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return L; };

  // junctions split in two where lines cross: put them back together
  const rep = nodes.map((_, k) => k), find = k => { while (rep[k] !== k) k = rep[k] = rep[rep[k]]; return k; };
  for (const e of edges) {
    const A = nodes[e.a], B = nodes[e.b];
    if (A.end || B.end || e.a === e.b || len(e.pts) > Math.max(2, 1.5 * Math.max(A.w, B.w))) continue;
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) rep[rb] = ra;
    e.gone = true;
  }
  const groupsOf = new Map();
  nodes.forEach((N, k) => { const r = find(k); if (!groupsOf.has(r)) groupsOf.set(r, []); groupsOf.get(r).push(N); });
  for (const [r, list] of groupsOf) if (list.length > 1) {
    const N = nodes[r];
    N.x = list.reduce((a, q) => a + q.x, 0) / list.length; N.y = list.reduce((a, q) => a + q.y, 0) / list.length;
    N.w = Math.max(...list.map(q => q.w));
  }
  let live = edges.filter(e => !e.gone).map(e => {
    const a = find(e.a), b = find(e.b), pts = e.pts.slice();
    pts[0] = [nodes[a].x, nodes[a].y]; pts[pts.length - 1] = [nodes[b].x, nodes[b].y];
    return { a, b, pts };
  });
  const endsAt = () => { // node → [{ e, start }]
    const m = new Map();
    for (const e of live) for (const start of [true, false]) {
      const k = start ? e.a : e.b;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ e, start });
    }
    return m;
  };
  // drop the little side branches thinning leaves at corners and stroke ends: all of them where a longer line goes on,
  // or all but the two longest where nothing does (a small blob)
  let ends = endsAt();
  for (const [k, list] of ends) {
    if (list.length < 3) continue;
    const limit = Math.max(3, 1.5 * nodes[k].w);
    const spurs = list.filter(h => { const far = h.start ? h.e.b : h.e.a; return far !== k && nodes[far].end && len(h.e.pts) < limit; })
      .sort((p, q) => len(p.e.pts) - len(q.e.pts));
    const drop = list.length > spurs.length ? spurs.length : spurs.length - 2;
    for (let i = 0; i < drop; i++) spurs[i].e.gone = true;
  }
  live = live.filter(e => !e.gone);
  // pieces: lines that meet belong together (decided now, before lines are joined through junctions)
  const own = nodes.map((_, k) => k), top = k => { while (own[k] !== k) k = own[k] = own[own[k]]; return k; };
  for (const e of live) { const ra = top(e.a), rb = top(e.b); if (ra !== rb) own[rb] = ra; }
  for (const e of live) e.comp = top(e.a);
  // join lines through junctions: always where only two meet, and where one carries straight on into another
  const dirAt = (h, k) => { // direction leaving node k along half-edge h
    const pts = h.start ? h.e.pts : h.e.pts.slice().reverse(), [x0, y0] = pts[0], want = Math.max(3, 2 * nodes[k].w);
    let L = 0, q = pts[pts.length - 1];
    for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (L >= want) { q = pts[i]; break; } }
    const dx = q[0] - x0, dy = q[1] - y0, d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };
  const loopsOut = [];
  const join = (k, list, h1, h2, straight) => { // merge the line ending at k (h1) with the one leaving k (h2)
    const p1 = h1.start ? h1.e.pts.slice().reverse() : h1.e.pts, p2 = h2.start ? h2.e.pts : h2.e.pts.slice().reverse();
    const a = h1.start ? h1.e.b : h1.e.a, b = h2.start ? h2.e.b : h2.e.a, comp = h1.e.comp;
    h1.e.gone = h2.e.gone = true;
    nodes[k].joined = true;
    if (h1.e === h2.e) { loopsOut.push({ pts: p1.slice(0, -1), comp }); return; } // a loop through k: closed
    let pts = p1.concat(p2.slice(1));
    if (straight) { // thinning bends lines towards a side branch: run straight past the junction instead
      const J = [nodes[k].x, nodes[k].y], r = Math.max(1.5, nodes[k].w), near = q => Math.hypot(q[0] - J[0], q[1] - J[1]) < r;
      let lo = p1.length - 1, hi = lo;
      while (lo - 1 > 0 && near(pts[lo - 1])) lo--;
      while (hi + 1 < pts.length - 1 && near(pts[hi + 1])) hi++;
      pts = pts.slice(0, lo).concat(pts.slice(hi + 1));
      const [ax, ay] = pts[lo - 1], [bx, by] = pts[lo], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((J[0] - ax) * dx + (J[1] - ay) * dy) / L2)) : 0, Jn = [ax + t * dx, ay + t * dy];
      nodes[k].x = Jn[0]; nodes[k].y = Jn[1];
      for (const h of list) if (h !== h1 && h !== h2 && !h.e.gone) h.e.pts[h.start ? 0 : h.e.pts.length - 1] = Jn; // the side branch ends on the line
    }
    live.push({ a, b, pts, comp });
  };
  for (let pass = 0, again = true; again && pass < 50; pass++) {
    again = false;
    ends = endsAt();
    for (const [k, list] of ends) {
      if (list.length < 2 || list.some(h => h.e.gone)) continue;
      const dirs = list.map(h => dirAt(h, k));
      let best = null;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (list[i].e === list[j].e) continue;
        const dot = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
        if (dot < -0.6 && (!best || dot < best.dot)) best = { dot, i, j };
      }
      if (list.length === 2) { join(k, list, list[0], list[1], !!best); again = true; }
      else if (best) { join(k, list, list[best.i], list[best.j], true); again = true; } // k's other lines get their turn next pass
    }
    live = live.filter(e => !e.gone);
  }
  // stretch line ends back out to the end of the stroke (thinning stops about half a stroke-width short), but never
  // out of the ink: a line that ends inside a filled area would otherwise poke out of it
  const inInk = (x, y) => { const X = Math.floor(x), Y = Math.floor(y); return X >= 0 && Y >= 0 && X < W && Y < H && mask[Y * W + X] === 1; };
  for (const [k, list] of endsAt()) {
    if (list.length !== 1 || nodes[k].joined) continue; // (a side line left where two were joined ends on that line)
    const { e, start } = list[0], pts = e.pts, i0 = start ? 0 : pts.length - 1, [ex, ey] = pts[i0], [dx, dy] = dirAt(list[0], k);
    const grow = nodes[k].w - 0.5;
    let g = 0; // how far the ink really goes on
    while (g < grow) { const s = Math.min(grow, g + 0.5); if (!inInk(ex - dx * s, ey - dy * s)) break; g = s; }
    if (g > 0.25) pts[i0] = [ex - dx * g, ey - dy * g];
  }
  const pieceOf = new Map(), pieceNo = c => { if (!pieceOf.has(c)) pieceOf.set(c, pieceOf.size); return pieceOf.get(c); };
  const lines = live.map(e => ({ pts: e.pts, closed: false, piece: pieceNo(e.comp) }));
  for (const l of loopsOut) lines.push({ pts: l.pts, closed: true, piece: pieceNo(l.comp) });
  for (const l of out) lines.push({ pts: l.pts, closed: true, piece: pieceNo(l.key) });
  return lines;
}

// Paths in raster pixels → paths in the image's local mm (centred), ready for path objects.
export function pathsToLocal(paths, o, W, H) {
  return paths.map(p => ({ closed: p.closed, piece: p.piece, pts: p.pts.map(([x, y]) => [x / W * o.w - o.w / 2, y / H * o.h - o.h / 2]) }));
}

// Trace an image object (paths in local mm, centred). Options: mode, cutoff, threshold, edge (see traceField),
// ignore, optimize, smooth, center (see traceValues), res (px per mm); maxPx below TRACE_MAX_PX gives a faster,
// rougher preview.
export function traceImage(o, opts = {}) {
  const { mode = 'brightness', res = 10, maxPx = TRACE_MAX_PX } = opts;
  const [W0] = traceSize(o, res), [W, H] = traceSize(o, res, maxPx);
  const paths = traceValues(traceRaster(o, mode, W, H), W, H, { ...opts, unit: W0 / W });
  return { paths: pathsToLocal(paths, o, W, H), W, H, pixels: W * H };
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

// The threshold that sets the darkest group of tones apart from the rest (values ≤ it are in the group): the first
// clear dip in the histogram on the way up from black with at least minPart and at most maxPart of the pixels below
// it, or -1 when there is no clear dip. On coloured artwork with dark outlines, that group is the outlines.
export function darkestGroup(hist, { minPart = 0.001, maxPart = 0.5 } = {}) {
  let n = 0;
  for (let i = 0; i < 256; i++) n += hist[i];
  if (!n) return -1;
  const s = new Float64Array(256); // lightly smoothed
  for (let i = 0; i < 256; i++) {
    let a = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(255, i + 2); j++, c++) a += hist[j];
    s[i] = a / c;
  }
  const above = new Float64Array(257); // the highest bar above each value
  for (let i = 255; i >= 0; i--) above[i] = Math.max(above[i + 1], s[i]);
  let peak = 0, below = 0, a = -1, b = -1, low = Infinity;
  for (let t = 0; t < 255; t++) {
    peak = Math.max(peak, s[t]); below += hist[t];
    const part = below / n;
    if (s[t] <= 0.2 * Math.min(peak, above[t + 1]) && part >= minPart && part <= maxPart) { if (a < 0) a = t; b = t; low = Math.min(low, s[t]); }
    else if (a >= 0) break;
  }
  if (a < 0) return -1;
  let lo = -1, hi = -1; // the middle of the lowest stretch of the dip
  for (let t = a; t <= b; t++) if (s[t] <= low * 1.5 + n * 1e-9) { if (lo < 0) lo = t; hi = t; }
  return Math.round((lo + hi) / 2);
}

// Average stroke width (pixels) of the ink in a mask: its area over the length of its center lines (0 = no lines).
// A big mask is measured at a coarser scale (a block counts as ink if any of its pixels is), which is much quicker
// and makes little difference.
export function strokeWidth(mask, W, H, maxPx = 1000) {
  const k = Math.max(1, Math.ceil(Math.max(W, H) / maxPx));
  let m = mask, w = W, h = H;
  if (k > 1) {
    w = Math.ceil(W / k); h = Math.ceil(H / k); m = new Uint8Array(w * h);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) m[Math.floor(y / k) * w + Math.floor(x / k)] = 1;
  }
  const sk = thinMask(m, w, h);
  let ink = 0, len = 0;
  for (let i = 0; i < w * h; i++) {
    ink += m[i];
    if (!sk[i]) continue;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of NB) { // half of each link to the next line pixel (the other half is counted from there)
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h && sk[Y * w + X]) len += dx && dy ? Math.SQRT1_2 : 0.5;
    }
  }
  return len ? ink / len * k : 0;
}

// Choose trace settings for a picture. gray/alpha: traceRaster values (brightness over white, opacity) at the final
// trace size W×H; pxPerMm: pixels per mm of that raster; sketch: tune Sketch mode instead of choosing a mode;
// center: settings for a center line trace — the picture's lines (lines: true), or its edges in Sketch mode when it
// has no clear lines (edges: true).
// Returns settings plus what was found ({ none: 'flat' | 'faint' } when there is nothing to trace).
export function autoTraceSettings(gray, alpha, W, H, pxPerMm, { sketch = false, center = false } = {}) {
  const n = W * H, hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const { t, eta, m0, m1 } = otsu(hist), gap = m1 - m0;
  // a photo has lots of in-between greys; artwork is mostly its two tones plus some anti-aliasing
  let mid = 0;
  for (let i = 0; i < 256; i++) if (i > m0 + gap / 4 && i < m1 - gap / 4) mid += hist[i];
  // the share of the picture's border (1 % of its size) where test(pixel) holds
  const b = Math.max(1, Math.round(Math.min(W, H) * 0.01));
  const onBorder = test => {
    let yes = 0, all = 0;
    const tally = i => { all++; if (test(i)) yes++; };
    for (let y = 0; y < H; y++) {
      if (y < b || y >= H - b) for (let x = 0; x < W; x++) tally(y * W + x);
      else { for (let x = 0; x < b; x++) tally(y * W + x); for (let x = W - b; x < W; x++) tally(y * W + x); }
    }
    return all ? yes / all : 0;
  };
  const lightBg = onBorder(i => gray[i] > t) >= 0.5; // the background is the group that covers most of the border
  // A transparent PNG whose artwork is about as light as the background (e.g. a white logo) only shows up by its
  // transparency, so trace that instead.
  let clear = 0, opaque = 0, caught = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 128) clear++;
    else { opaque++; if (lightBg ? gray[i] <= t : gray[i] > t) caught++; }
  }
  const keepSketch = sketch && !center; // a center line trace looks for the picture's lines first, in any mode
  const useAlpha = !keepSketch && clear >= n * 0.05 && opaque >= n * 0.005 && caught < opaque * 0.5;
  const out = { lightBg, photo: !useAlpha && mid > n * 0.2 }, speck = 0.1 * pxPerMm * pxPerMm;
  const edges = () => { // Sketch mode settings: Otsu's split between flat areas and edges, but at most 15 % edges
    const mh = new Float64Array(256);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) mh[Math.min(255, Math.round(sobel(gray, y * W + x, W)))]++;
    const inner = Math.max(1, (W - 2) * (H - 2));
    let acc = 0, p85 = 0;
    for (let i = 0; i < 256; i++) { acc += mh[i]; if (acc >= inner * 0.85) { p85 = i; break; } }
    if (!otsu(mh).eta) return false;
    return Object.assign(out, { mode: 'sketch', edge: Math.max(1, Math.min(254, 255 - Math.max(otsu(mh).t, p85))) });
  };
  // For center lines: the tones that make up the picture's lines, i.e. ink that is mostly thin strokes (on average at
  // most 5 % of the picture's size wide). The darkest group of tones first (the outlines of coloured artwork), then Otsu's
  // split; light lines instead when the darkest tones are the background.
  const lines = () => {
    const td = darkestGroup(hist), dl = darkestGroup(hist.slice().reverse()), tl = dl < 0 ? -1 : 255 - dl;
    const darkInk = td >= 0 ? onBorder(i => gray[i] <= td) <= 0.5 : lightBg;
    const tries = darkInk ? [td, t].filter((x, i, a) => x >= 0 && a.indexOf(x) === i).map(x => ({ cutoff: 0, threshold: x }))
      : [tl, Math.min(255, t + 1)].filter((x, i, a) => x >= 0 && a.indexOf(x) === i).map(x => ({ cutoff: x, threshold: 255 }));
    for (const s of tries) {
      const m = traceMaskFor(gray, W, H, { mode: 'brightness', ...s }), w = strokeWidth(dropSmallRegions(m, W, H, speck), W, H);
      if (w > 0 && w <= 0.05 * Math.min(W, H)) return Object.assign(out, { mode: 'brightness', ...s, lines: true, lightBg: darkInk });
    }
    return false;
  };
  if (useAlpha) out.mode = 'transparency';
  else if (keepSketch) { if (!edges()) return { none: 'flat' }; }
  else {
    if (!eta) return { none: 'flat' };
    if (gap < 20) return { none: 'faint' };
    if (!center) Object.assign(out, lightBg ? { mode: 'brightness', cutoff: 0, threshold: t } : { mode: 'brightness', cutoff: Math.min(255, t + 1), threshold: 255 });
    else if (!lines()) { if (!edges()) return { none: 'flat' }; out.edges = true; }
  }
  // Speckled scans and photos get bigger specks ignored and more smoothing; clean artwork keeps its fine detail.
  const mask = traceMaskFor(useAlpha ? alpha : gray, W, H, out);
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
  const a = autoTraceSettings(rasterOf('brightness', W, H), rasterOf('transparency', W, H), W, H, W / o.w, { sketch: current.mode === 'sketch', center: !!current.center });
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
