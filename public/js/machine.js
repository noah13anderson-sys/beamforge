// Client for the local BeamForge server (server.js), which owns the serial connection.
export class Machine {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.open();
  }
  open() {
    this.es = new EventSource('/api/events');
    this.es.onopen = () => this.onEvent({ type: 'server', ok: true });
    this.es.onmessage = e => { try { this.onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
    this.es.onerror = () => this.onEvent({ type: 'server', ok: false }); // EventSource retries by itself
  }
  async post(path, body, raw = false) {
    const r = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'content-type': raw ? 'text/plain' : 'application/json' },
      body: raw ? body : JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
    return j;
  }
  async ports() {
    const r = await fetch('/api/ports');
    if (!r.ok) throw new Error('Could not list ports');
    return r.json();
  }
  connect(port, baud, family, magic) { return this.post('connect', { port, baud, family, magic }); }
  ruida(op, body = {}) { return this.post('ruida', { op, ...body }); }
  async ruidaJob(bytes) {
    const r = await fetch('/api/ruida/job', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
    return j;
  }
  disconnect() { return this.post('disconnect'); }
  send(text) { return this.post('send', { text }); }
  realtime(cmd) { return this.post('realtime', { cmd }); }
  job(gcode) { return this.post('job', gcode, true); }
}
