// Design objects -> outlines in world (bed) millimetres, with caching.
import * as G from './geom.js';
import { textLocal } from './raster.js';

// Variable text: {serial}, {serial:4} (zero-padded), {date}, {time}, {year}, {month}, {day}
// CSV merge: {csv:Column} (by header name) or {col:N} (1-based) from the current row of the loaded CSV.
export const textVars = { serial: 1, csv: null, csvRow: 0 };
function csvField(key) {
  const c = textVars.csv; if (!c || !c.rows.length) return `{${key}}`;
  const row = c.rows[Math.min(textVars.csvRow, c.rows.length - 1)] || [];
  if (/^\d+$/.test(key)) return row[+key - 1] ?? '';
  const i = c.headers.findIndex(h => h.trim().toLowerCase() === key.trim().toLowerCase());
  return i < 0 ? `{csv:${key}}` : (row[i] ?? '');
}
export function resolveText(t) {
  if (!t || t.indexOf('{') < 0) return t;
  t = t.replace(/\{csv:([^}]+)\}/g, (m, k) => csvField(k)).replace(/\{col:(\d+)\}/g, (m, k) => csvField(k));
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  return t.replace(/\{(serial)(?::(\d+))?\}|\{(date|time|year|month|day)\}/g, (m, ser, pad, k) => {
    if (ser) return String(textVars.serial).padStart(pad ? +pad : 0, '0');
    return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
      year: String(d.getFullYear()), month: p2(d.getMonth() + 1), day: p2(d.getDate()) }[k];
  });
}

export function localPolys(o) {
  switch (o.type) {
    case 'rect': return [{ closed: true, pts: G.rectPts(o.w, o.h, o.radius) }];
    case 'ellipse': return [{ closed: true, pts: G.ellipsePts(o.w / 2, o.h / 2) }];
    case 'polygon': return [{ closed: true, pts: G.polygonPts(o.sides, o.w, o.h, o.star) }];
    case 'path': return o.polys;
    case 'text': return textLocal({ ...o, text: resolveText(o.text) }).polys;
    case 'image': return [{ closed: true, pts: [[-o.w / 2, -o.h / 2], [o.w / 2, -o.h / 2], [o.w / 2, o.h / 2], [-o.w / 2, o.h / 2]] }];
  }
  return [];
}

const cache = new WeakMap();
function geomKey(o) {
  const t = o.tf;
  const g = o.type === 'text' ? [resolveText(o.text), o.font, o.size, o.bold, o.italic, o.align].join('\u0001')
    : o.type === 'path' ? '' : [o.w, o.h, o.radius, o.sides, o.star].join(',');
  return `${o.type}|${t.x},${t.y},${t.sx},${t.sy},${t.r}|${g}`;
}
function entry(o) {
  const k = geomKey(o);
  let e = cache.get(o);
  if (!e || e.k !== k || e.polysRef !== o.polys) {
    const polys = G.transformPolys(localPolys(o), G.tfMatrix(o.tf));
    e = { k, polysRef: o.polys, polys, bounds: G.boundsOfPolys(polys), path: null };
    cache.set(o, e);
  }
  return e;
}
export const worldPolys = o => entry(o).polys;
export const objBounds = o => entry(o).bounds;
export function worldPath(o) {
  const e = entry(o);
  if (!e.path) {
    const p = new Path2D();
    for (const q of e.polys) {
      if (q.pts.length < 2) continue;
      p.moveTo(q.pts[0][0], q.pts[0][1]);
      for (let i = 1; i < q.pts.length; i++) p.lineTo(q.pts[i][0], q.pts[i][1]);
      if (q.closed) p.closePath();
    }
    e.path = p;
  }
  return e.path;
}

export function hitObject(o, x, y, tol, solid) {
  const b = objBounds(o);
  if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) return false;
  if (solid || o.type === 'image' || o.type === 'text') return true;
  for (const q of worldPolys(o)) {
    if (q.closed && q.pts.length > 2 && G.pointInPoly(x, y, q.pts)) return true;
    const n = q.pts.length;
    for (let i = 1; i < n + (q.closed ? 1 : 0); i++) {
      const a = q.pts[i - 1], c = q.pts[i % n];
      if (G.distToSegment(x, y, a[0], a[1], c[0], c[1]) <= tol) return true;
    }
  }
  return false;
}
