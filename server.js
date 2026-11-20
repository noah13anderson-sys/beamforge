#!/usr/bin/env node
// BeamForge local server.
// Serves the browser UI and bridges it to a GRBL laser over a serial port.
// No npm dependencies: the serial port is configured with `stty` and read/written as a file.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRuida } = require('./ruida-server.js');

const PORT = Number(process.env.BEAMFORGE_PORT) || 8787;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const GRBL_RX_BUFFER = 127; // GRBL has a 128-byte serial RX buffer; keep one byte spare.

// ---------------------------------------------------------------- events (SSE)
const clients = new Set();
function broadcast(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(s);
}

// ---------------------------------------------------------------- transports
class SerialLink {
  constructor(dev, baud, onData, onClose) {
    this.onData = onData;
    this.onClose = onClose;
    this.closing = false;
    this.closed = false;
    this.fd = fs.openSync(dev, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    try {
      // stty configures whatever is on its stdin, so this works on Linux and macOS alike.
      execFileSync('stty', [String(baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb', '-crtscts', 'clocal', 'min', '0', 'time', '1'],
        { stdio: [this.fd, 'ignore', 'pipe'] });
    } catch (e) {
      fs.closeSync(this.fd);
      throw new Error(`Could not configure ${dev}: ${String(e.stderr || e.message).trim()}`);
    }
    this.buf = Buffer.alloc(4096);
    this.read();
  }
  read() {
    fs.read(this.fd, this.buf, 0, this.buf.length, null, (err, n) => {
      if (this.closing) return this.finish();
      if (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') return setTimeout(() => this.read(), 4);
        this.closing = true; this.reason = err.message; return this.finish();
      }
      if (n > 0) { this.onData(this.buf.toString('latin1', 0, n)); return this.read(); }
      setTimeout(() => this.read(), 4);
    });
  }
  write(s) {
    if (this.closing) return;
    let buf = Buffer.from(s, 'latin1');
    for (let tries = 0; buf.length && tries < 200; tries++) {
      try { const n = fs.writeSync(this.fd, buf); buf = buf.subarray(n); }
      catch (e) { if (e.code !== 'EAGAIN') throw e; }
    }
  }
  close(reason = 'Disconnected') { this.reason = reason; this.closing = true; }
  finish() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.onClose(this.reason);
  }
}

// A software GRBL 1.1 so the whole app can be tried without a laser attached.
class VirtualGrbl {
  constructor(onData, onClose) {
    this.onData = onData; this.onClose = onClose;
    this.mpos = [0, 0, 0]; this.wco = [0, 0, 0];
    this.absolute = true; this.feed = 1000; this.power = 0; this.laserOn = false;
    this.state = 'Idle'; this.rx = ''; this.queue = []; this.busy = false; this.hold = false;
    this.speedup = 8; // simulated jobs run this many times faster than real time
    this.open = true;
    setTimeout(() => this.out("\r\nGrbl 1.1h ['$' for help]\r\n"), 250);
  }
  out(s) { if (this.open) this.onData(s); }
  write(str) {
    for (const ch of str) {
      if (ch === '?') this.out(this.status());
      else if (ch === '!') { this.hold = true; if (this.state === 'Run') this.state = 'Hold:0'; }
      else if (ch === '~') { this.hold = false; if (this.state.startsWith('Hold')) this.state = this.busy ? 'Run' : 'Idle'; this.step(); }
      else if (ch === '\x18') this.reset();
      else if (ch === '\x85') { /* jog cancel */ }
      else if (ch === '\n') { const l = this.rx.trim(); this.rx = ''; if (l) { this.queue.push(l); this.step(); } }
      else if (ch !== '\r') this.rx += ch;
    }
  }
  reset() {
    clearTimeout(this.timer);
    this.queue = []; this.busy = false; this.hold = false; this.state = 'Idle'; this.laserOn = false;
    this.out("\r\nGrbl 1.1h ['$' for help]\r\n");
  }
  status() {
    const f = v => v.toFixed(3);
    return `<${this.state}|MPos:${this.mpos.map(f).join(',')}|FS:${this.busy ? this.feed : 0},${this.laserOn ? this.power : 0}|WCO:${this.wco.map(f).join(',')}>\r\n`;
  }
  step() {
    if (this.busy || this.hold) return;
    if (!this.queue.length) { this.state = 'Idle'; return; }
    const line = this.queue.shift();
    this.busy = true; this.state = 'Run';
    const { ms, reply } = this.exec(line);
    this.timer = setTimeout(() => {
      this.busy = false;
      this.out(reply);
      if (this.hold) this.state = 'Hold:0';
      this.step();
    }, ms);
  }
  exec(raw) {
    const line = raw.replace(/\(.*?\)|;.*$/g, '').trim().toUpperCase();
    if (line.startsWith('$')) {
      if (line === '$$') return { ms: 0, reply: '$0=10\r\n$1=25\r\n$10=1\r\n$22=1\r\n$30=1000\r\n$31=0\r\n$32=1\r\n$100=80.000\r\n$101=80.000\r\n$110=6000.000\r\n$111=6000.000\r\n$130=400.000\r\n$131=400.000\r\nok\r\n' };
      if (line === '$I') return { ms: 0, reply: '[VER:1.1h.20190825:BeamForge virtual]\r\n[OPT:VL,15,128]\r\nok\r\n' };
      if (line === '$G') return { ms: 0, reply: `[GC:G0 G54 G17 G21 ${this.absolute ? 'G90' : 'G91'} G94 M5 M9 T0 F${this.feed} S0]\r\nok\r\n` };
      if (line === '$H') { this.mpos = [0, 0, 0]; return { ms: 600, reply: 'ok\r\n' }; }
      if (line === '$X') return { ms: 0, reply: '[MSG:Caution: Unlocked]\r\nok\r\n' };
      if (line.startsWith('$J=')) return this.motion(line.slice(3), true);
      return { ms: 0, reply: 'ok\r\n' };
    }
    if (!line) return { ms: 0, reply: 'ok\r\n' };
    if (line === 'M114') { const p = this.mpos.map((v, i) => (v - this.wco[i]).toFixed(2)); return { ms: 0, reply: `X:${p[0]} Y:${p[1]} Z:${p[2]} E:0.00 Count X:0 Y:0 Z:0\r\nok\r\n` }; }
    if (line === 'M503') return { ms: 0, reply: 'echo:; Steps per unit:\r\necho:  M92 X80.00 Y80.00 Z400.00\r\nok\r\n' };
    if (/^(M410|M999|M5|FIRE)/.test(line)) { if (!line.startsWith('M999')) this.laserOn = /^FIRE (?!OFF)/.test(line); return { ms: 0, reply: 'ok\r\n' }; }
    if (/^G28/.test(line)) { this.mpos = [0, 0, 0]; return { ms: 600, reply: 'ok\r\n' }; }
    if (/^G92/.test(line)) { this.wco[0] = this.mpos[0]; this.wco[1] = this.mpos[1]; return { ms: 0, reply: 'ok\r\n' }; }
    return this.motion(line, false);
  }
  motion(line, jog) {
    const words = {};
    const gs = [];
    for (const m of line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
      if (m[1] === 'G') gs.push(+m[2]); else words[m[1]] = +m[2];
      if (m[1] === 'M') {
        if (m[2] === '3' || m[2] === '4') this.laserOn = true;
        if (m[2] === '5') this.laserOn = false;
      }
    }
    let absolute = this.absolute;
    for (const g of gs) {
      if (g === 90) { absolute = true; if (!jog) this.absolute = true; }
      if (g === 91) { absolute = false; if (!jog) this.absolute = false; }
    }
    if (gs.includes(10) && words.L === 20) { // G10 L20 P1: set work origin at current position
      if ('X' in words) this.wco[0] = this.mpos[0] - words.X;
      if ('Y' in words) this.wco[1] = this.mpos[1] - words.Y;
      return { ms: 0, reply: 'ok\r\n' };
    }
    if ('F' in words) this.feed = words.F;
    if ('S' in words) this.power = words.S;
    const rapid = gs.includes(0);
    const target = this.mpos.slice();
    ['X', 'Y', 'Z'].forEach((a, i) => {
      if (a in words) target[i] = absolute ? words[a] + this.wco[i] : this.mpos[i] + words[a];
    });
    const dist = Math.hypot(target[0] - this.mpos[0], target[1] - this.mpos[1]);
    this.mpos = target;
    const rate = rapid ? 6000 : Math.max(this.feed, 1);
    const ms = Math.min(3000, (dist / rate) * 60000 / this.speedup);
    return { ms, reply: 'ok\r\n' };
  }
  close(reason = 'Disconnected') { this.open = false; this.reset(); this.onClose(reason); }
}

// ---------------------------------------------------------------- controller (GRBL / Smoothieware / Marlin)
// family 'grbl'     — character-counting flow control, realtime '?' status, '!' '~' Ctrl-X
// family 'smoothie' — one line at a time (wait for ok), '?' status (old or new format), '!' '~' Ctrl-X
// family 'marlin'   — one line at a time, position via M114 polling, pause by holding the stream, stop with M410
const FAMILIES = new Set(['grbl', 'smoothie', 'marlin']);
const ctl = {
  link: null, port: null, baud: 115200, family: 'grbl',
  rx: '', queue: [], inflight: [], inflightBytes: 0, paused: false,
  job: null, lastStatus: null, lastPos: [0, 0, 0], wco: [0, 0, 0], pollTimer: null, jobTimer: null, lastPoll: 0,
};

function connected() { return !!ctl.link; }

function poll() {
  if (!ctl.link) return;
  if (ctl.family !== 'marlin') return rawWrite('?');
  if (ctl.job) {
    broadcast({ type: 'status', state: ctl.job.paused ? 'Hold' : 'Run', wpos: ctl.lastPos, mpos: ctl.lastPos, wco: [0, 0, 0] });
  } else if (!ctl.queue.length && !ctl.inflight.length && Date.now() - ctl.lastPoll > 700) {
    ctl.lastPoll = Date.now();
    ctl.queue.push({ text: 'M114', poll: true });
    pump();
  }
}

function connect(port, baud, family) {
  if (ctl.link) disconnect();
  const onData = d => {
    ctl.rx += d;
    let i;
    while ((i = ctl.rx.indexOf('\n')) >= 0) {
      const line = ctl.rx.slice(0, i).replace(/\r$/, '').trim();
      ctl.rx = ctl.rx.slice(i + 1);
      if (line) handleLine(line);
    }
  };
  const onClose = reason => {
    if (ctl.job) endJob('error', `Connection lost: ${reason}`);
    clearInterval(ctl.pollTimer);
    ctl.link = null; ctl.queue = []; ctl.inflight = []; ctl.inflightBytes = 0;
    broadcast({ type: 'conn', connected: false, port: ctl.port, reason });
  };
  ctl.rx = ''; ctl.queue = []; ctl.inflight = []; ctl.inflightBytes = 0; ctl.paused = false;
  ctl.family = FAMILIES.has(family) ? family : 'grbl';
  ctl.link = port === 'virtual' ? new VirtualGrbl(onData, onClose) : new SerialLink(port, baud, onData, onClose);
  ctl.port = port; ctl.baud = baud;
  ctl.pollTimer = setInterval(poll, 250);
  broadcast({ type: 'conn', connected: true, port, family: ctl.family });
}

function disconnect() {
  if (!ctl.link) return;
  ctl.link.close('Disconnected');
}

function rawWrite(s) {
  if (!ctl.link) return;
  try { ctl.link.write(s); } catch (e) { broadcast({ type: 'error', text: `Write failed: ${e.message}` }); ctl.link.close(e.message); }
}

// Handles GRBL 1.1 (<Idle|MPos:..|FS:..>) and the older/Smoothie form (<Idle,MPos:..,WPos:..>).
function parseStatus(line) {
  const body = line.slice(1, line.lastIndexOf('>'));
  const st = { state: body.split(/[|,]/)[0] };
  const vec = key => {
    const m = new RegExp(`${key}:(-?[\\d.]+),(-?[\\d.]+)(?:,(-?[\\d.]+))?`).exec(body);
    return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
  };
  st.mpos = vec('MPos'); st.wpos = vec('WPos');
  const wco = vec('WCO'); if (wco) ctl.wco = wco;
  const fs = /\|FS?:([\d.]+)(?:,([\d.]+))?/.exec(body); if (fs) st.fs = [+fs[1], +(fs[2] || 0)];
  const pn = /\|Pn:([A-Z]+)/.exec(body); if (pn) st.pins = pn[1];
  if (st.mpos && !st.wpos) st.wpos = st.mpos.map((v, i) => v - (ctl.wco[i] || 0));
  if (st.wpos && !st.mpos) st.mpos = st.wpos.map((v, i) => v + (ctl.wco[i] || 0));
  st.wco = ctl.wco;
  return st;
}

function ack(line) {
  const item = ctl.inflight.shift();
  if (item) {
    ctl.inflightBytes -= item.len;
    if (item.job && ctl.job) {
      ctl.job.acked++;
      if (line !== 'ok') ctl.job.errors.push(`${line} on line ${item.n}: ${item.text}`);
    }
  }
  if (item && item.poll) { /* silent */ }
  else if (!(item && item.job)) broadcast({ type: 'rx', text: line });
  else if (line !== 'ok') broadcast({ type: 'rx', text: `${line}  (job line ${item.n}: ${item.text})` });
  pump();
  if (ctl.job && ctl.job.acked >= ctl.job.total) endJob('done');
}

function handleLine(line) {
  if (line.startsWith('<')) {
    ctl.lastStatus = parseStatus(line);
    if (ctl.job && ctl.family === 'grbl') ctl.job.paused = ctl.lastStatus.state.startsWith('Hold');
    broadcast({ type: 'status', ...ctl.lastStatus });
    return;
  }
  const m114 = /^X:\s*(-?[\d.]+)\s+Y:\s*(-?[\d.]+)(?:\s+Z:\s*(-?[\d.]+))?/.exec(line);
  if (m114) { // Marlin position report
    ctl.lastPos = [+m114[1], +m114[2], +(m114[3] || 0)];
    ctl.lastStatus = { state: ctl.job ? 'Run' : 'Idle', wpos: ctl.lastPos, mpos: ctl.lastPos, wco: [0, 0, 0] };
    broadcast({ type: 'status', ...ctl.lastStatus });
    return;
  }
  if (line === 'ok' || (ctl.family === 'grbl' && line.startsWith('error'))) return ack(line);
  if (/^ok\b/.test(line)) return ack('ok'); // "ok T:..." style
  if (/^echo:busy/.test(line) || /^wait$/.test(line)) return;
  if (/^Grbl |^Smoothie|^start$/.test(line)) {
    // Controller was reset: anything we had in flight is gone.
    ctl.queue = []; ctl.inflight = []; ctl.inflightBytes = 0;
    if (ctl.job) endJob(ctl.job.stopping ? 'stopped' : 'error', ctl.job.stopping ? null : 'Controller reset during job');
  }
  if ((line.startsWith('ALARM') || /^!!|^Error:Printer halted|^Error:.*Kill/i.test(line)) && ctl.job) {
    ctl.queue = [];
    endJob('error', line);
  }
  broadcast({ type: 'rx', text: line });
}

function pump() {
  if (ctl.paused) return;
  while (ctl.queue.length && ctl.link) {
    const item = ctl.queue[0];
    const len = item.text.length + 1;
    if (ctl.family === 'grbl') { if (ctl.inflight.length && ctl.inflightBytes + len > GRBL_RX_BUFFER) break; }
    else if (ctl.inflight.length) break; // ping-pong
    ctl.queue.shift();
    item.len = len;
    ctl.inflight.push(item);
    ctl.inflightBytes += len;
    rawWrite(item.text + '\n');
    if (item.job && ctl.job) ctl.job.sent++;
  }
}

function cleanLines(text) {
  return text.split(/\r?\n/)
    .map(l => l.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim())
    .filter(Boolean);
}

function sendLines(text) {
  const lines = cleanLines(text);
  for (const l of lines) {
    ctl.queue.push({ text: l, job: false });
    broadcast({ type: 'tx', text: l });
  }
  pump();
  return lines.length;
}

function startJob(gcode) {
  const lines = cleanLines(gcode);
  if (!lines.length) throw new Error('Job is empty');
  ctl.paused = false;
  ctl.queue = ctl.queue.filter(q => !q.poll);
  ctl.job = { total: lines.length, sent: 0, acked: 0, errors: [], started: Date.now(), paused: false, stopping: false };
  lines.forEach((text, i) => ctl.queue.push({ text, job: true, n: i + 1 }));
  clearInterval(ctl.jobTimer);
  ctl.jobTimer = setInterval(jobProgress, 300);
  jobProgress();
  pump();
}

function jobProgress(state) {
  const j = ctl.job;
  if (!j) return;
  broadcast({ type: 'job', state: state || (j.paused ? 'paused' : 'running'), total: j.total, sent: j.sent, acked: j.acked, elapsed: (Date.now() - j.started) / 1000, errors: j.errors.slice(-20) });
}

function endJob(state, reason) {
  const j = ctl.job;
  if (!j) return;
  clearInterval(ctl.jobTimer);
  jobProgress(state);
  if (reason) broadcast({ type: 'error', text: reason });
  ctl.job = null;
  ctl.paused = false;
}

function pauseJob() {
  if (ctl.family === 'marlin') ctl.paused = true; // stop feeding; buffered moves finish, then the laser goes idle
  else { rawWrite('!'); if (ctl.family === 'smoothie') ctl.paused = true; }
  if (ctl.job && ctl.family !== 'grbl') ctl.job.paused = true;
}

function resumeJob() {
  if (ctl.family !== 'marlin') rawWrite('~');
  ctl.paused = false;
  if (ctl.job && ctl.family !== 'grbl') ctl.job.paused = false;
  pump();
}

function stopJob() {
  ctl.queue = [];
  ctl.paused = false;
  if (ctl.job) ctl.job.stopping = true;
  if (ctl.family === 'marlin') {
    rawWrite('M410\nM5\n'); // quick-stop planner, laser off
    setTimeout(() => { ctl.inflight = []; ctl.inflightBytes = 0; if (ctl.job) endJob('stopped'); }, 300);
    return;
  }
  rawWrite('!'); // feed hold first so motion decelerates
  setTimeout(() => {
    rawWrite('\x18'); // then soft reset: clears buffers and turns the laser off
    ctl.inflight = []; ctl.inflightBytes = 0;
    if (ctl.job) endJob('stopped');
  }, 250);
}

// ---------------------------------------------------------------- Ruida (network/USB DSP controllers)
const ruida = createRuida({ broadcast, SerialLink });
const anyConnected = () => connected() || ruida.connected;
const anyJob = () => ctl.job || ruida.activeJob;

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listPorts() {
  const out = [{ path: 'virtual', label: 'Virtual laser (simulator)' }];
  let byId = {};
  try {
    for (const n of fs.readdirSync('/dev/serial/by-id')) {
      const target = path.resolve('/dev/serial/by-id', fs.readlinkSync(path.join('/dev/serial/by-id', n)));
      byId[target] = n.replace(/^usb-/, '').replace(/-if\d+.*$/, '').replace(/_/g, ' ');
    }
  } catch { /* no by-id directory */ }
  try {
    for (const n of fs.readdirSync('/dev').sort()) {
      if (/^tty(USB|ACM)\d+$/.test(n) || /^cu\.(usb|wch|SLAB)/i.test(n)) {
        const p = '/dev/' + n;
        out.push({ path: p, label: byId[p] ? `${p} — ${byId[p]}` : p });
      }
    }
  } catch { /* ignore */ }
  return out;
}

async function api(req, res, route) {
  const body = async () => { const t = await readBody(req, 1e6); return t ? JSON.parse(t) : {}; };
  if (req.method === 'GET' && route === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'conn', connected: anyConnected(), port: ruida.connected ? ruida.port : ctl.port })}\n\n`);
    if (ctl.lastStatus && connected()) res.write(`data: ${JSON.stringify({ type: 'status', ...ctl.lastStatus })}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  if (req.method === 'GET' && route === 'ports') return json(res, 200, listPorts());
  if (req.method === 'GET' && route === 'ruida/sim') return json(res, 200, ruida.simInfo() || {});
  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });

  switch (route) {
    case 'connect': {
      const { port, baud, family, magic } = await body();
      if (!port) return json(res, 400, { error: 'No port selected' });
      if (port !== 'virtual' && !/^\/dev\/(tty|cu\.)[\w.\-]+$/.test(port) && !(family === 'ruida' && /^udp:[A-Za-z0-9.\-]{1,253}$/.test(port))) return json(res, 400, { error: 'Invalid port or address' });
      disconnect(); ruida.disconnect();
      if (family === 'ruida') { await ruida.connect(port, Number(baud) || 115200, Number(magic)); return json(res, 200, { ok: true }); }
      connect(port, Number(baud) || 115200, family);
      return json(res, 200, { ok: true });
    }
    case 'disconnect': disconnect(); ruida.disconnect(); return json(res, 200, { ok: true });
    case 'ruida': {
      const b = await body();
      if (!ruida.connected) return json(res, 409, { error: 'Not connected to a Ruida controller' });
      if (ruida.activeJob && !['stop', 'pause', 'resume'].includes(b.op)) return json(res, 409, { error: 'A job is running' });
      switch (b.op) {
        case 'goto': await ruida.goTo(+b.x, +b.y); break;
        case 'home': await ruida.home(); break;
        case 'frame': if (!Array.isArray(b.pts) || b.pts.length < 2) return json(res, 400, { error: 'Bad frame' }); await ruida.frame(b.pts.map(p => [+p[0], +p[1]])); break;
        case 'stop': await ruida.stop(); break;
        case 'pause': await ruida.pause(); break;
        case 'resume': await ruida.resume(); break;
        case 'raw': await ruida.raw(String(b.text || '')); break;
        case 'probe': return json(res, 200, { ok: true, magic: await ruida.probeMagic() });
        default: return json(res, 400, { error: 'Unknown operation' });
      }
      return json(res, 200, { ok: true });
    }
    case 'ruida/job': {
      if (!ruida.connected) return json(res, 409, { error: 'Not connected to a Ruida controller' });
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 200e6) return json(res, 413, { error: 'Job too large' }); chunks.push(c); }
      await ruida.job(Buffer.concat(chunks));
      return json(res, 200, { ok: true });
    }
    case 'send': {
      const { text } = await body();
      if (!connected()) return json(res, 409, { error: 'Not connected' });
      if (ctl.job) return json(res, 409, { error: 'A job is running' });
      return json(res, 200, { ok: true, lines: sendLines(String(text || '')) });
    }
    case 'realtime': {
      const { cmd } = await body();
      const map = { status: '?', hold: '!', resume: '~', reset: '\x18', jogcancel: '\x85' };
      if (!map[cmd]) return json(res, 400, { error: 'Unknown realtime command' });
      if (!connected()) return json(res, 409, { error: 'Not connected' });
      if (cmd === 'reset') { ctl.queue = []; ctl.inflight = []; ctl.inflightBytes = 0; }
      if (ctl.family === 'marlin') { // Marlin has no realtime bytes
        if (cmd === 'hold') pauseJob(); else if (cmd === 'resume') resumeJob(); else if (cmd === 'reset') rawWrite('M410\nM5\n');
        return json(res, 200, { ok: true });
      }
      rawWrite(map[cmd]);
      return json(res, 200, { ok: true });
    }
    case 'job': {
      if (!connected()) return json(res, 409, { error: 'Not connected' });
      if (ctl.job) return json(res, 409, { error: 'A job is already running' });
      const g = await readBody(req, 400e6);
      startJob(g);
      return json(res, 200, { ok: true, lines: ctl.job.total });
    }
    case 'job/stop': stopJob(); return json(res, 200, { ok: true });
    case 'job/pause': pauseJob(); return json(res, 200, { ok: true });
    case 'job/resume': resumeJob(); return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks from web pages).
  if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method === 'POST' && req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ''))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname.slice(5));
    serveStatic(req, res, url.pathname);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

if (require.main !== module) { module.exports = { SerialLink, VirtualGrbl, ruida }; } else server.listen(PORT, HOST, () => {
  console.log(`BeamForge running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to quit.');
});
if (require.main === module) process.on('SIGINT', () => { if (ctl.link) { rawWrite('\x18'); } process.exit(0); });

// With BEAMFORGE_AUTO_EXIT=1 (used by the desktop launcher) the server quits once no BeamForge
// window has been open for a while — but never while a job is running.
if (require.main === module && process.env.BEAMFORGE_AUTO_EXIT === '1') {
  let idleSince = Date.now();
  setInterval(() => {
    if (clients.size || anyJob()) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince > 45000) {
      console.log('No BeamForge windows open — shutting down.');
      if (ctl.link) disconnect();
      ruida.disconnect();
      setTimeout(() => process.exit(0), 300);
    }
  }, 5000);
}
