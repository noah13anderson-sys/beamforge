// BeamForge — main UI.
import * as G from './geom.js';
import { worldPolys, worldPath, objBounds, hitObject, localPolys, textVars, resolveText } from './shapes.js';
import { generateJob, jobFrame, frameGcode } from './gcode.js';
import { loadImage, getImage, imageSource, imageFilter, traceImage, makeCanvas, traceSize, traceRaster, traceValues, loopsToLocal, autoTrace } from './raster.js';
import { offset as offsetPolys, boolean as booleanOp, joinPaths, fillet as filletPolys, reflectTf, hull, closeWithin, optimizePolys,
  polysKey, polysInside, samplePath, dockBoxes, breakAt, removeSegment } from './ops.js';
import { openMenu, closeMenu, isMenuOpen, menuAnchor } from './menu.js';
import { DEVICE_TYPES, ORIGINS, GRBL_SETTINGS, isCnc, makeDevice, family, toMachine, mapToMachine, machineToDesign, rotaryScale, commands, screenToMachineDelta } from './devices.js';
import { swizzle } from './ruida.js';
import { qrEncode, qrRects } from './qr.js';
import { CNC_OPS } from './cnc.js';
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
if (settings.csv) { textVars.csv = settings.csv; textVars.csvRow = settings.csvRow || 0; }

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
  undo: [], redo: [], clipboard: null, clipShift: 0, draft: null, cursor: null, node: null, measure: null, flash: null,
};

function layerDefaults(mode = 'line') {
  return {
    mode, output: true, show: true,
    speed: mode === 'line' ? 10 : 120, power: mode === 'line' ? 80 : 35, minPower: 0, passes: 1,
    interval: 0.1, overscan: 2.5, bidir: true, angle: 0, crosshatch: false, air: mode === 'line',
    dither: 'floyd', threshold: 128, halftoneCell: 6, halftoneAngle: 45,
    kerf: 0, overcut: 0, leadIn: 0, tabs: false, tabCount: 4, tabSpacing: 0, tabWidth: 0.5, perf: false, perfCut: 2, perfSkip: 1,
    constant: false, zOffset: 0, zStep: 0, fillGroups: 'all',
    // CNC router settings (used when the device is a CNC router)
    cncOp: 'profile', cncSide: 'outside', toolDia: 3.175, depth: 3, stepDown: 1, feed: 1000, plunge: 300, rpm: 12000,
    stepover: 40, climb: true, cncTabWidth: 6, tabHeight: 1, peck: 0,
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
// Hidden layers (Show off) are not drawn and can't be clicked, but still burn when their Output is on.
const shown = o => layerById(o.layer)?.show !== false;
const visibleObjects = () => S.objects.filter(shown);
// Locked shapes can be selected and copied, but not moved, resized, changed or deleted.
function blockLocked(objs, what = 'changed') {
  const n = objs.filter(o => o.locked).length;
  if (!n) return false;
  msg(`${n === 1 ? 'A locked shape' : `${n} locked shapes`} can't be ${what}. Right-click → Unlock selected shapes first.`, 'err');
  return true;
}
// Move units (a unit = one object or one group) by [unit, dx, dy]; refuses if a locked shape would move.
function moveUnits(moves, what = 'moved') {
  const moving = moves.filter(([, dx, dy]) => Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9);
  if (!moving.length) return false;
  if (blockLocked(moving.flatMap(([u]) => u.list), what)) return false;
  edit(() => moving.forEach(([u, dx, dy]) => moveUnit(u, dx, dy)));
  return true;
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
function zoomToBox(b) {
  const r = stage.getBoundingClientRect(), pad = 48;
  const w = Math.max(b.maxX - b.minX, 0.5), h = Math.max(b.maxY - b.minY, 0.5);
  S.view.s = clamp(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h), 0.05, 400);
  S.view.ox = r.width / 2 - (b.minX + b.maxX) / 2 * S.view.s;
  S.view.oy = r.height / 2 - (b.minY + b.maxY) / 2 * S.view.s;
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
    if (!L || L.show === false) continue;
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
  if (S.flash && S.flash.on) { // "Flash the content on this layer" (shown even when the layer is hidden)
    ctx.strokeStyle = colors.sel; ctx.lineWidth = 3 * px;
    for (const o of S.objects) if (o.layer === S.flash.layer) ctx.stroke(worldPath(o));
  }
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
    const sel = selected(), b = boundsOf(sel);
    if (b) {
      const hp = handlePoints(b), locked = sel.some(o => o.locked);
      ctx.strokeStyle = locked ? colors.muted : colors.sel; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.strokeRect(hp[0][0], hp[0][1], hp[2][0] - hp[0][0], hp[2][1] - hp[0][1]);
      ctx.setLineDash([]);
      if (locked) drawPadlock(hp[1][0] + 3, hp[1][1] - 3); // no handles: locked shapes can't be resized or rotated
      else {
        ctx.beginPath(); ctx.moveTo(hp[4][0], hp[4][1]); ctx.lineTo(hp[8][0], hp[8][1]); ctx.stroke();
        ctx.fillStyle = '#fff';
        hp.forEach(([x, y], i) => {
          ctx.beginPath();
          if (i === 8) ctx.arc(x, y, 5, 0, Math.PI * 2); else ctx.rect(x - 4, y - 4, 8, 8);
          ctx.fill(); ctx.stroke();
        });
      }
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

function drawPadlock(x, y) { // bottom-left corner at x, y (screen px)
  ctx.save();
  ctx.fillStyle = colors.muted; ctx.strokeStyle = colors.muted; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(x + 5, y - 8, 3.2, Math.PI, 0); ctx.stroke();
  ctx.fillRect(x, y - 8, 10, 8);
  ctx.restore();
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
    if (!L || L.show === false) continue;
    if (hitObject(o, x, y, tol, L.mode !== 'line')) return o;
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
  if (e.button === 2) return; // right button: the context menu (no pointer capture, so the menu gets the pointer)
  cv.setPointerCapture(e.pointerId);
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; return;
  }
  if (e.button !== 0 || S.previewOn) return;
  const tool = S.tool;
  if (tool === 'select') {
    const sel = selected(), b = boundsOf(sel);
    if (b && !sel.some(o => o.locked)) { // locked selections have no handles
      const hi = handlePoints(b).findIndex(([hx, hy]) => Math.hypot(hx - e.offsetX, hy - e.offsetY) <= 7);
      if (hi >= 0) { drag = { kind: hi === 8 ? 'rotate' : 'scale', h: hi, b0: b, start: [wx, wy], orig: origOf(sel), moved: false }; return; }
    }
    const hit = hitTest(wx, wy);
    if (hit) {
      const ids = withGroups([hit.id]);
      if (e.shiftKey) { const on = S.sel.has(hit.id); for (const id of ids) on ? S.sel.delete(id) : S.sel.add(id); }
      else if (!S.sel.has(hit.id)) S.sel = ids;
      selectionChanged();
      drag = { kind: 'move', start: [wx, wy], orig: origOf(selected()), moved: false, locked: selected().some(o => o.locked) };
      return;
    }
    if (!e.shiftKey) { S.sel.clear(); selectionChanged(); }
    drag = { kind: 'marquee', start: [wx, wy], cur: [wx, wy] };
    return;
  }
  if (tool === 'node') {
    const nh = nodeHit(e.offsetX, e.offsetY);
    if (nh) {
      S.node = nh; requestDraw();
      const o = S.objects.find(x => x.id === nh.id);
      if (o?.locked) blockLocked([o], 'edited'); else drag = { kind: 'node', ...nh, moved: false };
      return;
    }
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
      const sel = selected(), b = boundsOf(sel);
      const onHandle = b && !sel.some(o => o.locked) && handlePoints(b).some(([hx, hy]) => Math.hypot(hx - e.offsetX, hy - e.offsetY) <= 7);
      const h = onHandle ? null : hitTest(wx, wy);
      cv.style.cursor = spaceDown ? 'grab' : onHandle ? 'crosshair' : h ? (h.locked ? 'default' : 'move') : 'default';
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
      if (drag.locked) { if (!drag.told) { drag.told = true; blockLocked(selected(), 'moved'); } return; }
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
      for (const o of visibleObjects()) {
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
  const [wx, wy] = toWorld(e.offsetX, e.offsetY), h = segmentHit(wx, wy);
  if (h) insertNode(h.o, h.pi, h.i, [wx, wy]); // insert a node on the nearest segment
});

// ---- node editing (polylines: sub-path pi, vertex vi; segment i runs from vertex i-1 to vertex i)
// The line of a selected shape under world point (wx, wy), or null.
function segmentHit(wx, wy) {
  const tol = 6 / S.view.s;
  for (const o of selected()) {
    if (o.type === 'image') continue;
    const polys = worldPolys(o);
    for (let pi = 0; pi < polys.length; pi++) {
      const pts = polys[pi].pts, n = pts.length;
      for (let i = 1; i < n + (polys[pi].closed ? 1 : 0); i++) {
        const a = pts[i - 1], b = pts[i % n];
        if (G.distToSegment(wx, wy, a[0], a[1], b[0], b[1]) <= tol) return { o, pi, i };
      }
    }
  }
  return null;
}
// Geometry edit of one object in its own (local) coordinates; shapes and text become paths.
function nodeEdit(o, fn) {
  if (blockLocked([o], 'edited')) return false;
  edit(() => { ensurePath(o); fn(o); });
  return true;
}
const toLocal = (o, [x, y]) => G.apply(G.invert(G.tfMatrix(o.tf)), x, y);
function insertNode(o, pi, i, world) {
  const local = toLocal(o, world);
  nodeEdit(o, () => {
    o.polys = o.polys.map((p, k) => k !== pi ? p : { closed: p.closed, pts: [...p.pts.slice(0, i), local, ...p.pts.slice(i)] });
    S.node = { id: o.id, pi, vi: i };
  });
}
function breakNode(o, pi, vi) {
  if (o.type === 'path' && !breakAt(o.polys, pi, vi)) return msg('That point is already an end of the path');
  nodeEdit(o, () => { o.polys = breakAt(o.polys, pi, vi) || o.polys; S.node = null; });
}
function deleteSegment(o, pi, i) { // i: segment index as returned by segmentHit
  nodeEdit(o, () => {
    const r = removeSegment(o.polys, pi, i - 1);
    if (r) o.polys = r;
    if (!o.polys.length) S.objects = S.objects.filter(x => x !== o);
    S.node = null;
  });
}
function closeSubpath(o, pi) {
  nodeEdit(o, () => { o.polys = o.polys.map((p, k) => k === pi && p.pts.length >= 3 ? { closed: true, pts: p.pts } : p); });
}
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
  if (blockLocked([o], 'edited')) return true;
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
// Shortcuts follow LightBurn where they don't clash with BeamForge's single-letter tool keys.
const KEYS_MOD = { z: 'undo', y: 'redo', s: 'save', o: 'open', i: 'import', e: 'export', d: 'dup', a: 'select-all', c: 'copy', x: 'cut',
  v: 'paste', g: 'group', u: 'ungroup', pageup: 'order-front', pagedown: 'order-back' };
const KEYS_MOD_SHIFT = { z: 'redo', g: 'ungroup', i: 'invert-sel', c: 'topath', b: 'to-bitmap', h: 'mirror-h', v: 'mirror-v', m: 'mirror-line',
  a: 'zoom-sel', arrowleft: 'al-l', arrowright: 'al-r', arrowup: 'al-t', arrowdown: 'al-b' };
const KEYS_ALT = { p: 'preview', v: 'paste-place', c: 'close-paths', j: 'join', d: 'dedupe', b: 'break', o: 'offset', t: 'trace', i: 'img-adjust' };
const KEYS_ALT_SHIFT = { o: 'optimize', h: 'together-h', v: 'together-v' };
function removeLastPoint() {
  const d = S.draft; if (!d || d.kind !== 'line') return;
  d.pts.pop(); if (!d.pts.length) S.draft = null;
  requestDraw();
}
function zoomBy(k) { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, k); }
window.addEventListener('keydown', e => {
  if (typing()) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const letter = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3).toLowerCase() : k; // keyboard-layout proof for Alt+letter
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openCanvasMenuAtSelection(); return; }
  if (e.key === ' ') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (mod) {
    const name = !e.altKey && ((e.shiftKey && KEYS_MOD_SHIFT[k]) || KEYS_MOD[k]);
    if (name) { e.preventDefault(); act(name); }
    return;
  }
  if (e.altKey) {
    const name = (e.shiftKey ? KEYS_ALT_SHIFT : KEYS_ALT)[letter];
    if (name) { e.preventDefault(); act(name); return; }
    if (!e.key.startsWith('Arrow')) return; // Alt+arrow nudges by 0.1 mm (below)
  }
  if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); act(e.key === 'PageUp' ? 'order-fwd' : 'order-bwd'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (e.key === 'Backspace' && S.draft?.kind === 'line') { removeLastPoint(); return; }
    if (S.tool === 'node' && deleteNode()) return;
    act('del'); return;
  }
  if (e.key === 'Escape') {
    closeMenu();
    if (S.draft) { S.draft = null; requestDraw(); } else if (S.previewOn) act('preview');
    else if (S.tool !== 'select') setTool('select'); else { S.sel.clear(); selectionChanged(); }
    return;
  }
  if (e.key === 'Enter' && S.draft && S.draft.kind === 'line') { finishLine(false); return; }
  if (e.key.startsWith('Arrow') && S.sel.size) {
    e.preventDefault();
    if (blockLocked(selected(), 'moved')) return;
    const st = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
    const dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    edit(() => selected().forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; }));
    return;
  }
  if (S.tool === 'node' && !e.shiftKey) { // node-editing keys, as in LightBurn
    if (k === 'd' && S.node) { deleteNode(); return; }
    if (k === 'b' && S.node) { const o = S.objects.find(x => x.id === S.node.id); if (o) breakNode(o, S.node.pi, S.node.vi); return; }
    if (k === 'i' && S.cursor) { const h = segmentHit(...S.cursor); if (h) insertNode(h.o, h.pi, h.i, S.cursor); return; }
  }
  const tools = { v: 'select', n: 'node', r: 'rect', e: 'ellipse', p: 'polygon', l: 'line', t: 'text', m: 'measure' };
  if (tools[k]) { setTool(tools[k]); return; }
  if (k === 'f') zoomFit();
  else if (k === '+' || k === '=') zoomBy(1.25);
  else if (k === '-' || k === '_') zoomBy(0.8);
});
window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; cv.style.cursor = 'default'; } });

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
    { key: 'safeZ', label: 'CNC: safe Z height for moves (mm above the material)', type: 'number', value: d.safeZ ?? 5, min: 0.5 },
    { key: 'spinUp', label: 'CNC: spindle spin-up wait (s)', type: 'number', value: d.spinUp ?? 3, min: 0 },
    { key: 'probePlate', label: 'CNC: touch plate thickness (mm)', type: 'number', value: d.probePlate ?? 0, min: 0 },
    { key: 'host', label: 'Ruida: controller IP address', value: d.host || '' },
    { key: 'magic', label: 'Ruida: swizzle key', type: 'select', value: String(d.magic ?? 0x88), options: [['136', '0x88 — RDC644x / 654x / 320 (most)'], ['17', '0x11 — RDC634x'], ['56', '0x38 — RDL9635']] },
    { key: 'n', type: 'note', label: 'Max S: GRBL uses $30 (usually 1000). Smoothieware uses 1 (power 0.0–1.0). Marlin uses 255 by default. Changing the controller type resets Max S to its usual value.' },
  ], { ok: 'Save', wide: true });
  if (!v) return false;
  const typeChanged = v.type !== d.type;
  for (const [k, val] of Object.entries(v)) if (!(typeof val === 'number' && Number.isNaN(val))) d[k] = val;
  d.magic = Number(d.magic) || 0x88;
  d.host = String(d.host || '').trim();
  if (typeChanged) { d.sMax = DEVICE_TYPES[d.type].sMax; d.baud = String(DEVICE_TYPES[d.type].baud); if (DEVICE_TYPES[d.type].origin) d.origin = DEVICE_TYPES[d.type].origin; if (isCnc(d)) d.air = 'none'; }
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
// Full-detail traces run in a worker so the dialog stays responsive. run() resolves with loops in raster pixels;
// a newer run() cancels the one in progress (by restarting the worker).
function traceRunner() {
  let w = null, sent = null, job = null, seq = 0, failed = typeof Worker === 'undefined';
  const cancel = why => { const j = job; job = null; j?.reject(Object.assign(new Error(why), { cancelled: true })); };
  const fail = e => { failed = true; console.warn('Trace worker unavailable, tracing on the main thread:', e); w?.terminate(); w = null; cancel('worker failed'); };
  const send = j => { w.postMessage({ id: j.id, key: j.key, W: j.W, H: j.H, opts: j.opts, v: sent === j.key ? null : j.v }); sent = j.key; };
  const spawn = () => {
    try { w = new Worker(new URL('./trace-worker.js', import.meta.url), { type: 'module' }); } catch (e) { fail(e); return false; }
    sent = null;
    w.onerror = e => { e.preventDefault(); fail(e.message || 'could not start'); };
    w.onmessage = ({ data: m }) => {
      if (!job || m.id !== job.id) return;
      if (m.missing) { sent = null; send(job); return; }
      const j = job; job = null;
      if (m.error) j.reject(new Error(m.error)); else j.resolve(unpackLoops(m.xy, m.starts));
    };
    return true;
  };
  return {
    get ok() { return !failed; },
    run(key, v, W, H, opts) {
      if (job) { cancel('superseded'); w?.terminate(); w = null; }
      if (failed || (!w && !spawn())) return Promise.reject(Object.assign(new Error('no worker'), { cancelled: true }));
      return new Promise((resolve, reject) => { job = { id: ++seq, key, v, W, H, opts, resolve, reject }; send(job); });
    },
    stop() { cancel('stopped'); w?.terminate(); w = null; },
  };
}
function unpackLoops(xy, starts) {
  const loops = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const l = new Array(starts[i + 1] - starts[i]);
    for (let j = starts[i], k = 0; j < starts[i + 1]; j++, k++) l[k] = [xy[2 * j], xy[2 * j + 1]];
    loops.push(l);
  }
  return loops;
}

const TRACE_QUICK_PX = 700; // longest side of the instant (reduced-detail) preview
function traceDialog() {
  const o = selected().find(x => x.type === 'image');
  if (!o) return msg('Select an image to trace');
  const prefs = { mode: 'brightness', cutoff: 0, threshold: 128, edge: 60, ignore: 6, optimize: 0.6, smooth: 0.4, res: 10, fade: true, del: false, ...(settings.trace || {}) };
  const dlg = $('#dlg'), form = $('#dlg-form'), runner = traceRunner();
  const cvs = el('canvas', { class: 'trace-cv', tabindex: 0, 'aria-label': 'Trace preview',
    title: 'Scroll to zoom, drag to move around, double-click to zoom in or back out. Keys: + − 0 and arrows.' });
  const info = el('span', { class: 'info muted small' }, 'Tracing…');
  const note = el('p', { class: 'small auto-note', hidden: true });
  const zoomLbl = el('span', { class: 'zl muted small', title: 'Zoom (1× shows the whole picture)' }, '1×');

  // ---- settings
  const set = {}; // key → update the control after Auto trace
  const slider = (key, label, min, max, step) => {
    const val = el('span', { class: 'muted small', style: 'min-width:34px;text-align:right' }, String(prefs[key]));
    const i = el('input', { type: 'range', min, max, step, value: prefs[key] });
    i.addEventListener('input', () => { prefs[key] = +i.value; val.textContent = i.value; changed(); });
    set[key] = v => { i.value = v; prefs[key] = +i.value; val.textContent = i.value; };
    return el('label', { class: 'fld', 'data-for': key }, el('span', {}, label), el('div', { class: 'row' }, i, val));
  };
  const modeSel = selInput(prefs.mode, [['brightness', 'Brightness'], ['sketch', 'Sketch — trace edges'], ['transparency', 'Transparency (PNG alpha)']], v => { prefs.mode = v; sync(); changed(); });
  set.mode = v => { modeSel.value = v; prefs.mode = modeSel.value; };
  const fade = chkInput(prefs.fade, v => { prefs.fade = v; requestDraw(); });
  const del = chkInput(prefs.del, v => { prefs.del = v; });
  const rows = {
    cutoff: slider('cutoff', 'Cutoff', 0, 255, 1), threshold: slider('threshold', 'Threshold', 0, 255, 1),
    edge: slider('edge', 'Edge sensitivity', 1, 254, 1),
  };
  const sync = () => {
    rows.cutoff.style.display = rows.threshold.style.display = prefs.mode === 'brightness' ? '' : 'none';
    rows.edge.style.display = prefs.mode === 'sketch' ? '' : 'none';
  };

  // ---- tracing: an instant reduced-detail preview here, then the exact full-detail result from the worker
  const key = () => [prefs.mode, prefs.cutoff, prefs.threshold, prefs.edge, prefs.ignore, prefs.optimize, prefs.smooth, prefs.res].join('|');
  let quick = null, full = null, fullErr = false, timer = 0, fullTimer = 0, raf = 0;
  const rasters = new Map(); // pixel values per channel and size
  const raster = (mode, W, H) => {
    const k = `${mode === 'transparency' ? 'a' : 'g'}|${W}x${H}`;
    let v = rasters.get(k);
    if (!v) {
      v = traceRaster(o, mode, W, H);
      if (rasters.size >= 4) rasters.delete(rasters.keys().next().value);
      rasters.set(k, v);
    }
    return { k, v };
  };
  const result = (k, loops, W, H) => {
    const box = new Float32Array(loops.length * 4);
    let pts = 0;
    loops.forEach((l, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of l) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      box[i * 4] = x0; box[i * 4 + 1] = y0; box[i * 4 + 2] = x1; box[i * 4 + 3] = y1;
      pts += l.length;
    });
    return { key: k, loops, W, H, box, pts };
  };
  const exact = () => full && full.key === key();
  const shown = () => (exact() ? full : quick);
  const status = () => {
    const r = shown();
    if (!r) return;
    const n = r.loops.length;
    info.textContent = `${n.toLocaleString()} shape${n === 1 ? '' : 's'} · ${r.pts.toLocaleString()} points`
      + (exact() ? '' : runner.ok && !fullErr ? ' · refining…' : ' · reduced-detail preview');
  };
  const syncFull = () => {
    const k = key(), [W, H] = traceSize(o, prefs.res);
    try { full = result(k, traceValues(raster(prefs.mode, W, H).v, W, H, { ...prefs, unit: 1 }), W, H); } catch (e) { info.textContent = e.message; return; }
    status(); requestDraw();
  };
  // Without a worker the full trace blocks, so it only runs once you zoom in.
  const requestFull = (ms = 150) => {
    clearTimeout(fullTimer);
    fullTimer = setTimeout(() => {
      if (exact()) return;
      const k = key(), [W, H] = traceSize(o, prefs.res);
      if (!runner.ok) { if (view.z > 1.5) syncFull(); return; }
      let rv;
      try { rv = raster(prefs.mode, W, H); } catch (e) { info.textContent = e.message; return; }
      runner.run(rv.k, rv.v, W, H, { ...prefs, unit: 1 }).then(loops => {
        if (k !== key()) return; // the settings have moved on
        full = result(k, loops, W, H); status(); requestDraw();
      }, e => {
        if (!e.cancelled) { fullErr = true; status(); console.warn(e); }
        if (!runner.ok && view.z > 1.5 && k === key()) syncFull();
      });
    }, ms);
  };
  const runQuick = () => {
    const k = key(), [W0, H0] = traceSize(o, prefs.res), [W, H] = traceSize(o, prefs.res, TRACE_QUICK_PX);
    fullErr = false;
    quick = result(k, traceValues(raster(prefs.mode, W, H).v, W, H, { ...prefs, unit: W0 / W }), W, H);
    if (W === W0 && H === H0) full = quick; // small image: the preview is already full detail
    else requestFull();
    status(); requestDraw();
  };
  const schedule = (ms = 120) => { clearTimeout(timer); timer = setTimeout(() => { try { runQuick(); } catch (e) { info.textContent = e.message; } }, ms); };
  const changed = () => { note.hidden = true; schedule(); };

  // ---- preview: zoom and pan
  const view = { z: 1, cx: 0, cy: 0 }; // zoom (1 = whole image) and the mm point (from the image centre) in the middle
  let moved = false; // hide the how-to-zoom hint once the view has been zoomed or moved
  const dpr = () => window.devicePixelRatio || 1;
  let pic = null;
  const picture = () => { // the picture with its adjustments, drawn once
    if (pic) return pic;
    const img = imageSource(o);
    if (!img) return null;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, s = Math.min(1, 4096 / Math.max(iw, ih));
    const c = makeCanvas(Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s))), g = c.getContext('2d');
    g.filter = imageFilter(o); g.drawImage(img, 0, 0, c.width, c.height);
    return (pic = c);
  };
  const fitK = () => Math.min(cvs.width / o.w, cvs.height / o.h) * 0.96; // device px per mm at "Fit"
  const maxZoom = () => clamp(40 * (traceSize(o, prefs.res)[0] / o.w) / fitK(), 4, 400); // ~40 px per trace pixel
  const clampView = () => { // keep the middle of the view on the picture; at 1× show it all, centred
    view.z = clamp(view.z, 1, maxZoom());
    if (view.z < 1.0001) view.cx = view.cy = 0;
    else { view.cx = clamp(view.cx, -o.w / 2, o.w / 2); view.cy = clamp(view.cy, -o.h / 2, o.h / 2); }
    zoomLbl.textContent = `${view.z < 10 ? Math.round(view.z * 10) / 10 : Math.round(view.z)}×`;
  };
  const draw = () => {
    raf = 0;
    const g = cvs.getContext('2d'), Wc = cvs.width, Hc = cvs.height;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff'; g.fillRect(0, 0, Wc, Hc);
    if (Wc < 2 || Hc < 2) return;
    const k = fitK() * view.z, x0 = Wc / 2 - (view.cx + o.w / 2) * k, y0 = Hc / 2 - (view.cy + o.h / 2) * k;
    const p = picture();
    if (p) {
      g.save(); g.globalAlpha = prefs.fade ? 0.3 : 1;
      g.imageSmoothingEnabled = o.w * k / p.width < 3; // big zoom: show the real pixels
      g.drawImage(p, x0, y0, o.w * k, o.h * k); g.restore();
    }
    g.strokeStyle = 'rgba(0,0,0,.2)'; g.lineWidth = 1;
    g.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(o.w * k) + 1, Math.round(o.h * k) + 1);
    const r = shown();
    if (r) {
      const sx = o.w * k / r.W, sy = o.h * k / r.H;
      const vx0 = -x0 / sx, vy0 = -y0 / sy, vx1 = (Wc - x0) / sx, vy1 = (Hc - y0) / sy; // the visible part, in trace pixels
      g.strokeStyle = '#e5484d'; g.lineWidth = 1.25 * dpr(); g.lineJoin = 'round'; g.beginPath();
      r.loops.forEach((l, i) => {
        const b = i * 4;
        if (r.box[b + 2] < vx0 || r.box[b] > vx1 || r.box[b + 3] < vy0 || r.box[b + 1] > vy1) return;
        for (let j = 0; j < l.length; j++) { const X = x0 + l[j][0] * sx, Y = y0 + l[j][1] * sy; if (j) g.lineTo(X, Y); else g.moveTo(X, Y); }
        g.closePath();
      });
      g.stroke();
    }
    if (!moved) { // until the first zoom or move: say how
      const d = dpr(), text = 'Scroll to zoom  ·  drag to move  ·  double-click to zoom in';
      g.font = `${12 * d}px system-ui, sans-serif`;
      const w = g.measureText(text).width + 18 * d, h = 26 * d, x = 10 * d, y = Hc - h - 10 * d;
      g.fillStyle = 'rgba(22,24,28,.75)'; g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, 6 * d); else g.rect(x, y, w, h);
      g.fill(); g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, x + 9 * d, y + h / 2);
    }
  };
  const requestDraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const zoomAt = (px, py, f) => { // px, py: device pixels on the canvas; keeps that point still
    const k0 = fitK() * view.z, wx = view.cx + (px - cvs.width / 2) / k0, wy = view.cy + (py - cvs.height / 2) / k0;
    view.z = clamp(view.z * f, 1, maxZoom());
    moved = true;
    const k1 = fitK() * view.z;
    view.cx = wx - (px - cvs.width / 2) / k1; view.cy = wy - (py - cvs.height / 2) / k1;
    clampView(); requestDraw();
    if (view.z > 1.5 && !exact() && !runner.ok) requestFull(300);
  };
  const zoomStep = f => zoomAt(cvs.width / 2, cvs.height / 2, f);
  const fit = () => { view.z = 1; view.cx = view.cy = 0; clampView(); requestDraw(); };
  const pan = (dx, dy) => { const k = fitK() * view.z; view.cx += dx * cvs.width / 6 / k; view.cy += dy * cvs.height / 6 / k; moved = true; clampView(); requestDraw(); };
  const devXY = e => { const r = cvs.getBoundingClientRect(), d = dpr(); return [(e.clientX - r.left) * d, (e.clientY - r.top) * d]; };
  let drag = null;
  cvs.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = devXY(e); zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015))); }, { passive: false });
  cvs.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    cvs.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
    cvs.classList.add('panning');
  });
  cvs.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = fitK() * view.z / dpr();
    view.cx = drag.cx - (e.clientX - drag.x) / k; view.cy = drag.cy - (e.clientY - drag.y) / k;
    if (view.z > 1.0001) moved = true;
    clampView(); requestDraw();
  });
  const endDrag = e => { if (drag && drag.id === e.pointerId) { drag = null; cvs.classList.remove('panning'); } };
  cvs.addEventListener('pointerup', endDrag);
  cvs.addEventListener('pointercancel', endDrag);
  cvs.addEventListener('dblclick', e => { if (view.z > 1.01) fit(); else { const [x, y] = devXY(e); zoomAt(x, y, 4); } });
  cvs.addEventListener('keydown', e => {
    const f = { '+': () => zoomStep(1.5), '=': () => zoomStep(1.5), '-': () => zoomStep(1 / 1.5), '_': () => zoomStep(1 / 1.5), 0: fit,
      ArrowLeft: () => pan(-1, 0), ArrowRight: () => pan(1, 0), ArrowUp: () => pan(0, -1), ArrowDown: () => pan(0, 1) }[e.key];
    if (f && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); f(); }
  });
  const ro = new ResizeObserver(() => {
    const d = dpr(), W = Math.max(1, Math.round(cvs.clientWidth * d)), H = Math.max(1, Math.round(cvs.clientHeight * d));
    if (cvs.width !== W || cvs.height !== H) { cvs.width = W; cvs.height = H; clampView(); draw(); }
  });

  // ---- Auto trace: look at the picture and choose the settings
  const AUTO_KEYS = ['mode', 'cutoff', 'threshold', 'edge', 'ignore', 'optimize', 'smooth', 'res'];
  const describe = a => {
    const what = a.mode === 'transparency' ? 'the outline of the non-transparent parts'
      : a.mode === 'sketch' ? `edges, sensitivity ${a.edge}`
        : a.lightBg ? `dark shapes on a light background (threshold ${a.threshold})` : `light shapes on a dark background (cutoff ${a.cutoff})`;
    return `Auto trace: ${what}${a.noisy ? `; specks under ${a.ignore} px² left out` : ''}.`
      + (a.photo && a.mode === 'brightness' ? ' This looks like a photo, so the result is a two-tone stencil; Sketch mode traces outlines instead.' : '')
      + ' Adjust anything, then press Trace.';
  };
  const autoBtn = el('button', { type: 'button', class: 'auto-btn', title: 'Look at the picture and choose the mode, threshold and clean-up settings for it' }, 'Auto trace');
  autoBtn.addEventListener('click', () => {
    autoBtn.disabled = true; info.textContent = 'Looking at the picture…';
    requestAnimationFrame(() => setTimeout(() => { // let the message show first
      autoBtn.disabled = false;
      let a;
      try { a = autoTrace(o, prefs, (mode, W, H) => raster(mode, W, H).v); } catch (e) { info.textContent = e.message; return; }
      note.hidden = false; note.classList.toggle('warn', !!a.none);
      if (a.none) {
        note.textContent = a.none === 'flat' ? 'Auto trace: this picture is all one shade, so there is nothing to trace.'
          : 'Auto trace: the picture is too faint to separate shapes from the background. Raise its contrast with Adjust image (Alt+I) first.';
        status(); return;
      }
      for (const k of AUTO_KEYS) if (a[k] != null) set[k](a[k]);
      note.textContent = describe({ ...a, ...prefs, lightBg: a.lightBg });
      sync(); schedule(0);
    }, 0));
  });

  form.replaceChildren(el('h2', {}, 'Trace image'),
    el('div', { class: 'trace-body' },
      el('div', { class: 'trace-view' }, cvs,
        el('div', { class: 'trace-bar' }, info,
          el('button', { type: 'button', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => zoomStep(1 / 1.5) }, '−'),
          zoomLbl,
          el('button', { type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoomStep(1.5) }, '+'),
          el('button', { type: 'button', title: 'Show the whole picture (0)', onclick: fit }, 'Fit'))),
      el('div', { class: 'trace-side' }, autoBtn, note,
        el('div', { class: 'scroll' },
          field('Mode', modeSel), rows.cutoff, rows.threshold, rows.edge,
          slider('ignore', 'Ignore less than (px²)', 0, 400, 1), slider('smooth', 'Smoothness', 0, 1, 0.05),
          slider('optimize', 'Optimize (px)', 0.05, 3, 0.05), slider('res', 'Detail (px/mm)', 2, 30, 1),
          check('Fade image in preview', fade), check('Delete the image after tracing', del)))),
    el('div', { class: 'actions' },
      el('button', { value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
      el('button', { value: 'ok', type: 'submit', class: 'primary' }, 'Trace')));
  sync();
  dlg.onclose = () => {
    clearTimeout(timer); clearTimeout(fullTimer); cancelAnimationFrame(raf); ro.disconnect(); runner.stop();
    dlg.classList.remove('trace-dlg');
    settings.trace = { ...prefs }; saveSettings();
    if (dlg.returnValue !== 'ok') return;
    try {
      const polys = exact() ? loopsToLocal(full.loops, o, full.W, full.H) : traceImage(o, prefs).polys;
      if (!polys.length) return msg('Nothing found with those settings', 'err');
      edit(() => {
        const L = activeLayer().mode === 'image' ? (S.layers.find(l => l.mode !== 'image') || layerForColor(PALETTE[1])) : activeLayer();
        const p = addObject({ type: 'path', name: 'Traced ' + (o.name || 'image'), polys, layer: L.id, tf: { ...o.tf } });
        if (prefs.del && !o.locked) S.objects = S.objects.filter(x => x !== o); // a locked image is kept
        S.sel = new Set([p.id]);
      });
      msg(`Traced ${polys.length} shape(s)`, 'ok');
    } catch (e) { msg(e.message, 'err'); }
  };
  dlg.classList.add('trace-dlg');
  dlg.returnValue = '';
  dlg.showModal();
  ro.observe(cvs);
  schedule(0);
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
  if (blockLocked(objs, 'changed')) return;
  try {
    const groups = objs.map(o => worldPolys(o));
    const polys = op === 'union' ? booleanOp('union', groups) : booleanOp(op, [groups[0]], groups.slice(1));
    replaceWithResult(objs, polys, label);
  } catch (e) { msg(e.message, 'err'); }
}
// Copies are never locked, and land on the active layer if their own layer has been deleted since copying.
function copyObjs(list, dx, dy) {
  const regroup = new Map();
  return list.map(({ locked, ...c }) => {
    const g = c.group ? (regroup.get(c.group) || regroup.set(c.group, uid()).get(c.group)) : undefined;
    return addObject({ ...c, id: undefined, group: g, layer: layerById(c.layer) ? c.layer : activeLayer().id, tf: { ...c.tf, x: c.tf.x + dx, y: c.tf.y + dy } });
  });
}
function pasteAt([x, y]) {
  const b = boundsOf(S.clipboard); if (!b) return;
  const dx = x - (b.minX + b.maxX) / 2, dy = y - (b.minY + b.maxY) / 2;
  edit(() => { S.sel = new Set(copyObjs(S.clipboard, dx, dy).map(o => o.id)); });
}

// ================================================================ generators & production tools
const hslHex = (h, s, l) => {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
};

// QR code as a filled path (dark modules welded into clean outlines), placed at the centre of the view.
async function qrDialog() {
  const Q = settings.qr || { text: 'https://example.com', size: 30, ecl: 'M', quiet: false };
  const v = await formDialog('QR code', [
    { key: 'text', label: 'Text or link', type: 'textarea', value: Q.text },
    { key: 'size', label: 'Size (mm)', type: 'number', value: Q.size, min: 5 },
    { key: 'ecl', label: 'Error correction', type: 'select', value: Q.ecl, options: [['L', 'Low (7%) — smallest'], ['M', 'Medium (15%)'], ['Q', 'Quartile (25%)'], ['H', 'High (30%) — survives damage']] },
    { key: 'quiet', label: 'Add a quiet-zone border frame (helps scanning on busy material)', type: 'check', value: Q.quiet },
    { key: 'n', type: 'note', label: 'The code goes on the active layer; use a Fill layer to engrave it. Variable text like {serial} is filled in now. Engrave dark modules on light material (or invert the material).' },
  ], { ok: 'Create' });
  if (!v || !v.text) return;
  settings.qr = { text: v.text, size: v.size || 30, ecl: v.ecl, quiet: v.quiet }; saveSettings();
  let q;
  try { q = qrEncode(resolveText(v.text), { ecl: v.ecl }); } catch (e) { return msg(e.message, 'err'); }
  const m = settings.qr.size / q.size, c = viewCentre();
  const x0 = c[0] - settings.qr.size / 2, y0 = c[1] - settings.qr.size / 2;
  const rects = qrRects(q).map(([x, y, w, h]) => [{ closed: true, pts: [[x0 + x * m, y0 + y * m], [x0 + (x + w) * m, y0 + y * m], [x0 + (x + w) * m, y0 + (y + h) * m], [x0 + x * m, y0 + (y + h) * m]] }]);
  const polys = booleanOp('union', rects);
  if (v.quiet) {
    const z = 4 * m, t = Math.max(m / 2, 0.3);
    polys.push(...booleanOp('difference', [[rectPoly(x0 - z - t, y0 - z - t, settings.qr.size + 2 * (z + t), settings.qr.size + 2 * (z + t))]], [[rectPoly(x0 - z, y0 - z, settings.qr.size + 2 * z, settings.qr.size + 2 * z)]]));
  }
  edit(() => { const o = pathFromWorld(polys, { name: `QR: ${v.text.slice(0, 30)}` }); S.sel = new Set([o.id]); });
  msg(`QR code version ${q.version} (${q.size}×${q.size} modules, ${r3(m)} mm each)${m < 0.4 ? ' — modules are very small; make it bigger if it will not scan' : ''}`, m < 0.4 ? 'err' : 'ok');
}
const rectPoly = (x, y, w, h) => ({ closed: true, pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
function viewCentre() {
  const r = $('#cv').getBoundingClientRect();
  try { return toWorld(r.width / 2, r.height / 2); } catch { return [dev().bedW / 2, dev().bedH / 2]; }
}

// Material test: a grid of squares, each on its own layer with its own speed/power, plus labels.
async function materialTestDialog() {
  const T = settings.mtest || { mode: 'fill', pMin: 10, pMax: 100, sMin: 50, sMax: 300, cols: 5, rows: 5, cell: 10, gap: 3, labels: true, lp: 20, ls: 150, passes: 1, interval: 0.1 };
  const v = await formDialog('Material test', [
    { key: 'mode', label: 'Test type', type: 'select', value: T.mode, options: [['fill', 'Fill (engraving)'], ['line', 'Line (cutting / scoring)']] },
    { key: 'pMin', label: 'Power from (%)', type: 'number', value: T.pMin, min: 0, max: 100 },
    { key: 'pMax', label: 'Power to (%)', type: 'number', value: T.pMax, min: 0, max: 100 },
    { key: 'cols', label: 'Power steps (columns)', type: 'number', value: T.cols, min: 1, max: 12, step: 1 },
    { key: 'sMin', label: 'Speed from (mm/s)', type: 'number', value: T.sMin, min: 0.1 },
    { key: 'sMax', label: 'Speed to (mm/s)', type: 'number', value: T.sMax, min: 0.1 },
    { key: 'rows', label: 'Speed steps (rows)', type: 'number', value: T.rows, min: 1, max: 12, step: 1 },
    { key: 'passes', label: 'Passes', type: 'number', value: T.passes, min: 1, step: 1 },
    { key: 'interval', label: 'Fill line interval (mm)', type: 'number', value: T.interval, min: 0.01 },
    { key: 'cell', label: 'Square size (mm)', type: 'number', value: T.cell, min: 2 },
    { key: 'gap', label: 'Gap between squares (mm)', type: 'number', value: T.gap, min: 0 },
    { key: 'labels', label: 'Engrave labels (power across the top, speed down the side)', type: 'check', value: T.labels },
    { key: 'lp', label: 'Label power (%)', type: 'number', value: T.lp, min: 0, max: 100 },
    { key: 'ls', label: 'Label speed (mm/s)', type: 'number', value: T.ls, min: 0.1 },
    { key: 'n', type: 'note', label: 'Adds one layer per square to this project (named with its settings), placed at the top-left of the bed. Frame it, run it, then pick the best square and save it to the Material library. Delete the test layers afterwards.' },
  ], { ok: 'Create test', wide: true });
  if (!v) return;
  const cols = clamp(Math.round(v.cols) || 1, 1, 12), rows = clamp(Math.round(v.rows) || 1, 1, 12);
  settings.mtest = { ...v, cols, rows }; saveSettings();
  const lerp = (a, b, i, n) => n > 1 ? a + (b - a) * i / (n - 1) : a;
  const cell = v.cell || 10, gap = v.gap ?? 3, ts = Math.max(1.5, Math.min(cell * 0.35, 5));
  const left = 5 + (v.labels ? ts * 3.2 : 0), top = 5 + (v.labels ? ts * 2 : 0);
  edit(() => {
    const ids = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const power = Math.round(lerp(v.pMin, v.pMax, c, cols)), speed = +lerp(v.sMin, v.sMax, r, rows).toFixed(1);
      const L = { ...makeLayer(hslHex((r * cols + c) * 137.508 % 360, 65, 45), v.mode), name: `Test P${power}% S${speed}`, power, speed, passes: Math.max(1, Math.round(v.passes) || 1), interval: v.interval || 0.1, air: v.mode === 'line' };
      S.layers.push(L);
      ids.push(addObject({ type: 'rect', w: cell, h: cell, radius: 0, layer: L.id, name: L.name, tf: { x: left + c * (cell + gap) + cell / 2, y: top + r * (cell + gap) + cell / 2, sx: 1, sy: 1, r: 0 } }).id);
    }
    if (v.labels) {
      const LL = { ...makeLayer('#404a57', 'fill'), name: 'Test labels', power: v.lp, speed: v.ls, interval: 0.1, air: false };
      S.layers.push(LL);
      const txt = (text, x, y) => ids.push(addObject({ type: 'text', text, font: 'sans-serif', size: ts, bold: true, italic: false, align: 'center', layer: LL.id, tf: { x, y, sx: 1, sy: 1, r: 0 } }).id);
      for (let c = 0; c < cols; c++) txt(`${Math.round(lerp(v.pMin, v.pMax, c, cols))}`, left + c * (cell + gap) + cell / 2, top - ts * 0.9);
      for (let r = 0; r < rows; r++) txt(`${+lerp(v.sMin, v.sMax, r, rows).toFixed(1)}`, left - ts * 1.7, top + r * (cell + gap) + cell / 2);
      txt('%', left - ts * 1.7, top - ts * 0.9);
    }
    S.sel = new Set(ids);
  });
  msg(`Material test: ${rows * cols} squares (power ${v.pMin}→${v.pMax}% across, speed ${v.sMin}→${v.sMax} mm/s down)`, 'ok');
}

// Pack objects onto the bed in rows (bounding-box nesting). Groups stay together.
async function packDialog() {
  const objs = S.sel.size ? selected() : S.objects;
  if (!objs.length) return msg('Nothing to pack');
  if (blockLocked(objs, 'moved')) return;
  const P = settings.pack || { gap: 3, margin: 5, rotate: true };
  const v = await formDialog('Pack onto the bed', [
    { key: 'gap', label: 'Gap between parts (mm)', type: 'number', value: P.gap, min: 0 },
    { key: 'margin', label: 'Margin from the bed edge (mm)', type: 'number', value: P.margin, min: 0 },
    { key: 'rotate', label: 'Turn tall parts on their side to save space', type: 'check', value: P.rotate },
    { key: 'n', type: 'note', label: `${S.sel.size ? 'Packs the selected objects' : 'Nothing is selected, so this packs everything'} into rows from the top-left of the bed, tallest first. It uses each part's bounding box (fast, not true-shape nesting).` },
  ], { ok: 'Pack' });
  if (!v) return;
  settings.pack = v; saveSettings();
  const gap = v.gap || 0, mg = v.margin || 0, W = dev().bedW, H = dev().bedH;
  let overflow = false;
  edit(() => {
    const us = units(objs);
    if (v.rotate) for (const u of us) {
      const w = u.b.maxX - u.b.minX, h = u.b.maxY - u.b.minY;
      if (h > w * 1.05 && h <= W - 2 * mg) { applyRotate(origOf(u.list), 90, (u.b.minX + u.b.maxX) / 2, (u.b.minY + u.b.maxY) / 2); u.b = boundsOf(u.list); }
    }
    us.sort((a, b) => (b.b.maxY - b.b.minY) - (a.b.maxY - a.b.minY));
    let x = mg, y = mg, rowH = 0;
    for (const u of us) {
      const w = u.b.maxX - u.b.minX, h = u.b.maxY - u.b.minY;
      if (x > mg && x + w > W - mg) { x = mg; y += rowH + gap; rowH = 0; }
      if (y + h > H - mg) overflow = true;
      moveUnit(u, x - u.b.minX, y - u.b.minY);
      x += w + gap; rowH = Math.max(rowH, h);
    }
  });
  msg(overflow ? 'Packed, but some parts did not fit on the bed' : 'Packed onto the bed', overflow ? 'err' : 'ok');
}

// Print and cut: line up the design with something already printed, using two registration marks.
function printAndCutDialog() {
  const marks = selected();
  if (marks.length !== 2) return msg('Select exactly two registration marks in the design first (any two shapes — their centres are used)');
  const ctr = o => { const b = objBounds(o); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };
  const A = marks.map(ctr), got = [null, null];
  let allowScale = false;
  return panelDialog('Print and cut', redraw => {
    const rec = i => el('button', {
      type: 'button', disabled: !S.m.wpos,
      onclick: () => { got[i] = machineToDesign(dev(), S.m.wpos[0], S.m.wpos[1]); redraw(); },
    }, got[i] ? `Mark ${i + 1} recorded ✓ (record again)` : `Laser is on mark ${i + 1} — record`);
    const go = i => el('button', { type: 'button', disabled: !S.m.connected, onclick: guard(() => { const [mx, my] = mapToMachine(dev(), A[i][0], A[i][1]); return isRuida() ? machine.ruida('goto', { x: mx, y: my }) : machine.send(C().goTo(mx, my)); }) }, `Move near mark ${i + 1}`);
    const kids = [
      el('p', { class: 'muted small' }, '1. Put the printed sheet on the bed. 2. Jog the laser (use the red dot / a low test fire) exactly onto each printed mark and record it. 3. Align. The whole design is moved and rotated to match the sheet, and Start from is set to Absolute coords.'),
      el('div', { class: 'row gap wrap' }, go(0), rec(0)),
      el('div', { class: 'row gap wrap' }, go(1), rec(1)),
      check('Also scale the design to match (if the print shrank or stretched)', chkInput(allowScale, x => { allowScale = x; })),
    ];
    if (!S.m.connected) kids.push(el('p', { class: 'muted small' }, 'Connect to the laser to record positions (close this, connect in the Laser tab, then reopen).'));
    if (got[0] && got[1]) {
      const da = Math.hypot(A[1][0] - A[0][0], A[1][1] - A[0][1]), db = Math.hypot(got[1][0] - got[0][0], got[1][1] - got[0][1]);
      const ang = (Math.atan2(got[1][1] - got[0][1], got[1][0] - got[0][0]) - Math.atan2(A[1][1] - A[0][1], A[1][0] - A[0][0])) / G.D2R;
      kids.push(el('p', {}, `Measured: rotation ${ang.toFixed(2)}°, distance ${r3(db)} mm vs ${r3(da)} mm in the design (${((db / da - 1) * 100).toFixed(2)}%).`),
        el('button', {
          type: 'button', class: 'primary', onclick: () => {
            if (blockLocked(S.objects, 'moved')) return;
            const k = allowScale && da > 0 ? db / da : 1;
            const ma = [(A[0][0] + A[1][0]) / 2, (A[0][1] + A[1][1]) / 2], mb = [(got[0][0] + got[1][0]) / 2, (got[0][1] + got[1][1]) / 2];
            edit(() => {
              if (k !== 1) applyScale(origOf(S.objects), k, k, ma[0], ma[1]);
              applyRotate(origOf(S.objects), ang, ma[0], ma[1]);
              S.objects.forEach(o => { o.tf = { ...o.tf, x: o.tf.x + mb[0] - ma[0], y: o.tf.y + mb[1] - ma[1] }; });
            });
            settings.startFrom = 'absolute'; $('#j-start').value = 'absolute'; saveSettings(); syncAnchor();
            msg('Design aligned to the printed marks. Frame to check before cutting.', 'ok');
            $('#dlg').close();
          },
        }, 'Align design to the marks'));
    }
    return kids;
  });
}

// CSV merge for variable text.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
function csvDialog() {
  return panelDialog('Variable text data (CSV merge)', redraw => {
    const c = textVars.csv;
    const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      const rows = parseCsv(await f.text());
      if (rows.length < 2) return msg('The CSV needs a header row and at least one data row', 'err');
      textVars.csv = { name: f.name, headers: rows[0], rows: rows.slice(1) }; textVars.csvRow = 0;
      settings.csv = textVars.csv; settings.csvRow = 0; saveSettings(); changed(); redraw();
    });
    const kids = [el('p', { class: 'muted small' }, 'Load a spreadsheet saved as CSV (first row = column names). In any text object, {csv:Name} is replaced by that column from the current row, or {col:2} by the 2nd column. After each job the row can advance automatically — great for name tags and serial plates.'), field('CSV file', file)];
    if (c) {
      const setRow = n => { textVars.csvRow = settings.csvRow = clamp(n, 0, c.rows.length - 1); saveSettings(); changed(); redraw(); };
      kids.push(el('p', {}, `${c.name}: ${c.rows.length} rows · columns: ${c.headers.map(h => `{csv:${h}}`).join(' ')}`),
        el('div', { class: 'row gap' }, el('button', { type: 'button', onclick: () => setRow(textVars.csvRow - 1) }, '◀'), el('b', {}, `Row ${textVars.csvRow + 1} of ${c.rows.length}`), el('button', { type: 'button', onclick: () => setRow(textVars.csvRow + 1) }, '▶')),
        el('p', { class: 'muted small' }, c.headers.map((h, i) => `${h}: ${c.rows[textVars.csvRow][i] ?? ''}`).join(' · ')),
        check('Advance to the next row after each job', chkInput(settings.csvAuto !== false, x => { settings.csvAuto = x; saveSettings(); })),
        el('button', { type: 'button', onclick: () => { textVars.csv = settings.csv = null; saveSettings(); changed(); redraw(); } }, 'Remove CSV data'));
    }
    return kids;
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
  copy() {
    if (!S.sel.size) return msg('Select something to copy');
    S.clipboard = selected().map(o => ({ ...o, tf: { ...o.tf } })); S.clipShift = 0;
    msg(`Copied ${S.clipboard.length} object(s)`);
  },
  cut() {
    if (!S.sel.size || blockLocked(selected(), 'cut')) return;
    S.clipboard = selected().map(o => ({ ...o, tf: { ...o.tf } })); S.clipShift = 0;
    ACTIONS.del();
  },
  // Like LightBurn, Paste centres the copy on the mouse pointer (or on the right-clicked point). From the menu bar,
  // where the pointer isn't over the design, each paste lands 5 mm further along instead.
  paste(c) {
    if (!S.clipboard || !S.clipboard.length) return msg('Nothing to paste — copy something first');
    const at = c?.pt || (!c?.menubar && S.cursor);
    if (at) return pasteAt(at);
    S.clipShift += 5;
    edit(() => { S.sel = new Set(copyObjs(S.clipboard, S.clipShift, S.clipShift).map(o => o.id)); });
  },
  'paste-place'() {
    if (!S.clipboard || !S.clipboard.length) return msg('Nothing to paste — copy something first');
    edit(() => { S.sel = new Set(copyObjs(S.clipboard, 0, 0).map(o => o.id)); });
  },
  dup() {
    const objs = selected(); if (!objs.length) return;
    edit(() => { S.sel = new Set(copyObjs(objs, 5, 5).map(o => o.id)); });
  },
  del() {
    if (!S.sel.size || blockLocked(selected(), 'deleted')) return;
    edit(() => { S.objects = S.objects.filter(o => !S.sel.has(o.id)); S.sel.clear(); S.node = null; });
  },
  'select-all'() { S.sel = new Set(visibleObjects().map(o => o.id)); S.node = null; selectionChanged(); },
  group() {
    if (S.sel.size < 2) return msg('Select two or more objects to group');
    const g = uid(); edit(() => selected().forEach(o => { o.group = g; })); msg('Grouped', 'ok');
  },
  ungroup() { if (!selected().some(o => o.group)) return; edit(() => selected().forEach(o => { delete o.group; })); msg('Ungrouped', 'ok'); },
  'mirror-h'() { mirror(true); },
  'mirror-v'() { mirror(false); },
  'mirror-both'() {
    const b = boundsOf(selected()); if (!b || blockLocked(selected(), 'flipped')) return;
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
  center() { moveSelTo(0.5, 0.5); },
  topath() {
    const objs = selected().filter(o => o.type !== 'path' && o.type !== 'image');
    if (!objs.length) return msg('Select text or shapes to convert');
    if (blockLocked(objs, 'converted')) return;
    edit(() => objs.forEach(o => { const polys = localPolys(o); o.type = 'path'; o.polys = polys; }));
    msg(`Converted ${objs.length} object(s) to paths`, 'ok');
  },
  break() {
    const objs = selected().filter(o => o.type !== 'image' && localPolys(o).length > 1);
    if (!objs.length) return msg('Select a shape made of several sub-paths');
    if (blockLocked(objs, 'broken apart')) return;
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
    if (blockLocked(objs, 'joined')) return;
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
    if (blockLocked(objs, 'changed')) return;
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
    if (v.del && blockLocked(objs, 'deleted')) return;
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
  qr: () => qrDialog(),
  'material-test': () => materialTestDialog(),
  pack: () => packDialog(),
  'print-cut': () => printAndCutDialog(),
  csv: () => csvDialog(),
  // ---- the rest of LightBurn's Edit menu
  'invert-sel'() { S.sel = new Set(visibleObjects().filter(o => !S.sel.has(o.id)).map(o => o.id)); S.node = null; selectionChanged(); },
  deselect() { S.sel.clear(); S.node = null; selectionChanged(); },
  'sel-open'() { selectWhere(isOpenShape, 'open shape', 'open shapes'); },
  'sel-open-fill'() { selectWhere(o => isOpenShape(o) && isFillLayer(layerById(o.layer)), 'open shape set to fill', 'open shapes set to fill'); },
  'sel-layer'(c) {
    const L = (c?.layerId && layerById(c.layerId)) || activeLayer();
    selectWhere(o => o.layer === L.id, `shape on ${L.name}`, `shapes on ${L.name}`, `${L.name} has no visible shapes`);
  },
  'sel-contained': () => selectContained(),
  'sel-smaller': () => selectSmaller(),
  'to-bitmap': () => toBitmapDialog(),
  'close-tol': () => closeTolDialog(),
  optimize: () => optimizeDialog(),
  dedupe: () => deleteDuplicates(),
  'img-adjust'() {
    const im = selected().filter(o => o.type === 'image');
    if (!im.length) return msg('Select an image to adjust');
    if (S.sel.size !== 1) { S.sel = new Set([im[0].id]); selectionChanged(); }
    showTab('shape');
  },
  'img-invert'() {
    const im = selected().filter(o => o.type === 'image');
    if (!im.length) return msg('Select an image');
    if (blockLocked(im, 'changed')) return;
    const on = !im.every(o => o.invert);
    edit(() => im.forEach(o => { o.invert = on; }));
  },
  'img-replace': () => replaceImage(false),
  'img-replace-fit': () => replaceImage(true),
  // ---- the rest of LightBurn's Arrange menu
  'auto-group': () => autoGroup(),
  lock() {
    const objs = selected(); if (!objs.length) return msg('Select the shapes to lock');
    edit(() => objs.forEach(o => { o.locked = true; }));
    msg(`Locked ${plural(objs.length, 'shape', 'shapes')}: they can be selected and copied, but not moved, changed or deleted`, 'ok');
  },
  unlock() {
    const objs = selected().filter(o => o.locked); if (!objs.length) return msg('None of the selected shapes are locked');
    edit(() => objs.forEach(o => { delete o.locked; }));
    msg(`Unlocked ${plural(objs.length, 'shape', 'shapes')}`, 'ok');
  },
  'al-c'() { align((b, s) => [(s.minX + s.maxX) / 2 - (b.minX + b.maxX) / 2, (s.minY + s.maxY) / 2 - (b.minY + b.maxY) / 2]); },
  'together-h': () => moveTogether(0),
  'together-v': () => moveTogether(1),
  'move-tl': () => moveSelTo(0, 0), 'move-tc': () => moveSelTo(0.5, 0), 'move-tr': () => moveSelTo(1, 0),
  'move-ml': () => moveSelTo(0, 0.5), 'move-mr': () => moveSelTo(1, 0.5),
  'move-bl': () => moveSelTo(0, 1), 'move-bc': () => moveSelTo(0.5, 1), 'move-br': () => moveSelTo(1, 1),
  'move-laser'() { // centre the selection on the laser head
    if (!S.m.wpos) return msg('Connect to the laser first so its position is known', 'err');
    const objs = selected(), b = boundsOf(objs); if (!b) return msg('Select something to move');
    const [hx, hy] = machineToDesign(dev(), S.m.wpos[0], S.m.wpos[1]);
    moveUnits(units(objs).map(u => [u, hx - (b.minX + b.maxX) / 2, hy - (b.minY + b.maxY) / 2]));
  },
  'move-by': () => moveByDialog(),
  'dock-l': () => dockSel('left'), 'dock-r': () => dockSel('right'), 'dock-u': () => dockSel('up'), 'dock-d': () => dockSel('down'),
  'dock-settings': () => dockSettingsDialog(),
  'rot-180'() { rotateSel(180); },
  'rot-by': () => rotateByDialog(),
  'order-front': () => reorder('front'), 'order-fwd': () => reorder('fwd'), 'order-bwd': () => reorder('bwd'), 'order-back': () => reorder('back'),
  'copy-path': () => copyAlongPathDialog(),
  'rubber-band': () => rubberBand(),
  // ---- view and right-click extras
  'zoom-sel'() { const b = boundsOf(selected()); if (!b) return msg('Select something to zoom to'); zoomToBox(b); },
  'zoom-in': () => zoomBy(1.25),
  'zoom-out': () => zoomBy(0.8),
  props: () => showTab('shape'),
  'tool-select': () => setTool('select'),
  'text-here'(c) { const [x, y] = c?.pt || viewCentre(); createText(x, y); },
  async 'laser-here'(c) {
    if (!S.m.connected) return msg('Connect to the laser first', 'err');
    if (!inBed(c?.pt)) return msg('That point is outside the work area', 'err');
    const [x, y] = mapToMachine(dev(), c.pt[0], c.pt[1]);
    if (isRuida()) await machine.ruida('goto', { x, y }); else await machine.send(C().goTo(x, y));
  },
  'origin-here'(c) {
    if (!inBed(c?.pt)) return msg('That point is outside the work area', 'err');
    setUserOrigin(mapToMachine(dev(), c.pt[0], c.pt[1]));
    if (settings.startFrom !== 'user') { settings.startFrom = 'user'; $('#j-start').value = 'user'; saveSettings(); syncAnchor(); }
  },
};
// Run an action by name. ctx: the menu context (e.g. the right-clicked point) for actions that use it.
function act(name, ctx) {
  closeMenu();
  const f = ACTIONS[name];
  if (!f) return;
  try {
    const r = f(ctx);
    if (r && typeof r.catch === 'function') r.catch(e => msg(e.message, 'err'));
  } catch (e) { msg(e.message, 'err'); console.error(e); }
}
$$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));

// ================================================================ menus (menu bar and right-click menus)
const TYPE_LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', path: 'Path', text: 'Text', image: 'Image' };
// What the menus need to know about the selection; extra: pt (right-clicked point), hit, menubar…
function menuContext(extra = {}) {
  const objs = selected(), us = units(objs);
  return {
    objs, us, n: objs.length, nu: us.length,
    vec: objs.filter(o => o.type !== 'image'), imgs: objs.filter(o => o.type === 'image'),
    locked: objs.some(o => o.locked), grouped: objs.some(o => o.group), pt: null, ...extra,
  };
}
// Why a command can't run right now (the greyed-out item's tooltip), or false.
const WHY = {
  sel: c => !c.n && 'Select something first',
  vec: c => !c.vec.length && 'Select one or more shapes (pictures don\'t count)',
  vec2: c => c.vec.length < 2 && 'Select two or more shapes',
  u2: c => c.nu < 2 && 'Select two or more objects',
  u3: c => c.nu < 3 && 'Select three or more objects',
  lock: c => c.locked && 'Locked — unlock it first',
  clip: () => !S.clipboard?.length && 'Nothing has been copied yet',
  undo: () => !S.undo.length && 'Nothing to undo',
  redo: () => !S.redo.length && 'Nothing to redo',
  conn: () => !S.m.connected && 'Connect to the laser first',
  any: () => !visibleObjects().length && 'The design is empty',
};
const why = (c, ...keys) => { for (const k of keys) { const r = typeof k === 'function' ? k(c) : WHY[k](c); if (r) return r; } return false; };
// Menu item running action `name`. o: { kbd, title, ctx, why: [WHY keys / functions] | function | reason }
function mi(label, name, c, o = {}) {
  const w = Array.isArray(o.why) ? why(c, ...o.why) : typeof o.why === 'function' ? o.why(c) : o.why;
  return { label, kbd: o.kbd, title: o.title, disabled: w || false, run: () => act(name, o.ctx || c) };
}
const menuOpts = (extra = {}) => ({ onError: e => msg(e.message, 'err'), ...extra });

function selectItems(c, all = true) {
  const L = (c.hit && layerById(c.hit.layer)) || activeLayer();
  return [
    all && mi('Select all', 'select-all', c, { kbd: 'Ctrl+A', why: ['any'] }),
    all && mi('Invert selection', 'invert-sel', c, { kbd: 'Ctrl+Shift+I', why: ['any'] }),
    mi(`Select all shapes in layer “${L.name}”`, 'sel-layer', c, { ctx: { ...c, layerId: L.id }, why: !S.objects.some(o => o.layer === L.id) && 'That layer is empty' }),
    mi('Select open shapes', 'sel-open', c, { why: ['any'] }),
    mi('Select open shapes set to fill', 'sel-open-fill', c, { why: ['any'], title: 'Open shapes on Fill layers can\'t be filled — close them or move them to a Line layer' }),
    mi('Select contained shapes', 'sel-contained', c, { why: () => !c.objs.some(hasClosed) && 'Select a closed shape first', title: 'Selects the shapes completely inside the selected ones' }),
    mi('Select shapes smaller than selected', 'sel-smaller', c, { why: ['sel'], title: 'Selects every shape no bigger than the selected one — e.g. specks after tracing' }),
    all && '-',
    all && mi('Deselect', 'deselect', c, { kbd: 'Esc', why: ['sel'] }),
  ];
}
const flipItems = c => [
  mi('Flip horizontal', 'mirror-h', c, { kbd: 'Ctrl+Shift+H', why: ['sel', 'lock'] }),
  mi('Flip vertical', 'mirror-v', c, { kbd: 'Ctrl+Shift+V', why: ['sel', 'lock'] }),
  mi('Flip both (turn 180°)', 'mirror-both', c, { why: ['sel', 'lock'] }),
  mi('Mirror copy to the right', 'mirror-copy-h', c, { why: ['sel'] }),
  mi('Mirror copy below', 'mirror-copy-v', c, { why: ['sel'] }),
  mi('Mirror across a line…', 'mirror-line', c, { kbd: 'Ctrl+Shift+M', why: ['sel'] }),
  '-',
  mi('Rotate 90° clockwise', 'rot-cw', c, { why: ['sel', 'lock'] }),
  mi('Rotate 90° counter-clockwise', 'rot-ccw', c, { why: ['sel', 'lock'] }),
  mi('Rotate 180°', 'rot-180', c, { why: ['sel', 'lock'] }),
  mi('Rotate by angle…', 'rot-by', c, { why: ['sel', 'lock'] }),
];
function alignItems(c) {
  const mode = settings.alignTo || 'auto';
  const to = (label, v) => ({ label, radio: true, checked: mode === v, run: () => { settings.alignTo = v; saveSettings(); refreshPanels(); } });
  return [
    mi('Align left', 'al-l', c, { kbd: 'Ctrl+Shift+←', why: ['sel'] }),
    mi('Align centres horizontally', 'al-hc', c, { why: ['sel'] }),
    mi('Align right', 'al-r', c, { kbd: 'Ctrl+Shift+→', why: ['sel'] }),
    mi('Align top', 'al-t', c, { kbd: 'Ctrl+Shift+↑', why: ['sel'] }),
    mi('Align centres vertically', 'al-vc', c, { why: ['sel'] }),
    mi('Align bottom', 'al-b', c, { kbd: 'Ctrl+Shift+↓', why: ['sel'] }),
    mi('Align centres', 'al-c', c, { why: ['sel'] }),
    '-', { heading: 'Align to' },
    to('Selection (the bed for one object)', 'auto'), to('Selection', 'selection'), to('First selected object', 'key'), to('Bed', 'bed'),
  ];
}
const distributeItems = c => [
  mi('Distribute horizontally (equal gaps)', 'dist-h', c, { why: ['u3'] }),
  mi('Distribute vertically (equal gaps)', 'dist-v', c, { why: ['u3'] }),
  mi('Distribute centres horizontally', 'dist-hc', c, { why: ['u3'] }),
  mi('Distribute centres vertically', 'dist-vc', c, { why: ['u3'] }),
  '-',
  mi('Move together horizontally', 'together-h', c, { kbd: 'Alt+Shift+H', why: ['u2'], title: 'Slides them sideways until they touch; the last one selected stays put' }),
  mi('Move together vertically', 'together-v', c, { kbd: 'Alt+Shift+V', why: ['u2'], title: 'Slides them up or down until they touch; the last one selected stays put' }),
  mi('Set spacing…', 'spacing', c, { why: ['u2'] }),
  '-',
  mi('Make same width', 'same-w', c, { why: ['u2'], title: 'As wide as the first one selected' }),
  mi('Make same height', 'same-h', c, { why: ['u2'], title: 'As tall as the first one selected' }),
  mi('Make same size', 'same-size', c, { why: ['u2'], title: 'The same size as the first one selected' }),
];
function moveItems(c) {
  const w = ['sel', 'lock'];
  return [
    mi('Move to bed centre', 'center', c, { why: w }),
    mi('Move to upper left', 'move-tl', c, { why: w }),
    mi('Move to top centre', 'move-tc', c, { why: w }),
    mi('Move to upper right', 'move-tr', c, { why: w }),
    mi('Move to left centre', 'move-ml', c, { why: w }),
    mi('Move to right centre', 'move-mr', c, { why: w }),
    mi('Move to lower left', 'move-bl', c, { why: w }),
    mi('Move to bottom centre', 'move-bc', c, { why: w }),
    mi('Move to lower right', 'move-br', c, { why: w }),
    mi('Move to laser position', 'move-laser', c, { why: [() => !S.m.wpos && 'Connect to the laser first', ...w] }),
    mi('Move by…', 'move-by', c, { why: w }),
    '-',
    mi('Dock left', 'dock-l', c, { why: w }),
    mi('Dock right', 'dock-r', c, { why: w }),
    mi('Dock up', 'dock-u', c, { why: w }),
    mi('Dock down', 'dock-d', c, { why: w }),
    mi('Dock settings…', 'dock-settings', c),
  ];
}
const orderItems = c => [
  mi('Bring to front', 'order-front', c, { kbd: 'Ctrl+PgUp', why: ['sel'] }),
  mi('Bring forward', 'order-fwd', c, { kbd: 'PgUp', why: ['sel'] }),
  mi('Send backward', 'order-bwd', c, { kbd: 'PgDn', why: ['sel'] }),
  mi('Send to back', 'order-back', c, { kbd: 'Ctrl+PgDn', why: ['sel'] }),
];
function pathItems(c) {
  const open = c.objs.some(o => o.type === 'path' && o.polys.some(p => !p.closed && p.pts.length >= 3));
  const noOpen = () => !open && 'No open paths selected';
  return [
    mi('Convert to path', 'topath', c, { kbd: 'Ctrl+Shift+C', why: [() => !c.objs.some(o => o.type !== 'path' && o.type !== 'image') && 'Select text or a shape (rectangle, ellipse, polygon)', 'lock'] }),
    mi('Convert to bitmap…', 'to-bitmap', c, { kbd: 'Ctrl+Shift+B', why: ['vec', 'lock'] }),
    '-',
    mi('Close path', 'close-paths', c, { kbd: 'Alt+C', why: [noOpen, 'lock'] }),
    mi('Close paths with tolerance…', 'close-tol', c, { why: [noOpen, 'lock'] }),
    mi('Auto-join selected shapes…', 'join', c, { kbd: 'Alt+J', why: ['vec', 'lock'] }),
    mi('Optimize selected shapes…', 'optimize', c, { kbd: 'Alt+Shift+O', why: [() => !c.objs.some(o => o.type === 'path') && 'Select paths (convert shapes or text to paths first)', 'lock'] }),
    mi('Delete duplicates', 'dedupe', c, { kbd: 'Alt+D', why: () => S.objects.length < 2 && 'Nothing to compare', title: 'Deletes identical shapes stacked exactly on top of each other, anywhere in the design' }),
    mi('Break apart', 'break', c, { kbd: 'Alt+B', why: [() => !c.vec.some(o => worldPolys(o).length > 1) && 'Select a shape made of several parts', 'lock'] }),
  ];
}
const boolItems = c => [
  mi('Weld', 'weld', c, { why: ['vec', 'lock'] }),
  mi('Boolean subtract', 'subtract', c, { why: ['vec2', 'lock'], title: 'The bottom-most shape minus the others' }),
  mi('Boolean intersect', 'intersect', c, { why: ['vec2', 'lock'] }),
  mi('Boolean exclude (XOR)', 'xor', c, { why: ['vec2', 'lock'] }),
  '-',
  mi('Offset shapes…', 'offset', c, { kbd: 'Alt+O', why: ['vec'] }),
  mi('Fillet (round) corners…', 'fillet', c, { why: ['vec', 'lock'] }),
  mi('Chamfer corners…', 'chamfer', c, { why: ['vec', 'lock'] }),
];
const copyPathWhy = c => c.nu < 2 && 'Select the object to copy, then Shift-click the path';
const arrayItems = c => [
  mi('Grid array…', 'array', c, { why: ['sel'] }),
  mi('Circular array…', 'circ-array', c, { why: ['sel'] }),
  mi('Copy along path…', 'copy-path', c, { why: [copyPathWhy] }),
  mi('Pack onto the bed…', 'pack', c, { why: ['lock'], title: 'Nest the selection (or everything) onto the bed' }),
];
function imageItems(c) {
  const one = [() => c.imgs.length !== 1 && 'Select one image', 'lock'], any = () => !c.imgs.length && 'Select an image';
  return [
    mi('Adjust image…', 'img-adjust', c, { kbd: 'Alt+I', why: any, title: 'Brightness, contrast, gamma (Shape tab)' }),
    mi('Trace image…', 'trace', c, { kbd: 'Alt+T', why: any }),
    { label: 'Invert', checked: !!c.imgs.length && c.imgs.every(o => o.invert), disabled: why(c, any, 'lock'), run: () => act('img-invert', c) },
    '-',
    mi('Replace image…', 'img-replace', c, { why: one }),
    mi('Replace image to fit…', 'img-replace-fit', c, { why: one, title: 'The new picture is fitted inside the old one\'s box' }),
  ];
}
function moveSelToLayer(T) {
  const objs = selected(); if (!objs.length) return;
  edit(() => {
    if (!T) { T = makeLayer(PALETTE.find(col => !S.layers.some(l => l.color === col)) || PALETTE[S.layers.length % PALETTE.length]); S.layers.push(T); }
    S.activeLayer = T.id;
    for (const o of objs) { o.layer = T.id; if (o.type === 'image') T.mode = 'image'; } // same rule as the colour palette
  });
  msg(`Moved ${plural(objs.length, 'object', 'objects')} to ${T.name}`, 'ok');
}
const layerPickItems = c => [
  ...S.layers.map(L => ({ label: `${L.name} · ${MODE_LABEL[L.mode]}`, swatch: L.color, kbd: c.objs.every(o => o.layer === L.id) ? 'current' : '', run: () => moveSelToLayer(L) })),
  '-',
  { label: 'New layer', run: () => moveSelToLayer(null) },
];
function laserItems(c) {
  const here = !!c.pt, out = () => !inBed(c.pt) && 'That point is outside the work area';
  return [
    here && mi('Move laser here', 'laser-here', c, { why: ['conn', out] }),
    mi('Move laser to selection', 'goto-sel', c, { why: ['conn', 'sel'] }),
    mi('Move selection to laser position', 'move-laser', c, { why: [() => !S.m.wpos && 'Connect to the laser first', 'sel', 'lock'] }),
    '-',
    here && mi('Set user origin here', 'origin-here', c, { why: [out], title: 'Jobs started from "User origin" put their anchor on this spot' }),
    { label: 'Cut selected graphics only', checked: $('#j-selonly').checked, run: () => { const b = $('#j-selonly'); b.checked = !b.checked; changed(); } },
  ];
}
// Layers: LightBurn's column-header menu (all layers) and layer-row menu.
function setLayerShown(L, on) {
  L.show = on;
  if (!on) for (const o of S.objects) if (o.layer === L.id) S.sel.delete(o.id);
}
function allLayersItems() {
  const air = isCnc(dev()) ? 'coolant / dust extraction' : 'air assist';
  const each = fn => () => edit(() => S.layers.forEach(fn));
  return [
    { label: 'Enable all layers', run: each(L => { L.output = true; }) },
    { label: 'Disable all layers', run: each(L => { L.output = false; }) },
    { label: 'Invert enabled layers', run: each(L => { L.output = !L.output; }) },
    '-',
    { label: 'Show all layers', run: each(L => setLayerShown(L, true)) },
    { label: 'Hide all layers', run: each(L => setLayerShown(L, false)) },
    { label: 'Invert visible layers', run: each(L => setLayerShown(L, L.show === false)) },
    '-',
    { label: `Turn ${air} on for all layers`, run: each(L => { L.air = true; }) },
    { label: `Turn ${air} off for all layers`, run: each(L => { L.air = false; }) },
    { label: `Invert ${air} on all layers`, run: each(L => { L.air = !L.air; }) },
    '-',
    { label: 'Sort cuts last', title: 'Moves the Line (cutting) layers to the end, so engraving runs before parts are cut free',
      run: () => edit(() => { S.layers = [...S.layers.filter(L => L.mode !== 'line'), ...S.layers.filter(L => L.mode === 'line')]; }) },
  ];
}
function layerMenu(L) {
  const i = S.layers.indexOf(L), n = S.objects.filter(o => o.layer === L.id).length;
  const others = S.layers.filter(x => x !== L), empty = !n && 'This layer is empty';
  return [
    { heading: `${L.name} · ${MODE_LABEL[L.mode]} · ${plural(n, 'shape', 'shapes')}` },
    { label: 'Make this the active layer', disabled: activeLayer() === L && 'It is already the active layer', title: 'New shapes go on the active layer', run: () => { S.activeLayer = L.id; refreshPanels(); } },
    { label: 'Move selection to this layer', disabled: !S.sel.size && 'Nothing is selected', run: () => moveSelToLayer(L) },
    '-',
    { label: 'Select all shapes in this layer', kbd: 'Shift+click', disabled: empty || (L.show === false && 'The layer is hidden'), run: () => act('sel-layer', { layerId: L.id }) },
    { label: 'Flash the content on this layer', kbd: 'Shift+right-click', disabled: empty, run: () => flashLayer(L.id) },
    '-',
    { label: 'Output this layer', checked: !!L.output, run: () => edit(() => { L.output = !L.output; }) },
    { label: 'Disable all layers but this one', disabled: L.output && !others.some(x => x.output) && 'The other layers are already off', run: () => edit(() => { L.output = true; others.forEach(x => { x.output = false; }); }) },
    { label: 'Show this layer', checked: L.show !== false, title: 'Hidden layers still burn while their Output is on', run: () => edit(() => setLayerShown(L, L.show === false)) },
    { label: 'Hide all layers but this one', disabled: L.show !== false && !others.some(x => x.show !== false) && 'The other layers are already hidden', run: () => edit(() => { setLayerShown(L, true); others.forEach(x => setLayerShown(x, false)); }) },
    '-',
    { label: 'All layers', sub: allLayersItems() },
    '-',
    { label: 'Move up (runs earlier)', disabled: i === 0, run: () => edit(() => { S.layers.splice(i - 1, 0, S.layers.splice(i, 1)[0]); }) },
    { label: 'Move down (runs later)', disabled: i === S.layers.length - 1, run: () => edit(() => { S.layers.splice(i + 1, 0, S.layers.splice(i, 1)[0]); }) },
    { label: 'Save as a material preset…', run: () => { S.activeLayer = L.id; refreshPanels(); savePresetDialog(); } },
    { label: 'Delete layer', disabled: n ? 'Only empty layers can be deleted' : S.layers.length < 2 && 'The last layer can\'t be deleted',
      run: () => edit(() => { S.layers = S.layers.filter(x => x !== L); if (S.activeLayer === L.id) S.activeLayer = S.layers[0].id; }) },
  ];
}
function flashLayer(id) {
  if (!S.objects.some(o => o.layer === id)) return msg('That layer is empty');
  clearInterval(flashLayer.t);
  let n = 0;
  S.flash = { layer: id, on: true }; requestDraw();
  flashLayer.t = setInterval(() => {
    if (++n >= 6) { clearInterval(flashLayer.t); S.flash = null; } else S.flash.on = !S.flash.on;
    requestDraw();
  }, 170);
}

// ---- canvas right-click menu
function selectionTitle(c) {
  const b = boundsOf(c.objs);
  const what = c.n === 1 ? (c.objs[0].name || TYPE_LABEL[c.objs[0].type] || 'Object') : c.nu === 1 && c.objs[0].group ? `Group of ${c.n}` : `${c.n} objects`;
  return `${what} · ${+(b.maxX - b.minX).toFixed(2)} × ${+(b.maxY - b.minY).toFixed(2)} mm${c.locked ? ' · locked' : ''}`;
}
function canvasMenu(c) {
  const head = [
    S.tool !== 'select' && mi('Select tool', 'tool-select', c, { kbd: 'V' }),
    S.measure && { label: 'Clear measurement', run: () => { S.measure = null; requestDraw(); } },
    '-',
    mi('Undo', 'undo', c, { kbd: 'Ctrl+Z', why: ['undo'] }),
    mi('Redo', 'redo', c, { kbd: 'Ctrl+Y', why: ['redo'] }),
    '-',
  ];
  const paste = [
    mi('Paste', 'paste', c, { kbd: 'Ctrl+V', why: ['clip'], title: 'Pastes centred where you right-clicked' }),
    mi('Paste in place', 'paste-place', c, { kbd: 'Alt+V', why: ['clip'] }),
  ];
  if (!c.n) {
    return [...head, ...paste, '-',
      mi('Select all', 'select-all', c, { kbd: 'Ctrl+A', why: ['any'] }),
      { label: 'Select', sub: selectItems(c, false) },
      '-',
      mi('Add text here…', 'text-here', c),
      mi('Import…', 'import', c, { kbd: 'Ctrl+I' }),
      mi('QR code…', 'qr', c),
      '-',
      { label: 'Laser', sub: laserItems(c) },
      { label: 'Layers', sub: allLayersItems() },
      '-',
      mi('Zoom to bed', 'fit', c, { kbd: 'F' }),
      { label: 'Preview', kbd: 'Alt+P', checked: S.previewOn, run: () => act('preview') },
    ];
  }
  return [{ heading: selectionTitle(c) }, ...head,
    mi('Cut', 'cut', c, { kbd: 'Ctrl+X', why: ['lock'] }),
    mi('Copy', 'copy', c, { kbd: 'Ctrl+C' }),
    mi('Duplicate', 'dup', c, { kbd: 'Ctrl+D' }),
    ...paste,
    mi('Delete', 'del', c, { kbd: 'Del', why: ['lock'] }),
    '-',
    { label: 'Select', sub: selectItems(c) },
    mi('Group', 'group', c, { kbd: 'Ctrl+G', why: ['u2'] }),
    mi('Ungroup', 'ungroup', c, { kbd: 'Ctrl+U', why: () => !c.grouped && 'Nothing grouped is selected' }),
    mi('Auto-group', 'auto-group', c, { title: 'Groups each outer shape with the shapes fully inside it' }),
    c.locked ? mi('Unlock selected shapes', 'unlock', c) : mi('Lock selected shapes', 'lock', c, { title: 'Locked shapes can be selected and copied, but not moved, changed or deleted' }),
    '-',
    { label: 'Flip & rotate', sub: flipItems(c) },
    { label: 'Align', sub: alignItems(c) },
    { label: 'Distribute & size', sub: distributeItems(c) },
    { label: 'Move', sub: moveItems(c) },
    { label: 'Draw order', sub: orderItems(c) },
    '-',
    { label: 'Path tools', sub: [...pathItems(c), mi('Create rubber-band outline', 'rubber-band', c), '-', mi('Edit nodes', 'tool-node', c, { kbd: 'N' })] },
    { label: 'Boolean & offset', sub: boolItems(c) },
    { label: 'Array & copy', sub: arrayItems(c) },
    c.imgs.length ? { label: 'Image', sub: imageItems(c) } : null,
    { label: 'Move to layer', sub: layerPickItems(c) },
    '-',
    { label: 'Laser', sub: laserItems(c) },
    mi('Zoom to selection', 'zoom-sel', c, { kbd: 'Ctrl+Shift+A' }),
    mi('Properties', 'props', c, { title: 'Size, position and settings in the Shape tab' }),
  ];
}
function draftMenu() {
  const n = S.draft.pts.length;
  return [
    { heading: `Drawing a line · ${plural(n, 'point', 'points')}` },
    { label: 'Finish line', kbd: 'Enter', disabled: n < 2 && 'Click at least two points first', run: () => finishLine(false) },
    { label: 'Close shape', disabled: n < 3 && 'Needs three or more points', run: () => finishLine(true) },
    { label: 'Remove last point', kbd: 'Backspace', run: removeLastPoint },
    { label: 'Cancel line', kbd: 'Esc', run: () => { S.draft = null; requestDraw(); } },
  ];
}
const previewMenu = () => [
  { label: 'Close preview', kbd: 'Esc', run: () => act('preview') },
  { label: 'Zoom to bed', kbd: 'F', run: zoomFit },
  '-',
  { label: 'Save G-code / Ruida RD file…', kbd: 'Ctrl+E', run: () => act('export') },
];
// Edit nodes mode: right-click on a node or on a line of the selected shape.
function nodeMenu(c, sx, sy) {
  const nh = nodeHit(sx, sy), seg = nh ? null : segmentHit(c.pt[0], c.pt[1]);
  if (!nh && !seg) return null;
  const o = nh ? S.objects.find(x => x.id === nh.id) : seg.o;
  const pi = nh ? nh.pi : seg.pi, p = worldPolys(o)[pi], n = p.pts.length;
  const lk = o.locked && 'Locked — unlock it first';
  const closeItem = !p.closed && n >= 3 && { label: 'Close this path', disabled: lk, run: () => closeSubpath(o, pi) };
  const tail = ['-', mi('Undo', 'undo', c, { kbd: 'Ctrl+Z', why: ['undo'] }), mi('Select tool', 'tool-select', c, { kbd: 'V' })];
  if (nh) {
    S.node = nh; requestDraw();
    const end = !p.closed && (nh.vi === 0 || nh.vi === n - 1);
    return [{ heading: `Node ${nh.vi + 1} of ${n}${p.closed ? '' : ' · open path'}` },
      { label: 'Delete node', kbd: 'D', disabled: lk, run: deleteNode },
      { label: 'Break shape at this node', kbd: 'B', disabled: lk || (end && 'Already an end of the path'), run: () => breakNode(o, pi, nh.vi) },
      closeItem, ...tail];
  }
  const a = p.pts[seg.i - 1], b = p.pts[seg.i % n];
  return [{ heading: 'Line segment' },
    { label: 'Add node here', kbd: 'I', disabled: lk, run: () => insertNode(o, pi, seg.i, c.pt) },
    { label: 'Add node at the midpoint', disabled: lk, run: () => insertNode(o, pi, seg.i, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) },
    { label: 'Delete this segment', disabled: lk, title: 'Opens a closed shape here, or splits an open path in two', run: () => deleteSegment(o, pi, seg.i) },
    closeItem, ...tail];
}
// sx, sy: canvas pixels. A right-click on an unselected shape selects it first, as in LightBurn.
function openCanvasMenu(sx, sy, keyboard = false) {
  const r = cv.getBoundingClientRect(), pt = toWorld(sx, sy);
  let items = null;
  if (S.previewOn) items = previewMenu();
  else if (S.draft?.kind === 'line') items = draftMenu();
  else {
    const hit = keyboard ? null : hitTest(pt[0], pt[1]);
    if (hit && !S.sel.has(hit.id)) { S.sel = S.tool === 'node' ? new Set([hit.id]) : withGroups([hit.id]); S.node = null; selectionChanged(); }
    if (S.tool === 'node' && !keyboard) items = nodeMenu(menuContext({ pt }), sx, sy);
    if (!items) items = canvasMenu(menuContext({ pt, hit }));
  }
  openMenu(items, r.left + sx, r.top + sy, menuOpts({ keyboard }));
}
cv.addEventListener('contextmenu', e => { e.preventDefault(); if (!drag) openCanvasMenu(e.offsetX, e.offsetY); });
// Menu key or Shift+F10: the same menu at the selection (or the middle of the view).
function openCanvasMenuAtSelection() {
  const r = cv.getBoundingClientRect(), b = boundsOf(selected());
  const [sx, sy] = b ? toScreen((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2) : [r.width / 2, r.height / 2];
  openCanvasMenu(clamp(sx, 8, r.width - 8), clamp(sy, 8, r.height - 8), true);
}
// The Menu key also sends a contextmenu event to the focused element: don't let a browser menu cover ours.
document.addEventListener('contextmenu', e => { if (isMenuOpen() && !e.target.closest?.('.ctx-menu')) e.preventDefault(); });
$('#layer-list').addEventListener('contextmenu', e => {
  if (e.target.closest('.layer-row')) return;
  e.preventDefault();
  openMenu(allLayersItems(), e.clientX, e.clientY, menuOpts());
});

// ---- menu bar
const BAR = {
  file: c => [
    mi('New project', 'new', c),
    mi('Open project…', 'open', c, { kbd: 'Ctrl+O' }),
    mi('Save project', 'save', c, { kbd: 'Ctrl+S' }),
    '-',
    mi('Import SVG / DXF / PLT / image…', 'import', c, { kbd: 'Ctrl+I' }),
    mi('Export SVG…', 'export-svg', c),
    mi('Export DXF…', 'export-dxf', c),
    '-',
    mi('Save G-code / Ruida RD file…', 'export', c, { kbd: 'Ctrl+E' }),
    mi('Run a G-code file on the laser…', 'run-file', c),
  ],
  edit: c => [
    mi('Undo', 'undo', c, { kbd: 'Ctrl+Z', why: ['undo'] }),
    mi('Redo', 'redo', c, { kbd: 'Ctrl+Y', why: ['redo'] }),
    '-',
    mi('Cut', 'cut', c, { kbd: 'Ctrl+X', why: ['sel', 'lock'] }),
    mi('Copy', 'copy', c, { kbd: 'Ctrl+C', why: ['sel'] }),
    mi('Paste', 'paste', c, { kbd: 'Ctrl+V', why: ['clip'] }),
    mi('Paste in place', 'paste-place', c, { kbd: 'Alt+V', why: ['clip'] }),
    mi('Duplicate', 'dup', c, { kbd: 'Ctrl+D', why: ['sel'] }),
    mi('Delete', 'del', c, { kbd: 'Del', why: ['sel', 'lock'] }),
    '-',
    mi('Select all', 'select-all', c, { kbd: 'Ctrl+A', why: ['any'] }),
    mi('Invert selection', 'invert-sel', c, { kbd: 'Ctrl+Shift+I', why: ['any'] }),
    { label: 'Select', sub: selectItems(c, false) },
    '-',
    ...pathItems(c),
    '-',
    { label: 'Image', sub: imageItems(c) },
    '-',
    mi('Preferences…', 'settings', c),
  ],
  arrange: c => [
    mi('Group', 'group', c, { kbd: 'Ctrl+G', why: ['u2'] }),
    mi('Ungroup', 'ungroup', c, { kbd: 'Ctrl+U', why: () => !c.grouped && 'Nothing grouped is selected' }),
    mi('Auto-group', 'auto-group', c, { title: 'Groups each outer shape with the shapes fully inside it (the whole design if nothing is selected)' }),
    mi('Lock selected shapes', 'lock', c, { why: ['sel'] }),
    mi('Unlock selected shapes', 'unlock', c, { why: () => !c.locked && 'Nothing locked is selected' }),
    '-',
    { label: 'Flip & rotate', sub: flipItems(c) },
    { label: 'Align', sub: alignItems(c) },
    { label: 'Distribute & size', sub: distributeItems(c) },
    { label: 'Move', sub: moveItems(c) },
    { label: 'Draw order', sub: orderItems(c) },
    '-',
    mi('Grid array…', 'array', c, { why: ['sel'] }),
    mi('Circular array…', 'circ-array', c, { why: ['sel'] }),
    mi('Copy along path…', 'copy-path', c, { why: [copyPathWhy] }),
    mi('Create rubber-band outline', 'rubber-band', c, { why: ['sel'] }),
  ],
  tools: c => [
    ...boolItems(c),
    '-',
    mi('Trace image…', 'trace', c, { kbd: 'Alt+T', why: () => !c.imgs.length && 'Select an image to trace' }),
    mi('QR code…', 'qr', c),
    mi('Variable text data (CSV merge)…', 'csv', c),
    mi('Pack onto the bed…', 'pack', c, { why: ['lock'] }),
    '-',
    mi('Edit nodes', 'tool-node', c, { kbd: 'N' }),
    mi('Measure', 'tool-measure', c, { kbd: 'M' }),
  ],
  laser: c => [
    mi('Devices…', 'devices', c),
    mi('Machine settings…', 'machine-settings', c),
    mi('Rotary setup…', 'rotary', c),
    mi('Edit macros…', 'macros', c),
    '-',
    mi('Material library…', 'library', c),
    mi('Material test…', 'material-test', c),
    mi('Print and cut…', 'print-cut', c),
    '-',
    mi('Move laser to selection', 'goto-sel', c, { why: ['conn', 'sel'] }),
    mi('Move selection to laser position', 'move-laser', c, { why: [() => !S.m.wpos && 'Connect to the laser first', 'sel', 'lock'] }),
    mi('User origin…', 'user-origin', c),
  ],
  view: c => [
    mi('Zoom to bed', 'fit', c, { kbd: 'F' }),
    mi('Zoom to selection', 'zoom-sel', c, { kbd: 'Ctrl+Shift+A', why: ['sel'] }),
    mi('Zoom in', 'zoom-in', c, { kbd: '+' }),
    mi('Zoom out', 'zoom-out', c, { kbd: '−' }),
    '-',
    { label: 'Preview', kbd: 'Alt+P', checked: S.previewOn, run: () => act('preview') },
  ],
};
function openBarMenu(btn, keyboard = false) {
  openMenu(BAR[btn.dataset.menu](menuContext({ menubar: true })), 0, 0, menuOpts({
    anchor: btn, keyboard,
    onClose: () => btn.classList.remove('open'),
    onLeft: () => stepBarMenu(btn, -1), onRight: () => stepBarMenu(btn, 1),
  }));
  btn.classList.add('open');
}
function stepBarMenu(btn, d) {
  const all = $$('.menu-btn');
  openBarMenu(all[(all.indexOf(btn) + d + all.length) % all.length], true);
}
$$('.menu-btn').forEach(b => {
  b.addEventListener('click', e => { if (menuAnchor() === b) closeMenu(); else openBarMenu(b, e.detail === 0); });
  b.addEventListener('mouseenter', () => { const a = menuAnchor(); if (a && a !== b && a.classList.contains('menu-btn')) openBarMenu(b); });
  b.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); openBarMenu(b, true); } });
});

// Mirror the selection across a line at `deg` (0 = horizontal line, 90 = vertical) through (cx, cy).
// With copy, the originals stay and mirrored copies are added (and selected).
function mirrorSel(deg, { copy = false, at } = {}) {
  const objs = selected(), b = boundsOf(objs); if (!b) return msg('Select something to mirror');
  if (!copy && blockLocked(objs, 'flipped')) return;
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
  if (blockLocked(objs, 'changed')) return;
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
  const b = boundsOf(selected()); if (!b) return msg('Select something to rotate');
  if (blockLocked(selected(), 'rotated')) return;
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
  moveUnits(movers.map(u => [u, ...fn(u.b, target)])); // a locked object can still be the one others align to
}
const moveUnit = (u, dx, dy) => u.list.forEach(o => { o.tf = { ...o.tf, x: o.tf.x + dx, y: o.tf.y + dy }; });
// Spread centres evenly between the outermost centres.
function distributeCentres(axis) {
  const us = units(selected());
  if (us.length < 3) return msg('Select three or more objects to distribute');
  const c = u => axis ? (u.b.minY + u.b.maxY) / 2 : (u.b.minX + u.b.maxX) / 2;
  us.sort((a, b) => c(a) - c(b));
  const a = c(us[0]), step = (c(us[us.length - 1]) - a) / (us.length - 1);
  moveUnits(us.map((u, i) => { const d = a + step * i - c(u); return [u, axis ? 0 : d, axis ? d : 0]; }));
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
  const moves = [];
  let pos = us[0].b[lo];
  for (const u of us) { const d = pos - u.b[lo]; moves.push([u, ax ? 0 : d, ax ? d : 0]); pos += u.b[hi] - u.b[lo] + v.gap; }
  moveUnits(moves);
}
// Make every selected object the same width and/or height as the key (first selected) object.
function sameSize(w, h) {
  const us = units(selected());
  if (us.length < 2) return msg('Select two or more objects (the first one selected sets the size)');
  const k = keyUnit(us), KW = k.b.maxX - k.b.minX, KH = k.b.maxY - k.b.minY;
  if (blockLocked(us.filter(u => u !== k).flatMap(u => u.list), 'resized')) return;
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
  const moves = [];
  let pos = us[0].b[lo];
  for (const u of us) {
    const d = pos - u.b[lo];
    moves.push([u, axis ? 0 : d, axis ? d : 0]);
    pos += u.b[hi] - u.b[lo] + gap;
  }
  moveUnits(moves);
}

// ================================================================ LightBurn-style extras (Edit / Arrange menus)
const isOpenShape = o => o.type === 'path' && o.polys.some(p => !p.closed && p.pts.length >= 2);
const isFillLayer = L => !!L && (L.mode === 'fill' || L.mode === 'offset');
const hasClosed = o => worldPolys(o).some(p => p.closed && p.pts.length >= 3);
const isInside = (o, c) => o !== c && hasClosed(c) && polysInside(worldPolys(o), worldPolys(c), objBounds(o), objBounds(c));
const inBed = p => !!p && p[0] >= 0 && p[1] >= 0 && p[0] <= dev().bedW && p[1] <= dev().bedH;
const boxArea = b => (b.maxX - b.minX) * (b.maxY - b.minY);
const showTab = name => $(`.tabs [data-tab="${name}"]`)?.click();
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
function selectWhere(pred, one, many, none = `No ${many} found`) {
  const ids = visibleObjects().filter(pred).map(o => o.id);
  S.sel = new Set(ids); S.node = null; selectionChanged();
  msg(ids.length ? `Selected ${plural(ids.length, one, many)}` : none, ids.length ? 'ok' : '');
}
// Shapes completely inside the selected closed shapes (the outer shapes themselves end up deselected).
function selectContained() {
  const outer = selected().filter(hasClosed);
  if (!outer.length) return msg('Select one or more closed shapes first');
  const ids = new Set(outer.map(o => o.id));
  selectWhere(o => !ids.has(o.id) && outer.some(c => isInside(o, c)), 'shape inside', 'shapes inside', 'No shapes are fully inside the selection');
}
// Everything no bigger than the largest selected shape — handy for clearing specks after tracing.
function selectSmaller() {
  const objs = selected(); if (!objs.length) return msg('Select a shape first: everything up to its size gets selected');
  let W = 0, H = 0;
  for (const o of objs) { const b = objBounds(o); W = Math.max(W, b.maxX - b.minX); H = Math.max(H, b.maxY - b.minY); }
  selectWhere(o => { const b = objBounds(o); return b.maxX - b.minX <= W + 1e-6 && b.maxY - b.minY <= H + 1e-6; },
    'shape this size or smaller', 'shapes this size or smaller');
}
// Each outermost closed shape is grouped with all the shapes fully inside it; shapes partly outside are left out.
// Works on the selection; with one shape selected, groups it with what's inside it; with nothing selected, the
// whole design.
function autoGroup() {
  const sel = selected(), pool = sel.length >= 2 ? sel : visibleObjects();
  if (pool.length < 2) return msg('Nothing to group');
  const outer = sel.length === 1 ? sel.filter(hasClosed) : pool.filter(a => !pool.some(c => isInside(a, c)));
  const groups = new Map();
  for (const a of pool) {
    if (outer.includes(a)) continue;
    const hosts = outer.filter(c => isInside(a, c)).sort((x, y) => boxArea(objBounds(x)) - boxArea(objBounds(y)));
    if (!hosts.length) continue;
    if (!groups.has(hosts[0])) groups.set(hosts[0], [hosts[0]]);
    groups.get(hosts[0]).push(a);
  }
  if (!groups.size) return msg('No shapes were found inside other shapes');
  edit(() => {
    for (const list of groups.values()) { const g = uid(); list.forEach(o => { o.group = g; }); }
    S.sel = new Set([...groups.values()].flat().map(o => o.id));
  });
  msg(`Auto-group: made ${plural(groups.size, 'group', 'groups')}`, 'ok');
}
// The unit holding the object selected last (Shift-click order): LightBurn's anchor for "move together".
function lastUnit(us) {
  const ids = [...S.sel], last = ids[ids.length - 1];
  return us.find(u => u.list.some(o => o.id === last)) || us[us.length - 1];
}
// Slide objects along one axis until they touch, keeping the last-selected one still.
function moveTogether(axis) {
  const us = units(selected());
  if (us.length < 2) return msg('Select two or more objects (the last one selected stays where it is)');
  const lo = axis ? 'minY' : 'minX', hi = axis ? 'maxY' : 'maxX', c = u => (u.b[lo] + u.b[hi]) / 2;
  const anchor = lastUnit(us), moves = [];
  const mv = (u, d) => moves.push([u, axis ? 0 : d, axis ? d : 0]);
  let edge = anchor.b[lo];
  for (const u of us.filter(u => u !== anchor && c(u) <= c(anchor)).sort((a, b) => c(b) - c(a))) { const d = edge - u.b[hi]; mv(u, d); edge = u.b[lo] + d; }
  edge = anchor.b[hi];
  for (const u of us.filter(u => u !== anchor && c(u) > c(anchor)).sort((a, b) => c(a) - c(b))) { const d = edge - u.b[lo]; mv(u, d); edge = u.b[hi] + d; }
  moveUnits(moves);
}
// Put the selection's box at a spot on the bed: fx, fy = 0 (left / top), 0.5 (centre) or 1 (right / bottom).
function moveSelTo(fx, fy) {
  const objs = selected(), b = boundsOf(objs); if (!b) return msg('Select something to move');
  const d = dev(), dx = fx * (d.bedW - (b.maxX - b.minX)) - b.minX, dy = fy * (d.bedH - (b.maxY - b.minY)) - b.minY;
  moveUnits(units(objs).map(u => [u, dx, dy]));
}
async function moveByDialog() {
  const objs = selected(); if (!objs.length) return msg('Select something to move');
  if (blockLocked(objs, 'moved')) return;
  const M = settings.moveBy || { x: 10, y: 0 };
  const v = await formDialog('Move selection', [
    { key: 'x', label: 'Move X by (mm)', type: 'number', value: M.x },
    { key: 'y', label: 'Move Y by (mm)', type: 'number', value: M.y },
    { key: 'n', type: 'note', label: 'In the machine\'s X and Y directions, the same as the X and Y boxes in the Shape tab.' },
  ], { ok: 'Move' });
  if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
  settings.moveBy = { x: v.x, y: v.y }; saveSettings();
  const d = dev(), right = d.origin === 'tr' || d.origin === 'br', front = d.origin === 'bl' || d.origin === 'br';
  moveUnits(units(objs).map(u => [u, v.x * (right ? -1 : 1), v.y * (front ? -1 : 1)]));
}
async function rotateByDialog() {
  if (!S.sel.size) return msg('Select something to rotate');
  if (blockLocked(selected(), 'rotated')) return;
  const v = await formDialog('Rotate selection', [
    { key: 'deg', label: 'Angle (°, positive turns clockwise)', type: 'number', value: settings.rotBy ?? 45 },
  ], { ok: 'Rotate' });
  if (!v || !Number.isFinite(v.deg)) return;
  settings.rotBy = v.deg; saveSettings();
  rotateSel(v.deg);
}
// Shapes inside another selected shape's outline travel with it when docking.
function mergeContained(us) {
  const out = [];
  for (const u of us.slice().sort((a, b) => boxArea(b.b) - boxArea(a.b))) {
    const host = out.find(h => u.list.every(o => h.list.some(c => isInside(o, c))));
    if (host) host.list.push(...u.list); else out.push({ list: u.list.slice(), b: u.b });
  }
  return out;
}
// Dock: slide the selection until it touches another object or the edge of the bed (bounding boxes).
function dockSel(dir) {
  const objs = selected(); if (!objs.length) return msg('Select something to dock');
  const D = settings.dock || { pad: 0, together: false };
  const ids = new Set(objs.map(o => o.id));
  const movers = D.together ? [{ list: objs, b: boundsOf(objs) }] : mergeContained(units(objs));
  const others = units(visibleObjects().filter(o => !ids.has(o.id))).map(u => u.b);
  const deltas = dockBoxes(movers.map(u => u.b), others, bedBox(), dir, D.pad || 0);
  if (!moveUnits(movers.map((u, i) => [u, ...deltas[i]])) && !objs.some(o => o.locked)) msg('Already docked: something is in the way');
}
async function dockSettingsDialog() {
  const D = settings.dock || { pad: 0, together: false };
  const v = await formDialog('Dock settings', [
    { key: 'pad', label: 'Gap to leave (mm)', type: 'number', value: D.pad, min: 0 },
    { key: 'together', label: 'Move the selection as one block (otherwise each object docks on its own)', type: 'check', value: D.together },
    { key: 'n', type: 'note', label: 'Dock slides the selection left, right, up or down until it touches another object or the edge of the bed. Shapes inside a selected shape move with it. Objects are treated as their bounding boxes.' },
  ], { ok: 'Save' });
  if (!v) return;
  settings.dock = { pad: Math.max(0, v.pad || 0), together: v.together }; saveSettings();
}
// Draw order: later objects are drawn on top, picked first by a click and used last by Subtract.
function reorder(kind) {
  if (!S.sel.size) return msg('Select something first');
  const on = o => S.sel.has(o.id);
  let a = S.objects.slice();
  if (kind === 'front') a = [...a.filter(o => !on(o)), ...a.filter(on)];
  else if (kind === 'back') a = [...a.filter(on), ...a.filter(o => !on(o))];
  else if (kind === 'fwd') { for (let i = a.length - 2; i >= 0; i--) if (on(a[i]) && !on(a[i + 1])) [a[i], a[i + 1]] = [a[i + 1], a[i]]; }
  else { for (let i = 1; i < a.length; i++) if (on(a[i]) && !on(a[i - 1])) [a[i], a[i - 1]] = [a[i - 1], a[i]]; }
  if (a.every((o, i) => o === S.objects[i])) return msg(kind === 'front' || kind === 'fwd' ? 'Already at the front' : 'Already at the back');
  edit(() => { S.objects = a; });
}
// Copy along path: copies of the other selected objects, centred on evenly spaced points of the path.
// The path is the object selected last (select the object, then Shift-click the path), as in LightBurn.
async function copyAlongPathDialog() {
  const us = units(selected());
  if (us.length < 2) return msg('Select the object to copy, then Shift-click the path to copy it along');
  const name = u => `${u.list.length > 1 ? `Group of ${u.list.length}` : (u.list[0].name || TYPE_LABEL[u.list[0].type])} — ${r3(u.b.maxX - u.b.minX)} × ${r3(u.b.maxY - u.b.minY)} mm`;
  const P = settings.alongPath || { count: 10, spacing: 0, rotate: true, select: true };
  const v = await formDialog('Copy along path', [
    { key: 'path', label: 'Path to follow', type: 'select', value: String(us.indexOf(lastUnit(us))), options: us.map((u, i) => [String(i), name(u)]) },
    { key: 'count', label: 'Number of copies', type: 'number', value: P.count, min: 1, step: 1 },
    { key: 'spacing', label: '…or one copy every (mm, 0 = use the number)', type: 'number', value: P.spacing, min: 0 },
    { key: 'rotate', label: 'Rotate copies to follow the path', type: 'check', value: P.rotate },
    { key: 'select', label: 'Select the copies afterwards', type: 'check', value: P.select },
    { key: 'n', type: 'note', label: 'Copies are centred on the path. On a closed path they go all the way round; on an open path from one end to the other. The originals stay where they are.' },
  ], { ok: 'Copy' });
  if (!v) return;
  const count = clamp(Math.round(v.count) || 1, 1, 5000), spacing = Math.max(0, v.spacing || 0);
  settings.alongPath = { count, spacing, rotate: v.rotate, select: v.select }; saveSettings();
  const path = us[+v.path] || lastUnit(us), src = us.filter(u => u !== path).flatMap(u => u.list);
  const polys = path.list.filter(o => o.type !== 'image').flatMap(o => worldPolys(o)).filter(p => p.pts.length >= 2);
  if (!polys.length) return msg('That object has no outline to follow', 'err');
  const len = p => p.pts.reduce((s, q, i) => i ? s + Math.hypot(q[0] - p.pts[i - 1][0], q[1] - p.pts[i - 1][1]) : 0, 0) + (p.closed ? Math.hypot(p.pts[0][0] - p.pts[p.pts.length - 1][0], p.pts[0][1] - p.pts[p.pts.length - 1][1]) : 0);
  const longest = polys.reduce((a, p) => len(p) > len(a) ? p : a);
  const spots = samplePath(longest.pts, longest.closed, count, spacing);
  if (!spots.length) return msg('The path is too short', 'err');
  if (spots.length > 5000) return msg(`That would make ${spots.length.toLocaleString()} copies — use a larger spacing`, 'err');
  const b = boundsOf(src), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  edit(() => {
    const made = [];
    for (const s of spots) {
      const copies = copyObjs(src, s.x - cx, s.y - cy);
      if (v.rotate) applyRotate(origOf(copies), s.angle, s.x, s.y);
      made.push(...copies);
    }
    if (v.select) S.sel = new Set(made.map(o => o.id));
  });
  msg(`Made ${plural(spots.length, 'copy', 'copies')} along the path`, 'ok');
}
// Rubber-band outline: the shortest outline around the selection (convex hull), as a new shape on the active layer.
function rubberBand() {
  const objs = selected(); if (!objs.length) return msg('Select the shapes to wrap');
  const h = hull(objs.flatMap(o => worldPolys(o).flatMap(p => p.pts)));
  if (h.length < 3) return msg('The selection needs some width and height', 'err');
  edit(() => {
    const L = activeLayer().mode === 'image' ? (S.layers.find(l => l.mode !== 'image') || layerForColor(PALETTE[1])) : activeLayer();
    S.sel = new Set([pathFromWorld([{ closed: true, pts: h }], { layer: L.id, name: 'Rubber-band outline' }).id]);
  });
  msg('Added a rubber-band outline around the selection', 'ok');
}
// Convert to bitmap: render the selected vector shapes as a black-and-white picture on the image layer.
async function toBitmapDialog() {
  const objs = selected().filter(o => o.type !== 'image');
  if (!objs.length) return msg('Select the vector shapes to turn into a bitmap');
  if (blockLocked(objs, 'converted')) return;
  const IL = S.layers.find(l => l.mode === 'image');
  const B = settings.bitmap || { dpi: IL ? Math.round(25.4 / IL.interval) : 254, render: 'cut', stroke: 0.2 };
  const v = await formDialog('Convert to bitmap', [
    { key: 'dpi', label: 'Resolution (DPI)', type: 'number', value: B.dpi, min: 25, max: 1200, step: 1 },
    { key: 'render', label: 'Render', type: 'select', value: B.render, options: [['cut', 'Use cut settings (Fill layers filled, others as outlines)'], ['fill', 'Fill all closed shapes'], ['outline', 'Outlines only']] },
    { key: 'stroke', label: 'Outline thickness (mm)', type: 'number', value: B.stroke, min: 0.01, step: 0.05 },
    { key: 'n', type: 'note', label: 'The shapes are replaced by a picture on the image layer (Undo brings them back). It engraves with that layer\'s dither and line interval.' },
  ], { ok: 'Convert', wide: true });
  if (!v) return;
  const dpi = clamp(Math.round(v.dpi) || 254, 25, 1200), stroke = Math.max(0.01, v.stroke || 0.2);
  settings.bitmap = { dpi, render: v.render, stroke }; saveSettings();
  const b = boundsOf(objs), k = dpi / 25.4, x0 = b.minX - stroke, y0 = b.minY - stroke;
  let cvs;
  try { cvs = makeCanvas(Math.ceil((b.maxX - b.minX + 2 * stroke) * k), Math.ceil((b.maxY - b.minY + 2 * stroke) * k)); } catch (e) { return msg(e.message, 'err'); }
  const g = cvs.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cvs.width, cvs.height);
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  g.fillStyle = g.strokeStyle = '#000'; g.lineWidth = stroke; g.lineJoin = g.lineCap = 'round';
  for (const o of objs) {
    const closed = new Path2D(), open = new Path2D();
    for (const q of worldPolys(o)) {
      if (q.pts.length < 2) continue;
      const P = q.closed && q.pts.length >= 3 ? closed : open;
      P.moveTo(q.pts[0][0], q.pts[0][1]);
      for (let i = 1; i < q.pts.length; i++) P.lineTo(q.pts[i][0], q.pts[i][1]);
      if (P === closed) P.closePath();
    }
    const fill = v.render === 'fill' || (v.render === 'cut' && isFillLayer(layerById(o.layer)));
    if (fill) g.fill(closed, 'evenodd'); else g.stroke(closed);
    g.stroke(open);
  }
  const src = cvs.toDataURL('image/png'), key = uid(), w = cvs.width / k, h = cvs.height / k;
  try { await loadImage(key, src); } catch { return msg('Could not create the bitmap', 'err'); }
  let layerName = '';
  edit(() => {
    // the first Image layer, else a new one (a layer that holds cut/engrave shapes is never switched to Image mode)
    const hasShapes = col => S.objects.some(o => o.type !== 'image' && !objs.includes(o) && layerById(o.layer)?.color === col);
    const L = S.layers.find(l => l.mode === 'image')
      || layerForColor(hasShapes(PALETTE[5]) ? PALETTE.find(col => !S.layers.some(l => l.color === col)) || PALETTE[5] : PALETTE[5], 'image');
    L.mode = 'image'; layerName = L.name;
    const ids = new Set(objs.map(o => o.id));
    S.objects = S.objects.filter(o => !ids.has(o.id));
    const o = addObject({ type: 'image', name: 'Bitmap', src, imgKey: key, w, h, brightness: 100, contrast: 100, gamma: 1, invert: false, layer: L.id,
      tf: { x: x0 + w / 2, y: y0 + h / 2, sx: 1, sy: 1, r: 0 } });
    S.sel = new Set([o.id]);
  });
  msg(`Converted to a ${cvs.width} × ${cvs.height} px bitmap (${dpi} DPI) on ${layerName}`, 'ok');
}
async function closeTolDialog() {
  const objs = selected().filter(o => o.type === 'path' && o.polys.some(p => !p.closed && p.pts.length >= 3));
  if (!objs.length) return msg('No open paths selected');
  if (blockLocked(objs, 'changed')) return;
  const C = settings.closeTol || { tol: 0.5, mode: 'join' };
  const v = await formDialog('Close paths with tolerance', [
    { key: 'tol', label: 'Close when the two ends are within (mm)', type: 'number', value: C.tol, min: 0 },
    { key: 'mode', label: 'How', type: 'select', value: C.mode, options: [['join', 'Join the ends with a line'], ['move', 'Move the ends together']] },
  ], { ok: 'Close', wide: true });
  if (!v || !(v.tol >= 0)) return;
  settings.closeTol = { tol: v.tol, mode: v.mode }; saveSettings();
  let n = 0;
  const results = objs.map(o => [o, closeWithin(o.polys, v.tol, v.mode, worldPolys(o))]).filter(([, r]) => r.count);
  if (!results.length) return msg(`No open paths have ends within ${v.tol} mm`);
  edit(() => results.forEach(([o, r]) => { o.polys = r.polys; n += r.count; }));
  msg(`Closed ${plural(n, 'path', 'paths')}`, 'ok');
}
async function optimizeDialog() {
  const objs = selected().filter(o => o.type === 'path');
  if (!objs.length) return msg('Select paths to optimize (convert shapes or text to paths first)');
  if (blockLocked(objs, 'changed')) return;
  const v = await formDialog('Optimize selected shapes', [
    { key: 'tol', label: 'Tolerance (mm)', type: 'number', value: settings.optTol ?? 0.02, min: 0.001, step: 0.005 },
    { key: 'n', type: 'note', label: 'Removes repeated points and points that change the outline by less than the tolerance. Fewer points means smaller files and smoother, faster motion. BeamForge works in straight segments, so curves stay as fine segments.' },
  ], { ok: 'Optimize' });
  if (!v || !(v.tol > 0)) return;
  settings.optTol = v.tol; saveSettings();
  const count = o => o.polys.reduce((a, p) => a + p.pts.length, 0);
  const before = objs.reduce((a, o) => a + count(o), 0);
  edit(() => objs.forEach(o => {
    const s = Math.sqrt(Math.abs(o.tf.sx * o.tf.sy)) || 1; // tolerance in the path's own units
    const r = optimizePolys(o.polys, v.tol / s);
    if (r.length) o.polys = r;
  }));
  const after = objs.reduce((a, o) => a + count(o), 0);
  msg(`Optimized: ${before.toLocaleString()} → ${after.toLocaleString()} points`, 'ok');
}
// Delete duplicates: identical shapes stacked exactly on top of each other, across the whole design (as LightBurn).
// Only shapes on the same layer count (the same outline on two layers, e.g. engrave + cut, is usually deliberate);
// grouped shapes are skipped and a locked copy is always the one kept.
function deleteDuplicates() {
  const key = o => `${o.layer}|${o.type === 'image' ? `img:${o.src.length}:${o.src.slice(-48)}|` : ''}${polysKey(worldPolys(o))}`;
  const seen = new Set(), drop = new Set();
  for (const o of [...S.objects.filter(x => x.locked), ...S.objects.filter(x => !x.locked)]) {
    if (o.group) continue;
    const k = key(o);
    if (seen.has(k)) { if (!o.locked) drop.add(o.id); } else seen.add(k);
  }
  if (!drop.size) return msg('No duplicate shapes found');
  edit(() => { S.objects = S.objects.filter(o => !drop.has(o.id)); for (const id of drop) S.sel.delete(id); });
  msg(`Deleted ${plural(drop.size, 'duplicate shape', 'duplicate shapes')}`, 'ok');
}
// Replace image: a new picture in the same place. Fit keeps it inside the old box; otherwise the width stays.
let replaceTarget = null;
function replaceImage(fit) {
  const im = selected().filter(o => o.type === 'image');
  if (im.length !== 1) return msg('Select one image to replace');
  if (blockLocked(im, 'changed')) return;
  replaceTarget = { id: im[0].id, fit };
  $('#file-replace').click();
}
$('#file-replace').addEventListener('change', async e => {
  const f = e.target.files[0], t = replaceTarget; e.target.value = ''; replaceTarget = null;
  const o = t && S.objects.find(x => x.id === t.id);
  if (!f || !o) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (!(f.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext))) return msg(`${f.name} is not a picture (PNG, JPG, BMP, GIF or WebP)`, 'err');
  try {
    const src = await readFile(f, 'url'), key = uid(), img = await loadImage(key, src);
    const ar = img.naturalWidth / img.naturalHeight || 1;
    edit(() => {
      let w = o.w, h = o.w / ar;
      if (t.fit && h > o.h) { h = o.h; w = o.h * ar; }
      Object.assign(o, { src, imgKey: key, w, h, name: f.name });
    });
    msg(`Replaced the image with ${f.name}`, 'ok');
  } catch (err) { msg(`${f.name}: ${err.message}`, 'err'); }
});

// ================================================================ import
// Note: the file inputs deliberately have no `accept` filter. On KDE/GTK desktops Firefox's filtered file dialog can
// hide valid files (it may default to the first type only, and patterns are case-sensitive, hiding IMG_1.JPG).
// importFile() checks the type itself and explains what is supported.
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
    if (ext === 'svg') await importSvg(await readFile(f), f.name);
    else if (ext === 'dxf') importDxf(await readFile(f), f.name);
    else if (ext === 'plt' || ext === 'hpgl') importPlt(await readFile(f), f.name);
    else if (f.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) await importImage(await readFile(f, 'url'), f.name);
    else if (ext === 'bfp') await loadProject(JSON.parse(await readFile(f)));
    else throw new Error(`Can't import .${ext} files. Supported: SVG, DXF, PLT/HPGL, PNG, JPG, BMP, GIF, WebP (and .bfp projects).`);
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

// groups: [{polys(world mm), color, mode}]; images: [{src, key, cx, cy, w, h, r, flip}] embedded bitmaps (world mm)
function placeImported(groups, name, images = []) {
  let b = G.emptyBounds();
  for (const g of groups) b = G.boundsOfPolys(g.polys, b);
  for (const im of images) {
    const c = Math.cos(im.r * G.D2R), s = Math.sin(im.r * G.D2R), hw = im.w / 2, hh = im.h / 2;
    b = G.boundsOfPolys([{ pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [im.cx + c * x - s * y, im.cy + s * x + c * y]) }], b);
  }
  if (!G.boundsValid(b)) throw new Error('No usable shapes or images found');
  const dx = dev().bedW / 2 - (b.minX + b.maxX) / 2, dy = dev().bedH / 2 - (b.minY + b.maxY) / 2;
  const gid = groups.length + images.length > 1 ? uid() : undefined;
  edit(() => {
    S.sel.clear();
    if (images.length) {
      const IL = S.layers.find(l => l.mode === 'image') || layerForColor(PALETTE[5], 'image');
      IL.mode = 'image';
      for (const im of images) {
        const o = addObject({ type: 'image', name: images.length > 1 ? `${name} image` : name, src: im.src, imgKey: im.key, w: im.w, h: im.h,
          brightness: 100, contrast: 100, gamma: 1, invert: false, layer: IL.id, group: gid,
          tf: { x: im.cx + dx, y: im.cy + dy, sx: 1, sy: im.flip ? -1 : 1, r: im.r } });
        S.sel.add(o.id);
      }
    }
    for (const g of groups) {
      const L = g.color ? layerForColor(g.color, g.mode) : activeLayer();
      const o = pathFromWorld(g.polys.map(p => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x + dx, y + dy]) })), { name, layer: L.id, group: gid });
      S.sel.add(o.id);
    }
  });
  msg(`Imported ${name}: ${r3(b.maxX - b.minX)} × ${r3(b.maxY - b.minY)} mm${images.length ? ` (${images.length} image${images.length > 1 ? 's' : ''} — select it and use Tools → Trace image to make vectors)` : ''}`, 'ok');
}

async function importSvg(text, name) {
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
    // Embedded bitmaps (<image>): common in "SVG" files that are really a picture. Keep them so they can be traced.
    const images = [], skipped = [];
    for (const node of svg.querySelectorAll('image')) {
      if (node.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
      if (getComputedStyle(node).display === 'none') continue;
      const href = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      if (!/^data:image\//i.test(href)) { skipped.push(href.slice(0, 60) || '(empty)'); continue; }
      const m = node.getScreenCTM(); if (!m) continue;
      const x = node.x.baseVal.value, y = node.y.baseVal.value;
      let w = node.width.baseVal.value, h = node.height.baseVal.value;
      const key = uid();
      let img;
      try { img = await loadImage(key, href); } catch { skipped.push('(unreadable image data)'); continue; }
      if (!w && !h) { w = img.naturalWidth; h = img.naturalHeight; } else if (!w) w = h * img.naturalWidth / img.naturalHeight; else if (!h) h = w * img.naturalHeight / img.naturalWidth;
      // preserveAspectRatio (default xMidYMid meet): the picture is fitted inside the box, centred
      let bx = x, by = y, bw = w, bh = h;
      const par = (node.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
      if (!/^none/.test(par) && img.naturalWidth && img.naturalHeight) {
        const ar = img.naturalWidth / img.naturalHeight;
        const slice = /slice/.test(par);
        if ((w / h > ar) !== slice) { bw = h * ar; } else { bh = w / ar; }
        const al = /x(Min|Mid|Max)Y(Min|Mid|Max)/.exec(par) || [0, 'Mid', 'Mid'];
        bx = x + (w - bw) * { Min: 0, Mid: 0.5, Max: 1 }[al[1]];
        by = y + (h - bh) * { Min: 0, Mid: 0.5, Max: 1 }[al[2]];
      }
      const lcx = bx + bw / 2, lcy = by + bh / 2;
      const sx = Math.hypot(m.a, m.b) * k, sy = Math.hypot(m.c, m.d) * k;
      images.push({
        src: href, key,
        cx: (m.a * lcx + m.c * lcy + m.e - origin.left) * k, cy: (m.b * lcx + m.d * lcy + m.f - origin.top) * k,
        w: bw * sx, h: bh * sy, r: Math.atan2(m.b, m.a) / G.D2R, flip: m.a * m.d - m.b * m.c < 0,
      });
    }
    if (skipped.length && !images.length && !svg.querySelector('path, rect, circle, ellipse, line, polyline, polygon'))
      throw new Error(`The picture in this SVG is linked to a separate file (${skipped[0]}), not stored inside it. Import that picture file directly instead.`);
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
    placeImported([...groups.values()], name, images);
    if (skipped.length) msg(`${name}: ${skipped.length} linked image(s) could not be imported — import those picture files directly`, 'err');
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
// Layer settings for CNC routers.
function renderCncLayer(L, setL) {
  const op = L.cncOp || 'profile';
  const nameIn = el('input', { value: L.name }); nameIn.addEventListener('change', () => edit(() => { L.name = nameIn.value || L.name; }));
  const colIn = el('input', { type: 'color', value: L.color }); colIn.addEventListener('change', () => edit(() => { L.color = colIn.value; }));
  const passes = Math.ceil((L.depth ?? 3) / ((L.stepDown ?? 1) || (L.depth ?? 3)) - 1e-6);
  const kids = [
    el('h3', {}, 'CNC toolpath'),
    field('Name', nameIn), field('Colour', colIn),
    field('Operation', selInput(op, Object.entries(CNC_OPS), setL('cncOp'))),
  ];
  if (op === 'profile') kids.push(field('Cut', selInput(L.cncSide || 'outside', [['outside', 'Outside the line (keep the shape)'], ['inside', 'Inside the line (cut a hole)'], ['on', 'On the line']], setL('cncSide'))));
  kids.push(
    field('Tool diameter (mm)', numInput(L.toolDia ?? 3.175, setL('toolDia'), { min: 0.1 })),
    el('div', { class: 'muted small', style: 'margin:-2px 0 2px 120px' }, '1/8" = 3.175 · 1/4" = 6.35'),
    field('Cut depth (mm)', numInput(L.depth ?? 3, setL('depth'), { min: 0.01 })),
    field('Depth per pass (mm)', numInput(L.stepDown ?? 1, setL('stepDown'), { min: 0.01 })),
    el('div', { class: 'muted small', style: 'margin:-2px 0 2px 120px' }, `${passes} pass${passes === 1 ? '' : 'es'} · Z0 is the top of the material`),
    field('Feed rate (mm/min)', numInput(L.feed ?? 1000, setL('feed'), { min: 1 })),
    field('Plunge rate (mm/min)', numInput(L.plunge ?? 300, setL('plunge'), { min: 1 })),
    field('Spindle speed (RPM)', numInput(L.rpm ?? 12000, setL('rpm'), { min: 0 })));
  if (op === 'pocket') kids.push(field('Stepover (% of tool)', numInput(L.stepover ?? 40, setL('stepover'), { min: 5, max: 95 })));
  if (op === 'drill') kids.push(field('Peck depth (mm, 0 = none)', numInput(L.peck ?? 0, setL('peck'), { min: 0 })),
    el('p', { class: 'muted small' }, 'Drills one hole at the centre of each closed shape (draw small circles where you want holes).'));
  if (op !== 'drill') kids.push(field('Direction', selInput(L.climb !== false ? 'climb' : 'conv', [['climb', 'Climb (smoother finish)'], ['conv', 'Conventional (less chatter on weak machines)']], v => edit(() => { L.climb = v === 'climb'; }))));
  if (op === 'profile') {
    kids.push(check('Tabs (hold the part in place)', chkInput(L.tabs, setL('tabs'))));
    if (L.tabs) kids.push(field('Tabs per shape', numInput(L.tabCount ?? 4, setL('tabCount'), { min: 1, step: 1 })),
      field('Tab width (mm)', numInput(L.cncTabWidth ?? 6, setL('cncTabWidth'), { min: 0.5 })),
      field('Tab height (mm)', numInput(L.tabHeight ?? 1, setL('tabHeight'), { min: 0.1 })));
  }
  kids.push(field('Repeat whole layer', numInput(L.passes, v => edit(() => { L.passes = Math.max(1, Math.round(v)); }), { min: 1, step: 1 })),
    check('Coolant / dust extraction (device command)', chkInput(L.air, setL('air'))),
    el('p', { class: 'muted small' }, 'Always clamp the material, check the bit is tight, and wear eye and ear protection. Run an Air cut (Dry run) first: the spindle stays off and the bit moves above the material.'));
  const empty = !S.objects.some(o => o.layer === L.id);
  kids.push(el('div', { class: 'row gap' },
    el('button', { onclick: () => { S.sel = new Set(S.objects.filter(o => o.layer === L.id).map(o => o.id)); selectionChanged(); } }, 'Select its shapes'),
    el('button', { disabled: !empty || S.layers.length < 2, onclick: () => edit(() => { S.layers = S.layers.filter(x => x !== L); S.activeLayer = S.layers[0].id; }) }, 'Delete layer')));
  $('#layer-edit').replaceChildren(...kids);
}

function renderLayers() {
  const list = $('#layer-list');
  const counts = new Map();
  for (const o of S.objects) counts.set(o.layer, (counts.get(o.layer) || 0) + 1);
  const cur = activeLayer();
  list.replaceChildren(...S.layers.map((L, i) => {
    const out = chkInput(L.output, v => edit(() => { L.output = v; }));
    out.title = 'Output this layer';
    out.addEventListener('click', ev => ev.stopPropagation());
    const hidden = L.show === false;
    const eye = el('button', {
      class: 'eye' + (hidden ? ' off' : ''), 'aria-pressed': String(!hidden), 'aria-label': hidden ? 'Show layer' : 'Hide layer',
      title: hidden ? 'Hidden on the canvas: click to show it (it still burns while Output is on)' : 'Hide on the canvas (it still burns while Output is on)',
      onclick: ev => { ev.stopPropagation(); edit(() => setLayerShown(L, hidden)); },
    });
    eye.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/>${hidden ? '<path d="M4 4l16 16"/>' : '<circle cx="12" cy="12" r="3"/>'}</svg>`;
    const row = el('div', { class: `layer-row${L.id === cur.id ? ' active' : ''}${L.output ? '' : ' off'}${hidden ? ' hid' : ''}`, title: 'Click to edit · Shift+click selects its shapes · right-click for more' },
      el('span', { class: 'sw', style: `background:${L.color}` }),
      el('span', { class: 'nm' }, `${L.name} `, el('span', { class: 'muted small' }, `· ${counts.get(L.id) || 0}`)),
      el('span', { class: 'meta' }, isCnc(dev())
        ? `${CNC_OPS[L.cncOp || 'profile'].split(' ')[0]}${(L.cncOp || 'profile') === 'profile' ? ` ${L.cncSide || 'outside'}` : ''} ${L.depth ?? 3}mm Ø${L.toolDia ?? 3.175}`
        : `${MODE_LABEL[L.mode]} ${L.speed}mm/s ${L.power}%${L.passes > 1 ? ` ×${L.passes}` : ''}`),
      el('span', { class: 'ord' },
        el('button', { title: 'Move up (runs earlier)', disabled: i === 0, onclick: ev => { ev.stopPropagation(); edit(() => { S.layers.splice(i - 1, 0, S.layers.splice(i, 1)[0]); }); } }, '▲'),
        el('button', { title: 'Move down (runs later)', disabled: i === S.layers.length - 1, onclick: ev => { ev.stopPropagation(); edit(() => { S.layers.splice(i + 1, 0, S.layers.splice(i, 1)[0]); }); } }, '▼')),
      eye, out);
    row.addEventListener('click', ev => {
      if (ev.shiftKey) { act('sel-layer', { layerId: L.id }); return; } // LightBurn: Shift+click selects the layer's shapes
      S.activeLayer = L.id; refreshPanels();
    });
    // Shift+right-click flashes the layer (on the button press: Firefox keeps Shift+right-click for its own menu)
    row.addEventListener('pointerdown', ev => { if (ev.button === 2 && ev.shiftKey) flashLayer(L.id); });
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      if (!ev.shiftKey) openMenu(layerMenu(L), ev.clientX, ev.clientY, menuOpts());
    });
    return row;
  }));

  const L = cur, setL = k => v => edit(() => { L[k] = v; });
  if (isCnc(dev())) return renderCncLayer(L, setL);
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
    kids.push(field('Overcut (mm)', numInput(L.overcut || 0, setL('overcut'), { min: 0 })),
      field('Lead-in (mm)', numInput(L.leadIn || 0, setL('leadIn'), { min: 0 })),
      el('div', { class: 'muted small', style: 'margin:-2px 0 2px 120px' }, 'Overcut runs past the start so closed shapes fully separate. Lead-in starts the cut in the scrap so the pierce mark is not on the part. (Not used with tabs.)'));
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
  const layerField = () => field('Layer', selInput(objs.every(o => o.layer === objs[0].layer) ? objs[0].layer : '', S.layers.map(l => [l.id, `${l.name} (${MODE_LABEL[l.mode]})`]), v => edit(() => objs.forEach(o => { o.layer = v; }))));
  if (objs.some(o => o.locked)) { // locked: only the layer can change
    f.replaceChildren(
      el('div', { class: 'lockbar' }, el('span', {}, el('b', {}, 'Locked'), ' — can be selected and copied, but not moved, resized, changed or deleted.'),
        el('button', { onclick: () => act('unlock') }, 'Unlock')),
      el('h3', {}, objs.length > 1 ? `${objs.length} objects` : (objs[0].name || TYPE_LABEL[objs[0].type])),
      el('p', { class: 'muted small' }, `${r3(b.maxX - b.minX)} × ${r3(b.maxY - b.minY)} mm`),
      layerField());
    return;
  }
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
  kids.push(layerField());

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
  $('#m-z').textContent = S.m.wpos && S.m.wpos[2] != null ? S.m.wpos[2].toFixed(2) : '—';
  $('#m-zrow').hidden = !(isCnc(dev()) || dev().zEnabled);
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
  const cnc = isCnc(dev());
  $('#m-zctl').hidden = !(cnc || dev().zEnabled);
  for (const id of ['m-zeroz', 'm-probez']) $('#' + id).disabled = !S.m.connected || isRuida();
  $$('[data-jogz]').forEach(b => { b.disabled = !S.m.connected || isRuida(); });
  $('#j-dry-label').innerHTML = cnc ? '<b>Air cut</b> — spindle off, bit stays above the material' : '<b>Dry run</b> — laser off, motion only';
  if (cnc) for (const id of ['m-pulse', 'j-frame-on']) { $('#' + id).disabled = true; $('#' + id).title = 'Not used on CNC routers'; }
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
$$('[data-jogz]').forEach(b => b.addEventListener('click', guard(() => machine.send(C().jogZ(+b.dataset.jogz * Math.min(10, +$('#m-step').value), Math.min(1000, +$('#m-jogf').value || 600))))));
$('#m-zeroz').addEventListener('click', guard(async () => {
  if (await confirmDialog('Set Z zero here?', 'The current height becomes Z0 — this should be the top of the material (touch the bit on it first).', 'Set Z0')) await machine.send(C().zeroZ);
}));
$('#m-probez').addEventListener('click', guard(async () => {
  const t = dev().probePlate ?? 0;
  if (await confirmDialog('Probe Z?', `Put the touch plate (${t} mm thick, set in the device settings) under the bit and attach the clip. The bit moves down slowly until it touches the plate (up to 30 mm), then Z is set and it lifts 5 mm.`, 'Probe')) await machine.send(C().probeZ(t));
}));
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
  const only = jobOpts().selectedIds, hiddenOut = S.layers.filter(L => L.output && L.show === false && S.objects.some(o => o.layer === L.id && (!only || only.has(o.id))));
  const hiddenNote = hiddenOut.length ? ` Hidden layer${hiddenOut.length > 1 ? 's' : ''} ${hiddenOut.map(L => `“${L.name}”`).join(', ')} will run too (Output is on).` : '';
  const cnc = isCnc(dev());
  const safety = cnc
    ? (dry ? ' Air cut: the spindle stays off and every move is lifted above the material.' : ' Check: material clamped, bit tight, Z0 set on the material top, spindle on (if it is not controlled by the machine), eye and ear protection on. Keep a hand near the emergency stop.')
    : (dry ? ' The laser will not fire; the head just traces the job.' : ' Make sure the material is in place, the lid is closed and you are wearing laser-safe eyewear. Never leave a running laser unattended.');
  const ok = await confirmDialog(dry ? (cnc ? 'Start AIR CUT (spindle off)?' : 'Start DRY RUN (laser off)?') : 'Start job?',
    `${dev().name}: ${job.stats.lines.toLocaleString()} ${isRuida() ? 'moves' : 'lines'} · estimated ${fmtTime(job.stats.time)}.${hiddenNote}${safety}${ruidaNote}`, dry ? (cnc ? 'Start air cut' : 'Start dry run') : 'Start');
  if (!ok) return;
  if (isRuida()) await machine.ruidaJob(job.ruida); else await machine.job(job.gcode);
  if (dry) { log('Dry run started (laser off)', 'sys'); return; }
  log(`Job started: ${job.stats.lines} lines`, 'sys');
  if (settings.serialAuto && S.objects.some(o => o.type === 'text' && /\{serial/.test(o.text))) {
    settings.serial += 1; textVars.serial = settings.serial; saveSettings(); changed();
  }
  if (textVars.csv && settings.csvAuto !== false && S.objects.some(o => o.type === 'text' && /\{(csv|col):/.test(o.text))) {
    if (textVars.csvRow < textVars.csv.rows.length - 1) { textVars.csvRow = settings.csvRow = textVars.csvRow + 1; saveSettings(); changed(); msg(`CSV: now on row ${textVars.csvRow + 1} of ${textVars.csv.rows.length}`); }
    else msg('CSV: that was the last row', 'err');
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
window.beamforge = { S, settings, dev, machine, traceDialog, selectDevice, buildJob, addObject, edit, importSvg, importImage, importPlt, act, setTool, makeLayer, layerForColor, PALETTE, selectionChanged, ACTIONS,
  toScreen, toWorld, openCanvasMenu, isMenuOpen, closeMenu, worldPolys, objBounds, refreshPanels };

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
