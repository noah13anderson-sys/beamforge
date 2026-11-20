// Run with: npm test
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.ClipperLib = require(new URL('../public/vendor/clipper.js', import.meta.url).pathname);
const base = new URL('../public/js/', import.meta.url).href;
const { generateJob, jobFrame, frameGcode } = await import(base + 'gcode.js');
const D = await import(base + 'devices.js');
const O = await import(base + 'ops.js');
const G = await import(base + 'geom.js');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const L = (o = {}) => ({ id: 'a', name: 'L', mode: 'line', output: true, speed: 10, power: 50, passes: 1, air: true, interval: 0.5, ...o });
const sq = { id: 's', type: 'rect', w: 20, h: 20, layer: 'a', tf: { x: 50, y: 50, sx: 1, sy: 1, r: 0 } };
const job = (dev, layer = L(), objs = [sq], opts = {}) => generateJob({ layers: [layer], objects: objs }, dev, opts);

// --- every controller type
for (const t of Object.keys(D.DEVICE_TYPES).filter(t => t !== 'ruida')) { // ruida: see ruida.test.mjs
  const d = D.makeDevice(t);
  const g = job(d).gcode;
  const sVals = [...g.matchAll(/ S([\d.]+)/g)].map(m => +m[1]).filter(v => v > 0);
  const expectS = d.sMax <= 1 ? d.sMax * 0.5 : Math.round(d.sMax * 0.5);
  const head = { grbl: 'M4 S0', 'grbl-m3': 'M3 S0', grblhal: 'M4 S0', fluidnc: 'M4 S0', 'grbl-lpc': 'M4 S0', smoothie: null, marlin: 'M3 I S0' }[t];
  ok(`${t}: power S=${expectS}`, sVals.length && sVals.every(v => Math.abs(v - expectS) < 1e-9), `S values ${[...new Set(sVals)]}`);
  ok(`${t}: header`, head ? g.includes(head) : !/^M[345]/m.test(g), head || 'no M3/M4/M5');
}
// --- origins: square at design (40..60, 40..60) on 400 bed
for (const [o, exX, exY] of [['bl', [40, 60], [340, 360]], ['tl', [40, 60], [40, 60]], ['tr', [340, 360], [40, 60]], ['br', [340, 360], [340, 360]]]) {
  const d = D.makeDevice('grbl', { origin: o });
  const pts = jobFrame({ layers: [L()], objects: [sq] }, d, {});
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  ok(`origin ${o}`, Math.min(...xs) === exX[0] && Math.max(...xs) === exX[1] && Math.min(...ys) === exY[0] && Math.max(...ys) === exY[1], `x ${Math.min(...xs)}..${Math.max(...xs)} y ${Math.min(...ys)}..${Math.max(...ys)}`);
}
// --- kerf: 20 mm square + 0.2 kerf => cut length 4 * 20.2 + rounded corners
{
  const j0 = job(D.makeDevice('grbl')), j1 = job(D.makeDevice('grbl'), L({ kerf: 0.2 }));
  const expected = 4 * 20 + 2 * Math.PI * 0.1;
  ok('kerf grows outline', Math.abs(j1.stats.cutLen - expected) < 0.05, `${j0.stats.cutLen.toFixed(3)} -> ${j1.stats.cutLen.toFixed(3)} (expect ${expected.toFixed(3)})`);
  // hole shrinks: ring with hole
  const ring = { id: 'r', type: 'path', layer: 'a', tf: { x: 100, y: 100, sx: 1, sy: 1, r: 0 }, polys: [{ closed: true, pts: G.rectPts(40, 40) }, { closed: true, pts: G.rectPts(20, 20) }] };
  const jr = job(D.makeDevice('grbl'), L({ kerf: 1 }), [ring]);
  const outer = 4 * 40 + 2 * Math.PI * 0.5, inner = 4 * 19; // straight sides keep their length, corners become arcs
  ok('kerf: part grows, hole shrinks', Math.abs(jr.stats.cutLen - (outer + inner)) < 0.1, `${jr.stats.cutLen.toFixed(2)} vs ${(outer + inner).toFixed(2)}`);
}
// --- tabs: 4 tabs of 1 mm on 80 mm perimeter => 76 mm burned
{ const j = job(D.makeDevice('grbl'), L({ tabs: true, tabCount: 4, tabWidth: 1 }));
  ok('tabs leave 4×1 mm uncut', Math.abs(j.stats.cutLen - 76) < 0.01, j.stats.cutLen.toFixed(3)); }
{ const j = job(D.makeDevice('grbl'), L({ tabs: true, tabCount: 0, tabSpacing: 20, tabWidth: 2 }));
  ok('tabs by spacing (one per 20 mm)', Math.abs(j.stats.cutLen - 72) < 0.01, j.stats.cutLen.toFixed(3)); }
// --- perforation: 2 on / 2 off along 80 mm => 40 mm burned
{ const j = job(D.makeDevice('grbl'), L({ perf: true, perfCut: 2, perfSkip: 2 }));
  ok('perforation burns half', Math.abs(j.stats.cutLen - 40) < 0.01, j.stats.cutLen.toFixed(3)); }
// --- offset fill: 20mm square, 1mm step => rings at 0.5,1.5..9.5 inset: perimeters 4*(20-2d)
{ const j = job(D.makeDevice('grbl'), L({ mode: 'offset', interval: 1 }));
  let exp = 0; for (let d = 0.5; d < 10; d += 1) exp += 4 * (20 - 2 * d);
  ok('offset fill rings', Math.abs(j.stats.cutLen - exp) / exp < 0.02, `${j.stats.cutLen.toFixed(1)} vs ${exp}`); }
// --- passes + Z step
{ const d = D.makeDevice('grbl', { zEnabled: true });
  const g = job(d, L({ passes: 3, zStep: 1.5, zOffset: 0 })).gcode;
  ok('Z steps per pass', /G0 Z0\b/.test(g) && /G0 Z-1.5/.test(g) && /G0 Z-3\b/.test(g)); }
// --- constant power layer on M4 device
{ const g = job(D.makeDevice('grbl'), L({ constant: true })).gcode;
  ok('constant-power layer switches M3/M4', /^M3 ;/m.test(g) && /^M4$/m.test(g)); }
// --- rotary scale
{ const d = D.makeDevice('grbl', { origin: 'tl', rotary: true, rotaryType: 'roller', rotaryMmPerRot: 100, rotaryRollerDia: 20 });
  const k = 100 / (Math.PI * 20);
  const pts = jobFrame({ layers: [L()], objects: [sq] }, d, {});
  ok('rotary scales Y', Math.abs(pts[0][1] - 40 * k) < 1e-9 && pts[0][0] === 40, `k=${k.toFixed(4)} y=${pts[0][1].toFixed(3)}`); }
// --- current-position anchors
{ const d = D.makeDevice('grbl');
  const f = jobFrame({ layers: [L()], objects: [sq] }, d, { startFrom: 'current', anchor: 'c', position: [5, 5] });
  const cx = (Math.min(...f.map(p => p[0])) + Math.max(...f.map(p => p[0]))) / 2, cy = (Math.min(...f.map(p => p[1])) + Math.max(...f.map(p => p[1]))) / 2;
  ok('anchor centre at head', cx === 5 && cy === 5); }
// --- user origin
{ const d = D.makeDevice('grbl', { userOrigin: [100, 50] });
  const f = jobFrame({ layers: [L()], objects: [sq] }, d, { startFrom: 'user', anchor: 'bl', position: [5, 5] });
  ok('user origin anchors bottom-left', Math.min(...f.map(p => p[0])) === 100 && Math.min(...f.map(p => p[1])) === 50, JSON.stringify(f));
  const g = generateJob({ layers: [L()], objects: [sq] }, d, { startFrom: 'user', anchor: 'bl' }).gcode;
  ok('user origin: return to it at end', /G0 X100(\.0+)? Y50(\.0+)?\s*$/.test(g.trim().split('\n').pop()), g.trim().split('\n').pop());
  const r = D.makeDevice('ruida', { bedW: 1300, bedH: 900, userOrigin: [600, 400] });
  const fr = jobFrame({ layers: [L()], objects: [sq] }, r, { startFrom: 'user', anchor: 'c' });
  const rcx = (Math.min(...fr.map(p => p[0])) + Math.max(...fr.map(p => p[0]))) / 2;
  ok('user origin on Ruida (rear-right origin)', rcx === 600, String(rcx)); }
// --- air assist variants
{ ok('air M7', job(D.makeDevice('grbl', { air: 'M7' })).gcode.includes('M7 ; air'));
  ok('air none', !/M[789]/.test(job(D.makeDevice('grbl', { air: 'none' })).gcode)); }
// --- booleans
{ const a = [{ closed: true, pts: G.rectPts(20, 20) }], b = [{ closed: true, pts: G.rectPts(20, 20).map(([x, y]) => [x + 10, y]) }];
  const area = ps => ps.reduce((s, p) => s + G.polyArea(p.pts), 0);
  ok('union area 600', Math.abs(Math.abs(area(O.boolean('union', [a, b]))) - 600) < 0.01);
  ok('difference area 200', Math.abs(Math.abs(area(O.boolean('difference', [a], [b]))) - 200) < 0.01);
  ok('intersection area 200', Math.abs(Math.abs(area(O.boolean('intersection', [a], [b]))) - 200) < 0.01);
  ok('xor = 2 pieces', O.boolean('xor', [a], [b]).length === 2);
  const off = O.offset(a, 2, { join: 'miter' });
  ok('offset miter 24×24', Math.abs(Math.abs(area(off)) - 576) < 0.01);
  const j = O.joinPaths([{ closed: false, pts: [[0, 0], [10, 0]] }, { closed: false, pts: [[10, 10], [10, 0.05]] }, { closed: false, pts: [[10, 10], [0, 0.02]] }], 0.1);
  ok('auto-join closes triangle', j.length === 1 && j[0].closed, JSON.stringify(j.map(p => [p.closed, p.pts.length])));
  ok('hull of square+inner point', O.hull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]).length === 4); }
// --- frame G-code per family
for (const t of ['grbl', 'smoothie', 'marlin']) {
  const d = D.makeDevice(t);
  const g = frameGcode(d, [[0, 0], [10, 0], [10, 10]], 1, 3000);
  ok(`frame ${t}`, g.includes('G1 X0 Y0') && (t === 'smoothie' ? !/M[35]/.test(g) : /M5/.test(g)), g.split('\n').slice(3, 4).join(''));
}
// --- fillet / chamfer / reflect
{ const sqp = [{ closed: true, pts: [[0, 0], [20, 0], [20, 20], [0, 20]] }];
  const f = O.fillet(sqp, 5);
  const pts = f.polys[0].pts;
  const onArc = pts.every(([x, y]) => x >= -1e-9 && x <= 20 + 1e-9 && y >= -1e-9 && y <= 20 + 1e-9);
  const corner = Math.min(...pts.map(([x, y]) => Math.hypot(x, y)));
  ok('fillet rounds 4 corners', f.corners === 4 && onArc, String(f.corners));
  ok('fillet r=5 corner inset is 5√2−5', Math.abs(corner - (Math.hypot(5, 5) - 5)) < 0.05, corner.toFixed(3));
  const c = O.fillet(sqp, 5, { style: 'chamfer' }).polys[0].pts;
  ok('chamfer makes 8 points', c.length === 8 && c.some(p => Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1]) < 1e-9), JSON.stringify(c.slice(0, 2)));
  const big = O.fillet(sqp, 100).polys[0].pts;
  ok('fillet radius clamps to edge (circle-ish)', big.every(([x, y]) => Math.abs(Math.hypot(x - 10, y - 10) - 10) < 0.01), '');
  const circ = { closed: true, pts: Array.from({ length: 72 }, (_, i) => [Math.cos(i * Math.PI / 36), Math.sin(i * Math.PI / 36)]) };
  ok('fillet skips smooth curves', O.fillet([circ], 1).corners === 0);
  const open = O.fillet([{ closed: false, pts: [[0, 0], [10, 0], [10, 10]] }], 2);
  ok('open path keeps end points', open.corners === 1 && open.polys[0].pts[0].join() === '0,0' && open.polys[0].pts.at(-1).join() === '10,10');
  const G2 = await import(base + 'geom.js');
  const tf = { x: 30, y: 10, sx: 1.5, sy: 0.5, r: 25 };
  for (const deg of [0, 90, 45, 120]) {
    const R = O.reflectTf(tf, deg, 5, 7), t = 2 * deg * Math.PI / 180;
    const refl = ([x, y]) => { const dx = x - 5, dy = y - 7; return [5 + Math.cos(t) * dx + Math.sin(t) * dy, 7 + Math.sin(t) * dx - Math.cos(t) * dy]; };
    let good = true;
    for (const p of [[1, 2], [-3, 4], [0, 0]]) {
      const a = refl(G2.apply(G2.tfMatrix(tf), ...p)), b = G2.apply(G2.tfMatrix(R), ...p);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) good = false;
    }
    ok(`reflectTf matches true reflection at ${deg}°`, good);
  }
}
// --- variable text resolve
const Sh = await import(base + 'shapes.js');
Sh.textVars.serial = 7;
ok('variable text', Sh.resolveText('SN-{serial:4} {year}') === `SN-0007 ${new Date().getFullYear()}`, Sh.resolveText('SN-{serial:4} {year}'));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exitCode = fails ? 1 : 0;
