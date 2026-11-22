// Full-detail image tracing off the main thread, for the Trace image dialog (see traceValues in raster.js).
// Message in:  { id, key, W, H, opts, v? } — v (one byte per pixel) is sent only when key changes.
// Message out: { id, xy: Float64Array of x,y pairs, starts: Uint32Array of loop offsets } | { id, error } | { id, missing }
import { traceValues } from './raster.js';

let cache = null; // { key, v, W, H }
self.onmessage = ({ data: m }) => {
  if (m.v) cache = { key: m.key, v: m.v, W: m.W, H: m.H };
  if (!cache || cache.key !== m.key) { self.postMessage({ id: m.id, missing: true }); return; }
  try {
    const loops = traceValues(cache.v, cache.W, cache.H, m.opts);
    let n = 0;
    for (const l of loops) n += l.length;
    const xy = new Float64Array(n * 2), starts = new Uint32Array(loops.length + 1);
    let k = 0;
    loops.forEach((l, i) => { starts[i] = k / 2; for (const p of l) { xy[k++] = p[0]; xy[k++] = p[1]; } });
    starts[loops.length] = n;
    self.postMessage({ id: m.id, xy, starts }, [xy.buffer, starts.buffer]);
  } catch (e) {
    self.postMessage({ id: m.id, error: e.message || String(e) });
  }
};
