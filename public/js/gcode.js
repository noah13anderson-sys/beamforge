// Turns the design into laser G-code for the selected controller, plus a preview toolpath and stats.
import * as G from './geom.js';
import { worldPolys, objBounds } from './shapes.js';
import { makeCanvas, imageSource, imageFilter, dither } from './raster.js';
import { offset, concentric, splitTabs, dashes, hull } from './ops.js';
import { profile, family, mapToMachine, rotaryScale } from './devices.js';
import { encodeJob } from './ruida.js';

export const fmt = v => {
  if (Math.abs(v) < 0.0005) return '0';
  return v.toFixed(3).replace(/\.?0+$/, '');
};

// Tracks position, time/length stats and the preview toolpath; subclasses decide what is written.
class Emitter {
  constructor(cfg, offset) {
    this.cfg = cfg; this.off = offset;
    this.x = null; this.y = null;      // current position, design coords
    this.time = 0; this.cutLen = 0; this.travelLen = 0;
    this.seg = new Float32Array(1 << 15); this.segN = 0;
    this.travelF = Math.max(1, cfg.travel * 60);
  }
  m(x, y) { const [a, b] = mapToMachine(this.cfg, x, y); return [a + this.off[0], b + this.off[1]]; }
  sval(pct) {
    const v = Math.max(0, Math.min(100, pct)) / 100 * this.cfg.sMax;
    return this.cfg.sMax <= 1 ? Math.round(v * 1000) / 1000 : Math.round(v);
  }
  push(x1, y1, x2, y2, p) {
    if (this.segN + 5 > this.seg.length) { const n = new Float32Array(this.seg.length * 2); n.set(this.seg); this.seg = n; }
    this.seg.set([x1, y1, x2, y2, p], this.segN); this.segN += 5;
  }
  line() { /* comments/raw lines: G-code only */ }
  rapid(x, y) {
    if (this.x !== null && Math.abs(x - this.x) < 1e-6 && Math.abs(y - this.y) < 1e-6) return;
    const [mx, my] = this.m(x, y);
    this.outRapid(mx, my);
    if (this.x !== null) {
      const d = Math.hypot(x - this.x, y - this.y);
      this.travelLen += d; this.time += d / this.travelF * 60;
      this.push(this.x, this.y, x, y, -1);
    }
    this.x = x; this.y = y;
  }
  burn(x, y, pct, feed) {
    if (this.x !== null && Math.abs(x - this.x) < 1e-6 && Math.abs(y - this.y) < 1e-6) return;
    const S = this.sval(pct);
    const [mx, my] = this.m(x, y);
    this.outBurn(mx, my, S, feed);
    if (this.x !== null) {
      const d = Math.hypot(x - this.x, y - this.y);
      this.time += d / feed * 60;
      if (S > 0) this.cutLen += d;
      this.push(this.x, this.y, x, y, S / this.cfg.sMax);
    }
    this.x = x; this.y = y;
  }
}

class GcodeEmitter extends Emitter {
  constructor(cfg, offset) { super(cfg, offset); this.out = []; this.mF = null; this.mS = null; }
  line(s) { this.out.push(s); }
  outRapid(mx, my) { this.out.push(`G0 X${fmt(mx)} Y${fmt(my)}`); }
  outBurn(mx, my, S, feed) {
    let l = `G1 X${fmt(mx)} Y${fmt(my)}`;
    if (S !== this.mS) { l += ` S${this.cfg.sMax <= 1 ? fmt(S) : S}`; this.mS = S; }
    if (feed !== this.mF) { l += ` F${feed}`; this.mF = feed; }
    this.out.push(l);
  }
}

// Collects moves per layer in Ruida machine micrometres; refuses anything outside the work area.
class RuidaEmitter extends Emitter {
  constructor(cfg, offset) { super(cfg, offset); this.layers = []; this.cur = null; this.count = 0; }
  startLayer(L) {
    this.cur = { speed: L.speed, minPower: L.minPower > 0 ? L.minPower : L.power, maxPower: L.power, color: L.color, air: !!L.air, cmds: [] };
    this.layers.push(this.cur);
  }
  um(mx, my, strict) {
    const W = this.cfg.bedW, H = this.cfg.bedH * rotaryScale(this.cfg), tol = 0.01;
    if (strict && (mx < -tol || my < -tol || mx > W + tol || my > H + tol))
      throw new Error(`The job goes outside the ${W}×${this.cfg.bedH} mm work area (at X${mx.toFixed(1)} Y${my.toFixed(1)}). Move it fully onto the bed.`);
    return [Math.round(Math.max(0, Math.min(W, mx)) * 1000), Math.round(Math.max(0, Math.min(H, my)) * 1000)];
  }
  outRapid(mx, my) { this.cur.cmds.push([0, ...this.um(mx, my, false)]); this.count++; } // overscan may be clamped
  outBurn(mx, my, S) { this.cur.cmds.push([S > 0 ? 1 : 0, ...this.um(mx, my, S > 0)]); this.count++; }
}

// ---------------------------------------------------------------- vector cuts
// Inner shapes first (so parts don't drop before their holes are cut), then nearest-neighbour order.
function orderPolys(polys, sx, sy) {
  const items = polys.map(p => ({ p, b: G.boundsOfPolys([p]), depth: 0 }));
  if (items.length < 4000) {
    for (const a of items) {
      for (const c of items) {
        if (a === c || !c.p.closed || c.p.pts.length < 3) continue;
        const ab = a.b, cb = c.b;
        if (ab.minX >= cb.minX && ab.maxX <= cb.maxX && ab.minY >= cb.minY && ab.maxY <= cb.maxY &&
          G.pointInPoly(a.p.pts[0][0], a.p.pts[0][1], c.p.pts)) a.depth++;
      }
    }
  }
  const depths = [...new Set(items.map(i => i.depth))].sort((a, b) => b - a);
  const out = [];
  let x = sx, y = sy;
  for (const d of depths) {
    const pool = items.filter(i => i.depth === d);
    while (pool.length) {
      let best = 0, bestD = Infinity, bestIdx = 0, bestRev = false;
      for (let i = 0; i < pool.length; i++) {
        const pts = pool[i].p.pts;
        if (pool[i].p.closed) {
          const step = Math.max(1, Math.floor(pts.length / 200)); // sample long outlines
          for (let k = 0; k < pts.length; k += step) {
            const dd = (pts[k][0] - x) ** 2 + (pts[k][1] - y) ** 2;
            if (dd < bestD) { bestD = dd; best = i; bestIdx = k; bestRev = false; }
          }
        } else {
          const a = pts[0], z = pts[pts.length - 1];
          const da = (a[0] - x) ** 2 + (a[1] - y) ** 2, dz = (z[0] - x) ** 2 + (z[1] - y) ** 2;
          if (da < bestD) { bestD = da; best = i; bestRev = false; }
          if (dz < bestD) { bestD = dz; best = i; bestRev = true; }
        }
      }
      const it = pool.splice(best, 1)[0];
      let pts = it.p.pts;
      if (it.p.closed) pts = pts.slice(bestIdx).concat(pts.slice(0, bestIdx));
      else if (bestRev) pts = pts.slice().reverse();
      out.push({ closed: it.p.closed, pts });
      const last = it.p.closed ? pts[0] : pts[pts.length - 1];
      x = last[0]; y = last[1];
    }
  }
  return out;
}

// Burn a polyline, honouring perforation settings.
function burnPath(em, pts, L, F) {
  em.rapid(pts[0][0], pts[0][1]);
  if (L.perf && L.perfCut > 0 && L.perfSkip > 0) {
    for (const d of dashes(pts, L.perfCut, L.perfSkip)) {
      for (let i = 1; i < d.pts.length; i++) em.burn(d.pts[i][0], d.pts[i][1], d.on ? L.power : 0, F);
    }
  } else {
    for (let i = 1; i < pts.length; i++) em.burn(pts[i][0], pts[i][1], L.power, F);
  }
}

function emitLines(em, objs, L) {
  let polys = objs.flatMap(o => worldPolys(o)).filter(p => p.pts.length >= 2);
  if (L.kerf) { // grow parts / shrink holes by half the beam width
    const closed = polys.filter(p => p.closed && p.pts.length >= 3);
    const open = polys.filter(p => !(p.closed && p.pts.length >= 3));
    polys = [...offset(closed, L.kerf / 2, { join: 'round' }), ...open];
  }
  const F = Math.round(L.speed * 60);
  const tabs = L.tabs ? { count: L.tabCount, spacing: L.tabSpacing, width: L.tabWidth } : null;
  for (const p of orderPolys(polys, em.x ?? 0, em.y ?? 0)) {
    const pieces = tabs ? splitTabs(p.pts, p.closed, tabs) : [p.closed ? [...p.pts, p.pts[0]] : p.pts];
    for (const pts of pieces) if (pts.length >= 2) burnPath(em, pts, L, F);
  }
}

// Offset fill: concentric rings stepping inward by the line interval.
function emitOffsetFill(em, objs, L) {
  const rings = concentric(objs.flatMap(o => worldPolys(o)), L.interval);
  const F = Math.round(L.speed * 60);
  for (const r of rings) {
    let best = 0, bd = Infinity;
    const x = em.x ?? 0, y = em.y ?? 0;
    r.pts.forEach(([px, py], i) => { const d = (px - x) ** 2 + (py - y) ** 2; if (d < bd) { bd = d; best = i; } });
    const pts = r.pts.slice(best).concat(r.pts.slice(0, best + 1));
    burnPath(em, pts, L, F);
  }
}

// ---------------------------------------------------------------- scanline rasters
function emitRows(em, W, H, getRow, toWorld, L, lvlToPct) {
  const F = Math.round(L.speed * 60);
  const ov = (L.overscan || 0) / L.interval;
  let k = 0;
  for (let r = 0; r < H; r++) {
    const row = getRow(r);
    let a = -1, b = -1;
    for (let i = 0; i < W; i++) if (row[i]) { a = i; break; }
    if (a < 0) continue;
    for (let i = W - 1; i >= 0; i--) if (row[i]) { b = i; break; }
    const fwd = !L.bidir || k % 2 === 0; k++;
    const y = r + 0.5, dir = fwd ? 1 : -1;
    const start = fwd ? a : b + 1, end = fwd ? b + 1 : a;
    let p = toWorld(start - dir * ov, y); em.rapid(p[0], p[1]);
    p = toWorld(start, y); em.burn(p[0], p[1], 0, F);
    if (fwd) {
      for (let i = a; i <= b;) {
        const v = row[i]; let j = i;
        while (j <= b && row[j] === v) j++;
        p = toWorld(j, y); em.burn(p[0], p[1], v ? lvlToPct(v) : 0, F);
        i = j;
      }
    } else {
      for (let i = b; i >= a;) {
        const v = row[i]; let j = i;
        while (j >= a && row[j] === v) j--;
        p = toWorld(j + 1, y); em.burn(p[0], p[1], v ? lvlToPct(v) : 0, F);
        i = j;
      }
    }
    p = toWorld(end + dir * ov, y); em.burn(p[0], p[1], 0, F);
  }
}

function emitFill(em, objs, L, angle) {
  const R = G.rotation(-angle), Rinv = G.rotation(angle);
  const groups = objs.map(o => G.transformPolys(worldPolys(o).filter(p => p.pts.length >= 3), R));
  let b = G.emptyBounds();
  for (const g of groups) b = G.boundsOfPolys(g, b);
  if (!G.boundsValid(b)) return;
  const iv = L.interval;
  const W = Math.ceil((b.maxX - b.minX) / iv) + 1, H = Math.ceil((b.maxY - b.minY) / iv) + 1;
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.setTransform(1 / iv, 0, 0, 1 / iv, -b.minX / iv, -b.minY / iv);
  ctx.fillStyle = '#000';
  for (const g of groups) {
    const p = new Path2D();
    for (const q of g) { p.moveTo(q.pts[0][0], q.pts[0][1]); for (let i = 1; i < q.pts.length; i++) p.lineTo(q.pts[i][0], q.pts[i][1]); p.closePath(); }
    ctx.fill(p, 'evenodd');
  }
  const data = ctx.getImageData(0, 0, W, H).data;
  const row = new Uint8Array(W);
  const getRow = r => { for (let i = 0; i < W; i++) row[i] = data[(r * W + i) * 4 + 3] >= 128 ? 255 : 0; return row; };
  const toWorld = (px, py) => G.apply(Rinv, b.minX + px * iv, b.minY + py * iv);
  emitRows(em, W, H, getRow, toWorld, L, () => L.power);
}

function emitImage(em, objs, L) {
  let b = G.emptyBounds();
  for (const o of objs) b = G.unionBounds(b, objBounds(o));
  if (!G.boundsValid(b)) return;
  const iv = L.interval;
  const W = Math.ceil((b.maxX - b.minX) / iv), H = Math.ceil((b.maxY - b.minY) / iv);
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  for (const o of objs) {
    const img = imageSource(o);
    if (!img) throw new Error('An image has not finished loading. Try again in a moment.');
    const m = G.multiply([1 / iv, 0, 0, 1 / iv, -b.minX / iv, -b.minY / iv], G.tfMatrix(o.tf));
    ctx.setTransform(...m);
    ctx.filter = imageFilter(o);
    ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
    ctx.filter = 'none';
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const levels = new Uint8Array(W * H);
  const grayscale = L.dither === 'grayscale';
  if (grayscale) {
    for (let i = 0; i < gray.length; i++) { const dark = 255 - gray[i]; levels[i] = dark < 3 ? 0 : Math.round(dark); }
  } else {
    const bits = dither(gray, W, H, L.dither, L.threshold ?? 128, { cell: L.halftoneCell, angle: L.halftoneAngle });
    for (let i = 0; i < bits.length; i++) levels[i] = bits[i] ? 255 : 0;
  }
  const lvl = grayscale ? v => L.minPower + (L.power - L.minPower) * v / 255 : () => L.power;
  emitRows(em, W, H, r => levels.subarray(r * W, r * W + W), (px, py) => [b.minX + px * iv, b.minY + py * iv], L, lvl);
}

// ---------------------------------------------------------------- job
export function outputObjects(doc, opts) {
  const pool = opts.selectedIds ? doc.objects.filter(o => opts.selectedIds.has(o.id)) : doc.objects;
  const out = [];
  for (const L of doc.layers) {
    if (!L.output) continue;
    const objs = pool.filter(o => o.layer === L.id && (L.mode === 'image' ? o.type === 'image' : o.type !== 'image'));
    if (objs.length) out.push({ L, objs });
  }
  return out;
}

export function jobBounds(groups) {
  let b = G.emptyBounds();
  for (const { objs } of groups) for (const o of objs) b = G.unionBounds(b, objBounds(o));
  return G.boundsValid(b) ? b : null;
}

// Offset added to machine coordinates so the job's anchor (as seen on screen) lands on the head position.
export function jobOffset(b, cfg, opts) {
  if (opts.startFrom !== 'current' || !b) return [0, 0];
  const design = {
    bl: [b.minX, b.maxY], br: [b.maxX, b.maxY], tl: [b.minX, b.minY], tr: [b.maxX, b.minY],
    c: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2],
  }[opts.anchor] || [b.minX, b.maxY];
  const [ax, ay] = mapToMachine(cfg, design[0], design[1]);
  const [px, py] = opts.position || [0, 0];
  return [px - ax, py - ay];
}

// Applies the device power limit and the dry-run switch to a layer.
function effectiveLayer(L, cfg, opts) {
  const cap = Math.max(0, Math.min(100, cfg.powerLimit ?? 100));
  const out = { ...L, power: Math.min(L.power, cap), minPower: Math.min(L.minPower || 0, cap) };
  if (opts.dryRun) { out.power = 0; out.minPower = 0; out.air = false; }
  if (family(cfg) === 'ruida' && out.dither === 'grayscale') out.dither = 'floyd'; // per-pixel power not supported yet
  return out;
}

function emitLayer(em, cfg, L, objs, pass) {
  if (L.mode === 'line') emitLines(em, objs, L);
  else if (L.mode === 'offset') emitOffsetFill(em, objs, L);
  else if (L.mode === 'fill') {
    const sets = L.fillGroups === 'individual' ? objs.map(o => [o]) : [objs];
    for (const set of sets) {
      emitFill(em, set, L, L.angle || 0);
      if (L.crosshatch) emitFill(em, set, L, (L.angle || 0) + 90);
    }
  } else if (L.mode === 'image') emitImage(em, objs, L);
}

export function generateJob(doc, cfg, opts = {}) {
  const groups = outputObjects(doc, opts);
  const b = jobBounds(groups);
  if (!b) throw new Error('Nothing to output. Add shapes on a layer that has Output enabled.');
  const off = jobOffset(b, cfg, opts);
  const result = em => ({
    segs: em.seg.subarray(0, em.segN), designBounds: b, offset: off,
    stats: { time: em.time, cutLen: em.cutLen, travelLen: em.travelLen, lines: em.out ? em.out.length : em.count },
  });

  if (family(cfg) === 'ruida') {
    const em = new RuidaEmitter(cfg, off);
    for (const g of groups) {
      const L = effectiveLayer(g.L, cfg, opts);
      em.startLayer(L);
      for (let pass = 0; pass < Math.max(1, L.passes); pass++) emitLayer(em, cfg, L, g.objs, pass);
    }
    return { ...result(em), ruida: encodeJob({ layers: em.layers }), gcode: null };
  }

  const prof = profile(cfg);
  const em = new GcodeEmitter(cfg, off);
  const air = cfg.air && cfg.air !== 'none' ? cfg.air : null;
  em.line('; BeamForge job');
  em.line(`; device: ${cfg.name} (${cfg.type})${opts.dryRun ? ' — DRY RUN, laser off' : ''}`);
  em.line(`; ${new Date().toISOString()}`);
  em.line('G21 ; millimetres');
  em.line('G90 ; absolute positioning');
  if (prof.power === 'M4') em.line('M4 S0');
  else if (prof.power === 'M3') em.line('M3 S0');
  else if (prof.power === 'M3I') em.line('M3 I S0 ; inline laser power');
  for (const g of groups) {
    const L = effectiveLayer(g.L, cfg, opts);
    em.line(`; ---- ${L.name}: ${L.mode}, ${L.speed} mm/s, ${L.power}% power, ${L.passes} pass(es)`);
    if (air) em.line(L.air ? `${air} ; air assist on` : 'M9');
    const constant = L.constant && prof.power === 'M4';
    if (constant) em.line('M3 ; constant power for this layer');
    for (let pass = 0; pass < Math.max(1, L.passes); pass++) {
      if (L.passes > 1) em.line(`; pass ${pass + 1}`);
      if (cfg.zEnabled && (L.zOffset || L.zStep)) em.line(`G0 Z${fmt((L.zOffset || 0) - pass * (L.zStep || 0))}`);
      emitLayer(em, cfg, L, g.objs, pass);
    }
    if (constant) em.line('M4');
    if (cfg.zEnabled && (L.zOffset || L.zStep)) em.line('G0 Z0');
  }
  if (prof.power !== 'inline') em.line('M5 ; laser off');
  if (air) em.line('M9');
  if (cfg.returnHome) {
    const home = opts.startFrom === 'current' ? (opts.position || [0, 0]) : [0, 0];
    em.line(`G0 X${fmt(home[0])} Y${fmt(home[1])}`);
  }
  return { ...result(em), gcode: em.out.join('\n') + '\n' };
}

// Outline of the job in machine coordinates: bounding box, or convex hull ("rubber band").
export function jobFrame(doc, cfg, opts, rubberBand = false) {
  const groups = outputObjects(doc, opts);
  const b = jobBounds(groups);
  if (!b) throw new Error('Nothing to frame');
  const off = jobOffset(b, cfg, opts);
  let pts;
  if (rubberBand) {
    const all = [];
    for (const { objs } of groups) for (const o of objs) for (const p of worldPolys(o)) for (const q of p.pts) all.push(q);
    pts = hull(all);
  } else pts = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
  return pts.map(([x, y]) => { const [a, c] = mapToMachine(cfg, x, y); return [a + off[0], c + off[1]]; });
}

export function frameGcode(cfg, pts, beamPct, feed) {
  const prof = profile(cfg);
  const S = beamPct > 0 ? (cfg.sMax <= 1 ? fmt(beamPct / 100 * cfg.sMax) : Math.round(beamPct / 100 * cfg.sMax)) : 0;
  const lines = ['G21', 'G90', `G0 X${fmt(pts[0][0])} Y${fmt(pts[0][1])}`];
  if (beamPct > 0) { if (prof.power === 'M3I') lines.push('M3 I'); else if (prof.power !== 'inline') lines.push('M3'); }
  for (const [x, y] of [...pts.slice(1), pts[0]]) lines.push(`G1 X${fmt(x)} Y${fmt(y)} S${S} F${feed}`);
  if (prof.power !== 'inline') lines.push('M5');
  return lines.join('\n');
}
