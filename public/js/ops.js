// Shape operations built on the Clipper polygon library (vendor/clipper.js, Boost licence):
// offsetting, booleans, concentric offset fill — plus tabs, perforation and convex hull.

const CL = () => {
  const c = globalThis.ClipperLib;
  if (!c) throw new Error('Clipper library not loaded');
  return c;
};
const SC = 1000; // Clipper works in integers: 1 unit = 1 µm
const toPath = pts => pts.map(([x, y]) => ({ X: Math.round(x * SC), Y: Math.round(y * SC) }));
const fromPath = p => p.map(q => [q.X / SC, q.Y / SC]);
const outPolys = paths => paths.filter(p => p.length >= 3).map(p => ({ closed: true, pts: fromPath(p) }));
const isClosed = p => p.closed && p.pts.length >= 3;

// Resolve self-intersections and nesting (even-odd) into cleanly oriented outer/hole polygons.
function normalize(polys) {
  const C = CL();
  const closed = polys.filter(isClosed).map(p => toPath(p.pts));
  if (!closed.length) return [];
  const c = new C.Clipper();
  c.AddPaths(closed, C.PolyType.ptSubject, true);
  const sol = new C.Paths();
  c.Execute(C.ClipType.ctUnion, sol, C.PolyFillType.pftEvenOdd, C.PolyFillType.pftEvenOdd);
  return sol;
}

export function offset(polys, d, { join = 'round', miter = 2, arcTol = 0.01 } = {}) {
  const C = CL();
  const co = new C.ClipperOffset(miter, arcTol * SC);
  const jt = { round: C.JoinType.jtRound, miter: C.JoinType.jtMiter, square: C.JoinType.jtSquare }[join] ?? C.JoinType.jtRound;
  const closed = normalize(polys);
  if (closed.length) co.AddPaths(closed, jt, C.EndType.etClosedPolygon);
  const open = polys.filter(p => !isClosed(p) && p.pts.length >= 2).map(p => toPath(p.pts));
  if (open.length && d > 0) co.AddPaths(open, jt, C.EndType.etOpenRound);
  const sol = new C.Paths();
  co.Execute(sol, d * SC);
  return outPolys(sol);
}

// op: 'union' | 'difference' | 'intersection' | 'xor'. Each group is one object's polygons.
export function boolean(op, subjectGroups, clipGroups = []) {
  const C = CL();
  const c = new C.Clipper();
  let any = false;
  for (const g of subjectGroups) { const n = normalize(g); if (n.length) { c.AddPaths(n, C.PolyType.ptSubject, true); any = true; } }
  for (const g of clipGroups) { const n = normalize(g); if (n.length) c.AddPaths(n, C.PolyType.ptClip, true); }
  if (!any) return [];
  const ct = { union: C.ClipType.ctUnion, difference: C.ClipType.ctDifference, intersection: C.ClipType.ctIntersection, xor: C.ClipType.ctXor }[op];
  const sol = new C.Paths();
  c.Execute(ct, sol, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return outPolys(sol);
}

// Concentric inward rings, outermost first.
export function concentric(polys, step, maxRings = 4000) {
  const base = outPolys(normalize(polys));
  const rings = [];
  for (let d = step / 2, i = 0; i < maxRings; d += step, i++) {
    const r = offset(base, -d, { join: 'round' });
    if (!r.length) break;
    rings.push(...r);
  }
  return rings;
}

// ---------------------------------------------------------------- path slicing
function cumLengths(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
function pointAt(pts, cum, s) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}
// Points of an open polyline between arc-length positions a < b.
function subPath(pts, cum, a, b) {
  const out = [pointAt(pts, cum, a)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > a && cum[i] < b) out.push(pts[i]);
  out.push(pointAt(pts, cum, b));
  return out;
}

// Split a closed shape into cut pieces, leaving `count` (or one every `spacing` mm) uncut tabs of `width` mm.
export function splitTabs(pts, closed, { count = 0, spacing = 0, width = 0.5 } = {}) {
  const ring = closed ? [...pts, pts[0]] : pts;
  if (!closed || width <= 0 || (!count && !spacing)) return [ring];
  const cum = cumLengths(ring), P = cum[cum.length - 1];
  const n = spacing > 0 ? Math.max(1, Math.floor(P / spacing)) : Math.round(count);
  if (n < 1 || n * width >= P * 0.8) return [ring];
  // Work on the ring traversed twice so pieces can wrap past the start.
  const twice = ring.concat(ring.slice(1));
  const cum2 = cumLengths(twice);
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) * P / n + width / 2, b = (i + 1.5) * P / n - width / 2;
    if (b > a) pieces.push(subPath(twice, cum2, a, b));
  }
  return pieces;
}

// Split a polyline into alternating on/off dashes (perforation).
export function dashes(pts, on, off) {
  const cum = cumLengths(pts), L = cum[cum.length - 1];
  if (on <= 0 || off <= 0 || L <= 0) return [{ on: true, pts }];
  const out = [];
  let s = 0, state = true;
  while (s < L - 1e-9) {
    const e = Math.min(L, s + (state ? on : off));
    out.push({ on: state, pts: subPath(pts, cum, s, e) });
    s = e; state = !state;
  }
  return out;
}

// Monotone-chain convex hull.
export function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Join open polylines whose endpoints are within `tol` mm. Returns new poly list.
export function joinPaths(polys, tol = 0.05) {
  const closed = polys.filter(p => p.closed), open = polys.filter(p => !p.closed).map(p => p.pts.slice());
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < open.length; i++) {
      for (let j = 0; j < open.length; j++) {
        if (i === j) continue;
        const a = open[i], b = open[j];
        const aS = a[0], aE = a[a.length - 1], bS = b[0], bE = b[b.length - 1];
        let joined = null;
        if (near(aE, bS)) joined = a.concat(b.slice(1));
        else if (near(aE, bE)) joined = a.concat(b.slice(0, -1).reverse());
        else if (near(aS, bE)) joined = b.concat(a.slice(1));
        else if (near(aS, bS)) joined = b.slice().reverse().concat(a.slice(1));
        if (joined) {
          open.splice(Math.max(i, j), 1); open.splice(Math.min(i, j), 1);
          open.push(joined); merged = true; break outer;
        }
      }
    }
  }
  const out = closed.slice();
  for (const pts of open) {
    if (pts.length >= 3 && near(pts[0], pts[pts.length - 1])) out.push({ closed: true, pts: pts.slice(0, -1) });
    else out.push({ closed: false, pts });
  }
  return out;
}
