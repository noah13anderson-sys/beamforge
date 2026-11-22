// Path clean-up, docking, path sampling and node-editing helpers (the right-click / Edit / Arrange menu tools).
// Run with: npm test
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.ClipperLib = require(new URL('../public/vendor/clipper.js', import.meta.url).pathname);
const base = new URL('../public/js/', import.meta.url).href;
const O = await import(base + 'ops.js');
const G = await import(base + 'geom.js');
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const ptEq = (p, q, e = 1e-6) => near(p[0], q[0], e) && near(p[1], q[1], e);
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

// --- close paths with tolerance
{
  const open = [{ closed: false, pts: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.3]] }];
  const j = O.closeWithin(open, 0.5, 'join');
  ok('close: ends 0.3 apart close with a line', j.count === 1 && j.polys[0].closed && j.polys[0].pts.length === 5);
  ok('close: tolerance too small leaves it open', O.closeWithin(open, 0.1).count === 0 && !O.closeWithin(open, 0.1).polys[0].closed);
  const m = O.closeWithin(open, 0.5, 'move');
  ok('close: move ends together', m.count === 1 && m.polys[0].pts.length === 4 && ptEq(m.polys[0].pts[0], [0, 0.15]), JSON.stringify(m.polys[0].pts[0]));
  const touching = O.closeWithin([{ closed: false, pts: [[0, 0], [5, 0], [5, 5], [0, 0]] }], 0.01);
  ok('close: coincident ends drop the repeated point', touching.count === 1 && touching.polys[0].pts.length === 3);
  // decide on world size, edit local points: a path scaled up 10x has ends 3 mm apart in the world
  const local = [{ closed: false, pts: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0.3]] }];
  const world = G.transformPolys(local, [10, 0, 0, 10, 0, 0]);
  ok('close: measured in world mm', O.closeWithin(local, 0.5, 'join', world).count === 0 && O.closeWithin(local, 3.5, 'join', world).count === 1);
  ok('close: closed paths untouched', O.closeWithin([{ closed: true, pts: sq(0, 0, 5) }], 1).count === 0);
}

// --- optimize
{
  const pts = [];
  for (const [a, b] of [[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]])
    for (let k = 0; k < 5; k++) pts.push([a[0] + (b[0] - a[0]) * k / 5, a[1] + (b[1] - a[1]) * k / 5]);
  pts.splice(7, 0, pts[7].slice()); // a repeated point
  const r = O.optimizePolys([{ closed: true, pts }], 0.01);
  ok('optimize: square with extra points -> 4 corners', r[0].pts.length === 4 && r[0].closed, `${pts.length} -> ${r[0].pts.length}`);
  ok('optimize: area kept', near(Math.abs(G.polyArea(r[0].pts)), 100));
  const line = O.optimizePolys([{ closed: false, pts: [[0, 0], [1, 0], [2, 0.001], [3, 0], [4, 0]] }], 0.01);
  ok('optimize: straight open line -> 2 points', line[0].pts.length === 2 && !line[0].closed);
  const circle = G.ellipsePts(20, 20), tol = 0.02;
  const c = O.optimizePolys([{ closed: true, pts: circle }], tol)[0].pts;
  const dev = Math.max(...circle.map(([x, y]) => Math.min(...c.map((q, i) => { const z = c[(i + 1) % c.length]; return G.distToSegment(x, y, q[0], q[1], z[0], z[1]); }))));
  ok('optimize: circle stays within tolerance', c.length < circle.length && dev <= tol + 1e-9, `${circle.length} -> ${c.length} points, max deviation ${dev.toFixed(4)} mm`);
  ok('optimize: tiny shapes survive', O.optimizePolys([{ closed: true, pts: sq(0, 0, 0.001) }], 0.02)[0].pts.length >= 3);
}

// --- duplicate fingerprints
{
  const a = [{ closed: true, pts: sq(5, 5, 10) }];
  const rotated = [{ closed: true, pts: [...sq(5, 5, 10).slice(2), ...sq(5, 5, 10).slice(0, 2)] }];
  const reversed = [{ closed: true, pts: sq(5, 5, 10).reverse() }];
  const moved = [{ closed: true, pts: sq(5.1, 5, 10) }];
  ok('duplicates: same shape, other start point / direction', O.polysKey(a) === O.polysKey(rotated) && O.polysKey(a) === O.polysKey(reversed));
  ok('duplicates: moved 0.1 mm is different', O.polysKey(a) !== O.polysKey(moved));
  ok('duplicates: open vs closed differ', O.polysKey(a) !== O.polysKey([{ closed: false, pts: sq(5, 5, 10) }]));
}

// --- containment
{
  const big = [{ closed: true, pts: sq(0, 0, 100) }], small = [{ closed: true, pts: sq(10, 10, 5) }];
  const donut = [{ closed: true, pts: sq(0, 0, 100) }, { closed: true, pts: sq(20, 20, 60) }];
  ok('inside: small in big', O.polysInside(small, big));
  ok('inside: big not in small', !O.polysInside(big, small));
  ok('inside: overlapping is not inside', !O.polysInside([{ closed: true, pts: sq(95, 10, 10) }], big));
  ok('inside: in the hole of a ring still counts', O.polysInside([{ closed: true, pts: sq(40, 40, 5) }], donut));
  ok('inside: an open path is not a container', !O.polysInside(small, [{ closed: false, pts: sq(0, 0, 100) }]));
  ok('inside: open path inside a closed one', O.polysInside([{ closed: false, pts: [[10, 10], [20, 30]] }], big));
}

// --- samples along a path
{
  const s = O.samplePath(sq(0, 0, 10), true, 4);
  ok('along path: 4 on a square = the corners', s.length === 4 && ptEq([s[1].x, s[1].y], [10, 0]) && ptEq([s[2].x, s[2].y], [10, 10]));
  ok('along path: faces along the next edge', near(s[0].angle, 0) && near(s[1].angle, 90) && near(Math.abs(s[2].angle), 180) && near(s[3].angle, -90), s.map(q => q.angle).join(','));
  const l = O.samplePath([[0, 0], [10, 0]], false, 3);
  ok('along path: open line includes both ends', l.length === 3 && ptEq([l[0].x, l[0].y], [0, 0]) && ptEq([l[2].x, l[2].y], [10, 0]) && ptEq([l[1].x, l[1].y], [5, 0]));
  const sp = O.samplePath(sq(0, 0, 10), true, 0, 15);
  ok('along path: fixed spacing', sp.length === 2 && ptEq([sp[1].x, sp[1].y], [10, 5]), JSON.stringify(sp.map(q => [q.x, q.y])));
  ok('along path: one copy', O.samplePath([[0, 0], [10, 0]], false, 1).length === 1);
  ok('along path: zero-length path', O.samplePath([[1, 1], [1, 1]], false, 3).length === 0);
}

// --- dock
{
  const area = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const box = { minX: 50, maxX: 60, minY: 0, maxY: 10 };
  ok('dock: to the bed edge', O.dockBoxes([box], [], area, 'left')[0][0] === -50);
  ok('dock: stops at an object in the way', O.dockBoxes([box], [{ minX: 10, maxX: 20, minY: 5, maxY: 15 }], area, 'left')[0][0] === -30);
  ok('dock: padding', O.dockBoxes([box], [{ minX: 10, maxX: 20, minY: 5, maxY: 15 }], area, 'left', 2)[0][0] === -28);
  ok('dock: ignores objects not in the way', O.dockBoxes([box], [{ minX: 10, maxX: 20, minY: 20, maxY: 30 }], area, 'left')[0][0] === -50);
  const two = O.dockBoxes([{ minX: 70, maxX: 80, minY: 0, maxY: 10 }, box], [], area, 'left');
  ok('dock: several objects stack up', two[1][0] === -50 && two[0][0] === -60, JSON.stringify(two));
  ok('dock: slides out of a frame it is inside', O.dockBoxes([{ minX: 40, maxX: 50, minY: 40, maxY: 50 }], [{ ...area }], area, 'left')[0][0] === -40);
  ok('dock: down / right', O.dockBoxes([box], [], area, 'down')[0][1] === 90 && O.dockBoxes([box], [], area, 'right')[0][0] === 40);
  ok('dock: never moves backwards', O.dockBoxes([{ minX: -5, maxX: 5, minY: 0, maxY: 10 }], [], area, 'left')[0][0] === 0);
  ok('dock: up', O.dockBoxes([{ minX: 0, maxX: 10, minY: 50, maxY: 60 }], [{ minX: 5, maxX: 8, minY: 10, maxY: 20 }], area, 'up')[0][1] === -30);
}

// --- node editing
{
  const square = [{ closed: true, pts: sq(0, 0, 10) }];
  const b = O.breakAt(square, 0, 1);
  ok('break: closed loop opens at the node', b.length === 1 && !b[0].closed && b[0].pts.length === 5 && ptEq(b[0].pts[0], [10, 0]) && ptEq(b[0].pts[4], [10, 0]));
  const open = [{ closed: false, pts: [[0, 0], [1, 0], [2, 0], [3, 0]] }];
  const b2 = O.breakAt(open, 0, 2);
  ok('break: open path splits in two', b2.length === 2 && b2[0].pts.length === 3 && b2[1].pts.length === 2 && ptEq(b2[1].pts[0], [2, 0]));
  ok('break: an end point cannot break', O.breakAt(open, 0, 0) === null && O.breakAt(open, 0, 3) === null);
  const r = O.removeSegment(square, 0, 0);
  ok('delete segment: closed loop opens', r.length === 1 && !r[0].closed && r[0].pts.length === 4 && ptEq(r[0].pts[0], [10, 0]) && ptEq(r[0].pts[3], [0, 0]));
  const rc = O.removeSegment(square, 0, 3);
  ok('delete segment: the closing line', !rc[0].closed && ptEq(rc[0].pts[0], [0, 0]) && ptEq(rc[0].pts[3], [0, 10]));
  const r2 = O.removeSegment(open, 0, 1);
  ok('delete segment: open path splits', r2.length === 2 && r2[0].pts.length === 2 && r2[1].pts.length === 2);
  ok('delete segment: last segment of a 2-point line removes it', O.removeSegment([{ closed: false, pts: [[0, 0], [1, 1]] }], 0, 0).length === 0);
  const keep = O.removeSegment([square[0], { closed: false, pts: [[0, 0], [5, 5]] }], 1, 0);
  ok('delete segment: other sub-paths kept', keep.length === 1 && keep[0].closed);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
