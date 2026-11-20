// CNC router toolpaths. Run with: npm test
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.ClipperLib = require(new URL('../public/vendor/clipper.js', import.meta.url).pathname);
const base = new URL('../public/js/', import.meta.url).href;
const { generateJob, frameGcode } = await import(base + 'gcode.js');
const D = await import(base + 'devices.js');
const C = await import(base + 'cnc.js');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const dev = D.makeDevice('cnc-grbl', { bedW: 600, bedH: 400 });
const L = (o = {}) => ({ id: 'a', name: 'Cut', mode: 'line', output: true, passes: 1, air: false, cncOp: 'profile', cncSide: 'outside', toolDia: 6, depth: 6, stepDown: 2, feed: 1200, plunge: 300, rpm: 18000, climb: true, stepover: 40, ...o });
const rect = (w, h, x = 100, y = 100) => ({ id: 'r' + x + y, type: 'rect', w, h, layer: 'a', tf: { x, y, sx: 1, sy: 1, r: 0 } });
const run = (layer, objs = [rect(40, 20)], opts = {}) => generateJob({ layers: [layer], objects: objs }, dev, opts);
// parse G-code into moves with modal Z
function moves(g) {
  let x = null, y = null, z = null;
  const out = [];
  for (const line of g.split('\n')) {
    const m = /^(G[01])\b(.*)$/.exec(line.replace(/;.*$/, '').trim()); if (!m) continue;
    const w = {}; for (const t of m[2].matchAll(/([XYZF])(-?[\d.]+)/g)) w[t[1]] = +t[2];
    if ('X' in w) x = w.X; if ('Y' in w) y = w.Y; if ('Z' in w) z = w.Z;
    out.push({ g: m[1], x, y, z });
  }
  return out;
}

ok('CNC device type', D.isCnc(dev) && !D.isCnc(D.makeDevice('grbl')) && dev.air === 'none');
ok('pass depths', C.passDepths(6, 2).join() === '2,4,6' && C.passDepths(5, 2).join() === '2,4,5' && C.passDepths(1, 0).join() === '1');

{ const j = run(L());
  const g = j.gcode, mv = moves(g);
  ok('spindle on with RPM, off at end', /^M3 S18000/m.test(g) && /^M5/m.test(g) && /^G4 P3/m.test(g));
  ok('starts at safe Z', /G0 Z5\n/.test(g.split('; ----')[0]));
  ok('never cuts deeper than the depth', Math.min(...mv.map(m => m.z ?? 0)) === -6);
  ok('three depth passes', new Set(mv.filter(m => m.g === 'G1' && m.z < 0).map(m => m.z)).size === 3);
  const cut = mv.filter(m => m.g === 'G1' && m.z === -6);
  const xs = cut.map(m => m.x), ys = cut.map(m => m.y);
  ok('outside profile offset by the tool radius', Math.min(...xs) === 77 && Math.max(...xs) === 123 && Math.min(...ys) === 287 && Math.max(...ys) === 313, `${Math.min(...xs)}..${Math.max(...xs)} ${Math.min(...ys)}..${Math.max(...ys)}`);
  ok('rapids only at safe height', mv.every((m, i) => m.g !== 'G0' || i === 0 || m.z > 0 || mv[i - 1].z > 0));
  ok('ends with M2', g.trim().endsWith('M2 ; end of program')); }

{ const mv = moves(run(L({ cncSide: 'inside' })).gcode).filter(m => m.g === 'G1' && m.z === -6);
  const xs = mv.map(m => m.x);
  ok('inside profile offset inward', Math.min(...xs) === 83 && Math.max(...xs) === 117, `${Math.min(...xs)}..${Math.max(...xs)}`); }

{ const mv = moves(run(L({ cncSide: 'on' })).gcode).filter(m => m.g === 'G1' && m.z === -6);
  const xs = mv.map(m => m.x);
  ok('on-line profile follows the shape', Math.min(...xs) === 80 && Math.max(...xs) === 120); }

// climb vs conventional: outside climb is clockwise seen from above (machine Y up → negative shoelace)
{ const loopArea = g => { const p = moves(g).filter(m => m.g === 'G1' && m.z === -6).map(m => [m.x, m.y]); let a = 0; for (let i = 0; i < p.length - 1; i++) a += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; return a; };
  const climb = loopArea(run(L()).gcode), conv = loopArea(run(L({ climb: false })).gcode);
  ok('outside climb = clockwise (machine coords)', climb < 0, String(climb));
  ok('conventional reverses direction', conv > 0, String(conv));
  const hole = loopArea(run(L({ cncSide: 'inside' })).gcode);
  ok('inside climb = anticlockwise', hole > 0, String(hole)); }

{ const g = run(L({ tabs: true, tabCount: 2, cncTabWidth: 5, tabHeight: 2 })).gcode, mv = moves(g);
  const zs = mv.filter(m => m.g === 'G1').map(m => m.z);
  ok('tabs lift to the tab height on the last pass', zs.includes(-4) && zs.filter(z => z === -6).length > 2);
  const atTab = mv.filter((m, i) => m.g === 'G1' && m.z === -4 && i > 0 && mv[i - 1].z === -4 && (m.x !== mv[i - 1].x || m.y !== mv[i - 1].y));
  ok('two tab crossings at the tab height', atTab.length >= 2, String(atTab.length)); }

{ const g = run(L({ cncOp: 'pocket', depth: 3, stepDown: 3 })).gcode, mv = moves(g).filter(m => m.g === 'G1' && m.z === -3);
  const xs = mv.map(m => m.x);
  ok('pocket stays inside the wall', Math.min(...xs) >= 83 - 1e-6 && Math.max(...xs) <= 117 + 1e-6, `${Math.min(...xs)}..${Math.max(...xs)}`);
  ok('pocket reaches the wall', Math.min(...xs) === 83 && Math.max(...xs) === 117);
  ok('pocket has 3 rings for a 14 mm wide pocket', new Set(mv.map(m => m.y)).size >= 6, String(mv.length)); }

// coverage check: no point of the pocket floor is further than the tool radius from the toolpath
for (const so of [40, 50, 70, 90]) {
  const g = run(L({ cncOp: 'pocket', depth: 3, stepDown: 3, stepover: so }), [rect(47, 31)]).gcode;
  const mv = moves(g).filter(m => m.z === -3);
  const segs = []; for (let i = 1; i < mv.length; i++) if (mv[i].g === 'G1' && mv[i - 1].z === -3) segs.push([mv[i - 1], mv[i]]);
  const dist = (px, py, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l)); return Math.hypot(px - a.x - t * dx, py - a.y - t * dy); };
  let worst = 0;
  for (let x = 76.6; x <= 123.4; x += 0.8) for (let y = 284.6; y <= 315.4; y += 0.8) if (!((x < 79.5 || x > 120.5) && (y < 287.5 || y > 312.5))) worst = Math.max(worst, Math.min(...segs.map(([a, b]) => dist(x, y, a, b))));
  ok(`pocket fully cleared at ${so}% stepover`, worst <= 3 + 0.05, `max gap to tool centre ${worst.toFixed(2)} mm`);
}

{ const holes = [{ id: 'c1', type: 'ellipse', w: 5, h: 5, layer: 'a', tf: { x: 50, y: 50, sx: 1, sy: 1, r: 0 } }, { id: 'c2', type: 'ellipse', w: 5, h: 5, layer: 'a', tf: { x: 150, y: 50, sx: 1, sy: 1, r: 0 } }];
  const g = run(L({ cncOp: 'drill', depth: 5, peck: 2 }), holes).gcode;
  const plunges = moves(g).filter(m => m.g === 'G1');
  ok('drill pecks to full depth at each centre', plunges.filter(m => m.z === -5).length === 2 && plunges.some(m => m.z === -2) && plunges.every(m => m.y === 350), JSON.stringify(plunges.slice(0, 3))); }

{ const g = run(L(), undefined, { dryRun: true }).gcode;
  const mv = moves(g);
  ok('air cut: no spindle and never below the surface', !/^M3/m.test(g) && Math.min(...mv.map(m => m.z ?? 99)) > 0); }

{ const g = generateJob({ layers: [L(), { ...L({ toolDia: 3 }), id: 'b', name: 'Fine' }], objects: [rect(40, 20), { ...rect(10, 10, 300, 100), layer: 'b' }] }, dev, {}).gcode;
  ok('tool change pauses with M0', /TOOL CHANGE[^\n]*\nM0/.test(g)); }

{ const f = frameGcode(dev, [[0, 0], [10, 0], [10, 10]], 1, 1000);
  ok('CNC frame lifts Z first and never turns on the spindle', f.indexOf('G0 Z5') < f.indexOf('G0 X0') && !/M3/.test(f)); }

{ const c = D.commands(dev);
  ok('Z commands', c.jogZ(-1, 300) === '$J=G91 G21 Z-1 F300' && c.zeroZ === 'G10 L20 P1 Z0' && /G38\.2/.test(c.probeZ(19.5)) && /Z19\.5/.test(c.probeZ(19.5))); }

{ const mv = moves(run(L(), [rect(40, 20), { ...rect(40, 20), id: 'dup' }]).gcode).filter(m => m.g === 'G1' && m.z === -6);
  const one = moves(run(L()).gcode).filter(m => m.g === 'G1' && m.z === -6).length;
  ok('duplicate shapes are cut once, not cancelled', mv.length === one && one > 4, `${mv.length} vs ${one}`); }

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exitCode = fails ? 1 : 0;
