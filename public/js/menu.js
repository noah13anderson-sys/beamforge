// Pop-up menus with submenus and keyboard control — used for the menu bar and the right-click menus.
//
// An item is '-' (separator), { heading: 'Text' }, null (skipped), or
//   { label, kbd, run, disabled, checked, radio, swatch, sub, hidden, title }
//   disabled  false, true, or a string saying why (shown as a tooltip)
//   checked   true/false shows a tick (radio: true shows a dot); leave undefined for a plain item
//   sub       an item list (or a function returning one) shown as a submenu
//   swatch    a CSS colour shown in front of the label
//
// openMenu(items, x, y, { anchor, keyboard, onClose, onLeft, onRight, onError })
//   anchor    element to drop the menu below (menu bar) instead of opening at x, y
//   keyboard  focus the first item (menu opened from the keyboard)
//   onLeft/onRight  arrow keys at the top level (switch menu-bar menus)

const levels = []; // open menus, root first: { el, rows: [{ it, row, dis }], active, parentLevel, parentIdx }
let opts = {};
let timer = 0;
let openedAt = 0, openX = 0, openY = 0;

export const isMenuOpen = () => levels.length > 0;
export const menuAnchor = () => (levels.length ? opts.anchor || null : null);

export function closeMenu() {
  clearTimeout(timer);
  if (!levels.length) return;
  for (const l of levels) l.el.remove();
  levels.length = 0;
  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('wheel', onWheel, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  const cb = opts.onClose;
  opts = {};
  cb?.();
}

export function openMenu(items, x, y, o = {}) {
  closeMenu();
  opts = o;
  const lvl = build(items);
  if (!lvl) { opts = {}; return; }
  openedAt = performance.now(); openX = x; openY = y;
  place(lvl.el, x, y, o.anchor);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('wheel', onWheel, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  if (o.keyboard) move(lvl, 1);
  else lvl.el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- building
const isRow = it => it && it !== '-' && !it.heading;
function tidy(list) {
  const out = [];
  for (const it of list) {
    if (!it || it.hidden) continue;
    const prev = out[out.length - 1];
    if (it === '-' && (!prev || prev === '-' || prev.heading)) continue;
    out.push(it);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

function build(raw, parentLevel = null, parentIdx = -1) {
  const items = tidy((typeof raw === 'function' ? raw() : raw) || []);
  if (!items.some(isRow)) return null;
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const lvl = { el, rows: [], active: -1, parentLevel, parentIdx };
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'ctx-sep'; s.setAttribute('role', 'separator'); el.append(s); continue; }
    if (it.heading) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = it.heading; h.title = it.heading; el.append(h); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item';
    row.tabIndex = -1;
    row.setAttribute('role', it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox');
    if (it.checked !== undefined) row.setAttribute('aria-checked', String(!!it.checked));
    const dis = !!it.disabled;
    if (dis) { row.classList.add('disabled'); row.setAttribute('aria-disabled', 'true'); }
    const tip = typeof it.disabled === 'string' ? it.disabled : it.title;
    if (tip) row.title = tip;
    if (it.sub && !dis && Array.isArray(it.sub) && !tidy(it.sub).some(s => isRow(s) && !s.disabled)) row.classList.add('dim');
    const mark = document.createElement('span');
    mark.className = 'ctx-mark';
    if (it.swatch) { mark.classList.add('sw'); mark.style.background = it.swatch; } else if (it.checked) mark.textContent = it.radio ? '●' : '✓';
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = it.label;
    const kbd = document.createElement('kbd');
    kbd.textContent = it.kbd || '';
    const arrow = document.createElement('span');
    arrow.className = 'ctx-arrow';
    arrow.textContent = it.sub ? '›' : '';
    row.append(mark, label, kbd, arrow);
    if (it.sub) { row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false'); }
    const idx = lvl.rows.push({ it, row, dis }) - 1;
    row.addEventListener('pointerenter', () => hover(lvl, idx));
    row.addEventListener('click', ev => { ev.stopPropagation(); activate(lvl, idx, false); });
    // press the right button on the canvas, drag onto an item and let go: picks it (like native menus)
    row.addEventListener('pointerup', ev => {
      if (ev.button === 2 && (performance.now() - openedAt > 350 || Math.hypot(ev.clientX - openX, ev.clientY - openY) > 6)) activate(lvl, idx, false);
    });
    el.append(row);
  }
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerenter', () => {
    clearTimeout(timer); // reached the submenu: keep it open
    if (lvl.parentLevel) setActive(lvl.parentLevel, lvl.parentIdx, false);
  });
  document.body.append(el);
  levels.push(lvl);
  return lvl;
}

// ---------------------------------------------------------------- placement
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function place(el, x, y, anchor) {
  const m = 4, vw = innerWidth, vh = innerHeight;
  el.style.maxHeight = `${vh - 2 * m}px`;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = x, top = y;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    left = r.left; top = r.bottom + 4;
    if (top + h > vh - m) top = vh - m - h;
  } else {
    if (left + w > vw - m) left = x - w; // open toward the free side of the cursor
    if (top + h > vh - m) top = y - h;
  }
  el.style.left = `${clampN(left, m, Math.max(m, vw - m - w))}px`;
  el.style.top = `${clampN(top, m, Math.max(m, vh - m - h))}px`;
}
function placeSub(el, r) {
  const m = 4, vw = innerWidth, vh = innerHeight;
  el.style.maxHeight = `${vh - 2 * m}px`;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.right - 3;
  if (left + w > vw - m) left = r.left - w + 3;
  el.style.left = `${clampN(left, m, Math.max(m, vw - m - w))}px`;
  el.style.top = `${clampN(r.top - 5, m, Math.max(m, vh - m - h))}px`;
}

// ---------------------------------------------------------------- behaviour
function setActive(lvl, idx, focus = true) {
  const old = lvl.rows[lvl.active];
  if (old) old.row.classList.remove('active');
  lvl.active = idx;
  const r = lvl.rows[idx];
  if (!r) return;
  r.row.classList.add('active');
  if (focus) r.row.focus({ preventScroll: true });
  r.row.scrollIntoView?.({ block: 'nearest' });
}
function closeFrom(depth) {
  while (levels.length > depth) {
    const l = levels.pop();
    l.el.remove();
    const p = l.parentLevel && l.parentLevel.rows[l.parentIdx];
    if (p) { p.row.classList.remove('open'); p.row.setAttribute('aria-expanded', 'false'); }
  }
}
function hover(lvl, idx) {
  clearTimeout(timer);
  const d = levels.indexOf(lvl);
  if (d < 0) return;
  setActive(lvl, idx);
  const r = lvl.rows[idx], child = levels[d + 1];
  if (child && child.parentIdx === idx) return; // its submenu is already open
  // short delay so the pointer can cross other items on its way to an open submenu
  timer = setTimeout(() => {
    closeFrom(d + 1);
    if (r.it.sub && !r.dis) openSub(lvl, idx, false);
  }, child ? 230 : 120);
}
function openSub(lvl, idx, keyboard) {
  const d = levels.indexOf(lvl);
  if (d < 0) return;
  closeFrom(d + 1);
  const r = lvl.rows[idx];
  const child = build(r.it.sub, lvl, idx);
  if (!child) return;
  r.row.classList.add('open');
  r.row.setAttribute('aria-expanded', 'true');
  placeSub(child.el, r.row.getBoundingClientRect());
  if (keyboard) move(child, 1);
}
function activate(lvl, idx, keyboard) {
  const r = lvl.rows[idx];
  if (!r || r.dis) return;
  if (r.it.sub) { openSub(lvl, idx, keyboard); return; }
  const run = r.it.run, onError = opts.onError;
  closeMenu();
  if (!run) return;
  try {
    const p = run();
    if (p && typeof p.catch === 'function') p.catch(e => onError?.(e));
  } catch (e) { if (onError) onError(e); else throw e; }
}
// Step to the next enabled item (wrapping). from = -1 starts before the first / after the last item.
function move(lvl, dir, from = lvl.active) {
  const n = lvl.rows.length;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (!lvl.rows[i].dis) { setActive(lvl, i); return; }
  }
}
function back() {
  const l = levels[levels.length - 1];
  const p = l.parentLevel, i = l.parentIdx;
  closeFrom(levels.length - 1);
  if (p) setActive(p, i);
}
function onKey(e) {
  const lvl = levels[levels.length - 1];
  if (!lvl) return;
  const k = e.key;
  const take = () => { e.preventDefault(); e.stopPropagation(); };
  clearTimeout(timer);
  switch (k) {
    case 'Escape': take(); if (levels.length > 1) back(); else closeMenu(); return;
    case 'ArrowDown': take(); move(lvl, 1); return;
    case 'ArrowUp': take(); move(lvl, -1); return;
    case 'Home': take(); move(lvl, 1, -1); return;
    case 'End': take(); move(lvl, -1, -1); return;
    case 'ArrowRight': {
      take();
      const r = lvl.rows[lvl.active];
      if (r && r.it.sub && !r.dis) openSub(lvl, lvl.active, true); else opts.onRight?.();
      return;
    }
    case 'ArrowLeft': take(); if (levels.length > 1) back(); else opts.onLeft?.(); return;
    case 'Enter': case ' ': take(); if (lvl.active >= 0) activate(lvl, lvl.active, true); return;
    case 'Tab': take(); closeMenu(); return;
    case 'ContextMenu': take(); closeMenu(); return;
  }
  if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { // jump to the next item starting with that letter
    take();
    const n = lvl.rows.length, c = k.toLowerCase();
    for (let s = 1; s <= n; s++) {
      const i = (lvl.active + s + n) % n, r = lvl.rows[i];
      if (!r.dis && r.it.label.toLowerCase().startsWith(c)) { setActive(lvl, i); return; }
    }
    return;
  }
  // anything else (e.g. Ctrl+Z): close the menu and let the app handle the key
  if (!['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(k)) closeMenu();
}
function onOutside(e) {
  if (levels.some(l => l.el.contains(e.target))) return;
  if (opts.anchor && opts.anchor.contains(e.target)) return; // the menu-bar button toggles its own menu
  closeMenu();
  // a click on the drawing just closes the menu (it doesn't also deselect or start a drag)
  if (e.target instanceof HTMLCanvasElement) e.stopPropagation();
}
function onWheel(e) { if (!levels.some(l => l.el.contains(e.target))) closeMenu(); }
