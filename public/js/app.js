// BeamForge — main UI.
import * as G from './geom.js';
import { worldPolys, worldPath, objBounds, hitObject, localPolys, textVars, resolveText } from './shapes.js';
import { generateJob, jobFrame, frameGcode } from './gcode.js';
import { loadImage, getImage, imageSource, imageFilter, traceImage } from './raster.js';
import { offset as offsetPolys, boolean as booleanOp, joinPaths, fillet as filletPolys, reflectTf } from './ops.js';
import { DEVICE_TYPES, ORIGINS, GRBL_SETTINGS, makeDevice, family, toMachine, mapToMachine, machineToDesign, rotaryScale, commands, screenToMachineDelta } from './devices.js';
import { swizzle } from './ruida.js';
import { Machine } from './machine.js';

// ================================================================ utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = v => Math.round(v * 1000) / 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function msg(text, kind = '') {
  const m = $('#st-msg');
  m.textContent = text; m.className = 'msg ' + kind;
  clearTimeout(msg.t); msg.t = setTimeout(() => { m.textContent = ''; }, 7000);
}
function fmtTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const readFile = (f, as) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result); r.onerror = () => rej(r.error);
  as === 'url' ? r.readAsDataURL(f) : r.readAsText(f);
});

// ================================================================ settings & devices
const PALETTE = ['#1d1d1f', '#1f6feb', '#e5484d', '#2da44e', '#e08a00', '#8957e5', '#0aa5b8', '#d6409f', '#6e9a00', '#f06a1b',
  '#4c5fd5', '#119c8a', '#b3123e', '#9a6a00', '#6d28d9', '#0a84c6', '#b625b1', '#167a3a', '#a82222', '#5b6676',
  '#ff9e80', '#80b3ff', '#7fd8a6', '#e3c46b', '#c7a0ff', '#78d6e6', '#ff9fd1', '#b9d96b', '#a6a6a6', '#404a57'];

const APP_DEFAULTS = {
  startFrom: 'absolute', anchor: 'bl', jogStep: '10', jogF: 3000, pulsePower: 1, pulseMs: 200, framePower: 1,
  snap: 0, lockAspect: true, alignTo: 'auto', serial: 1, serialAuto: true, devices: [], deviceId: null,
};
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('beamforge.settings') || '{}'); } catch { /* ignore */ }
  const out = { ...APP_DEFAULTS, ...s };
  if (!Array.isArray(out.devices) || !out.devices.length) { // migrate the single-machine settings of v1
    out.devices = [makeDevice(s.laserMode === 'M3' ? 'grbl-m3' : 'grbl', {
      name: 'My laser', bedW: s.bedW ?? 400, bedH: s.bedH ?? 400, origin: s.origin ?? 'bl', sMax: s.sMax ?? 1000,
      travel: s.travel ?? 100, returnHome: s.returnHome ?? true, baud: s.baud ?? '115200', port: s.port ?? 'virtual',
    })];
  }
  out.devices = out.devices.map(d => ({ ...makeDevice(d.type), ...d }));
  if (!out.devices.some(d => d.id === out.deviceId)) out.deviceId = out.devices[0].id;
  return out;
}
const settings = loadSettings();
function saveSettings() { try { localStorage.setItem('beamforge.settings', JSON.stringify(settings)); } catch { /* storage unavailable */ } }
const dev = () => settings.devices.find(d => d.id === settings.deviceId) || settings.devices[0];
textVars.serial = settings.serial;

// ================================================================ material library
function loadLib() { try { return JSON.parse(localStorage.getItem('beamforge.materials') || '[]'); } catch { return []; } }
function saveLib(lib) { try { localStorage.setItem('beamforge.materials', JSON.stringify(lib)); } catch { msg('Could not save library', 'err'); } }
const LAYER_KEYS = ['mode', 'speed', 'power', 'minPower', 'passes', 'interval', 'overscan', 'bidir', 'angle', 'crosshatch', 'air',
  'dither', 'threshold', 'kerf', 'tabs', 'tabCount', 'tabSpacing', 'tabWidth', 'perf', 'perfCut', 'perfSkip', 'constant',
  'zOffset', 'zStep', 'fillGroups', 'halftoneCell', 'halftoneAngle'];

// ================================================================ document state
const S = {
  layers: [], objects: [], sel: new Set(), activeLayer: null,
  tool: 'select', view: { s: 2, ox: 40, oy: 40 },
  previewOn: false, preview: null, previewT: 1,
  m: { connected: false, port: null, state: '—', wpos: null, job: null, server: false },
  undo: [], redo: [], clipboard: null, draft: null, cursor: null, node: null, measure: null,
};

function layerDefaults(mode = 'line') {
  return {
    mode, output: true,
    speed: mode === 'line' ? 10 : 120, power: mode === 'line' ? 80 : 35, minPower: 0, passes: 1,
    interval: 0.1, overscan: 2.5, bidir: true, angle: 0, crosshatch: false, air: mode === 'line',
    dither: 'floyd', threshold: 128, halftoneCell: 6, halftoneAngle: 45,
    kerf: 0, tabs: false, tabCount: 4, tabSpacing: 0, tabWidth: 0.5, perf: false, perfCut: 2, perfSkip: 1,
    constant: false, zOffset: 0, zStep: 0, fillGroups: 'all',
  };
}
function makeLayer(color, mode = 'line') {
  return { id: uid(), color, name: `Layer ${S.layers.length + 1}`, ...layerDefaults(mode) };
}
const layerById = id => S.layers.find(l => l.id === id);
function activeLayer() {
  let l = layerById(S.activeLayer);
  if (!l) {
    if (!S.layers.length) S.layers.push(makeLayer(PALETTE[0]));
    l = S.layers[0]; S.activeLayer = l.id;
  }
  return l;
}
function layerForColor(color, mode = 'line') {
  let l = S.layers.find(x => x.color === color);
  if (!l) { l = makeLayer(color, mode); S.layers.push(l); }
  return l;
}
function addObject(o) {
  o.id = uid();
  o.layer = o.layer || activeLayer().id;
  o.tf = o.tf || { x: 0, y: 0, sx: 1, sy: 1, r: 0 };
  if (!o.group) delete o.group;
  S.objects.push(o);
  return o;
}
// New path object from world-space polylines (re-centred).
function pathFromWorld(polys, extra = {}) {
  const b = G.boundsOfPolys(polys);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return addObject({ type: 'path', ...extra, polys: polys.map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x - cx, y - cy]) })), tf: { x: cx, y: cy, sx: 1, sy: 1, r: 0 } });
}
const selected = () => S.objects.filter(o => S.sel.has(o.id));
function boundsOf(objs) {
  let b = G.emptyBounds();
  for (const o of objs) b = G.unionBounds(b, objBounds(o));
  return G.boundsValid(b) ? b : null;
}
function withGroups(ids) {
  const out = new Set(ids);
  const groups = new Set(S.objects.filter(o => out.has(o.id) && o.group).map(o => o.group));
  if (groups.size) for (const o of S.objects) if (o.group && groups.has(o.group)) out.add(o.id);
  return out;
}

// ================================================================ undo / change tracking
const snapshot = () => ({
  layers: S.layers.map(l => ({ ...l })),
  objects: S.objects.map(o => ({ ...o, tf: { ...o.tf } })),
  sel: [...S.sel], active: S.activeLayer,
});
function restore(s) {
  S.layers = s.layers.map(l => ({ ...l }));
  S.objects = s.objects.map(o => ({ ...o, tf: { ...o.tf } }));
  S.sel = new Set(s.sel.filter(id => S.objects.some(o => o.id === id)));
  S.activeLayer = s.active; S.node = null;
  changed();
}
function pushUndo() {
  S.undo.push(snapshot());
  if (S.undo.length > 200) S.undo.shift();
  S.redo.length = 0;
}
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }
function edit(fn) { pushUndo(); fn(); changed(); }

let previewTimer, autosaveTimer;
function changed() {
  S.preview = null;
  if (S.previewOn) { clearTimeout(previewTimer); previewTimer = setTimeout(buildPreview, 250); }
  clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosave, 1200);
  if (S.objects.length && S.tool === 'select') $('#hint').textContent = '';
  refreshPanels(); requestDraw();
}
function selectionChanged() { refreshPanels(); requestDraw(); }

// ================================================================ project files & export
function projectData() {
  return { app: 'BeamForge', version: 2, layers: S.layers, objects: S.objects, activeLayer: S.activeLayer };
}
async function loadProject(data) {
  if (!data || data.app !== 'BeamForge') throw new Error('Not a BeamForge project file');
  S.layers = (data.layers || []).map(l => ({ ...layerDefaults(l.mode), ...l }));
  S.objects = data.objects || []; S.activeLayer = data.activeLayer;
  S.sel.clear(); S.undo = []; S.redo = []; S.node = null;
  await Promise.all(S.objects.filter(o => o.type === 'image').map(o => loadImage(o.imgKey, o.src).catch(() => null)));
  changed(); zoomFit();
}
function autosave() {
  try { localStorage.setItem('beamforge.autosave', JSON.stringify(projectData())); } catch { /* too big or unavailable */ }
}
function newProject() {
  S.layers = [makeLayer(PALETTE[0])]; S.activeLayer = S.layers[0].id;
  S.objects = []; S.sel.clear(); S.undo = []; S.redo = []; S.node = null;
  changed();
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function exportSvg() {
  const d = dev(), parts = [];
  for (const L of S.layers) {
    const objs = S.objects.filter(o => o.layer === L.id);
    if (!objs.length) continue;
    const items = objs.map(o => {
      if (o.type === 'image') {
        const m = G.tfMatrix(o.tf).map(v => r3(v)).join(' ');
        return `<image href="${o.src}" x="${-o.w / 2}" y="${-o.h / 2}" width="${o.w}" height="${o.h}" transform="matrix(${m})" preserveAspectRatio="none"/>`;
      }
      const dd = worldPolys(o).map(p => 'M' + p.pts.map(([x, y]) => `${r3(x)} ${r3(y)}`).join(' L') + (p.closed ? ' Z' : '')).join(' ');
      return `<path d="${dd}"/>`;
    });
    const fill = L.mode === 'fill' || L.mode === 'offset' ? L.color : 'none';
    parts.push(`<g id="${esc(L.name)}" stroke="${L.color}" stroke-width="0.1" fill="${fill}" fill-rule="evenodd">\n${items.join('\n')}\n</g>`);
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${d.bedW}mm" height="${d.bedH}mm" viewBox="0 0 ${d.bedW} ${d.bedH}">\n${parts.join('\n')}\n</svg>\n`;
  download('design.svg', svg, 'image/svg+xml');
}
function exportDxf() {
  const H = dev().bedH, out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const o of S.objects) {
    if (o.type === 'image') continue;
    const layer = (layerById(o.layer)?.name || '0').replace(/[^\w-]/g, '_');
    for (const p of worldPolys(o)) {
      out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', p.closed ? '1' : '0', '10', '0', '20', '0', '30', '0');
      for (const [x, y] of p.pts) out.push('0', 'VERTEX', '8', layer, '10', r3(x).toString(), '20', r3(H - y).toString(), '30', '0');
      out.push('0', 'SEQEND', '8', layer);
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  download('design.dxf', out.join('\n') + '\n', 'application/dxf');
}

// ================================================================ canvas view
const stage = $('#stage'), cv = $('#cv'), ctx = cv.getContext('2d');
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['canvas-bg', 'bed', 'grid', 'grid-major', 'sel', 'travel', 'burn', 'text', 'muted', 'accent'])
    colors[k] = cs.getPropertyValue('--' + k).trim();
}
readColors();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readColors(); requestDraw(); });

const toWorld = (sx, sy) => [(sx - S.view.ox) / S.view.s, (sy - S.view.oy) / S.view.s];
const toScreen = (x, y) => [x * S.view.s + S.view.ox, y * S.view.s + S.view.oy];
function zoomFit() {
  const r = stage.getBoundingClientRect(), pad = 36, d = dev();
  const s = Math.min((r.width - pad * 2) / d.bedW, (r.height - pad * 2) / d.bedH);
  S.view.s = Math.max(0.05, s);
  S.view.ox = (r.width - d.bedW * S.view.s) / 2;
  S.view.oy = (r.height - d.bedH * S.view.s) / 2;
  requestDraw();
}
function zoomAt(sx, sy, k) {
  const [wx, wy] = toWorld(sx, sy);
  S.view.s = clamp(S.view.s * k, 0.05, 400);
  S.view.ox = sx - wx * S.view.s; S.view.oy = sy - wy * S.view.s;
  requestDraw();
}

let drawQueued = false;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }
new ResizeObserver(() => requestDraw()).observe(stage);

function handlePoints(b) {
  const [x0, y0] = toScreen(b.minX, b.minY), [x1, y1] = toScreen(b.maxX, b.maxY);
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [xm, y0], [x1, ym], [xm, y1], [x0, ym], [xm, y0 - 26]];
}
function niceStep() {
  for (const s of [0.1, 0.5, 1, 5, 10, 50, 100, 500]) if (s * S.view.s >= 7) return s;
  return 1000;
}

function draw() {
  drawQueued = false;
  const dpr = window.devicePixelRatio || 1, r = stage.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors['canvas-bg']; ctx.fillRect(0, 0, r.width, r.height);
  const d = dev(), v = S.view, px = 1 / v.s, bw = d.bedW, bh = d.bedH;
  const right = d.origin === 'tr' || d.origin === 'br', front = d.origin === 'bl' || d.origin === 'br';

  ctx.save();
  ctx.translate(v.ox, v.oy); ctx.scale(v.s, v.s);
  ctx.fillStyle = colors.bed; ctx.fillRect(0, 0, bw, bh);
  const step = niceStep();
  const major = step * (step === 0.5 || step === 50 || step === 500 ? 2 : 5);
  ctx.lineWidth = px;
  for (const [st, col] of [[step, colors.grid], [major, colors['grid-major']]]) {
    ctx.strokeStyle = col; ctx.beginPath();
    for (let i = 0; i * st <= bw + 1e-6; i++) { const x = right ? bw - i * st : i * st; ctx.moveTo(x, 0); ctx.lineTo(x, bh); }
    for (let i = 0; i * st <= bh + 1e-6; i++) { const y = front ? bh - i * st : i * st; ctx.moveTo(0, y); ctx.lineTo(bw, y); }
    ctx.stroke();
  }
  ctx.fillStyle = colors.accent; ctx.beginPath(); ctx.arc(right ? bw : 0, front ? bh : 0, 4 * px, 0, Math.PI * 2); ctx.fill();

  const pv = S.previewOn && S.preview;
  for (const o of S.objects) {
    const L = layerById(o.layer);
    if (!L) continue;
    ctx.globalAlpha = (L.output ? 1 : 0.35) * (pv ? 0.35 : 1);
    if (o.type === 'image') {
      const img = imageSource(o);
      if (img) {
        ctx.save(); ctx.transform(...G.tfMatrix(o.tf));
        ctx.filter = imageFilter(o);
        ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
        ctx.restore();
      }
      ctx.strokeStyle = L.color; ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]);
      ctx.stroke(worldPath(o)); ctx.setLineDash([]);
      continue;
    }
    const p = worldPath(o);
    if (L.mode === 'fill' || L.mode === 'offset') { ctx.fillStyle = L.color + '55'; ctx.fill(p, 'evenodd'); }
    ctx.strokeStyle = L.color; ctx.lineWidth = 1.3 * px;
    if (L.perf && L.mode === 'line') ctx.setLineDash([L.perfCut, L.perfSkip]);
    ctx.stroke(p); ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
  if (pv) drawPreview(px);

  const dr = S.draft;
  if (dr) {
    ctx.strokeStyle = colors.sel; ctx.lineWidth = 1.3 * px; ctx.setLineDash([5 * px, 4 * px]);
    ctx.beginPath();
    if (dr.kind === 'line') {
      dr.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      if (S.cursor) ctx.lineTo(...S.cursor);
    } else if (dr.box) {
      const { x, y, w, h } = dr.box;
      if (dr.tool === 'rect') ctx.rect(x, y, w, h);
      else if (dr.tool === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      else {
        const pts = G.polygonPts(6, Math.abs(w), Math.abs(h));
        pts.forEach(([a, b], i) => i ? ctx.lineTo(a + x + w / 2, b + y + h / 2) : ctx.moveTo(a + x + w / 2, b + y + h / 2));
        ctx.closePath();
      }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  if (d.userOrigin) {
    const [ux, uy] = machineToDesign(d, d.userOrigin[0], d.userOrigin[1]);
    const r = 7 * px;
    ctx.strokeStyle = settings.startFrom === 'user' ? '#30a46c' : 'rgba(48,164,108,0.45)'; ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); ctx.moveTo(ux, uy - r); ctx.lineTo(ux + r, uy); ctx.lineTo(ux, uy + r); ctx.lineTo(ux - r, uy); ctx.closePath();
    ctx.moveTo(ux - 2 * r, uy); ctx.lineTo(ux + 2 * r, uy); ctx.moveTo(ux, uy - 2 * r); ctx.lineTo(ux, uy + 2 * r);
    ctx.stroke();
  }
  if (S.m.connected && S.m.wpos) {
    const [hx, hy] = machineToDesign(d, S.m.wpos[0], S.m.wpos[1]);
    ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); ctx.arc(hx, hy, 5 * px, 0, Math.PI * 2);
    ctx.moveTo(hx - 10 * px, hy); ctx.lineTo(hx + 10 * px, hy); ctx.moveTo(hx, hy - 10 * px); ctx.lineTo(hx, hy + 10 * px);
    ctx.stroke();
  }
  ctx.restore();

  // overlays in screen space
  if (!pv && S.tool === 'node') drawNodes();
  else if (!pv) {
    const b = boundsOf(selected());
    if (b) {
      const hp = handlePoints(b);
      ctx.strokeStyle = colors.sel; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.strokeRect(hp[0][0], hp[0][1], hp[2][0] - hp[0][0], hp[2][1] - hp[0][1]);
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(hp[4][0], hp[4][1]); ctx.lineTo(hp[8][0], hp[8][1]); ctx.stroke();
      ctx.fillStyle = '#fff';
      hp.forEach(([x, y], i) => {
        ctx.beginPath();
        if (i === 8) ctx.arc(x, y, 5, 0, Math.PI * 2); else ctx.rect(x - 4, y - 4, 8, 8);
        ctx.fill(); ctx.stroke();
      });
    }
  }
  if (drag && drag.kind === 'marquee') {
    const [x0, y0] = toScreen(...drag.start), [x1, y1] = toScreen(...drag.cur);
    const crossing = x1 < x0;
    ctx.fillStyle = crossing ? 'rgba(45,164,78,.12)' : 'rgba(11,123,255,.12)';
    ctx.strokeStyle = crossing ? '#2da44e' : colors.sel;
    ctx.setLineDash(crossing ? [5, 4] : []);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
  }
  if (S.measure) drawMeasure();
  drawRulers(r.width, r.height);
}

function drawNodes() {
  ctx.lineWidth = 1;
  for (const o of selected()) {
    if (o.type === 'image') continue;
    worldPolys(o).forEach((p, pi) => p.pts.forEach(([x, y], vi) => {
      const [sx, sy] = toScreen(x, y);
      const on = S.node && S.node.id === o.id && S.node.pi === pi && S.node.vi === vi;
      ctx.fillStyle = on ? colors.accent : '#fff'; ctx.strokeStyle = colors.sel;
      ctx.beginPath(); ctx.rect(sx - 3.5, sy - 3.5, 7, 7); ctx.fill(); ctx.stroke();
    }));
  }
}
function drawMeasure() {
  const { a, b } = S.measure;
  const [x0, y0] = toScreen(...a), [x1, y1] = toScreen(...b);
  ctx.strokeStyle = '#d6409f'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke(); }
  const dx = b[0] - a[0], dy = -(b[1] - a[1]);
  const label = `${Math.hypot(dx, dy).toFixed(2)} mm  ·  ΔX ${dx.toFixed(2)}  ΔY ${dy.toFixed(2)}  ·  ${(Math.atan2(dy, dx) / G.D2R).toFixed(1)}°`;
  ctx.font = '12px system-ui'; const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x1 + 10, y1 - 22, w + 12, 20);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, x1 + 16, y1 - 12);
}

function drawRulers(w, h) {
  const d = dev();
  let major = niceStep();
  while (major * S.view.s < 60) major *= String(major).startsWith('1') ? 5 : 2;
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, w, 16); ctx.fillRect(0, 0, 16, h);
  ctx.fillStyle = '#cfd3d8'; ctx.font = '10px system-ui'; ctx.textBaseline = 'top';
  const [wx0, wy0] = toWorld(16, 16), [wx1, wy1] = toWorld(w, h);
  const mxa = toMachine(d, wx0, wy0), mxb = toMachine(d, wx1, wy1);
  const right = d.origin === 'tr' || d.origin === 'br', front = d.origin === 'bl' || d.origin === 'br';
  for (let mx = Math.ceil(Math.min(mxa[0], mxb[0]) / major) * major; mx <= Math.max(mxa[0], mxb[0]); mx += major) {
    const [sx] = toScreen(right ? d.bedW - mx : mx, 0);
    ctx.fillRect(sx, 10, 1, 6); ctx.fillText(String(r3(mx)), sx + 2, 2);
  }
  ctx.save(); ctx.rotate(-Math.PI / 2);
  for (let my = Math.ceil(Math.min(mxa[1], mxb[1]) / major) * major; my <= Math.max(mxa[1], mxb[1]); my += major) {
    const [, sy] = toScreen(0, front ? d.bedH - my : my);
    ctx.fillRect(-sy, 10, 1, 6); ctx.fillText(String(r3(my)), -sy + 2, 2);
  }
  ctx.restore();
}

function drawPreview(px) {
  const P = S.preview, sg = P.segs, n = Math.floor(sg.length / 5 * S.previewT);
  ctx.lineWidth = px; ctx.strokeStyle = colors.travel; ctx.beginPath();
  for (let i = 0; i < n; i++) { const k = i * 5; if (sg[k + 4] < 0) { ctx.moveTo(sg[k], sg[k + 1]); ctx.lineTo(sg[k + 2], sg[k + 3]); } }
  ctx.stroke();
  const buckets = [[], [], [], [], []];
  for (let i = 0; i < n; i++) { const p = sg[i * 5 + 4]; if (p > 0) buckets[Math.min(4, Math.floor(p * 5))].push(i * 5); }
  ctx.lineWidth = Math.max(px * 1.2, 0.08); ctx.lineCap = 'round';
  buckets.forEach((list, bi) => {
    if (!list.length) return;
    ctx.strokeStyle = `rgba(200,40,0,${0.35 + bi * 0.16})`; ctx.beginPath();
    for (const k of list) { ctx.moveTo(sg[k], sg[k + 1]); ctx.lineTo(sg[k + 2], sg[k + 3]); }
    ctx.stroke();
  });
  ctx.lineCap = 'butt';
  if (n > 0) {
    const k = (n - 1) * 5;
    ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.arc(sg[k + 2], sg[k + 3], 3 * px, 0, Math.PI * 2); ctx.fill();
  }
}

// ================================================================ pointer interaction
let drag = null, spaceDown = false;

function hitTest(x, y) {
  const tol = 5 / S.view.s;
  for (let i = S.objects.length - 1; i >= 0; i--) {
    const o = S.objects[i], L = layerById(o.layer);
    if (hitObject(o, x, y, tol, L && L.mode !== 'line')) return o;
  }
  return null;
}
const snapV = v => settings.snap > 0 ? Math.round(v / settings.snap) * settings.snap : v;

function applyScale(orig, kx, ky, ax, ay) {
  for (const { o, tf } of orig) {
    const rr = ((tf.r % 360) + 360) % 360, near = a => Math.abs(rr - a) < 0.01;
    let sx = tf.sx, sy = tf.sy;
    if (near(0) || near(180) || near(360)) { sx *= kx; sy *= ky; }
    else if (near(90) || near(270)) { sx *= ky; sy *= kx; }
    else { const u = Math.sqrt(kx * ky); sx *= u; sy *= u; }
    o.tf = { ...tf, x: ax + (tf.x - ax) * kx, y: ay + (tf.y - ay) * ky, sx, sy };
  }
}
function applyRotate(orig, deg, cx, cy) {
  const c = Math.cos(deg * G.D2R), s = Math.sin(deg * G.D2R);
  for (const { o, tf } of orig) {
    const dx = tf.x - cx, dy = tf.y - cy;
    o.tf = { ...tf, x: cx + c * dx - s * dy, y: cy + s * dx + c * dy, r: ((tf.r + deg) % 360 + 360) % 360 };
  }
}
const origOf = objs => objs.map(o => ({ o, tf: { ...o.tf } }));

function nodeHit(sx, sy) {
  for (const o of selected()) {
    if (o.type === 'image') continue;
    const polys = worldPolys(o);
    for (let pi = 0; pi < polys.length; pi++) for (let vi = 0; vi < polys[pi].pts.length; vi++) {
      const [x, y] = toScreen(...polys[pi].pts[vi]);
      if (Math.hypot(x - sx, y - sy) <= 6) return { id: o.id, pi, vi };
    }
  }
  return null;
}
function ensurePath(o) { if (o.type !== 'path') { o.polys = localPolys(o); o.type = 'path'; } }

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; return;
  }
  if (e.button !== 0 || S.previewOn) return;
  const tool = S.tool;
  if (tool === 'select') {
    const b = boundsOf(selected());
    if (b) {
      const hi = handlePoints(b).findIndex(([hx, hy]) => Math.hypot(hx - e.offsetX, hy - e.offsetY) <= 7);
      if (hi >= 0) { drag = { kind: hi === 8 ? 'rotate' : 'scale', h: hi, b0: b, start: [wx, wy], orig: origOf(selected()), moved: false }; return; }
    }
    const hit = hitTest(wx, wy);
    if (hit) {
      const ids = withGroups([hit.id]);
      if (e.shiftKey) { const on = S.sel.has(hit.id); for (const id of ids) on ? S.sel.delete(id) : S.sel.add(id); }
      else if (!S.sel.has(hit.id)) S.sel = ids;
      selectionChanged();
      drag = { kind: 'move', start: [wx, wy], orig: origOf(selected()), moved: false };
      return;
    }
    if (!e.shiftKey) { S.sel.clear(); selectionChanged(); }
    drag = { kind: 'marquee', start: [wx, wy], cur: [wx, wy] };
    return;
  }
  if (tool === 'node') {
    const nh = nodeHit(e.offsetX, e.offsetY);
    if (nh) { S.node = nh; drag = { kind: 'node', ...nh, moved: false }; requestDraw(); return; }
    const hit = hitTest(wx, wy);
    S.node = null;
    S.sel = hit ? new Set([hit.id]) : new Set();
    selectionChanged();
    return;
  }
  if (tool === 'measure') { S.measure = { a: [wx, wy], b: [wx, wy] }; drag = { kind: 'measure' }; requestDraw(); return; }
  if (tool === 'rect' || tool === 'ellipse' || tool === 'polygon') {
    S.draft = { kind: 'box', tool, start: [snapV(wx), snapV(wy)], box: null };
    drag = { kind: 'create' };
    return;
  }
  if (tool === 'line') {
    let p = [snapV(wx), snapV(wy)];
    if (!S.draft) S.draft = { kind: 'line', pts: [] };
    const pts = S.draft.pts;
    if (e.shiftKey && pts.length) p = constrain45(pts[pts.length - 1], p);
    if (pts.length >= 3) {
      const [fx, fy] = toScreen(...pts[0]);
      if (Math.hypot(fx - e.offsetX, fy - e.offsetY) < 8) { finishLine(true); return; }
    }
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) pts.push(p);
    requestDraw();
    return;
  }
  if (tool === 'text') createText(wx, wy);
});

function constrain45([ax, ay], [x, y]) {
  const dx = x - ax, dy = y - ay, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(dx, dy);
  return [ax + Math.cos(a) * d, ay + Math.sin(a) * d];
}

cv.addEventListener('pointermove', e => {
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  S.cursor = [wx, wy];
  const [mx, my] = toMachine(dev(), wx, wy);
  $('#st-xy').textContent = `X ${mx.toFixed(2)}  Y ${my.toFixed(2)} mm`;
  if (S.draft && S.draft.kind === 'line') {
    if (e.shiftKey && S.draft.pts.length) S.cursor = constrain45(S.draft.pts[S.draft.pts.length - 1], [wx, wy]);
    requestDraw();
  }
  if (!drag) {
    if (S.tool === 'select' && !S.previewOn) {
      const b = boundsOf(selected());
      const onHandle = b && handlePoints(b).some(([hx, hy]) => Math.hypot(hx - e.offsetX, hy - e.offsetY) <= 7);
      cv.style.cursor = spaceDown ? 'grab' : onHandle ? 'crosshair' : hitTest(wx, wy) ? 'move' : 'default';
    } else if (S.tool === 'node') cv.style.cursor = nodeHit(e.offsetX, e.offsetY) ? 'move' : 'default';
    else cv.style.cursor = spaceDown ? 'grab' : 'crosshair';
    return;
  }
  switch (drag.kind) {
    case 'pan':
      S.view.ox = drag.ox + e.clientX - drag.sx; S.view.oy = drag.oy + e.clientY - drag.sy; requestDraw(); break;
    case 'move': {
      let dx = wx - drag.start[0], dy = wy - drag.start[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (settings.snap > 0) { dx = snapV(dx); dy = snapV(dy); }
      if (!drag.moved && Math.hypot(dx, dy) * S.view.s < 2) return;
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      for (const { o, tf } of drag.orig) o.tf = { ...tf, x: tf.x + dx, y: tf.y + dy };
      changed(); break;
    }
    case 'scale': {
      const b = drag.b0, h = drag.h;
      const left = [0, 3, 7].includes(h), rgt = [1, 2, 5].includes(h);
      const top = [0, 1, 4].includes(h), bottom = [2, 3, 6].includes(h);
      const ax = left ? b.maxX : rgt ? b.minX : (b.minX + b.maxX) / 2;
      const ay = top ? b.maxY : bottom ? b.minY : (b.minY + b.maxY) / 2;
      const hx = left ? b.minX : b.maxX, hy = top ? b.minY : b.maxY;
      let kx = left || rgt ? (wx - ax) / (hx - ax || 1e-9) : 1;
      let ky = top || bottom ? (wy - ay) / (hy - ay || 1e-9) : 1;
      if (h < 4 && !e.shiftKey) { const k = Math.abs(kx) > Math.abs(ky) ? kx : ky; kx = ky = k; }
      kx = Math.max(kx, 0.001); ky = Math.max(ky, 0.001);
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      applyScale(drag.orig, kx, ky, ax, ay); changed(); break;
    }
    case 'rotate': {
      const b = drag.b0, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      let deg = (Math.atan2(wy - cy, wx - cx) - Math.atan2(drag.start[1] - cy, drag.start[0] - cx)) / G.D2R;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      applyRotate(drag.orig, deg, cx, cy); changed();
      $('#hint').textContent = `Rotate ${deg.toFixed(1)}°`;
      break;
    }
    case 'node': {
      const o = S.objects.find(x => x.id === drag.id); if (!o) break;
      if (!drag.moved) { pushUndo(); drag.moved = true; ensurePath(o); }
      const [lx, ly] = G.apply(G.invert(G.tfMatrix(o.tf)), snapV(wx), snapV(wy));
      o.polys = o.polys.map((p, i) => i !== drag.pi ? p : { closed: p.closed, pts: p.pts.map((q, j) => j === drag.vi ? [lx, ly] : q) });
      changed(); break;
    }
    case 'measure': {
      let b = [wx, wy];
      if (e.shiftKey) b = constrain45(S.measure.a, b);
      S.measure.b = b; requestDraw(); break;
    }
    case 'marquee': drag.cur = [wx, wy]; requestDraw(); break;
    case 'create': {
      const [x0, y0] = S.draft.start;
      let x1 = snapV(wx), y1 = snapV(wy);
      if (e.shiftKey) { const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s; }
      if (e.altKey) S.draft.box = { x: x0 - (x1 - x0), y: y0 - (y1 - y0), w: 2 * (x1 - x0), h: 2 * (y1 - y0) };
      else S.draft.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      requestDraw(); break;
    }
  }
});

cv.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'rotate') $('#hint').textContent = '';
  if (d.kind === 'marquee') {
    const [x0, y0] = d.start, [x1, y1] = d.cur;
    const mb = { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) };
    const crossing = x1 < x0;
    if ((mb.maxX - mb.minX) * S.view.s > 3) {
      for (const o of S.objects) {
        const b = objBounds(o);
        const inside = b.minX >= mb.minX && b.maxX <= mb.maxX && b.minY >= mb.minY && b.maxY <= mb.maxY;
        const touch = !(b.maxX < mb.minX || b.minX > mb.maxX || b.maxY < mb.minY || b.minY > mb.maxY);
        if (crossing ? touch : inside) S.sel.add(o.id);
      }
      S.sel = withGroups(S.sel);
    }
    selectionChanged();
  } else if (d.kind === 'create') {
    const dr = S.draft; S.draft = null;
    let box = dr.box;
    if (!box || (Math.abs(box.w) * S.view.s < 4 && Math.abs(box.h) * S.view.s < 4)) {
      box = { x: dr.start[0] - 10, y: dr.start[1] - 10, w: 20, h: 20 }; // click without drag: 20 mm shape
    }
    const w = Math.abs(box.w), h = Math.abs(box.h);
    edit(() => {
      const o = addObject({ type: dr.tool, w, h, radius: 0, sides: 6, star: 0, tf: { x: box.x + box.w / 2, y: box.y + box.h / 2, sx: 1, sy: 1, r: 0 } });
      S.sel = new Set([o.id]);
    });
  } else if (d.kind === 'pan') cv.style.cursor = spaceDown ? 'grab' : 'default';
  requestDraw();
});

cv.addEventListener('dblclick', e => {
  if (S.tool === 'line' && S.draft) { finishLine(false); return; }
  if (S.tool !== 'node') return;
  // insert a node on the nearest segment
  const [wx, wy] = toWorld(e.offsetX, e.offsetY), tol = 6 / S.view.s;
  for (const o of selected()) {
    if (o.type === 'image') continue;
    const polys = worldPolys(o);
    for (let pi = 0; pi < polys.length; pi++) {
      const pts = polys[pi].pts, n = pts.length;
      for (let i = 1; i < n + (polys[pi].closed ? 1 : 0); i++) {
        const a = pts[i - 1], b = pts[i % n];
        if (G.distToSegment(wx, wy, a[0], a[1], b[0], b[1]) <= tol) {
          edit(() => {
            ensurePath(o);
            const local = G.apply(G.invert(G.tfMatrix(o.tf)), wx, wy);
            o.polys = o.polys.map((p, k) => k !== pi ? p : { closed: p.closed, pts: [...p.pts.slice(0, i), local, ...p.pts.slice(i)] });
            S.node = { id: o.id, pi, vi: i };
          });
          return;
        }
      }
    }
  }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || !e.shiftKey) zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
  else { S.view.ox -= e.deltaY; requestDraw(); }
}, { passive: false });
cv.addEventListener('pointerleave', () => { S.cursor = null; requestDraw(); });

function finishLine(close) {
  const d = S.draft; S.draft = null;
  if (!d || d.pts.length < 2) { requestDraw(); return; }
  edit(() => { const o = pathFromWorld([{ closed: close, pts: d.pts }]); S.sel = new Set([o.id]); });
}

function deleteNode() {
  const n = S.node, o = n && S.objects.find(x => x.id === n.id);
  if (!o) return false;
  edit(() => {
    ensurePath(o);
    const p = o.polys[n.pi], min = p.closed ? 3 : 2;
    if (p.pts.length <= min) o.polys = o.polys.filter((_, i) => i !== n.pi);
    else o.polys = o.polys.map((q, i) => i !== n.pi ? q : { closed: q.closed, pts: q.pts.filter((_, j) => j !== n.vi) });
    if (!o.polys.length) S.objects = S.objects.filter(x => x !== o);
    S.node = null;
  });
  return true;
}

// ================================================================ tools & keyboard
const HINTS = {
  line: 'Click to add points · Shift = 45° · Double-click / Enter to finish · click the first point to close',
  text: 'Click where the text should go', rect: 'Drag to draw · Shift = square · Alt = from centre',
  ellipse: 'Drag to draw · Shift = circle · Alt = from centre', polygon: 'Drag to draw — change sides/star in the Shape tab',
  node: 'Click a shape, then drag its points · double-click a line to add a point · Del removes the selected point',
  measure: 'Drag to measure · Shift = 45°',
};
function setTool(t) {
  if (S.draft && S.draft.kind === 'line' && t !== 'line') finishLine(false);
  S.tool = t; S.draft = null; S.node = null;
  if (t !== 'measure') S.measure = null;
  $$('.tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  $('#hint').textContent = HINTS[t] || '';
  requestDraw();
}
$$('.tools [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $('#dlg').open;
window.addEventListener('keydown', e => {
  if (typing()) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === ' ') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  const combos = {
    z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', i: 'import', e: 'export', d: 'dup',
    a: 'select-all', c: 'copy', x: 'cut', v: 'paste', g: e.shiftKey ? 'ungroup' : 'group',
  };
  if (mod && combos[k]) { e.preventDefault(); act(combos[k]); return; }
  if (e.altKey && k === 'p') { e.preventDefault(); act('preview'); return; }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (S.tool === 'node' && deleteNode()) return; act('del'); return; }
  if (e.key === 'Escape') {
    closeMenus();
    if (S.draft) { S.draft = null; requestDraw(); } else if (S.previewOn) act('preview');
    else if (S.tool !== 'select') setTool('select'); else { S.sel.clear(); selectionChanged(); }
    return;
  }
  if (e.key === 'Enter' && S.draft && S.draft.kind === 'line') { finishLine(false); return; }
  if (e.key.startsWith('Arrow') && S.sel.size) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
    const dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    edit(() => selected().forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; }));
    return;
  }
  const tools = { v: 'select', n: 'node', r: 'rect', e: 'ellipse', p: 'polygon', l: 'line', t: 'text', m: 'measure' };
  if (tools[k]) { setTool(tools[k]); return; }
  if (k === 'f') zoomFit();
});
window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; cv.style.cursor = 'default'; } });

// ================================================================ menus
function closeMenus() { $$('.menu.open').forEach(m => m.classList.remove('open')); }
function openMenu(m) {
  closeMenus(); m.classList.add('open');
  const r = m.querySelector('.menu-btn').getBoundingClientRect(), pop = m.querySelector('.menu-pop');
  pop.style.left = `${Math.min(r.left, innerWidth - 260)}px`; pop.style.top = `${r.bottom + 4}px`;
}
$$('.menu').forEach(m => {
  m.querySelector('.menu-btn').addEventListener('click', ev => { ev.stopPropagation(); m.classList.contains('open') ? closeMenus() : openMenu(m); });
  m.querySelector('.menu-btn').addEventListener('mouseenter', () => { if ($('.menu.open') && !m.classList.contains('open')) openMenu(m); });
});
document.addEventListener('click', ev => { if (!ev.target.closest('.menu-pop')) closeMenus(); });

// ================================================================ dialogs
const FONTS = ['sans-serif', 'serif', 'monospace', '"DejaVu Sans"', '"DejaVu Serif"', '"Liberation Sans"', '"Liberation Serif"', '"Noto Sans"', '"Noto Serif"', 'Arial', 'Georgia', '"Times New Roman"', 'Verdana', 'Impact', 'cursive', 'fantasy'];

// fields: [{key,label,type:'number'|'text'|'textarea'|'select'|'check'|'note',value,options,step,min,max,cls}]
function formDialog(title, fields, { ok = 'OK', note, wide } = {}) {
  return new Promise(resolve => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    form.replaceChildren(el('h2', {}, title));
    if (note) form.append(el('p', {}, note));
    const inputs = {}, box = el('div', { class: 'scroll' });
    for (const f of fields) {
      if (f.type === 'note') { box.append(el('p', { class: 'small' }, f.label)); continue; }
      let inp;
      if (f.type === 'select') inp = el('select', {}, f.options.map(([v, l]) => el('option', { value: v }, l)));
      else if (f.type === 'textarea') inp = el('textarea', { class: f.cls || '' });
      else if (f.type === 'check') inp = el('input', { type: 'checkbox' });
      else inp = el('input', { type: f.type || 'text', step: f.step ?? 'any', min: f.min, max: f.max });
      if (f.type === 'check') inp.checked = !!f.value; else inp.value = f.value ?? '';
      inputs[f.key] = inp;
      box.append(f.type === 'check' ? el('label', { class: 'fld chk' }, inp, el('span', {}, f.label))
        : f.type === 'textarea' && f.cls === 'code' ? el('label', { class: 'form' }, el('span', { class: 'muted' }, f.label), inp)
          : el('label', { class: 'fld' + (wide ? ' wide' : '') }, el('span', {}, f.label), inp));
    }
    form.append(box);
    form.append(el('div', { class: 'actions' },
      el('button', { value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
      el('button', { value: 'ok', type: 'submit', class: 'primary' }, ok)));
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const out = {};
      for (const f of fields) {
        const i = inputs[f.key]; if (!i) continue;
        out[f.key] = f.type === 'check' ? i.checked : f.type === 'number' ? parseFloat(i.value) : i.value;
      }
      resolve(out);
    };
    dlg.returnValue = '';
    dlg.showModal();
    const first = form.querySelector('textarea, input, select');
    if (first) { first.focus(); first.select?.(); }
  });
}
const confirmDialog = (title, note, ok = 'OK') => formDialog(title, [], { ok, note }).then(v => !!v);
// Dialog whose body is rebuilt by `render(redraw)`; resolves when closed.
function panelDialog(title, render) {
  return new Promise(resolve => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    const body = el('div', { class: 'form' });
    const redraw = () => body.replaceChildren(...[render(redraw)].flat());
    form.replaceChildren(el('h2', {}, title), body, el('div', { class: 'actions' }, el('button', { value: 'ok', type: 'submit', class: 'primary' }, 'Done')));
    redraw();
    dlg.onclose = () => resolve();
    dlg.returnValue = '';
    if (!dlg.open) dlg.showModal();
  });
}

async function createText(x, y) {
  const v = await formDialog('Add text', [
    { key: 'text', label: 'Text', type: 'textarea', value: 'Hello' },
    { key: 'font', label: 'Font', type: 'select', options: FONTS.map(f => [f, f.replace(/"/g, '')]), value: 'sans-serif' },
    { key: 'size', label: 'Height (mm)', type: 'number', value: 10, min: 0.5 },
    { key: 'bold', label: 'Bold', type: 'check' },
    { key: 'italic', label: 'Italic', type: 'check' },
    { key: 'n', type: 'note', label: 'Variable text: {serial}, {serial:4}, {date}, {time}, {year}, {month}, {day}' },
  ], { ok: 'Add' });
  if (!v || !v.text.trim()) return;
  edit(() => {
    const o = addObject({ type: 'text', text: v.text, font: v.font, size: v.size || 10, bold: v.bold, italic: v.italic, align: 'center', tf: { x, y, sx: 1, sy: 1, r: 0 } });
    S.sel = new Set([o.id]);
  });
  setTool('select');
}

async function preferencesDialog() {
  const v = await formDialog('Preferences', [
    { key: 'snap', label: 'Snap to grid (mm, 0 = off)', type: 'number', value: settings.snap, min: 0 },
    { key: 'pulsePower', label: 'Test fire power (%)', type: 'number', value: settings.pulsePower, min: 0, max: 100 },
    { key: 'pulseMs', label: 'Test fire length (ms)', type: 'number', value: settings.pulseMs, min: 10, max: 2000 },
    { key: 'framePower', label: 'Frame beam power (%)', type: 'number', value: settings.framePower, min: 0, max: 100 },
    { key: 'serial', label: 'Next {serial} number', type: 'number', value: settings.serial, step: 1 },
    { key: 'serialAuto', label: 'Advance {serial} after each job', type: 'check', value: settings.serialAuto },
  ], { ok: 'Save', note: 'Machine options (bed size, origin, controller type…) are under Laser → Devices.', wide: true });
  if (!v) return;
  for (const [k, val] of Object.entries(v)) if (!(typeof val === 'number' && Number.isNaN(val))) settings[k] = val;
  textVars.serial = settings.serial;
  saveSettings(); changed();
}

async function deviceEditDialog(d) {
  const v = await formDialog(`Device: ${d.name}`, [
    { key: 'name', label: 'Name', value: d.name },
    { key: 'type', label: 'Controller', type: 'select', value: d.type, options: Object.entries(DEVICE_TYPES).map(([k, t]) => [k, t.label]) },
    { key: 'bedW', label: 'Work area width (mm)', type: 'number', value: d.bedW, min: 10 },
    { key: 'bedH', label: 'Work area height (mm)', type: 'number', value: d.bedH, min: 10 },
    { key: 'origin', label: 'Origin (home corner)', type: 'select', value: d.origin, options: ORIGINS },
    { key: 'sMax', label: 'Max S value', type: 'number', value: d.sMax, min: 0.001 },
    { key: 'travel', label: 'Travel speed (mm/s)', type: 'number', value: d.travel, min: 1 },
    { key: 'baud', label: 'Baud rate', type: 'select', value: String(d.baud), options: ['115200', '250000', '230400', '57600', '38400', '9600'].map(b => [b, b]) },
    { key: 'air', label: 'Air assist command', type: 'select', value: d.air, options: [['M8', 'M8 (flood coolant pin)'], ['M7', 'M7 (mist coolant pin)'], ['none', 'None']] },
    { key: 'returnHome', label: 'Return to start when the job finishes', type: 'check', value: d.returnHome },
    { key: 'zEnabled', label: 'Machine has a Z axis (enables Z offset / Z step per pass)', type: 'check', value: d.zEnabled },
    { key: 'powerLimit', label: 'Power limit (%) — caps every layer', type: 'number', value: d.powerLimit ?? 100, min: 0, max: 100 },
    { key: 'host', label: 'Ruida: controller IP address', value: d.host || '' },
    { key: 'magic', label: 'Ruida: swizzle key', type: 'select', value: String(d.magic ?? 0x88), options: [['136', '0x88 — RDC644x / 654x / 320 (most)'], ['17', '0x11 — RDC634x'], ['56', '0x38 — RDL9635']] },
    { key: 'n', type: 'note', label: 'Max S: GRBL uses $30 (usually 1000). Smoothieware uses 1 (power 0.0–1.0). Marlin uses 255 by default. Changing the controller type resets Max S to its usual value.' },
  ], { ok: 'Save', wide: true });
  if (!v) return false;
  const typeChanged = v.type !== d.type;
  for (const [k, val] of Object.entries(v)) if (!(typeof val === 'number' && Number.isNaN(val))) d[k] = val;
  d.magic = Number(d.magic) || 0x88;
  d.host = String(d.host || '').trim();
  if (typeChanged) { d.sMax = DEVICE_TYPES[d.type].sMax; d.baud = String(DEVICE_TYPES[d.type].baud); if (DEVICE_TYPES[d.type].origin) d.origin = DEVICE_TYPES[d.type].origin; }
  if (d.type === 'ruida' && d.port !== 'virtual') d.port = `udp:${d.host}`;
  saveSettings(); deviceChanged();
  return true;
}
function devicesDialog() {
  return panelDialog('Devices', redraw => {
    const rows = settings.devices.map(d => el('div', { class: 'ditem' + (d.id === settings.deviceId ? ' active' : '') },
      el('span', { class: 't' }, el('b', {}, d.name), el('span', { class: 'muted small' }, ` · ${DEVICE_TYPES[d.type].label} · ${d.bedW}×${d.bedH} mm`)),
      el('span', { class: 'row' },
        el('button', { type: 'button', disabled: d.id === settings.deviceId, onclick: () => { selectDevice(d.id); redraw(); } }, 'Use'),
        el('button', { type: 'button', onclick: async () => { $('#dlg').close(); await deviceEditDialog(d); devicesDialog(); } }, 'Edit'),
        el('button', { type: 'button', disabled: settings.devices.length < 2, onclick: () => { settings.devices = settings.devices.filter(x => x !== d); if (settings.deviceId === d.id) selectDevice(settings.devices[0].id); saveSettings(); redraw(); } }, 'Delete'))));
    const typeSel = el('select', {}, Object.entries(DEVICE_TYPES).map(([k, t]) => el('option', { value: k }, t.label)));
    return [el('div', { class: 'dlist' }, rows),
      el('div', { class: 'row gap' }, typeSel, el('button', { type: 'button', onclick: async () => {
        const d = makeDevice(typeSel.value, { name: DEVICE_TYPES[typeSel.value].label });
        settings.devices.push(d); saveSettings();
        $('#dlg').close();
        if (await deviceEditDialog(d)) selectDevice(d.id);
        devicesDialog();
      } }, '+ Add device'))];
  });
}
function selectDevice(id) {
  if (S.m.connected && id !== settings.deviceId) { msg('Disconnected: switching device', 'err'); machine.disconnect().catch(() => {}); }
  settings.deviceId = id; saveSettings(); deviceChanged();
}
function deviceChanged() {
  const sel = $('#dev-select');
  sel.replaceChildren(...settings.devices.map(d => el('option', { value: d.id }, d.name)));
  sel.value = settings.deviceId;
  $('#m-devname').textContent = `${dev().name} · ${DEVICE_TYPES[dev().type].label}${dev().rotary ? ' · rotary' : ''}`;
  $('#con-in').placeholder = isRuida() ? 'Hex bytes, e.g. DA 00 05 7E (reads the card ID)' : 'G-code or controller command…';
  $('#m-baud').value = String(dev().baud);
  renderMacros(); refreshPorts(); zoomFit(); changed();
}
$('#dev-select').addEventListener('change', e => selectDevice(e.target.value));

async function rotaryDialog() {
  const d = dev();
  const v = await formDialog('Rotary setup', [
    { key: 'rotary', label: 'Enable rotary (replaces the Y axis)', type: 'check', value: d.rotary },
    { key: 'rotaryType', label: 'Rotary type', type: 'select', value: d.rotaryType, options: [['roller', 'Roller (object rests on rollers)'], ['chuck', 'Chuck (object is clamped)']] },
    { key: 'rotaryMmPerRot', label: 'Y travel for one full turn (mm)', type: 'number', value: d.rotaryMmPerRot, min: 0.1 },
    { key: 'rotaryRollerDia', label: 'Roller diameter (mm)', type: 'number', value: d.rotaryRollerDia, min: 1 },
    { key: 'rotaryObjectDia', label: 'Object diameter (mm)', type: 'number', value: d.rotaryObjectDia, min: 1 },
    { key: 'n', type: 'note', label: 'To find "Y travel for one turn": jog Y by e.g. 100 mm and count how many turns the roller/chuck makes. Draw your design at true size on the object surface; BeamForge scales the Y moves.' },
  ], { ok: 'Save', wide: true });
  if (!v) return;
  for (const [k, val] of Object.entries(v)) if (!(typeof val === 'number' && Number.isNaN(val))) d[k] = val;
  saveSettings(); deviceChanged();
  msg(d.rotary ? `Rotary on — Y scale ×${rotaryScale(d).toFixed(4)}` : 'Rotary off', 'ok');
}

async function macrosDialog() {
  const d = dev();
  const text = (d.macros || []).map(m => `[${m.name}]\n${m.gcode}`).join('\n\n');
  const v = await formDialog('Macros', [
    { key: 'text', label: 'One macro per block: a [Name] line followed by its commands.', type: 'textarea', cls: 'code', value: text || '[Air on]\nM8\n\n[Air off]\nM9' },
  ], { ok: 'Save' });
  if (!v) return;
  const macros = [];
  for (const block of v.text.split(/\n(?=\[)/)) {
    const m = /^\s*\[([^\]]+)\]\s*\n?([\s\S]*)$/.exec(block);
    if (m && m[2].trim()) macros.push({ name: m[1].trim(), gcode: m[2].trim() });
  }
  d.macros = macros; saveSettings(); renderMacros();
}
function renderMacros() {
  $('#m-macros').replaceChildren(...(dev().macros || []).map(m => el('button', { title: m.gcode, disabled: !S.m.connected, onclick: guard(() => isRuida() ? machine.ruida('raw', { text: m.gcode }) : machine.send(m.gcode)) }, m.name)));
}

function libraryDialog() {
  return panelDialog('Material library', redraw => {
    const lib = loadLib();
    const L = activeLayer();
    const rows = lib.length ? lib.map(p => el('div', { class: 'ditem' },
      el('span', { class: 't' }, el('b', {}, `${p.material} ${p.thickness ? p.thickness + ' mm' : ''}`), el('span', { class: 'muted small' }, ` · ${p.name} · ${p.settings.mode} ${p.settings.speed} mm/s ${p.settings.power}%`)),
      el('span', { class: 'row' },
        el('button', { type: 'button', title: `Apply to ${L.name}`, onclick: () => { edit(() => Object.assign(L, p.settings)); msg(`Applied "${p.name}" to ${L.name}`, 'ok'); } }, 'Apply'),
        el('button', { type: 'button', onclick: () => { saveLib(lib.filter(x => x !== p)); redraw(); } }, 'Delete'))))
      : [el('p', { class: 'muted' }, 'No presets yet. Set up a layer, then save it here.')];
    return [
      el('p', { class: 'small muted' }, `Presets apply to the active layer (${L.name}).`),
      el('div', { class: 'dlist' }, rows),
      el('div', { class: 'row gap wrap' },
        el('button', { type: 'button', onclick: async () => { $('#dlg').close(); await savePresetDialog(); libraryDialog(); } }, `Save ${L.name} as preset…`),
        el('button', { type: 'button', onclick: () => download('beamforge-materials.json', JSON.stringify(loadLib(), null, 2), 'application/json') }, 'Export'),
        el('button', { type: 'button', onclick: () => $('#file-lib').click() }, 'Import')),
    ];
  });
}
async function savePresetDialog() {
  const L = activeLayer();
  const v = await formDialog('Save preset', [
    { key: 'material', label: 'Material', value: '3 mm plywood' },
    { key: 'thickness', label: 'Thickness (mm)', type: 'number', value: 3, min: 0 },
    { key: 'name', label: 'Operation', value: L.mode === 'line' ? 'Cut' : L.mode === 'image' ? 'Photo engrave' : 'Engrave' },
  ], { ok: 'Save' });
  if (!v) return;
  const copy = {}; for (const k of LAYER_KEYS) copy[k] = L[k];
  saveLib([...loadLib(), { id: uid(), material: v.material, thickness: v.thickness, name: v.name, settings: copy }]);
  msg('Preset saved', 'ok'); refreshPanels();
}
$('#file-lib').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const items = JSON.parse(await readFile(f));
    if (!Array.isArray(items)) throw new Error('Not a material library file');
    const good = items.filter(i => i && i.settings);
    saveLib([...loadLib(), ...good]); msg(`Imported ${good.length} preset(s)`, 'ok');
    if ($('#dlg').open) $('#dlg').close();
    libraryDialog();
  } catch (err) { msg(err.message, 'err'); }
});

// ================================================================ trace (live preview)
function traceDialog() {
  const o = selected().find(x => x.type === 'image');
  if (!o) return msg('Select an image to trace');
  const prefs = { mode: 'brightness', cutoff: 0, threshold: 128, edge: 60, ignore: 6, optimize: 0.6, smooth: 0.4, res: 10, fade: true, del: false, ...(settings.trace || {}) };
  const dlg = $('#dlg'), form = $('#dlg-form');
  const cvs = el('canvas', { width: 480, height: 320, style: 'width:100%;background:#fff;border-radius:6px;border:1px solid var(--line)' });
  const info = el('div', { class: 'muted small' });
  const slider = (key, label, min, max, step) => {
    const val = el('span', { class: 'muted small', style: 'min-width:34px;text-align:right' }, String(prefs[key]));
    const i = el('input', { type: 'range', min, max, step, value: prefs[key] });
    i.addEventListener('input', () => { prefs[key] = +i.value; val.textContent = i.value; schedule(); });
    return el('label', { class: 'fld', 'data-for': key }, el('span', {}, label), el('div', { class: 'row' }, i, val));
  };
  const modeSel = selInput(prefs.mode, [['brightness', 'Brightness (cutoff → threshold)'], ['sketch', 'Sketch — trace edges'], ['transparency', 'Transparency (PNG alpha)']], v => { prefs.mode = v; sync(); schedule(); });
  const fade = chkInput(prefs.fade, v => { prefs.fade = v; draw(); });
  const del = chkInput(prefs.del, v => { prefs.del = v; });
  const rows = {
    cutoff: slider('cutoff', 'Cutoff', 0, 255, 1), threshold: slider('threshold', 'Threshold', 0, 255, 1),
    edge: slider('edge', 'Edge sensitivity', 1, 254, 1),
  };
  const sync = () => {
    rows.cutoff.style.display = rows.threshold.style.display = prefs.mode === 'brightness' ? '' : 'none';
    rows.edge.style.display = prefs.mode === 'sketch' ? '' : 'none';
  };
  let result = null, timer = null;
  const draw = () => {
    const g = cvs.getContext('2d'), Wc = cvs.width, Hc = cvs.height;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, Wc, Hc);
    const k = Math.min(Wc / o.w, Hc / o.h) * 0.96, ox = Wc / 2, oy = Hc / 2;
    const img = imageSource(o);
    if (img) {
      g.save(); g.globalAlpha = prefs.fade ? 0.3 : 1; g.filter = imageFilter(o);
      g.drawImage(img, ox - o.w / 2 * k, oy - o.h / 2 * k, o.w * k, o.h * k); g.restore();
    }
    if (!result) return;
    g.strokeStyle = '#e5484d'; g.lineWidth = 1.2; g.beginPath();
    for (const p of result.polys) { p.pts.forEach(([x, y], i) => i ? g.lineTo(ox + x * k, oy + y * k) : g.moveTo(ox + x * k, oy + y * k)); g.closePath(); }
    g.stroke();
  };
  const run = full => {
    const opts = { ...prefs, maxPx: full ? 3000 : 700 };
    const r = traceImage(o, opts);
    if (!full) {
      result = r; draw();
      info.textContent = `${r.polys.length} shape(s), ${r.polys.reduce((a, p) => a + p.pts.length, 0).toLocaleString()} points (preview at reduced detail)`;
    }
    return r;
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { try { run(false); } catch (e) { info.textContent = e.message; } }, 120); };
  form.replaceChildren(el('h2', {}, 'Trace image'), cvs, info,
    el('div', { class: 'scroll' },
      field('Mode', modeSel), rows.cutoff, rows.threshold, rows.edge,
      slider('ignore', 'Ignore less than (px²)', 0, 400, 1), slider('smooth', 'Smoothness', 0, 1, 0.05),
      slider('optimize', 'Optimize (px)', 0.05, 3, 0.05), slider('res', 'Detail (px/mm)', 2, 30, 1),
      check('Fade image in preview', fade), check('Delete the image after tracing', del)),
    el('div', { class: 'actions' },
      el('button', { value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
      el('button', { value: 'ok', type: 'submit', class: 'primary' }, 'Trace')));
  sync();
  dlg.onclose = () => {
    clearTimeout(timer);
    settings.trace = { ...prefs }; saveSettings();
    if (dlg.returnValue !== 'ok') return;
    try {
      const { polys } = run(true);
      if (!polys.length) return msg('Nothing found with those settings', 'err');
      edit(() => {
        const L = activeLayer().mode === 'image' ? (S.layers.find(l => l.mode !== 'image') || layerForColor(PALETTE[1])) : activeLayer();
        const p = addObject({ type: 'path', name: 'Traced ' + (o.name || 'image'), polys, layer: L.id, tf: { ...o.tf } });
        if (prefs.del) S.objects = S.objects.filter(x => x !== o);
        S.sel = new Set([p.id]);
      });
      msg(`Traced ${polys.length} shape(s)`, 'ok');
    } catch (e) { msg(e.message, 'err'); }
  };
  dlg.returnValue = '';
  dlg.showModal();
  schedule();
}

// ================================================================ actions
function replaceWithResult(objs, polys, label) {
  if (!polys.length) { msg(`${label}: the result is empty`, 'err'); return; }
  edit(() => {
    const layer = objs[0].layer;
    const ids = new Set(objs.map(o => o.id));
    S.objects = S.objects.filter(o => !ids.has(o.id));
    const o = pathFromWorld(polys, { layer, name: label });
    S.sel = new Set([o.id]);
  });
  msg(`${label}: ${polys.length} outline(s)`, 'ok');
}
function boolAction(op, label) {
  // Order follows the drawing order, so "first" is the bottom-most selected object.
  const objs = selected().filter(o => o.type !== 'image');
  if (objs.length < (op === 'union' ? 1 : 2)) return msg(`Select ${op === 'union' ? 'one or more' : 'two or more'} shapes`);
  try {
    const groups = objs.map(o => worldPolys(o));
    const polys = op === 'union' ? booleanOp('union', groups) : booleanOp(op, [groups[0]], groups.slice(1));
    replaceWithResult(objs, polys, label);
  } catch (e) { msg(e.message, 'err'); }
}
function copyObjs(list, dx, dy) {
  const regroup = new Map();
  return list.map(c => {
    const g = c.group ? (regroup.get(c.group) || regroup.set(c.group, uid()).get(c.group)) : undefined;
    return addObject({ ...c, id: undefined, group: g, tf: { ...c.tf, x: c.tf.x + dx, y: c.tf.y + dy } });
  });
}

const ACTIONS = {
  async new() {
    if (S.objects.length && !(await confirmDialog('Start a new project?', 'Unsaved changes in the current design will be lost.', 'New project'))) return;
    newProject();
  },
  open() { $('#file-open').click(); },
  save() { download('design.bfp', JSON.stringify(projectData()), 'application/json'); msg('Project saved', 'ok'); },
  import() { $('#file-import').click(); },
  'export-svg': exportSvg,
  'export-dxf': exportDxf,
  export() {
    try {
      const job = buildJob();
      if (job.ruida) {
        download('job.rd', swizzle(job.ruida, dev().magic ?? 0x88), 'application/octet-stream');
        msg(`RD file saved (${job.ruida.length.toLocaleString()} bytes) — copy it to a USB stick to run it from the laser's panel`, 'ok');
      } else {
        download('job.gcode', job.gcode, 'text/plain');
        msg(`G-code saved — ${job.stats.lines.toLocaleString()} lines, est. ${fmtTime(job.stats.time)}`, 'ok');
      }
    } catch (e) { msg(e.message, 'err'); }
  },
  'run-file'() {
    if (isRuida()) return msg('Ruida machines run RD files: save one with File → Save, then load it from a USB stick on the laser.');
    if (!S.m.connected) return msg('Connect to the laser first', 'err');
    $('#file-gcode').click();
  },
  undo, redo,
  copy() { S.clipboard = selected().map(o => ({ ...o, tf: { ...o.tf } })); msg(`Copied ${S.clipboard.length} object(s)`); },
  cut() { S.clipboard = selected().map(o => ({ ...o, tf: { ...o.tf } })); ACTIONS.del(); },
  paste() {
    if (!S.clipboard || !S.clipboard.length) return;
    edit(() => { S.sel = new Set(copyObjs(S.clipboard, 5, 5).map(o => o.id)); });
    S.clipboard = S.clipboard.map(c => ({ ...c, tf: { ...c.tf, x: c.tf.x + 5, y: c.tf.y + 5 } }));
  },
  dup() {
    const objs = selected(); if (!objs.length) return;
    edit(() => { S.sel = new Set(copyObjs(objs, 5, 5).map(o => o.id)); });
  },
  del() {
    if (!S.sel.size) return;
    edit(() => { S.objects = S.objects.filter(o => !S.sel.has(o.id)); S.sel.clear(); S.node = null; });
  },
  'select-all'() { S.sel = new Set(S.objects.map(o => o.id)); selectionChanged(); },
  group() {
    if (S.sel.size < 2) return msg('Select two or more objects to group');
    const g = uid(); edit(() => selected().forEach(o => { o.group = g; })); msg('Grouped', 'ok');
  },
  ungroup() { if (!selected().some(o => o.group)) return; edit(() => selected().forEach(o => { delete o.group; })); msg('Ungrouped', 'ok'); },
  'mirror-h'() { mirror(true); },
  'mirror-v'() { mirror(false); },
  'mirror-both'() {
    const b = boundsOf(selected()); if (!b) return;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    edit(() => selected().forEach(o => { o.tf = reflectTf(reflectTf(o.tf, 0, cx, cy), 90, cx, cy); }));
  },
  'mirror-copy-h'() { const b = boundsOf(selected()); if (b) mirrorSel(90, { copy: true, at: [b.maxX, b.minY] }); },
  'mirror-copy-v'() { const b = boundsOf(selected()); if (b) mirrorSel(0, { copy: true, at: [b.minX, b.maxY] }); },
  'mirror-line'() { mirrorLineDialog(); },
  fillet() { filletDialog({ style: 'round' }); },
  chamfer() { filletDialog({ style: 'chamfer' }); },
  'dist-hc'() { distributeCentres(0); },
  'dist-vc'() { distributeCentres(1); },
  spacing() { spacingDialog(); },
  'same-w'() { sameSize(true, false); },
  'same-h'() { sameSize(false, true); },
  'same-size'() { sameSize(true, true); },
  'rot-cw'() { rotateSel(90); },
  'rot-ccw'() { rotateSel(-90); },
  async array() {
    const objs = selected(); if (!objs.length) return msg('Select something to array first');
    const b = boundsOf(objs);
    const v = await formDialog('Grid array', [
      { key: 'cols', label: 'Columns', type: 'number', value: 3, min: 1, step: 1 },
      { key: 'rows', label: 'Rows', type: 'number', value: 2, min: 1, step: 1 },
      { key: 'gx', label: 'Gap X (mm)', type: 'number', value: 5 },
      { key: 'gy', label: 'Gap Y (mm)', type: 'number', value: 5 },
    ], { ok: 'Create', note: `Selection is ${r3(b.maxX - b.minX)} × ${r3(b.maxY - b.minY)} mm.` });
    if (!v) return;
    const dx = b.maxX - b.minX + (v.gx || 0), dy = b.maxY - b.minY + (v.gy || 0);
    edit(() => {
      for (let r = 0; r < Math.max(1, v.rows | 0); r++) for (let c = 0; c < Math.max(1, v.cols | 0); c++) {
        if (!r && !c) continue;
        copyObjs(objs, c * dx, r * dy).forEach(o => S.sel.add(o.id));
      }
    });
  },
  async 'circ-array'() {
    const objs = selected(); if (!objs.length) return msg('Select something to array first');
    const v = await formDialog('Circular array', [
      { key: 'count', label: 'Total copies', type: 'number', value: 6, min: 2, step: 1 },
      { key: 'radius', label: 'Radius (mm)', type: 'number', value: 40, min: 0 },
      { key: 'sweep', label: 'Sweep angle (°)', type: 'number', value: 360 },
      { key: 'rotate', label: 'Rotate copies around the centre', type: 'check', value: true },
      { key: 'n', type: 'note', label: 'The circle centre is placed below the selection by the radius.' },
    ], { ok: 'Create' });
    if (!v) return;
    const b = boundsOf(objs), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2 + (v.radius || 0);
    const n = Math.max(2, v.count | 0), sweep = v.sweep || 360;
    const step = Math.abs(Math.abs(sweep) - 360) < 1e-6 ? sweep / n : sweep / (n - 1);
    edit(() => {
      for (let i = 1; i < n; i++) {
        const copies = copyObjs(objs, 0, 0), ang = step * i;
        if (v.rotate) applyRotate(origOf(copies), ang, cx, cy);
        else {
          const c = Math.cos(ang * G.D2R), s = Math.sin(ang * G.D2R);
          for (const o of copies) {
            const u = units([o])[0].b, ox = (u.minX + u.maxX) / 2 - cx, oy = (u.minY + u.maxY) / 2 - cy;
            const nx = cx + c * ox - s * oy, ny = cy + s * ox + c * oy;
            o.tf = { ...o.tf, x: o.tf.x + nx - (cx + ox), y: o.tf.y + ny - (cy + oy) };
          }
        }
        copies.forEach(o => S.sel.add(o.id));
      }
    });
  },
  'al-l'() { align((b, s) => [s.minX - b.minX, 0]); },
  'al-hc'() { align((b, s) => [(s.minX + s.maxX) / 2 - (b.minX + b.maxX) / 2, 0]); },
  'al-r'() { align((b, s) => [s.maxX - b.maxX, 0]); },
  'al-t'() { align((b, s) => [0, s.minY - b.minY]); },
  'al-vc'() { align((b, s) => [0, (s.minY + s.maxY) / 2 - (b.minY + b.maxY) / 2]); },
  'al-b'() { align((b, s) => [0, s.maxY - b.maxY]); },
  'dist-h'() { distribute(0); },
  'dist-v'() { distribute(1); },
  center() {
    const b = boundsOf(selected()); if (!b) return;
    const dx = dev().bedW / 2 - (b.minX + b.maxX) / 2, dy = dev().bedH / 2 - (b.minY + b.maxY) / 2;
    edit(() => selected().forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; }));
  },
  topath() {
    const objs = selected().filter(o => o.type !== 'path' && o.type !== 'image');
    if (!objs.length) return msg('Select text or shapes to convert');
    edit(() => objs.forEach(o => { const polys = localPolys(o); o.type = 'path'; o.polys = polys; }));
    msg(`Converted ${objs.length} object(s) to paths`, 'ok');
  },
  break() {
    const objs = selected().filter(o => o.type !== 'image' && localPolys(o).length > 1);
    if (!objs.length) return msg('Select a shape made of several sub-paths');
    edit(() => {
      S.sel.clear();
      for (const o of objs) {
        const polys = worldPolys(o);
        S.objects = S.objects.filter(x => x !== o);
        for (const p of polys) S.sel.add(pathFromWorld([p], { layer: o.layer }).id);
      }
    });
  },
  async join() {
    const objs = selected().filter(o => o.type !== 'image');
    if (!objs.length) return msg('Select the paths to join');
    const v = await formDialog('Auto-join', [{ key: 'tol', label: 'Join gaps up to (mm)', type: 'number', value: 0.1, min: 0 }], { ok: 'Join' });
    if (!v) return;
    const before = objs.reduce((a, o) => a + worldPolys(o).length, 0);
    const polys = joinPaths(objs.flatMap(o => worldPolys(o)), v.tol || 0.1);
    edit(() => {
      const ids = new Set(objs.map(o => o.id));
      S.objects = S.objects.filter(o => !ids.has(o.id));
      S.sel = new Set([pathFromWorld(polys, { layer: objs[0].layer }).id]);
    });
    msg(`Joined ${before} path(s) into ${polys.length}`, 'ok');
  },
  'close-paths'() {
    const objs = selected().filter(o => o.type === 'path' && o.polys.some(p => !p.closed && p.pts.length >= 3));
    if (!objs.length) return msg('No open paths selected');
    edit(() => objs.forEach(o => { o.polys = o.polys.map(p => ({ ...p, closed: p.closed || p.pts.length >= 3 })); }));
  },
  weld() { boolAction('union', 'Weld'); },
  subtract() { boolAction('difference', 'Subtract'); },
  intersect() { boolAction('intersection', 'Intersect'); },
  xor() { boolAction('xor', 'Exclude'); },
  async offset() {
    const objs = selected().filter(o => o.type !== 'image');
    if (!objs.length) return msg('Select shapes to offset');
    const v = await formDialog('Offset shapes', [
      { key: 'dist', label: 'Distance (mm)', type: 'number', value: 2, min: 0 },
      { key: 'dir', label: 'Direction', type: 'select', value: 'out', options: [['out', 'Outward'], ['in', 'Inward'], ['both', 'Both']] },
      { key: 'join', label: 'Corners', type: 'select', value: 'round', options: [['round', 'Round'], ['miter', 'Sharp (miter)'], ['square', 'Bevel']] },
      { key: 'del', label: 'Delete the original', type: 'check', value: false },
    ], { ok: 'Offset' });
    if (!v || !(v.dist > 0)) return;
    try {
      const src = objs.flatMap(o => worldPolys(o));
      const polys = [];
      if (v.dir !== 'in') polys.push(...offsetPolys(src, v.dist, { join: v.join }));
      if (v.dir !== 'out') polys.push(...offsetPolys(src, -v.dist, { join: v.join }));
      if (!polys.length) return msg('Offset produced nothing (shape too small for an inward offset?)', 'err');
      edit(() => {
        if (v.del) { const ids = new Set(objs.map(o => o.id)); S.objects = S.objects.filter(o => !ids.has(o.id)); }
        S.sel = new Set([pathFromWorld(polys, { layer: objs[0].layer, name: 'Offset' }).id]);
      });
    } catch (e) { msg(e.message, 'err'); }
  },
  trace() { traceDialog(); },
  'tool-node'() { setTool('node'); },
  'tool-measure'() { setTool('measure'); },
  fit: zoomFit,
  preview() {
    S.previewOn = !S.previewOn;
    $('#btn-preview').classList.toggle('on', S.previewOn);
    $('#preview-bar').hidden = !S.previewOn;
    if (S.previewOn) buildPreview(); else requestDraw();
  },
  settings: preferencesDialog,
  devices: devicesDialog,
  rotary: rotaryDialog,
  macros: macrosDialog,
  library: libraryDialog,
  'machine-settings': () => machineSettingsDialog(),
  'goto-sel': () => gotoSelection(),
  'user-origin': () => userOriginDialog(),
};
function act(name) { closeMenus(); const f = ACTIONS[name]; if (f) f(); }
$$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));

// Mirror the selection across a line at `deg` (0 = horizontal line, 90 = vertical) through (cx, cy).
// With copy, the originals stay and mirrored copies are added (and selected).
function mirrorSel(deg, { copy = false, at } = {}) {
  const objs = selected(), b = boundsOf(objs); if (!b) return msg('Select something to mirror');
  const [cx, cy] = at || [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  edit(() => {
    const list = copy ? copyObjs(objs, 0, 0) : objs;
    for (const o of list) o.tf = reflectTf(o.tf, deg, cx, cy);
    if (copy) S.sel = new Set(list.map(o => o.id));
  });
}
function mirror(horizontal) { mirrorSel(horizontal ? 90 : 0); }
async function mirrorLineDialog() {
  const b = boundsOf(selected()); if (!b) return msg('Select something to mirror');
  const v = await formDialog('Mirror across a line', [
    { key: 'deg', label: 'Line angle (°) — 0 horizontal, 90 vertical, 45 diagonal', type: 'number', value: settings.mirrorDeg ?? 45 },
    { key: 'through', label: 'Line passes through', type: 'select', value: 'c', options: [['c', 'Centre of selection'], ['l', 'Left edge'], ['r', 'Right edge'], ['t', 'Top edge'], ['b', 'Bottom edge'], ['xy', 'A point (X/Y below, design mm)']] },
    { key: 'x', label: 'Point X', type: 'number', value: r3((b.minX + b.maxX) / 2) },
    { key: 'y', label: 'Point Y', type: 'number', value: r3((b.minY + b.maxY) / 2) },
    { key: 'copy', label: 'Keep the original (mirror a copy)', type: 'check', value: true },
  ], { ok: 'Mirror' });
  if (!v || !Number.isFinite(v.deg)) return;
  settings.mirrorDeg = v.deg; saveSettings();
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const at = { c: [cx, cy], l: [b.minX, cy], r: [b.maxX, cy], t: [cx, b.minY], b: [cx, b.maxY], xy: [v.x, v.y] }[v.through];
  mirrorSel(v.deg, { copy: v.copy, at });
}
// Fillet (round) or chamfer the corners of the selected shapes. Shapes become editable paths.
async function filletDialog(preset = {}) {
  const objs = selected().filter(o => o.type !== 'image');
  if (!objs.length) return msg('Select one or more shapes to round their corners');
  const F = settings.fillet || { style: 'round', radius: 3, minTurn: 10 };
  const v = await formDialog('Fillet / chamfer corners', [
    { key: 'style', label: 'Corner style', type: 'select', value: preset.style || F.style, options: [['round', 'Round (fillet)'], ['chamfer', 'Straight cut (chamfer)']] },
    { key: 'radius', label: 'Radius / chamfer size (mm)', type: 'number', value: F.radius, min: 0.01 },
    { key: 'minTurn', label: 'Skip gentle corners that turn less than (°)', type: 'number', value: F.minTurn, min: 0, max: 179 },
    { key: 'n', type: 'note', label: 'Each corner\'s radius shrinks if the edges next to it are too short. Curves made of many small segments are left alone by the "skip gentle corners" setting. Shapes are converted to paths; Undo restores them.' },
  ], { ok: 'Apply' });
  if (!v || !(v.radius > 0)) return;
  settings.fillet = { style: v.style, radius: v.radius, minTurn: v.minTurn || 0 }; saveSettings();
  let corners = 0;
  edit(() => objs.forEach(o => {
    const r = filletPolys(worldPolys(o), v.radius, { style: v.style, minTurn: v.minTurn || 0 });
    if (!r.corners) return;
    corners += r.corners;
    const b = G.boundsOfPolys(r.polys), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    o.type = 'path';
    o.polys = r.polys.map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x - cx, y - cy]) }));
    o.tf = { x: cx, y: cy, sx: 1, sy: 1, r: 0 };
  }));
  msg(corners ? `${v.style === 'chamfer' ? 'Chamfered' : 'Rounded'} ${corners} corner(s)` : 'No corners sharp enough to change', corners ? 'ok' : '');
}
function rotateSel(deg) {
  const b = boundsOf(selected()); if (!b) return;
  edit(() => applyRotate(origOf(selected()), deg, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2));
}
// Units for align/distribute: groups move together.
function units(objs) {
  const m = new Map();
  for (const o of objs) { const k = o.group || o.id; if (!m.has(k)) m.set(k, []); m.get(k).push(o); }
  return [...m.values()].map(list => ({ list, b: boundsOf(list) }));
}
// The "key" object: the first one selected (with its group). Align/size tools can use it as the reference.
function keyUnit(us) {
  const first = [...S.sel][0];
  return us.find(u => u.list.some(o => o.id === first)) || us[0];
}
const bedBox = () => ({ minX: 0, minY: 0, maxX: dev().bedW, maxY: dev().bedH });
function align(fn) {
  const objs = selected(); if (!objs.length) return msg('Select something to align');
  const us = units(objs);
  const mode = settings.alignTo || 'auto';
  let target, movers = us;
  if (mode === 'bed' || (mode === 'auto' && us.length === 1)) target = bedBox();
  else if (mode === 'key') { const k = keyUnit(us); target = k.b; movers = us.filter(u => u !== k); }
  else target = boundsOf(objs);
  edit(() => movers.forEach(u => { const [dx, dy] = fn(u.b, target); u.list.forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; }); }));
}
const moveUnit = (u, dx, dy) => u.list.forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; });
// Spread centres evenly between the outermost centres.
function distributeCentres(axis) {
  const us = units(selected());
  if (us.length < 3) return msg('Select three or more objects to distribute');
  const c = u => axis ? (u.b.minY + u.b.maxY) / 2 : (u.b.minX + u.b.maxX) / 2;
  us.sort((a, b) => c(a) - c(b));
  const a = c(us[0]), step = (c(us[us.length - 1]) - a) / (us.length - 1);
  edit(() => us.forEach((u, i) => { const d = a + step * i - c(u); moveUnit(u, axis ? 0 : d, axis ? d : 0); }));
}
// Exact gap between neighbours, left-to-right (or top-to-bottom), starting at the first one.
async function spacingDialog() {
  const us = units(selected());
  if (us.length < 2) return msg('Select two or more objects');
  const v = await formDialog('Set spacing', [
    { key: 'axis', label: 'Direction', type: 'select', value: 'h', options: [['h', 'Horizontal (left → right)'], ['v', 'Vertical (top → bottom)']] },
    { key: 'gap', label: 'Gap between objects (mm)', type: 'number', value: settings.gap ?? 5 },
  ], { ok: 'Apply' });
  if (!v || !Number.isFinite(v.gap)) return;
  settings.gap = v.gap; saveSettings();
  const ax = v.axis === 'v', lo = ax ? 'minY' : 'minX', hi = ax ? 'maxY' : 'maxX';
  us.sort((a, b) => a.b[lo] - b.b[lo]);
  edit(() => {
    let pos = us[0].b[lo];
    for (const u of us) { const d = pos - u.b[lo]; moveUnit(u, ax ? 0 : d, ax ? d : 0); pos += u.b[hi] - u.b[lo] + v.gap; }
  });
}
// Make every selected object the same width and/or height as the key (first selected) object.
function sameSize(w, h) {
  const us = units(selected());
  if (us.length < 2) return msg('Select two or more objects (the first one selected sets the size)');
  const k = keyUnit(us), KW = k.b.maxX - k.b.minX, KH = k.b.maxY - k.b.minY;
  edit(() => us.forEach(u => {
    if (u === k) return;
    const W = u.b.maxX - u.b.minX || 1, H = u.b.maxY - u.b.minY || 1;
    applyScale(origOf(u.list), w ? KW / W : 1, h ? KH / H : 1, (u.b.minX + u.b.maxX) / 2, (u.b.minY + u.b.maxY) / 2);
  }));
}
function distribute(axis) {
  const us = units(selected());
  if (us.length < 3) return msg('Select three or more objects to distribute');
  const lo = axis ? 'minY' : 'minX', hi = axis ? 'maxY' : 'maxX';
  us.sort((a, b) => a.b[lo] - b.b[lo]);
  const span = us[us.length - 1].b[hi] - us[0].b[lo], total = us.reduce((s, u) => s + u.b[hi] - u.b[lo], 0);
  const gap = (span - total) / (us.length - 1);
  edit(() => {
    let pos = us[0].b[lo];
    for (const u of us) {
      const d = pos - u.b[lo];
      u.list.forEach(o => { o.tf = axis ? { ...o.tf, y: o.tf.y + d } : { ...o.tf, x: o.tf.x + d }; });
      pos += u.b[hi] - u.b[lo] + gap;
    }
  });
}

// ================================================================ import
$('#file-import').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) await importFile(f);
});
$('#file-open').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await loadProject(JSON.parse(await readFile(f))); msg(`Opened ${f.name}`, 'ok'); } catch (err) { msg(err.message, 'err'); }
});
stage.addEventListener('dragover', e => e.preventDefault());
stage.addEventListener('drop', async e => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    if (/\.bfp$/i.test(f.name)) { try { await loadProject(JSON.parse(await readFile(f))); } catch (err) { msg(err.message, 'err'); } }
    else await importFile(f);
  }
});

async function importFile(f) {
  try {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'svg') importSvg(await readFile(f), f.name);
    else if (ext === 'dxf') importDxf(await readFile(f), f.name);
    else if (ext === 'plt' || ext === 'hpgl') importPlt(await readFile(f), f.name);
    else if (f.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) await importImage(await readFile(f, 'url'), f.name);
    else throw new Error(`Unsupported file type: .${ext}`);
  } catch (err) { msg(`${f.name}: ${err.message}`, 'err'); }
}

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function nearestPalette(cssColor) {
  const m = /rgba?\(([^)]+)\)/.exec(cssColor);
  if (!m) return PALETTE[0];
  const [r, g, b] = m[1].split(',').map(parseFloat);
  let best = PALETTE[0], bd = Infinity;
  for (const p of PALETTE) { const [pr, pg, pb] = hexToRgb(p); const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}

function placeImported(groups, name) { // groups: [{polys(world mm), color, mode}]
  let b = G.emptyBounds();
  for (const g of groups) b = G.boundsOfPolys(g.polys, b);
  if (!G.boundsValid(b)) throw new Error('No usable shapes found');
  const dx = dev().bedW / 2 - (b.minX + b.maxX) / 2, dy = dev().bedH / 2 - (b.minY + b.maxY) / 2;
  const gid = groups.length > 1 ? uid() : undefined;
  edit(() => {
    S.sel.clear();
    for (const g of groups) {
      const L = g.color ? layerForColor(g.color, g.mode) : activeLayer();
      const o = pathFromWorld(g.polys.map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x + dx, y + dy]) })), { name, layer: L.id, group: gid });
      S.sel.add(o.id);
    }
  });
  msg(`Imported ${name}: ${r3(b.maxX - b.minX)} × ${r3(b.maxY - b.minY)} mm`, 'ok');
}

function importSvg(text, name) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = doc.documentElement;
  if (!src || src.nodeName.toLowerCase() !== 'svg') throw new Error('Not a valid SVG');
  const host = el('div', { style: 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' });
  const svg = document.importNode(src, true);
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const badLen = a => !svg.getAttribute(a) || /%$/.test(svg.getAttribute(a));
  if (vb && vb.width && vb.height) {
    if (badLen('width')) svg.setAttribute('width', vb.width);
    if (badLen('height')) svg.setAttribute('height', vb.height);
  }
  host.append(svg); document.body.append(host);
  try {
    const origin = svg.getBoundingClientRect();
    const k = 25.4 / 96; // CSS px -> mm
    const groups = new Map();
    for (const node of svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')) {
      if (node.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
      const cs = getComputedStyle(node);
      if (cs.display === 'none') continue;
      const m = node.getScreenCTM(); if (!m) continue;
      const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * k || 1;
      const tol = 0.15 / scale;
      let polys = [];
      const L = a => node[a].baseVal.value;
      switch (node.tagName.toLowerCase()) {
        case 'path': polys = G.parseSvgPath(node.getAttribute('d') || '', tol); break;
        case 'rect': {
          const w = L('width'), h = L('height'), x = L('x'), y = L('y');
          const rx = node.rx.baseVal.value || node.ry.baseVal.value;
          polys = [{ closed: true, pts: G.rectPts(w, h, rx).map(([a, b]) => [a + x + w / 2, b + y + h / 2]) }]; break;
        }
        case 'circle': { const r = L('r'), cx = L('cx'), cy = L('cy'); polys = [{ closed: true, pts: G.ellipsePts(r, r).map(([a, b]) => [a + cx, b + cy]) }]; break; }
        case 'ellipse': { const cx = L('cx'), cy = L('cy'); polys = [{ closed: true, pts: G.ellipsePts(L('rx'), L('ry')).map(([a, b]) => [a + cx, b + cy]) }]; break; }
        case 'line': polys = [{ closed: false, pts: [[L('x1'), L('y1')], [L('x2'), L('y2')]] }]; break;
        case 'polyline': case 'polygon': polys = [{ closed: node.tagName.toLowerCase() === 'polygon', pts: [...node.points].map(p => [p.x, p.y]) }]; break;
      }
      polys = polys.filter(p => p.pts.length >= 2).map(p => ({
        closed: p.closed,
        pts: p.pts.map(([x, y]) => [(m.a * x + m.c * y + m.e - origin.left) * k, (m.b * x + m.d * y + m.f - origin.top) * k]),
      }));
      if (!polys.length) continue;
      const stroked = cs.stroke && cs.stroke !== 'none';
      const color = nearestPalette(stroked ? cs.stroke : cs.fill);
      const mode = !stroked && cs.fill && cs.fill !== 'none' ? 'fill' : 'line';
      const key = color + mode;
      if (!groups.has(key)) groups.set(key, { polys: [], color, mode });
      groups.get(key).polys.push(...polys);
    }
    placeImported([...groups.values()], name);
  } finally { host.remove(); }
}

function importDxf(text, name) {
  const polys = G.parseDxf(text).map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x, -y]) }));
  if (!polys.length) throw new Error('No supported entities found (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE)');
  placeImported([{ polys, color: null }], name);
}

// HPGL plotter files: PU/PD/PA/PR, 40 plotter units per mm.
function importPlt(text, name) {
  const polys = [];
  let x = 0, y = 0, pen = false, abs = true, cur = null;
  const moveTo = (nx, ny) => {
    if (pen) { if (!cur) { cur = { closed: false, pts: [[x, y]] }; polys.push(cur); } cur.pts.push([nx, ny]); } else cur = null;
    x = nx; y = ny;
  };
  for (const raw of text.split(/[;\n]/)) {
    const c = raw.trim(); if (c.length < 2) continue;
    const op = c.slice(0, 2).toUpperCase();
    const nums = c.slice(2).trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (op === 'PU') { pen = false; cur = null; }
    else if (op === 'PD') pen = true;
    else if (op === 'PA') abs = true;
    else if (op === 'PR') abs = false;
    else continue;
    for (let i = 0; i + 1 < nums.length; i += 2) moveTo(abs ? nums[i] : x + nums[i], abs ? nums[i + 1] : y + nums[i + 1]);
  }
  const mm = polys.filter(p => p.pts.length >= 2).map(p => {
    const pts = p.pts.map(([a, b]) => [a / 40, -b / 40]);
    const f = pts[0], l = pts[pts.length - 1];
    const closed = pts.length > 2 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.01;
    return { closed, pts: closed ? pts.slice(0, -1) : pts };
  });
  if (!mm.length) throw new Error('No pen-down moves found');
  placeImported([{ polys: mm, color: null }], name);
}

async function importImage(src, name) {
  const key = uid();
  const img = await loadImage(key, src);
  let w = img.naturalWidth * 25.4 / 254, h = img.naturalHeight * 25.4 / 254; // assume 254 DPI (0.1 mm/px)
  const k = Math.min(1, dev().bedW * 0.6 / w, dev().bedH * 0.6 / h);
  w *= k; h *= k;
  edit(() => {
    const L = S.layers.find(l => l.mode === 'image') || layerForColor(PALETTE[5], 'image');
    L.mode = 'image';
    const o = addObject({ type: 'image', name, src, imgKey: key, w, h, brightness: 100, contrast: 100, gamma: 1, invert: false, layer: L.id, tf: { x: dev().bedW / 2, y: dev().bedH / 2, sx: 1, sy: 1, r: 0 } });
    S.sel = new Set([o.id]);
  });
  msg(`Imported ${name}: ${r3(w)} × ${r3(h)} mm`, 'ok');
}

// ================================================================ panels
const field = (label, input) => el('label', { class: 'fld' }, el('span', {}, label), input);
const check = (label, input) => el('label', { class: 'fld chk' }, input, el('span', {}, label));
function numInput(value, onset, opts = {}) {
  const i = el('input', { type: 'number', step: opts.step ?? 'any', min: opts.min, max: opts.max, value: value ?? '' });
  i.addEventListener('change', () => { const v = parseFloat(i.value); if (!Number.isNaN(v)) onset(opts.min != null ? Math.max(opts.min, opts.max != null ? Math.min(opts.max, v) : v) : v); });
  return i;
}
function selInput(value, options, onset) {
  const s = el('select', {}, options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value; s.addEventListener('change', () => onset(s.value));
  return s;
}
function chkInput(value, onset) { const c = el('input', { type: 'checkbox', checked: value }); c.addEventListener('change', () => onset(c.checked)); return c; }

function refreshPanels() {
  renderLayers(); renderShape(); renderPalette();
  const n = S.sel.size;
  $('#st-sel').textContent = n ? `${n} selected` : `${S.objects.length} object(s)`;
}

const MODE_LABEL = { line: 'Line', fill: 'Fill', offset: 'Offset fill', image: 'Image' };
function renderLayers() {
  const list = $('#layer-list');
  const counts = new Map();
  for (const o of S.objects) counts.set(o.layer, (counts.get(o.layer) || 0) + 1);
  const cur = activeLayer();
  list.replaceChildren(...S.layers.map((L, i) => {
    const out = chkInput(L.output, v => edit(() => { L.output = v; }));
    out.title = 'Output this layer';
    out.addEventListener('click', ev => ev.stopPropagation());
    const row = el('div', { class: `layer-row${L.id === cur.id ? ' active' : ''}${L.output ? '' : ' off'}`, title: 'Click to edit · new shapes go on the active layer' },
      el('span', { class: 'sw', style: `background:${L.color}` }),
      el('span', { class: 'nm' }, `${L.name} `, el('span', { class: 'muted small' }, `· ${counts.get(L.id) || 0}`)),
      el('span', { class: 'meta' }, `${MODE_LABEL[L.mode]} ${L.speed}mm/s ${L.power}%${L.passes > 1 ? ` ×${L.passes}` : ''}`),
      el('span', { class: 'ord' },
        el('button', { title: 'Move up (runs earlier)', disabled: i === 0, onclick: ev => { ev.stopPropagation(); edit(() => { S.layers.splice(i - 1, 0, S.layers.splice(i, 1)[0]); }); } }, '▲'),
        el('button', { title: 'Move down (runs later)', disabled: i === S.layers.length - 1, onclick: ev => { ev.stopPropagation(); edit(() => { S.layers.splice(i + 1, 0, S.layers.splice(i, 1)[0]); }); } }, '▼')),
      out);
    row.addEventListener('click', () => { S.activeLayer = L.id; refreshPanels(); });
    return row;
  }));

  const L = cur, setL = k => v => edit(() => { L[k] = v; });
  const lib = loadLib();
  const libSel = el('select', {}, el('option', { value: '' }, lib.length ? 'Apply a material preset…' : 'No presets saved yet'),
    lib.map((p, i) => el('option', { value: i }, `${p.material}${p.thickness ? ` ${p.thickness}mm` : ''} — ${p.name}`)));
  libSel.addEventListener('change', () => { const p = lib[+libSel.value]; if (p) { edit(() => Object.assign(L, p.settings)); msg(`Applied "${p.name}"`, 'ok'); } });
  const kids = [
    el('h3', {}, 'Cut settings'),
    el('div', { class: 'row' }, libSel, el('button', { title: 'Save these settings as a material preset', onclick: () => savePresetDialog() }, 'Save')),
    field('Name', (() => { const i = el('input', { value: L.name }); i.addEventListener('change', () => edit(() => { L.name = i.value || L.name; })); return i; })()),
    field('Colour', (() => { const i = el('input', { type: 'color', value: L.color }); i.addEventListener('change', () => edit(() => { L.color = i.value; })); return i; })()),
    field('Mode', selInput(L.mode, [['line', 'Line — follow the outline'], ['fill', 'Fill — scan the inside'], ['offset', 'Offset fill — concentric'], ['image', 'Image — engrave bitmaps']], setL('mode'))),
    field('Speed (mm/s)', numInput(L.speed, setL('speed'), { min: 0.1 })),
    field(L.mode === 'image' ? 'Max power (%)' : 'Power (%)', numInput(L.power, setL('power'), { min: 0, max: 100 })),
    field('Passes', numInput(L.passes, v => edit(() => { L.passes = Math.max(1, Math.round(v)); }), { min: 1, step: 1 })),
    check('Air assist', chkInput(L.air, setL('air'))),
  ];
  if (DEVICE_TYPES[dev().type].power === 'M4') kids.push(check('Constant power (M3) for this layer', chkInput(L.constant, setL('constant'))));
  if (L.mode === 'line') {
    kids.push(el('h3', {}, 'Cutting'),
      field('Kerf offset (mm)', numInput(L.kerf, setL('kerf'), { step: 0.01 })),
      el('div', { class: 'muted small', style: 'margin:-2px 0 2px 120px' }, 'Beam width: parts grow, holes shrink by half this.'),
      check('Tabs / bridges (hold parts in place)', chkInput(L.tabs, setL('tabs'))));
    if (L.tabs) kids.push(field('Tabs per shape', numInput(L.tabCount, setL('tabCount'), { min: 0, step: 1 })),
      field('…or one every (mm)', numInput(L.tabSpacing, setL('tabSpacing'), { min: 0 })),
      field('Tab width (mm)', numInput(L.tabWidth, setL('tabWidth'), { min: 0.05, step: 0.1 })));
    kids.push(check('Perforation (dashed cut)', chkInput(L.perf, setL('perf'))));
    if (L.perf) kids.push(field('Cut length (mm)', numInput(L.perfCut, setL('perfCut'), { min: 0.05 })), field('Skip length (mm)', numInput(L.perfSkip, setL('perfSkip'), { min: 0.05 })));
  }
  if (L.mode !== 'line') {
    kids.push(
      el('h3', {}, L.mode === 'offset' ? 'Offset fill' : 'Scanning'),
      field('Line interval (mm)', numInput(L.interval, setL('interval'), { min: 0.01, step: 0.01 })),
      el('div', { class: 'muted small', style: 'margin:-2px 0 2px 120px' }, `${Math.round(25.4 / L.interval)} lines per inch`));
    if (L.mode !== 'offset') kids.push(field('Overscan (mm)', numInput(L.overscan, setL('overscan'), { min: 0 })), check('Bi-directional scanning', chkInput(L.bidir, setL('bidir'))));
  }
  if (L.mode === 'fill') {
    kids.push(field('Scan angle (°)', numInput(L.angle, setL('angle'))),
      check('Cross-hatch (second pass at +90°)', chkInput(L.crosshatch, setL('crosshatch'))),
      field('Fill shapes', selInput(L.fillGroups, [['all', 'All at once'], ['individual', 'One at a time (less travel)']], setL('fillGroups'))));
  }
  if (L.mode === 'image') {
    kids.push(field('Dither', selInput(L.dither, [['floyd', 'Floyd–Steinberg'], ['jarvis', 'Jarvis'], ['stucki', 'Stucki'], ['atkinson', 'Atkinson'], ['ordered', 'Ordered (Bayer)'], ['halftone', 'Halftone (newsprint)'], ['threshold', 'Threshold'], ['grayscale', 'Grayscale (variable power)']], setL('dither'))));
    if (L.dither === 'grayscale') kids.push(field('Min power (%)', numInput(L.minPower, setL('minPower'), { min: 0, max: 100 })));
    if (L.dither === 'threshold') kids.push(field('Threshold', numInput(L.threshold, setL('threshold'), { min: 1, max: 254, step: 1 })));
    if (L.dither === 'halftone') kids.push(field('Cell size (px)', numInput(L.halftoneCell, setL('halftoneCell'), { min: 2, step: 1 })), field('Screen angle (°)', numInput(L.halftoneAngle, setL('halftoneAngle'))));
  }
  if (dev().zEnabled) {
    kids.push(el('h3', {}, 'Z axis'), field('Z offset (mm)', numInput(L.zOffset, setL('zOffset'))), field('Z step per pass (mm)', numInput(L.zStep, setL('zStep'))));
  }
  const empty = !S.objects.some(o => o.layer === L.id);
  kids.push(el('div', { class: 'row gap' },
    el('button', { onclick: () => { S.sel = new Set(S.objects.filter(o => o.layer === L.id).map(o => o.id)); selectionChanged(); } }, 'Select its shapes'),
    el('button', { disabled: !empty || S.layers.length < 2, title: empty ? 'Delete this empty layer' : 'Only empty layers can be deleted', onclick: () => edit(() => { S.layers = S.layers.filter(x => x !== L); S.activeLayer = S.layers[0].id; }) }, 'Delete layer')));
  $('#layer-edit').replaceChildren(...kids);
}

$('#btn-add-layer').addEventListener('click', () => {
  const free = PALETTE.find(c => !S.layers.some(l => l.color === c)) || PALETTE[S.layers.length % PALETTE.length];
  edit(() => { const L = makeLayer(free); S.layers.push(L); S.activeLayer = L.id; });
});

function renderPalette() {
  const used = new Set(S.layers.map(l => l.color)), actC = activeLayer().color;
  $('#palette').replaceChildren(...PALETTE.map(c => el('button', {
    class: `${used.has(c) ? 'used' : ''}${c === actC ? ' active' : ''}`, style: `background:${c}`, title: S.sel.size ? 'Move selection to this layer' : 'Make this the active layer',
    onclick: () => edit(() => {
      const L = layerForColor(c);
      S.activeLayer = L.id;
      for (const o of selected()) { o.layer = L.id; if (o.type === 'image') L.mode = 'image'; }
    }),
  })));
}

// Icon toolbar for mirror / align / distribute / size / fillet, shown at the top of the Shape tab.
const ICON = {
  'mirror-h': '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L3 18h6zM15 6l6 12h-6z"/>',
  'mirror-v': '<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M6 9L18 3v6zM6 15l12 6v-6z"/>',
  'mirror-copy-h': '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M10 6L4 18h6z"/><path d="M14 6l6 12h-6z" stroke-dasharray="2 1.5"/>',
  'mirror-line': '<path d="M4 20L20 4" stroke-dasharray="2 2"/><path d="M5 5h7v7zM19 19h-7v-7z"/>',
  'al-l': '<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4"/><rect x="7" y="14" width="7" height="4"/>',
  'al-hc': '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4"/><rect x="8" y="14" width="8" height="4"/>',
  'al-r': '<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4"/><rect x="10" y="14" width="7" height="4"/>',
  'al-t': '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12"/><rect x="14" y="7" width="4" height="7"/>',
  'al-vc': '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14"/><rect x="14" y="8" width="4" height="8"/>',
  'al-b': '<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12"/><rect x="14" y="10" width="4" height="7"/>',
  'dist-h': '<path d="M3 4v16M21 4v16"/><rect x="6" y="8" width="4" height="8"/><rect x="14" y="8" width="4" height="8"/>',
  'dist-v': '<path d="M4 3h16M4 21h16"/><rect x="8" y="6" width="8" height="4"/><rect x="8" y="14" width="8" height="4"/>',
  'same-w': '<rect x="4" y="5" width="16" height="5"/><rect x="4" y="14" width="16" height="5"/>',
  'same-h': '<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>',
  fillet: '<path d="M4 20V11a7 7 0 0 1 7-7h9"/>',
  chamfer: '<path d="M4 20V10l6-6h10"/>',
};
const ICON_TITLE = {
  'mirror-h': 'Mirror horizontally', 'mirror-v': 'Mirror vertically', 'mirror-copy-h': 'Mirror copy to the right',
  'mirror-line': 'Mirror across a line…', 'al-l': 'Align left edges', 'al-hc': 'Align centres (horizontally)', 'al-r': 'Align right edges',
  'al-t': 'Align top edges', 'al-vc': 'Align centres (vertically)', 'al-b': 'Align bottom edges',
  'dist-h': 'Distribute horizontally (equal gaps)', 'dist-v': 'Distribute vertically (equal gaps)',
  'same-w': 'Make same width as the first selected', 'same-h': 'Make same height as the first selected',
  fillet: 'Fillet (round) corners…', chamfer: 'Chamfer corners…',
};
function arrangeBar(objs) {
  const btn = k => { const b = el('button', { type: 'button', title: ICON_TITLE[k], onclick: () => act(k) }); b.innerHTML = `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`; return b; };
  const row = (...keys) => el('div', { class: 'iconbar' }, ...keys.map(btn));
  const alignTo = selInput(settings.alignTo || 'auto', [['auto', 'Selection (bed if one object)'], ['selection', 'Selection'], ['key', 'First selected object'], ['bed', 'Bed']],
    v => { settings.alignTo = v; saveSettings(); });
  return el('div', { class: 'arrange' },
    el('div', { class: 'muted small' }, 'Mirror'), row('mirror-h', 'mirror-v', 'mirror-copy-h', 'mirror-line'),
    el('div', { class: 'muted small' }, 'Align'), row('al-l', 'al-hc', 'al-r', 'al-t', 'al-vc', 'al-b'),
    field('Align to', alignTo),
    el('div', { class: 'muted small' }, 'Distribute · size · corners'), row('dist-h', 'dist-v', 'same-w', 'same-h', 'fillet', 'chamfer'));
}

function renderShape() {
  const f = $('#shape-edit');
  const objs = selected();
  if (!objs.length) { f.replaceChildren(el('p', { class: 'muted' }, 'Select a shape to edit its size, position and properties.')); return; }
  const d = dev(), b = boundsOf(objs);
  const right = d.origin === 'tr' || d.origin === 'br', front = d.origin === 'bl' || d.origin === 'br';
  const W = b.maxX - b.minX, H = b.maxY - b.minY;
  const c1 = toMachine(d, b.minX, b.minY), c2 = toMachine(d, b.maxX, b.maxY);
  const mx = Math.min(c1[0], c2[0]), my = Math.min(c1[1], c2[1]);
  const moveTo = (nx, ny) => edit(() => {
    const dx = (nx - mx) * (right ? -1 : 1), dy = (ny - my) * (front ? -1 : 1);
    for (const o of objs) o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy };
  });
  const resize = (nw, nh) => edit(() => {
    const ax = right ? b.maxX : b.minX, ay = front ? b.maxY : b.minY; // keep the corner nearest the machine origin fixed
    applyScale(origOf(objs), Math.max(nw / (W || 1), 1e-4), Math.max(nh / (H || 1), 1e-4), ax, ay);
  });
  const lockBox = chkInput(settings.lockAspect !== false, v => { settings.lockAspect = v; saveSettings(); });
  const grouped = objs.length > 1 && objs.every(o => o.group && o.group === objs[0].group);
  const kids = [
    arrangeBar(objs),
    el('h3', {}, grouped ? `Group of ${objs.length}` : objs.length > 1 ? `${objs.length} objects` : (objs[0].name || objs[0].type)),
    el('div', { class: 'grid2' },
      field('X', numInput(r3(mx), v => moveTo(v, my))),
      field('Y', numInput(r3(my), v => moveTo(mx, v))),
      field('W', numInput(r3(W), v => resize(v, lockBox.checked ? v * H / (W || 1) : H), { min: 0.01 })),
      field('H', numInput(r3(H), v => resize(lockBox.checked ? v * W / (H || 1) : W, v), { min: 0.01 }))),
    check('Lock aspect ratio', lockBox),
  ];
  const sameLayer = objs.every(o => o.layer === objs[0].layer);
  kids.push(field('Layer', selInput(sameLayer ? objs[0].layer : '', S.layers.map(l => [l.id, `${l.name} (${MODE_LABEL[l.mode]})`]), v => edit(() => objs.forEach(o => { o.layer = v; })))));

  if (objs.length === 1) {
    const o = objs[0];
    const setO = k => v => edit(() => { o[k] = v; });
    kids.push(field('Rotation (°)', numInput(r3(o.tf.r), v => edit(() => { o.tf = { ...o.tf, r: ((v % 360) + 360) % 360 }; }))));
    if (o.type === 'rect') kids.push(field('Corner radius', numInput(o.radius || 0, setO('radius'), { min: 0 })));
    if (o.type === 'polygon') {
      kids.push(field('Sides / points', numInput(o.sides, v => edit(() => { o.sides = clamp(Math.round(v), 3, 200); }), { min: 3, step: 1 })));
      kids.push(field('Star depth (0–0.95)', numInput(o.star || 0, v => edit(() => { o.star = clamp(v, 0, 0.95); }), { min: 0, max: 0.95, step: 0.05 })));
    }
    if (o.type === 'text') {
      const ta = el('textarea', { rows: 3 }); ta.value = o.text;
      ta.addEventListener('change', () => edit(() => { o.text = ta.value || ' '; }));
      kids.push(field('Text', ta),
        field('Font', selInput(o.font, FONTS.map(x => [x, x.replace(/"/g, '')]), setO('font'))),
        field('Height (mm)', numInput(o.size, setO('size'), { min: 0.5 })),
        field('Align', selInput(o.align || 'center', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], setO('align'))),
        check('Bold', chkInput(o.bold, setO('bold'))), check('Italic', chkInput(o.italic, setO('italic'))));
      kids.push(el('p', { class: 'muted small' }, /\{/.test(o.text)
        ? `Shows as: “${resolveText(o.text)}”. Next serial: ${settings.serial} (Edit → Preferences).`
        : 'Tip: use {serial}, {date}, {time} for variable text.'));
    }
    if (o.type === 'image') {
      const L = layerById(o.layer);
      kids.push(el('h3', {}, 'Image adjustments'),
        field('Brightness (%)', numInput(o.brightness, setO('brightness'), { min: 0, max: 300, step: 5 })),
        field('Contrast (%)', numInput(o.contrast, setO('contrast'), { min: 0, max: 300, step: 5 })),
        field('Gamma', numInput(o.gamma ?? 1, setO('gamma'), { min: 0.1, max: 5, step: 0.1 })),
        check('Invert (for dark materials / glass)', chkInput(o.invert, setO('invert'))),
        el('p', { class: 'muted small' }, `${getImage(o)?.naturalWidth || '?'}×${getImage(o)?.naturalHeight || '?'} px source · engraves at ${L ? Math.round(25.4 / L.interval) : '?'} DPI`));
    }
    if (o.type === 'path') {
      const n = o.polys.reduce((a, p) => a + p.pts.length, 0), open = o.polys.filter(p => !p.closed).length;
      kids.push(el('p', { class: 'muted small' }, `${o.polys.length} sub-path(s) (${open} open), ${n.toLocaleString()} points`));
    }
  }
  f.replaceChildren(...kids);
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
}));

// ================================================================ preview & job building
function jobOpts() {
  return {
    selectedIds: $('#j-selonly').checked && S.sel.size ? new Set(S.sel) : null,
    startFrom: settings.startFrom, anchor: settings.anchor,
    position: S.m.wpos ? [S.m.wpos[0], S.m.wpos[1]] : [0, 0],
    dryRun: $('#j-dry').checked,
  };
}
const docData = () => ({ layers: S.layers, objects: S.objects });
function checkStart() {
  if (settings.startFrom === 'current' && !S.m.wpos) throw new Error('Connect to the laser first so the current position is known');
  if (settings.startFrom === 'user' && !dev().userOrigin) throw new Error('No user origin set — jog the head to the spot and press "Set user origin" (or Laser → User origin…)');
}
function buildJob() {
  checkStart();
  return generateJob(docData(), dev(), jobOpts());
}
function buildPreview() {
  try {
    const t0 = performance.now();
    S.preview = buildJob();
    const st = S.preview.stats;
    $('#pv-stats').textContent = `Est. ${fmtTime(st.time)} · burn ${r3(st.cutLen / 1000)} m · travel ${r3(st.travelLen / 1000)} m · ${st.lines.toLocaleString()} lines · built in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    S.preview = null; $('#pv-stats').textContent = e.message;
  }
  requestDraw();
}
$('#pv-scrub').addEventListener('input', e => { S.previewT = e.target.value / 1000; requestDraw(); });

// ================================================================ machine
const machine = new Machine(onMachineEvent);
const conLog = $('#con-log');
const rxListeners = new Set();
function log(text, cls = '') {
  const atBottom = conLog.scrollTop + conLog.clientHeight >= conLog.scrollHeight - 4;
  conLog.append(el('div', { class: cls }, text));
  while (conLog.childElementCount > 800) conLog.firstChild.remove();
  if (atBottom) conLog.scrollTop = conLog.scrollHeight;
}

function onMachineEvent(ev) {
  switch (ev.type) {
    case 'server':
      S.m.server = ev.ok;
      $('#st-server').textContent = ev.ok ? 'server ok' : 'server offline';
      $('#st-server').className = 'pill ' + (ev.ok ? 'ok' : 'bad');
      if (ev.ok) refreshPorts();
      break;
    case 'conn':
      S.m.connected = ev.connected; S.m.port = ev.port;
      if (!ev.connected) { S.m.wpos = null; S.m.state = '—'; }
      log(ev.connected ? `Connected to ${ev.port}` : `Disconnected${ev.reason && ev.reason !== 'Disconnected' ? ': ' + ev.reason : ''}`, 'sys');
      updateMachineUI(); requestDraw();
      break;
    case 'status': {
      const moved = !S.m.wpos || S.m.wpos[0] !== ev.wpos?.[0] || S.m.wpos[1] !== ev.wpos?.[1];
      S.m.state = ev.state; S.m.wpos = ev.wpos;
      updateDro();
      if (moved) requestDraw();
      break;
    }
    case 'rx':
      for (const f of rxListeners) f(ev.text);
      log(ev.text, /^(error|ALARM|Error)/.test(ev.text) ? 'err' : '');
      if (/^ALARM/.test(ev.text)) msg(`${ev.text} — use Unlock or Home`, 'err');
      break;
    case 'tx': log('> ' + ev.text, 'tx'); break;
    case 'error': log(ev.text, 'err'); msg(ev.text, 'err'); break;
    case 'job': S.m.job = ev; updateJobUI(); break;
  }
}

function updateDro() {
  $('#m-state').textContent = S.m.state || '—';
  $('#m-x').textContent = S.m.wpos ? S.m.wpos[0].toFixed(2) : '—';
  $('#m-y').textContent = S.m.wpos ? S.m.wpos[1].toFixed(2) : '—';
  const st = $('#m-conn');
  if (S.m.connected) {
    const alarm = /Alarm/i.test(S.m.state);
    st.textContent = alarm ? 'Alarm' : S.m.state || 'Connected';
    st.className = 'pill ' + (alarm ? 'bad' : /Run|Jog|Home/.test(S.m.state) ? 'warn' : 'ok');
  } else { st.textContent = 'Offline'; st.className = 'pill'; }
}
function updateMachineUI() {
  $('#m-connect').textContent = S.m.connected ? 'Disconnect' : 'Connect';
  $('#m-connect').classList.toggle('primary', !S.m.connected);
  for (const id of ['m-home', 'm-unlock', 'm-setorigin', 'm-goorigin', 'm-setuser', 'm-gouser', 'm-gosel', 'm-pulse', 'j-frame', 'j-frame-on', 'j-start-btn', 'j-pause', 'j-resume', 'j-stop'])
    $('#' + id).disabled = !S.m.connected;
  if (isRuida()) { // these are done on the Ruida's own control panel
    for (const id of ['m-unlock', 'm-setorigin', 'm-goorigin', 'm-pulse', 'j-frame-on']) { $('#' + id).disabled = true; $('#' + id).title = 'Use the laser\'s control panel for this on Ruida machines'; }
  }
  $$('[data-jog]').forEach(b => { b.disabled = !S.m.connected; });
  $('#m-port').disabled = $('#m-baud').disabled = S.m.connected;
  renderMacros(); updateDro(); updateJobUI();
}
function updateJobUI() {
  const j = S.m.job;
  const running = j && (j.state === 'running' || j.state === 'paused' || j.state === 'uploading');
  $('#j-bar').style.width = j ? `${(j.acked / j.total) * 100}%` : '0';
  $('#j-start-btn').disabled = !S.m.connected || running;
  if (!j) { $('#j-info').textContent = ''; return; }
  const pct = Math.round(j.acked / j.total * 100);
  const label = { uploading: 'Uploading to laser', running: 'Running', paused: 'Paused', done: 'Finished', stopped: 'Stopped', error: 'Failed' }[j.state];
  $('#j-info').textContent = `${label} · ${pct}% · ${j.acked.toLocaleString()}/${j.total.toLocaleString()} lines · ${fmtTime(j.elapsed)}${j.errors.length ? ` · ${j.errors.length} error(s)` : ''}`;
  if (j.state === 'done' && !j._told) { j._told = true; msg(`Job finished in ${fmtTime(j.elapsed)}`, 'ok'); }
}

async function refreshPorts() {
  try {
    let ports = await machine.ports();
    if (isRuida()) ports = [{ path: `udp:${dev().host}`, label: `Network — ${dev().host || 'set the IP in Laser → Devices'}` }, ...ports];
    const sel = $('#m-port');
    sel.replaceChildren(...ports.map(p => el('option', { value: p.path }, p.label)));
    if (ports.some(p => p.path === dev().port)) sel.value = dev().port;
  } catch { /* server offline */ }
}
function guard(fn) { return async (...a) => { try { await fn(...a); } catch (e) { msg(e.message, 'err'); log(e.message, 'err'); } }; }
const C = () => commands(dev());
const isRuida = () => family(dev()) === 'ruida';

$('#m-refresh').addEventListener('click', refreshPorts);
$('#m-step').value = settings.jogStep;
$('#m-jogf').value = settings.jogF;
$('#m-port').addEventListener('change', e => { dev().port = e.target.value; saveSettings(); });
$('#m-baud').addEventListener('change', e => { dev().baud = e.target.value; saveSettings(); });
$('#m-step').addEventListener('change', e => { settings.jogStep = e.target.value; saveSettings(); });
$('#m-jogf').addEventListener('change', e => { settings.jogF = +e.target.value || 3000; saveSettings(); });
$('#m-connect').addEventListener('click', guard(async () => {
  if (S.m.connected) return machine.disconnect();
  dev().port = $('#m-port').value; saveSettings();
  if (dev().port === 'udp:') throw new Error('Set the controller IP address in Laser → Devices first');
  await machine.connect(dev().port, +$('#m-baud').value, family(dev()), dev().magic);
}));
$$('[data-jog]').forEach(b => b.addEventListener('click', guard(async () => {
  const [r, k] = b.dataset.jog.split(',').map(Number), st = +$('#m-step').value;
  const [dx, dy] = screenToMachineDelta(dev(), r * st, k * st);
  if (isRuida()) {
    if (!S.m.wpos) throw new Error('Position not known yet');
    const d = dev(), H = d.bedH * rotaryScale(d);
    return machine.ruida('goto', { x: clamp(S.m.wpos[0] + dx, 0, d.bedW), y: clamp(S.m.wpos[1] + dy, 0, H) });
  }
  await machine.send(C().jog(dx, dy, +$('#m-jogf').value || 3000));
})));
$('#m-home').addEventListener('click', guard(() => isRuida() ? machine.ruida('home') : machine.send(C().home)));
$('#m-unlock').addEventListener('click', guard(() => machine.send(C().unlock)));
$('#m-setorigin').addEventListener('click', guard(() => machine.send(C().setOrigin)));
$('#m-goorigin').addEventListener('click', guard(() => machine.send(C().goOrigin)));
$('#m-gosel').addEventListener('click', () => gotoSelection());
function setUserOrigin(pt) {
  dev().userOrigin = pt; saveSettings(); changed(); requestDraw();
  msg(pt ? `User origin set to X ${pt[0].toFixed(2)}, Y ${pt[1].toFixed(2)}` : 'User origin cleared', 'ok');
}
$('#m-setuser').addEventListener('click', guard(() => {
  if (!S.m.wpos) throw new Error('Position not known yet');
  setUserOrigin([S.m.wpos[0], S.m.wpos[1]]);
  if (settings.startFrom !== 'user') { settings.startFrom = 'user'; $('#j-start').value = 'user'; saveSettings(); syncAnchor(); }
}));
$('#m-gouser').addEventListener('click', guard(() => {
  const u = dev().userOrigin; if (!u) throw new Error('No user origin set');
  return isRuida() ? machine.ruida('goto', { x: u[0], y: u[1] }) : machine.send(C().goTo(u[0], u[1]));
}));
async function userOriginDialog() {
  const d = dev(), u = d.userOrigin || S.m.wpos || [0, 0];
  const v = await formDialog('User origin', [
    { key: 'x', label: 'X (machine mm)', type: 'number', value: +u[0].toFixed(3) },
    { key: 'y', label: 'Y (machine mm)', type: 'number', value: +u[1].toFixed(3) },
    { key: 'clear', label: 'Clear the user origin', type: 'check', value: false },
    { key: 'n', type: 'note', label: 'With Start from = User origin, the job anchor is placed on this point. Easiest: jog the head to the spot and press "Set user origin". Shown on the bed as a green cross.' },
  ], { ok: 'Save' });
  if (!v) return;
  if (v.clear) return setUserOrigin(null);
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return msg('Enter X and Y', 'err');
  setUserOrigin([v.x, v.y]);
  settings.startFrom = 'user'; $('#j-start').value = 'user'; saveSettings(); syncAnchor();
}
$('#m-pulse').addEventListener('click', guard(async () => {
  for (const step of C().pulse(settings.pulsePower, settings.pulseMs)) {
    if (step.delay) await sleep(step.delay);
    await machine.send(step.lines);
  }
}));
async function gotoSelection() {
  if (!S.m.connected) return msg('Connect to the laser first', 'err');
  const b = boundsOf(selected()); if (!b) return msg('Select something first');
  const [x, y] = mapToMachine(dev(), (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  try { if (isRuida()) await machine.ruida('goto', { x, y }); else await machine.send(C().goTo(x, y)); } catch (e) { msg(e.message, 'err'); }
}

async function machineSettingsDialog() {
  if (!S.m.connected) return msg('Connect to the laser first', 'err');
  if (isRuida()) return msg('Ruida machine settings are changed on the laser\'s control panel (or in LaserWorks/RDWorks).');
  if (family(dev()) !== 'grbl') {
    if (C().settings) {
      await machine.send(C().settings);
      $('.tabs [data-tab="console"]').click();
      msg('Settings printed in the Console. Change them with M-codes (Marlin) or config.txt (Smoothieware).');
    }
    return;
  }
  const found = new Map();
  const listener = t => { const m = /^\$(\d+)=([-\d.]+)/.exec(t); if (m) found.set(+m[1], m[2]); };
  rxListeners.add(listener);
  try { await machine.send('$$'); await sleep(1200); } finally { rxListeners.delete(listener); }
  if (!found.size) return msg('No settings received — is the controller idle?', 'err');
  const keys = [...found.keys()].sort((a, b) => a - b);
  const v = await formDialog('Machine settings (GRBL)', keys.map(k => ({ key: 'k' + k, label: `$${k} ${GRBL_SETTINGS[k] || ''}`, type: 'number', value: found.get(k) })),
    { ok: 'Write changes', note: 'Only changed values are sent. They are stored in the controller.', wide: true });
  if (!v) return;
  const lines = keys.filter(k => Number.isFinite(v['k' + k]) && v['k' + k] !== parseFloat(found.get(k))).map(k => `$${k}=${v['k' + k]}`);
  if (!lines.length) return msg('No changes');
  await machine.send(lines.join('\n'));
  msg(`Wrote ${lines.length} setting(s)`, 'ok');
}

$('#j-start').value = settings.startFrom;
$('#j-anchor').value = settings.anchor;
const syncAnchor = () => { $('#j-anchor-wrap').style.display = settings.startFrom === 'absolute' ? 'none' : ''; requestDraw(); };
syncAnchor();
$('#j-start').addEventListener('change', e => { settings.startFrom = e.target.value; saveSettings(); syncAnchor(); changed(); });
$('#j-anchor').addEventListener('change', e => { settings.anchor = e.target.value; saveSettings(); changed(); });
$('#j-selonly').addEventListener('change', () => changed());

function frameCode(withBeam) {
  const opts = jobOpts();
  checkStart();
  const pts = jobFrame(docData(), dev(), opts, $('#j-rubber').checked);
  return frameGcode(dev(), pts, withBeam ? settings.framePower : 0, +$('#m-jogf').value || 3000);
}
$('#j-frame').addEventListener('click', guard(async () => {
  if (!isRuida()) return machine.send(frameCode(false));
  checkStart();
  const opts = jobOpts();
  await machine.ruida('frame', { pts: jobFrame(docData(), dev(), opts, $('#j-rubber').checked) });
}));
$('#j-frame-on').addEventListener('click', guard(() => machine.send(frameCode(true))));
$('#j-start-btn').addEventListener('click', guard(async () => {
  const job = buildJob();
  const dry = $('#j-dry').checked;
  const ruidaNote = isRuida() && !dry ? ' Ruida support is new and has not been tested on a real machine yet — if you have not done so, cancel and do a Dry run first, then a small test at low power.' : '';
  const ok = await confirmDialog(dry ? 'Start DRY RUN (laser off)?' : 'Start job?',
    `${dev().name}: ${job.stats.lines.toLocaleString()} ${isRuida() ? 'moves' : 'lines'} · estimated ${fmtTime(job.stats.time)}.${dry ? ' The laser will not fire; the head just traces the job.' : ' Make sure the material is in place, the lid is closed and you are wearing laser-safe eyewear. Never leave a running laser unattended.'}${ruidaNote}`, dry ? 'Start dry run' : 'Start');
  if (!ok) return;
  if (isRuida()) await machine.ruidaJob(job.ruida); else await machine.job(job.gcode);
  if (dry) { log('Dry run started (laser off)', 'sys'); return; }
  log(`Job started: ${job.stats.lines} lines`, 'sys');
  if (settings.serialAuto && S.objects.some(o => o.type === 'text' && /\{serial/.test(o.text))) {
    settings.serial += 1; textVars.serial = settings.serial; saveSettings(); changed();
  }
}));
$('#j-pause').addEventListener('click', guard(() => isRuida() ? machine.ruida('pause') : machine.post('job/pause')));
$('#j-resume').addEventListener('click', guard(() => isRuida() ? machine.ruida('resume') : machine.post('job/resume')));
$('#j-stop').addEventListener('click', guard(() => isRuida() ? machine.ruida('stop') : machine.post('job/stop')));
$('#j-dry').addEventListener('change', () => changed());

$('#file-gcode').addEventListener('change', guard(async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const text = await readFile(f);
  const n = text.split('\n').filter(l => l.replace(/;.*|\(.*?\)/g, '').trim()).length;
  if (!(await confirmDialog(`Run ${f.name}?`, `${n.toLocaleString()} commands will be streamed to ${dev().name}. BeamForge can't preview external files — make sure it was made for this machine.`, 'Run'))) return;
  await machine.job(text);
  log(`Job started from file ${f.name}: ${n} lines`, 'sys');
}));

$('#con-form').addEventListener('submit', guard(async e => {
  e.preventDefault();
  const i = $('#con-in'), t = i.value.trim();
  if (!t) return;
  if (isRuida()) await machine.ruida('raw', { text: t });
  else if (t === '?') await machine.realtime('status'); else await machine.send(t);
  i.value = '';
}));
$$('[data-cmd]').forEach(b => b.addEventListener('click', guard(() => isRuida() ? machine.ruida('raw', { text: 'DA 00 04 00' }) : machine.send(b.dataset.cmd))));
$('#con-clear').addEventListener('click', () => conLog.replaceChildren());

// Small debugging handle for the browser console.
window.beamforge = { S, settings, dev, machine, traceDialog, selectDevice, buildJob, addObject, edit, importSvg, importImage, importPlt, act, setTool, makeLayer, layerForColor, PALETTE, selectionChanged, ACTIONS };

// ================================================================ boot
(async function boot() {
  let restored = false;
  try {
    const saved = localStorage.getItem('beamforge.autosave');
    if (saved) { await loadProject(JSON.parse(saved)); restored = S.objects.length > 0; }
  } catch { /* ignore broken autosave */ }
  if (!S.layers.length) newProject();
  deviceChanged(); updateMachineUI(); refreshPanels(); zoomFit();
  if (!restored) $('#hint').textContent = 'Draw with the tools on the left, or Import an SVG, DXF, PLT or image (you can also drag files in).';
})();
