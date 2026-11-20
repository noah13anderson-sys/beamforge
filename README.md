# BeamForge

An original laser-engraver design **and** control app — one program to draw, prepare and run jobs on G-code
lasers (GRBL, Smoothieware, Marlin) and Ruida DSP CO₂ controllers. Design runs in the browser; a small local
Node.js server talks to the laser over USB or the network. No npm packages are needed.

> **Ruida support is new and has only been tested against the built-in virtual controller.**
> Before cutting on a real Ruida machine, follow the [first-run checklist](#first-run-on-a-ruida-machine-eg-genesis-g139l).

## Run

```bash
./beamforge          # starts the server (if needed) and opens http://localhost:8787
```

Requires Node.js 18+ and a modern browser. Pick **Virtual laser** in the Laser tab to try everything without hardware.

## Supported controllers

| Controller | Connection | Notes |
|---|---|---|
| GRBL 1.1+, GRBL-M3, grblHAL, FluidNC, GRBL-LPC | USB serial | M4 dynamic / M3 constant power, character-counting streaming, realtime status/hold/reset |
| Smoothieware | USB serial | S 0.0–1.0 on each G1, one line at a time, `fire` test pulse |
| Marlin 2.x | USB serial | `M3 I` inline laser power (S 0–255), M114 position, M410 quick-stop |
| **Ruida DSP** (RDC644x / 654x / 634x) — beta | **Network (UDP 50200/40200)** or USB | Job upload with checksums, live position/status, jog, frame, home, pause/resume/stop, RD file export |

Set up any number of machines under **Laser → Devices** (work area, origin corner, power limit, air-assist M-code,
Z axis, baud, Ruida IP address and swizzle key) and switch between them from the top-right drop-down.

## First run on a Ruida machine (e.g. Genesis G139L)

1. On the laser's panel, find its IP address (network settings). Connect the laser and PC to the same network.
2. **Laser → Devices → Add device → Ruida DSP.** Enter the work area (G139L: 1300 × 900 mm), the IP address, and
   set **Power limit** to 20 % for the first tests. Origin: *Rear-right* is the Ruida default.
3. Close LaserWorks/RDWorks (they use the same network port), then **Connect**. The Console should report
   *"Ruida controller found (card ID …)"* and the X/Y readout should match the panel. If it doesn't answer,
   try the other swizzle key in the device settings.
4. Jog with the arrows, then **Frame** — check the head traces where you expect on the bed.
5. Tick **Dry run** and press **Start**: the head follows the whole job with the laser off.
6. Untick Dry run and cut a small square on scrap at low power. Only then raise the power limit.

Alternative that skips the network entirely: **File → Save** writes a `.rd` file you can run from a USB stick on
the laser's panel.

## Features

**Design** — rectangle, ellipse, polygon/star, polyline, text (any installed font; variable text `{serial}`,
`{serial:4}`, `{date}`, `{time}`, `{year}`, `{month}`, `{day}`), node editing, measure tool, handles for
move/scale/rotate, numeric position/size/rotation, snap to grid, undo/redo.

**Trace image** (live preview) — brightness band (cutoff → threshold), sketch/edge tracing, PNG transparency;
ignore small specks, smoothness, optimize, detail, fade preview, delete image after tracing.

**Arrange** (Arrange menu and the icon bar at the top of the Shape tab) — group/ungroup; align left/right/top/bottom/centres
to the selection, the first-selected object or the bed; distribute by equal gaps or by centres, set exact spacing, make same
width/height/size; mirror horizontally/vertically/both, mirror a copy, mirror across a line at any angle; centre on bed,
rotate 90°, grid array, circular array.

**Shape tools** — weld, subtract, intersect, exclude, offset (round/sharp/bevel), fillet (round) and chamfer corners, convert to path, break apart,
auto-join, close paths.

**Import / export** — SVG, DXF, HPGL/PLT, PNG/JPG/BMP/GIF/WebP; export SVG, DXF, G-code, Ruida RD files.

**Cut layers** — Line, Fill, Offset fill, Image; speed, power, passes, air assist, output on/off, run order,
constant-power override, Z offset/step per pass. Line: kerf compensation, tabs, perforation, holes before outlines.
Fill: interval, overscan, bi-directional, angle, cross-hatch, one-shape-at-a-time. Image: Floyd–Steinberg, Jarvis,
Stucki, Atkinson, ordered, halftone, threshold, grayscale (G-code devices); brightness, contrast, gamma, invert.

**Material library** — save/apply/import/export layer presets. **Material test** generator (power × speed grid with labels).

**Production** — QR codes (any text/link, 4 error-correction levels), CSV merge for variable text (`{csv:Name}`, `{col:2}`,
auto-advance per job), pack parts onto the bed, **print and cut** (align the design to two printed registration marks,
with optional scale correction), overcut and lead-in for clean closed cuts.

**Machine** — connect, live position, jog in screen directions, home, unlock, set/go to origin, go to selection,
test fire, macros, GRBL `$$` editor, frame (box or rubber-band), **dry run**, **power limit**, refuses cuts outside
the work area (Ruida), start from absolute coords, current position or a saved **user origin** (with job anchor), rotary, pause/resume/stop, console (hex bytes for
Ruida).

## Not supported

Trocen, TopWisdom and EZCad/BJJCZ galvo controllers; camera alignment; true-shape nesting (packing uses bounding boxes).

## Safety

Lasers start fires and cause permanent eye damage. Wear eyewear rated for your laser's wavelength, keep an
extinguisher nearby, ventilate fumes, never cut PVC/vinyl (chlorine gas), and never leave a running job unattended.
This is hobby software provided as-is; check every job with Frame and Dry run before cutting.

## Development

```bash
node server.js                 # BEAMFORGE_PORT=8787 by default
```

- `server.js` — HTTP + Server-Sent Events, serial transport, GRBL/Smoothie/Marlin streaming, virtual GRBL
- `ruida-server.js` — Ruida UDP/USB transport, request/ACK engine, status polling, job upload, virtual Ruida
- `public/js/ruida.js` — Ruida command encoding, swizzling, packets, RD job encoder
- `public/js/devices.js` — controller profiles, coordinate mapping, rotary, controller commands
- `public/js/gcode.js` — job generation (G-code and Ruida), path ordering, kerf/tabs/perforation, fills, images
- `public/js/ops.js` — offsets, booleans, concentric fill, tabs, dashes, hull, auto-join
- `public/js/geom.js` — matrices, shapes, SVG path / DXF parsing, simplification
- `public/js/raster.js` — contour tracing, image trace, text outlines, dithering, gamma
- `public/js/shapes.js`, `public/js/app.js`, `public/js/machine.js` — objects, editor UI, server client

## Credits

- Polygon clipping: [Clipper](http://www.angusj.com/) by Angus Johnson, Boost Software License 1.0 (`public/vendor/clipper.js`).
- The Ruida protocol was implemented from public notes: the EduTech Wiki *Ruida* page, the
  [jnweiger/ruida-laser](https://github.com/jnweiger/ruida-laser) documentation and the command table documented by
  the MIT-licensed [MeerK40t](https://github.com/meerk40t/meerk40t) project. No code was copied.
- BeamForge is independent and is not affiliated with LightBurn, Ruida, LaserWorks or any laser manufacturer.
