// CNC router toolpaths: profile (outside / inside / on line), pocket, engrave and drill, with depth passes,
// tabs, climb or conventional milling, spindle control and tool-change pauses. Output is GRBL-style G-code.
//
// Coordinates: X/Y as for the laser (design → machine through the device origin), Z = 0 at the top of the
// material, cutting depths are negative. Keep laser mode off on the controller ($32=0).
import * as G from './geom.js';
import { worldPolys } from './shapes.js';
import { offset, splitTabs } from './ops.js';
import { mapToMachine } from './devices.js';
import { fmt, orderPolys } from './gcode.js';

export const CNC_OPS = { profile: 'Profile', pocket: 'Pocket', engrave: 'Engrave (on line)', drill: 'Drill' };

// Signed area in design coordinates (Y down): positive = clockwise as seen from above.
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
const nestDepth = (loop, all) => all.reduce((d, o) => d + (o !== loop && G.pointInPoly(loop.pts[0][0], loop.pts[0][1], o.pts) ? 1 : 0), 0);

// Depths of each pass: stepDown increments, ending exactly at the full depth.
export function passDepths(depth, stepDown) {
  depth = Math.abs(depth); stepDown = Math.abs(stepDown) || depth;
  const out = [];
  for (let d = stepDown; d < depth - 1e-6; d += stepDown) out.push(d);
  out.push(depth);
  return out;
}

const layerCnc = L => ({
  op: L.cncOp || 'profile', side: L.cncSide || 'outside', tool: Math.max(0.01, L.toolDia ?? 3.175),
  depth: Math.abs(L.depth ?? 3), stepDown: Math.abs(L.stepDown ?? 1) || Math.abs(L.depth ?? 3), feed: Math.max(1, L.feed ?? 1000),
  plunge: Math.max(1, L.plunge ?? 300), rpm: Math.max(0, L.rpm ?? 12000), stepover: Math.min(95, Math.max(5, L.stepover ?? 40)) / 100,
  climb: L.climb !== false, tabs: !!L.tabs, tabCount: L.tabCount ?? 4, tabSpacing: L.tabSpacing ?? 0, tabWidth: L.cncTabWidth ?? 6,
  tabHeight: Math.abs(L.tabHeight ?? 1), peck: Math.abs(L.peck ?? 0), passes: Math.max(1, L.passes || 1),
});

// Toolpath loops for one layer: [{ pts, closed, materialInside? }].
export function cncPaths(polys, C) {
  // drop exact duplicates (e.g. pasted twice) — with even-odd nesting they would cancel each other out
  const seen = new Set();
  polys = polys.filter(p => { const k = p.closed + p.pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(';'); if (seen.has(k)) return false; seen.add(k); return true; });
  const closed = polys.filter(p => p.closed && p.pts.length >= 3);
  const open = polys.filter(p => !(p.closed && p.pts.length >= 3) && p.pts.length >= 2).map(p => ({ pts: p.pts, closed: false }));
  const r = C.tool / 2;
  const orient = (loops, insideMaterialAtEvenDepth) => loops.map(l => {
    const even = nestDepth(l, loops) % 2 === 0;
    const materialInside = even === insideMaterialAtEvenDepth;
    // climb milling with a clockwise spindle keeps the tool on the left of travel:
    // material inside the loop → travel clockwise (seen from above); material outside → anticlockwise
    const wantCw = materialInside === C.climb;
    const cw = signedArea(l.pts) > 0;
    return { pts: cw === wantCw ? l.pts : l.pts.slice().reverse(), closed: true };
  });
  if (C.op === 'drill') return closed.map(p => { const b = G.boundsOfPolys([p]); return { drill: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] }; });
  if (C.op === 'engrave' || (C.op === 'profile' && C.side === 'on')) return [...closed.map(p => ({ pts: p.pts, closed: true })), ...open];
  if (C.op === 'profile') {
    const loops = offset(closed, C.side === 'outside' ? r : -r, { join: 'round' });
    return [...orient(loops, C.side === 'outside'), ...open];
  }
  // pocket: rings from the outside boundary inward, cut innermost first so the final pass is the wall
  const step = C.tool * C.stepover, rings = [];
  let last = r;
  for (let d = r, i = 0; i < 2000; d += step, i++) {
    const ring = offset(closed, -d, { join: 'round' });
    if (!ring.length) {
      // stepover > 50%: material can remain in the middle; one more ring just under a radius further in clears it
      if (step > r && i > 0) { const extra = offset(closed, -(last + r * 0.9), { join: 'round' }); if (extra.length) rings.push(orient(extra, false)); }
      break;
    }
    rings.push(orient(ring, false).map(l => ({ ...l, ring: i })));
    last = d;
  }
  return rings.reverse().flat();
}

class CncEmitter {
  constructor(cfg, off, zShift) {
    this.cfg = cfg; this.off = off; this.zShift = zShift;
    this.out = []; this.x = null; this.y = null; this.z = null; this.f = null;
    this.time = 0; this.cutLen = 0; this.travelLen = 0;
    this.seg = new Float32Array(1 << 15); this.segN = 0; this.maxDepth = 1;
    this.rapidF = Math.max(1, cfg.travel * 60);
    this.safe = Math.max(0.5, cfg.safeZ ?? 5);
  }
  m(x, y) { const [a, b] = mapToMachine(this.cfg, x, y); return [a + this.off[0], b + this.off[1]]; }
  push(x1, y1, x2, y2, p) {
    if (this.segN + 5 > this.seg.length) { const n = new Float32Array(this.seg.length * 2); n.set(this.seg); this.seg = n; }
    this.seg.set([x1, y1, x2, y2, p], this.segN); this.segN += 5;
  }
  line(s) { this.out.push(s); }
  zTo(z, feed) { // feed null = rapid
    z += this.zShift;
    if (this.z !== null && Math.abs(z - this.z) < 1e-6) return;
    if (feed) { this.out.push(`G1 Z${fmt(z)}${feed !== this.f ? ` F${feed}` : ''}`); this.f = feed; }
    else this.out.push(`G0 Z${fmt(z)}`);
    if (this.z !== null) this.time += Math.abs(z - this.z) / (feed || this.rapidF) * 60;
    this.z = z;
  }
  retract() { this.zTo(this.safe - this.zShift, null); }
  rapidXY(x, y) {
    if (this.x !== null && Math.abs(x - this.x) < 1e-6 && Math.abs(y - this.y) < 1e-6) return;
    const [mx, my] = this.m(x, y);
    this.out.push(`G0 X${fmt(mx)} Y${fmt(my)}`);
    if (this.x !== null) { const d = Math.hypot(x - this.x, y - this.y); this.travelLen += d; this.time += d / this.rapidF * 60; this.push(this.x, this.y, x, y, -1); }
    this.x = x; this.y = y;
  }
  cutXY(x, y, feed) {
    if (this.x !== null && Math.abs(x - this.x) < 1e-6 && Math.abs(y - this.y) < 1e-6) return;
    const [mx, my] = this.m(x, y);
    this.out.push(`G1 X${fmt(mx)} Y${fmt(my)}${feed !== this.f ? ` F${feed}` : ''}`); this.f = feed;
    const d = Math.hypot(x - this.x, y - this.y);
    this.time += d / feed * 60; this.cutLen += d;
    this.push(this.x, this.y, x, y, Math.min(1, Math.max(0.15, -(this.z - this.zShift) / this.maxDepth)));
    this.x = x; this.y = y;
  }
  // Move to (x, y) at safe height, then plunge to z.
  enter(x, y, z, plunge) {
    const near = this.x !== null && Math.hypot(x - this.x, y - this.y) < 1e-6;
    if (!near) { this.retract(); this.rapidXY(x, y); this.zTo(0.5, null); }
    this.zTo(z, plunge);
  }
}

function cutLoop(em, p, C, zs) {
  const loop = p.closed ? [...p.pts, p.pts[0]] : p.pts;
  const tabZ = -(C.depth - C.tabHeight);
  const pieces = C.tabs && p.closed && C.tabHeight > 0 && C.tabHeight < C.depth
    ? splitTabs(p.pts, true, { count: C.tabCount, spacing: C.tabSpacing, width: C.tabWidth + C.tool }) : null;
  let fwd = true;
  for (const d of zs) {
    const z = -d;
    if (pieces && z < tabZ - 1e-6) {
      // deep passes: lift over each tab
      pieces.forEach((pc, k) => {
        if (pc.length < 2) return;
        if (k === 0) em.enter(pc[0][0], pc[0][1], z, C.plunge);
        else { em.zTo(tabZ, C.plunge); em.cutXY(pc[0][0], pc[0][1], C.feed); em.zTo(z, C.plunge); }
        for (let i = 1; i < pc.length; i++) em.cutXY(pc[i][0], pc[i][1], C.feed);
      });
      em.zTo(tabZ, C.plunge);
      continue;
    }
    const pts = p.closed || fwd ? loop : loop.slice().reverse();
    em.enter(pts[0][0], pts[0][1], z, C.plunge);
    for (let i = 1; i < pts.length; i++) em.cutXY(pts[i][0], pts[i][1], C.feed);
    if (!p.closed) fwd = !fwd; // zig-zag open paths so there is no retract between passes
  }
}

// groups: [{L, objs}] from outputObjects(); returns the same shape as generateJob for lasers.
export function generateCnc(groups, cfg, opts, off) {
  const all = groups.map(g => ({ L: g.L, C: layerCnc(g.L), objs: g.objs.filter(o => o.type !== 'image') })).filter(g => g.objs.length);
  if (!all.length) throw new Error('Nothing to cut. CNC jobs use vector shapes (images are skipped).');
  const maxDepth = Math.max(...all.map(g => g.C.depth));
  const zShift = opts.dryRun ? maxDepth + Math.max(0.5, cfg.safeZ ?? 5) : 0;
  const em = new CncEmitter(cfg, off, zShift);
  em.maxDepth = maxDepth || 1;
  const coolant = cfg.air && cfg.air !== 'none' ? cfg.air : null;
  em.line('; BeamForge CNC job');
  em.line(`; device: ${cfg.name}${opts.dryRun ? ` — AIR CUT: spindle off, everything ${fmt(zShift)} mm higher` : ''}`);
  em.line(`; ${new Date().toISOString()}`);
  em.line('; Z0 = top of the material. Laser mode must be off ($32=0).');
  em.line('G21 G90 G17 ; mm, absolute, XY plane');
  em.retract();
  let tool = null, rpm = null;
  for (const { L, C, objs } of all) {
    em.line(`; ---- ${L.name}: ${CNC_OPS[C.op]}${C.op === 'profile' ? ` ${C.side}` : ''}, Ø${C.tool} mm tool, depth ${C.depth} mm in ${fmt(C.stepDown)} mm steps, ${C.feed} mm/min`);
    if (tool !== null && Math.abs(tool - C.tool) > 1e-6) {
      em.line('M5 ; spindle off for tool change');
      if (coolant) em.line('M9');
      em.retract();
      em.line(`; TOOL CHANGE: fit the Ø${C.tool} mm bit, re-zero Z on the material top, then press Resume`);
      em.line('M0');
      rpm = null;
    }
    tool = C.tool;
    if (!opts.dryRun && C.rpm !== rpm) { em.line(`M3 S${Math.round(C.rpm)} ; spindle on`); em.line(`G4 P${fmt(Math.max(0, cfg.spinUp ?? 3))} ; spin up`); rpm = C.rpm; }
    if (coolant && !opts.dryRun) em.line(L.air ? `${coolant} ; coolant / dust on` : 'M9');
    const paths = cncPaths(objs.flatMap(o => worldPolys(o)), C);
    const zs = passDepths(C.depth, C.stepDown);
    for (let rep = 0; rep < C.passes; rep++) {
      if (C.op === 'drill') {
        let x = em.x ?? 0, y = em.y ?? 0;
        const pool = paths.slice();
        while (pool.length) { // nearest hole next
          let bi = 0, bd = Infinity;
          pool.forEach((h, i) => { const d = (h.drill[0] - x) ** 2 + (h.drill[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } });
          const [hx, hy] = pool.splice(bi, 1)[0].drill;
          em.retract(); em.rapidXY(hx, hy); em.zTo(0.5, null);
          if (C.peck > 0) {
            for (let d = C.peck; ; d = Math.min(C.depth, d + C.peck)) {
              em.zTo(-d, C.plunge);
              if (d >= C.depth - 1e-6) break;
              em.zTo(0.5, null); em.zTo(-d + 0.2, null);
            }
          } else em.zTo(-C.depth, C.plunge);
          em.retract();
          x = hx; y = hy;
        }
        continue;
      }
      // pockets keep their ring order (innermost → wall); other cuts: holes first, nearest next
      const ordered = C.op === 'pocket' ? paths : orderPolys(paths, em.x ?? 0, em.y ?? 0).map(p => ({ ...p, pts: p.pts }));
      if (C.op === 'pocket') {
        // cut every ring at each depth before going deeper; stay down when stepping to the next ring
        for (const d of zs) {
          let first = true;
          for (const p of ordered) {
            const pts = [...p.pts, p.pts[0]];
            const near = !first && em.x !== null && Math.hypot(pts[0][0] - em.x, pts[0][1] - em.y) <= C.tool * C.stepover * 2.2;
            if (near) em.cutXY(pts[0][0], pts[0][1], C.feed); else em.enter(pts[0][0], pts[0][1], -d, C.plunge);
            em.zTo(-d, C.plunge);
            for (let i = 1; i < pts.length; i++) em.cutXY(pts[i][0], pts[i][1], C.feed);
            first = false;
          }
          em.retract();
        }
      } else {
        for (const p of ordered) { cutLoop(em, p, C, zs); em.retract(); }
      }
    }
  }
  em.retract();
  if (!opts.dryRun) em.line('M5 ; spindle off');
  if (coolant && !opts.dryRun) em.line('M9');
  if (cfg.returnHome) em.line(`G0 X${fmt(opts.home?.[0] ?? 0)} Y${fmt(opts.home?.[1] ?? 0)}`);
  em.line('M2 ; end of program');
  return {
    segs: em.seg.subarray(0, em.segN),
    stats: { time: em.time, cutLen: em.cutLen, travelLen: em.travelLen, lines: em.out.length },
    gcode: em.out.join('\n') + '\n',
  };
}

// Frame for CNC: lift to safe Z first, then trace the outline with the spindle off.
export function cncFrameGcode(cfg, pts, feed) {
  const safe = Math.max(0.5, cfg.safeZ ?? 5);
  const lines = ['G21 G90', 'M5', `G0 Z${fmt(safe)}`, `G0 X${fmt(pts[0][0])} Y${fmt(pts[0][1])}`];
  for (const [x, y] of [...pts.slice(1), pts[0]]) lines.push(`G1 X${fmt(x)} Y${fmt(y)} F${feed}`);
  return lines.join('\n');
}
