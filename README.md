# BeamForge

An original laser-engraver design **and** control app — one program to draw, prepare and run jobs on G-code
lasers (GRBL, Smoothieware, Marlin), Ruida DSP CO₂ controllers and **CNC routers** (GRBL / grblHAL / FluidNC). Design runs in the browser; a small local
Node.js server talks to the laser over USB or the network. No npm packages are needed.

> **Ruida support is new and has only been tested against the built-in virtual controller.**
> Before cutting on a real Ruida machine, follow the [first-run checklist](#first-run-on-a-ruida-machine-eg-genesis-g139l).

## Run

```bash
./beamforge          # opens BeamForge in its own app window
```

BeamForge runs as a desktop app: its own window (GTK + WebKit), normal Open/Save dialogs, and no browser tabs or
address bar. Requires Node.js 18+ and WebKitGTK with Python bindings (Arch: `pacman -S webkit2gtk-4.1 python-gobject`).
If those are missing, or with `BEAMFORGE_BROWSER=1 ./beamforge`, it opens in Firefox at http://localhost:8787 instead.
Closing the window never stops a running job. `BEAMFORGE_DEVTOOLS=1` turns on the web inspector (right-click → Inspect). Pick **Virtual laser** in the Laser tab to try everything without hardware.

## Supported controllers

| Controller | Connection | Notes |
|---|---|---|
| GRBL 1.1+, GRBL-M3, grblHAL, FluidNC, GRBL-LPC | USB serial | M4 dynamic / M3 constant power, character-counting streaming, realtime status/hold/reset |
| Smoothieware | USB serial | S 0.0–1.0 on each G1, one line at a time, `fire` test pulse |
| Marlin 2.x | USB serial | `M3 I` inline laser power (S 0–255), M114 position, M410 quick-stop |
| **Ruida DSP** (RDC644x / 654x / 634x) — beta | **Network (UDP 50200/40200)** or USB | Job upload with checksums, live position/status, jog, frame, home, pause/resume/stop, RD file export |

| **CNC router** — GRBL, grblHAL, FluidNC | USB serial | Profile / pocket / engrave / drill toolpaths, spindle RPM, Z probing; generic G-code export for Mach3 / LinuxCNC / UCCNC |

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

## CNC routers

Add a device of type **CNC router**. On a CNC device the Cuts tab shows router settings instead of laser settings:

- **Operations:** Profile (outside the line to keep the shape, inside to cut a hole, or on the line), Pocket (clears the
  inside of closed shapes), Engrave (follows the line at depth), Drill (one hole at the centre of each closed shape,
  with optional pecking).
- **Settings per layer:** tool diameter, cut depth, depth per pass, feed and plunge rate, spindle RPM, stepover for
  pockets, climb or conventional milling, tabs (count, width, height), coolant/dust command.
- Shapes inside other shapes are treated as holes, so an outside profile of a part keeps its holes the right size.
- Layers with different tool diameters insert a **tool-change pause** (M5 + M0): fit the new bit, re-zero Z, press Resume.
- **Air cut** (the Dry run box) runs the whole job with the spindle off and every move lifted above the material.
- Machine panel: Z jog, **Zero Z** (Z0 = top of the material), **Probe Z** with a touch plate (thickness in the device
  settings), Z readout. Frame lifts to the safe height first.
- Controller setup: GRBL `$32=0` (laser mode off) and `$30` = your spindle's max RPM.

Always clamp the material, check the bit is tight, wear eye and ear protection, and run an air cut first.

## Features

**Design** — rectangle, ellipse, polygon/star, polyline, text (any installed font; variable text `{serial}`,
`{serial:4}`, `{date}`, `{time}`, `{year}`, `{month}`, `{day}`), node editing, measure tool, handles for
move/scale/rotate, numeric position/size/rotation, snap to grid, undo/redo.

**Trace image** (live preview) — first choose **Outline** (2 lines: one along each side of every line in the picture)
or **Center line** (1 line down the middle of each line: for line drawings, sketches, cartoon outlines and single-line
engraving; dots keep their outline, and the lines go on a Line layer). **Auto trace** looks at the picture and picks
the mode, threshold and clean-up (dark on light or light on dark, white logos on transparent PNGs, speckled scans);
with Center line it picks out the picture's lines — on coloured artwork with dark outlines, just the outlines — or,
when there are no clear lines, one line along each edge. Then adjust anything and press Trace.
Zoom into the preview to check the detail: scroll to zoom, drag to move around, double-click to zoom in or back out,
or + / − / 0 and the arrow keys. The preview refines to the exact final trace in the background. Brightness band
(cutoff → threshold), sketch/edge tracing (Sketch follows edges, so with Center line a thick line still gets a line on
each side; Brightness puts one down its middle), PNG transparency; ignore small specks,
smoothness (sharp corners stay sharp), optimize, detail, fade preview, delete image after tracing. Outlines land on the
picture's edges to within a fraction of a pixel, so traced parts come out the right size. The result is a group of
pieces (each outline with its holes, or each connected set of lines): Ctrl+U ungroups them to edit them one by one.

**Right-click menus** (like LightBurn's) — right-click a shape to select it and get Cut / Copy / Duplicate / Paste
(lands where you clicked) / Paste in place / Delete, plus submenus for Select, Flip & rotate, Align, Distribute & size,
Move, Draw order, Path tools, Boolean & offset, Array & copy, Image, Move to layer and Laser (move the laser here, set the
user origin here). Items that can't be used right now are greyed out, and hovering one says why. Right-click empty space
to paste, select, add text or import. In Edit nodes mode, right-click a point or line for node tools. While drawing a line,
right-click to finish, close or undo the last point. In the Cuts list, right-click a layer to switch its output or
visibility, select or flash its shapes, or sort cuts last (Shift+right-click flashes it). The Menu key or Shift+F10 opens
the menu from the keyboard.

**Arrange** (Arrange menu, right-click menu and the icon bar at the top of the Shape tab) — group/ungroup, auto-group
(each outer shape with the shapes inside it), lock/unlock (locked shapes can be selected and copied but not moved,
changed or deleted); align left/right/top/bottom/centres to the selection, the first-selected object or the bed;
distribute by equal gaps or by centres, move together, set exact spacing, make same width/height/size; mirror
horizontally/vertically/both, mirror a copy, mirror across a line at any angle; rotate 90°/180°/any angle; move to the
bed centre, corners or edges, to the laser position or by a distance; dock against other shapes or the bed edge; draw
order (front/forward/backward/back); grid array, circular array, copy along a path, rubber-band outline.

**Trim** (scissors in the toolbar, Ctrl+K, like LightBurn's Trim Shapes) — click a line to cut it back to where it
crosses other lines; a line that crosses nothing is removed. Hover to see in red what will go. The pieces left over are
joined where they used to cross (so trimming the inside of two overlapping shapes leaves one outline round both);
Ctrl+click doesn't join, Shift+click keeps a copy of the cut piece on the current layer. Grouped shapes need
ungrouping first.

**Shape tools** — weld, subtract, intersect, exclude, offset (round/sharp/bevel), fillet (round) and chamfer corners, convert to path,
convert to bitmap, break apart, auto-join, close paths (also with a gap tolerance), optimize (fewer points), delete
duplicates; select open shapes, open shapes on fill layers, shapes inside the selection, or shapes smaller than the
selection; replace an image keeping its place. Layers can be hidden (eye button) — hidden layers still burn while their
Output is on, and the Start dialog says so.

**Shortcuts** (LightBurn's where they don't clash with the one-letter tool keys) — Ctrl+Shift+I invert selection,
Alt+V paste in place, Ctrl+U ungroup, Ctrl+Shift+C convert to path, Ctrl+Shift+B convert to bitmap, Alt+C close path,
Alt+J auto-join, Alt+Shift+O optimize, Alt+D delete duplicates, Alt+B break apart, Alt+O offset, Alt+T trace,
Alt+I adjust image, Ctrl+K trim, Ctrl+Shift+H / V flip, Ctrl+Shift+M mirror across a line, Ctrl+Shift+arrows align,
Alt+Shift+H / V move together, PgUp / PgDn draw order (Ctrl for front/back), Ctrl+Shift+A zoom to selection, + / − zoom.
Edit nodes: D delete point, B break, I insert point under the pointer. Drawing a line: Backspace removes the last point.

**Import / export** — SVG (including pictures embedded in SVG files, ready to trace), DXF, HPGL/PLT, PNG/JPG/BMP/GIF/WebP; export SVG, DXF, G-code, Ruida RD files.

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
- `public/js/ops.js` — offsets, booleans, concentric fill, tabs, dashes, hull, auto-join, path clean-up, dock, node edits
- `public/js/menu.js` — pop-up menus (menu bar and right-click), submenus, keyboard control
- `public/js/geom.js` — matrices, shapes, SVG path / DXF parsing, simplification
- `public/js/raster.js` — contour tracing, image trace and Auto trace, text outlines, dithering, image adjustments
- `public/js/trace-worker.js` — full-detail tracing off the main thread for the Trace image dialog
- `public/js/shapes.js`, `public/js/app.js`, `public/js/machine.js` — objects, editor UI, server client

## Credits

- Polygon clipping: [Clipper](http://www.angusj.com/) by Angus Johnson, Boost Software License 1.0 (`public/vendor/clipper.js`).
- The Ruida protocol was implemented from public notes: the EduTech Wiki *Ruida* page, the
  [jnweiger/ruida-laser](https://github.com/jnweiger/ruida-laser) documentation and the command table documented by
  the MIT-licensed [MeerK40t](https://github.com/meerk40t/meerk40t) project. No code was copied.
- BeamForge is independent and is not affiliated with LightBurn, Ruida, LaserWorks or any laser manufacturer.
