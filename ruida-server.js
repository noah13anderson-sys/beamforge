// Ruida DSP controller connection for the BeamForge server: UDP (network) or USB, plus a virtual Ruida
// for testing. Protocol notes: see public/js/ruida.js.
'use strict';
const dgram = require('node:dgram');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let R = null; // the shared ES module (public/js/ruida.js), loaded once
const ready = import(pathToFileURL(path.join(__dirname, 'public', 'js', 'ruida.js')).href).then(m => { R = m; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// ---------------------------------------------------------------- transports
class UdpLink {
  constructor(host, onMessage, onClose) {
    this.host = host; this.onClose = onClose; this.closed = false; this.datagram = true;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, rinfo) => { if (rinfo.address === this.host || this.hostResolved === rinfo.address) onMessage(m); });
    this.sock.on('error', e => this.close(e.code === 'EADDRINUSE'
      ? 'UDP port 40200 is already in use — close LaserWorks/RDWorks/LightBurn and try again'
      : e.message));
    this.sock.bind(40200);
    require('node:dns').lookup(host, { family: 4 }, (err, addr) => { if (!err) this.hostResolved = addr; });
  }
  send(buf) { if (!this.closed) this.sock.send(buf, 50200, this.host); }
  close(reason = 'Disconnected') { if (this.closed) return; this.closed = true; try { this.sock.close(); } catch { /* closed */ } this.onClose(reason); }
}

class UsbLink { // FTDI serial bridge on the controller: raw swizzled bytes, no checksum, no ACK
  constructor(SerialLink, dev, baud, onMessage, onClose) {
    this.datagram = false;
    this.link = new SerialLink(dev, baud, s => onMessage(Buffer.from(s, 'latin1')), onClose);
  }
  send(buf) { this.link.write(Buffer.from(buf).toString('latin1')); }
  close(reason) { this.link.close(reason); }
}

// A software Ruida: checks checksums and the RD file sum, answers status queries and "runs" jobs.
class VirtualRuida {
  constructor(magic, onMessage, onClose) {
    this.magic = magic; this.onMessage = onMessage; this.onClose = onClose; this.datagram = true; this.closed = false;
    this.x = 0; this.y = 0; this.busyUntil = 0; this.job = null; this.last = null;
    this.bed = [400000, 400000];
  }
  reply(plain) { const b = Buffer.from(R.swizzle(plain, this.magic)); setTimeout(() => !this.closed && this.onMessage(b), 2); }
  send(buf) {
    if (this.closed) return;
    const payload = buf.subarray(2);
    let sum = 0; for (const b of payload) sum += b;
    if (((buf[0] << 8) | buf[1]) !== (sum & 0xFFFF)) return this.reply([R.NAK]);
    const plain = R.unswizzle(payload, this.magic);
    this.reply([R.ACK]);
    for (const c of R.commands(plain)) this.exec(c);
  }
  exec(c) {
    const now = Date.now();
    if (this.job) {
      this.job.bytes.push(...c);
      if (c[0] === 0xD7) this.finishJob();
      return;
    }
    if (c[0] === 0xD8 && c[1] === 0x10) { this.job = { bytes: [...c] }; return; }
    if (c[0] === 0xDA && c[1] === 0x00) {
      const addr = (c[2] << 7) | c[3];
      const v = addr === R.MEM.x ? this.x : addr === R.MEM.y ? this.y : addr === R.MEM.status ? (now < this.busyUntil ? 0x01000001 : 0)
        : addr === R.MEM.bedX ? this.bed[0] : addr === R.MEM.bedY ? this.bed[1] : addr === R.MEM.cardId ? 0x65106510 : 0;
      return this.reply([0xDA, 0x01, c[2], c[3], ...R.e35(v)]);
    }
    if (c[0] === 0xD9 && c[1] === 0x10) { this.x = R.d35(c, 3); this.y = R.d35(c, 8); this.busyUntil = now + 300; return; }
    if (c[0] === 0xD8 && c[1] === 0x2A) { this.x = 0; this.y = 0; this.busyUntil = now + 600; return; }
    if (c[0] === 0xD8 && c[1] === 0x01) { this.busyUntil = 0; }
  }
  finishJob() {
    const b = this.job.bytes; this.job = null;
    // locate E5 05 (file sum) and check it
    let sumOk = false, cuts = 0, moves = 0, dist = 0, x = this.x, y = this.y, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const cmds = [...R.commands(Uint8Array.from(b))];
    let running = 0;
    for (const c of cmds) {
      if (c[0] === 0xE5 && c[1] === 0x05) sumOk = R.d35(c, 2) === running + 0xD7;
      for (const v of c) running += v;
      if (c[0] === 0x88 || c[0] === 0xA8) {
        const nx = R.d35(c, 1), ny = R.d35(c, 6);
        dist += Math.hypot(nx - x, ny - y); x = nx; y = ny;
        if (c[0] === 0xA8) { cuts++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } else moves++;
      }
    }
    this.last = { bytes: b.length, commands: cmds.length, sumOk, cuts, moves, cutBounds: [minX, minY, maxX, maxY], endsWithD7: b[b.length - 1] === 0xD7 };
    this.x = x; this.y = y;
    this.busyUntil = Date.now() + Math.min(4000, 300 + dist / 400); // pretend to run
  }
  close(reason = 'Disconnected') { if (this.closed) return; this.closed = true; this.onClose(reason); }
}

// ---------------------------------------------------------------- controller
function createRuida({ broadcast, SerialLink }) {
  const rd = { link: null, port: null, magic: 0x88, queue: [], cur: null, rx: Buffer.alloc(0), pollTimer: null, job: null, pos: [0, 0], state: 'Idle', lastPoll: 0 };

  function done(err, val) {
    const c = rd.cur; if (!c) return;
    clearTimeout(c.timer); rd.cur = null;
    err ? c.reject(err) : c.resolve(val);
    setImmediate(pump);
  }
  function arm(ms) {
    const c = rd.cur;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      if (rd.link && rd.link.datagram && c.state === 'ack' && c.tries < c.retries) { c.tries++; transmit(); return; }
      done(new Error('No reply from the laser controller'));
    }, ms);
  }
  function transmit() {
    const c = rd.cur;
    c.state = 'ack';
    if (rd.link.datagram) { rd.link.send(Buffer.from(R.packet(c.plain, rd.magic))); arm(c.timeout); }
    else {
      rd.link.send(Buffer.from(R.swizzle(c.plain, rd.magic)));
      if (c.expectReply) { c.state = 'data'; rd.rx = Buffer.alloc(0); arm(c.timeout); } else setTimeout(() => done(null, {}), 5);
    }
  }
  function pump() {
    if (rd.cur || !rd.queue.length || !rd.link) return;
    rd.cur = rd.queue.shift();
    rd.cur.tries = 0;
    transmit();
  }
  function request(plain, { expectReply = false, timeout = 1500, retries = 3, priority = false } = {}) {
    if (!rd.link) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      const item = { plain: Uint8Array.from(plain), expectReply, timeout, retries, resolve, reject };
      priority ? rd.queue.unshift(item) : rd.queue.push(item);
      pump();
    });
  }
  function onMessage(buf) {
    const c = rd.cur;
    if (!c) return;
    if (rd.link.datagram) {
      const plain = R.unswizzle(buf, rd.magic);
      if (c.state === 'ack') {
        if (plain[0] === R.ACK) {
          if (!c.expectReply) return done(null, {});
          c.state = 'data'; arm(c.timeout);
          if (plain.length >= 10) return done(null, R.parseReply(plain.subarray(1)));
          return;
        }
        if (plain[0] === R.NAK && c.tries < c.retries) { c.tries++; return transmit(); }
        if (plain[0] === R.ERR || plain[0] === R.NAK) return done(new Error('The controller rejected the data (checksum/format error)'));
        return;
      }
      if (c.state === 'data' && plain.length >= 9) return done(null, R.parseReply(plain));
    } else if (c.state === 'data') {
      rd.rx = Buffer.concat([rd.rx, buf]);
      if (rd.rx.length >= 9) return done(null, R.parseReply(R.unswizzle(rd.rx.subarray(0, 9), rd.magic)));
    }
  }
  const query = addr => request(R.cmd.query(addr), { expectReply: true });

  async function poll() {
    if (!rd.link || rd.cur || rd.queue.length || (rd.job && rd.job.phase === 'upload')) return;
    try {
      const st = await query(R.MEM.status);
      const x = await query(R.MEM.x), y = await query(R.MEM.y);
      if (!st || !x || !y) return;
      const s = R.decodeStatus(st.value);
      rd.pos = [x.value / 1000, y.value / 1000];
      rd.state = s.busy ? 'Run' : 'Idle';
      broadcast({ type: 'status', state: rd.state, wpos: [...rd.pos, 0], mpos: [...rd.pos, 0], wco: [0, 0, 0] });
      const j = rd.job;
      if (j && j.phase === 'run') {
        if (s.busy) j.sawBusy = true;
        if ((j.sawBusy && !s.busy) || (!j.sawBusy && Date.now() - j.uploaded > 6000)) endJob('done');
      }
    } catch { /* missed poll; try again later */ }
  }

  function jobEvent(state) {
    const j = rd.job; if (!j) return;
    broadcast({ type: 'job', state: state || (j.phase === 'upload' ? 'uploading' : j.paused ? 'paused' : 'running'),
      total: j.total, sent: j.acked, acked: j.phase === 'upload' ? j.acked : j.total, elapsed: (Date.now() - j.started) / 1000, errors: j.errors });
  }
  function endJob(state, reason) {
    if (!rd.job) return;
    jobEvent(state);
    if (reason) broadcast({ type: 'error', text: reason });
    rd.job = null;
  }

  return {
    ready,
    get connected() { return !!rd.link; },
    get port() { return rd.port; },
    get activeJob() { return rd.job; },
    async connect(port, baud, magic) {
      await ready;
      this.disconnect();
      rd.magic = R.MAGICS.includes(magic) ? magic : R.MAGIC_DEFAULT;
      const onClose = reason => {
        clearInterval(rd.pollTimer);
        if (rd.cur) { clearTimeout(rd.cur.timer); rd.cur.reject(new Error(reason)); rd.cur = null; }
        for (const q of rd.queue) q.reject(new Error(reason));
        rd.queue = [];
        if (rd.job) endJob('error', `Connection lost: ${reason}`);
        rd.link = null;
        broadcast({ type: 'conn', connected: false, port: rd.port, reason });
      };
      if (port === 'virtual') { rd.link = new VirtualRuida(rd.magic, onMessage, onClose); rd.sim = rd.link; }
      else if (port.startsWith('udp:')) rd.link = new UdpLink(port.slice(4), onMessage, onClose);
      else rd.link = new UsbLink(SerialLink, port, baud, onMessage, onClose);
      rd.port = port;
      broadcast({ type: 'conn', connected: true, port, family: 'ruida' });
      // Handshake: read the controller card ID.
      try {
        const id = await query(R.MEM.cardId);
        broadcast({ type: 'rx', text: id ? `Ruida controller found (card ID 0x${id.value.toString(16).toUpperCase()})` : 'Connected, but the controller did not answer the ID query' });
      } catch (e) {
        broadcast({ type: 'error', text: `${e.message}. Check the IP address and that the laser is on (Ruida uses UDP ports 50200/40200).` });
      }
      rd.pollTimer = setInterval(poll, 500);
    },
    disconnect() { if (rd.link) rd.link.close('Disconnected'); },
    async probeMagic() { // try the known swizzle keys and keep the one the controller answers
      for (const m of R.MAGICS) {
        rd.magic = m;
        try { const r = await request(R.cmd.query(R.MEM.cardId), { expectReply: true, retries: 0, timeout: 800 }); if (r) return m; } catch { /* next */ }
      }
      rd.magic = R.MAGIC_DEFAULT;
      return null;
    },
    async raw(hexText) {
      const bytes = hexText.trim().split(/[\s,]+/).filter(Boolean).map(h => parseInt(h, 16));
      if (!bytes.length || bytes.some(b => !(b >= 0 && b <= 255))) throw new Error('Type hex bytes, e.g. DA 00 05 7E');
      broadcast({ type: 'tx', text: hex(bytes) });
      const expectReply = bytes[0] === 0xDA && bytes[1] === 0x00;
      const r = await request(bytes, { expectReply });
      broadcast({ type: 'rx', text: r && r.addr !== undefined ? `DA 01 addr 0x${r.addr.toString(16)} value ${r.value} (0x${(r.value >>> 0).toString(16)})` : 'ACK' });
    },
    goTo(xMm, yMm) { return request(R.cmd.rapidTo(Math.round(xMm * 1000), Math.round(yMm * 1000))); },
    home() { return request(R.cmd.home()); },
    async frame(pts) {
      for (const [x, y] of [...pts, pts[0]]) {
        await this.goTo(x, y);
        await sleep(250);
        for (let t = 0; t < 300; t++) { // wait (max 60 s) for the move to finish
          const st = await query(R.MEM.status);
          if (st && !R.decodeStatus(st.value).moving) break;
          await sleep(200);
        }
      }
    },
    async job(bytes) {
      if (rd.job) throw new Error('A job is already running');
      const chunks = R.chunk(Uint8Array.from(bytes), 1000);
      rd.job = { total: chunks.length, acked: 0, errors: [], started: Date.now(), phase: 'upload', paused: false };
      jobEvent();
      (async () => {
        try {
          for (const c of chunks) {
            if (!rd.job) return; // stopped
            await request(c, { timeout: 4000, retries: 2 });
            rd.job.acked++;
            if (rd.job.acked % 5 === 0) jobEvent();
          }
          rd.job.phase = 'run'; rd.job.uploaded = Date.now(); rd.job.sawBusy = false;
          broadcast({ type: 'rx', text: `Job uploaded (${bytes.length.toLocaleString()} bytes in ${chunks.length} packets)` });
          jobEvent();
        } catch (e) { endJob('error', `Upload failed: ${e.message}`); }
      })();
    },
    async stop() {
      for (const q of rd.queue) q.reject(new Error('Stopped'));
      rd.queue = [];
      if (rd.job) endJob('stopped');
      await request(R.cmd.stop(), { priority: true });
    },
    async pause() { if (rd.job) { rd.job.paused = true; jobEvent(); } await request(R.cmd.pause(), { priority: true }); },
    async resume() { if (rd.job) { rd.job.paused = false; jobEvent(); } await request(R.cmd.resume(), { priority: true }); },
    simInfo() { return rd.sim && !rd.sim.closed ? { last: rd.sim.last, x: rd.sim.x, y: rd.sim.y } : null; },
  };
}

module.exports = { createRuida, VirtualRuida, UdpLink };
