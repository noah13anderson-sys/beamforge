// Ruida DSP laser controllers (RDC6442/6445, 654x, 634x…): command encoding, byte "swizzling" and RD job files.
//
// Written from public protocol notes (EduTech wiki "Ruida", jnweiger/ruida-laser docs, and the MIT-licensed
// MeerK40t project's documented command table). No vendor code is used. This module has no DOM dependencies,
// so the server and tests can use it too.

export const MAGIC_DEFAULT = 0x88; // RDC644xG/S, 654xG, 320, 633x. (634xG uses 0x11, RDL9635 uses 0x38)
export const MAGICS = [0x88, 0x11, 0x38];

export function swizzleByte(b, m) {
  b ^= (b >> 7) & 0xFF; b ^= (b << 7) & 0xFF; b ^= (b >> 7) & 0xFF;
  b ^= m;
  return (b + 1) & 0xFF;
}
export function unswizzleByte(b, m) {
  b = (b - 1) & 0xFF;
  b ^= m;
  b ^= (b >> 7) & 0xFF; b ^= (b << 7) & 0xFF; b ^= (b >> 7) & 0xFF;
  return b;
}
const tables = new Map();
function table(m) {
  let t = tables.get(m);
  if (!t) {
    const sw = new Uint8Array(256), un = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { sw[i] = swizzleByte(i, m); un[i] = unswizzleByte(i, m); }
    tables.set(m, t = { sw, un });
  }
  return t;
}
export function swizzle(bytes, m = MAGIC_DEFAULT) { const t = table(m).sw; return Uint8Array.from(bytes, b => t[b]); }
export function unswizzle(bytes, m = MAGIC_DEFAULT) { const t = table(m).un; return Uint8Array.from(bytes, b => t[b]); }

// UDP datagram: 2-byte big-endian checksum (16-bit sum of the swizzled payload) + swizzled payload.
export function packet(plain, m = MAGIC_DEFAULT) {
  const sw = swizzle(plain, m);
  let sum = 0;
  for (const b of sw) sum += b;
  const out = new Uint8Array(sw.length + 2);
  out[0] = (sum >> 8) & 0xFF; out[1] = sum & 0xFF; out.set(sw, 2);
  return out;
}

export const ACK = 0xCC, ERR = 0xCD, ENQ = 0xCE, NAK = 0xCF;

// ---------------------------------------------------------------- number encodings (7-bit groups, MSB first)
export function e14(v) { v = Math.round(v); return [(v >> 7) & 0x7F, v & 0x7F]; }
export function e35(v) {
  v = Math.round(v);
  if (v < 0) v += 2 ** 35; // 35-bit two's complement
  const out = [];
  for (let s = 28; s >= 0; s -= 7) out.push(Math.floor(v / 2 ** s) & 0x7F);
  return out;
}
export function d35(bytes, i = 0) { let v = 0; for (let k = 0; k < 5; k++) v = v * 128 + (bytes[i + k] & 0x7F); return v >= 2 ** 34 ? v - 2 ** 35 : v; }
const pw = pct => e14(Math.floor(Math.max(0, Math.min(100, pct)) * 16383 / 100)); // truncates, as the reference does
const sp = mmPerS => e35(mmPerS * 1000);
export const colorInt = hex => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return ((n & 0xFF) << 16) | (n & 0xFF00) | ((n >> 16) & 0xFF); }; // 0xBBGGRR

// ---------------------------------------------------------------- immediate commands
export const cmd = {
  query: addr => [0xDA, 0x00, (addr >> 7) & 0x7F, addr & 0x7F],
  rapidTo: (xUm, yUm) => [0xD9, 0x10, 0x02, ...e35(xUm), ...e35(yUm)], // move, laser off, no light
  home: () => [0xD8, 0x2A],
  stop: () => [0xD8, 0x01],
  pause: () => [0xD8, 0x02],
  resume: () => [0xD8, 0x03],
  enq: () => [ENQ],
};
export const MEM = { status: 0x0400, x: 0x0421, y: 0x0431, z: 0x0441, bedX: 0x0026, bedY: 0x0036, cardId: 0x057E };
// Status bits as observed by MeerK40t: 0x01000000 moving, 0x02 part end, 0x01 job running (wiki: 0x10 moving).
export function decodeStatus(v) {
  const moving = !!(v & 0x01000000) || !!(v & 0x10);
  const running = !!(v & 0x01);
  return { moving, running, busy: moving || running };
}
// Query reply: DA 01 a0 a1 v(5)
export function parseReply(plain) {
  if (plain.length < 9 || plain[0] !== 0xDA || plain[1] !== 0x01) return null;
  return { addr: (plain[2] << 7) | plain[3], value: d35(plain, 4) };
}

// ---------------------------------------------------------------- job encoding
// job.layers: [{ speed (mm/s), minPower, maxPower (%), color '#rrggbb', air: bool,
//                cmds: [[cut 0|1, xUm, yUm], …] }]  — coordinates already in Ruida machine µm.
export function encodeJob(job) {
  const out = [];
  const put = (...a) => { for (const x of a) Array.isArray(x) ? out.push(...x) : out.push(x); };
  const layers = job.layers.filter(l => l.cmds.length);
  if (!layers.length) throw new Error('Nothing to send');
  if (layers.length > 255) throw new Error('Too many layers for a Ruida job (max 255)');
  const bb = cs => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, x, y] of cs) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return { minX, minY, maxX, maxY };
  };
  const lb = layers.map(l => bb(l.cmds));
  const all = bb(layers.flatMap(l => l.cmds));
  const xy = (x, y) => [...e35(x), ...e35(y)];

  // header
  put(0xD8, 0x10);            // reference point: machine zero (absolute coordinates)
  put(0xE6, 0x01);            // absolute coordinates
  put(0xF0);                  // reference point set
  put(0xF1, 0x02, 0x00);      // block cutting off
  put(0xD8, 0x00);            // start process
  put(0xE7, 0x06, e35(0), e35(0));
  put(0xE7, 0x38, 0x00);
  put(0xE7, 0x03, xy(all.maxX, all.minY));
  put(0xE7, 0x07, xy(all.minX, all.maxY));
  put(0xE7, 0x50, xy(all.maxX, all.minY));
  put(0xE7, 0x51, xy(all.minX, all.maxY));
  put(0xE7, 0x04, [1, 1, 0, 0, 0, 0, 0].flatMap(e14));
  put(0xE7, 0x05, 0x00);
  layers.forEach((l, p) => {
    put(0xC9, 0x04, p, sp(l.speed));
    put(0xC6, 0x31, p, pw(l.minPower)); put(0xC6, 0x32, p, pw(l.maxPower));
    put(0xC6, 0x41, p, pw(l.minPower)); put(0xC6, 0x42, p, pw(l.maxPower));
    put(0xCA, 0x06, p, e35(colorInt(l.color)));
    put(0xCA, 0x41, p, 0x00);
    put(0xE7, 0x52, p, xy(lb[p].minX, lb[p].minY)); put(0xE7, 0x53, p, xy(lb[p].maxX, lb[p].maxY));
    put(0xE7, 0x61, p, xy(lb[p].minX, lb[p].minY)); put(0xE7, 0x62, p, xy(lb[p].maxX, lb[p].maxY));
  });
  put(0xCA, 0x22, layers.length - 1);
  put(0xE7, 0x54, 0x00, e35(0)); put(0xE7, 0x54, 0x01, e35(0));
  put(0xE7, 0x55, 0x00, e35(0)); put(0xE7, 0x55, 0x01, e35(0));
  put(0xF1, 0x03, e35(0), e35(0));
  put(0xE7, 0x0A, e35(0));
  put(0xEA, 0x00);
  put(0xE7, 0x60, 0x00);
  put(0xE7, 0x0B, 0x00);
  put(0xE7, 0x13, xy(all.minX, all.minY));
  put(0xE7, 0x17, xy(all.maxX, all.maxY));
  put(0xE7, 0x23, e35(0), e35(0));
  put(0xE7, 0x24, 0x00);
  put(0xE7, 0x08, [1, 1, 0, 1123, -3328, 4, 3480].flatMap(e14));

  // body
  layers.forEach((l, p) => {
    if (p > 0) put(0xE7, 0x00, 0xCA, 0x01, 0x00, 0xCA, 0x01, 0x30);
    put(0xCA, 0x02, p);
    put(0xCA, 0x01, 0x10);
    put(0xCA, 0x01, l.air ? 0x13 : 0x12);
    put(0xC9, 0x02, sp(l.speed));
    put(0xC6, 0x12, e35(0)); put(0xC6, 0x13, e35(0));
    put(0xC6, 0x01, pw(l.minPower)); put(0xC6, 0x02, pw(l.maxPower));
    put(0xC6, 0x21, pw(l.minPower)); put(0xC6, 0x22, pw(l.maxPower));
    put(0xCA, 0x03, 0x01);
    for (const [cut, x, y] of l.cmds) put(cut ? 0xA8 : 0x88, xy(x, y));
  });

  // footer
  put(0xE7, 0x00, 0xCA, 0x01, 0x00, 0xCA, 0x01, 0x30);
  let sum = 0;
  for (const b of out) sum += b;
  put(0xE5, 0x05, e35(sum + 0xD7));
  put(0xD7);
  return Uint8Array.from(out);
}

// Split a plain command stream into chunks ≤ max bytes, only at command boundaries (bytes ≥ 0x80 start a command).
export function chunk(plain, max = 1000) {
  const out = [];
  let start = 0;
  while (start < plain.length) {
    let end = Math.min(plain.length, start + max);
    if (end < plain.length) {
      while (end > start && plain[end] < 0x80) end--;
      if (end === start) throw new Error('Command longer than packet size');
    }
    out.push(plain.subarray(start, end));
    start = end;
  }
  return out;
}

// Decode a plain stream back into commands (used by the simulator and tests).
const ARGLEN = {
  0x88: 10, 0xA8: 10, 0x89: 4, 0xA9: 4, 0x8A: 2, 0x8B: 2, 0xAA: 2, 0xAB: 2,
};
export function* commands(plain) {
  let i = 0;
  while (i < plain.length) {
    const s = i++;
    while (i < plain.length && plain[i] < 0x80) i++;
    yield plain.subarray(s, i);
  }
}
export { ARGLEN };
