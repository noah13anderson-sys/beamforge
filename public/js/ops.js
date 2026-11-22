// Shape operations built on the Clipper polygon library (vendor/clipper.js, Boost licence):
// offsetting, booleans, concentric offset fill — plus tabs, perforation, convex hull, path clean-up,
// docking and node editing helpers.
import { simplify, distToSegment, pointInPoly, boundsOfPolys } from './geom.js';

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

// ---------------------------------------------------------------- fillet / chamfer corners
// polys: [{closed, pts}] in world mm. Rounds (or cuts) every corner that turns by at least minTurn degrees.
// The radius shrinks automatically where an edge is too short to fit it. Open path end points are left alone.
export function fillet(polys, radius, { style = 'round', minTurn = 10, maxTurn = 179, segDeg = 5, only } = {}) {
  const out = [];
  let changed = 0;
  polys.forEach((poly, pi) => {
    // drop repeated points (and the closing duplicate)
    const pts = [];
    for (const p of poly.pts) { const q = pts[pts.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p); }
    if (poly.closed && pts.length > 2) { const a = pts[0], z = pts[pts.length - 1]; if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9) pts.pop(); }
    const n = pts.length;
    if (n < 3 || radius <= 0) { out.push({ closed: poly.closed, pts }); return; }
    const res = [];
    for (let i = 0; i < n; i++) {
      const P = pts[i];
      const end = !poly.closed && (i === 0 || i === n - 1);
      if (end || (only && !only(pi, i))) { res.push(P); continue; }
      const A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
      const la = Math.hypot(A[0] - P[0], A[1] - P[1]), lb = Math.hypot(B[0] - P[0], B[1] - P[1]);
      const u = [(A[0] - P[0]) / la, (A[1] - P[1]) / la], v = [(B[0] - P[0]) / lb, (B[1] - P[1]) / lb];
      const theta = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))); // interior angle
      const turn = 180 - theta * 180 / Math.PI;
      if (turn < minTurn || turn > maxTurn) { res.push(P); continue; }
      // each neighbouring corner may use up to half of the shared edge (all of it at an open end)
      const lim = Math.min(la * (!poly.closed && i === 1 ? 1 : 0.5), lb * (!poly.closed && i === n - 2 ? 1 : 0.5));
      let t = radius / Math.tan(theta / 2);
      if (t > lim) t = lim;
      const r = t * Math.tan(theta / 2);
      const T1 = [P[0] + u[0] * t, P[1] + u[1] * t], T2 = [P[0] + v[0] * t, P[1] + v[1] * t];
      changed++;
      if (style === 'chamfer') { res.push(T1, T2); continue; }
      const bis = [u[0] + v[0], u[1] + v[1]], bl = Math.hypot(bis[0], bis[1]);
      const d = r / Math.sin(theta / 2);
      const C = [P[0] + bis[0] / bl * d, P[1] + bis[1] / bl * d];
      let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
      let da = a2 - a1;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(da) * 180 / Math.PI / segDeg));
      for (let k = 0; k <= steps; k++) { const a = a1 + da * k / steps; res.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
    }
    out.push({ closed: poly.closed, pts: res });
  });
  return { polys: out, corners: changed };
}

// Reflection of an object transform {x, y, sx, sy, r} across a line through (cx, cy) at angle deg.
export function reflectTf(tf, deg, cx, cy) {
  const t = 2 * deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const dx = tf.x - cx, dy = tf.y - cy;
  return { ...tf, x: cx + c * dx + s * dy, y: cy + s * dx - c * dy, sy: -tf.sy, r: (((2 * deg - tf.r) % 360) + 360) % 360 };
}

// ---------------------------------------------------------------- path clean-up (Edit menu)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Close open sub-paths whose two ends are within `tol` mm. mode 'join' closes them with a short straight line,
// 'move' moves both ends to their midpoint. `measure` (same structure, e.g. in world mm) decides which ends are
// close enough; the edit itself is applied to `polys`.
export function closeWithin(polys, tol, mode = 'join', measure = polys) {
  let count = 0;
  const out = polys.map((p, i) => {
    const m = measure[i] || p;
    if (p.closed || p.pts.length < 3 || m.pts.length !== p.pts.length) return p;
    const d = dist(m.pts[0], m.pts[m.pts.length - 1]);
    if (d > tol) return p;
    const pts = p.pts.slice(), a = pts[0], z = pts[pts.length - 1];
    if (d < 1e-6) pts.pop();
    else if (mode === 'move') { pts.pop(); pts[0] = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2]; }
    if (pts.length < 3) return p;
    count++;
    return { closed: true, pts };
  });
  return { polys: out, count };
}

// Drop repeated points and points that change the outline by less than `tol` (Ramer–Douglas–Peucker).
// Closed loops are split at the point farthest from the start so both halves simplify cleanly.
export function optimizePolys(polys, tol) {
  const out = [];
  for (const p of polys) {
    let pts = [];
    for (const q of p.pts) if (!pts.length || dist(q, pts[pts.length - 1]) > 1e-6) pts.push(q);
    if (p.closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= 1e-6) pts.pop();
    if (pts.length < 2) continue;
    if (tol > 0 && pts.length > 2) {
      if (p.closed) {
        let far = 0, fd = -1;
        for (let i = 1; i < pts.length; i++) { const d = dist(pts[i], pts[0]); if (d > fd) { fd = d; far = i; } }
        const a = simplify(pts.slice(0, far + 1), tol), b = simplify([...pts.slice(far), pts[0]], tol);
        let s = a.concat(b.slice(1, -1));
        const z = s[s.length - 1];
        // the start point can go too if it sits on a straight edge
        if (s.length > 3 && distToSegment(s[0][0], s[0][1], z[0], z[1], s[1][0], s[1][1]) <= tol) s = s.slice(1);
        if (s.length >= 3) pts = s;
      } else pts = simplify(pts, tol);
    }
    out.push({ closed: p.closed && pts.length >= 3, pts });
  }
  return out;
}

// Fingerprint of an outline for finding duplicates: its points rounded to `grid` mm, ignoring where each loop
// starts and which way it runs.
export function polysKey(polys, grid = 0.01) {
  return polys.filter(p => p.pts.length).map(p => {
    const pts = p.pts.map(([x, y]) => `${Math.round(x / grid) || 0},${Math.round(y / grid) || 0}`);
    if (p.closed && pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
    return `${p.closed ? 'c' : 'o'}${pts.length}:${pts.sort().join(' ')}`;
  }).sort().join('|');
}

// True when every point of `inner` lies inside a closed outline of `outer` (holes in `outer` don't matter).
export function polysInside(inner, outer, bi = boundsOfPolys(inner), bo = boundsOfPolys(outer)) {
  const e = 1e-6;
  if (!(bi.minX >= bo.minX - e && bi.maxX <= bo.maxX + e && bi.minY >= bo.minY - e && bi.maxY <= bo.maxY + e)) return false;
  const rings = outer.filter(p => p.closed && p.pts.length >= 3);
  if (!rings.length || !inner.some(p => p.pts.length)) return false;
  for (const p of inner) {
    const step = Math.max(1, Math.floor(p.pts.length / 400)); // sample long outlines
    for (let i = 0; i < p.pts.length; i += step) {
      const [x, y] = p.pts[i];
      if (!rings.some(r => pointInPoly(x, y, r.pts))) return false;
    }
  }
  return true;
}

// Evenly spaced points along a polyline, with the direction of travel there in degrees (0 = +X; positive turns
// clockwise on screen, like object rotation). Closed: `count` points around the loop; open: `count` points from one
// end to the other. With spacing > 0: one point every `spacing` mm instead.
export function samplePath(pts, closed, count, spacing = 0) {
  const ring = closed ? [...pts, pts[0]] : pts;
  if (ring.length < 2) return [];
  const cum = cumLengths(ring), L = cum[cum.length - 1];
  if (!(L > 1e-9)) return [];
  const ss = [];
  if (spacing > 0) {
    const n = Math.min(100000, Math.floor(L / spacing + 1e-9) + (closed ? 0 : 1));
    for (let i = 0; i < n; i++) ss.push(i * spacing);
  } else {
    const n = Math.max(1, Math.round(count));
    for (let i = 0; i < n; i++) ss.push(closed ? L * i / n : n > 1 ? L * i / (n - 1) : 0);
  }
  return ss.map(s => {
    let i = 1;
    while (i < ring.length - 1 && cum[i] <= s) i++; // at a corner, face along the next edge
    while (i < ring.length - 1 && cum[i] - cum[i - 1] < 1e-9) i++; // skip zero-length segments
    const a = ring[i - 1], b = ring[i], [x, y] = pointAt(ring, cum, s);
    return { x, y, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI };
  });
}

// Dock: slide each box in `dir` ('left' | 'right' | 'up' | 'down'; up = -Y) until it touches an obstacle box it
// overlaps across the direction of travel, or the edge of `area`, leaving `pad` mm. Obstacles it already overlaps are
// ignored (so a shape inside a frame slides out through the frame's inner edge). Boxes nearest the target edge go
// first and then block the others. Returns [dx, dy] for each box; nothing ever moves backwards.
export function dockBoxes(boxes, obstacles, area, dir, pad = 0) {
  const horiz = dir === 'left' || dir === 'right', neg = dir === 'left' || dir === 'up';
  const lo = horiz ? 'minX' : 'minY', hi = horiz ? 'maxX' : 'maxY';
  const plo = horiz ? 'minY' : 'minX', phi = horiz ? 'maxY' : 'maxX';
  const e = 1e-7, obs = obstacles.slice(), out = new Array(boxes.length);
  const order = boxes.map((_, i) => i).sort((a, c) => (neg ? boxes[a][lo] - boxes[c][lo] : boxes[c][hi] - boxes[a][hi]));
  for (const i of order) {
    const b = boxes[i];
    let travel = neg ? b[lo] - (area[lo] + pad) : area[hi] - pad - b[hi];
    for (const o of obs) {
      if (o[plo] >= b[phi] - e || o[phi] <= b[plo] + e) continue; // not in the way
      const gap = neg ? b[lo] - o[hi] : o[lo] - b[hi];
      if (gap < -e) continue; // already overlapping, or behind
      travel = Math.min(travel, gap - pad);
    }
    const d = neg ? -Math.max(0, travel) : Math.max(0, travel);
    out[i] = horiz ? [d, 0] : [0, d];
    obs.push({ ...b, [lo]: b[lo] + d, [hi]: b[hi] + d });
  }
  return out;
}

// ---------------------------------------------------------------- node editing
// Break sub-path pi at vertex vi: a closed loop opens there (that vertex becomes both ends); an open path splits in
// two. Returns the new sub-path list, or null if the vertex is already an end.
export function breakAt(polys, pi, vi) {
  const p = polys[pi];
  if (!p) return null;
  const n = p.pts.length;
  let parts;
  if (p.closed) {
    if (n < 2) return null;
    parts = [{ closed: false, pts: [...p.pts.slice(vi), ...p.pts.slice(0, vi), p.pts[vi]] }];
  } else {
    if (vi <= 0 || vi >= n - 1) return null;
    parts = [{ closed: false, pts: p.pts.slice(0, vi + 1) }, { closed: false, pts: p.pts.slice(vi) }];
  }
  return [...polys.slice(0, pi), ...parts, ...polys.slice(pi + 1)];
}
// Delete the line from vertex i to the next one (on a closed loop i = n - 1 is the closing line). A closed loop
// becomes an open path; an open path splits in two (pieces shorter than a line are dropped).
export function removeSegment(polys, pi, i) {
  const p = polys[pi];
  if (!p) return null;
  const n = p.pts.length;
  let parts;
  if (p.closed) {
    if (i < 0 || i >= n) return null;
    const j = (i + 1) % n;
    parts = [{ closed: false, pts: [...p.pts.slice(j), ...p.pts.slice(0, j)] }];
  } else {
    if (i < 0 || i >= n - 1) return null;
    parts = [{ closed: false, pts: p.pts.slice(0, i + 1) }, { closed: false, pts: p.pts.slice(i + 1) }];
  }
  return [...polys.slice(0, pi), ...parts.filter(q => q.pts.length >= 2), ...polys.slice(pi + 1)];
}
