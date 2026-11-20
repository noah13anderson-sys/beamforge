// Run with: npm test
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.ClipperLib = require(new URL('../public/vendor/clipper.js', import.meta.url).pathname);
const base = new URL('../public/js/', import.meta.url).href;
const R = await import(base + 'ruida.js');
const D = await import(base + 'devices.js');
const { generateJob, jobFrame } = await import(base + 'gcode.js');
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' — ' + x : '')); if (!c) fails++; };
// known protocol facts
ok('swizzle ACK 0xCC -> 0xC6 (magic 0x88)', R.swizzleByte(0xCC, 0x88) === 0xC6);
ok('swizzle ERR 0xCD -> 0x46', R.swizzleByte(0xCD, 0x88) === 0x46);
let rt = true; for (const m of R.MAGICS) for (let i = 0; i < 256; i++) if (R.unswizzleByte(R.swizzleByte(i, m), m) !== i) rt = false;
ok('swizzle round-trip all magics', rt);
ok('power 50% = 3F 7F', R.e14(Math.floor(50 * 16383 / 100)).join() === [0x3F, 0x7F].join());
ok('speed 100 mm/s = 00 00 06 0D 20', R.e35(100000).map(x => x.toString(16)).join(' ') === '0 0 6 d 20');
ok('e14(-3328) = 66 00', R.e14(-3328).join() === [0x66, 0].join());
ok('d35(e35(-1)) = -1', R.d35(R.e35(-1)) === -1 && R.d35(R.e35(123456789)) === 123456789);
ok('colour #ff8000 -> 0x0080FF', R.colorInt('#ff8000') === 0x0080ff);
// job via generator
const dev = D.makeDevice('ruida', { bedW: 1300, bedH: 900 });
ok('ruida default origin top-right', dev.origin === 'tr');
const L = { id: 'a', name: 'Cut', mode: 'line', output: true, speed: 20, power: 65, minPower: 0, passes: 2, air: true, color: '#e5484d' };
const sq = { id: 's', type: 'rect', w: 100, h: 50, layer: 'a', tf: { x: 200, y: 100, sx: 1, sy: 1, r: 0 } };
const job = generateJob({ layers: [L], objects: [sq] }, dev, {});
const bytes = job.ruida;
ok('job ends with D7', bytes[bytes.length - 1] === 0xD7);
ok('job starts D8 10', bytes[0] === 0xD8 && bytes[1] === 0x10);
const cmds = [...R.commands(bytes)];
const cuts = cmds.filter(c => c[0] === 0xA8).map(c => [R.d35(c, 1) / 1000, R.d35(c, 6) / 1000]);
ok('cut count 8 (4 edges × 2 passes)', cuts.length === 8, String(cuts.length));
const xs = cuts.map(c => c[0]), ys = cuts.map(c => c[1]);
// design x 150..250 -> ruida x = 1300 - x = 1050..1150 ; y 75..125
ok('X mirrored for top-right origin', Math.min(...xs) === 1050 && Math.max(...xs) === 1150, `${Math.min(...xs)}..${Math.max(...xs)}`);
ok('Y from top', Math.min(...ys) === 75 && Math.max(...ys) === 125);
const pw = cmds.find(c => c[0] === 0xC6 && c[1] === 0x02);
ok('layer power 65%', pw && Math.round(((pw[2] << 7) | pw[3]) * 100 / 16383) === 65);
ok('minPower defaults to max (no corner under-burn)', cmds.find(c => c[0] === 0xC6 && c[1] === 0x01)[2] === pw[2]);
ok('air assist on (CA 01 13)', cmds.some(c => c[0] === 0xCA && c[1] === 0x01 && c[2] === 0x13));
const sp = cmds.find(c => c[0] === 0xC9 && c[1] === 0x02);
ok('speed 20 mm/s', R.d35(sp, 2) === 20000);
let sum = 0; let sumCmd; for (const c of cmds) { if (c[0] === 0xE5) { sumCmd = c; break; } for (const v of c) sum += v; }
ok('file sum E5 05 correct', R.d35(sumCmd, 2) === sum + 0xD7);
// dry run & power limit
const dry = [...R.commands(generateJob({ layers: [L], objects: [sq] }, dev, { dryRun: true }).ruida)].filter(c => c[0] === 0xC6 && (c[1] === 0x02 || c[1] === 0x32));
ok('dry run = 0% power everywhere', dry.length && dry.every(c => c[c.length - 1] === 0 && c[c.length - 2] === 0));
const lim = [...R.commands(generateJob({ layers: [L], objects: [sq] }, { ...dev, powerLimit: 30 }, {}).ruida)].find(c => c[0] === 0xC6 && c[1] === 0x02);
ok('power limit 30%', Math.round(((lim[2] << 7) | lim[3]) * 100 / 16383) === 30);
// out of bounds rejected
let threw = false; try { generateJob({ layers: [L], objects: [{ ...sq, tf: { ...sq.tf, x: 1290 } }] }, dev, {}); } catch (e) { threw = /outside/.test(e.message); }
ok('cutting outside the bed is refused', threw);
// chunking on command boundaries
const ch = R.chunk(bytes, 100);
ok('chunks ≤100 bytes, each starts with a command byte', ch.every(c => c.length <= 100 && c[0] >= 0x80) && ch.reduce((a, c) => a + c.length, 0) === bytes.length, `${ch.length} chunks`);
// packet checksum
const pk = R.packet([0xDA, 0x00, 0x05, 0x7E]);
const sw = R.swizzle([0xDA, 0x00, 0x05, 0x7E]); const s2 = sw.reduce((a, b) => a + b, 0);
ok('packet checksum = sum of swizzled bytes', ((pk[0] << 8) | pk[1]) === (s2 & 0xffff));
// frame in ruida coords
const fr = jobFrame({ layers: [L], objects: [sq] }, dev, {});
ok('frame mirrored', Math.min(...fr.map(p => p[0])) === 1050);
console.log(`job: ${bytes.length} bytes, ${cmds.length} commands`);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
