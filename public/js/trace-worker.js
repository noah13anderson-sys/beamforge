// Full-detail image tracing off the main thread, for the Trace image dialog (see traceValues in raster.js).
// Message in:  { id, key, W, H, opts, v? } — v (one byte per pixel) is sent only when key changes.
// Message out: { id, xy: Float64Array of x,y pairs, starts: Uint32Array of path offsets, closed: Uint8Array,
//               piece: Int32Array } | { id, error } | { id, missing }
import { traceValues } from './raster.js';

let cache = null; // { key, v, W, H }
self.onmessage = ({ data: m }) => {
  if (m.v) cache = { key: m.key, v: m.v, W: m.W, H: m.H };
  if (!cache || cache.key !== m.key) { self.postMessage({ id: m.id, missing: true }); return; }
  try {
    const paths = traceValues(cache.v, cache.W, cache.H, m.opts);
    let n = 0;
    for (const p of paths) n += p.pts.length;
    const xy = new Float64Array(n * 2), starts = new Uint32Array(paths.length + 1);
    const closed = new Uint8Array(paths.length), piece = new Int32Array(paths.length);
    let k = 0;
    paths.forEach((p, i) => {
      starts[i] = k / 2; closed[i] = p.closed ? 1 : 0; piece[i] = p.piece;
      for (const q of p.pts) { xy[k++] = q[0]; xy[k++] = q[1]; }
    });
    starts[paths.length] = n;
    self.postMessage({ id: m.id, xy, starts, closed, piece }, [xy.buffer, starts.buffer, closed.buffer, piece.buffer]);
  } catch (e) {
    self.postMessage({ id: m.id, error: e.message || String(e) });
  }
};
