// Image tracing: corner-keeping smoothing, preview/full-detail consistency and the Auto trace settings.
// Run with: npm test
const R = await import(new URL('../public/js/raster.js', import.meta.url).href);
const G = await import(new URL('../public/js/geom.js', import.meta.url).href);
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? ' — ' + extra : '')); if (!cond) fails++; };

// distance from point p to closed polygon pts
const segD = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const distPoly = (p, pts) => Math.min(...pts.map((a, i) => segD(p, a, pts[(i + 1) % pts.length])));
// a W×H gray raster (255 = white) with paint(x, y) → value
const raster = (W, H, paint) => { const v = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = paint(x, y); return v; };
const square = (x0, y0, s, inside = 0, outside = 255) => (x, y) => (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s ? inside : outside);

// --- Otsu threshold
{
  const h = new Float64Array(256); h[0] = 100; h[255] = 300;
  const r = R.otsu(h);
  ok('otsu: black/white splits in the middle', r.t === 127 && Math.abs(r.eta - 1) < 1e-9, JSON.stringify(r));
  const g = new Float64Array(256); for (let i = 30; i <= 50; i++) g[i] = 10; for (let i = 190; i <= 210; i++) g[i] = 30;
  const r2 = R.otsu(g);
  ok('otsu: two groups split between them', r2.t >= 50 && r2.t < 190 && Math.abs(r2.m0 - 40) < 1e-9 && Math.abs(r2.m1 - 200) < 1e-9, JSON.stringify(r2));
  const f = new Float64Array(256); f[128] = 50;
  ok('otsu: one shade has no split', R.otsu(f).eta === 0);
}

// --- region sizes
{
  const W = 10, H = 6, m = new Uint8Array(W * H);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * W + x] = 1; // 3×3
  m[2 * W + 7] = 1; // 1 px
  m[5 * W + 9] = 1; m[4 * W + 8] = 1; // diagonal neighbours are separate regions
  const s = R.regionSizes(m, W, H, 1).sort((a, b) => a - b);
  ok('regions: sizes of 4-connected regions', JSON.stringify(s) === '[1,1,1,9]', JSON.stringify(s));
  ok('regions: background counted too', R.regionSizes(m, W, H, 0).reduce((a, b) => a + b, 0) === W * H - 12);
}

// --- smoothing keeps corners sharp and rounds curves
{
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const s = R.smoothLoop(sq, 1, 0.4 * 4 / 3);
  ok('smooth: square corners stay sharp', sq.every(c => s.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < 1e-9)), JSON.stringify(s));
  const all = R.smoothLoop(sq, 1, 4 / 3);
  ok('smooth: highest smoothness rounds corners', all.length === 8 && distPoly([0, 0], all) > 10);
  const circle = Array.from({ length: 24 }, (_, i) => [50 * Math.cos(i * Math.PI / 12), 50 * Math.sin(i * Math.PI / 12)]);
  const c = R.smoothLoop(circle, 1, 0.4 * 4 / 3);
  ok('smooth: curves get rounded', c.length === 48);
  const spike = [[0, 0], [50, 0], [0, 0.0000000001], [-50, 0], [-50, 10]];
  ok('smooth: no iterations leaves points alone', R.smoothLoop(spike, 0, 0.5) === spike);
}

// --- tracing a square: corners within ~1.5 px at the default smoothness (was ~18 px before corner keeping)
{
  const W = 140, H = 140, v = raster(W, H, square(20, 20, 100));
  const loops = R.traceValues(v, W, H, { mode: 'brightness', cutoff: 0, threshold: 128, smooth: 0.4, optimize: 0.6, ignore: 6 }).map(p => p.pts);
  ok('trace: one square found', loops.length === 1, String(loops.length));
  const gaps = [[20, 20], [120, 20], [120, 120], [20, 120]].map(p => distPoly(p, loops[0]));
  ok('trace: square corners kept', gaps.every(g => g < 1.5), gaps.map(g => g.toFixed(2)).join(' '));
  const heavy = R.traceValues(v, W, H, { smooth: 1, optimize: 0.6, ignore: 6 }).map(p => p.pts);
  ok('trace: smoothness 1 rounds them', [[120, 20], [120, 120]].some(p => distPoly(p, heavy[0]) > 5));
}

// --- accuracy: edges where the picture's edges are, not half a pixel inside
{
  // supersampled anti-aliased raster: inside(x, y) in pixel units → dark (#111) on white
  const aa = (W, H, inside, ss = 8) => raster(W, H, (x, y) => {
    let c = 0;
    for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) if (inside(x + (i + 0.5) / ss, y + (j + 0.5) / ss)) c++;
    return Math.round(255 - 238 * c / (ss * ss));
  });
  const opts = { mode: 'brightness', cutoff: 0, threshold: 136, smooth: 0, optimize: 0.6, ignore: 2 };
  const sqr = R.traceValues(raster(140, 140, square(20, 20, 100, 17)), 140, 140, opts)[0].pts;
  const xs = sqr.map(p => p[0]), ys = sqr.map(p => p[1]);
  ok('accuracy: traced square is the right size', Math.abs(Math.min(...xs) - 20) < 0.05 && Math.abs(Math.max(...xs) - 120) < 0.05 && Math.abs(Math.min(...ys) - 20) < 0.05 && Math.abs(Math.max(...ys) - 120) < 0.05,
    `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}, ${Math.min(...ys).toFixed(3)}–${Math.max(...ys).toFixed(3)}`);
  ok('accuracy: square has 4 corners', sqr.length === 4, String(sqr.length));
  ok('accuracy: square area within 0.2 %', Math.abs(Math.abs(G.polyArea(sqr)) - 10000) < 20, Math.abs(G.polyArea(sqr)).toFixed(1));
  // a slanted anti-aliased edge: points lie on the true line, and few are needed
  const k = Math.tan(10 * Math.PI / 180), slant = aa(200, 120, (x, y) => x > 20 && x < 180 && y > 30 + k * (x - 20) && y < 100);
  const sl = R.traceValues(slant, 200, 120, opts)[0].pts;
  const want = [[20, 30], [180, 30 + 160 * k], [180, 100], [20, 100]];
  const off = want.map(w => Math.min(...sl.map(p => Math.hypot(p[0] - w[0], p[1] - w[1]))));
  ok('accuracy: slanted anti-aliased shape has its 4 corners', sl.length === 4, String(sl.length));
  ok('accuracy: corners within 0.1 px', Math.max(...off) < 0.1, off.map(d => d.toFixed(3)).join(' '));
  // an anti-aliased circle keeps its radius
  const circ = aa(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 40);
  const cl = R.traceValues(circ, 120, 120, { ...opts, smooth: 0.4 })[0].pts;
  const radii = cl.map(p => Math.hypot(p[0] - 60, p[1] - 60));
  ok('accuracy: circle radius within 0.25 px', Math.max(...radii.map(r => Math.abs(r - 40))) < 0.25, `${Math.min(...radii).toFixed(3)}–${Math.max(...radii).toFixed(3)}`);
}

// --- the quick preview treats Ignore like the full-detail trace (sizes are in full-detail pixels)
{
  const W = 200, H = 200;
  const v = raster(W, H, (x, y) => (square(40, 40, 100)(x, y) === 0 || (x >= 170 && x < 174 && y >= 20 && y < 24) ? 0 : 255)); // big square + 16 px² speck
  const half = raster(W / 2, H / 2, (x, y) => v[(2 * y) * W + 2 * x]);
  const count = (vals, w, h, unit, ignore) => R.traceValues(vals, w, h, { ignore, unit }).length;
  ok('preview: speck kept below Ignore at both sizes', count(v, W, H, 1, 10) === 2 && count(half, W / 2, H / 2, 2, 10) === 2);
  ok('preview: speck dropped above Ignore at both sizes', count(v, W, H, 1, 30) === 1 && count(half, W / 2, H / 2, 2, 30) === 1);
}

// --- outlines come out in pieces: an outline plus the holes in it (an island in a hole is its own piece)
{
  const W = 200, H = 120;
  const v = raster(W, H, (x, y) => {
    const ring = Math.hypot(x - 60, y - 60), d2 = Math.hypot(x - 150, y - 60);
    return (ring < 40 && ring > 25) || ring < 10 || d2 < 25 ? 0 : 255; // a ring with a dot in its hole, and a disc
  });
  const paths = R.traceValues(v, W, H, { threshold: 128, ignore: 2 });
  ok('pieces: four outlines found', paths.length === 4, String(paths.length));
  const pieceOf = (x, y) => paths.find(p => p.pts.some(q => Math.abs(Math.hypot(q[0] - x, q[1] - y)) < 200) && G.pointInPoly(x, y, p.pts) && Math.abs(G.polyArea(p.pts)) < 1e9)?.piece;
  const ids = new Set(paths.map(p => p.piece));
  ok('pieces: ring (with its hole), dot, disc', ids.size === 3, JSON.stringify(paths.map(p => [p.piece, Math.round(Math.abs(G.polyArea(p.pts)))])));
  const byArea = paths.slice().sort((a, b) => Math.abs(G.polyArea(b.pts)) - Math.abs(G.polyArea(a.pts)));
  const outer = byArea.find(p => Math.abs(G.polyArea(p.pts)) > 4000), hole = byArea.find(p => p !== outer && G.pointInPoly(60, 60, p.pts) && Math.abs(G.polyArea(p.pts)) > 1000);
  ok('pieces: the hole goes with its ring', outer && hole && outer.piece === hole.piece);
  ok('pieces: all closed', paths.every(p => p.closed));
}

// --- center line trace: one line along the middle of each stroke
{
  const W = 220, H = 160;
  const lenOf = pts => pts.reduce((a, q, i) => (i ? a + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0), 0);
  const C = { threshold: 128, center: true, ignore: 2, smooth: 0.4, optimize: 0.6 };
  // a thick horizontal bar, 12 px wide, from x 20 to 200 at y 40
  const bar = R.traceValues(raster(W, H, (x, y) => (x >= 20 && x < 200 && y >= 34 && y < 46 ? 0 : 255)), W, H, C);
  ok('center: a bar gives one line', bar.length === 1 && !bar[0].closed, JSON.stringify(bar.map(p => p.pts.length)));
  const b0 = bar[0].pts, xs = b0.map(q => q[0]);
  ok('center: along the middle of the bar', b0.every(q => Math.abs(q[1] - 40) < 0.8), JSON.stringify(b0.map(q => q.map(Math.round))));
  ok('center: reaches (nearly) both ends', Math.min(...xs) < 24 && Math.max(...xs) > 196, `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`);
  ok('center: no side branches at the square ends', b0.length <= 4, String(b0.length));
  // a plus sign: two straight lines crossing, one piece
  const plus = R.traceValues(raster(W, H, (x, y) => ((x >= 104 && x < 116 && y >= 20 && y < 140) || (x >= 30 && x < 190 && y >= 74 && y < 86) ? 0 : 255)), W, H, C);
  ok('center: a plus gives two lines', plus.length === 2, String(plus.length));
  ok('center: the plus is one piece', new Set(plus.map(p => p.piece)).size === 1);
  ok('center: both lines run the full length', plus.every(p => lenOf(p.pts) > 110), plus.map(p => lenOf(p.pts).toFixed(0)).join(' '));
  // a drawn ring gives one closed line in the middle of the stroke
  const ring = R.traceValues(raster(W, H, (x, y) => { const r = Math.hypot(x + 0.5 - 110, y + 0.5 - 80); return r > 44 && r < 56 ? 0 : 255; }), W, H, C);
  ok('center: a ring gives one closed line', ring.length === 1 && ring[0].closed, JSON.stringify(ring.map(p => [p.closed, p.pts.length])));
  const radii = ring[0].pts.map(q => Math.hypot(q[0] - 110, q[1] - 80));
  ok('center: the ring line is in the middle', radii.every(r => Math.abs(r - 50) < 1.5), `${Math.min(...radii).toFixed(2)}–${Math.max(...radii).toFixed(2)}`);
  // a T: the bar stays one straight line, the stem is a second line ending on it
  const T = R.traceValues(raster(W, H, (x, y) => ((x >= 30 && x < 190 && y >= 30 && y < 42) || (x >= 104 && x < 116 && y >= 30 && y < 140) ? 0 : 255)), W, H, C);
  ok('center: a T gives two lines', T.length === 2, String(T.length));
  const top = T.find(p => p.pts.every(q => q[1] < 50));
  ok('center: the T bar is straight through', top && top.pts.length <= 4 && lenOf(top.pts) > 150, top ? top.pts.map(q => q.map(Math.round)).join(' ') : 'none');
  // two separate strokes are two pieces; specks are ignored
  const two = R.traceValues(raster(W, H, (x, y) => ((x >= 20 && x < 100 && y >= 20 && y < 30) || (x >= 20 && x < 100 && y >= 100 && y < 110) || (x === 150 && y === 60) ? 0 : 255)), W, H, { ...C, ignore: 6 });
  ok('center: separate strokes are separate pieces, specks ignored', two.length === 2 && new Set(two.map(p => p.piece)).size === 2, String(two.length));
  // a thin 1-pixel line still works
  const thin = R.traceValues(raster(W, H, (x, y) => (y === Math.round(20 + x * 0.5) && x > 10 && x < 200 ? 0 : 255)), W, H, C);
  ok('center: a 1-pixel diagonal line gives one line', thin.length === 1 && lenOf(thin[0].pts) > 200, thin.map(p => lenOf(p.pts).toFixed(0)).join(' '));
  // the T's stem ends on the bar's line instead of poking through it, and still reaches its own end
  const stem = T.find(p => p !== top), sy = stem ? stem.pts.map(q => q[1]) : [0];
  ok('center: the T stem ends on the bar line', Math.abs(Math.min(...sy) - 36) < 1.5 && Math.max(...sy) > 136, `${Math.min(...sy).toFixed(1)}–${Math.max(...sy).toFixed(1)}`);
  // thick bars still reach their ends (the corner branches thinning leaves there are dropped first)
  for (const th of [24, 36]) {
    const tb = R.traceValues(raster(W, H, (x, y) => (x >= 20 && x < 200 && y >= 80 - th / 2 && y < 80 + th / 2 ? 0 : 255)), W, H, C);
    const tx = tb.flatMap(p => p.pts.map(q => q[0]));
    ok(`center: a ${th}-pixel bar is one line end to end`, tb.length === 1 && Math.min(...tx) < 24 && Math.max(...tx) > 196, `${tb.length} ${Math.min(...tx).toFixed(1)}–${Math.max(...tx).toFixed(1)}`);
  }
  // line ends are stretched back out to the ends of the strokes, but never out of the ink: a thick bar with a notch in
  // its end (the short prongs either side are where thinning's corner branches get dropped)
  const fork = raster(W, H, (x, y) => (x >= 20 && x < 160 && y >= 70 && y < 90 && !(x >= 150 && y >= 77 && y < 83) ? 0 : 255));
  const fk = R.traceValues(fork, W, H, C), outside = fk.flatMap(p => p.pts.filter(q => fork[Math.floor(q[1]) * W + Math.floor(q[0])] !== 0));
  ok('center: line ends never leave the ink', fk.length > 0 && !outside.length, JSON.stringify(outside));
  // a filled dot — plain Zhang–Suen thinned it away completely — keeps its outline
  const dot = R.traceValues(raster(W, H, (x, y) => (Math.hypot(x + 0.5 - 60, y + 0.5 - 60) < 10 ? 0 : 255)), W, H, C);
  ok('center: a dot is kept, as its outline', dot.length === 1 && dot[0].closed, JSON.stringify(dot.map(p => [p.closed, p.pts.length])));
  const dr = dot.length ? dot[0].pts.map(q => Math.hypot(q[0] - 60, q[1] - 60)) : [0];
  ok('center: the dot outline is the dot', dr.every(r => Math.abs(r - 10) < 1), `${Math.min(...dr).toFixed(2)}–${Math.max(...dr).toFixed(2)}`);
  const dots = R.traceValues(raster(W, H, (x, y) => (Math.hypot(x + 0.5 - 60, y + 0.5 - 60) < 10 || Math.hypot(x + 0.5 - 160, y + 0.5 - 60) < 4 || (x >= 20 && x < 200 && y >= 120 && y < 128) ? 0 : 255)), W, H, C);
  ok('center: dots beside a line: two outlines and one line', dots.length === 3 && dots.filter(p => p.closed).length === 2 && new Set(dots.map(p => p.piece)).size === 3,
    JSON.stringify(dots.map(p => [p.closed, p.piece])));
  // the thinning never wipes out a 2×2 block or a 2-pixel-thick diagonal (plain Zhang–Suen does)
  ok('center: thinning keeps a 2×2 block', R.thinMask(raster(4, 4, (x, y) => (x >= 1 && x < 3 && y >= 1 && y < 3 ? 1 : 0)), 4, 4).some(v => v));
  const diag = R.traceValues(raster(W, H, (x, y) => (x > 10 && x < 150 && (y === x || y === x + 1) ? 0 : 255)), W, H, C);
  ok('center: a 2-pixel diagonal gives one unbroken line', diag.length === 1 && lenOf(diag[0].pts) > 190, diag.map(p => lenOf(p.pts).toFixed(0)).join(' '));
}

// --- traceSize keeps the longest side within the limit
{
  ok('size: res × size', JSON.stringify(R.traceSize({ w: 50, h: 20 }, 10)) === '[500,200]');
  const [W, H] = R.traceSize({ w: 600, h: 300 }, 10);
  ok('size: capped at TRACE_MAX_PX', W === R.TRACE_MAX_PX && H === 1500, `${W}x${H}`);
}

// --- image adjustments applied to pixels (for browsers that ignore canvas filters)
{
  const L = R.adjustLut({ brightness: 50, contrast: 100, invert: false }), C = R.adjustLut({ brightness: 100, contrast: 200 });
  ok('adjust: brightness 50 % halves', L[255] === 128 && L[0] === 0, `${L[255]} ${L[0]}`);
  ok('adjust: contrast 200 % stretches around the middle', C[64] === 0 && C[191] === 255 && Math.abs(C[128] - 128) <= 1, `${C[64]} ${C[128]} ${C[191]}`);
  const I = R.adjustLut({ invert: true });
  ok('adjust: invert flips', I[0] === 255 && I[255] === 0 && I[100] === 155);
  ok('adjust: defaults change nothing', R.adjustLut({}).every((v, i) => v === i));
}

// --- Auto trace settings
{
  const W = 200, H = 160, opaque = new Uint8Array(W * H).fill(255), p = 10;
  const logo = raster(W, H, square(60, 40, 80));
  const a = R.autoTraceSettings(logo, opaque, W, H, p);
  ok('auto: dark logo on white → brightness 0–threshold', a.mode === 'brightness' && a.cutoff === 0 && a.threshold >= 100 && a.threshold <= 160 && a.lightBg, JSON.stringify(a));
  ok('auto: clean artwork keeps detail', !a.noisy && a.ignore === 2 && !a.photo);
  const inv = R.autoTraceSettings(raster(W, H, square(60, 40, 80, 255, 0)), opaque, W, H, p);
  ok('auto: white on black → traces the light part', inv.mode === 'brightness' && inv.cutoff > 100 && inv.threshold === 255 && !inv.lightBg, JSON.stringify(inv));
  // white logo on a transparent background: over white it vanishes, so trace the transparency
  const white = new Uint8Array(W * H).fill(255), alpha = raster(W, H, square(60, 40, 80, 255, 0));
  ok('auto: white logo on transparent → transparency', R.autoTraceSettings(white, alpha, W, H, p).mode === 'transparency');
  ok('auto: dark logo on transparent → brightness keeps inner detail', R.autoTraceSettings(logo, alpha, W, H, p).mode === 'brightness');
  // speckled scan: lots of tiny dots around the shape
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const dots = new Set(); for (let i = 0; i < 150; i++) dots.add(Math.floor(rnd() * W * H));
  const noisy = raster(W, H, (x, y) => (dots.has(y * W + x) ? 30 : square(60, 40, 80)(x, y)));
  const nz = R.autoTraceSettings(noisy, opaque, W, H, p);
  ok('auto: speckled → ignores specks', nz.noisy && nz.ignore === 12 && nz.smooth > a.smooth, JSON.stringify(nz));
  ok('auto: the specks really go', R.traceValues(noisy, W, H, nz).length === 1);
  ok('auto: flat picture → nothing to trace', R.autoTraceSettings(new Uint8Array(W * H).fill(128), opaque, W, H, p).none === 'flat');
  ok('auto: faint picture → nothing to trace', R.autoTraceSettings(raster(W, H, square(60, 40, 80, 120, 130)), opaque, W, H, p).none === 'faint');
  const photo = raster(W, H, (x, y) => Math.round(255 * x / (W - 1)));
  ok('auto: smooth tones count as a photo', R.autoTraceSettings(photo, opaque, W, H, p).photo === true);
  const sk = R.autoTraceSettings(logo, opaque, W, H, p, { sketch: true });
  ok('auto: Sketch mode stays Sketch', sk.mode === 'sketch' && sk.edge >= 1 && sk.edge <= 254, JSON.stringify(sk));
  const edges = R.traceValues(logo, W, H, { ...sk, mode: 'sketch' });
  ok('auto: sketch edges found', edges.length >= 1, String(edges.length));

  // center line: the darkest group of tones, i.e. the outlines of coloured artwork
  const h = new Float64Array(256); h[80] = 40; h[82] = 60; h[140] = 300; h[150] = 500; h[180] = 400; h[230] = 600;
  const dg = R.darkestGroup(h);
  ok('auto: darkest group = the dark outlines', dg > 82 && dg < 140, String(dg));
  ok('auto: no darkest group in a smooth ramp', R.darkestGroup(new Float64Array(256).fill(10)) === -1);
  // a light-blue filled whale-ish blob with a dark outline, on a mid-blue background
  const art = raster(W, H, (x, y) => { const r = Math.hypot(x - 100, y - 80); return r < 50 ? 150 : r < 56 ? 70 : (x + y) % 2 ? 200 : 190; });
  const ca = R.autoTraceSettings(art, opaque, W, H, p, { center: true });
  ok('auto center: coloured artwork → just its dark outline', ca.lines && ca.mode === 'brightness' && ca.cutoff === 0 && ca.threshold > 70 && ca.threshold < 150 && ca.lightBg, JSON.stringify(ca));
  const cl = R.traceValues(art, W, H, { ...ca, center: true });
  ok('auto center: one closed line round the middle of the outline', cl.length === 1 && cl[0].closed && cl[0].pts.every(q => Math.abs(Math.hypot(q[0] - 100, q[1] - 80) - 53) < 1.5),
    JSON.stringify(cl.map(p => [p.closed, p.pts.length])));
  ok('auto center: same from Sketch mode', R.autoTraceSettings(art, opaque, W, H, p, { center: true, sketch: true }).threshold === ca.threshold);
  // black line art on white: the split falls between the two tones
  const lineArt = raster(W, H, (x, y) => (Math.abs(y - 80) < 3 && x > 20 && x < 180) || (Math.abs(x - 100) < 3 && y > 20 && y < 140) ? 0 : 255);
  const la = R.autoTraceSettings(lineArt, opaque, W, H, p, { center: true });
  ok('auto center: line art → its lines', la.lines && la.threshold > 60 && la.threshold < 200, JSON.stringify(la));
  // white lines on black
  const chalk = raster(W, H, (x, y) => (Math.abs(y - 80) < 3 && x > 20 && x < 180 ? 255 : 0));
  const ch = R.autoTraceSettings(chalk, opaque, W, H, p, { center: true });
  ok('auto center: white lines on black → the light lines', ch.lines && ch.threshold === 255 && ch.cutoff > 60 && ch.cutoff < 200 && !ch.lightBg, JSON.stringify(ch));
  // big filled shapes have no lines to follow: one line along each edge instead
  const fills = R.autoTraceSettings(raster(W, H, (x, y) => (x >= 20 && x < 100 && y >= 20 && y < 140 ? 40 : x >= 110 && x < 190 && y >= 20 && y < 140 ? 130 : 230)), opaque, W, H, p, { center: true });
  ok('auto center: big fills → one line per edge (Sketch)', fills.edges && fills.mode === 'sketch', JSON.stringify(fills));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
