// MobileSAM auto-mask for the shredded-gloss regime.
//
// The counter's own mask machinery wins everywhere EXCEPT when specular
// gloss shreds pill bodies into confetti (maskstats ratio = comps/mass-units
// >= 1.4 -- fires on exactly {s-0bfc44d8, salmon} across the corpus, zero
// healthy photos). There, a segmentation model sees whole pills where
// thresholds see shreds. Validated offline before any of this was written:
// MobileSAM fp16 ONNX union mask -> our counter = 0bfc 34 EXACT (was +2),
// salmon 89 (was +2). The model NEVER counts -- its union mask enters the
// mask bake-off as a candidate and the same judge (gradient precision +
// fragmentation veto) decides. See known-issues 'ai-segmentation-option'.
//
// Pure-core design: samAutoMask() takes an injected onnxruntime module and
// sessions, so Node (onnxruntime-node) validates the exact code the PWA
// (onnxruntime-web) runs.

const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];
const ENC_SIZE = 1024;
const LOW = 512;          // union/NMS resolution; 256 fuses salmon's 90 pills

// Bilinear resize RGBA -> Float32 CHW normalized, letterboxed to 1024x1024.
function preprocess(img) {
  const { data, width: w, height: h } = img;
  const s = ENC_SIZE / Math.max(w, h);
  const nw = Math.round(w * s), nh = Math.round(h * s);
  const x = new Float32Array(3 * ENC_SIZE * ENC_SIZE);
  const plane = ENC_SIZE * ENC_SIZE;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1.001, y / s);
    const y0 = sy | 0, fy = sy - y0;
    for (let px = 0; px < nw; px++) {
      const sx = Math.min(w - 1.001, px / s);
      const x0 = sx | 0, fx = sx - x0;
      const i00 = (y0 * w + x0) * 4, i01 = i00 + 4, i10 = i00 + w * 4, i11 = i10 + 4;
      const o = y * ENC_SIZE + px;
      for (let c = 0; c < 3; c++) {
        const v = data[i00 + c] * (1 - fx) * (1 - fy) + data[i01 + c] * fx * (1 - fy)
          + data[i10 + c] * (1 - fx) * fy + data[i11 + c] * fx * fy;
        x[c * plane + o] = (v - MEAN[c]) / STD[c];
      }
    }
  }
  return { x, s, nw, nh };
}

// Auto-mask: grid prompts -> per-mask quality filters -> NMS -> area band ->
// union. Returns a 0/1 Uint8Array at (outW x outH), or null if nothing kept.
// opts.fg (Uint8Array at outW x outH) restricts prompts to foreground --
// the counter's own working mask is shredded but its FOOTPRINT is right,
// and skipping background points is the difference between ~1000 and ~200
// decoder runs on a phone.
export async function samAutoMask(ort, enc, dec, img, outW, outH, opts = {}) {
  const grid = opts.grid || 32;
  const onProgress = opts.onProgress || null;
  const { x, s, nw, nh } = preprocess(img);
  const embRes = await enc.run({ image: new ort.Tensor('float32', x, [1, 3, ENC_SIZE, ENC_SIZE]) });
  const emb = embRes[Object.keys(embRes)[0]];

  // Prompt points in encoder coords; optionally only where fg says pill.
  const pts = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const px = (gx + 0.5) * nw / grid, py = (gy + 0.5) * nh / grid;
      if (opts.fg) {
        const wx = Math.min(outW - 1, Math.round(px / s / img.width * outW));
        const wy = Math.min(outH - 1, Math.round(py / s / img.height * outH));
        // 1-px tolerance: a shredded mask has pinholes exactly where pills are
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2 && !hit; dx++) {
            const yy = wy + dy, xx = wx + dx;
            if (yy >= 0 && yy < outH && xx >= 0 && xx < outW && opts.fg[yy * outW + xx]) hit = true;
          }
        }
        if (!hit) continue;
      }
      pts.push([px, py]);
    }
  }

  const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
  const hasMask = new ort.Tensor('float32', new Float32Array([0]), [1]);
  const imSize = new ort.Tensor('float32', new Float32Array([LOW, LOW]), [2]);
  const masks = [];   // {bits: Uint8Array(LOW*LOW), area, iou}
  for (let i = 0; i < pts.length; i++) {
    const coords = new ort.Tensor('float32',
      new Float32Array([pts[i][0], pts[i][1], 0, 0]), [1, 2, 2]);
    const labels = new ort.Tensor('float32', new Float32Array([1, -1]), [1, 2]);
    const out = await dec.run({ image_embeddings: emb, point_coords: coords,
      point_labels: labels, mask_input: maskInput, has_mask_input: hasMask,
      orig_im_size: imSize });
    const logits = out.masks.data;           // [1,K,LOW,LOW]
    const ious = out.iou_predictions.data;   // [1,K]
    const K = out.iou_predictions.dims[1];
    const px = LOW * LOW;
    for (let k = 0; k < K; k++) {
      if (ious[k] < 0.85) continue;
      const base = k * px;
      let a = 0, hi = 0, lo = 0;
      for (let j = 0; j < px; j++) {
        const v = logits[base + j];
        if (v > 0) a++;
        if (v > 2) hi++;
        if (v > -2) lo++;
      }
      if (!a || hi / Math.max(lo, 1) < 0.90) continue;   // stability
      const bits = new Uint8Array(px);
      for (let j = 0; j < px; j++) bits[j] = logits[base + j] > 0 ? 1 : 0;
      masks.push({ bits, area: a, iou: ious[k] });
    }
    if (onProgress && i % 16 === 15) onProgress(i + 1, pts.length);
  }
  if (!masks.length) return null;

  // NMS by min-overlap on 4x-downsampled bits (cheap, order-insensitive
  // enough); keep the higher predicted IoU.
  const D = LOW / 4, dpx = D * D;
  for (const m of masks) {
    const ds = new Uint8Array(dpx);
    for (let y = 0; y < D; y++) {
      for (let xx = 0; xx < D; xx++) {
        ds[y * D + xx] = m.bits[(y * 4 + 2) * LOW + xx * 4 + 2];
      }
    }
    m.ds = ds;
    m.dsArea = ds.reduce((t, v) => t + v, 0);
  }
  masks.sort((a, b) => b.iou - a.iou);
  const kept = [];
  for (const m of masks) {
    let dup = false;
    for (const k2 of kept) {
      let inter = 0;
      for (let j = 0; j < dpx; j++) if (m.ds[j] && k2.ds[j]) inter++;
      if (inter / Math.max(1, Math.min(m.dsArea, k2.dsArea)) > 0.8) { dup = true; break; }
    }
    if (!dup) kept.push(m);
  }

  // Area band around the median: drop the board and the specks (mirrors the
  // validated exporter: 0.02%..15% of frame, then 0.45x..6x median).
  const ia = LOW * LOW;
  let band = kept.filter((m) => m.area < 0.15 * ia && m.area > 0.0002 * ia);
  if (!band.length) return null;
  const med = band.map((m) => m.area).sort((a, b) => a - b)[band.length >> 1];
  band = band.filter((m) => m.area >= 0.45 * med && m.area <= 6 * med);
  if (!band.length) return null;

  // Union at LOW, then nearest-neighbour to the counter's working scale.
  // The LOW square covers the PADDED encoder square; only the (vw x vh)
  // region is real image.
  // OWNER-SEAM union. The raw OR of 91 touching pill masks is one fused
  // megablob (measured on salmon: 1.13M px, per-pill separation destroyed,
  // downstream count 89). Eroding every instance instead minted fragments
  // where near-duplicate masks survive NMS (eb: 35 masks for 34 beads,
  // 33 -> 36). So: assign each pixel to ONE owner (first claim in
  // predicted-IoU order) and clear only the 1px boundary BETWEEN different
  // owners -- the model's own instance separation, preserved for the
  // watershed, with duplicates absorbed by first-claim. The counter still
  // does all counting.
  // Seams are REGIME-SPECIFIC (opts.seams): the fusion regime (predicate
  // ratio arm, salmon 4.45) needs them -- without seams the union is one
  // megablob and the count lands 89. The specular regime (gloss arm, eb)
  // must NOT have them: glare-split near-duplicate masks survive NMS
  // (35 masks for 34 beads) and seams let the extras live as fragments
  // (33 -> 36); the solid OR union lets the counter re-split correctly
  // (34 EXACT). 0bfc (ratio arm) measures 34 under both styles.
  if (!opts.seams) {
    const uniS = new Uint8Array(LOW * LOW);
    for (const m of band) {
      for (let j = 0; j < LOW * LOW; j++) if (m.bits[j]) uniS[j] = 1;
    }
    return finishUnion(uniS, band.length, nw, nh, outW, outH);
  }
  const owner = new Int16Array(LOW * LOW).fill(-1);
  band.forEach((m, bi) => {
    for (let j = 0; j < LOW * LOW; j++) {
      if (m.bits[j] && owner[j] < 0) owner[j] = bi;
    }
  });
  const uni = new Uint8Array(LOW * LOW);
  for (let y = 1; y < LOW - 1; y++) {
    for (let xx = 1; xx < LOW - 1; xx++) {
      const j = y * LOW + xx;
      const o = owner[j];
      if (o < 0) continue;
      const n1 = owner[j - 1], n2 = owner[j + 1],
        n3 = owner[j - LOW], n4 = owner[j + LOW];
      uni[j] = ((n1 >= 0 && n1 !== o) || (n2 >= 0 && n2 !== o)
        || (n3 >= 0 && n3 !== o) || (n4 >= 0 && n4 !== o)) ? 0 : 1;
    }
  }
  return finishUnion(uni, band.length, nw, nh, outW, outH);
}

function finishUnion(uni, nMasks, nw, nh, outW, outH) {
  const vw = Math.round(LOW * nw / ENC_SIZE), vh = Math.round(LOW * nh / ENC_SIZE);
  const cand = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(vh - 1, Math.round(y / outH * vh));
    for (let xx = 0; xx < outW; xx++) {
      const sx = Math.min(vw - 1, Math.round(xx / outW * vw));
      cand[y * outW + xx] = uni[sy * LOW + sx];
    }
  }
  return { cand, nMasks };
}

// ---- browser loader (lazy; ~42MB fetched once, then HTTP/SW-cached) ----
// WebGPU ONLY, fp32 ONLY. Both were measured, not chosen: the fp16 models
// return uniformly wrong IoUs on WebGPU (all 576 grid points compressed
// into 0.70-0.81, zero masks survive, vs 1.03 correct on CPU -- TinyViT
// overflows half precision on GPU), and the wasm CPU path is correct but
// 326ms per decoder run = 3 minutes per photo. fp32 on WebGPU is correct
// AND fast (encoder 0.94s, 22ms per point). Devices without WebGPU simply
// keep the classical count. The encoder ships in two chunks because
// Cloudflare Pages caps files at 25MiB.
let _samSessions = null;
// Cache the IN-FLIGHT promise, not just the resolved value: a retake during
// the first ~42MB download followed by another glossy board started a second
// parallel download and a second GPU session. A rejection clears the cache so
// the next attempt can retry.
let _samPromise = null;
export function samSessions() {
  if (!_samPromise) {
    _samPromise = loadSamSessions().catch((e) => { _samPromise = null; throw e; });
  }
  return _samPromise;
}
async function loadSamSessions() {
  if (_samSessions) return _samSessions;
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('sam requires webgpu');
  }
  const ortUrl = new URL('../vendor/ort/ort.bundle.min.mjs', import.meta.url);
  const ort = await import(ortUrl.href);
  const ortBase = new URL('../vendor/ort/', import.meta.url).href;
  ort.env.wasm.wasmPaths = ortBase;
  const cat = async (urls) => {
    const parts = await Promise.all(urls.map((u) => fetch(u).then((r) => {
      if (!r.ok) throw new Error('fetch ' + u + ' -> ' + r.status);
      return r.arrayBuffer();
    })));
    const total = parts.reduce((t, b) => t + b.byteLength, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const b of parts) { bytes.set(new Uint8Array(b), off); off += b.byteLength; }
    return bytes;
  };
  // Cloudflare Pages caps files at 25MiB, so the ort wasm and the encoder
  // both ship as chunks and are reassembled here.
  ort.env.wasm.wasmBinary = (await cat([
    ortBase + 'ort-wasm-simd-threaded.jsep.wasm.0',
    ortBase + 'ort-wasm-simd-threaded.jsep.wasm.1',
  ])).buffer;
  const base = new URL('../vendor/sam/', import.meta.url).href;
  const encBytes = await cat([
    base + 'mobilesam_encoder.onnx.0',
    base + 'mobilesam_encoder.onnx.1',
  ]);
  const o = { executionProviders: ['webgpu'] };
  const enc = await ort.InferenceSession.create(encBytes, o);
  const dec = await ort.InferenceSession.create(base + 'mobilesam_decoder.onnx', o);
  _samSessions = { ort, enc, dec };
  return _samSessions;
}

// The shredded-gloss predicate, from countPills() result. Measured across
// all 34 browser-pixel corpus JPEGs: ratio >= 1.4 fires on exactly the two
// glare-shredded boards, zero healthy; the gloss second signal reaches
// s-eb90778f (ratio 1.25) without touching matte boards above it.
export function samWanted(result) {
  const ms = result && result.maskStats;
  if (!ms || !(result.unitArea > 0) || !(ms.fg > 0)) return false;
  const ratio = ms.comps / (ms.fg / result.unitArea);
  return ratio >= 1.4 || (ratio >= 1.15 && (ms.gloss || 0) >= 0.055);
}

// Which union style the firing regime needs (see the seams comment above):
// the fusion arm (ratio >= 1.4) gets instance seams, the gloss arm a solid
// union.
export function samSeamsWanted(result) {
  const ms = result && result.maskStats;
  if (!ms || !(result.unitArea > 0) || !(ms.fg > 0)) return false;
  return ms.comps / (ms.fg / result.unitArea) >= 1.4;
}
