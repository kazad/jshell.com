// Counting worker: runs countPills() off the main thread so the tab never
// freezes while a photo is analyzed (2-30s on healthy photos, up to the 180s
// wall-clock budget on textured ones), and so a count can be cancelled by
// terminating this worker.
//
// This is a MODULE worker (`new Worker(url, { type: 'module' })`) because
// counter.js is an ES module (it imports stamp.js and cluster.js). Module
// workers have no importScripts(), and vendor/opencv.js is a UMD/global
// script, not a module -- so it is fetched and evaluated in the worker's
// global scope with an indirect eval. The UMD wrapper sees
// `typeof importScripts === 'function'` (the function exists on every
// WorkerGlobalScope, it merely throws when called from a module worker) and
// assigns `self.cv`. Support: module workers are Chrome 80+, Safari 15+
// (iOS 15+), Firefox 114+. Anything older fails the `ready` handshake and
// app.js falls back to counting on the main thread.
//
// Protocol (main -> worker):
//   { id, cmd: 'count', image: { data: ArrayBuffer, width, height }, opts }
//     image.data is RGBA at full source resolution (transferred, zero-copy).
//     opts is countPills' opts with two boolean flags in place of callbacks:
//       opts.debug === true  -> every debug event is forwarded as a progress
//                               message (only primitive fields are kept)
//       opts.stages === true -> stage snapshots are collected and returned
//                               with the result as `stages`
// Protocol (worker -> main):
//   { ready: true } | { ready: false, error }        once, after OpenCV init
//   { id, progress: { stage, ...primitives } }       zero or more per job
//   { id, ok: true, result, ms } | { id, ok: false, error: { message, stack } }

import { countPills } from './counter.js';

let cv = null;

function loadCV() {
  const url = new URL('../vendor/opencv.js', import.meta.url).href;
  return fetch(url)
    .then((r) => { if (!r.ok) throw new Error(`opencv.js fetch ${r.status}`); return r.text(); })
    .then((text) => new Promise((resolve, reject) => {
      // Indirect eval: sloppy mode, global scope, so the UMD wrapper's `this`
      // is the worker global and `var`s inside it do not leak into this module.
      (0, eval)(text + '\n//# sourceURL=' + url);
      // The Emscripten Module is a self-resolving FAKE THENABLE: `await cv` or
      // resolve(cv) unwraps `then` forever and wedges the thread. Poll for the
      // runtime-ready marker (cv.Mat), strip `then`, and resolve with nothing;
      // the Module itself only ever lives in the module-level `cv` variable.
      const t0 = Date.now();
      const timer = setInterval(() => {
        const c = self.cv;
        if (c && c.Mat) {
          clearInterval(timer);
          try { delete c.then; } catch { /* non-configurable: leave it */ }
          cv = c;
          resolve();
        } else if (Date.now() - t0 > 60000) {
          clearInterval(timer);
          reject(new Error('OpenCV init timeout in worker'));
        }
      }, 25);
    }));
}

const ready = loadCV().then(
  () => { self.postMessage({ ready: true }); },
  (e) => { self.postMessage({ ready: false, error: String(e && e.message || e) }); throw e; },
);

// Keep only fields structured clone is guaranteed to accept and that are
// cheap to ship: debug events are emitted from inner loops and can carry
// arrays or large objects (holes sizes, seam cells) that nobody reads live.
function slim(ev) {
  const out = {};
  for (const k in ev) {
    const v = ev[k];
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.cmd !== 'count') return;
  const { id } = msg;
  try { await ready; } catch (err) {
    self.postMessage({ id, ok: false, error: { message: 'opencv failed in worker: ' + (err && err.message) } });
    return;
  }
  const t0 = performance.now();
  try {
    const img = msg.image;
    const source = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    const opts = Object.assign({}, msg.opts);
    if (opts.maskCandidate && !(opts.maskCandidate instanceof Uint8Array)) {
      opts.maskCandidate = new Uint8Array(opts.maskCandidate);
    }
    if (opts.debug === true) {
      opts.debug = (ev) => { try { self.postMessage({ id, progress: slim(ev) }); } catch { /* never let telemetry break a count */ } };
    } else delete opts.debug;
    let stages = null;
    if (opts.stages === true) {
      stages = {};
      opts.stages = (k, v) => { stages[k] = v; };
    } else delete opts.stages;
    const result = countPills(cv, source, opts);
    const reply = { id, ok: true, result, ms: Math.round(performance.now() - t0) };
    if (stages) reply.stages = stages;
    self.postMessage(reply);
  } catch (err) {
    self.postMessage({ id, ok: false, error: { message: String(err && err.message || err), stack: err && err.stack } });
  }
};
