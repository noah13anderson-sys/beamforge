// Laser controller profiles and machine-coordinate mapping.
//
// family  — how the server talks to it (grbl: character-counting + realtime '?', smoothie: ping-pong + '?',
//           marlin: ping-pong + M114 polling)
// power   — how laser power is expressed in G-code
//           M4: dynamic power (scales with speed), M3: constant power, M3I: Marlin inline (M3 I),
//           inline: S on every G1, no M3/M5 (Smoothieware)
export const DEVICE_TYPES = {
  grbl: { label: 'GRBL 1.1+ (laser mode)', family: 'grbl', power: 'M4', sMax: 1000, baud: 115200 },
  'grbl-m3': { label: 'GRBL-M3 (constant power)', family: 'grbl', power: 'M3', sMax: 1000, baud: 115200 },
  grblhal: { label: 'grblHAL', family: 'grbl', power: 'M4', sMax: 1000, baud: 115200 },
  fluidnc: { label: 'FluidNC', family: 'grbl', power: 'M4', sMax: 1000, baud: 115200 },
  'grbl-lpc': { label: 'GRBL-LPC', family: 'grbl', power: 'M4', sMax: 1000, baud: 115200 },
  smoothie: { label: 'Smoothieware', family: 'smoothie', power: 'inline', sMax: 1, baud: 115200 },
  marlin: { label: 'Marlin 2.x (laser feature)', family: 'marlin', power: 'M3I', sMax: 255, baud: 250000 },
  ruida: { label: 'Ruida DSP (RDC644x/654x) — beta', family: 'ruida', power: 'ruida', sMax: 100, baud: 115200, origin: 'tr' },
  // CNC routers: S is spindle RPM (GRBL $30 should be the spindle's max RPM, $32=0).
  'cnc-grbl': { label: 'CNC router — GRBL / grblHAL / FluidNC', family: 'grbl', power: 'spindle', kind: 'cnc', sMax: 24000, baud: 115200 },
  'cnc-gcode': { label: 'CNC router — generic G-code (save file for Mach3 / LinuxCNC / UCCNC)', family: 'grbl', power: 'spindle', kind: 'cnc', sMax: 24000, baud: 115200 },
};
export const isCnc = cfg => (DEVICE_TYPES[cfg?.type] || {}).kind === 'cnc';

export const ORIGINS = [['bl', 'Front-left'], ['tl', 'Rear-left'], ['tr', 'Rear-right'], ['br', 'Front-right']];

const uid = () => Math.random().toString(36).slice(2, 10);

export function makeDevice(type = 'grbl', over = {}) {
  const t = DEVICE_TYPES[type] || DEVICE_TYPES.grbl;
  return {
    id: uid(), name: t.label, type,
    bedW: 400, bedH: 400, origin: t.origin || 'bl', sMax: t.sMax, baud: String(t.baud), port: 'virtual',
    host: '192.168.1.100', magic: 0x88, powerLimit: 100, safeZ: 5, spinUp: 3, probePlate: 0,
    travel: 100, air: 'M8', returnHome: true, zEnabled: false,
    rotary: false, rotaryType: 'roller', rotaryMmPerRot: 100, rotaryRollerDia: 20, rotaryObjectDia: 80,
    macros: [],
    ...(t.kind === 'cnc' ? { bedW: 600, bedH: 400, air: 'none', travel: 50 } : {}),
    ...over,
  };
}

export const family = cfg => (DEVICE_TYPES[cfg.type] || DEVICE_TYPES.grbl).family;
export const profile = cfg => DEVICE_TYPES[cfg.type] || DEVICE_TYPES.grbl;

// Design space: millimetres, origin at the bed's rear-left as seen on screen, Y pointing toward the front.
export function toMachine(cfg, x, y) {
  const right = cfg.origin === 'tr' || cfg.origin === 'br';
  const front = cfg.origin === 'bl' || cfg.origin === 'br';
  return [right ? cfg.bedW - x : x, front ? cfg.bedH - y : y];
}
// Rotary attachments replace the Y axis: scale Y so the surface of the work moves the right distance.
export function rotaryScale(cfg) {
  if (!cfg.rotary) return 1;
  const d = cfg.rotaryType === 'chuck' ? cfg.rotaryObjectDia : cfg.rotaryRollerDia;
  return d > 0 && cfg.rotaryMmPerRot > 0 ? cfg.rotaryMmPerRot / (Math.PI * d) : 1;
}
export function mapToMachine(cfg, x, y) {
  const [mx, my] = toMachine(cfg, x, y);
  return [mx, my * rotaryScale(cfg)];
}
export function machineToDesign(cfg, mx, my) {
  return toMachine(cfg, mx, my / rotaryScale(cfg));
}

// Jog arrows move the head in screen directions (right / toward the back) whatever the origin corner is.
export function screenToMachineDelta(cfg, dRight, dBack) {
  const right = cfg.origin === 'tr' || cfg.origin === 'br';
  const front = cfg.origin === 'bl' || cfg.origin === 'br';
  return [right ? -dRight : dRight, front ? dBack : -dBack];
}

// Controller-specific commands.
export function commands(cfg) {
  const fam = family(cfg), p = profile(cfg);
  const S = pct => {
    const v = Math.max(0, Math.min(100, pct)) / 100 * cfg.sMax;
    return cfg.sMax <= 1 ? (Math.round(v * 1000) / 1000).toString() : String(Math.round(v));
  };
  return {
    S,
    jog: (dx, dy, f) => fam === 'grbl' ? `$J=G91 G21 X${dx} Y${dy} F${f}` : `G91\nG0 X${dx} Y${dy} F${f}\nG90`,
    jogZ: (dz, f) => fam === 'grbl' ? `$J=G91 G21 Z${dz} F${f}` : `G91\nG0 Z${dz} F${f}\nG90`,
    zeroZ: fam === 'grbl' ? 'G10 L20 P1 Z0' : 'G92 Z0',
    // Touch plate: probe down, set Z to the plate thickness, back off 5 mm.
    probeZ: plate => `G91\nG38.2 Z-30 F100\nG90\n${fam === 'grbl' ? `G10 L20 P1 Z${plate}` : `G92 Z${plate}`}\nG91\nG0 Z5\nG90`,
    home: fam === 'marlin' ? 'G28 X Y' : '$H',
    unlock: fam === 'grbl' ? '$X' : 'M999',
    setOrigin: fam === 'grbl' ? 'G10 L20 P1 X0 Y0' : 'G92 X0 Y0',
    goOrigin: 'G90\nG0 X0 Y0',
    goTo: (x, y) => `G90\nG0 X${x.toFixed(3)} Y${y.toFixed(3)}`,
    // Returns [{lines, delay}] steps. Smoothie uses its console `fire` command.
    pulse: (pct, ms) => {
      if (fam === 'smoothie') return [{ lines: `fire ${Math.max(0.1, pct)}` }, { delay: ms, lines: 'fire off' }];
      if (fam === 'marlin') return [{ lines: `M3 S${S(pct)}\nG4 P${Math.round(ms)}\nM5` }];
      return [{ lines: `M3 S${S(pct)}\nG4 P${(ms / 1000).toFixed(2)}\nM5 S0` }];
    },
    beamOn: p.power === 'M3I' ? 'M3 I' : p.power === 'inline' ? null : 'M3',
    beamOff: p.power === 'inline' ? null : 'M5',
    settings: fam === 'grbl' ? '$$' : fam === 'marlin' ? 'M503' : null,
  };
}

// Descriptions of GRBL $ settings (from the public GRBL 1.1 documentation).
export const GRBL_SETTINGS = {
  0: 'Step pulse time (µs)', 1: 'Step idle delay (ms)', 2: 'Step pulse invert (mask)', 3: 'Direction invert (mask)',
  4: 'Invert step enable', 5: 'Invert limit pins', 6: 'Invert probe pin', 10: 'Status report options (mask)',
  11: 'Junction deviation (mm)', 12: 'Arc tolerance (mm)', 13: 'Report in inches', 20: 'Soft limits enable',
  21: 'Hard limits enable', 22: 'Homing cycle enable', 23: 'Homing direction invert (mask)', 24: 'Homing locate feed (mm/min)',
  25: 'Homing search seek (mm/min)', 26: 'Homing debounce (ms)', 27: 'Homing pull-off (mm)', 30: 'Max laser power S',
  31: 'Min laser power S', 32: 'Laser mode enable', 100: 'X steps/mm', 101: 'Y steps/mm', 102: 'Z steps/mm',
  110: 'X max rate (mm/min)', 111: 'Y max rate (mm/min)', 112: 'Z max rate (mm/min)', 120: 'X acceleration (mm/s²)',
  121: 'Y acceleration (mm/s²)', 122: 'Z acceleration (mm/s²)', 130: 'X max travel (mm)', 131: 'Y max travel (mm)', 132: 'Z max travel (mm)',
};
