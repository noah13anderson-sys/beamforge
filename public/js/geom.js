// Geometry: affine matrices, shape outlines, SVG path + DXF parsing, simplification.
// Matrices are [a, b, c, d, e, f] mapping (x, y) -> (a*x + c*y + e, b*x + d*y + f).

export const D2R = Math.PI / 180;

export function tfMatrix(tf) {
  const c = Math.cos(tf.r * D2R), s = Math.sin(tf.r * D2R);
  return [c * tf.sx, s * tf.sx, -s * tf.sy, c * tf.sy, tf.x, tf.y];
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export function multiply(A, B) { // A ∘ B (apply B first)
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
export const rotation = deg => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [c, s, -s, c, 0, 0]; };

export function transformPolys(polys, m) {
  return polys.map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => apply(m, x, y)) }));
}

// ---------------------------------------------------------------- bounds
export const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const boundsValid = b => b && b.minX <= b.maxX && b.minY <= b.maxY;
export function boundsOfPolys(polys, b = emptyBounds()) {
  for (const p of polys) for (const [x, y] of p.pts) {
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
  }
  return b;
}
export function unionBounds(a, b) {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

// ---------------------------------------------------------------- primitive shapes (centred on 0,0)
function arcPts(out, cx, cy, rx, ry, a0, a1, segLen = 0.25) {
  const n = Math.max(4, Math.min(720, Math.ceil(Math.abs(a1 - a0) * Math.max(rx, ry) / segLen)));
  for (let i = 0; i <= n; i++) {
    const t = a0 + (a1 - a0) * i / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
}

export function rectPts(w, h, r = 0) {
  const hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r || 0, hw, hh));
  if (r <= 0) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const pts = [], q = Math.PI / 2;
  arcPts(pts, hw - r, -hh + r, r, r, -q, 0);
  arcPts(pts, hw - r, hh - r, r, r, 0, q);
  arcPts(pts, -hw + r, hh - r, r, r, q, 2 * q);
  arcPts(pts, -hw + r, -hh + r, r, r, 2 * q, 3 * q);
  return pts;
}

export function ellipsePts(rx, ry) {
  const pts = [];
  arcPts(pts, 0, 0, rx, ry, 0, 2 * Math.PI);
  pts.pop();
  return pts;
}

// Regular polygon or star inscribed in a w×h box. `star` is the inner radius ratio (0 = plain polygon).
export function polygonPts(sides, w, h, star = 0) {
  sides = Math.max(3, Math.round(sides));
  const pts = [], n = star > 0 ? sides * 2 : sides;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    const k = star > 0 && i % 2 ? star : 1;
    pts.push([Math.cos(a) * k, Math.sin(a) * k]);
  }
  const b = boundsOfPolys([{ pts }]);
  const sx = w / (b.maxX - b.minX || 1), sy = h / (b.maxY - b.minY || 1);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return pts.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]);
}

// ---------------------------------------------------------------- tests
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

// Ramer–Douglas–Peucker, iterative.
export function simplify(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = L < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (ay - py) - dy * (ax - px)) / L;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- SVG path data
function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol) {
  const L = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = Math.max(2, Math.min(256, Math.ceil(L / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
}
function flattenQuad(out, x0, y0, x1, y1, x2, y2, tol) {
  const L = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.min(256, Math.ceil(L / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    out.push([mt * mt * x0 + 2 * mt * t * x1 + t * t * x2, mt * mt * y0 + 2 * mt * t * y1 + t * t * y2]);
  }
}
// SVG elliptical arc (endpoint parameterisation, SVG spec appendix F.6).
function flattenArc(out, x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, tol) {
  if (!rx || !ry) { out.push([x2, y2]); return; }
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = phiDeg * D2R, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(dth) * Math.max(rx, ry) / tol)));
  for (let i = 1; i <= n; i++) {
    const t = th1 + dth * i / n, px = rx * Math.cos(t), py = ry * Math.sin(t);
    out.push([c * px - s * py + cx, s * px + c * py + cy]);
  }
}

// Parse an SVG path `d` string into polylines. `tol` is the max segment length in path units.
export function parseSvgPath(d, tol = 0.5) {
  const polys = [];
  let p = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0, cur = null, lastCtl = null, lastCmd = '';
  const numRe = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
  const skip = () => { while (p < d.length && /[\s,]/.test(d[p])) p++; };
  const num = () => {
    skip(); numRe.lastIndex = p;
    const m = numRe.exec(d);
    if (!m) throw new Error('Bad path data');
    p = numRe.lastIndex; return +m[0];
  };
  const flag = () => { skip(); const c = d[p++]; if (c !== '0' && c !== '1') throw new Error('Bad arc flag'); return c === '1'; };
  const ensure = () => { if (!cur) { cur = { closed: false, pts: [[cx, cy]] }; polys.push(cur); } return cur.pts; };

  while (true) {
    skip();
    if (p >= d.length) break;
    if (/[a-zA-Z]/.test(d[p])) cmd = d[p++];
    else if (!cmd) break;
    const rel = cmd >= 'a', C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    try {
      switch (C) {
        case 'M': {
          const x = num() + ox, y = num() + oy;
          cur = { closed: false, pts: [[x, y]] }; polys.push(cur);
          cx = sx = x; cy = sy = y; cmd = rel ? 'l' : 'L'; lastCtl = null; break;
        }
        case 'L': { const x = num() + ox, y = num() + oy; ensure().push([x, y]); cx = x; cy = y; lastCtl = null; break; }
        case 'H': { const x = num() + ox; ensure().push([x, cy]); cx = x; lastCtl = null; break; }
        case 'V': { const y = num() + oy; ensure().push([cx, y]); cy = y; lastCtl = null; break; }
        case 'C': {
          const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
          flattenCubic(ensure(), cx, cy, x1, y1, x2, y2, x, y, tol); lastCtl = [x2, y2]; cx = x; cy = y; break;
        }
        case 'S': {
          const x1 = /[CS]/.test(lastCmd) && lastCtl ? 2 * cx - lastCtl[0] : cx;
          const y1 = /[CS]/.test(lastCmd) && lastCtl ? 2 * cy - lastCtl[1] : cy;
          const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
          flattenCubic(ensure(), cx, cy, x1, y1, x2, y2, x, y, tol); lastCtl = [x2, y2]; cx = x; cy = y; break;
        }
        case 'Q': {
          const x1 = num() + ox, y1 = num() + oy, x = num() + ox, y = num() + oy;
          flattenQuad(ensure(), cx, cy, x1, y1, x, y, tol); lastCtl = [x1, y1]; cx = x; cy = y; break;
        }
        case 'T': {
          const x1 = /[QT]/.test(lastCmd) && lastCtl ? 2 * cx - lastCtl[0] : cx;
          const y1 = /[QT]/.test(lastCmd) && lastCtl ? 2 * cy - lastCtl[1] : cy;
          const x = num() + ox, y = num() + oy;
          flattenQuad(ensure(), cx, cy, x1, y1, x, y, tol); lastCtl = [x1, y1]; cx = x; cy = y; break;
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), x = num() + ox, y = num() + oy;
          flattenArc(ensure(), cx, cy, rx, ry, rot, fa, fs, x, y, tol); cx = x; cy = y; lastCtl = null; break;
        }
        case 'Z': {
          if (cur) cur.closed = true;
          cx = sx; cy = sy; cur = null; lastCtl = null; lastCmd = 'Z'; cmd = ''; continue;
        }
        default: return polys.filter(q => q.pts.length > 1); // unknown command: stop
      }
    } catch { break; }
    lastCmd = C;
  }
  // A closed path whose last point repeats the first: drop the duplicate.
  for (const q of polys) {
    if (q.closed && q.pts.length > 2) {
      const a = q.pts[0], b = q.pts[q.pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) q.pts.pop();
    }
  }
  return polys.filter(q => q.pts.length > 1);
}

// ---------------------------------------------------------------- DXF (R12+ ASCII)
// Returns polylines in millimetres with DXF's Y-up orientation.
export function parseDxf(text) {
  const raw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
  let unitScale = 1;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      const u = parseInt(pairs[i + 1][1], 10);
      unitScale = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 }[u] || 1;
    }
  }
  // Collect entities
  const ents = [];
  let inEnt = false, cur = null;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION' && pairs[i + 1] && pairs[i + 1][1] === 'ENTITIES') { inEnt = true; i++; continue; }
    if (!inEnt) continue;
    if (c === 0) {
      if (cur) ents.push(cur);
      if (v === 'ENDSEC') { inEnt = false; cur = null; continue; }
      cur = { type: v, codes: [] };
    } else if (cur) cur.codes.push([c, v]);
  }
  if (cur) ents.push(cur);

  const polys = [];
  const get = (e, code, def = 0) => { const f = e.codes.find(x => x[0] === code); return f ? parseFloat(f[1]) : def; };
  const bulgeTo = (out, x1, y1, x2, y2, b) => {
    if (Math.abs(b) < 1e-9) { out.push([x2, y2]); return; }
    const th = 4 * Math.atan(b), dx = x2 - x1, dy = y2 - y1, dd = Math.hypot(dx, dy);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, off = (dd / 2) / Math.tan(th / 2);
    const cx = mx - dy / dd * off, cy = my + dx / dd * off;
    const r = Math.hypot(x1 - cx, y1 - cy), a0 = Math.atan2(y1 - cy, x1 - cx);
    const n = Math.max(2, Math.ceil(Math.abs(th) * r / 0.25));
    for (let k = 1; k <= n; k++) { const a = a0 + th * k / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  const verts = e => { // vertices with bulges from repeated 10/20/42 codes
    const vs = []; let v = null;
    for (const [c, val] of e.codes) {
      if (c === 10) { v = { x: +val, y: 0, b: 0 }; vs.push(v); }
      else if (c === 20 && v) v.y = +val;
      else if (c === 42 && v) v.b = +val;
    }
    return vs;
  };
  const emitVerts = (vs, closed) => {
    if (vs.length < 2) return;
    const pts = [[vs[0].x, vs[0].y]];
    for (let i = 1; i < vs.length; i++) bulgeTo(pts, vs[i - 1].x, vs[i - 1].y, vs[i].x, vs[i].y, vs[i - 1].b);
    if (closed) { const l = vs[vs.length - 1]; bulgeTo(pts, l.x, l.y, vs[0].x, vs[0].y, l.b); pts.pop(); }
    polys.push({ closed, pts });
  };

  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    switch (e.type) {
      case 'LINE': polys.push({ closed: false, pts: [[get(e, 10), get(e, 20)], [get(e, 11), get(e, 21)]] }); break;
      case 'LWPOLYLINE': emitVerts(verts(e), (get(e, 70) & 1) === 1); break;
      case 'POLYLINE': {
        const closed = (get(e, 70) & 1) === 1, vs = [];
        while (ents[i + 1] && ents[i + 1].type === 'VERTEX') { i++; vs.push({ x: get(ents[i], 10), y: get(ents[i], 20), b: get(ents[i], 42) }); }
        emitVerts(vs, closed); break;
      }
      case 'CIRCLE': {
        const pts = []; arcPts(pts, get(e, 10), get(e, 20), get(e, 40), get(e, 40), 0, 2 * Math.PI); pts.pop();
        polys.push({ closed: true, pts }); break;
      }
      case 'ARC': {
        let a0 = get(e, 50) * D2R, a1 = get(e, 51) * D2R;
        if (a1 <= a0) a1 += 2 * Math.PI;
        const pts = []; arcPts(pts, get(e, 10), get(e, 20), get(e, 40), get(e, 40), a0, a1);
        polys.push({ closed: false, pts }); break;
      }
      case 'ELLIPSE': {
        const cx = get(e, 10), cy = get(e, 20), mx = get(e, 11), my = get(e, 21), ratio = get(e, 40, 1);
        let t0 = get(e, 41, 0), t1 = get(e, 42, 2 * Math.PI);
        if (t1 <= t0) t1 += 2 * Math.PI;
        const a = Math.hypot(mx, my), rot = Math.atan2(my, mx), b = a * ratio;
        const n = Math.max(16, Math.ceil((t1 - t0) * a / 0.25)), pts = [];
        for (let k = 0; k <= n; k++) {
          const t = t0 + (t1 - t0) * k / n, px = a * Math.cos(t), py = b * Math.sin(t);
          pts.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
        }
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
        if (full) pts.pop();
        polys.push({ closed: full, pts }); break;
      }
      case 'SPLINE': { // approximate with a B-spline through the control points (uniform)
        const ctl = verts(e).map(v => [v.x, v.y]);
        if (ctl.length < 2) break;
        if (ctl.length < 4) { polys.push({ closed: false, pts: ctl }); break; }
        const pts = [ctl[0]];
        for (let k = 0; k < ctl.length - 3; k++) {
          const [p0, p1, p2, p3] = [ctl[k], ctl[k + 1], ctl[k + 2], ctl[k + 3]];
          for (let s = 1; s <= 12; s++) {
            const t = s / 12, t2 = t * t, t3 = t2 * t;
            const b0 = (1 - 3 * t + 3 * t2 - t3) / 6, b1 = (4 - 6 * t2 + 3 * t3) / 6, b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, b3 = t3 / 6;
            pts.push([b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]]);
          }
        }
        pts.push(ctl[ctl.length - 1]);
        polys.push({ closed: (get(e, 70) & 1) === 1, pts }); break;
      }
    }
  }
  if (unitScale !== 1) for (const q of polys) q.pts = q.pts.map(([x, y]) => [x * unitScale, y * unitScale]);
  return polys;
}
