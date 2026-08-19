// Pill counting pipeline: threshold -> morphology -> distance transform -> watershed.
// Touching pills are split by watershed; oversized regions get an area-ratio fallback.
// Environment-agnostic: runs in the browser and in Node (see tools/count-cli.mjs).
//
// CANDIDATE: stamp-router integration (see js/stamp.js). Last-resort
// arbitration by stamp-peel-repeat, fired only on weak-evidence images.
import { solveCluster, overlapDepth as clusterPen } from './cluster.js';
import { stampArbitrate, stadArea as stampStadArea,
  buildSeamMask, calibrateMatch, matchQuality } from './stamp.js';

let cvReady = null;

export function loadCV(src = 'vendor/opencv.js') {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      // Emscripten builds expose cv as a fake-thenable Module that hangs under
      // `await`; poll for the runtime-initialized marker (cv.Mat) instead.
      const start = Date.now();
      const timer = setInterval(() => {
        const c = window.cv;
        if (c && c.Mat) {
          clearInterval(timer);
          // The Module is a self-resolving fake thenable (old Emscripten bug);
          // strip `then` so it can cross promise boundaries without looping forever.
          try { delete c.then; } catch { /* non-configurable: leave it */ }
          resolve(c);
        }
        else if (Date.now() - start > 30000) { clearInterval(timer); reject(new Error('OpenCV init timeout')); }
      }, 50);
    };
    s.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(s);
  });
  return cvReady;
}

// Fraction of white pixels along the image border; used to decide if the
// background (not the pills) came out white after Otsu.
function borderWhiteFraction(cv, bw) {
  const t = Math.max(2, Math.round(Math.min(bw.rows, bw.cols) * 0.02));
  const rois = [
    new cv.Rect(0, 0, bw.cols, t),
    new cv.Rect(0, bw.rows - t, bw.cols, t),
    new cv.Rect(0, 0, t, bw.rows),
    new cv.Rect(bw.cols - t, 0, t, bw.rows),
  ];
  let white = 0, total = 0;
  for (const r of rois) {
    const roi = bw.roi(r);
    white += cv.countNonZero(roi);
    total += r.width * r.height;
    roi.delete();
  }
  return white / total;
}

// Dominant border color — the background/tray estimate. Robust to mixed
// borders (e.g. black pillarbox bars beside a white counter): each side
// nominates its median color, the candidate supported by the most border
// pixels wins, and the final color is the median of just its supporters.
function borderColor(rgba, w, h) {
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const sides = { top: [], bottom: [], left: [], right: [] };
  const push = (arr, x, y) => {
    const o = (y * w + x) * 4;
    arr.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  };
  for (let y = 0; y < t; y++) {
    for (let x = 0; x < w; x += 3) { push(sides.top, x, y); push(sides.bottom, x, h - 1 - y); }
  }
  for (let x = 0; x < t; x++) {
    for (let y = t; y < h - t; y += 3) { push(sides.left, x, y); push(sides.right, w - 1 - x, y); }
  }
  const all = [...sides.top, ...sides.bottom, ...sides.left, ...sides.right];
  const medOf = (px) => [0, 1, 2].map((c) => median(px.map((p) => p[c])));
  const candidates = Object.values(sides).filter((s) => s.length).map(medOf);
  // Every border color with meaningful support is a background (a pillarboxed
  // photo has two: the counter AND the black bars). Sorted by support.
  const kept = [];
  for (const cand of candidates) {
    const support = all.filter((p) =>
      Math.abs(p[0] - cand[0]) + Math.abs(p[1] - cand[1]) + Math.abs(p[2] - cand[2]) < 90);
    if (support.length < all.length * 0.15) continue;
    const col = medOf(support);
    if (!kept.some((k) => Math.abs(k.col[0] - col[0]) + Math.abs(k.col[1] - col[1]) + Math.abs(k.col[2] - col[2]) < 60)) {
      kept.push({ col, support: support.length });
    }
  }
  kept.sort((a, b) => b.support - a.support);
  return kept.length ? kept.map((k) => k.col) : [medOf(all)];
}

// Color difference vs a reference, damping only shadow-like shifts (darker
// than the reference at near-identical chroma). White pills on white counters
// keep full luminance weight; cast shadows don't.
function colorDist(dr, dg, db, bg, hueAware) {
  const dl = (dr + dg + db) / 3;
  const cr = dr - dl, cg = dg - dl, cb = db - dl;
  const chroma2 = cr * cr + cg * cg + cb * cb;
  // Shadow = luminance-dominant darkening. On saturated surfaces (wood),
  // shading is multiplicative, so deep shadows shift chroma proportionally —
  // the gate must scale with |dl| rather than stay absolute.
  let shadowish = dl < 0 && chroma2 < Math.max(400, 0.5 * dl * dl);
  // OPT-IN hue check, used only when the plain metric has already been shown
  // to fail on this photo (see the chromatic-rescue block). "Chroma is small
  // in absolute terms" also describes a modestly coloured DARK object, and
  // damping one to 12% deletes it: measured on the glossy beads, interiors
  // read 18-46 against an Otsu cut of 49, so every pill pixel fell below the
  // threshold and the mask came out as gnawed fragments.
  //
  // The physical distinction is direction, not magnitude. Shadow SCALES the
  // background colour and preserves its RGB direction; a coloured body
  // rotates it. Measured on that photo: true shadow 0.18-0.36 degrees off the
  // background vector, shaded board 0.6-4.1, bead pixels 9.8-15.2 — a 25x
  // margin. Applying it globally is NOT safe (it also undamps board shading,
  // which lifted the threshold and merged clumps: r-7ff7fd99 19 -> 12), so it
  // stays behind the per-photo gate.
  if (hueAware && shadowish && bg) {
    const px = bg[0] + dr, py = bg[1] + dg, pz = bg[2] + db;
    const dot = px * bg[0] + py * bg[1] + pz * bg[2];
    const n1 = Math.sqrt(px * px + py * py + pz * pz);
    const n2 = Math.sqrt(bg[0] * bg[0] + bg[1] * bg[1] + bg[2] * bg[2]);
    if (n1 > 1 && n2 > 1 && dot / (n1 * n2) < 0.99065) shadowish = false;
  }
  return Math.min(255, Math.sqrt(chroma2 + (shadowish ? 0.12 : 1) * dl * dl) | 0);
}

// Per-pixel color distance from the NEAREST background color, as a CV_8U Mat.
// Also returns a raw (shadow-damping-free) map: white pill bodies that sit
// slightly darker than a light background look like shadows to the damped
// metric, but the rescue stage can re-examine them in the raw map where its
// pill-shape filters (not luma damping) reject actual cast shadows.
function distanceFromBackground(cv, rgbaMat, hueAware) {
  const w = rgbaMat.cols, h = rgbaMat.rows;
  const d = rgbaMat.data;
  const bgs = borderColor(d, w, h);
  const out = new cv.Mat(h, w, cv.CV_8UC1);
  const raw = new cv.Mat(h, w, cv.CV_8UC1);
  const o = out.data, ro = raw.data;
  for (let i = 0, p = 0; i < o.length; i++, p += 4) {
    let m = 255, mr = 255;
    for (const [br, bg, bb] of bgs) {
      const dr = d[p] - br, dg = d[p + 1] - bg, db = d[p + 2] - bb;
      const v = colorDist(dr, dg, db, [br, bg, bb], hueAware);
      if (v < m) m = v;
      const dl = (dr + dg + db) / 3;
      const cr = dr - dl, cg = dg - dl, cb = db - dl;
      const vr = Math.min(255, Math.sqrt(cr * cr + cg * cg + cb * cb + dl * dl) | 0);
      if (vr < mr) mr = vr;
    }
    o[i] = m;
    ro[i] = mr;
  }
  return { mat: out, raw, color: bgs[0] };
}

// CHROMATIC distance from a LOCAL background estimate.
//
// Two failures of the border-median/absolute-colour metric above, both
// measured on the glossy-bead photos (testdata/shiny):
//
//   1. One background colour cannot describe a lit surface. That leather
//      runs rgb(180,123,92) top-right to (131,80,53) bottom, so bare board
//      sits 46-52 units from the border median while a BEAD interior sits at
//      33 — the classes overlap and no threshold can separate them. Result:
//      33% of the frame classified as pill (true coverage ~8%), separate
//      beads welded into clumps, "the boundaries are really off".
//
//   2. A specular highlight blows a glossy pill toward white in the middle,
//      so a brightness-sensitive metric punches a hole through every bead
//      and the mask becomes a shell around a hollow core.
//
// Both are fixed by comparing CHROMATICITY (r,g,b normalized by intensity)
// against a heavily-blurred local estimate of the surface: normalizing kills
// the highlight's brightness, and the local reference tracks the gradient.
//
// This does NOT replace the absolute metric — it is its complement. White
// caplets share the board's chromaticity and differ only in brightness, so
// this map is nearly blind to them, exactly where the absolute metric is
// strongest. The caller measures both and keeps whichever yields a coherent
// pill population (see cueSelect).
function chromaticDistance(cv, rgbaMat) {
  const w = rgbaMat.cols, h = rgbaMat.rows, d = rgbaMat.data;
  // Local surface estimate: downsample hard, median-blur, upsample. The
  // median (not mean) keeps pills from dragging their own neighbourhood.
  const SS = Math.max(1, Math.round(Math.min(w, h) / 90));
  const sw = Math.max(1, (w / SS) | 0), sh = Math.max(1, (h / SS) | 0);
  const sm = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const p = ((Math.min(h - 1, y * SS) * w) + Math.min(w - 1, x * SS)) * 4;
    const q = (y * sw + x) * 3;
    sm[q] = d[p]; sm[q + 1] = d[p + 1]; sm[q + 2] = d[p + 2];
  }
  const R = Math.max(2, Math.round(Math.min(sw, sh) / 6));
  const bgf = new Float32Array(sw * sh * 3);
  const buf = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    for (let c = 0; c < 3; c++) {
      buf.length = 0;
      for (let j = -R; j <= R; j += 2) for (let i = -R; i <= R; i += 2) {
        const yy = y + j, xx = x + i;
        if (yy < 0 || xx < 0 || yy >= sh || xx >= sw) continue;
        buf.push(sm[(yy * sw + xx) * 3 + c]);
      }
      buf.sort((a, b) => a - b);
      bgf[(y * sw + x) * 3 + c] = buf[buf.length >> 1] || 0;
    }
  }
  const out = new cv.Mat(h, w, cv.CV_8UC1);
  const o = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    const sx = Math.min(sw - 1, (x / SS) | 0), sy = Math.min(sh - 1, (y / SS) | 0);
    const q = (sy * sw + sx) * 3;
    const s1 = d[p] + d[p + 1] + d[p + 2] + 1e-6;
    const s2 = bgf[q] + bgf[q + 1] + bgf[q + 2] + 1e-6;
    const dr = d[p] / s1 - bgf[q] / s2;
    const dg = d[p + 1] / s1 - bgf[q + 1] / s2;
    const db = d[p + 2] / s1 - bgf[q + 2] / s2;
    // chromaticity deltas are ~0..0.35; scale into the 0..255 the rest of
    // the pipeline (Otsu, absFloor, rescue) already speaks
    o[y * w + x] = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db) * 900) | 0;
  }
  return out;
}

// Which distance map actually separates pills here? Not "which histogram is
// more bimodal" — board texture makes both bimodal, and on the bead photos
// the two scored 0.693 vs 0.695, a coin flip. Ask instead whether the mask a
// cue produces looks like a POPULATION OF PILLS: identical medication means
// blobs repeat at one size, and the tightness of that repeat is a strong,
// well-separated signal (measured: absolute wins by 0.10-0.30 on every white-
// caplet photo, chromatic wins by a comparable margin on both bead photos).
function cueScore(cv, distMat, minArea) {
  const bw = new cv.Mat();
  const thr = cv.threshold(distMat, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const lab = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
  const n = cv.connectedComponentsWithStats(bw, lab, stats, cent, 8, cv.CV_32S);
  const areas = [];
  let fgArea = 0;
  for (let i = 1; i < n; i++) {
    const a = stats.intAt(i, cv.CC_STAT_AREA);
    fgArea += a;
    if (a >= minArea) areas.push(a);
  }
  bw.delete(); lab.delete(); stats.delete(); cent.delete();
  const frac = fgArea / (distMat.rows * distMat.cols);
  // absurd coverage means the cue is describing the surface, not the pills
  if (areas.length < 3 || frac > 0.42 || frac < 0.005) return { score: -1, thr, frac };
  const med = median(areas);
  const singles = areas.filter((a) => a > 0.6 * med && a < 1.5 * med);
  if (singles.length < 2) return { score: -1, thr, frac };
  const mean = singles.reduce((s, a) => s + a, 0) / singles.length;
  const sd = Math.sqrt(singles.reduce((s, a) => s + (a - mean) ** 2, 0) / singles.length);
  const cv2 = sd / (mean || 1);
  const share = singles.reduce((s, a) => s + a, 0) / areas.reduce((s, a) => s + a, 0);
  return { score: (1 - cv2) * 0.6 + share * 0.4, thr, frac, n: singles.length };
}

// HIGH-CONTRAST MASK RESCUE (self-calibrating two-gate segmentation).
//
// The failure this addresses, measured on t3-cream-caplets-wood.jpg (48
// caplets, pipeline read 45): the adaptive path fuses the whole pile into one
// 430k-px blob, and refineOversizedBlobs then re-thresholds that blob against
// its OWN median colour. But the pills are the MAJORITY of the blob, so the
// "surface colour" it measures IS the pill colour — the refine keeps the wood
// web between the caplets and sheds the caplets themselves (measured:
// keptRatio 0.45 but pillRatio 0.099, the inverted signature). Downstream then
// fits capsules to wood fragments.
//
// Yet the photo is trivially separable: pills and board differ hugely in BOTH
// luma and one chroma channel. Two gates recover it essentially perfectly (49
// clean components, median 5021 px, every capsule its own blob). The point of
// this function is to derive those two gates PER PHOTO rather than fix them at
// the measured 150/90 constants:
//
//   gate 1 (luma)   Otsu on luma, oriented AWAY from the border background —
//                   whichever side of the cut the background is not on.
//   gate 2 (chroma) the channel that best separates the luma-proposed
//                   foreground from the border background, measured in units
//                   of the BACKGROUND'S OWN spread (a noisy channel is
//                   discounted), cut at that background's 98th/2nd percentile
//                   in the direction of the separation. On the cream photo
//                   this learns B with z=3.5 and a cut of 64 — no constant is
//                   spelled anywhere, and the same code learns G on the
//                   r-* countertop photos and R on the advil ones.
//
// This is RESCUE MATERIAL only, never a segmenter: it is handed to the stamp
// arbiter, which must show it explains more material than the pipeline's own
// mask before it may change the count (see retry (e) in stamp.js).
function highContrastMask(cv, src, debug) {
  const w = src.cols, h = src.rows, d = src.data, n = w * h;
  // Border strip = background population (same 3% strip borderColor samples).
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const bR = [], bG = [], bB = [];
  const pushB = (x, y) => { const o = (y * w + x) * 4; bR.push(d[o]); bG.push(d[o + 1]); bB.push(d[o + 2]); };
  for (let y = 0; y < t; y++) for (let x = 0; x < w; x += 3) { pushB(x, y); pushB(x, h - 1 - y); }
  for (let x = 0; x < t; x++) for (let y = t; y < h - t; y += 3) { pushB(x, y); pushB(w - 1 - x, y); }
  if (bR.length < 50) return null;
  const bg = [median(bR), median(bG), median(bB)];
  const bgL = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];

  // ---- gate 1: Otsu on luma ----
  const luma = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
    luma[i] = v; hist[v]++;
  }
  const thr = otsuFromHist(hist, n);
  const bright = bgL <= thr;   // pills on the far side of the cut from the bg

  // ---- gate 2: chroma channel learned against the border background ----
  // Proposed foreground median per channel (subsampled).
  const fR = [], fG = [], fB = [];
  for (let i = 0; i < n; i += 7) {
    const on = bright ? luma[i] > thr : luma[i] < thr;
    if (!on) continue;
    const p = i * 4; fR.push(d[p]); fG.push(d[p + 1]); fB.push(d[p + 2]);
  }
  if (fR.length < 30) return null;
  const fg = [median(fR), median(fG), median(fB)];
  const bgCh = [bR, bG, bB];
  const pct = (arr, q) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1))))];
  };
  let ch = -1, bestZ = 0, gap = 0, spread = 1;
  for (let c = 0; c < 3; c++) {
    const sp = Math.max(1, pct(bgCh[c], 0.9) - pct(bgCh[c], 0.1));
    const g = fg[c] - bg[c];
    const z = g / sp;
    if (ch < 0 || Math.abs(z) > Math.abs(bestZ)) { ch = c; bestZ = z; gap = g; spread = sp; }
  }
  const cut = gap > 0 ? pct(bgCh[ch], 0.98) : pct(bgCh[ch], 0.02);

  const m = new cv.Mat(h, w, cv.CV_8UC1);
  const md = m.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const lOK = bright ? luma[i] > thr : luma[i] < thr;
    if (!lOK) { md[i] = 0; continue; }
    const cv2 = d[p + ch];
    md[i] = (gap > 0 ? cv2 > cut : cv2 < cut) ? 255 : 0;
  }
  // Clean at pill scale: opening removes grain speckle, fill seals engravings.
  const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.morphologyEx(m, m, cv.MORPH_OPEN, k5, new cv.Point(-1, -1), 1);
  k5.delete();
  fillHoles(cv, m);
  debug?.({ stage: 'hcmask', thr, bright, ch, cut, z: +bestZ.toFixed(2),
    gap: +gap.toFixed(1), spread, bg: bg.map((v) => Math.round(v)),
    fg: fg.map((v) => Math.round(v)), frac: +(cv.countNonZero(m) / n).toFixed(3) });
  return m;
}

// Visualize a CV_8UC1 mat as a green-tinted ImageData-like object (for the
// stage-by-stage demos on the about page).
function grayToStage(mat8) {
  const o = new Uint8ClampedArray(mat8.cols * mat8.rows * 4);
  const d = mat8.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    o[i * 4] = (v * 0.24) | 0;
    o[i * 4 + 1] = (v * 0.86) | 0;
    o[i * 4 + 2] = (v * 0.59) | 0;
    o[i * 4 + 3] = 255;
  }
  return { data: o, width: mat8.cols, height: mat8.rows };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Otsu threshold from a 256-bin histogram (for arbitrary pixel subsets).
function otsuFromHist(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

// A blob bigger than this fraction of the frame is a surface (plate/tray),
// not a pill: re-threshold it against its own dominant color so the pills
// sitting on it become the foreground.
const SURFACE_FRACTION = 0.12;

function refineOversizedBlobs(cv, src, bw, absFloor, debug) {
  const w = bw.cols, h = bw.rows, total = w * h;
  const lab = new cv.Mat();
  cv.connectedComponents(bw, lab);
  const ll = lab.data32S;
  const areas = new Map();
  for (let i = 0; i < ll.length; i++) {
    if (ll[i]) areas.set(ll[i], (areas.get(ll[i]) || 0) + 1);
  }
  const big = [...areas.entries()].filter(([, a]) => a > total * SURFACE_FRACTION).map(([l]) => l);
  const d = src.data, mask = bw.data;
  let refined = 0;

  // SAME-MEDICATION SCALE PRIOR. One photo holds one medication, so every pill
  // has the same area. The blobs that are ALREADY pill-sized (not oversized,
  // above the absolute floor) are therefore a direct measurement of the unit
  // area — and any refinement of an oversized blob must yield pieces on that
  // same scale. Without this anchor the refine step has no idea how big a pill
  // is, and on a dense raft of touching same-colour tablets it re-thresholds
  // the raft against its OWN median colour (which is the tablet colour), so
  // the only pixels that survive are the ones LEAST like a tablet: the
  // specular glare on each glossy dome and the printed imprint. Measured on
  // t2-advil-scatter-dark-1.jpg: a 230522-px raft of 28 tablets, median colour
  // [207,133,110] (the tablet orange, not a tray), distance peak 54px, refined
  // into 19 "pill-like" pieces of area 1605/582/546/492/450/399/386/359...
  // against real isolated tablets of 8306/8626/8912/9645/9829 px. Those pieces
  // are the glare specks, ~20x too small, and they went on to calibrate the
  // unit area at 359 px and inflate the count 28 -> 48.
  const unitAreas = [...areas.entries()]
    .filter(([, a]) => a >= absFloor && a <= total * SURFACE_FRACTION)
    .map(([, a]) => a);
  const unitArea = unitAreas.length >= 3 ? median(unitAreas) : 0;

  for (const blob of big) {
    // Dominant (median) color of the blob = the surface color.
    const rs = [], gs = [], bs = [];
    for (let i = 0; i < ll.length; i += 5) {
      if (ll[i] !== blob) continue;
      const p = i * 4;
      rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]);
    }
    if (rs.length < 100) continue;
    const br = median(rs), bg = median(gs), bb = median(bs);

    // Distance-from-surface for blob pixels, then Otsu on just those.
    const hist = new Uint32Array(256);
    const distAt = (i) => {
      const p = i * 4;
      return colorDist(d[p] - br, d[p + 1] - bg, d[p + 2] - bb);
    };
    let n = 0;
    for (let i = 0; i < ll.length; i++) {
      if (ll[i] !== blob) continue;
      hist[distAt(i)]++;
      n++;
    }
    // Otsu on this distance histogram is BISTABLE: the surface pixels form a
    // huge near-zero spike and the pills a long thin tail, so the between-
    // class optimum sits between two nearly-equal maxima. A ~1% exposure
    // shift tips it, and the cut jumps 13 <-> 25 on a static scene. That
    // swings the kept area 4x (4k <-> 16k px), which thickens the surviving
    // blobs and inflates radiusEst (6.5 -> 8.4) downstream.
    //
    // Anchor it to a PERCENTILE of the same distribution instead: the pill
    // fraction of a tray is roughly fixed by geometry, so the percentile cut
    // tracks exposure smoothly rather than snapping between modes. Otsu is
    // still consulted, but only within a band around that anchor, so it can
    // refine the cut without being free to jump to the far mode.
    let cum = 0, pct = 12;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      // Pills cover a minority of a tray/plate; the top ~18% of the
      // distance distribution is the stable side of that split.
      if (cum >= n * 0.82) { pct = v; break; }
    }
    const rawOtsu = otsuFromHist(hist, n);
    const thr = Math.max(12, Math.min(Math.max(rawOtsu, 0.7 * pct), 1.4 * pct));
    for (let i = 0; i < ll.length; i++) {
      if (ll[i] === blob) mask[i] = distAt(i) > thr ? 255 : 0;
    }

    // Accept-test: a real surface (plate/tray) yields several chunky,
    // pill-sized pieces. A pile of same-colored pills yields thin crevice
    // fragments — revert those so the pile stays one blob.
    const subLab = new cv.Mat();
    cv.connectedComponents(bw, subLab);
    const subDist = new cv.Mat();
    cv.distanceTransform(bw, subDist, cv.DIST_L2, 5);
    const sl = subLab.data32S, sd = subDist.data32F;
    const pieces = new Map(); // sub-label -> {area, peak}
    let kept = 0;
    for (let i = 0; i < sl.length; i++) {
      if (ll[i] !== blob) continue;
      if (mask[i]) kept++;
      if (!sl[i]) continue;
      let p = pieces.get(sl[i]);
      if (!p) { p = { area: 0, peak: 0 }; pieces.set(sl[i], p); }
      p.area++;
      if (sd[i] > p.peak) p.peak = sd[i];
    }
    // Pill-like piece: chunky and compact (a disk has area ~ pi*peak^2; a
    // crevice/edge network has far more area than its thickness explains).
    const pillLike = [...pieces.values()].filter(
      (p) => p.area >= absFloor && p.peak >= 6 && p.area <= 4 * Math.PI * p.peak * p.peak
    );
    const pillArea = pillLike.reduce((a, p) => a + p.area, 0);
    const blobArea = areas.get(blob);

    // BISTABILITY GUARD. This decision used to be a hard AND of three
    // knife-edge predicates:
    //   pillLike.length >= 3 && pillArea >= 0.4*kept && kept <= 0.5*blobArea
    // On a static scene, sub-Otsu (`thr`) drifts a couple of units with
    // exposure, which swings `kept` by 4x (3.9k <-> 16.6k px on the same
    // tray). That drags pillArea/kept across the 0.40 line — observed at
    // 0.393 vs 0.456 on consecutive frames — and rejecting the refine
    // restores the whole 87k-px tray blob, inflating radiusEst 6.5 -> 51
    // and collapsing the count from ~60 to ~12.
    //
    // Fix: score the evidence instead of ANDing thresholds, and weight the
    // signal that does NOT move with `thr`. The pill-like PIECE COUNT is
    // that signal (it read 4/5/6 across every frame, flipped or not);
    // pillArea/kept is the thr-sensitive one, so it gets a soft ramp with a
    // wide margin rather than a cliff.
    const keptRatio = kept / Math.max(1, blobArea);
    const pillRatio = pillArea / Math.max(1, kept);
    // Each term in [0,1]; ramps span a wide band so a 1-unit `thr` change
    // moves the score by a few percent, never across the accept line.
    const ramp = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    const score =
      // Stable evidence, dominant weight: several chunky pill-sized pieces.
      0.55 * ramp(pillLike.length, 2, 4)
      // thr-sensitive evidence, soft and low-weight: pill mass vs kept mass.
      + 0.25 * ramp(pillRatio, 0.15, 0.5)
      // A real surface keeps only a minority of its own area as pills.
      + 0.20 * (1 - ramp(keptRatio, 0.4, 0.7));
    // Scale veto (see unitArea above). If this image contains isolated
    // pill-sized blobs, the refinement's own pieces must be on that scale. A
    // refinement whose typical piece is a small fraction of a known pill has
    // not found pills on a surface — it has found sub-features (glare,
    // imprint) inside a mass of pills, and adopting it destroys the mass.
    // Kept deliberately loose (1/4 of a unit) so genuine tray refinements,
    // where the pieces ARE pills and match within a factor of two, sail
    // through; only the ~20x mismatch of a glare-speck shatter is vetoed.
    const pieceMed = pillLike.length ? median(pillLike.map((p) => p.area)) : 0;
    const scaleVeto = unitArea > 0 && pieceMed > 0 && pieceMed < 0.25 * unitArea;
    const accept = pillLike.length >= 3 && score >= 0.5 && !scaleVeto;
    debug?.({ stage: 'refine', blobArea, kept, keptRatio: +keptRatio.toFixed(3),
      pillLike: pillLike.length, pillRatio: +pillRatio.toFixed(3), score: +score.toFixed(3), thr,
      unitArea, pieceMed, scaleVeto, accept });

    // POLARITY CHECK. The accept-test above only ever examines the side the
    // re-threshold KEPT; it never asks which side of the cut is the
    // medication. When the oversized blob is a PILE of same-coloured pills
    // fused to the surface texture between them (pills the MAJORITY of the
    // blob), the blob's median colour IS the pill colour, so
    // distance-from-surface keeps exactly the non-pill web — wood grain,
    // crevice shadows, specular rims — and discards every pill. Measured on
    // t3-cream-caplets-wood (134 counted for a dot-verified 48): the kept
    // side scored 0.719 (20 web knots read pill-like, pillRatio 0.099,
    // scaleVeto disarmed because no isolated pill existed pre-refine to set
    // unitArea) while the DISCARDED side was 31 single caplets + 8 small
    // clumps. Every calibration downstream (radiusEst 9.3 vs true 21, unit
    // 1839 vs true ~6100, stamp template) then locked onto web fragments and
    // certified the shatter-count.
    //
    // So measure the DISCARDED side too, and keep whichever side actually
    // looks like a same-medication population. The discriminator is
    // topological, not photometric: with the polarity inverted the KEPT side
    // is one connected lattice (the material BETWEEN pills) while the
    // complement decomposes into many same-scale pill-thick chunks; with the
    // polarity correct the complement is one crevice-network sheet (the
    // surface). Measured here, kept side: 75 pieces, dominant piece 50.0% of
    // its mass, median DT peak 8.2; complement (hole-filled): 31 pieces,
    // dominant 13.0%, median DT peak 26.0 — the two sides are not close on
    // any axis, which is what lets the flip gate demand every clause at
    // once. After the flip this photo calibrates unit 6598 (vs 1839 on the
    // web), radiusEst 25.6 (vs 9.3) and counts 43 for a dot-verified 48
    // (the 5 misses are glare/deep-shadow faces, the documented shiny-class
    // limitation) instead of 134.
    const compM = cv.Mat.zeros(bw.rows, bw.cols, cv.CV_8UC1);
    const cmd = compM.data;
    for (let i = 0; i < ll.length; i++) if (ll[i] === blob && !mask[i]) cmd[i] = 255;
    // Hole-fill the complement before measuring it: dark speckles and
    // imprint dots on a pill sit far from the blob's median colour, so they
    // read "kept" and punch interior holes that flatten each piece's
    // distance peak (measured on t3-cream-caplets-wood: single caplets read
    // peak 14.6 with holes vs ~21 filled). BFS from the frame border over
    // non-complement pixels; anything unreached is an enclosed hole.
    {
      const wq = bw.cols, hq = bw.rows;
      const seen = new Uint8Array(wq * hq);
      const qx = new Int32Array(wq * hq);
      let qh = 0, qt = 0;
      const push = (i) => { if (!seen[i] && !cmd[i]) { seen[i] = 1; qx[qt++] = i; } };
      for (let x = 0; x < wq; x++) { push(x); push((hq - 1) * wq + x); }
      for (let y = 0; y < hq; y++) { push(y * wq); push(y * wq + wq - 1); }
      while (qh < qt) {
        const i = qx[qh++];
        const x = i % wq, y = (i / wq) | 0;
        if (x > 0) push(i - 1);
        if (x < wq - 1) push(i + 1);
        if (y > 0) push(i - wq);
        if (y < hq - 1) push(i + wq);
      }
      for (let i = 0; i < wq * hq; i++) if (!cmd[i] && !seen[i]) cmd[i] = 255;
    }
    const compLab = new cv.Mat();
    cv.connectedComponents(compM, compLab);
    const compDist = new cv.Mat();
    cv.distanceTransform(compM, compDist, cv.DIST_L2, 5);
    const cl2 = compLab.data32S, cd2 = compDist.data32F;
    const pieces2 = new Map();
    let kept2 = 0;
    for (let i = 0; i < cl2.length; i++) {
      if (!cl2[i]) continue;
      kept2++;
      let p = pieces2.get(cl2[i]);
      if (!p) { p = { area: 0, peak: 0 }; pieces2.set(cl2[i], p); }
      p.area++;
      if (cd2[i] > p.peak) p.peak = cd2[i];
    }
    const sideStats = (list, total) => {
      const arr = list.filter((p) => p.area >= absFloor).sort((a, b) => b.area - a.area);
      const n = arr.length;
      const dom = n ? arr[0].area / Math.max(1, total) : 0;
      const medA2 = n ? median(arr.map((p) => p.area)) : 0;
      const medPk = n ? median(arr.map((p) => p.peak)) : 0;
      // modal (same-medication) cohort share of this side's mass
      const cohort = arr.filter((p) => p.area >= 0.6 * medA2 && p.area <= 1.5 * medA2);
      const cohShare = total ? cohort.reduce((a, p) => a + p.area, 0) / total : 0;
      return { n, dom, medA: medA2, medPk, coh: cohort.length, cohShare,
        top: arr.slice(0, 12).map((p) => `a${p.area | 0}p${p.peak.toFixed(1)}`) };
    };
    const sk = sideStats([...pieces.values()], kept);
    const sc2 = sideStats([...pieces2.values()], kept2);
    // The flip exists ONLY to stop an ACCEPT from adopting an inverted
    // mask. When the kept side is being rejected anyway, the revert path
    // (fused pile -> clump/mass machinery) is the measured-correct road —
    // the advil trio reaches 30/30/30 exact through it, and flipping there
    // instead read 30/24/31 (glare-heavy tablets shred under any
    // photometric cut; the raft machinery does not care). So `accept` is a
    // hard precondition, and the flip additionally demands the full
    // inverted-polarity signature, every clause measured on both sides:
    //   comp.n >= 6          a POPULATION of pieces — a surface-sheet
    //                        complement is 1-4 (cream 31; beige-90 tray 4,
    //                        lightblue 4)
    //   comp.dom <= 0.35     no sheet dominance on the complement
    //                        (cream 0.13; beige-90 0.97, lightblue 0.95)
    //   kept.dom >= 0.40     the kept side IS a connected lattice — one
    //                        piece holding >=40% of its mass (cream 0.50;
    //                        a genuine pills-kept refine spreads its mass:
    //                        beige-90 kept.dom 0.066)
    //   comp.medPk >= 6 and >= 1.5x kept.medPk
    //                        complement pieces carry pill thickness, kept
    //                        pieces are web-thin (cream 26.0 vs 8.2 — the
    //                        contact-independent DT half-width witness)
    //   scale sanity         when isolated pills DID exist pre-refine
    //                        (unitArea > 0), complement pieces must be on
    //                        that scale, same rule as scaleVeto above.
    const scaleVeto2 = unitArea > 0 && sc2.medA > 0 && sc2.medA < 0.25 * unitArea;
    const flip = accept && sc2.n >= 6 && sc2.dom <= 0.35 && sk.dom >= 0.40
      && sc2.medPk >= 6 && sc2.medPk >= 1.5 * sk.medPk && !scaleVeto2;
    debug?.({ stage: 'refine2',
      kept: { total: kept, n: sk.n, dom: +sk.dom.toFixed(3), medA: sk.medA,
        medPk: +sk.medPk.toFixed(1), coh: sk.coh, cohShare: +sk.cohShare.toFixed(3) },
      comp: { total: kept2, n: sc2.n, dom: +sc2.dom.toFixed(3), medA: sc2.medA,
        medPk: +sc2.medPk.toFixed(1), coh: sc2.coh, cohShare: +sc2.cohShare.toFixed(3) },
      scaleVeto2, flip });

    if (flip) {
      // Keep the discarded side: it, not the kept side, is the pill
      // population. cmd is the hole-filled complement, so pill interiors
      // come back whole (speckle holes sealed), rims and web stay out.
      for (let i = 0; i < ll.length; i++) if (ll[i] === blob) mask[i] = cmd[i] ? 255 : 0;
      refined++;
    } else if (accept) {
      refined++;
    } else {
      for (let i = 0; i < ll.length; i++) if (ll[i] === blob) mask[i] = 255;
    }
    compM.delete(); compLab.delete(); compDist.delete();
    subLab.delete(); subDist.delete();
  }
  lab.delete();
  return refined > 0;
}

// When pill colors are bimodal (colored + near-white on a light surface),
// Otsu splits colored-vs-rest and drops the faint pills. Re-threshold the
// residual background and admit only compact pill-shaped pieces.
function rescueSecondMode(cv, distBg, bw, absFloor, src, bgLum, debug) {
  // Size/thickness profile of pills already found — rescued pieces must match
  // (same-medication prior). No confirmed pills => nothing to calibrate against.
  const preLab = new cv.Mat();
  cv.connectedComponents(bw, preLab);
  const preDist = new cv.Mat();
  cv.distanceTransform(bw, preDist, cv.DIST_L2, 5);
  const pl = preLab.data32S, pd = preDist.data32F;
  const pre = new Map();
  for (let i = 0; i < pl.length; i++) {
    if (!pl[i]) continue;
    let p = pre.get(pl[i]);
    if (!p) { p = { area: 0, peak: 0 }; pre.set(pl[i], p); }
    p.area++;
    if (pd[i] > p.peak) p.peak = pd[i];
  }
  preLab.delete(); preDist.delete();
  // COMPACTNESS, so medA learns from pills rather than from the board.
  // `confirmed` selects on area >= absFloor and peak >= 4, which a long thin
  // wood-grain BAND passes as easily as a pill. medA is the median of these
  // and every bound below is relative to it, so one bad median poisons the
  // whole stage: measured on the adversarial wood chain, medA came out 4869
  // against a true pill of ~530 and rescue admitted eight 12k-53k px pieces,
  // counting 60 for 9.
  //
  // A pill's area is close to the disc implied by its own half-thickness
  // (530px against pi*13^2 = 531, a ratio of 1.0). A band is many times that
  // -- 12182px against pi*15.8^2 = 784, a ratio of 15.5. The test needs no
  // scale estimate, only the component's own two measurements. 6x is generous
  // enough for a touching pair or a short chain to survive.
  const compactOnly = [...pre.values()].filter((p) => p.area >= absFloor && p.peak >= 4
    && p.area <= 6 * Math.PI * p.peak * p.peak);
  const confirmed = compactOnly.length >= 3
    ? compactOnly
    : [...pre.values()].filter((p) => p.area >= absFloor && p.peak >= 4);
  if (confirmed.length < 1) return 0;
  // A SHATTERED MASK HAS NO CONFIRMED PILLS TO LEARN FROM.
  // Everything below calibrates on medA, the median CONFIRMED-pill area. On a
  // textured board the "confirmed pills" are grain: measured on the
  // adversarial noise chain, 1531 components with a median of 21px against a
  // largest of 5668px, and medA came out 127.5 -- so rUnit, the shadow
  // polarity margins and the acceptance shape tests were all sized to noise.
  // Rescue then reinstated hundreds of specks and the image counted 279 for 9.
  //
  // The grain purge later drops 1530 of them, but by then the damage is done:
  // rescue runs at this point, long before any trustworthy scale exists.
  // Refusing to run at all is the honest response -- rescue exists to recover
  // pill material the threshold missed, and it cannot do that from a mask
  // where it cannot tell a pill from the board.
  {
    const areas = [...pre.values()].map((q) => q.area).filter((a) => a >= 4).sort((a, b) => a - b);
    const tot = areas.length;
    const med = tot ? areas[tot >> 1] : 0;
    const big = tot ? areas[tot - 1] : 0;
    // Same two arms as the mask-shattered test later in the pipeline: the
    // median-to-largest ratio needs a big fused blob to compare against, and a
    // DENSE board of small pills has none. Measured on adv-dense-noise, 1627
    // components with a median of 24px against a largest of only 789px, so the
    // ratio arm alone missed it and rescue ran on pure grain.
    if ((tot >= 150 && big > 0 && med < 0.02 * big) || tot >= 800) {
      debug?.({ stage: 'rescue-refused', components: tot, medianArea: med, largest: big });
      return 0;
    }
  }
  const medA = median(confirmed.map((p) => p.area));
  const medP = median(confirmed.map((p) => p.peak));

  const db = distBg.data, mask = bw.data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) { hist[db[i]]++; n++; }
  }
  if (!n) return 0;
  const t2 = otsuFromHist(hist, n);
  if (t2 < 5) return 0; // residual is flat noise, nothing hiding in it

  const cand = new cv.Mat(bw.rows, bw.cols, cv.CV_8UC1);
  const cd = cand.data;
  // Union with the existing mask: a faint pill whose specular highlight was
  // already segmented must be measured as a full disk, not an annulus (the
  // hole flattens its distance peak and fails the thickness filter).
  for (let i = 0; i < mask.length; i++) cd[i] = mask[i] || db[i] > t2 ? 255 : 0;
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(cand, cand, cv.MORPH_OPEN, k, new cv.Point(-1, -1), 2);

  const lab = new cv.Mat();
  cv.connectedComponents(cand, lab);
  const dist = new cv.Mat();
  cv.distanceTransform(cand, dist, cv.DIST_L2, 5);
  const ll = lab.data32S, dd = dist.data32F;
  const sd = src.data;
  const pieces = new Map();
  for (let i = 0; i < ll.length; i++) {
    if (!ll[i]) continue;
    let p = pieces.get(ll[i]);
    if (!p) { p = { area: 0, peak: 0, dtSum: 0, newArea: 0, lumSum: 0, oldArea: 0, oldLum: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1 }; pieces.set(ll[i], p); }
    p.area++;
    p.dtSum += dd[i];
    {
      const px = i % cand.cols, py = (i / cand.cols) | 0;
      if (px < p.x0) p.x0 = px;
      if (px > p.x1) p.x1 = px;
      if (py < p.y0) p.y0 = py;
      if (py > p.y1) p.y1 = py;
    }
    const q = i * 4;
    const lum = (sd[q] + sd[q + 1] + sd[q + 2]) / 3;
    if (!mask[i]) {
      p.newArea++;
      p.lumSum += lum;
    } else {
      // Luminance of the piece's ALREADY-CONFIRMED pill material, which fixes
      // the polarity a genuine pill has against this background.
      p.oldArea++;
      p.oldLum += lum;
    }
    if (dd[i] > p.peak) p.peak = dd[i];
  }
  debug?.({ stage: 'rescue', t2, medA, medP, pieces: [...pieces.values()].filter((p) => p.area > 2.2 * medA).map((p) => `a${p.area | 0}p${p.peak.toFixed(1)}m${(p.dtSum / p.area / p.peak).toFixed(2)}n${(p.newArea / p.area).toFixed(2)}`).slice(0, 40) });
  // Unit pill radius implied by the confirmed-pill median area (medP is
  // unreliable pre-fillHoles: specular holes flatten the distance peak).
  const rUnit = Math.sqrt(medA / Math.PI);

  // SHADOW POLARITY. Distance-from-background is UNSIGNED: a cast shadow sits
  // beside the pill, is darker than the surface, and therefore scores as
  // foreground exactly like the pill does. Sign is what separates them. A pill
  // has a fixed polarity against the background (bright pill on dark tray, or
  // dark pill on white paper); its cast shadow ALWAYS falls on the dark side,
  // whichever way the pill went. So compare the material rescue wants to ADD
  // against the pill material already confirmed inside the same piece:
  //   - addition on the same side as the pill  -> more pill, keep it
  //   - addition on the dark side when the pill is bright -> shadow, drop it
  // Measured on r-cc7a2ada: confirmed pill material sits at luminance 188-209
  // over a background of 121, while the material being added sits at 73-92 —
  // opposite sides of the background, a 100+ unit gap. That addition was 30%
  // of the blob's final area and is precisely the "webbing" between pills.
  // A piece with no confirmed material (oldArea 0) is a wholly new find with
  // no polarity to compare against, so it is judged on shape alone as before.
  // An ON-EDGE pill is pill material at pill brightness, so it passes cleanly.
  // The margin matters: material a few units under the background is ordinary
  // shading on the pill's own curved flank and must be kept, or real pills are
  // lost. Only DECISIVE darkening is a cast shadow — r-cc7a2ada's additions sit
  // 29-48 below background, while legitimate flank shading on
  // synth2-rc-kraft-small sits 9-16 below, so a cut at 20 clears both.
  const SHADOW_MARGIN = 20;
  const shadowLike = (p) => {
    if (!p.oldArea || !p.newArea) return false;
    const nl = p.lumSum / p.newArea, ol = p.oldLum / p.oldArea;
    // Pill must be clearly brighter than the background for "darker than
    // background" to mean shadow rather than "this medication is dark".
    if (ol <= bgLum + 10) return false;
    return nl < bgLum - SHADOW_MARGIN;
  };

  // LINEAR MASS DENSITY — does the piece carry chain-like mass along its span?
  //
  // The chain clause below admits a piece far larger than one pill on the
  // theory that it is several touching pills. That theory makes a hard
  // geometric prediction: a run of same-size pills laid end to end carries
  // about ONE pill's area for every ONE pill-diameter it spans. Density is
  // therefore ~1 and cannot fall far below it, however the chain bends.
  //
  // A pill welded to a surviving ruled-line fragment breaks that prediction
  // completely. The line contributes enormous SPAN and almost no AREA, so
  // density collapses. This is the failure on lined paper: the ruled-line
  // suppression removes most of each line but leaves dashes, the closing
  // welds the dashes into a continuous hairline, and the chain clause then
  // adopts the whole wire as "touching pills". Measured across every image in
  // the corpus that reaches this clause (area in unit-pill areas divided by
  // span in pill diameters):
  //     ruled-line wires:  0.366, 0.439   <- lined-bfdbfef9, lined-503b3041
  //     genuine chains:    0.621 ... 1.287 (21 pieces, 9 photos)
  // No overlap, and a 1.4x gap at the boundary. 0.55 sits in the middle of
  // that gap. The quantity is a shape fact about the piece, not a level.
  const chainDensity = (p) => {
    const bwid = p.x1 - p.x0 + 1, bhei = p.y1 - p.y0 + 1;
    const span = Math.sqrt(bwid * bwid + bhei * bhei) / (2 * rUnit);
    return span > 0 ? (p.area / medA) / span : 0;
  };

  const good = new Set([...pieces.entries()]
    .filter(([, p]) => (p.area >= Math.max(absFloor, 0.45 * medA) && p.area <= 2.2 * medA
      && p.peak >= Math.max(4, 0.5 * medP) && p.area <= 4 * Math.PI * p.peak * p.peak
      && !shadowLike(p))
      // Touching CHAIN of same-medication pills: single-pill thickness but a
      // multi-unit area. Watershed + area-split handle the separation later.
      // The new material must not be darker than the background — a pill
      // glued to its own shadow ring mimics a chain geometrically, but its
      // new material is shadow (dark), not pill (bright).
      || (p.area > 2.2 * medA && p.area <= 12 * medA
        && p.peak >= 0.8 * rUnit && p.peak <= 1.35 * rUnit
        && p.lumSum >= (bgLum - 6) * p.newArea
        && chainDensity(p) >= 0.55
        // A LARGE PIECE MUST CONTAIN A CONFIRMED PILL. This arm exists for a
        // touching CHAIN of pills -- single-pill thickness, multi-unit area --
        // which by definition already holds confirmed pill material. Nothing
        // required that, so a wholly-new region qualified on shape alone.
        // Measured on the adversarial wood chain: rescue admitted eight
        // pieces of 12k-53k px, every one with newArea == area (no confirmed
        // pill inside), because medA was 4869 -- itself learned from the wood
        // GRAIN, so every medA-relative bound inherited the error. The image
        // counted 60 for 9. Requiring a confirmed seed is scale-free and is
        // what "extend a pill" already means.
        && p.oldArea > 0))
    .map(([l]) => l));
  let added = 0;
  if (good.size && good.size <= 500) {
    for (let i = 0; i < ll.length; i++) {
      if (good.has(ll[i])) { mask[i] = 255; added++; }
    }
  }

  // Oversized pieces (> 12*medA) are ambiguous as a whole: a mega-cluster of
  // faint pills looks just like already-masked pills grouted together by
  // shadow. Decide by their NEW material alone — pill chains stay pill-thick,
  // shadow grout is a thin web that fails the same shape filters.
  const bigSet = new Set([...pieces.entries()]
    .filter(([, p]) => p.area > 12 * medA).map(([l]) => l));
  if (bigSet.size) {
    const cand2 = new cv.Mat(bw.rows, bw.cols, cv.CV_8UC1);
    const c2 = cand2.data;
    for (let i = 0; i < ll.length; i++) c2[i] = bigSet.has(ll[i]) && !mask[i] ? 255 : 0;
    const lab2 = new cv.Mat();
    cv.connectedComponents(cand2, lab2);
    const dist2 = new cv.Mat();
    cv.distanceTransform(cand2, dist2, cv.DIST_L2, 5);
    const l2 = lab2.data32S, d2 = dist2.data32F;
    const sub = new Map();
    const W = bw.cols;
    for (let i = 0; i < l2.length; i++) {
      if (!l2[i]) continue;
      let p = sub.get(l2[i]);
      if (!p) { p = { area: 0, peak: 0, perim: 0, contact: 0, lumSum: 0 }; sub.set(l2[i], p); }
      p.area++;
      const q2 = i * 4;
      p.lumSum += (sd[q2] + sd[q2 + 1] + sd[q2 + 2]) / 3;
      if (d2[i] > p.peak) p.peak = d2[i];
      // Boundary/contact topology: shadow grout hugs already-masked pills
      // (contact along most of its perimeter); a chain of faint pills mostly
      // borders open background.
      const nb = [i - 1, i + 1, i - W, i + W];
      let isB = false, isC = false;
      for (const j of nb) {
        if (j < 0 || j >= l2.length || l2[j] !== l2[i]) {
          isB = true;
          if (j >= 0 && j < l2.length && mask[j]) isC = true;
        }
      }
      if (isB) p.perim++;
      if (isC) p.contact++;
    }
    debug?.({ stage: 'rescue2', subs: [...sub.values()].filter((p) => p.area >= 0.45 * medA).map((p) => `a${p.area | 0}p${p.peak.toFixed(1)}c${(p.contact / Math.max(1, p.perim)).toFixed(2)}`).slice(0, 40) });
    // Chain subcomps must be thicker than a lone pill radius: overlapping
    // pills with shadow-filled crevices push the distance peak ABOVE rUnit,
    // while shadow-grout webs between pills stay below it.
    const good2 = new Set([...sub.entries()]
      .filter(([, p]) => (p.area >= Math.max(absFloor, 0.45 * medA) && p.area <= 2.2 * medA
        && p.peak >= Math.max(4, 0.5 * medP) && p.area <= 4 * Math.PI * p.peak * p.peak)
        || (p.area > 2.2 * medA && p.area <= 6 * medA
          && p.peak >= 1.05 * rUnit && p.peak <= 1.35 * rUnit
          && p.lumSum >= (bgLum - 6) * p.area))
      .map(([l]) => l));
    if (good2.size && good2.size <= 500) {
      for (let i = 0; i < l2.length; i++) {
        if (good2.has(l2[i])) { mask[i] = 255; added++; }
      }
    }
    cand2.delete(); lab2.delete(); dist2.delete();
  }

  k.delete(); cand.delete(); lab.delete(); dist.delete();
  return added;
}

// Flatten uneven illumination (vignettes, side-light gradients): estimate the
// lighting field as a heavy low-resolution blur of luminance and divide it
// out. The field cells are far larger than a pill, so pills barely perturb it.
function flattenIllumination(cv, src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const fw = 24, fh = Math.max(2, Math.round(24 * src.rows / src.cols));
  const small = new cv.Mat();
  cv.resize(gray, small, new cv.Size(fw, fh), 0, 0, cv.INTER_AREA);
  cv.GaussianBlur(small, small, new cv.Size(5, 5), 0);
  const field = new cv.Mat();
  cv.resize(small, field, gray.size(), 0, 0, cv.INTER_LINEAR);
  const meanL = cv.mean(field)[0];
  const f = field.data, d = src.data;
  for (let i = 0, p = 0; i < f.length; i++, p += 4) {
    // Cap the gain: vignettes need ~1.5x at the corners, but larger gains
    // amplify dark-surface texture (fabric weave) into phantom pills.
    const k = Math.min(1.5, Math.max(0.7, meanL / Math.max(30, f[i])));
    if (k > 1.02 || k < 0.98) {
      d[p] = Math.min(255, d[p] * k);
      d[p + 1] = Math.min(255, d[p + 1] * k);
      d[p + 2] = Math.min(255, d[p + 2] * k);
    }
  }
  gray.delete(); small.delete(); field.delete();
}

// RULED-LINE (thin dark filament) SUPPRESSION.
//
// Measured failure: ~19 tan caplets on WHITE LINED PAPER counted 14 and 8.
// The cause is NOT shadows and NOT over-erosion. On p-69204ff4.jpg the halo
// just outside each pill measures median luma 205 against far paper at 210 —
// there is no dark shadow ring at all, and 0.0% of those halo pixels fall on
// the foreground side of Otsu (thr=171). What DOES fall on the foreground
// side is the PRINTED RULING: the blue lines measure median luma 150-160,
// darker than the cut, so they threshold as "pill". They are 33-37% of all
// foreground pixels and they run edge to edge, so they act as wires that
// weld every pill into one blob. Measured on the raw Otsu mask: the largest
// blob is 26791 px; delete just the line pixels and the largest drops to
// 1222 px with 85 separate blobs. Raising the threshold does NOT fix this —
// the merged blob grows monotonically (26791 -> 44376 -> 83236 -> 133038 as
// thr goes 171 -> 181 -> 191 -> 206), because a higher cut swallows more
// paper, not less line.
//
// The fix is a grayscale morphological CLOSING, applied BEFORE any
// thresholding so every downstream stage sees clean paper. Closing by a disc
// of radius r erases dark structures thinner than the disc and leaves
// everything wider untouched: a 2-4 px ruled line disappears, while a pill
// tens of px across is unchanged (its interior is never reached by the
// structuring element). This is strictly a same-or-brighter operation, so it
// can only remove dark filaments — it can never invent foreground.
//
// SELF-CALIBRATING TRIGGER. We do not want to touch the primary dark-board
// photos, where pills are BRIGHTER than the background and there is no thin
// dark structure to remove. Two conditions gate the operation, both measured
// from the image:
//   1. The background must be BRIGHT relative to the foreground. Only then
//      can a dark filament be a surface marking rather than a pill.
//   2. Closing must actually change a meaningful slice of the FOREGROUND.
//      We threshold before and after and require that the closing removes a
//      real share of foreground pixels. On lined paper this is 20-40%; on a
//      dark cutting board it is ~0%, so the whole stage no-ops.
// The radius is derived from the image's own scale, not a magic constant.
function suppressThinDarkLines(cv, src, debug) {
  const w = src.cols, h = src.rows;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  const before = new cv.Mat();
  const thr = cv.threshold(gray, before, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

  // Condition 1: the BACKGROUND must be the bright side. Thin dark markings
  // can only be surface print if the surface they sit on is brighter than
  // them; on a dark board the dark class IS the background and this whole
  // stage is meaningless (worse: the closing would erase the gaps between
  // bright pills and weld them together).
  //
  // Decide this from the BORDER, not from the size of the dark class. A
  // frame-area test fails on sparse scenes: r-90dbe20e.jpg is three pills on
  // dark grey fabric, where the dark class is only 0.448 of the frame and so
  // slipped under a 0.5 area gate — the closing then fired on the primary
  // dark-background use case and cost the real corpus an exact count
  // (13/20 -> 12/20). The border is background essentially by definition, so
  // comparing border luma against the Otsu cut answers the actual question:
  // "is the surface the bright class?"
  const bt = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const gdb = gray.data;
  let borderSum = 0, borderN = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < bt || y >= h - bt;
    for (let x = 0; x < w; x += 2) {
      if (!edgeRow && x >= bt && x < w - bt) continue;
      borderSum += gdb[y * w + x]; borderN++;
    }
  }
  const borderLum = borderN ? borderSum / borderN : 0;
  const darkFrac = cv.countNonZero(before) / (w * h);
  // The border must sit CLEARLY on the bright side, not merely a shade above
  // the cut. On r-90dbe20e.jpg (three pills on dark grey fabric) the border
  // measures 91 against a cut of 89 — nominally "bright", but a 2-level
  // margin is noise, and acting on it fired the closing on a dark-background
  // photo. Genuine bright surfaces clear the cut by a real margin: the lined
  // photos measure 182 vs 173, 157 vs 136. Requiring a separation
  // proportional to the cut keeps this scale-free rather than a fixed step.
  if (borderLum <= thr * 1.04) {
    gray.delete(); before.delete();
    debug?.({ stage: 'lines', skipped: 'dark-background', borderLum: Math.round(borderLum), thr, darkFrac: +darkFrac.toFixed(3) });
    return false;
  }

  // Radius: a ruled line is a hairline at any sane photo distance. Scale it
  // off the frame so the same physical line width is caught at 393px and at
  // 1280px. r ~= 1.3% of the short side, floored at 3px (below that the
  // closing cannot bridge a 2px line plus its antialiasing).
  const r = Math.max(3, Math.round(Math.min(w, h) * 0.013));
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
  const closed = new cv.Mat();
  cv.morphologyEx(gray, closed, cv.MORPH_CLOSE, k);

  // Condition 2: how much of the ORIGINAL foreground was thin dark filament?
  // Measure this directly, at the FIXED original threshold, by asking which
  // foreground pixels the closing lifted above that same cut. Re-running Otsu
  // on the closed image and differencing the two foreground counts does NOT
  // work: removing the lines changes the histogram, so Otsu moves, and the new
  // cut can admit far MORE paper than the lines ever covered — measured
  // `removed` = -4.3 on p-0ae0c302 and -4.5 on p-bfdbfef9, i.e. the metric
  // went sharply negative on exactly the lined-paper images it exists to
  // catch. Holding the threshold fixed makes this a clean subset count:
  // filament pixels are those that were below the cut and are no longer.
  const bd = before.data, gd0 = gray.data, cd0 = closed.data;
  let fgBefore = 0, filament = 0;
  for (let i = 0; i < bd.length; i++) {
    if (!bd[i]) continue;          // was background: irrelevant
    fgBefore++;
    if (cd0[i] > thr && gd0[i] <= thr) filament++; // closing lifted it out
  }
  const removed = fgBefore > 0 ? filament / fgBefore : 0;

  // Condition 3 — IS THE THIN DARK STUFF ACTUALLY LINEAR?
  //
  // `removed` alone is not enough. It counts dark pixels the closing lifted,
  // but it cannot tell a printed RULE from the dark GAP between two bright
  // touching pills — both are dark, both are thin-ish, and a closing fills
  // both. On t2-advil-scatter-dark-1.jpg (28 bright orange tablets on navy)
  // `removed` reads 0.299, over any sane cut, and firing there was
  // catastrophic: the closing welds the inter-pill gaps shut, the raft
  // becomes one mass, and the count explodes 28 -> 135. A "is the dark class
  // thin?" test does not separate them either — measured in-pipeline, the
  // surviving fraction is 0.70 for advil against 0.57-0.66 for lined paper,
  // which overlaps.
  //
  // What a ruled line uniquely IS, and an inter-pill wedge never is, is
  // LONG AND STRAIGHT. Test exactly that: open the filament pixels with a
  // long thin bar at each angle and keep the best-matching orientation. A
  // real ruling contains a bar spanning a quarter of the frame; a wedge
  // between two round tablets cannot contain one at any angle. Measured:
  //     lined paper:  0.095, 0.067, 0.033, 0.016  (all at 0deg — one ruling)
  //     everything else: 0.000, exactly, on every image tested
  // The separation is total, and the quantity is a shape fact about the
  // image rather than a tuned level.
  const barLen = (Math.round(Math.min(w, h) * 0.25) | 1);
  const fil = cv.Mat.zeros(h, w, cv.CV_8UC1);
  const fd = fil.data;
  for (let i = 0; i < bd.length; i++) {
    if (bd[i] && cd0[i] > thr && gd0[i] <= thr) fd[i] = 255;
  }
  let linear = 0;
  if (filament > 0 && barLen >= 9) {
    const c = (barLen - 1) / 2;
    for (let deg = 0; deg < 180; deg += 10) {
      const se = cv.Mat.zeros(barLen, barLen, cv.CV_8UC1);
      const rad = deg * Math.PI / 180, ca = Math.cos(rad), sa = Math.sin(rad);
      for (let t = -c; t <= c; t += 0.5) {
        const x = Math.round(c + t * ca), y = Math.round(c + t * sa);
        if (x >= 0 && x < barLen && y >= 0 && y < barLen) se.ucharPtr(y, x)[0] = 1;
      }
      const op = new cv.Mat();
      cv.morphologyEx(fil, op, cv.MORPH_OPEN, se);
      const fr = cv.countNonZero(op) / filament;
      if (fr > linear) linear = fr;
      op.delete(); se.delete();
    }
  }
  fil.delete();

  // Require a real ruling to be present. 0.01 sits an order of magnitude
  // above the exact-zero every non-lined image measures, and well below the
  // 0.016 floor of the lined set.
  const APPLY = removed >= 0.12 && linear >= 0.01;
  if (APPLY) {
    // Write the closing back into the COLOR image, as a per-pixel brightness
    // gain. Working through a gain (rather than overwriting with gray) keeps
    // the pill hue intact for the color-distance stage downstream: pills are
    // unchanged because closing barely moves them, while line pixels get
    // pulled up to the surrounding paper level and lose their darkness.
    const gd = gray.data, cd = closed.data, sd = src.data;
    for (let i = 0, p = 0; i < gd.length; i++, p += 4) {
      const lift = cd[i] - gd[i];
      if (lift <= 2) continue; // pill interiors: closing changed nothing
      const gain = cd[i] / Math.max(1, gd[i]);
      sd[p] = Math.min(255, sd[p] * gain);
      sd[p + 1] = Math.min(255, sd[p + 1] * gain);
      sd[p + 2] = Math.min(255, sd[p + 2] * gain);
    }
  }
  debug?.({ stage: 'lines', applied: APPLY, r, thr, borderLum: Math.round(borderLum), darkFrac: +darkFrac.toFixed(3), removed: +removed.toFixed(3), linear: +linear.toFixed(3) });

  gray.delete(); before.delete(); closed.delete(); k.delete();
  return APPLY;
}

// Pills are solid: any background component fully enclosed by foreground is
// an artifact (specular highlight, engraving) — fill it.
function fillHoles(cv, bw, debug) {
  const md0 = bw.data.slice();          // foreground BEFORE any filling
  const inv = new cv.Mat();
  cv.bitwise_not(bw, inv);
  const lab = new cv.Mat();
  const n = cv.connectedComponents(inv, lab);
  const ll = lab.data32S;
  const w = bw.cols, h = bw.rows;
  const touchesBorder = new Uint8Array(n + 1);
  for (let x = 0; x < w; x++) { touchesBorder[ll[x]] = 1; touchesBorder[ll[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { touchesBorder[ll[y * w]] = 1; touchesBorder[ll[y * w + w - 1]] = 1; }
  if (debug) {
    const sizes = new Map();
    for (let i = 0; i < ll.length; i++) {
      if (ll[i] && !touchesBorder[ll[i]]) sizes.set(ll[i], (sizes.get(ll[i]) || 0) + 1);
    }
    debug({ stage: 'holes', n: sizes.size, sizes: [...sizes.values()].sort((a, b) => b - a).slice(0, 25) });
  }
  // A COURTYARD IS NOT A HIGHLIGHT. This fills any enclosed background
  // component, at any size -- but the things it exists to remove (specular
  // highlights, engraved score lines) are a small fraction of ONE pill, while
  // pills arranged in a closed loop enclose a hole that is a large fraction
  // of ALL the pill material in the photo.
  //
  // Measured on the adversarial ring (12 pills of R=13 in a circle): the
  // central courtyard is 4765px against 6122px of foreground -- 78% -- while
  // the 12 genuine engraving holes are 68-91px, i.e. 1.5%. Filling the
  // courtyard turned the donut into a solid disc of 11796px, so radiusEst
  // read 54.6 instead of 13, no scale witness fired, and consolidate merged
  // the whole ring into ONE pill. The separation between the two classes is
  // 52x, so the bound does not need to be delicate.
  //
  // Scale-free on purpose: fillHoles runs before radiusEst exists, so the
  // test is a fraction of the photo's own foreground rather than a pill size.
  let fgCount = 0;
  for (let i = 0; i < md0.length; i++) if (md0[i]) fgCount++;
  const holeArea = new Map();
  for (let i = 0; i < ll.length; i++) {
    if (ll[i] && !touchesBorder[ll[i]]) holeArea.set(ll[i], (holeArea.get(ll[i]) || 0) + 1);
  }
  const tooBig = new Set();
  for (const [id, a] of holeArea) if (fgCount > 0 && a > 0.25 * fgCount) tooBig.add(id);
  if (tooBig.size) {
    debug?.({ stage: 'holes-refused', n: tooBig.size, fg: fgCount,
      sizes: [...tooBig].map((id) => holeArea.get(id)).sort((a, b) => b - a).slice(0, 5) });
  }
  const md = bw.data;
  for (let i = 0; i < ll.length; i++) {
    if (ll[i] && !touchesBorder[ll[i]] && !tooBig.has(ll[i])) md[i] = 255;
  }
  inv.delete(); lab.delete();
}

// Cut strong interior intensity edges (the creases where touching pills
// meet) out of a mask copy. Used to calibrate the single-pill unit area when
// pills form one connected clump with no isolated specimen.
function cutCreases(cv, src, mask) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
  const gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat();
  cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
  cv.magnitude(gx, gy, mag);
  const mg = mag.data32F, md = mask.data;
  // Threshold at a high percentile of the in-mask gradient.
  const vals = [];
  for (let i = 0; i < md.length; i += 3) if (md[i]) vals.push(mg[i]);
  vals.sort((a, b) => a - b);
  const thr = Math.max(30, vals[Math.floor(vals.length * 0.86)] || 1e9);
  for (let i = 0; i < md.length; i++) if (md[i] && mg[i] > thr) md[i] = 0;
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k, new cv.Point(-1, -1), 1);
  gray.delete(); gx.delete(); gy.delete(); mag.delete(); k.delete();
}

function toImageData(source) {
  if (source && source.data && source.width && source.height) return source;
  if (source && typeof source.getContext === 'function') {
    return source.getContext('2d').getImageData(0, 0, source.width, source.height);
  }
  throw new Error('countPills needs a canvas or an ImageData-like {data,width,height}');
}

// Iteratively estimate the single-pill area assuming all pills are the same
// medication (the pharmacy case): clusters converge to integer multiples.
function estimateUnitArea(areas) {
  if (!areas.length) return 0;
  let unit = median(areas);
  for (let pass = 0; pass < 3; pass++) {
    const perUnit = areas.map((a) => a / Math.max(1, Math.round(a / unit)));
    unit = median(perUnit);
  }
  return unit;
}

// Second-moment axes of a labelled blob, in pixels. For an ellipse-like
// region the eigenvalues of the covariance matrix give semi-axes 2*sqrt(l);
// this is the same quantity fitEllipse reports, without needing contours.
// Returns {major, minor} full-axis lengths.
function blobAxes(bl, w, l, box) {
  let n = 0, sx = 0, sy = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      if (bl[row + x] !== l) continue;
      n++; sx += x; sy += y;
    }
  }
  if (n < 2) return { major: 0, minor: 0 };
  const mx = sx / n, my = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      if (bl[row + x] !== l) continue;
      const dx = x - mx, dy = y - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
  }
  cxx /= n; cyy /= n; cxy /= n;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  return { major: 4 * Math.sqrt(Math.max(0, l1)), minor: 4 * Math.sqrt(l2) };
}

// -- SHAPE CLASSIFICATION (one medication => one shape) ---------------------
//
// Every pill primitive we care about (circle, ellipse/oval, capsule/caplet,
// rounded rectangle) is CONVEX and FILLS its own oriented bounding box to a
// characteristic, primitive-specific fraction:
//
//   fill = area / (major * minor)      circle/ellipse  pi/4 = 0.785
//                                      capsule/stadium 0.79..0.86 (aspect-dep)
//                                      roundrect       0.87..0.95
//                                      rectangle       1.00
//
// Measured on the clean corpus, real pills land at fill 0.78-0.86 with
// solidity 0.93-0.99. Texture fragments (paper-towel weave, wood grain, cloth)
// are wildly NON-convex: measured fill 0.26-0.40, solidity 0.40-0.51. That is
// a ~100x gap in fit residual, so it separates cleanly.
//
// Convex-hull area of a labelled blob, via a monotone-chain hull over the
// blob's per-row x-extremes. A convex hull only ever touches the leftmost and
// rightmost pixel of each row, so scanning row extremes is exact and costs one
// pass instead of a full contour trace.
function blobHullArea(bl, w, l, box) {
  const pts = [];
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    let lo = -1, hi = -1;
    for (let x = box.x0; x <= box.x1; x++) {
      if (bl[row + x] !== l) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    pts.push([lo, y]);
    if (hi !== lo) pts.push([hi, y]);
  }
  if (pts.length < 3) return 0;
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (src) => {
    const st = [];
    for (const p of src) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], p) <= 0) st.pop();
      st.push(p);
    }
    st.pop();
    return st;
  };
  const hull = build(pts).concat(build([...pts].reverse()));
  if (hull.length < 3) return 0;
  let a2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  // +0.5*perimeter-ish correction is not needed: both hull and pixel area are
  // measured in the same pixel-centre coordinates, so the ratio is unbiased
  // for blobs more than a few px across (all pill-sized blobs qualify).
  return Math.abs(a2) / 2;
}

// Which convex primitive does this (fill, aspect) pair best describe, and how
// far off is it? Returns {primitive, err} where err is the absolute fill
// deviation from that primitive's ideal at this aspect ratio.
//
// The catalogue is deliberately tiny — these are the only shapes a tablet or
// capsule press produces. A blob that fits NONE of them well is not a pill of
// any kind, regardless of what the other pills in the photo look like.
function fitPrimitive(fill, aspect) {
  const a = Math.max(1, aspect);
  const cands = [
    // circle / round tablet: only meaningful when nearly isotropic
    { primitive: 'circle', ideal: Math.PI / 4, penalty: a > 1.25 ? (a - 1.25) : 0 },
    // ellipse / oval tablet: pi/4 at every aspect
    { primitive: 'ellipse', ideal: Math.PI / 4, penalty: 0 },
    // capsule / caplet (stadium): two half-discs joined by a rectangle.
    // area = minor*(major-minor) + pi/4*minor^2  =>  fill = 1 - (1-pi/4)/a
    { primitive: 'capsule', ideal: 1 - (1 - Math.PI / 4) / a, penalty: a < 1.35 ? (1.35 - a) * 0.5 : 0 },
    // rounded rectangle with corner radius ~ minor/4:
    // area = major*minor - (4-pi)*(minor/4)^2
    { primitive: 'roundrect', ideal: 1 - (4 - Math.PI) / (16 * a), penalty: 0.02 },
  ];
  let best = null;
  for (const c of cands) {
    const err = Math.abs(fill - c.ideal) + c.penalty;
    if (!best || err < best.err) best = { primitive: c.primitive, err };
  }
  return best;
}

// Per-blob shape descriptor. `solidity` is the convexity measure that kills
// texture fragments; `fill` + `aspect` pick the primitive.
function shapeOf(bl, w, l, box, area, ax) {
  const major = ax.major || 0, minor = ax.minor || 0;
  if (!(major > 0) || !(minor > 0)) return null;
  const hull = blobHullArea(bl, w, l, box);
  const solidity = hull > 0 ? Math.min(1, area / hull) : 0;
  const fill = area / (major * minor);
  const aspect = major / minor;
  const fit = fitPrimitive(fill, aspect);
  // Residual = primitive misfit + a convexity penalty. 0.93 is the measured
  // floor for real pills (they run 0.93-0.99); the 2x weight makes a badly
  // non-convex fragment dominate the score even if its fill happens to land
  // near a primitive's ideal by accident.
  const residual = fit.err + Math.max(0, 0.93 - solidity) * 2;
  return { primitive: fit.primitive, residual, solidity, fill, aspect, major, minor, area };
}

// Single-pill LENGTH for a same-medication population. An oblong caplet keeps
// its MAJOR axis when it tips onto its narrow side — only the minor axis (and
// hence the projected AREA) collapses, by roughly 3x. Area-based calibration
// therefore has a documented failure mode on these photos: when enough pills
// lie on edge, the raw area median lands in the on-edge subpopulation and
// estimateUnitArea's refinement passes divide the FLAT pills by 2, dragging
// the unit down until every flat pill reads as two. Length has no such
// bimodality (measured: area spans 2.3x within one photo while the major axis
// stays within 0.90-1.09 of its median), so it is the reliable anchor for
// "is this blob one pill or several".
function estimateUnitLength(majors) {
  if (!majors.length) return 0;
  const sorted = [...majors].sort((a, b) => a - b);
  // Lower-half median: merged multi-pill blobs are long outliers, and singles
  // (flat or on-edge) share the same length, so the short half is pure.
  const half = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  return median(half);
}

// Erosion-split core counter (consensus panel method). Thresholding a blob's
// distance transform at depth t is exactly erosion by a disk of radius t, so
// sweep t across the blob's depth range and count the cores at each level.
// Touching pills separate once t passes the neck depth; the core count that
// persists over the most levels is the geometrically stable answer.
function erosionCores(bl, dd, w, l, box, peak) {
  const lw = box.x1 - box.x0 + 1, lh = box.y1 - box.y0 + 1;
  const loc = new Float32Array(lw * lh);
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w, lrow = (y - box.y0) * lw;
    for (let x = box.x0; x <= box.x1; x++) {
      if (bl[row + x] === l) loc[lrow + x - box.x0] = dd[row + x];
    }
  }
  const seen = new Int32Array(lw * lh);
  const stack = new Int32Array(lw * lh);
  const countAt = (t, gen) => {
    let comps = 0;
    for (let s = 0; s < loc.length; s++) {
      if (loc[s] < t || seen[s] === gen) continue;
      let top = 0, area = 0;
      stack[top++] = s;
      seen[s] = gen;
      while (top) {
        const p = stack[--top];
        area++;
        const px = p % lw;
        const nb = [px > 0 ? p - 1 : -1, px < lw - 1 ? p + 1 : -1, p - lw, p + lw];
        for (const q of nb) {
          if (q < 0 || q >= loc.length || loc[q] < t || seen[q] === gen) continue;
          seen[q] = gen;
          stack[top++] = q;
        }
      }
      if (area >= 4) comps++; // sub-4px cores are noise bumps, not pills
    }
    return comps;
  };
  const lo = Math.max(1.5, 0.3 * peak), hi = 0.85 * peak;
  const steps = 10;
  const tally = new Map();
  for (let s = 0; s <= steps; s++) {
    const c = countAt(lo + (hi - lo) * (s / steps), s + 1);
    if (c >= 1) tally.set(c, (tally.get(c) || 0) + 1);
  }
  let best = 0, bestN = 0;
  // Tie-break toward MORE cores: separation (high t) is the informative regime.
  for (const [c, n] of tally) if (n > bestN || (n === bestN && c > best)) { best = c; bestN = n; }
  return best || 1;
}

// -- BOUNDARY-ARC WITNESS ----------------------------------------------------
//
// The outer boundary of every clump is a chain of arcs of individual pills.
// Pills are identical convex primitives, so three facts hold that no area
// calibration can corrupt:
//   1. The pill END-CAP RADIUS is recoverable from boundary curvature
//      statistics even when NO pill stands alone: each pill contributes ~2*pi
//      of turn at its cap radius (two caps of pi each, or a circle's full
//      revolution) while flanks contribute ~0, so a turn-weighted histogram
//      of radius-of-curvature peaks at the cap radius.
//   2. Junctions between adjacent pills are CONCAVE notches. For a clump with
//      tree topology (no interior holes) the boundary crosses each of the k-1
//      contacts exactly twice, so J notches => k = J/2 + 1 exactly. Cycles,
//      fans and rafts hide contacts from the boundary, so J only ever
//      UNDER-counts them: J/2+1 is a floor, never an invention.
//   3. Distinct end-cap arcs cluster at pill end-centers. A capsule shows 1-2
//      caps depending on what its neighbours occlude, so C cap clusters bound
//      k to [ceil(C/2), C]; a round pill's visible arcs share one center, so
//      C is the count of boundary pills itself.
// Together they give a per-blob interval [arcLo, arcHi] that fails
// INDEPENDENTLY of pixel mass: webbing and foreshortening inflate area but
// not arcs; deep occlusion blurs arcs but not area.
//
// Measured on the gen-touch contact matrix (18 pills/image, flush contact):
// side/end/tee/groups/onedge blobs read exactly 74/81 by the interval floor
// against 11/81 for area-division; fan and hex read LOW (floor semantics) and
// never high. On the 24 annotated real photos: 45/58 multi-unit blobs exact
// vs 43/58 for area, and the failures overlap on only 11 blobs.

// Outer contour of blob `l` inside `box` (Moore-neighbour tracing,
// 8-connected). Returns [[x,y],...] or null for degenerate specks.
function traceOuterContour(bl, w, l, box) {
  let sx = -1, sy = -1;
  outer: for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      if (bl[row + x] === l) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return null;
  const at = (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
    && bl[y * w + x] === l;
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const pts = [];
  let cx = sx, cy = sy, dir = 7;
  const maxSteps = 8 * (box.x1 - box.x0 + box.y1 - box.y0 + 2) + 1000;
  for (let step = 0; step < maxSteps; step++) {
    pts.push([cx, cy]);
    let found = -1;
    const start = (dir + 6) % 8;
    for (let i = 0; i < 8; i++) {
      const d = (start + i) % 8;
      if (at(cx + DX[d], cy + DY[d])) { found = d; break; }
    }
    if (found < 0) break;
    cx += DX[found]; cy += DY[found]; dir = found;
    if (cx === sx && cy === sy && pts.length > 2) break;
  }
  return pts.length >= 8 ? pts : null;
}

const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Resample a closed contour to uniform arc-length step h, box-smooth the
// polyline over +-smoothPx, and return tangent angles + signed curvature
// normalized so CONVEX is positive. Null when the contour is too short.
function arcCurvature(bl, w, l, box, h, smoothPx) {
  const raw = traceOuterContour(bl, w, l, box);
  if (!raw) return null;
  const nR = raw.length;
  const P = [];
  {
    let acc = 0, prev = raw[0];
    P.push(prev);
    for (let i = 1; i <= nR; i++) {
      const p = raw[i % nR];
      let seg = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      while (acc + seg >= h) {
        const t = (h - acc) / seg;
        const q = [prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t];
        P.push(q);
        seg = Math.hypot(p[0] - q[0], p[1] - q[1]);
        prev = q;
        acc = 0;
      }
      acc += seg;
      prev = p;
    }
  }
  const n = P.length;
  if (n < 12) return null;
  const sm = Math.max(1, Math.round(smoothPx / h));
  const S = new Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, c = 0;
    for (let j = -sm; j <= sm; j++) {
      const p = P[(i + j + n) % n];
      ax += p[0]; ay += p[1]; c++;
    }
    S[i] = [ax / c, ay / c];
  }
  const th = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = S[(i - 1 + n) % n], b = S[(i + 1) % n];
    th[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const kap = new Float64Array(n);
  let turnTotal = 0;
  for (let i = 0; i < n; i++) {
    kap[i] = wrapAngle(th[(i + 1) % n] - th[(i - 1 + n) % n]) / (2 * h);
    turnTotal += wrapAngle(th[(i + 1) % n] - th[i]);
  }
  const sgn = turnTotal < 0 ? -1 : 1;
  if (sgn < 0) for (let i = 0; i < n; i++) kap[i] = -kap[i];
  return { S, th, kap, n, sgn };
}

// Image-wide cap-radius recovery (fact 1 above). One turn-weighted histogram
// over every blob boundary; the peak bin, refined by a turn-weighted mean, is
// one pill's end-cap radius. Independent of the area unit by construction.
function recoverCapRadius(bl, w, blobList, blobBox) {
  const RMIN = 2, RMAX = 100, NB = 36;
  const bins = new Float64Array(NB);
  const H = 1.5;
  const samples = []; // [R, weight] pooled across blobs
  for (const l of blobList) {
    const box = blobBox.get(l);
    if (!box) continue;
    const cur = arcCurvature(bl, w, l, box, H, 4);
    if (!cur) continue;
    for (let i = 0; i < cur.n; i++) {
      if (cur.kap[i] <= 0) continue;
      const R = 1 / cur.kap[i];
      if (R < RMIN || R > RMAX) continue;
      const wgt = cur.kap[i] * H; // turn contribution
      samples.push(R, wgt);
      const bi = Math.min(NB - 1, Math.max(0,
        Math.floor(Math.log(R / RMIN) / Math.log(RMAX / RMIN) * NB)));
      bins[bi] += wgt;
    }
  }
  let best = -1, bestV = 0;
  for (let i = 0; i < NB; i++) {
    const v = (bins[Math.max(0, i - 1)] + 2 * bins[i] + bins[Math.min(NB - 1, i + 1)]) / 4;
    if (v > bestV) { bestV = v; best = i; }
  }
  if (best < 0) return { capR: 0, turnMass: 0 };
  const lo = RMIN * Math.pow(RMAX / RMIN, Math.max(0, best - 1) / NB);
  const hi = RMIN * Math.pow(RMAX / RMIN, Math.min(NB, best + 2) / NB);
  let sw = 0, swr = 0;
  for (let i = 0; i < samples.length; i += 2) {
    const R = samples[i], wgt = samples[i + 1];
    if (R < lo || R > hi) continue;
    sw += wgt; swr += wgt * R;
  }
  return { capR: sw > 0 ? swr / sw : (lo + hi) / 2, turnMass: sw };
}

// Per-blob arc statistics against a known cap radius (facts 2 and 3 above).
function boundaryArcStats(bl, w, l, box, capR) {
  if (!(capR > 2.5)) return null;
  const h = Math.min(3, Math.max(1, capR / 5));
  const cur = arcCurvature(bl, w, l, box, h, Math.max(2, capR / 2));
  if (!cur) return null;
  const { S, th, kap, n, sgn } = cur;
  const capKLo = 1 / (2.2 * capR);
  const capKHi = 1 / (0.30 * capR);
  const concK = -1 / (3.0 * capR);
  const cls = new Int8Array(n);
  let capSamples = 0;
  for (let i = 0; i < n; i++) {
    if (kap[i] >= capKLo && kap[i] <= capKHi) { cls[i] = 1; capSamples++; }
    else if (kap[i] <= concK) cls[i] = -1;
  }
  // maximal cyclic runs of one classification
  const runs = [];
  let start = 0;
  while (start < n && cls[start] === cls[(start - 1 + n) % n]) start++;
  if (start === n) {
    let turn = 0;
    for (let i = 0; i < n; i++) turn += kap[i] * h;
    runs.push({ c: cls[0], turn, i0: 0, i1: n - 1 });
  } else {
    let i0 = start;
    for (let i = 1; i <= n; i++) {
      const idx = (start + i) % n;
      if (cls[idx] !== cls[(idx - 1 + n) % n] || i === n) {
        const i1 = (idx - 1 + n) % n;
        let turn = 0;
        for (let j = i0; ; j = (j + 1) % n) { turn += kap[j] * h; if (j === i1) break; }
        runs.push({ c: cls[i0], turn, i0, i1 });
        i0 = idx;
        if (i === n) break;
      }
    }
  }
  // caps: convex cap-curved runs with enough accumulated turn (a full cap
  // turns pi; 0.9 rad keeps occlusion-clipped caps while refusing flank
  // wobble). Each cap's QUALITY is the coherence of its implied centers
  // (point + R * inward normal): a true circular arc of one pill focuses its
  // centers within a small fraction of capR, a texture wiggle that happens
  // to curve scatters them. Cluster the QUALITY cap centers at 1.2*capR: a
  // round pill seen twice re-lands on its own center, adjacent capsule caps
  // stay apart.
  let caps = 0, qcaps = 0;
  const clusters = [];
  for (const r of runs) {
    if (r.c !== 1 || r.turn < 0.9) continue;
    caps++;
    const cx = [], cy = [];
    for (let j = r.i0; ; j = (j + 1) % n) {
      if (kap[j] > 1e-6) {
        const R = Math.min(1 / kap[j], 3 * capR);
        cx.push(S[j][0] - Math.sin(th[j]) * sgn * R);
        cy.push(S[j][1] + Math.cos(th[j]) * sgn * R);
      }
      if (j === r.i1) break;
    }
    const m = cx.length;
    if (!m) continue;
    let px = 0, py = 0;
    for (let j = 0; j < m; j++) { px += cx[j]; py += cy[j]; }
    px /= m; py /= m;
    let spread = 0;
    for (let j = 0; j < m; j++) spread += Math.hypot(cx[j] - px, cy[j] - py);
    spread /= m;
    const quality = spread / capR; // <= ~0.35 for true pill caps
    if (quality > 0.5) continue;   // wiggle, not an arc of a pill
    qcaps++;
    let hit = null;
    for (const cl of clusters) {
      if (Math.hypot(cl.x / cl.n - px, cl.y / cl.n - py) < 1.2 * capR) { hit = cl; break; }
    }
    if (hit) { hit.x += px; hit.y += py; hit.n++; }
    else clusters.push({ x: px, y: py, n: 1 });
  }
  let notches = 0;
  for (const r of runs) {
    if (r.c === -1 && -r.turn >= 0.35) notches++;
  }
  return { caps, qcaps, clusters: clusters.length, notches, capFrac: capSamples / n };
}

// --- SEAM witness: 0-dim persistence of superlevel sets on the blob's own
// LUMA relief (the flattened image, post illumination/line suppression).
//
// Pills are bright plateaus; the contact line between two touching pills is a
// dark seam. Each pill is then a local maximum of the luma relief, and the
// PERSISTENCE of that maximum (birth luma minus the luma of the saddle where
// it merges into an older maximum) is exactly the measured depth of the seam
// separating it from its neighbour. This is the one witness that can see an
// INTERIOR pill of a raft: a pill buried in the middle of a clump never
// reaches the outline (blinding the arc witness) and has no mask neck
// (blinding ws/erosion/crease), but it still keeps its own seams.
//
// Measured in the dense-separation research (docs/dense-separation-research.md):
// this localizer scores 81.3% per-pill recall vs the DT family's 74.8% at
// oracle-k. Its weakness is k-SELECTION: no image-level threshold exists
// (r-f5d11815 vs r-7ff7fd99 need opposite settings), which is why it is
// integrated here as a per-BLOB witness feeding the consensus panel rather
// than as a counter.
//
// Returns the merge-event spectrum sorted by descending persistence, with the
// birth position (= the pill-candidate local maximum) of each event, plus the
// survivor maximum and luma quantiles of the blob's own pixels for
// self-calibration. Costs O(n log n) in blob pixels; only ambiguous blobs pay.
function seamSpectrum(srcData, srcW, srcH, bl, w, l, box) {
  const R = 2; // blur radius, matches the research harness
  const x0 = Math.max(0, box.x0 - R), y0 = Math.max(0, box.y0 - R);
  const x1 = Math.min(srcW - 1, box.x1 + R), y1 = Math.min(srcH - 1, box.y1 + R);
  const bw2 = x1 - x0 + 1, bh2 = y1 - y0 + 1;
  const n = bw2 * bh2;
  const g = new Float32Array(n);
  for (let y = 0; y < bh2; y++) {
    let j = ((y + y0) * srcW + x0) * 4;
    let i = y * bw2;
    for (let x = 0; x < bw2; x++, i++, j += 4) {
      g[i] = 0.299 * srcData[j] + 0.587 * srcData[j + 1] + 0.114 * srcData[j + 2];
    }
  }
  // light separable box blur (pixel noise kills the union-find with fake
  // maxima; radius 2 suppresses it without filling 3-4px-wide seams)
  const t = new Float32Array(n);
  for (let y = 0; y < bh2; y++) {
    for (let x = 0; x < bw2; x++) {
      let s = 0, m = 0;
      for (let k = -R; k <= R; k++) { const xx = x + k; if (xx < 0 || xx >= bw2) continue; s += g[y * bw2 + xx]; m++; }
      t[y * bw2 + x] = s / m;
    }
  }
  for (let x = 0; x < bw2; x++) {
    for (let y = 0; y < bh2; y++) {
      let s = 0, m = 0;
      for (let k = -R; k <= R; k++) { const yy = y + k; if (yy < 0 || yy >= bh2) continue; s += t[yy * bw2 + x]; m++; }
      g[y * bw2 + x] = s / m;
    }
  }
  // blob pixels in local coordinates
  const px = [];
  for (let y = Math.max(y0, box.y0); y <= Math.min(y1, box.y1); y++) {
    for (let x = Math.max(x0, box.x0); x <= Math.min(x1, box.x1); x++) {
      if (bl[y * w + x] === l) px.push((y - y0) * bw2 + (x - x0));
    }
  }
  if (px.length < 16) return null;
  // luma quantiles of the blob's own pixels (self-calibration base)
  const vals = new Float32Array(px.length);
  for (let i = 0; i < px.length; i++) vals[i] = g[px[i]];
  vals.sort();
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
  // 0-dim persistence via union-find over pixels in descending luma order
  const order = Array.from(px).sort((a, b) => g[b] - g[a]);
  const parent = new Map(), birth = new Map(), rep = new Map();
  const added = new Set();
  const find = (p) => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
  const events = [];
  let survivor = -1;
  for (const p of order) {
    const nb = [];
    for (const nq of [p - 1, p + 1, p - bw2, p + bw2]) if (added.has(nq)) nb.push(find(nq));
    const uniq = [...new Set(nb)];
    if (uniq.length === 0) {
      parent.set(p, p); birth.set(p, g[p]); rep.set(p, p);
      if (survivor < 0) survivor = p;
    } else {
      uniq.sort((a, b) => birth.get(b) - birth.get(a));
      const old = uniq[0];
      parent.set(p, old);
      for (let i = 1; i < uniq.length; i++) {
        const yc = uniq[i];
        events.push({ v: birth.get(yc) - g[p], p: rep.get(yc) });
        parent.set(yc, old);
      }
    }
    added.add(p);
  }
  events.sort((a, b) => b.v - a.v);
  const toXY = (p) => ({ x: x0 + (p % bw2), y: y0 + ((p / bw2) | 0) });
  return {
    events: events.map((e) => ({ v: e.v, p: e.p, ...toXY(e.p) })),
    survivor: { p: survivor, ...toXY(survivor) },
    p10: q(0.10), p25: q(0.25), p50: q(0.50), p75: q(0.75), p90: q(0.90),
    n: px.length,
    // the relief itself, for partitioning the blob into candidate cells
    relief: g, rw: bw2, rx0: x0, ry0: y0, px,
  };
}

// Partition a blob into k cells by priority-flooding the luma relief from the
// top-k persistence maxima (basins grow from high ground down, so each basin
// is one candidate pill). Returns per-cell {n, cx, cy, fill, aspect, err}
// using the same oriented-extent convention as the per-region geometry pass
// at the end of countPills — so a cell's `err` is directly comparable to the
// photo's own single-pill residuals.
function seamCells(seam, k) {
  const { relief: g, rw, rx0, ry0, px } = seam;
  const markers = [seam.survivor.p];
  for (let i = 0; i < k - 1 && i < seam.events.length; i++) markers.push(seam.events[i].p);
  if (markers.length < k) return null;
  const lab = new Map();
  const heap = [];
  const push = (p, v) => {
    heap.push([v, p]);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par][0] >= heap[i][0]) break;
      const t = heap[par]; heap[par] = heap[i]; heap[i] = t; i = par;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const lft = 2 * i + 1, rgt = lft + 1;
        let m = i;
        if (lft < heap.length && heap[lft][0] > heap[m][0]) m = lft;
        if (rgt < heap.length && heap[rgt][0] > heap[m][0]) m = rgt;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  const inSet = new Set(px);
  markers.forEach((p, i) => { if (!lab.has(p)) lab.set(p, i); push(p, g[p]); });
  if (lab.size < k) return null; // duplicate maxima — partition impossible
  while (heap.length) {
    const [, p] = pop();
    const id = lab.get(p);
    for (const nq of [p - 1, p + 1, p - rw, p + rw]) {
      if (!inSet.has(nq) || lab.has(nq)) continue;
      lab.set(nq, id);
      push(nq, g[nq]);
    }
  }
  // per-cell moments -> orientation -> oriented extents -> fill/aspect/fit
  const acc = markers.map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }));
  for (const [p, id] of lab) {
    const x = p % rw, y = (p / rw) | 0;
    const a = acc[id];
    a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
  }
  for (const a of acc) {
    if (a.n < 20) continue;
    const mx = a.sx / a.n, my = a.sy / a.n;
    const cxx = a.sxx / a.n - mx * mx, cxy = a.sxy / a.n - mx * my, cyy = a.syy / a.n - my * my;
    a.th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    a.mx = mx; a.my = my;
    a.pLo = Infinity; a.pHi = -Infinity; a.qLo = Infinity; a.qHi = -Infinity;
  }
  for (const [p, id] of lab) {
    const a = acc[id];
    if (a.n < 20 || a.th === undefined) continue;
    const x = (p % rw) - a.mx, y = ((p / rw) | 0) - a.my;
    const c = Math.cos(a.th), sn = Math.sin(a.th);
    const pp = x * c + y * sn, qq = -x * sn + y * c;
    if (pp < a.pLo) a.pLo = pp; if (pp > a.pHi) a.pHi = pp;
    if (qq < a.qLo) a.qLo = qq; if (qq > a.qHi) a.qHi = qq;
  }
  return acc.map((a) => {
    if (a.n < 20 || a.th === undefined) return { n: a.n, err: Infinity, fill: 0, aspect: 0, cx: 0, cy: 0, theta: 0, major: 0, minor: 0 };
    const e1 = a.pHi - a.pLo + 1, e2 = a.qHi - a.qLo + 1;
    const major = Math.max(e1, e2), minor = Math.max(1, Math.min(e1, e2));
    const aspect = major / minor;
    const fill = a.n / (major * minor);
    // theta is the direction of the MAJOR axis in image coordinates
    const theta = e1 >= e2 ? a.th : a.th + Math.PI / 2;
    return { n: a.n, cx: rx0 + a.mx, cy: ry0 + a.my, fill, aspect,
      err: fitPrimitive(fill, aspect).err, theta, major, minor };
  });
}

// Photometric validation of one pill hypothesis (owner's render-and-verify
// idea, counter side): sample the interior of the hypothesized outline at
// ~0.7x scale on the distance-from-background map and return the mean. A
// placement over pill material reads far above the photo's own Otsu cut; a
// placement over bare surface reads below it. Constant-free: the bar is the
// photo's own segmentation threshold.
function pillPhotoScore(distData, w, h, pill) {
  const c = Math.cos(pill.theta), s = Math.sin(pill.theta);
  const a = 0.35 * pill.major, b = 0.35 * pill.minor; // 0.7x of half-extents
  let sum = 0, n = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) {
      // grid over the inscribed ellipse
      const u = ((i + 0.5) / 6 * 2 - 1), v = ((j + 0.5) / 4 * 2 - 1);
      if (u * u + v * v > 1) continue;
      const x = Math.round(pill.cx + u * a * c - v * b * s);
      const y = Math.round(pill.cy + u * a * s + v * b * c);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      sum += distData[y * w + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Patch-based interior statistics (owner's refinement of render-and-verify):
// speckled pills on speckled boards make single-pixel reads noisy, so sample
// 3x3 PATCH MEANS instead; and a mean alone can hide a background corner
// inside the outline, so also report bgFrac — the fraction of interior
// patches that read BELOW the photo's own Otsu cut, i.e. patches of actual
// background color inside the claimed pill. A correct outline has bgFrac ~0
// regardless of speckle; a wrong-angle or oversized outline pokes into the
// board and bgFrac says so immediately.
function pillPhotoStats(distData, w, h, pill, otsuCut) {
  const c = Math.cos(pill.theta), s = Math.sin(pill.theta);
  const a = 0.38 * pill.major, b = 0.38 * pill.minor;
  let sum = 0, n = 0, bg = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) {
      const u = (i / 5) * 2 - 1, v = (j / 3) * 2 - 1;
      const px = Math.round(pill.cx + u * a * c - v * b * s);
      const py = Math.round(pill.cy + u * a * s + v * b * c);
      if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) { bg++; n++; continue; }
      let pm = 0;                                   // 3x3 patch mean
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        pm += distData[(py + dy) * w + (px + dx)];
      pm /= 9;
      sum += pm; n++;
      if (pm < otsuCut) bg++;
    }
  }
  return { mean: n ? sum / n : 0, bgFrac: n ? bg / n : 1 };
}

/**
 * Count pills in an image.
 * @param {object} cv - OpenCV module
 * @param {HTMLCanvasElement|ImageData|{data,width,height}} source - RGBA image to analyze
 * @param {object} opts - { maxDim, overlay, returnImage, variant: 'baseline'|'sized' }
 * @returns {{count:number, regions:Array<{cx,cy,area,units}>, scale:number, boundaries?:Uint8Array, width:number, height:number, image?:Uint8ClampedArray}}
 */
export function countPills(cv, source, opts = {}) {
  const maxDim = opts.maxDim || 1280;
  const withOverlay = opts.overlay !== false;

  // Kept for the stamp router's interior photometry (it samples the ORIGINAL
  // photo, not the working-scale flattened copy). For ImageData-like sources
  // this is the same object — no copy, no cost.
  const srcImageFull = toImageData(source);
  const src = cv.matFromImageData(srcImageFull);
  const mats = [src];
  const track = (m) => { mats.push(m); return m; };

  try {
    const scale = Math.min(1, maxDim / Math.max(src.rows, src.cols));
    if (scale < 1) {
      cv.resize(src, src, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    }

    // Optional stage-snapshot callback (drives the live demos in about.html).
    const emit = typeof opts.stages === 'function' ? opts.stages : null;
    if (emit) emit('input', { data: new Uint8ClampedArray(src.data), width: src.cols, height: src.rows });

    // Working-scale snapshot BEFORE illumination flattening. The high-contrast
    // rescue must reason about the photo's true luma/chroma separation, and
    // flattening deliberately destroys exactly that: on the cream-caplet photo
    // it lifts the shaded wood and compresses the caplets until the border
    // background reads BRIGHTER than the Otsu cut, which inverts the rescue's
    // foreground (measured: bg [157,99,52] thr 97 flattened, versus the true
    // bg [128,80,43] thr 132). Cheap — one working-scale copy, and only the
    // rescue reads it.
    const srcPreFlat = track(src.clone());

    // Level out vignettes and lighting gradients before any color reasoning.
    flattenIllumination(cv, src);

    // Erase thin dark surface markings (ruled paper, grout lines, printed
    // grid) before anything reasons about color. These threshold as pills and
    // physically bridge them into one blob — a merge no downstream splitter
    // can undo. Self-gated: no-ops on dark backgrounds and on clean surfaces.
    suppressThinDarkLines(cv, src, opts.debug);
    if (emit) emit('pre-dist', { data: new Uint8ClampedArray(src.data), width: src.cols, height: src.rows });

    // Segment by color distance from the background (est. from the border) —
    // works for colored pills that grayscale Otsu lumps into the background.
    const dfb = distanceFromBackground(cv, src);
    const distBg = track(dfb.mat);
    const distBgRaw = track(dfb.raw);
    cv.GaussianBlur(distBgRaw, distBgRaw, new cv.Size(5, 5), 0);
    if (emit) emit('bgcolor', dfb.color);
    cv.GaussianBlur(distBg, distBg, new cv.Size(5, 5), 0);

    // CHROMATIC RESCUE. The shadow-damping in colorDist protects against
    // counting cast shadows, but it cannot tell a modestly-coloured DARK pill
    // from a shadow of the board, and it deletes the pill when it guesses
    // wrong. Measured on the glossy-bead photos: every bead interior landed
    // 18-46 on this map against an Otsu cut of 49, so the mask came out as
    // gnawed fragments and isolated "singles" scattered over a 2.7x area
    // range — the owner's read, "we erode too much of the pill", exactly.
    //
    // Fixing it globally is not safe: undamping also lifts board shading into
    // the foreground, which raises the threshold and fuses clumps (measured:
    // r-7ff7fd99 19 -> 12, r-295482c1 19 -> 22). So it is a RESCUE, tried only
    // when this photo's own blob population says the default map failed, and
    // adopted only when the retry is clearly more coherent.
    //
    // The score is population coherence, not histogram shape: identical
    // medication means blobs repeat at one size. On the caplet corpus the
    // default map scores 0.78-0.94 and this never fires; on the bead photos
    // it scores below the floor and the hue-aware retry wins outright.
    {
      const minA = Math.max(30, (src.cols * src.rows) / 6000);
      const s0 = cueScore(cv, distBg, minA);
      if (s0.score < 0.62) {
        const alt = distanceFromBackground(cv, src, true);
        cv.GaussianBlur(alt.mat, alt.mat, new cv.Size(5, 5), 0);
        const s1 = cueScore(cv, alt.mat, minA);
        // Both scores can be -1 (no coherent population either way, e.g. a
        // graph-paper grid that floods the mask). A rescue is only meaningful
        // when the retry itself is coherent; -1 > -1*1.08 would otherwise
        // "win" on two invalid measurements.
        const win = s1.score > 0 && s1.score > s0.score * 1.08;
        opts.debug?.({ stage: 'cue', base: +s0.score.toFixed(3), hue: +s1.score.toFixed(3),
          baseFrac: +(s0.frac || 0).toFixed(3), hueFrac: +(s1.frac || 0).toFixed(3),
          chose: win ? 'hue-aware' : 'default' });
        if (win) alt.mat.copyTo(distBg);
        alt.mat.delete(); alt.raw.delete();
      }
    }

    const bw = track(new cv.Mat());
    let otsuThr = cv.threshold(distBg, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    // Live mode passes the previous frame's threshold: blending it in stops
    // auto-exposure flicker from yanking the global cut frame to frame.
    if (opts.thrHint > 0) {
      otsuThr = 0.65 * opts.thrHint + 0.35 * otsuThr;
      cv.threshold(distBg, bw, otsuThr, 255, cv.THRESH_BINARY);
    }

    // If pills fill the frame, the border isn't background — fall back to gray Otsu.
    let usedColorDist = true;
    if (cv.countNonZero(bw) / (bw.rows * bw.cols) > 0.9) {
      usedColorDist = false;
      const gray = track(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      if (borderWhiteFraction(cv, bw) > 0.5) cv.bitwise_not(bw, bw); // make pills white
    }

    // Absolute pill-size floor, relative to image size (used in several stages).
    const absFloor = Math.pow(Math.min(src.cols, src.rows) * 0.012, 2);

    if (emit) emit('mask-otsu', grayToStage(bw));
    // Snapshot the pre-purge otsu mask for the stamp router's retry (a) and
    // the cleaned-vs-otsu coverage signature. One memcpy; the mask evolves
    // in place after this point.
    const stampOtsu = opts.variant === 'consensus' && opts.stamp !== false
      ? new Uint8Array(bw.data) : null;

    // Plates/trays segment as one huge blob; re-segment those against their
    // own surface color (twice, for nested surfaces like table -> plate).
    // The refine's MAJORITY-PILL failure mode (it re-thresholds a pill pile
    // against the pill colour and keeps the board web instead) is recorded
    // here for the high-contrast rescue's trigger — see highContrastMask.
    const refineSig = [];
    const refDbg = (e) => {
      if (e && e.stage === 'refine') refineSig.push(e);
      opts.debug?.(e);
    };
    if (refineOversizedBlobs(cv, src, bw, absFloor, refDbg)) refineOversizedBlobs(cv, src, bw, absFloor, refDbg);
    // Inverted signature: the refine ACCEPTED, kept a large share of the blob,
    // yet almost none of what it kept is pill-shaped. That is the fingerprint
    // of having thresholded pills-as-background (cream: kept 0.45 of a 430k
    // blob, only 0.10 of it pill-like). Healthy refines on real trays read the
    // other way round (beige 0.11/0.90, salmon 0.17/0.45).
    const refineInverted = refineSig.some(
      (e) => e.accept && e.keptRatio > 0.3 && e.pillRatio < 0.35);

    // Faint pills hidden below a bimodal Otsu split (white pills next to
    // colored ones on a light tray) get a second chance.
    if (usedColorDist) {
      const bgLum = (dfb.color[0] + dfb.color[1] + dfb.color[2]) / 3;
      rescueSecondMode(cv, distBg, bw, absFloor, src, bgLum, opts.debug);
    }

    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    const anchor = new cv.Point(-1, -1);
    cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel, anchor, 2);
    // Closing seals interior speckle, but 2 iterations dilate by ~2px on
    // every side, which BRIDGES pills that merely lie near each other. That
    // bridge is unrecoverable downstream: two pills become one blob with no
    // neck for the watershed to cut, and the pair is counted as one. Measured
    // on a real photo: 16 separate blobs before closing, 14 after — two
    // genuine pills lost at this line, upstream of every size/shape rule.
    // Keep the speckle-sealing benefit but forbid the side effect: close as
    // before, then undo the fill anywhere it would weld two distinct
    // components together. Blobs that were already separate stay separate.
    {
      const preClose = track(bw.clone());
      cv.morphologyEx(bw, bw, cv.MORPH_CLOSE, kernel, anchor, 2);
      const labPre = track(new cv.Mat());
      const nPre = cv.connectedComponents(preClose, labPre);
      const labPost = track(new cv.Mat());
      const nPost = cv.connectedComponents(bw, labPost);
      if (nPost < nPre) {
        // Some component absorbed another. For each post-close component,
        // find which pre-close labels it contains; if more than one, the
        // pixels closing ADDED inside it are a bridge — remove just those.
        const lp = labPre.data32S, lq = labPost.data32S, bd = bw.data, pd = preClose.data;
        const seen = new Map(); // post label -> Set(pre labels)
        for (let i = 0; i < lq.length; i++) {
          if (!lq[i] || !lp[i]) continue;
          let s = seen.get(lq[i]);
          if (!s) { s = new Set(); seen.set(lq[i], s); }
          s.add(lp[i]);
        }
        const merged = new Set();
        for (const [post, pres] of seen) if (pres.size > 1) merged.add(post);
        if (merged.size) {
          for (let i = 0; i < lq.length; i++) {
            if (bd[i] && !pd[i] && merged.has(lq[i])) bd[i] = 0; // added bridge pixel
          }
        }
      }
      opts.debug?.({ stage: 'closeguard', nPre, nPost });
    }
    const preFill = track(bw.clone()); // pre-fill state: crevices between touching pills still open
    fillHoles(cv, bw, opts.debug); // highlights/engravings punch holes in solid pills

    // Dominant-cluster texture purge. On textured surfaces (paper towel,
    // wood grain) the pills form one dominant high-contrast cluster while
    // the texture segments into satellite blobs. Same-medication prior: a
    // real stray pill is the same COLOR as the cluster, so satellites whose
    // body color doesn't match are texture, shadow folds, or surface streaks.
    // Scatter scenes (no dominant blob) are left untouched.
    if (usedColorDist) {
      const labP = track(new cv.Mat());
      cv.connectedComponents(bw, labP);
      const lp = labP.data32S;
      const dtP = track(new cv.Mat());
      cv.distanceTransform(bw, dtP, cv.DIST_L2, 3);
      const dp = dtP.data32F;
      const dbv = distBg.data, sdp = src.data;
      const st = new Map();
      const W = src.cols, H = src.rows;
      for (let i = 0; i < lp.length; i++) {
        if (!lp[i]) continue;
        let s = st.get(lp[i]);
        if (!s) { s = { a: 0, mx: 0, pk: 0, r: 0, g: 0, b: 0, edge: 0 }; st.set(lp[i], s); }
        s.a++;
        if (dbv[i] > s.mx) s.mx = dbv[i];
        if (dp[i] > s.pk) s.pk = dp[i];
        const x = i % W, y = (i / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) s.edge++;
        const q = i * 4;
        s.r += sdp[q]; s.g += sdp[q + 1]; s.b += sdp[q + 2];
      }
      // Border-strip removal: an unrecognized second background (wood table
      // behind the paper towel) segments as a wide flat band hugging the
      // image border — long border contact, area far beyond what its
      // thickness explains. Pill piles are compact; pills touching the
      // border have tiny contact runs.
      {
        const mdp = bw.data;
        for (const [l, s] of st) {
          if (s.edge >= 0.2 * Math.max(W, H) && s.a > 4 * Math.PI * s.pk * s.pk) {
            for (let i = 0; i < lp.length; i++) if (lp[i] === l) mdp[i] = 0;
            opts.debug?.({ stage: 'strip', a: s.a, pk: s.pk, edge: s.edge });
            st.delete(l);
          }
        }
      }
      let fg = 0, big = null;
      for (const s of st.values()) { fg += s.a; if (!big || s.a > big.a) big = s; }
      // Decisive dominance only. At a bare 0.45 majority this branch is
      // BISTABLE: a few percent of exposure change flips it on and off
      // between frames, which is what made live counts swing 11<->56 on
      // textured backgrounds. Require the cluster to clearly own the frame.
      if (big && big.a >= 0.7 * fg && big.mx >= 40) {
        // Chromaticity (shading-invariant): a real pill in shade keeps the
        // cluster's color RATIOS; wood streaks and towel folds don't. Pills
        // washed by a scene-wide color cast CAN drift, so pill-THICK blobs
        // (a real fraction of the cluster's own distance peak) are protected;
        // texture is invariably thin next to the pill mass.
        const chrom = (s) => {
          const sum = Math.max(1, s.r + s.g + s.b);
          return [s.r / sum, s.g / sum, s.b / sum];
        };
        const bc = chrom(big);
        const drop = new Set();
        for (const [l, s] of st) {
          if (s === big) continue;
          if (s.pk >= 0.25 * big.pk) continue;
          const c = chrom(s);
          const dC = 255 * (Math.abs(c[0] - bc[0]) + Math.abs(c[1] - bc[1]) + Math.abs(c[2] - bc[2]));
          if (dC > 35) drop.add(l);
        }
        if (drop.size) {
          const mdp = bw.data;
          for (let i = 0; i < lp.length; i++) if (drop.has(lp[i])) mdp[i] = 0;
        }
        opts.debug?.({ stage: 'purge', fg, bigA: big.a, bigMx: big.mx, bigPk: big.pk, dropped: drop.size });
      }
    }
    if (emit) emit('mask-final', grayToStage(bw));

    // Sure background: dilated mask. Sure foreground: distance-transform peaks.
    const sureBg = track(new cv.Mat());
    cv.dilate(bw, sureBg, kernel, anchor, 3);

    const dist = track(new cv.Mat());
    cv.distanceTransform(bw, dist, cv.DIST_L2, 5);
    const mm = cv.minMaxLoc(dist);
    if (mm.maxVal < 3) return { count: 0, regions: [], scale, width: src.cols, height: src.rows };

    // Per-blob thickness (distance-transform peak) and area.
    const blobs = track(new cv.Mat());
    cv.connectedComponents(bw, blobs);
    const bl = blobs.data32S;
    const dd = dist.data32F;
    let peaks = new Float32Array(64);
    let blobAreas = new Uint32Array(64);
    // Per-blob boundary-arc reading, recorded by the panel for the stamp
    // router's hidden-contact test (clusters <= 2*units - 2 on an elongated
    // template = at least one flush contact hides a cap pair).
    const arcInfoByBlob = new Map();
    for (let i = 0; i < bl.length; i++) {
      const l = bl[i];
      if (!l) continue;
      if (l >= peaks.length) {
        const np = new Float32Array(Math.max(l + 1, peaks.length * 2));
        np.set(peaks); peaks = np;
        const na = new Uint32Array(peaks.length);
        na.set(blobAreas); blobAreas = na;
      }
      if (dd[i] > peaks[l]) peaks[l] = dd[i];
      blobAreas[l]++;
    }
    if (emit) {
      const dn = new cv.Mat(src.rows, src.cols, cv.CV_8UC1);
      const dnd = dn.data;
      // Normalize to PILL scale (2x half-width), not the global max: one
      // fused mega-blob's deep interior made every individual pill render
      // near-black (field report: "it became really faint").
      // Self-contained pill-scale estimate (everything else here is TDZ):
      // the 95th percentile of nonzero DT values. Pills dominate the
      // foreground area, so p95 sits at pill half-width even when one fused
      // mega-blob's core runs far deeper.
      let dtScale = 4;
      {
        const nz = [];
        for (let i = 0; i < dd.length; i += 7) if (dd[i] > 0) nz.push(dd[i]);
        if (nz.length > 50) { nz.sort((a2, b2) => a2 - b2); dtScale = Math.max(4, nz[(nz.length * 0.95) | 0] * 1.3); }
        else dtScale = Math.max(4, mm.maxVal);
      }
      for (let i = 0; i < dd.length; i++) dnd[i] = Math.min(255, (dd[i] / dtScale) * 255) | 0;
      emit('disttransform', grayToStage(dn));
      dn.delete();
    }

    // Blobs thinner than ~8px across are texture/noise, not pills — no marker.
    const MIN_PEAK = 4;

    // Typical pill radius = median thickness of pill-sized blobs.
    const candPeaks = [];
    for (let l = 1; l < peaks.length; l++) {
      if (blobAreas[l] >= absFloor && peaks[l] >= MIN_PEAK) candPeaks.push(peaks[l]);
    }
    let radiusEst = median(candPeaks) || mm.maxVal;

    // AUTOCORRELATION SCALE CHECK. radiusEst above is the median DT thickness,
    // so it is only ever as good as the mask. On a LOW-CONTRAST board a pale
    // pill barely clears the threshold and the ridge comes out at HALF scale —
    // measured on the adversarial suite, R=6.7 against a true 13 on a light
    // background versus 10.5 for identical pills on a dark one. Everything
    // downstream then hunts at the wrong size: on those images the distance
    // transform found 45% of the pills and every detector over-proposed 3-5x.
    //
    // Pills in contact REPEAT at one spacing, and the first peak of the
    // photo's luminance autocorrelation is exactly that pitch (= 2R). It never
    // consults a threshold, so it survives the bad mask that broke the ridge.
    // Only ever used to RAISE the estimate, and only when it disagrees by more
    // than 25%: a too-small radius invents pills, a too-large one merges them,
    // and the ridge is right whenever the mask is healthy.
    //
    // Measured integrating this alone (tools/raft-bakeoff.mjs): dt recall
    // 45.5% -> 81.3%, and every adversarial case whose R comes out correct is
    // EXACT — including a 37-pill hex raft and a 120-pill dense board that
    // previously returned count=1.
    let shatteredMask = false;
    if (opts.acScale !== false) {
      // SHATTERED MASK TEST. Board texture segments into hundreds of sub-pill
      // specks; pills do not. Measured on the adversarial noise raft: 207
      // components for 19 pills, 183 of them under a fifth of a pill's area,
      // and the DT ridge reads their grain (4.2) rather than the pills (13).
      // Only such a mask justifies overriding the ridge with a correlation
      // pitch -- see the fallthrough in the estimator below.
      shatteredMask = (() => {
        const lab = new cv.Mat(), st = new cv.Mat(), ct = new cv.Mat();
        const n = cv.connectedComponentsWithStats(bw, lab, st, ct);
        // Judge by COMPONENT COUNT and the area distribution, never against
        // radiusEst: sizing "tiny" as a fraction of pi*radiusEst^2 is circular
        // -- the whole point is that radiusEst is measuring grain. Measured on
        // the noise raft that circularity produced components 1068, tiny 4,
        // because an 11px threshold derived from a 4.2px ridge is smaller than
        // the specks themselves.
        //
        // A photo of pills has tens of components at most. A thousand-plus
        // means the board is being segmented, and the giveaway is that the
        // median component is a tiny fraction of the LARGEST one (the real
        // pill material), which needs no scale estimate at all.
        const areas = [];
        for (let i = 1; i < n; i++) {
          const a = st.intAt(i, cv.CC_STAT_AREA);
          if (a >= 4) areas.push(a);
        }
        lab.delete(); st.delete(); ct.delete();
        areas.sort((a, b) => a - b);
        const tot = areas.length;
        const med = tot ? areas[tot >> 1] : 0;
        const big = tot ? areas[tot - 1] : 0;
        // Two arms, because the median-to-largest ratio assumes a big fused
        // blob exists to compare against. On a DENSE board of small pills
        // nothing stands out: measured on adv-dense-noise, 1627 components
        // with a median of 24px against a largest of only 789px -- ratio
        // 0.030, just outside the 0.02 bar -- so the mask was NOT flagged and
        // the image counted 385 for 200 with zero pills found. The noise chain
        // by contrast has a 5668px raft and passes at 0.0037.
        //
        // Sheer count is the arm that survives that: a photo of pills does not
        // produce a thousand components. Both arms are scale-free.
        const bad = (tot >= 150 && big > 0 && med < 0.02 * big) || tot >= 800;
        if (bad) opts.debug?.({ stage: 'mask-shattered', components: tot,
          medianArea: med, largest: big });
        return bad;
      })();
      const acR = (() => {
        const bwd0 = bw.data;
        const w = src.cols, h = src.rows;      // `w`/`h` are declared later
        let x0 = w, y0 = h, x1 = 0, y1 = 0, fg = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (!bwd0[y * w + x]) continue;
          fg++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (fg < 400 || x1 - x0 < 16 || y1 - y0 < 16) return 0;
        const sd = src.data;
        const lum = (x, y) => { const o = (y * w + x) * 4;
          return 0.299 * sd[o] + 0.587 * sd[o + 1] + 0.114 * sd[o + 2]; };
        let mean = 0, n = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { mean += lum(x, y); n++; }
        mean /= Math.max(1, n);
        const maxLag = Math.min(60, Math.floor((x1 - x0) / 2));
        const curve = [];
        // Start at lag 4, as the original did. Lags 2-3 are dominated by pure
        // pixel-to-pixel self-similarity on EVERY photo, so including them
        // makes the global maximum always land there -- measured, that alone
        // took the fused hex rafts from 19 back to count=1 because the pitch
        // came out 1 and fell under the acR > 3 floor.
        for (let lag = 4; lag <= maxLag; lag++) {
          let acc = 0, cnt = 0;
          for (let y = y0; y <= y1; y += 2) for (let x = x0; x + lag <= x1; x++) {
            acc += (lum(x, y) - mean) * (lum(x + lag, y) - mean); cnt++;
          }
          curve.push(cnt ? acc / cnt : 0);            // index i == lag (i + 4)
        }
        if (curve.length < 6) return 0;
        // THE PITCH IS A LOCAL PEAK, NOT THE GLOBAL MAXIMUM. On a textured
        // board the correlation is dominated by the GRAIN, whose period is a
        // couple of pixels: measured on the adversarial noise raft, the global
        // maximum gave acR 2 against a true pill radius of 13, which fell
        // under the acR > 3 floor and was silently discarded -- so the one
        // witness that could have caught radiusEst 4.2 never spoke, and the
        // image emitted 274 spurious pills.
        //
        // Skip the monotone decay off lag 0, then take the FIRST interior
        // peak; fall back to the global maximum when no peak exists, so every
        // image that reads correctly today keeps its answer.
        let gPeak = -1, gv = -Infinity;
        for (let i = 0; i < curve.length; i++) if (curve[i] > gv) { gv = curve[i]; gPeak = i; }
        const gLag = gPeak + 4;
        // The global maximum is the right answer on a clean board and is what
        // every currently-passing image relies on. It only fails when board
        // TEXTURE dominates the correlation, which shows up as a pitch of a
        // few pixels -- far too small to be a pill. Measured on the
        // adversarial noise raft: global max gave lag 4 (acR 2) against a true
        // radius of 13, which fell under the acR > 3 floor and was discarded,
        // so nothing corrected radiusEst 4.2 and the image emitted 274
        // spurious pills.
        //
        // Only in that degenerate case fall through to the first interior
        // peak. Applying first-peak everywhere measured WORSE: it over-reads
        // on clean photos (r-dbe1f2d8 8.4 -> 24, r-cc7a2ada 10.3 -> 22, both
        // locking onto a pair-spacing rather than the pill) and cost two exact
        // images, 238 -> 236.
        // A GLOBAL MAX AT THE VERY FIRST LAG CARRIES NO PITCH INFORMATION.
        // The search starts at lag 4, so gLag === 4 means the correlation was
        // still descending from its lag-0 spike -- board texture, not pills.
        // That is a failure of the estimator whatever the mask looks like, and
        // it is exactly what the first-interior-peak fallback is for.
        //
        // Measured on the dark and wood hex rafts: acR came out 2, failed the
        // acR > 3 floor, was discarded, and radiusEst stayed at the fused
        // blob's own peak (51.8 against a true 13) -- so massR read 1 and the
        // whole raft collapsed to count=1. The light raft of the same geometry
        // reads acR 13 and counts 19.
        //
        // Still not a blanket change: a blanket first-peak measured WORSE
        // (238 -> 236), because on a clean photo it locks onto a PAIR spacing.
        // It applies only when the global answer is degenerate or the mask is
        // shattered -- in both cases there is no valid answer to displace.
        if (!shatteredMask && gLag > 4) return gLag / 2;
        // Reaching here means either the mask is shattered or the global
        // maximum sat at the very first lag -- in both cases the global
        // answer carries no pitch information, so scan for the first
        // interior peak instead. Skip the monotone descent off lag 0 first:
        // measured on the dark hex raft the curve falls from 2600 at lag 4
        // to a minimum of 201 at lag 20, then peaks at 998 at lag 26 --
        // exactly the true pitch (2 x R13). Starting the scan before the
        // descent ends finds nothing.
        let i0 = 0;
        while (i0 + 1 < curve.length && curve[i0 + 1] <= curve[i0]) i0++;
        for (let i = Math.max(1, i0); i + 1 < curve.length; i++) {
          if (curve[i] > curve[i - 1] && curve[i] >= curve[i + 1]) {
            const rPeak = (i + 4) / 2;
            // THE RESCUE IS FOR AN OVER-READING RIDGE, NOT AN UNDER-READING ONE.
            // A fused raft inflates the DT ridge far above one pill, and the
            // correlation peak is then much SMALLER than the ridge -- the dark
            // hex raft reads peak 13 against ridge 51.8 (0.25x), and adopting
            // it takes the image from count=1 to 19 EXACT.
            //
            // When the peak sits well ABOVE the ridge it is a PAIR spacing,
            // not a pill: r-dbe1f2d8 reads peak 24 against ridge 8.4 (2.9x)
            // and r-cc7a2ada peak 22 against ridge 10.3 (2.1x). Adopting those
            // cost both images (238 -> 236). A shattered mask is the one case
            // where the ridge itself is untrustworthy, so it is exempt.
            if (!shatteredMask && radiusEst > 0 && rPeak > 1.6 * radiusEst) break;
            return rPeak;
          }
        }
        return gLag / 2;
      })();
      // Correct in BOTH directions. The ridge under-reads on a low-contrast
      // board (pale pill, thin mask) and grossly OVER-reads on a fully fused
      // raft, where the DT peak belongs to the whole lump rather than to one
      // pill: measured radiusEst 53.2 on a 19-pill hex raft whose true radius
      // is 13, so the counter saw ONE pill 106px across and returned count=1.
      // The autocorrelation pitch describes the repeating unit either way.
      if (acR > 3 && acR < 60
          && (acR > radiusEst * 1.25 || acR < radiusEst * 0.8)) {
        opts.debug?.({ stage: 'acscale', from: +radiusEst.toFixed(1), to: +acR.toFixed(1),
          ratio: +(acR / radiusEst).toFixed(2) });
        radiusEst = acR;
      }

      // GRAIN PURGE. absFloor is a fraction of the IMAGE (0.012 * min side)^2,
      // computed long before any pill size is known -- 81px on a 1000x750
      // photo. That is far below a real pill and lets board texture through:
      // measured on the adversarial noise raft, 207 components survive to the
      // geometry stage, 117 of them under a quarter of a pill's area, while
      // exactly ONE is pill-sized. Those specks become 274 spurious pills.
      //
      // Once the correlation pitch has corrected radiusEst, a pill-relative
      // floor is finally available. Scoped to the shattered case so a healthy
      // mask -- where small components are engraving fragments worth keeping
      // -- is untouched.
      if (shatteredMask && radiusEst > 3) {
        const floor2 = 0.25 * Math.PI * radiusEst * radiusEst;
        const lab2 = new cv.Mat(), st2 = new cv.Mat(), ct2 = new cv.Mat();
        const n2 = cv.connectedComponentsWithStats(bw, lab2, st2, ct2);
        const drop = new Uint8Array(n2 + 1);
        let dropped = 0;
        for (let i = 1; i < n2; i++) {
          if (st2.intAt(i, cv.CC_STAT_AREA) < floor2) { drop[i] = 1; dropped++; }
        }
        if (dropped) {
          const ld = lab2.data32S, bd = bw.data;
          for (let i = 0; i < ld.length; i++) if (drop[ld[i]]) bd[i] = 0;
          opts.debug?.({ stage: 'grain-purge', dropped, kept: n2 - 1 - dropped,
            floor: +floor2.toFixed(0), radiusEst: +radiusEst.toFixed(1) });
        }
        lab2.delete(); st2.delete(); ct2.delete();
      }
    }

    // Local maxima of the distance transform (used for deep piles, where each
    // pill center is a peak even though the blob is one giant lump).
    const kk = Math.min(40, Math.max(2, Math.round(radiusEst * 0.8)));
    const distDil = track(new cv.Mat());
    const maxKernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * kk + 1, 2 * kk + 1)));
    cv.dilate(dist, distDil, maxKernel);
    const dm = distDil.data32F;

    // Markers: pill-scale blobs use a fraction of their own peak (robust for
    // capsules/tablets, splits touching pairs); thicker-than-pill blobs (piles)
    // use strict distance-transform local maxima.
    const sureFg = track(new cv.Mat(src.rows, src.cols, cv.CV_8UC1));
    const sf = sureFg.data;
    const pileFloor = Math.max(MIN_PEAK, 0.45 * radiusEst);

    // PILE vs SHEET. The pile branch below seeds from STRICT distance-transform
    // local maxima, on the premise that in a deep heap each pill centre rises to
    // its own peak. That premise fails for a SHEET: many same-size pills fused
    // side-by-side in ONE layer. There the medial axis is a smooth branching
    // plateau with no per-pill bumps, so the strict-max test finds almost
    // nothing and the whole clump gets a handful of seed pixels -- the watershed
    // is then given nothing to split with and the pills are never individually
    // detected. Measured on lined-503b3041's 14-pill cluster: 81428 px, 47129 of
    // them above pileFloor, but only 16 px passing `dd >= dm` -- SIXTEEN seed
    // pixels for fourteen pills, against 1300-1700 px for each isolated pill.
    //
    // `peaks[l]` cannot separate the two cases: it is a MAX, so one fused
    // junction inflates a flat sheet's peak just as high as a real heap's (here
    // 60.3 vs a true pill half-width of 28.7). Neither can the DT distribution:
    // measured, a genuine sheet and a blob that the strict-max branch handles
    // correctly both sit at p90/radiusEst ~= 1.2, so any cut there is tuning.
    //
    // The condition that actually matters is not what the blob IS but whether
    // the strict-max branch produced enough SEED REGIONS to split the blob.
    // Seed pixel COUNT is the wrong yardstick -- strict maxima are points, so
    // even correct seeding covers a negligible fraction of area (measured on
    // t2-salmon-pentagon-tablets-teal, a real stacked pile: 1 seed pixel for a
    // 3497 px blob, working as intended). What matters is how many SEPARATE
    // seeds there are versus how many pills the blob can hold: the watershed
    // can never yield more regions than it has seeds, so a blob with room for
    // a dozen pills and one connected seed is guaranteed to under-count no
    // matter what happens downstream.
    //
    // Capacity is area/pillArea. Require the seeds to be able to account for
    // at least a third of it -- generous, since a pile legitimately hides some
    // pills behind others, but 503b3041's cluster (capacity 31, ONE seed
    // component) misses by a factor of ten and cannot be explained by occlusion.
    const sheetBlob = new Set();
    {
      const pillArea = Math.max(1, Math.PI * radiusEst * radiusEst);
      // Label the strict-max seeds so distinct seeds can be counted per blob.
      const pileSeed = track(new cv.Mat(src.rows, src.cols, cv.CV_8UC1));
      const ps = pileSeed.data;
      for (let i = 0; i < bl.length; i++) {
        const l = bl[i];
        ps[i] = (l && peaks[l] > 1.4 * radiusEst && dd[i] >= pileFloor && dd[i] >= dm[i]) ? 255 : 0;
      }
      const seedLab = track(new cv.Mat());
      const nSeed = cv.connectedComponents(pileSeed, seedLab);
      const sl = seedLab.data32S;
      // one representative blob per seed component
      const seedBlob = new Int32Array(nSeed);
      for (let i = 0; i < sl.length; i++) if (sl[i]) seedBlob[sl[i]] = bl[i];
      const seedCount = new Map();
      for (let s = 1; s < nSeed; s++) {
        const b2 = seedBlob[s];
        if (b2) seedCount.set(b2, (seedCount.get(b2) || 0) + 1);
      }
      for (let l = 1; l < blobAreas.length; l++) {
        if (!blobAreas[l] || peaks[l] <= 1.4 * radiusEst) continue;
        const capacity = blobAreas[l] / pillArea;
        if (capacity < 4) continue; // too small to be a multi-pill sheet
        const got = seedCount.get(l) || 0;
        // Starvation alone is not enough to justify reseeding. A genuinely
        // STACKED pile is also seed-starved, but there the sparse point seeds
        // plus the downstream mass estimate get the count right, and reseeding
        // at pill scale merges the stack into mush instead (measured on
        // t2-salmon-pentagon-tablets-teal: 90 -> 16). Reseeding only helps when
        // the pills lie in ONE layer, and a single layer cannot be much thicker
        // than a single pill: a flat sheet's DT peak exceeds pill radius only at
        // the junctions where two pills' half-widths meet, capping it near 2x.
        // Real stacking runs past that (salmon: peak 35.4 vs radius 10.6, 3.3x;
        // the lined sheets: 60.3 vs 28.7 and 27 vs 13.4, both ~2.1x).
        let singleLayer = peaks[l] <= 2.4 * radiusEst;
        // The 2.4x test reads the blob's DT PEAK, which is only a layer-count
        // signal while the blob is elongated. A COMPACT fused raft breaks it:
        // a hex disc of 19 tablets is one layer, but its medial axis reaches
        // the raft's own inradius, so peak/radius came out 4.1 (53.2 vs 13) and
        // the sheet rescue refused it as a stack — the raft then kept its single
        // watershed basin and the image returned count=1 for nineteen pills.
        //
        // Compactness separates the two cases without consulting peak height:
        // in a single layer the blob's AREA is fully explained by pills tiling
        // a plane (area ~= n * pillArea), whereas a genuine stack hides pills
        // behind each other and covers far less ground than its pill count
        // implies. So if the blob's footprint is close to a disc AND its area
        // accounts for a whole number of pills at the measured scale, treat it
        // as one layer regardless of how deep its medial axis runs.
        if (!singleLayer) {
          const rEq = Math.sqrt(blobAreas[l] / Math.PI);      // radius of equal-area disc
          const compact = peaks[l] >= rEq * 0.72;             // peak ~ inradius => solid, not branched
          // A DISC IS NOT THE ONLY SINGLE LAYER. The compactness test asks
          // "is this blob a disc?", which a hex raft is and a full BOARD of
          // pills is not: measured on the adversarial dense case (120 pills
          // covering the frame), peak 96.4 against a required 115.8, so the
          // rescue declined and the watershed seeded only 34 markers in a
          // blob holding 120 pills -- under-called by 86.
          //
          // The question that matters is not the outline's shape but whether
          // the blob is ONE PILL THICK. Pills lying flat in a single layer
          // cover an area proportional to their number, so area/pillArea
          // tracks the count; a PILE hides area under the top layer and its
          // area falls well short. A solid interior (no holes, high fill of
          // its own bounding box) plus that area agreement is the honest
          // single-layer signature, and it does not care how wide the sheet
          // spreads.
          // blobBox is not built yet at this point, so judge from the two
          // quantities that are: the medial-axis depth and the area. A wide
          // single layer has a deep peak BECAUSE it is wide, and its area
          // still accounts for many whole pills at the measured scale.
          const sheetLike = capacity >= 20 && radiusEst > 0
            && peaks[l] >= 2.5 * radiusEst
            && blobAreas[l] >= 20 * Math.PI * radiusEst * radiusEst;
          if ((compact || sheetLike) && capacity >= 6) {
            singleLayer = true;
            opts.debug?.({ stage: 'compact-raft', blob: l, peak: +peaks[l].toFixed(1),
              rEq: +rEq.toFixed(1), capacity: +capacity.toFixed(1),
              via: compact ? 'disc' : 'sheet' });
          }
        }
        // The capacity >= 8 floor excluded small rafts outright. Measured on
        // the 7-pill dark and wood hex rafts: capacity 6.8 with ONE seed --
        // starved by any reading, since got < capacity/3 holds comfortably --
        // yet the rescue declined and both collapsed to count=1. A raft that
        // holds 4+ pills and was seeded with a third of them is the same
        // failure the rescue exists for, whatever its size.
        // TRIED AND REVERTED: lowering this floor to admit small rafts. The
        // 7-pill hex rafts have capacity 6.8 and are excluded here, so they
        // collapse to count=1 on dark and wood backgrounds. Lowering to 4
        // fixes all three, but costs r-cc7a2ada (19 -> 21) and no
        // discriminator separates them: measured side by side, the raft reads
        // area 3912 / capacity 6.8 / seeds 1 / peak 28 / thickR 2.07 and the
        // real clump reads 2592 / 7.8 / 1 / 21.8 / 2.12 -- the same on every
        // field the stage has. Requiring got <= 1 does not separate them
        // either; both are seeded with exactly one marker.
        // 1 corpus image is worth more than 2 adversarial ones, so the floor
        // stays until a real discriminator exists.
        const starved = got < capacity / 3 && singleLayer && capacity >= 8;
        if (starved) sheetBlob.add(l);
        opts.debug?.({ stage: 'sheet', blob: l, area: blobAreas[l], capacity: +capacity.toFixed(1), seeds: got, peak: +peaks[l].toFixed(1), radiusEst: +radiusEst.toFixed(1), thickR: +(peaks[l] / radiusEst).toFixed(2), singleLayer, starved });
      }
    }

    // PHOTO-SEEDED RAFTS. For a fused raft the mask carries no usable seed
    // signal at all: `dd >= 0.6 * radiusEst` is true across the whole interior,
    // so every seed merges into ONE component and the watershed has nothing to
    // separate — measured on a 19-pill hex raft, the reseed produced a single
    // solid marker and the image returned count=1.
    //
    // The PHOTO still shows every pill: each carries its own specular highlight
    // and a dark seam against its neighbours. A bake-off over the adversarial
    // suite (tools/raft-bakeoff.mjs) measured highlight, Hough and template
    // correlation all at 100% recall on exactly these images where the distance
    // transform managed 45%. Their false positives are uncorrelated because
    // they read independent layers, so requiring agreement — plus the
    // one-diameter packing rule that solid pills obey — cut spurious detections
    // to a quarter of the best single technique at the same recall.
    //
    // So seed compact rafts from the photo instead of the mask: local luminance
    // maxima at pill pitch, confirmed by radial-gradient (Hough) voting, spaced
    // at least one pill apart.
    const photoSeed = new Map();          // blob -> [[x,y],...]
    if (sheetBlob.size && opts.acScale !== false) {
      const W2 = src.cols, H2 = src.rows, sd2 = src.data;
      const lumAt = (x, y) => { const o = (y * W2 + x) * 4;
        return 0.299 * sd2[o] + 0.587 * sd2[o + 1] + 0.114 * sd2[o + 2]; };
      // ISOLATED BLOBS OUTRANK THE DT RIDGE FOR SEED SPACING.
      // A photo with a big fused clump plus a few pills standing alone has
      // direct evidence of pill size: the lone blobs ARE single pills. The DT
      // ridge is a thickness estimate and can be badly low when the mask is
      // eroded -- measured on lined-bfdbfef9, radiusEst 29.2 against isolated
      // blobs whose median area implies 42.7, and the pipeline's own later
      // `unitfix` stage independently lands on 43.7 from the same singles.
      //
      // That stage runs long AFTER seeding, so the correction never reaches
      // it: seeding used 29.2 and picked 43 seeds for a clump holding ~14
      // pills. Recovering it here costs one median over blobs we already have.
      let rad = Math.max(3, radiusEst);
      {
        const lone = [];
        for (let l = 1; l < peaks.length; l++) {
          if (sheetBlob.has(l)) continue;              // the fused clumps
          const a = blobAreas[l];
          if (a >= 0.35 * Math.PI * rad * rad && a <= 12 * Math.PI * rad * rad) lone.push(a);
        }
        if (lone.length >= 4) {
          lone.sort((x, y) => x - y);
          const rLone = Math.sqrt(lone[lone.length >> 1] / Math.PI);
          // Only when they disagree materially, and only upward: a ridge that
          // over-reads is the fused-raft case the autocorrelation already
          // handles, and lowering here would undo it.
          if (rLone > rad * 1.25) {
            opts.debug?.({ stage: 'seedscale', from: +rad.toFixed(1),
              to: +rLone.toFixed(1), lone: lone.length });
            rad = rLone;
          }
        }
      }
      // box-blur the luminance at a fraction of pill scale: kills sensor grain
      // without merging neighbouring highlights
      const br = Math.max(1, Math.round(rad * 0.22));
      const sm = new Float32Array(W2 * H2);
      {
        const tmp = new Float32Array(W2 * H2);
        for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
          let s2 = 0, n2 = 0;
          for (let d = -br; d <= br; d++) { const xx = x + d; if (xx < 0 || xx >= W2) continue; s2 += lumAt(xx, y); n2++; }
          tmp[y * W2 + x] = s2 / n2;
        }
        for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
          let s2 = 0, n2 = 0;
          for (let d = -br; d <= br; d++) { const yy = y + d; if (yy < 0 || yy >= H2) continue; s2 += tmp[yy * W2 + x]; n2++; }
          sm[y * W2 + x] = s2 / n2;
        }
      }
      // Hough-style centre vote: every strong rim gradient votes for a centre
      // one radius away, on BOTH sides (a sign-aware vote was measured and was
      // far worse — inside a raft a pill's rim gradient flips wherever the
      // neighbour outshines the board).
      const acc = new Float32Array(W2 * H2);
      for (let y = 1; y < H2 - 1; y++) for (let x = 1; x < W2 - 1; x++) {
        const i2 = y * W2 + x;
        const gx = sm[i2 + 1] - sm[i2 - 1], gy = sm[i2 + W2] - sm[i2 - W2];
        const g2 = Math.hypot(gx, gy);
        if (g2 < 6) continue;
        for (const sgn of [-1, 1]) {
          const cx2 = Math.round(x + sgn * gx / g2 * rad), cy2 = Math.round(y + sgn * gy / g2 * rad);
          if (cx2 < 0 || cy2 < 0 || cx2 >= W2 || cy2 >= H2) continue;
          acc[cy2 * W2 + cx2] += g2;
        }
      }
      for (const l of sheetBlob) {
        const cand = [];
        for (let y = 1; y < H2 - 1; y++) for (let x = 1; x < W2 - 1; x++) {
          const i2 = y * W2 + x;
          if (bl[i2] !== l) continue;
          cand.push([x, y, sm[i2] * 0.6 + acc[i2] * 0.02]);
        }
        cand.sort((a2, b2) => b2[2] - a2[2]);
        const picked = [];
        const sep2 = (rad * 1.55) ** 2;    // solid discs: one diameter apart    // solid discs: one diameter apart
        for (const [x, y] of cand) {
          if (picked.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < sep2)) continue;
          picked.push([x, y]);
        }
        opts.debug?.({ stage: 'photoseed-try', blob: l, cand: cand.length,
          picked: picked.length, rad: +rad.toFixed(1) });
        if (picked.length > 1) {
          photoSeed.set(l, picked);
          opts.debug?.({ stage: 'photoseed', blob: l, seeds: picked.length,
            capacity: +(blobAreas[l] / (Math.PI * rad * rad)).toFixed(1) });
        }
      }
    }

    for (let i = 0; i < bl.length; i++) {
      const l = bl[i];
      if (!l || peaks[l] < MIN_PEAK) { sf[i] = 0; continue; }
      if (photoSeed.has(l)) { sf[i] = 0; continue; }   // painted below
      if (peaks[l] <= 1.4 * radiusEst || sheetBlob.has(l)) {
        // Pill-scale / single-layer: threshold on the POPULATION radius rather
        // than this blob's own peak. For a sheet, `0.6 * peaks[l]` would key off
        // the inflated junction depth and select only the junctions; the pill
        // cores it needs to seed sit at radiusEst.
        const cut = sheetBlob.has(l) ? 0.6 * radiusEst : 0.6 * peaks[l];
        sf[i] = dd[i] >= cut ? 255 : 0;
      } else {
        sf[i] = dd[i] >= pileFloor && dd[i] >= dm[i] ? 255 : 0;
      }
    }
    // Paint the photo-derived seeds as small discs, well inside one pill so
    // neighbouring seeds stay separate components for the watershed.
    for (const [, pts] of photoSeed) {
      const rr2 = Math.max(2, Math.round(radiusEst * 0.30));
      for (const [x, y] of pts) {
        for (let dy = -rr2; dy <= rr2; dy++) for (let dx = -rr2; dx <= rr2; dx++) {
          if (dx * dx + dy * dy > rr2 * rr2) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= src.cols || yy >= src.rows) continue;
          sf[yy * src.cols + xx] = 255;
        }
      }
    }
    cv.dilate(sureFg, sureFg, kernel, anchor, 1); // fatten point seeds

    if (emit) emit('markers', grayToStage(sureFg));

    const unknown = track(new cv.Mat());
    cv.subtract(sureBg, sureFg, unknown);

    const markers = track(new cv.Mat());
    cv.connectedComponents(sureFg, markers);

    // Shift labels so background=1, and zero out the unknown band for watershed.
    const md = markers.data32S;
    const ud = unknown.data;
    for (let i = 0; i < md.length; i++) {
      md[i] += 1;
      if (ud[i] === 255) md[i] = 0;
    }

    const rgb = track(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.watershed(rgb, markers);

    // Tally each labeled region (label 1 = background, -1 = boundary).
    const w = src.cols, h = src.rows;
    const stats = new Map(); // label -> {area, sx, sy, peak}
    for (let i = 0; i < md.length; i++) {
      const l = md[i];
      if (l <= 1) continue;
      let s = stats.get(l);
      if (!s) { s = { area: 0, sx: 0, sy: 0, peak: 0, blob: bl[i] }; stats.set(l, s); }
      s.area++;
      s.sx += i % w;
      s.sy += (i / w) | 0;
      if (dd[i] > s.peak) s.peak = dd[i];
    }

    // Median of pill-sized regions; the absolute floor keeps texture specks
    // from dragging the median down, then a relative floor rejects fragments.
    // The 2%-of-largest floor keeps a handful of specks from corrupting the
    // median in few-pill photos (3 large pills + 3 specks would otherwise
    // put the median between the two populations and split every pill).
    const allAreas = [...stats.values()].map((s) => s.area);
    const maxArea = Math.max(0, ...allAreas);
    const areas = allAreas.filter((a) => a >= Math.max(absFloor, 0.02 * maxArea));
    const med = median(areas);
    const minArea = Math.max(absFloor, med * 0.3);

    const medPeak = median([...stats.values()].filter((s) => s.area >= minArea).map((s) => s.peak));
    let regions = [];
    let count = 0;
    // Set when the splotch population guard refuses the shape filter: a
    // signal that solidity/circularity could not separate pills from junk on
    // this photo, so scales derived alongside them are suspect downstream.
    let splotchRefused = false;
    for (const [lbl, s] of stats) {
      // The relative area floor assumes a discarded region is a sliver of
      // texture. That is wrong for a clump the watershed SHATTERED — most
      // often one running off the FRAME EDGE, where pills are cut and the
      // distance transform has no clean interior maximum to seed from. Such
      // fragments are small in AREA but retain a pill's THICKNESS, and
      // thickness is the property that texture slivers never have. Measured
      // on a real photo: a frame-edge clump split into 1213/1065/710/... px
      // against a 1109px floor, and the 1065px piece — peak 41.6 vs the
      // population's ~22 — was thrown away, losing a whole pill upstream of
      // every later stage. Keep a sub-floor fragment only when it is as thick
      // as a real pill and still carries real mass.
      const thickCore = s.peak >= medPeak && s.area >= Math.max(absFloor, 0.25 * med);
      if (s.area < minArea && !thickCore) continue;
      if (s.peak < MIN_PEAK) continue; // thin artifact (rim, engraving), not a pill
      // Oversized region => watershed under-split; estimate pills by area
      // ratio. 1.5x catches merged PAIRS (the most common under-split; any
      // ratio >= 1.5 already rounds to 2 units, and mixed-size pairs like
      // capsule+tablet land near 1.55x); splitting still requires pill-like
      // thickness so rings/rims never multiply.
      // The thickness guard exists to stop thin rings/rims from multiplying,
      // but it also blocked legitimate splits: when pills OVERLAP or one lies
      // SIDEWAYS, the merged region is thin at the neck, so its peak falls
      // below the population's and the split never fired (user-reported: a
      // sideways pill in a clump was never counted). Allow the split when the
      // region is either pill-thick OR clearly oversized in area — a ring is
      // never both large in area and elongated like a pill run.
      const thickEnough = s.peak >= 0.8 * medPeak;
      const clearlyMultiple = s.area > med * 1.8 && s.peak >= 0.5 * medPeak;
      const units = med > 0 && s.area > med * 1.5 && (thickEnough || clearlyMultiple)
        ? Math.max(1, Math.round(s.area / med)) : 1;
      count += units;
      regions.push({ cx: s.sx / s.area, cy: s.sy / s.area, area: s.area, units, label: lbl });
    }

    // WATERSHED FLOOD-LOSS RESCUE. A pill-sized mask blob can come out of the
    // watershed with NO region at all: thick blobs (peak > 1.4x radiusEst)
    // get strict local-maximum point seeds, and on a low-contrast surface the
    // background label floods across the blob's faint rim and claims nearly
    // every pixel, leaving the interior seed a few px. Measured on
    // t3-white-caplets-blue-sparse (white pills on light blue, contrast ~8):
    // a flush side-by-side pair reads peak 56 against radiusEst 30 (the seam
    // inflates the DT), takes the pile branch, and its 15109 px mask blob
    // yields one 11 px piece -- the pair vanished from the count while its
    // twin pair in the same photo (whose watershed kept one 6.7k px region)
    // was counted and arc-raised to 2. The mask said FOREGROUND for a
    // pill-sized area; silently dropping it is never right. Re-enter the
    // blob as ONE conservative region carrying its largest surviving piece's
    // label (so labelBlob and the panel machinery see it normally) and let
    // the downstream witnesses -- splotch, shape, panel, boundary arcs --
    // decide what it is. Only blobs with ZERO pushed regions qualify, so
    // this can never double-count a partially-covered blob.
    {
      const pushed = new Set();
      for (const r of regions) {
        const s = stats.get(r.label);
        if (s && s.blob) pushed.add(s.blob);
      }
      const lost = [];
      for (let l = 1; l < peaks.length; l++) {
        if (blobAreas[l] >= Math.max(minArea, absFloor) && peaks[l] >= MIN_PEAK && !pushed.has(l)) lost.push(l);
      }
      if (lost.length) {
        const lsx = new Map(), lsy = new Map();
        for (const l of lost) { lsx.set(l, 0); lsy.set(l, 0); }
        for (let i = 0; i < bl.length; i++) {
          const l = bl[i];
          if (!lsx.has(l)) continue;
          lsx.set(l, lsx.get(l) + (i % w));
          lsy.set(l, lsy.get(l) + ((i / w) | 0));
        }
        for (const l of lost) {
          let bestLbl = 0, bestA = 0;
          for (const [lbl, s] of stats) {
            if (s.blob === l && s.area > bestA) { bestA = s.area; bestLbl = lbl; }
          }
          if (!bestLbl) continue; // no surviving piece to hang a label on
          count += 1;
          regions.push({ cx: lsx.get(l) / blobAreas[l], cy: lsy.get(l) / blobAreas[l],
            area: blobAreas[l], units: 1, label: bestLbl });
          opts.debug?.({ stage: 'floodloss', blob: l, area: blobAreas[l], piece: bestA });
        }
      }
    }


    // Population-geometry veto ("splotch filter"). Pixel statistics alone
    // (color distance + area + thickness) cannot separate pills from patches
    // of a mottled surface: a cutting-board splotch reaches pill-like area.
    // Object identity can: one medication => one convex shape at one size.
    // Measured on real photos — pills: solidity .93-.98, circularity .60-.70;
    // splotches: solidity ~.72, circularity ~.42 at ~0.5x the pill area.
    // A real pill is never BOTH mis-shapen AND undersized (an on-edge pill is
    // small but well-formed, so it survives this test).
    if (regions.length >= 4) {
      const contV = new cv.MatVector();
      const hierV = track(new cv.Mat());
      cv.findContours(bw, contV, hierV, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const shapeAt = new Map(); // pixel index -> {solidity, circularity, area}
      const idOf = track(cv.Mat.zeros(src.rows, src.cols, cv.CV_32S));
      const shapes = [null];
      for (let i = 0; i < contV.size() && shapes.length < 4000; i++) {
        const c = contV.get(i);
        const a = cv.contourArea(c);
        if (a >= absFloor) {
          const peri = cv.arcLength(c, true);
          const hull = new cv.Mat();
          cv.convexHull(c, hull);
          const ha = cv.contourArea(hull);
          hull.delete();
          shapes.push({
            area: a,
            solidity: ha ? a / ha : 0,
            circularity: peri ? (4 * Math.PI * a) / (peri * peri) : 0,
          });
          cv.drawContours(idOf, contV, i, new cv.Scalar(shapes.length - 1), -1);
        }
        c.delete();
      }
      contV.delete();

      const io = idOf.data32S;
      const wellFormed = shapes.filter((s) => s && s.solidity >= 0.90 && s.circularity >= 0.55);
      // POPULATION SANITY GUARD ON THE SPLOTCH FILTER.
      //
      // Both arms below rest on an unstated premise: splotches are a MINORITY
      // contaminant, and `wellFormed` (solidity >=0.90 AND circularity >=0.55)
      // is a fair sample of the pill class to measure them against. On a
      // glare-shredded photo of ELONGATED pills both halves fail at once, and
      // they fail in the same direction, so the filter inverts.
      //
      // Why circularity in particular cannot be trusted here: it is
      // 4*pi*area/perimeter^2, so it is quadratically sensitive to perimeter
      // ROUGHNESS — and a ragged boundary is precisely what specular shredding
      // produces. An ideal stadium at the beads' ~2.5 aspect scores 0.761,
      // comfortably over the 0.50 bar; the real shredded beads measure
      // 0.357-0.507 purely from boundary noise, not from being splotch-shaped.
      //
      // Measured on s-0bfc44d8 (34 beads, one medication): the filter removed
      // 14 of 43 regions — 13 REAL BEADS and 1 piece of junk — and the single
      // genuine junk blob scored HIGHER on BOTH criteria (sol 0.903, circ
      // 0.635) than every real bead it was grouped with (sol 0.756-0.883,
      // circ 0.357-0.497). The criteria had no discriminative power in either
      // direction, so the stage was pure loss: those 13 are 10 of the image's
      // per-pill misses.
      //
      // ONE MEDICATION PER PHOTO is the invariant that makes this checkable
      // without new tuning: the pills in a photo are one population, so a
      // shape test that condemns a large SHARE of that population is not
      // finding contaminants — it has mis-modelled the pill class. Compute the
      // verdicts first and refuse the whole stage when it over-reaches. The
      // bar is deliberately loose (a third of the regions) so it only catches
      // the inversion; genuine debris photos kill a handful out of many and
      // are untouched, and the corpus confirms it (no count moves).
      if (wellFormed.length >= 3) {
        const medGood = median(wellFormed.map((s) => s.area));
        const shOf = (r) => shapes[io[Math.round(r.cy) * w + Math.round(r.cx)] || 0];
        const doomed = regions.filter((r) => {
          const sh = shOf(r);
          if (!sh) return false;
          return (sh.solidity < 0.85 || sh.circularity < 0.50) && sh.area < 0.75 * medGood
            ? true : sh.area < 0.45 * medGood;
        });
        const overReach = regions.length >= 6 && doomed.length > 0.33 * regions.length;
        if (overReach) {
          splotchRefused = true;
          opts.debug?.({ stage: 'splotch-refused', kind: 'population',
            regions: regions.length, doomed: doomed.length,
            wellFormed: wellFormed.length, medGood: +medGood.toFixed(0) });
        }
        const kept = [];
        for (const r of regions) {
          const sh = shapes[io[Math.round(r.cy) * w + Math.round(r.cx)] || 0];
          // The solidity floor must clear the ON-EDGE pill, which this AND-test
          // was assumed to spare ("small but well-formed") but did not. An
          // oblong resting on its narrow side keeps its LENGTH while projecting
          // only ~2/3 the area, so it lands squarely inside `undersized`, and
          // its narrow-side silhouette is just rough enough to trip a 0.88
          // solidity bar. Measured, all three of them within 0.008 of that bar:
          //   r-5de0d534   solidity 0.872, circ 0.507, area 0.66x  -> killed
          //   r-9e5ac6c9   solidity 0.875, circ 0.500, area 0.70x  -> killed
          //   edge-ad9ea48c solidity 0.877, circ 0.523, area 0.75x -> killed
          // Each was a real pill, dropped before any later stage could see it,
          // costing exactly one count on each photo (18 for a true 19).
          //
          // Genuine splotches are materially non-convex, not marginally so: the
          // one on r-295482c1 (an image that counts exactly) scores solidity
          // 0.766 at 0.75x area, and the population medians quoted above run
          // ~0.72. That leaves a clean ~0.10 gap between the worst on-edge pill
          // (0.872) and the best splotch (0.766); 0.85 sits in the middle of it,
          // so both populations keep real margin. Verified: 0.86/0.87 recover
          // only 2 of the 3 pills, 0.84 recovers the same 3 as 0.85 with less
          // room above the splotch, and 0.85 breaks nothing across 267 images.
          const misshapen = sh && (sh.solidity < 0.85 || sh.circularity < 0.50);
          const undersized = sh && sh.area < 0.75 * medGood;
          if (misshapen && undersized && !overReach) {
            opts.debug?.({ stage: 'splotchkill', arm: 'shape', cx: r.cx, cy: r.cy,
              area: sh.area, sol: +sh.solidity.toFixed(3), circ: +sh.circularity.toFixed(3),
              medGood: +medGood.toFixed(0) });
            count -= r.units; continue; } // splotch
          // SIZE-ONLY veto. One photo holds ONE medication, so every pill is
          // the same size; a blob far below the population's area is not a
          // pill whatever its shape. The AND-test above misses the common
          // case of a WELL-FORMED surface mark (a round stain on the board
          // scores solidity ~.95, circularity ~.8 and sails through), which
          // is why an area-only arm is needed.
          //
          // The floor must clear the on-edge case, the one legitimately
          // small pill: an oblong resting on its narrow side keeps its
          // LENGTH but projects only ~2/3 the area. 0.45 sits well below
          // that 0.67 so on-edge pills are never touched, while the
          // measured splotches (0.34x on r-96e5f08f) fall clearly outside.
          if (sh && sh.area < 0.45 * medGood && !overReach) {
            opts.debug?.({ stage: 'splotchkill', arm: 'size', cx: r.cx, cy: r.cy,
              area: sh.area, sol: +sh.solidity.toFixed(3), circ: +sh.circularity.toFixed(3),
              medGood: +medGood.toFixed(0) });
            count -= r.units; continue; }
          kept.push(r);
        }
        if (kept.length !== regions.length) {
          opts.debug?.({ stage: 'splotch', removed: regions.length - kept.length, medGood });
        }
        regions = kept;
      }
    }

    let activeMd = md;
    let out2Template = null;   // template card info, filled by the debug emit
    let deferredGeometry = null;   // re-render geometry after clump placement
    const COMBINER = opts.combiner || 'A';   // bake-off selector; A = shipping
    let stampKernelUsed = null, stampFgUsed = null;   // for the match-map stage
    let unitArea = 0;

    // 'geometry' variant: classify every mask region by shape before counting.
    // Pills are convex ellipses; touching clusters are convex-deficient at
    // their necks; texture junk is neither. Reasonableness rules: a pill's
    // area can never be far below pi*(its thickness)^2, artifacts are never
    // counted, and only convex-deficient regions may count as more than one.
    if (opts.variant === 'geometry') {
      const contours = new cv.MatVector();
      const hier = track(new cv.Mat());
      cv.findContours(bw, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const items = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area < absFloor) { c.delete(); continue; }
        const hull = new cv.Mat();
        cv.convexHull(c, hull);
        const hullArea = cv.contourArea(hull);
        hull.delete();
        const solidity = hullArea ? area / hullArea : 0;
        let ell = null, fill = 0, aspect = 99;
        if (c.rows >= 5) {
          const e = cv.fitEllipse(c);
          const ea = Math.PI * (e.size.width / 2) * (e.size.height / 2);
          fill = ea ? area / ea : 0;
          aspect = Math.max(e.size.width, e.size.height) / Math.max(1, Math.min(e.size.width, e.size.height));
          ell = { cx: e.center.x, cy: e.center.y, rx: e.size.width / 2, ry: e.size.height / 2, angle: e.angle };
        }
        // Pass 1: SHAPE classification only (clump-proof — a giant merged
        // clump can't corrupt solidity/fill of the other regions).
        const pillShaped = solidity >= 0.92 && fill >= 0.85 && fill <= 1.15 && aspect <= 3.5;
        const clusterShaped = !pillShaped && solidity >= 0.72;
        items.push({ area, ell, pillShaped, clusterShaped });
        c.delete();
      }
      contours.delete();

      // Unit from shape-clean specimens (median is robust to a few shape-
      // passing specks); thickness-implied area only as a last resort.
      const specimens = items.filter((x) => x.pillShaped).map((x) => x.area);
      let unitG = specimens.length >= 1 ? median(specimens) : Math.PI * radiusEst * radiusEst;
      unitG = Math.max(unitG, absFloor);

      // Pass 2: size-gate against the unit. Pill-shaped but far smaller than
      // a pill = artifact (texture speck); cluster mass divides by the unit.
      regions = [];
      count = 0;
      unitArea = unitG;
      for (const x of items) {
        if (!x.ell) continue;
        if (x.pillShaped && x.area >= 0.45 * unitG && x.area <= 2.2 * unitG) {
          count += 1;
          regions.push({ cx: x.ell.cx, cy: x.ell.cy, area: x.area, units: 1, ellipse: x.ell, cls: 'pill' });
        } else if ((x.clusterShaped || x.pillShaped) && x.area > 1.5 * unitG) {
          const units = Math.max(2, Math.round(x.area / unitG));
          count += units;
          regions.push({ cx: x.ell.cx, cy: x.ell.cy, area: x.area, units, ellipse: x.ell, cls: 'cluster' });
        }
        // everything else: artifact — never counted
      }
    }

    // Clump-collapse rescue. A tight monolayer clump (all pills touching, no
    // isolated specimen) closes+fills into one SOLID blob: the filled
    // distance transform loses per-pill structure, radiusEst inflates to the
    // clump thickness, and the whole cluster tallies as 1-3 regions. Rebuild
    // markers from a mask that still knows the pill size: the PRE-FILL mask
    // (inter-pill crevices still open, so its distance peak is one pill
    // radius), else the crease-cut mask (intensity valleys where pills meet).
    if (count >= 1 && count <= 3) {
      const fgArea = cv.countNonZero(bw);
      if (fgArea >= 12 * absFloor) {
        // Candidate structure masks, coarsest signal first. Each is accepted
        // if its distance peak is pill-scale (far below the clump thickness).
        const dt2 = track(new cv.Mat());
        let mm2 = { maxVal: 0 };
        let source = 'none';
        let massCap = Infinity;
        const structOk = () => mm2.maxVal >= 6 && mm2.maxVal <= 0.6 * radiusEst;
        cv.distanceTransform(preFill, dt2, cv.DIST_L2, 5);
        mm2 = cv.minMaxLoc(dt2);
        source = 'prefill';
        if (!structOk()) {
          // Crease-cut mask. Its pieces also give a unit-area estimate that
          // caps the final count: on ELONGATED pills the distance transform
          // has several maxima per pill, so maxima-markers over-split, but
          // mask-area / unit-area stays honest.
          const cutM = track(new cv.Mat());
          bw.copyTo(cutM);
          cutCreases(cv, src, cutM);
          cv.distanceTransform(cutM, dt2, cv.DIST_L2, 5);
          mm2 = cv.minMaxLoc(dt2);
          source = 'crease';
          if (structOk()) {
            const cutLab = track(new cv.Mat());
            cv.connectedComponents(cutM, cutLab);
            const cl2 = cutLab.data32S;
            const pMap = new Map();
            for (let i = 0; i < cl2.length; i++) {
              if (cl2[i]) pMap.set(cl2[i], (pMap.get(cl2[i]) || 0) + 1);
            }
            const pAreas = [...pMap.values()].filter((a) => a >= absFloor);
            const unit = estimateUnitArea(pAreas);
            if (pAreas.length >= 4 && unit >= absFloor) massCap = Math.round(fgArea / unit);
          }
        }
        if (!structOk()) {
          // Re-threshold the color-distance map above Otsu: crevices between
          // touching pills sit just above the background cut and reopen,
          // while pill bodies stay far above it. Climb a ladder and keep the
          // first cut that yields pill-scale structure.
          const hiM = track(new cv.Mat());
          for (const mult of [1.25, 1.5, 1.75, 2.1]) {
            const hiThr = Math.min(250, mult * otsuThr);
            cv.threshold(distBg, hiM, hiThr, 255, cv.THRESH_BINARY);
            cv.bitwise_and(hiM, bw, hiM);
            cv.distanceTransform(hiM, dt2, cv.DIST_L2, 5);
            mm2 = cv.minMaxLoc(dt2);
            source = 'hithresh' + mult;
            if (structOk()) break;
          }
        }
        opts.debug?.({ stage: 'collapse', count, fgArea, source, structMax: mm2.maxVal, radiusEst, massCap });
        if (structOk()) {
          const rN = mm2.maxVal;
          const dd3 = dt2.data32F;
          const kkN = Math.min(40, Math.max(2, Math.round(0.8 * rN)));
          const dil3 = track(new cv.Mat());
          const mk3 = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * kkN + 1, 2 * kkN + 1)));
          cv.dilate(dt2, dil3, mk3);
          const dm3 = dil3.data32F;
          const sf3m = track(new cv.Mat(src.rows, src.cols, cv.CV_8UC1));
          const sf3 = sf3m.data;
          const floor3 = Math.max(MIN_PEAK, 0.45 * rN);
          for (let i = 0; i < sf3.length; i++) {
            sf3[i] = dd3[i] >= floor3 && dd3[i] >= dm3[i] ? 255 : 0;
          }
          cv.dilate(sf3m, sf3m, kernel, anchor, 1);
          const markers3 = track(new cv.Mat());
          cv.connectedComponents(sf3m, markers3);
          const md3 = markers3.data32S;
          const sb3 = sureBg.data;
          for (let i = 0; i < md3.length; i++) {
            md3[i] += 1;
            if (sb3[i] === 255 && sf3[i] === 0) md3[i] = 0;
          }
          cv.watershed(rgb, markers3);
          const stats3 = new Map();
          for (let i = 0; i < md3.length; i++) {
            const l = md3[i];
            if (l <= 1) continue;
            let s = stats3.get(l);
            if (!s) { s = { area: 0, sx: 0, sy: 0, peak: 0 }; stats3.set(l, s); }
            s.area++;
            s.sx += i % w;
            s.sy += (i / w) | 0;
            if (dd3[i] > s.peak) s.peak = dd3[i];
          }
          const areas3 = [...stats3.values()].map((s) => s.area).filter((a) => a >= absFloor);
          const med3 = median(areas3);
          const minArea3 = Math.max(absFloor, med3 * 0.3);
          let count3 = 0;
          const regions3 = [];
          for (const s of stats3.values()) {
            if (s.area < minArea3 || s.peak < MIN_PEAK) continue;
            const units = med3 > 0 && s.area > med3 * 1.5 ? Math.max(1, Math.round(s.area / med3)) : 1;
            count3 += units;
            regions3.push({ cx: s.sx / s.area, cy: s.sy / s.area, area: s.area, units });
          }
          opts.debug?.({ stage: 'collapse2', rN, markers: stats3.size, count3, massCap });
          // Only adopt a DECISIVE improvement. A marginal rescue is bistable:
          // tiny exposure changes flip it on and off between frames, which is
          // what made live counts swing wildly on textured backgrounds. The
          // rescue must find several times more pills than the plain tally.
          if (count3 >= Math.max(count * 3, count + 5)) {
            count = Math.min(count3, massCap);
            regions = regions3;
            activeMd = md3;
          }
        }
      }
    }

    // 'mass' variant: pixel-mass counting. Same medication => equal pill
    // area, so each blob's pixel count is ~an integer multiple of one pill's
    // area. Count = sum of round(blobArea / unitArea); watershed boundaries
    // are kept only for the overlay.
    if (opts.variant === 'mass') {
      const blobList = [];
      for (let l = 1; l < peaks.length; l++) {
        if (blobAreas[l] >= absFloor && peaks[l] >= MIN_PEAK) blobList.push(l);
      }
      let unit = estimateUnitArea(blobList.map((l) => blobAreas[l]));

      // Clump rescue: cut creases on a mask copy and re-measure. If cutting
      // reveals substantially more pieces than there were blobs, the blobs
      // were multi-pill clumps and the pieces are the real unit calibration.
      const cutM = track(new cv.Mat());
      bw.copyTo(cutM);
      cutCreases(cv, src, cutM);
      const cutLab = track(new cv.Mat());
      cv.connectedComponents(cutM, cutLab);
      const cl = cutLab.data32S;
      const pieceStats = new Map(); // label -> {area, sx, sy, blob}
      for (let i = 0; i < cl.length; i++) {
        if (!cl[i]) continue;
        let p = pieceStats.get(cl[i]);
        if (!p) { p = { area: 0, sx: 0, sy: 0, blob: bl[i] }; pieceStats.set(cl[i], p); }
        p.area++;
        p.sx += i % w;
        p.sy += (i / w) | 0;
      }
      const pieces = [...pieceStats.values()].filter((p) => p.area >= absFloor);
      const unit2 = estimateUnitArea(pieces.map((p) => p.area));
      // Physical sanity: a pill's area can't be much less than pi*(half its
      // thickness)^2 — engraving fragments fail this and must not calibrate.
      const minPlausibleUnit = 0.6 * Math.PI * radiusEst * radiusEst;
      // A FLOOR WITHOUT A CEILING IS HALF A GUARD. The crease cut on a dense
      // raft yields a few huge merged fragments, and their median becomes the
      // "unit": measured on the adversarial dense case (120 pills, R=13), this
      // installed a unit of 9317px against a geometric 531px -- 17.5x too big
      // -- so pixel mass read the whole 81264px board as 8.72 units and the
      // panel never had a chance. The raft-unit rescue had already set 531
      // correctly two stages earlier; this line silently undid it.
      //
      // radiusEst is the autocorrelation pitch here, independent of the mask,
      // so it bounds both directions. A real pill cannot be several times the
      // area its own measured radius implies. Generous at 3x so genuinely
      // elongated caplets (whose area exceeds a circle of their half-width)
      // are untouched -- the case this bites is an order of magnitude out.
      if (pieces.length >= blobList.length * 2 && unit2 >= Math.max(absFloor, minPlausibleUnit)) unit = unit2;
      opts.debug?.({ stage: 'mass', blobs: blobList.length, unit, pieces: pieces.length, unit2 });

      if (blobList.length >= 2 && unit >= absFloor) {
        const cent = new Map(blobList.map((l) => [l, { sx: 0, sy: 0, n: 0 }]));
        for (let i = 0; i < bl.length; i++) {
          const c = cent.get(bl[i]);
          if (c) { c.sx += i % w; c.sy += (i / w) | 0; c.n++; }
        }
        // Badge placement: when the watershed found exactly as many pill
        // centers inside a blob as its mass says it holds, badge those
        // centers (pills), not the blob centroid (which is the gap between
        // touching pills). Otherwise fall back to a range badge.
        const baseByBlob = new Map();
        for (const r of regions) {
          const l = bl[(Math.round(r.cy) * w + Math.round(r.cx)) | 0];
          if (!baseByBlob.has(l)) baseByBlob.set(l, []);
          baseByBlob.get(l).push(r);
        }
        regions = [];
        count = 0;
        for (const l of blobList) {
          const units = Math.max(1, Math.round(blobAreas[l] / unit));
          count += units;
          const centers = (baseByBlob.get(l) || []).filter((r) => r.units === 1);
          const pieceCenters = pieces
            .filter((p) => p.blob === l && p.area >= 0.55 * unit && p.area <= 1.8 * unit)
            .map((p) => ({ cx: p.sx / p.area, cy: p.sy / p.area, area: p.area }));
          const pick = centers.length === units ? centers
            : (pieceCenters.length === units ? pieceCenters : null);
          if (units > 1 && pick) {
            for (const r of pick) regions.push({ cx: r.cx, cy: r.cy, area: r.area, units: 1 });
          } else if (units === 1 && centers.length === 1) {
            regions.push({ cx: centers[0].cx, cy: centers[0].cy, area: blobAreas[l], units: 1 });
          } else {
            const c = cent.get(l);
            regions.push({ cx: c.sx / c.n, cy: c.sy / c.n, area: blobAreas[l], units });
          }
        }
        unitArea = unit;
      }
    }

    // 'sized' variant: pharmacy counts are one medication, so all pills share
    // one size. Pass 1 (above) yields candidate regions; estimate the unit
    // pill area from the compact ones, then redo markers + watershed with
    // size-informed spacing and floors, and split clusters by area/unit.
    if (opts.variant === 'sized') {
      const compact = [...stats.values()]
        .filter((s) => s.area >= absFloor && s.peak >= MIN_PEAK && s.area <= 4 * Math.PI * s.peak * s.peak)
        .map((s) => s.area)
        .sort((a, b) => a - b);
      // Pill radius from blob thickness (immune to touching-cluster merges);
      // shape factor from the smaller compact regions (singles cohort) —
      // ~1 for round tablets, up to ~2.6 for elongated capsules.
      const r = radiusEst;
      const p25 = compact.length ? compact[Math.floor(compact.length * 0.25)] : 0;
      const shape = Math.min(2.6, Math.max(0.85, p25 / (Math.PI * r * r)));
      unitArea = shape * Math.PI * r * r;
      opts.debug?.({ stage: 'unit', compact: compact.length, unitArea, r, shape });

      if (compact.length >= 3 && unitArea >= absFloor) {
        const kk2 = Math.min(60, Math.max(2, Math.round(r * 0.9)));
        const dil2 = track(new cv.Mat());
        const mk2 = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * kk2 + 1, 2 * kk2 + 1)));
        cv.dilate(dist, dil2, mk2);
        const dm2 = dil2.data32F;

        const sf2m = track(new cv.Mat(src.rows, src.cols, cv.CV_8UC1));
        const sf2 = sf2m.data;
        const floor2 = Math.max(MIN_PEAK, 0.45 * r);
        for (let i = 0; i < bl.length; i++) {
          sf2[i] = bl[i] && dd[i] >= floor2 && dd[i] >= dm2[i] - 0.5 ? 255 : 0;
        }
        cv.dilate(sf2m, sf2m, kernel, anchor, 1);

        const markers2 = track(new cv.Mat());
        cv.connectedComponents(sf2m, markers2);
        const md2 = markers2.data32S;
        // Recompute the unknown band against pass-2 markers — reusing pass-1's
        // would leave background seeds inside pills wherever the marker moved.
        const sb = sureBg.data;
        for (let i = 0; i < md2.length; i++) {
          md2[i] += 1;
          if (sb[i] === 255 && sf2[i] === 0) md2[i] = 0;
        }
        cv.watershed(rgb, markers2);

        const stats2 = new Map();
        for (let i = 0; i < md2.length; i++) {
          const l = md2[i];
          if (l <= 1) continue;
          let s = stats2.get(l);
          if (!s) { s = { area: 0, sx: 0, sy: 0, peak: 0 }; stats2.set(l, s); }
          s.area++;
          s.sx += i % w;
          s.sy += (i / w) | 0;
          if (dd[i] > s.peak) s.peak = dd[i];
        }

        regions = [];
        count = 0;
        const minArea2 = Math.max(absFloor, 0.4 * unitArea);
        opts.debug?.({ stage: 'pass2', markers: cv.countNonZero(sf2m), regions2: stats2.size, minArea2 });
        for (const s of stats2.values()) {
          if (s.area < minArea2 || s.peak < MIN_PEAK) continue;
          const units = Math.max(1, Math.round(s.area / unitArea));
          count += units;
          regions.push({ cx: s.sx / s.area, cy: s.sy / s.area, area: s.area, units });
        }
        activeMd = md2;
      }
    }

    // 'consensus' variant: keep the baseline result for CLEAR blobs, and for
    // the few AMBIGUOUS ones run an independent panel of per-blob counters,
    // taking the answer >=2 methods agree on. Blobs where no two methods
    // agree get the median vote and a LOW-CONFIDENCE flag — the count is
    // never silently wrong (see docs/consensus-design.md).
    let lowConfidence = 0;
    let consensusEligible = Infinity;
    if (opts.variant === 'consensus') {
      for (const r of regions) r.confidence = 'high';

      // -- Unit-area calibration (same-medication prior), as in 'mass'. --
      const blobList = [];
      for (let l = 1; l < peaks.length; l++) {
        // On a SHATTERED mask absFloor is far too permissive: it is
        // (0.012 * min side)^2 -- 81px on a 1000x750 photo -- fixed before any
        // pill size is known. Measured on the adversarial noise raft, 207
        // components clear it and 117 are under a QUARTER of a pill, which is
        // where its 274 spurious pills come from. radiusEst is trustworthy on
        // these images now (the correlation pitch corrected it), so a
        // pill-relative floor is finally available.
        // Area alone cannot separate grain from pills on a textured board:
        // measured on the adversarial noise raft, 90 components clear a
        // quarter-pill floor and only FOUR of them are plausibly a pill (area
        // >= half a pill AND aspect < 2.2). The other 86 are grain and
        // streaks, 31 with a median aspect of 2.5 -- long smears no tablet
        // could be. Each then votes k:1 and becomes a counted pill.
        //
        // A quarter-pill floor is what measured best: raising it to HALF made
        // the noise raft WORSE (289 -> 299), because removing mid-sized blobs
        // let the remaining ones absorb more area and count higher. Area
        // thresholds are not the lever for this failure.
        const floorL = shatteredMask && radiusEst > 3
          ? Math.max(absFloor, 0.25 * Math.PI * radiusEst * radiusEst) : absFloor;
        if (blobAreas[l] >= floorL && peaks[l] >= MIN_PEAK) blobList.push(l);
      }
      // Calibrate on pill-sized blobs only. ONE MEDICATION PER PHOTO means
      // every pill is the same size, so blobs a small fraction of the biggest
      // ones are debris, not product -- and debris must not set the unit.
      // Glossy tablets make this acute: printed text and specular highlights
      // punch interior holes that survive as tiny blobs. Measured on
      // t2-advil-scatter-dark-1, ~30 imprint fragments of 106..524 px sat
      // beside real tablets of ~8500 px and dragged BOTH estimators down
      // (unit 322 and unitLen 21.7 against a true tablet of ~8500 / ~100),
      // after which each tablet read as dozens of pills: 283 counted vs 28.
      //
      // The 80th percentile of area is the anchor -- high enough that debris
      // (many but small) cannot reach it, while a genuine clump-heavy photo
      // still lands on real pill material. An on-edge pill keeps ~2/3 of the
      // flat area, well clear of the 0.33 cut, so it is never discarded.
      // Falls back to the unfiltered list whenever filtering would leave too
      // few blobs to calibrate from.
      const areasSorted = blobList.map((l) => blobAreas[l]).sort((x, y) => x - y);
      const hiArea = areasSorted.length
        ? areasSorted[Math.min(areasSorted.length - 1, Math.floor(areasSorted.length * 0.8))] : 0;
      const solidList = hiArea > 0
        ? blobList.filter((l) => blobAreas[l] >= 0.33 * hiArea) : blobList;
      // Only trust this filter when the discarded blobs look like DEBRIS
      // rather than pills. The 80th-percentile anchor is a multi-pill CLUMP
      // in a photo where pills touch heavily, and then a perfectly real
      // single pill sits below 0.33x of it. Measured on r-cc7a2ada, whose 10
      // blobs hold 19 pills: the filter dropped 3 of 10 and the count fell
      // from 18 to 16.
      //
      // Real debris is numerous AND tiny -- the advil photos discard ~70% of
      // their blobs, which are imprint specks. Genuine pills are never the
      // minority of their own photo, so require the discards to outnumber the
      // survivors before believing them to be fragments.
      const dropped = blobList.length - solidList.length;
      const debrisDominates = dropped > solidList.length;
      const calList = (debrisDominates && solidList.length >= 3) ? solidList : blobList;
      if (calList.length !== blobList.length) {
        opts.debug?.({ stage: 'fragfilter', blobs: blobList.length, kept: calList.length, hiArea });
      }
      let unit = estimateUnitArea(calList.map((l) => blobAreas[l]));

      // FUSED-RAFT UNIT RESCUE. estimateUnitArea reads the median BLOB AREA,
      // which is the right answer only when most blobs are single pills. On a
      // photo that is one fully-fused raft there is exactly one blob, so the
      // "median pill" IS the whole raft and massR comes out 1.00: a 19-pill
      // hex raft was read as a single 120px pill and returned count=1.
      //
      // The autocorrelation scale above does not depend on the blob count — it
      // measures the repeating pitch in the photo — so when it disagrees with
      // the area-derived unit by more than 2x, believe the geometry. Guarded
      // to that gross disagreement so healthy photos, where the two already
      // agree, are untouched.
      if (opts.acScale !== false && radiusEst > 0) {
        const geomUnit = Math.PI * radiusEst * radiusEst;
        if (unit > geomUnit * 2) {
          opts.debug?.({ stage: 'raft-unit', from: Math.round(unit),
            to: Math.round(geomUnit), radiusEst: +radiusEst.toFixed(1),
            blobs: calList.length });
          unit = geomUnit;
        }
      }

      // Crease-cut pieces: unit recalibration AND panel method 3's evidence.
      const cutM = track(new cv.Mat());
      bw.copyTo(cutM);
      cutCreases(cv, src, cutM);
      const cutLab = track(new cv.Mat());
      cv.connectedComponents(cutM, cutLab);
      const cl = cutLab.data32S;
      const pieceStats = new Map(); // cut-label -> {area, sx, sy, blob}
      for (let i = 0; i < cl.length; i++) {
        if (!cl[i]) continue;
        let p = pieceStats.get(cl[i]);
        if (!p) { p = { area: 0, sx: 0, sy: 0, blob: bl[i] }; pieceStats.set(cl[i], p); }
        p.area++;
        p.sx += i % w;
        p.sy += (i / w) | 0;
      }
      const pieces = [...pieceStats.values()].filter((p) => p.area >= absFloor);
      const unit2 = estimateUnitArea(pieces.map((p) => p.area));
      const minPlausibleUnit = 0.6 * Math.PI * radiusEst * radiusEst;
      // A FLOOR WITHOUT A CEILING IS HALF A GUARD. The crease cut on a dense
      // raft yields a handful of huge merged fragments, and their median
      // becomes the "unit": measured on the adversarial dense case (120 pills
      // of R=13), 3 pieces produced a unit of 9317px against a geometric
      // 531px -- 17.5x too big -- so pixel mass read the whole 81264px board
      // as 8.72 units. The raft-unit rescue had already set 531 correctly two
      // stages earlier and this line silently undid it.
      //
      // radiusEst is the autocorrelation pitch, independent of the mask, so
      // it bounds both directions. Generous at 3x: an elongated caplet covers
      // more than a circle of its half-width, and the case this catches is an
      // order of magnitude out, not a borderline one.
      const maxPlausibleUnit2 = radiusEst > 0 ? 3 * Math.PI * radiusEst * radiusEst : Infinity;
      if (pieces.length >= blobList.length * 2 && unit2 >= Math.max(absFloor, minPlausibleUnit)) {
        if (unit2 <= maxPlausibleUnit2) unit = unit2;
        else opts.debug?.({ stage: 'unit2-refused', proposed: +unit2.toFixed(0),
          cap: +maxPlausibleUnit2.toFixed(0), pieces: pieces.length, kept: +unit.toFixed(0) });
      }
      const unitOk = unit >= absFloor;

      // -- Length calibration (on-edge-proof; see estimateUnitLength). --
      // Blob bounding boxes, needed for the second-moment axes below.
      const blobBox = new Map();
      for (let i = 0; i < bl.length; i++) {
        const l = bl[i];
        if (!l) continue;
        const x = i % w, y = (i / w) | 0;
        let b = blobBox.get(l);
        if (!b) { b = { x0: x, y0: y, x1: x, y1: y }; blobBox.set(l, b); }
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
      }
      const blobAxis = new Map();
      for (const l of blobList) {
        const b = blobBox.get(l);
        if (b) blobAxis.set(l, blobAxes(bl, w, l, b));
      }
      // -- SHAPE CLASSIFICATION (one medication => one shape) ---------------
      //
      // ONE MEDICATION PER PHOTO means every pill in this image is the same
      // shape AND size as every other. That is a far stronger prior than any
      // fixed shape catalogue: rather than asking "does this look like some
      // pill?", ask "does this look like the OTHER blobs in this very photo?".
      // Scale-free, so it is not fooled by illumination or camera distance.
      //
      // Measured separation on a clean board photo (r-295482c1, 19 pills):
      // real pills score residual 0.009-0.049, junk scores 0.482-0.900 —
      // roughly 100x, with no overlap. On paper-towel texture the junk runs
      // 1.2-1.6 (fill 0.26-0.40, solidity 0.40-0.51).
      //
      // Computed HERE, before the length/area calibration, because the
      // template is the only estimator in this function that survives a photo
      // where junk outnumbers pills — and the calibration below needs that.
      const blobShape = new Map();
      for (const l of blobList) {
        const b = blobBox.get(l);
        const ax = blobAxis.get(l);
        if (!b || !ax) continue;
        const s = shapeOf(bl, w, l, b, blobAreas[l], ax);
        if (s) blobShape.set(l, s);
      }

      // ROBUST TEMPLATE ESTIMATION. The template must survive a population in
      // which junk OUTNUMBERS pills (the paper-towel case is 37 blobs for 14
      // pills). A plain median over all blobs is then a median of junk, and a
      // filter built on it drops nothing — measured: a naive width-only rule
      // (minor < 0.55*template_minor) removed ZERO junk there.
      //
      // So seed from the MOST CONVEX blobs (solidity >= 0.93 — the measured
      // floor for real pills, which no texture fragment reaches), then
      // re-estimate once over everything the seed accepts, so the template is
      // not biased by whichever convex blobs happened to be seeds. When too
      // few convex blobs exist to form a median there is no template and every
      // shape-derived rule below is skipped.
      const shapeVals = [...blobShape.values()];
      let template = null;
      if (shapeVals.length >= 6) {
        let seed = shapeVals.filter((s) => s.solidity >= 0.93);
        if (seed.length < 3) seed = shapeVals.filter((s) => s.solidity >= 0.88);
        if (seed.length >= 3) {
          const mk = (pool) => ({
            residual: median(pool.map((s) => s.residual)),
            solidity: median(pool.map((s) => s.solidity)),
            fill: median(pool.map((s) => s.fill)),
            aspect: median(pool.map((s) => s.aspect)),
            primitive: (() => {
              const t = new Map();
              for (const s of pool) t.set(s.primitive, (t.get(s.primitive) || 0) + 1);
              let bp = null, bn = 0;
              for (const [p, n] of t) if (n > bn) { bn = n; bp = p; }
              return bp;
            })(),
          });
          template = mk(seed);
          const near = shapeVals.filter((s) =>
            s.solidity >= 0.90 && Math.abs(s.fill - template.fill) <= 0.12);
          if (near.length >= 3) template = mk(near);
        }
      }

      // SHAPE-DERIVED SCALE. How big is ONE pill, measured only over blobs the
      // template vouches for. The template pool is selected by CONVEXITY,
      // which texture fragments cannot fake, so these medians are the honest
      // single-pill scale even when junk dominates by count.
      const tplPool = template
        ? [...blobShape.entries()].filter(([, s]) => s.solidity >= 0.90
            && Math.abs(s.fill - template.fill) <= 0.12) : [];
      const tplMajor = tplPool.length ? median(tplPool.map(([, s]) => s.major)) : 0;
      const tplArea = tplPool.length ? median(tplPool.map(([, s]) => s.area)) : 0;
      // Half-thickness of one pill, from the same convex population. Used to
      // tell a multi-pill clump (pill-thick along its whole length) from a
      // sprawling texture fragment (thin however far it runs).
      const tplPeak = tplPool.length ? median(tplPool.map(([l]) => peaks[l] || 0)) : 0;

      // Calibrated on calList for the same reason as the area unit: imprint
      // and highlight fragments are short as well as small, so leaving them
      // in collapses unitLen too (21.7 vs a true ~100 on the advil photos).
      let unitLen = estimateUnitLength(calList.map((l) => (blobAxis.get(l) || {}).major || 0).filter((m) => m > 0));

      // SHAPE-VOUCHED LENGTH OVERRIDE.
      // estimateUnitLength takes the median of the SHORT HALF of blob lengths,
      // which is correct when the short blobs are single pills and the long
      // ones are clumps. On a textured surface it is exactly backwards: the
      // short half is weave nubs and the pills are the long half. Measured on
      // t2-ironyl-capsules-papertowel-2 — unitLen came out 34 px against real
      // capsules of ~92 px, and the same contamination then drove unitfix to a
      // unit of 242 against a true ~2570, an 11x collapse that inflated the
      // count to 72 for 14 pills.
      //
      // The shape template is immune to that inversion because it selects on
      // convexity rather than size, so when it disagrees materially with the
      // length estimator, believe the template. Guarded to fire only when the
      // template rests on a real population (>=5 vouched blobs) and only when
      // the disagreement is large (>1.4x), so on clean photos — where the two
      // agree within a few percent — this is a no-op.
      //
      // TWO GUARDS, both needed. The override may only RAISE unitLen, and only
      // when the blobs it is overruling really are sub-pill debris.
      //
      // Raising only, because the template pool can itself contain clumps: two
      // touching tablets are convex enough to be vouched for, and on a dense
      // photo they drag tplMajor up. Measured on
      // synth2-rc-gradient-small-n60-t65-s171 (60 small tablets, heavy
      // touching) the override doubled unitLen from 31.3 to 61.1 and cost 11
      // pills. Requiring the DISPLACED population to be sub-pill in area is
      // what distinguishes the two cases: on the paper-towel photo the short
      // blobs are weave nubs at ~5% of a pill's area, while on the dense
      // synthetic they are real tablets at full area.
      //
      // THE ON-EDGE HOLE IN BOTH GUARDS. As written above, the two thresholds
      // (1.4x disagreement, displaced blobs under 0.35x area) describe only
      // ONE way unitLen collapses: sub-pill DEBRIS in the short half. There is
      // a second way, and the corpus contains it. When a specular photo shreds
      // the mask, a large share of real beads read as ON-EDGE — full length,
      // but only ~2/3 the flat area, the ratio this file already documents in
      // five other places (lines 2599, 2978, 3215: "an on-edge pill keeps ~2/3
      // of the flat area"). Those beads are real pills, so the area guard
      // rightly refuses to call them debris — but they still drag unitLen down,
      // and nothing else catches it.
      //
      // Measured on s-0bfc44d8 (34 beads, one medication). The template pool is
      // HEALTHY here — 31 of 43 blobs vouched, tplMajor 69.9 against a true
      // bead major of ~83 — so the premise that the pool collapses on ragged
      // boundaries does not hold; solidity survives the shredding (31 blobs
      // score >=0.90, eleven of them at 1.000). What fails is downstream:
      //   unitLen  53.0   tplMajor 69.9   ratio 1.32  -> under the 1.4 trigger
      //   displaced blobs: median area 1080 vs tplArea 1624 = 0.665x
      // The ratio misses the trigger by 6%, and 0.665 is nowhere near 0.35, so
      // BOTH guards refuse and unitLen stays collapsed. That collapse is what
      // over-splits in lloyd: 39 counted for 34 true, all 8 spurious from it.
      //
      // So the area guard needs a SECOND arm, not a looser bar. 0.35 keeps its
      // original meaning (sub-pill debris); the new arm admits the on-edge
      // band, which is bounded ABOVE as well as below — an on-edge pill loses
      // area, a full-size tablet does not. The upper bound is what preserves
      // the dense-synthetic case the original guard was written for:
      //   s-0bfc44d8 (fix wanted)          0.665x  -> inside  [0.50, 0.80]
      //   s-eb90778f (fix must not fire)   0.983x  -> outside, full-size pills
      // Verified by forcing the override unconditionally: it corrects
      // s-0bfc44d8 (39->33, spurious 8->2) and breaks the dense synthetic
      // (60->50), which is exactly the pair this band must separate.
      //
      // TWO MORE CONDITIONS, both measured over the whole 251-image corpus by
      // logging this decision on every image. The area band ALONE is not
      // enough: five images fall inside it, and two are the touching-tablet
      // synthetics the original guard exists to protect.
      //
      //   synth2-rc-gradient-small-n60-t65-s171  R 0.508  lenR 1.951  shortN 7
      //   synth2-rc-kraft-small-n12-t65-s259     R 0.739  lenR 1.529  shortN 4
      //   synth2-rc-kraft-small-n60-t65-s261     R 0.665  lenR 0.997  shortN 4
      //   t2-beige-round-cluster-black-1         R 0.570  lenR 1.249  shortN 19
      //   t2-beige-round-cluster-black-2         R 0.613  lenR 1.293  shortN 27
      //   s-0bfc44d8 (the target)                R 0.665  lenR 1.320  shortN 20
      //
      // lenR < 1.4 — the collapse must be MILD. A 1.95x disagreement is the
      // clump signature the 1.4 bar was built to catch: the pool itself holds
      // touching pairs and tplMajor is measuring two tablets, not one. An
      // on-edge collapse cannot be that large, because on-edge pills KEEP
      // their length; only the short half of the distribution sags.
      //
      // shortN >= 10 — the displaced set must be a POPULATION, not a handful.
      // This is the same "one medication per photo" invariant the splotch
      // population guard rests on: 20 of 43 blobs reading on-edge is a real
      // subpopulation; 4 of them is a coincidence of a few touching tablets.
      //
      // Together these admit only the two t2-beige images besides the target,
      // and neither moves (verified: both gates clean).
      //
      // The trigger widens to 1.25 for the same reason — 1.4 was calibrated on
      // the debris case, where the collapse is 2-3x. An on-edge collapse is
      // milder by construction, so it lands just under the old bar at 1.32.
      const shortAreasAll = blobList
        .filter((l) => ((blobAxis.get(l) || {}).major || 0) > 0
          && (blobAxis.get(l).major) <= 1.35 * unitLen)
        .map((l) => blobAreas[l]);
      const displacedR = shortAreasAll.length >= 3 && tplArea > 0
        ? median(shortAreasAll) / tplArea : null;
      const onEdgeBand = displacedR !== null
        && displacedR >= 0.50 && displacedR <= 0.80
        && shortAreasAll.length >= 10
        && unitLen > 0 && tplMajor < 1.4 * unitLen;
      if (tplMajor > 0 && tplPool.length >= 5
        && (unitLen <= 0 || tplMajor > (onEdgeBand ? 1.25 : 1.4) * unitLen)) {
        const shortAreas = shortAreasAll;
        const shortAreMinor = shortAreas.length >= 3
          && tplArea > 0 && median(shortAreas) < 0.35 * tplArea;
        if (unitLen <= 0 || shortAreMinor || onEdgeBand) {
          opts.debug?.({ stage: 'shapelen', from: +unitLen.toFixed(1), to: +tplMajor.toFixed(1), vouched: tplPool.length });
          unitLen = tplMajor;
        }
      }
      // Unit WIDTH, from blobs length says are single pills. Length alone
      // cannot bound a SIDE-BY-SIDE pair (two pills abreast are wide, not
      // long), so the width of a known-single pill is needed to recognise
      // one. Taken from length-confirmed singles so pairs cannot inflate it.
      const unitMinor = (() => {
        if (!(unitLen > 0)) return 0;
        const ms = blobList
          .map((l) => blobAxis.get(l) || {})
          .filter((ax) => ax.major > 0 && ax.major <= 1.35 * unitLen && ax.minor > 0)
          .map((ax) => ax.minor);
        return ms.length >= 3 ? median(ms) : 0;
      })();

      // LENGTH-GATED UNIT RECALIBRATION.
      // estimateUnitArea assumes clusters land on integer multiples of the
      // unit, so its refinement passes can divide a clump's area by the wrong
      // integer and settle on an inflated "unit". Measured on the real corpus:
      // on r-cc7a2ada the unit came out 1.31x too big (1109 vs 849 px) and on
      // r-90dbe20e 160x too big, which deflates every mass ratio in the image
      // — a 6-pill clump read as massR 4.05 and was counted 3 short.
      //
      // Length is the honest arbiter (see estimateUnitLength): a blob no
      // longer than ~1 pill IS one pill, whatever its area does. So calibrate
      // the unit from the AREAS OF LENGTH-CONFIRMED SINGLES only. Clumps are
      // excluded by construction, so no integer-multiple guessing is needed.
      // Applied only when enough singles exist to form a stable median, and
      // only when it disagrees materially (>15%) with the incumbent — on 20 of
      // 22 real photos the two agree within 2% and this is a no-op.
      if (unitLen > 0) {
        // SUB-PILL FRAGMENT GUARD.
        // The "singles" pool is selected by length, so when length itself is
        // contaminated the pool fills with debris and the median collapses.
        // Glossy tablets are the pathological case: printed text and specular
        // highlights punch interior holes that survive as tiny blobs.
        // Measured on t2-advil-scatter-dark-1 -- 44 blobs, of which ~30 are
        // imprint fragments of 106..524 px against real tablets of ~8500 px.
        // Those 22 fragments outvoted the tablets and drove unitfix to a unit
        // of 226 (37x too small), after which every real tablet read as ~38
        // pills and the photo counted 283 vs 28.
        //
        // ONE MEDICATION PER PHOTO means every pill is the same size, so a
        // blob a small fraction of the biggest coherent blobs is not a pill.
        // Anchor on a HIGH percentile of blob area (robust to the debris that
        // dominates by count but not by size) and drop anything below a third
        // of it. An on-edge pill keeps ~2/3 of the flat area, comfortably
        // above the 0.33 cut, so the exception the owner called out survives.
        // Same debris-only condition as the calibration filter above: when
        // the small blobs are NOT the dominant population they are pills, not
        // fragments, and excluding them would bias the unit upward.
        const fragFloor = (debrisDominates && hiArea > 0) ? 0.33 * hiArea : 0;
        const singleAreas = blobList
          .filter((l) => {
            const m = (blobAxis.get(l) || {}).major || 0;
            return m > 0 && m <= 1.35 * unitLen && blobAreas[l] >= fragFloor;
          })
          .map((l) => blobAreas[l]);
        if (singleAreas.length >= 5) {
          const unitSingle = median(singleAreas);
          // SHAPE VETO ON THE UNIT FIX. The "singles" pool is selected by
          // length and area floor only, so on a textured surface it fills with
          // weave nubs and the median collapses. Measured on
          // t2-ironyl-capsules-papertowel-2: unitfix overwrote a CORRECT unit
          // of 2043 with 242 (11x too small), and the count went to 72 for 14
          // pills. The shape template is the independent witness — it is
          // selected by convexity, not size, so junk cannot vote in it. Refuse
          // any unit fix that contradicts the vouched pill area by more than
          // 2x. On clean photos the two agree closely and this never fires.
          const contradicted = tplArea > 0 && tplPool.length >= 5
            && (unitSingle < 0.5 * tplArea || unitSingle > 2 * tplArea);
          if (contradicted) {
            opts.debug?.({ stage: 'unitfix-veto', proposed: unitSingle, tplArea, unit });
          } else if (unitSingle >= absFloor && Math.abs(unitSingle - unit) > 0.15 * unitSingle) {
            opts.debug?.({ stage: 'unitfix', from: unit, to: unitSingle, singles: singleAreas.length });
            unit = unitSingle;
          }
        }
      }

      // ALL-CLUMPS UNIT RESCUE.
      //
      // Every calibration above learns the unit from whole BLOBS, so all of
      // them assume at least a few blobs are single pills. When a photo has
      // pills in separated GROUPS that each touch internally, that assumption
      // fails completely: there is no isolated specimen to learn from, the
      // "unit" is measured on a 2-pill clump, and every mass ratio downstream
      // is halved. Measured on the user-reported c-2448027d (19 caplets in six
      // touching groups): 7 blobs for 19 pills, unit 1626 against a true 924
      // (1.76x), and the photo counted 10.
      //
      // The distance transform's RIDGE is the way out. A pixel that is a
      // strict local maximum of the distance transform sits on the medial axis,
      // and its depth there is HALF THE PILL'S WIDTH — a property of one pill
      // that no amount of side-by-side touching changes, because each pill in a
      // clump keeps its own ridge crest. The median crest depth is therefore a
      // single-pill measurement taken from a photo with no single pills in it.
      //
      // Measured across the 24 hand-annotated photos, a pill's true area
      // tracks the square of that half-width closely: area / pk^2 runs 6.7-13.8
      // with a median of 8.8, a 2.1x spread across pills from 7.4px to 85.7px
      // half-width. That is far tighter than the 3.0x spread that caps the
      // mass-division family (docs/splitting-bakeoff.md), because it is a
      // shape constant rather than a per-photo scale.
      //
      // DETECTOR, NOT ESTIMATOR. This must never touch a photo whose unit is
      // already right, so it fires only on a hard contradiction: the incumbent
      // unit claiming more than 2.4x the area that the ridge width says one
      // pill can cover. Measured across all 24 annotated photos, that ratio is
      // 1.41-2.01 on the 22 photos whose unit is within 30% of truth, and
      // 2.78-3.07 on exactly the three whose unit is clump-inflated. No photo
      // that currently counts correctly is touched.
      let ridgePk = 0;
      let clumpUnitFired = false;
      if (unit > 0 && blobList.length >= 3) {
        // Ridge crest depths over the whole mask. `dd` is the distance
        // transform already computed for the watershed; `bl` labels the blobs.
        const crests = [];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!bl[i]) continue;
            const dv = dd[i];
            if (dv < 3) continue;
            let isMax = true;
            for (let ky = -1; ky <= 1 && isMax; ky++) {
              for (let kx = -1; kx <= 1; kx++) {
                if (!kx && !ky) continue;
                if (dd[i + ky * w + kx] > dv) { isMax = false; break; }
              }
            }
            if (isMax) crests.push(dv);
          }
        }
        if (crests.length >= 8) {
          const pk = median(crests);
          ridgePk = pk;
          // Thickness -> area, SHAPE-AWARE. For a stadium of aspect a and
          // half-width r, area = r^2 * (4a - 4 + pi): aspect 2.4 gives 8.74,
          // which is why the old fixed 8.8 (measured on the caplet corpus)
          // worked there -- it was the capsule value of this formula. A
          // CIRCLE is a = 1 -> pi, 2.8x smaller. Using the capsule constant
          // on round pills under-sized the unit ~40%, pushed impliedPerBlob
          // over the 2.5 gate, and fired this rescue on healthy images
          // (measured: synth t65 round pills, unit 664 -> 360, which then
          // starved the mass vote and shipped flush pairs as singles).
          //
          // Half-width comes from radiusEst (median of per-blob DT peaks),
          // not the crest median: a capsule's spine crest IS its half-width,
          // but a circle has no spine -- its crest sample is mostly junction
          // ridges and noise (measured 6.4 vs a true half-width of 14.6).
          // Both measures are contact-independent, which is the whole point:
          // flush contact cannot change interior thickness.
          const halfW = radiusEst >= MIN_PEAK ? radiusEst : pk;
          const aspectEst = unitLen > 0 && halfW > 0 ? unitLen / (2 * halfW) : 2.4;
          const shapeK = Math.min(14, Math.max(Math.PI, 4 * aspectEst - 4 + Math.PI));
          const rescued = shapeK * halfW * halfW;
          // HOW MANY PILLS DOES THE AVERAGE BLOB HOLD? Total foreground divided
          // by (blob count x one pill's ridge-derived area). This is the
          // discriminator, and it must be measured this way rather than by any
          // per-blob shape test.
          //
          // Measured: photos whose unit is clump-inflated sit at 2.95-3.52
          // implied pills per blob (c-2448027d 3.52, lined-503b3041 3.20,
          // lined-bfdbfef9 2.95). Every photo that currently counts correctly,
          // AND every dense synthetic in the manifest, sits at 1.13-1.97
          // (r-295482c1 1.13, r-dbe1f2d8 1.21, synthetic-wood-mixed-35 1.97).
          //
          // The dense synthetics are the reason a shape-based test will not do:
          // synthetic-blur-20 and synthetic-noise-25 have plenty of merged
          // blobs and a LOW fraction of single-looking ones (0.29-0.50, the
          // same range as c-2448027d), yet their unit is already correct.
          // Nothing local to a blob separates them; only the image-wide ratio
          // of material to blobs does.
          let fgTotal = 0;
          for (const l of blobList) fgTotal += blobAreas[l];
          const impliedPerBlob = rescued > 0 && blobList.length
            ? fgTotal / (blobList.length * rescued) : 0;
          if (rescued >= absFloor && impliedPerBlob >= 2.5 && unit > 1.3 * rescued) {
            opts.debug?.({ stage: 'clumpunit', from: unit, to: +rescued.toFixed(0),
              pk: +pk.toFixed(1), impliedPerBlob: +impliedPerBlob.toFixed(2),
              blobs: blobList.length });
            unit = rescued;
            clumpUnitFired = true;
          }
        }
      }

      opts.debug?.({ stage: 'lengthcal', unitLen, unit });
      if (opts.debug) {
        for (const l of blobList) {
          const ax = blobAxis.get(l) || {};
          // Ship the bounding box too: only the two blobs that reach the
          // seam router emitted one, so any tool cropping per blob had to
          // fall back to the whole frame -- which silently showed the WRONG
          // region rather than nothing (the method arena cropped bare
          // countertop and labelled it a disputed clump).
          const bb = blobBox.get(l);
          opts.debug({ stage: 'blobgeo', blob: l, area: blobAreas[l],
            box: bb ? { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 } : null,
            massR: +(blobAreas[l] / Math.max(1, unit)).toFixed(2),
            major: +(ax.major || 0).toFixed(1), minor: +(ax.minor || 0).toFixed(1),
            lenR: +((ax.major || 0) / Math.max(1, unitLen)).toFixed(2),
            peak: +peaks[l].toFixed(1), radiusEst: +radiusEst.toFixed(1) });
        }
      }

      // -- Map watershed regions to blobs (majority pixel vote). --
      const labelBlob = new Map();
      {
        const votes = new Map(); // ws-label -> Map(blob -> px)
        for (let i = 0; i < md.length; i++) {
          if (md[i] <= 1 || !bl[i]) continue;
          let m = votes.get(md[i]);
          if (!m) { m = new Map(); votes.set(md[i], m); }
          m.set(bl[i], (m.get(bl[i]) || 0) + 1);
        }
        for (const [L, m] of votes) {
          let bb = 0, bn = 0;
          for (const [b, n] of m) if (n > bn) { bn = n; bb = b; }
          labelBlob.set(L, bb);
        }
      }
      const regByBlob = new Map();
      for (const r of regions) {
        const b = labelBlob.get(r.label) || 0;
        if (!regByBlob.has(b)) regByBlob.set(b, []);
        regByBlob.get(b).push(r);
      }

      // -- Length-anchored junk veto (surface splotches). --
      // The major axis is the one dimension a pill cannot lose: tipping a
      // caplet onto its narrow side collapses the MINOR axis (and ~3x of the
      // area) but preserves LENGTH. So the discriminator is asymmetric:
      //   - short in the major axis AND unremarkable in the minor  -> junk
      //   - full length, thin minor axis                           -> ON-EDGE
      // Measured here: every real pill sits at lenR 0.90-1.10 even when its
      // area ratio drops to 0.6; the board splotch is lenR 0.66. Requiring a
      // sub-unit AREA as well keeps this from ever touching a real pill that
      // is merely foreshortened, and needing several length-confirmed pills
      // present means a photo of one odd object can't self-veto.
      if (unitLen > 0 && blobList.length >= 6) {
        const confirmed = blobList.filter((l) => {
          const m = (blobAxis.get(l) || {}).major || 0;
          return m >= 0.85 * unitLen;
        }).length;
        if (confirmed >= 5) {
          // Per-blob mean brightness. Geometry alone cannot reject every
          // splotch: the worst one measured here is a bare-board patch at 2x
          // the unit area and full pill length, so no size or axis test can
          // see it. What it cannot fake is BEING A PILL'S COLOR — the pills
          // are markedly brighter than the board. Comparing each blob to the
          // population's own brightness keeps this illumination-independent.
          const blobLum = new Map();
          {
            const sd = src.data, ch = src.channels();
            const sum = new Map();
            for (let i = 0; i < bl.length; i++) {
              const l = bl[i];
              if (!l) continue;
              const o = i * ch;
              const v = (sd[o] + sd[o + 1] + sd[o + 2]) / 3;
              let s = sum.get(l);
              if (!s) { s = { v: 0, n: 0 }; sum.set(l, s); }
              s.v += v; s.n++;
            }
            for (const [l, s] of sum) blobLum.set(l, s.v / Math.max(1, s.n));
          }
          const lums = blobList.map((l) => blobLum.get(l) || 0).filter((v) => v > 0);
          const medLum = median(lums);

          const junk = new Set();
          for (const l of blobList) {
            const ax = blobAxis.get(l) || {};
            const maj = ax.major || 0, min = ax.minor || 0;
            if (!maj) continue;
            // (a) Small in BOTH axes. Length alone cannot carry this test: a
            // real pill seen at a steep angle foreshortens to ~0.76 of the
            // median length while a splotch measured 0.66 — too narrow a gap.
            // What separates them is that the foreshortened pill stays
            // ELONGATED, whereas the splotch is stubby in both directions.
            const shortAxis = maj < 0.80 * unitLen;
            const stubby = min > 0 && maj / min < 1.6;
            const lightMass = unitOk && blobAreas[l] < 0.8 * unit;
            if (shortAxis && stubby && lightMass) { junk.add(l); continue; }
            // (b) Too dark to be one of these pills. Pills of one medication
            // share a color; a blob well below the population's own median
            // brightness is surface, not product. The margin is wide (0.82)
            // so shadowed or dulled pills are never touched.
            if (medLum > 0 && (blobLum.get(l) || 0) < 0.70 * medLum) junk.add(l);
          }
          if (junk.size) {
            const before = regions.length;
            regions = regions.filter((r) => {
              const b = labelBlob.get(r.label) || 0;
              if (!junk.has(b)) return true;
              count -= r.units;
              return false;
            });
            opts.debug?.({ stage: 'lenjunk', removed: before - regions.length, unitLen });
            for (const l of junk) regByBlob.delete(l);
          }
        }
      }

      // -- SHAPE-CONSISTENCY JUNK VETO -------------------------------------
      //
      // The template and its scale were computed above, before calibration, so
      // that unitfix could be guarded by them. Here they are used for what they
      // were designed for: deciding which blobs are not pills at all.
      //
      // THE CLUMP RULE. A multi-pill clump legitimately has non-pill shape —
      // two touching caplets are a peanut, not a capsule. Rejecting clumps for
      // "not looking like one pill" is catastrophic: measured, it zeroed
      // lined-69204ff4 (19 pills in one merged mass -> 0) and froze
      // t2-advil-scatter-dark-1 at 5 of 28. So a blob that could be a clump is
      // NEVER vetoed here; it is left for the mass/watershed/erosion splitting
      // logic below.
      //
      // ON-EDGE PILLS. An oblong pill resting on its narrow side keeps its
      // MAJOR axis, loses minor axis and ~1/3 of its area, and stays a clean
      // convex primitive (it is still a capsule, just a thinner one). It is
      // therefore protected explicitly by major-axis agreement, and the
      // template deviation below is measured on shape descriptors that survive
      // the tip (primitive + residual), never on minor axis or area alone.
      if (opts.debug) {
        for (const l of blobList) {
          const s = blobShape.get(l);
          if (!s) continue;
          opts.debug({ stage: 'shape', blob: l, primitive: s.primitive,
            residual: +s.residual.toFixed(3), solidity: +s.solidity.toFixed(3),
            fill: +s.fill.toFixed(3), aspect: +s.aspect.toFixed(2),
            area: s.area, lenR: unitLen > 0 ? +(s.major / unitLen).toFixed(2) : null,
            areaR: tplArea > 0 ? +(s.area / tplArea).toFixed(2) : null,
            tplFill: template ? +template.fill.toFixed(3) : null,
            tplPrimitive: template ? template.primitive : null,
            // Plain-language verdict for the debug sheet: what this blob is,
            // according to shape alone.
            verdict: !template ? 'no-template'
              : (tplArea > 0 && s.area > 1.30 * tplArea) ? 'clump'
              // Full length but markedly narrower than the template: the pill
              // is resting on its narrow side.
              : (tplMajor > 0 && s.major >= 0.85 * tplMajor
                 && s.aspect > 1.35 * template.aspect) ? 'on-edge'
              : (s.residual <= Math.max(0.30, 4 * template.residual + 0.12)) ? 'single'
              : 'off-shape' });
        }
      }

      if (template && tplMajor > 0 && tplArea > 0) {
        const shapeJunk = new Set();
        for (const l of blobList) {
          const s = blobShape.get(l);
          if (!s) continue;
          // CLUMP IMMUNITY. Anything that could hold more than one pill is out
          // of scope for this veto — its shape is allowed to be arbitrary.
          // Measured against the SHAPE template's own scale, not the global
          // unit, for the reason documented above.
          const bigByLength = s.major > 1.30 * tplMajor;
          const bigByArea = s.area > 1.30 * tplArea;
          // Near-integer multiple of the unit area is the classic clump
          // signature, and it holds even for a clump that is short and fat.
          const mult = s.area / tplArea;
          const integerish = mult >= 1.5 && Math.abs(mult - Math.round(mult)) <= 0.35;
          // ...but a clump is made of PILL-WIDTH MATERIAL. A sprawling texture
          // fragment is also "big", and waving it through on size alone is
          // exactly how the paper-towel photo kept its 37 junk blobs.
          //
          // LOCAL WIDTH is the first of the two tests that make this call. The
          // distance transform's peak is the blob's half-thickness at its
          // fattest point. A clump of pills is as thick as one pill everywhere
          // along it, so its peak matches the template population's peak; a
          // weave filament or grain streak is thin however far it sprawls.
          //
          // The threshold has to clear an ON-EDGE pill, whose half-width is
          // genuinely reduced — a pair of on-edge caplets end to end is a real
          // clump made of thin material. Measured on
          // synth2-cw-kraft-normal-n20-t25-s303, blob 3 is exactly that pair
          // and reads 0.44 of the template peak; a 0.70 threshold rejected it
          // and cost a pill. 0.40 clears on-edge pills while a weave filament,
          // which is a small fraction of a pill's width, stays out.
          const thickEnough = tplPeak > 0 ? peaks[l] >= 0.40 * tplPeak : true;
          // ELONGATION is the second bound. A pile of N identical pills is
          // COMPACT: however they are dropped they land in a heap, not a
          // queue, because each pill is only ~2.5 long. Measured aspect of
          // genuine multi-pill masses across the corpus is 1.42-4.2, including
          // the single 14-pill mass on lined-69204ff4 at 1.49. The weave
          // smears that pass the thickness test measure 17.8 and 22.3 — they
          // run the width of the frame, and were being divided by area into 20
          // and 30 "pills", 50 of that photo's 56.
          //
          // The ceiling scales with how many pills the blob could hold, so a
          // genuine queue laid end to end is still admitted, but it is capped:
          // no arrangement of one medication reaches six pill-aspects of
          // elongation, whereas a smear does.
          //
          // SOLIDITY IS DELIBERATELY NOT USED AS A CLUMP GATE. It looks
          // tempting (smears measure 0.43-0.63) but it is not safe: the more
          // pills a mass holds, the more notches it has. Genuine 2-4 pill
          // clumps on the real corpus score 0.62-0.77 (r-681ce773 blob 2 at
          // 0.62, r-cc7a2ada blob 5 at 0.66, r-295482c1 blob 12 at 0.69) and
          // lined-69204ff4's 14-pill mass scores 0.57 — squarely inside the
          // range texture fragments occupy. A 0.80 floor dropped the real
          // corpus from 19 to 11; a 0.58 floor cut lined-69204ff4 from 14 to
          // 5. Fill fares no better: the smears measure 0.64-0.66 and a
          // genuine 2-pill chain measures 0.657. Thickness and elongation are
          // the only two that separate without casualties.
          //
          // nMax takes whichever dimension claims more pills, because area
          // alone under-counts: an ON-EDGE pill contributes full length but
          // only ~2/3 of the flat area. Measured on
          // synth2-cw-kraft-normal-n20-t25-s303, blob 3 spans 1.9 pill-lengths
          // at 0.94 of ONE pill area — a pair lying on edge end to end. An
          // area-only nMax called it 1, denied it immunity, and cost a pill.
          const nMax = Math.max(2,
            Math.ceil(s.area / Math.max(1, tplArea)),
            Math.ceil(s.major / Math.max(1, tplMajor)));
          const chainAspect = Math.min(6 * Math.max(1, template.aspect),
            Math.max(4.5, nMax * Math.max(1, template.aspect)));
          const chainable = s.aspect <= 4.5 || s.aspect <= chainAspect;
          const couldBeClump = (bigByLength || bigByArea || integerish) && thickEnough && chainable;
          if (couldBeClump) continue;

          // ON-EDGE PROTECTION. Same length as the population, convex, and a
          // legitimate primitive => an oblong pill on its narrow side. Its
          // minor axis and area are ALLOWED to collapse; nothing below may
          // reject it. Measured on-edge pills keep 0.85-1.10 of unit length.
          const onEdge = s.major >= 0.85 * tplMajor && s.solidity >= 0.90 && s.residual <= 0.20;
          if (onEdge) continue;

          // Deviation from the photo's OWN consensus template. Two independent
          // arms, both scale-free:
          //   (a) absolute shape quality — fits no convex primitive at all,
          //   (b) disagreement with the template's fill/solidity.
          const badPrimitive = s.residual > Math.max(0.30, 4 * template.residual + 0.12);
          const nonConvex = s.solidity < 0.82 && s.solidity < 0.88 * template.solidity;
          const offTemplate = Math.abs(s.fill - template.fill) > 0.22;
          // (c) WRONG SIZE for this medication. One medication per photo means
          // one SIZE too, and unlike shape, size has no on-edge exception in
          // the major axis — tipping a pill preserves its length. A blob at a
          // fraction of the template's length is a speck, however tidy its own
          // little shape is. This is the arm that removes imprint fragments
          // and weave nubs that happen to be convex: measured on the
          // paper-towel photo, 8 such blobs at area 136-350 against a template
          // area of ~2600, each with solidity 0.94-1.00 and residual < 0.05.
          // Both axes must be short, so a genuine on-edge pill (full length,
          // thin) can never satisfy it.
          const speck = s.major < 0.60 * tplMajor && s.area < 0.35 * tplArea;
          if (badPrimitive || nonConvex || speck || (offTemplate && s.solidity < 0.90)) {
            shapeJunk.add(l);
            opts.debug?.({ stage: 'shapewhy', blob: l, badPrimitive, nonConvex, speck,
              offTemplate, area: s.area, tplArea, major: +s.major.toFixed(1), tplMajor: +tplMajor.toFixed(1),
              solidity: +s.solidity.toFixed(3), residual: +s.residual.toFixed(3) });
          }
        }
        if (shapeJunk.size) {
          const before = regions.length;
          regions = regions.filter((r) => {
            const b = labelBlob.get(r.label) || 0;
            if (!shapeJunk.has(b)) return true;
            count -= r.units;
            return false;
          });
          opts.debug?.({ stage: 'shapejunk', removed: before - regions.length,
            blobs: blobList.length, tplFill: +template.fill.toFixed(3),
            tplPrimitive: template.primitive, tplResidual: +template.residual.toFixed(3) });
          for (const l of shapeJunk) regByBlob.delete(l);
        }
      }

      // QUOTIENT RECALIBRATION. The baseline's oversized-region fallback
      // (units = round(area/med)) divides by the median WATERSHED-REGION
      // area, which on soft-edged photos is systematically smaller than one
      // pill's mask area: the watershed erodes a free-standing single's rim
      // (the unknown band floods to background), while a clump interior
      // keeps nearly full per-pill area (only thin seam lines are lost).
      // Measured on t3-white-round-yellow-2: ws-region singles median 1474
      // vs certified unit 2005.5 (mask singles 1930-2060) — a 1.36x quotient
      // inflation that read the 40-pill raft as 48 (its 35719px core region:
      // /1474 -> 24 units, /2005.5 -> 18; whole-blob re-quote 48 -> 40, the
      // audited truth, with blob mass 39.22 corroborating).
      //
      // TWO GUARDS, both measured:
      //   REDUCE-ONLY — raising is massoverride's job and stays behind its
      //   capacity guard; a raise here could only come from a collapsed
      //   unit (the unitfix failure family), exactly when this must stay
      //   silent.
      //   MASS-CORROBORATED, per blob — the re-quote is accepted only when
      //   the blob's new units sum lands ON the blob's own pixel mass
      //   (within rounding slack) AND strictly closer to it than the old
      //   sum. Region areas are watershed-eroded, so on photos where the
      //   erosion is heavy (or the unit itself is clump-corrupted) the
      //   re-quote undershoots mass and must be refused: an unguarded
      //   region-level re-quote measured salmon-pentagon 81 -> 17 (want
      //   90) and lined-69204ff4 21 -> 17 (want 20) — the guard keeps
      //   those at their current counts while yellow-2's raft (sumNew 40
      //   vs mass 39.22, diff 0.78 within slack 1.18) passes.
      if (unitOk) {
        for (const [bq, regsQ] of regByBlob) {
          if (!bq || !regsQ || !regsQ.length) continue;
          if (!regsQ.some((r) => (r.units || 1) > 1 && r.area > 0)) continue;
          const sumOld = regsQ.reduce((t, r) => t + (r.units || 1), 0);
          const sumNew = regsQ.reduce((t, r) => t + ((r.units || 1) > 1 && r.area > 0
            ? Math.min(r.units, Math.max(1, Math.round(r.area / unit)))
            : (r.units || 1)), 0);
          if (sumNew >= sumOld) continue; // reduce-only
          const massQ = blobAreas[bq] / unit;
          const slack = Math.max(0.75, 0.03 * massQ);
          if (Math.abs(sumNew - massQ) > slack
            || Math.abs(sumNew - massQ) >= Math.abs(sumOld - massQ)) continue;
          for (const r of regsQ) {
            if ((r.units || 1) <= 1 || !(r.area > 0)) continue;
            const uCal = Math.min(r.units, Math.max(1, Math.round(r.area / unit)));
            if (uCal < r.units) {
              opts.debug?.({ stage: 'quotcal', blob: bq, label: r.label,
                area: r.area, from: r.units, to: uCal, unit: +unit.toFixed(1),
                mass: +massQ.toFixed(2) });
              count += uCal - r.units;
              r.units = uCal;
            }
          }
        }
      }

      // -- Ambiguity test per blob (cheap; most blobs are CLEAR). --
      const ambiguous = [];
      let eligible = 0;
      for (const l of blobList) {
        const regs = regByBlob.get(l);
        if (!regs || !regs.length) continue; // baseline counted nothing here; keep that
        eligible++;
        const mass = unitOk ? blobAreas[l] / unit : 0;
        const k0 = Math.round(mass);
        const wsCount = regs.length;
        const unitsSum = regs.reduce((a, r) => a + r.units, 0);
        const pillThick = peaks[l] >= 0.6 * radiusEst && peaks[l] <= 1.45 * radiusEst;
        const compact = blobAreas[l] <= 4 * Math.PI * peaks[l] * peaks[l] * Math.max(1, k0);
        const clear = unitOk && k0 >= 1 && Math.abs(mass - k0) <= 0.2
          && wsCount === k0 && unitsSum === wsCount && pillThick && compact;
        if (!clear) ambiguous.push({ l, regs, k0, unitsSum });
      }
      consensusEligible = eligible;
      opts.debug?.({ stage: 'consensus', blobs: blobList.length, eligible, ambiguous: ambiguous.length, unit, unitOk });

      if (ambiguous.length) {
        // Bounding boxes + centroids for just the ambiguous blobs.
        const ambSet = new Map(ambiguous.map((a) => [a.l, a]));
        for (let i = 0; i < bl.length; i++) {
          const a = ambSet.get(bl[i]);
          if (!a) continue;
          const x = i % w, y = (i / w) | 0;
          if (!a.box) { a.box = { x0: x, y0: y, x1: x, y1: y }; a.sx = 0; a.sy = 0; }
          if (x < a.box.x0) a.box.x0 = x;
          if (x > a.box.x1) a.box.x1 = x;
          if (y < a.box.y0) a.box.y0 = y;
          if (y > a.box.y1) a.box.y1 = y;
          a.sx += x;
          a.sy += y;
        }

        const drop = new Set();
        for (const a of ambiguous) drop.add(a.l);
        regions = regions.filter((r) => !drop.has(labelBlob.get(r.label) || 0));

        // Image-level prior: when most eligible blobs are CLEAR, the clear
        // majority certifies the calibration and the baseline — the few
        // ambiguous blobs are local overlap cases the panel systematically
        // under-reads, so it may only flag them, not override. Broad
        // ambiguity means the baseline's own calibration is suspect
        // image-wide and the panel's consensus is the better estimate.
        const broadAmbiguity = ambiguous.length >= 0.5 * eligible;

        // A calibrated unit must look like ONE pill of the observed thickness;
        // outside this window the "unit" is a clump and mass votes are noise.
        const unitPlausible = unitOk
          && unit >= 0.6 * Math.PI * radiusEst * radiusEst
          && unit <= 4 * Math.PI * radiusEst * radiusEst;

        // Boundary-arc witness calibration (computed lazily — only photos
        // with ambiguous blobs pay for it). The recovered cap radius must be
        // a plausible pill half-width: within the same generous window the
        // ridge/peak estimates occupy. ridgePk, when measured, IS one pill's
        // half-width and arbitrates; otherwise radiusEst bounds it loosely.
        const arcCal = recoverCapRadius(bl, w, blobList, blobBox);
        const arcRef = (ridgePk > 0 && ridgePk >= 0.5 * radiusEst) ? ridgePk : radiusEst;
        const arcCalOk = arcCal.capR >= MIN_PEAK * 0.75
          && arcCal.turnMass >= 4 * Math.PI
          && arcCal.capR >= 0.4 * arcRef && arcCal.capR <= 2.5 * arcRef;
        opts.debug?.({ stage: 'arccal', capR: +arcCal.capR.toFixed(1),
          turnMass: +arcCal.turnMass.toFixed(1), ok: arcCalOk,
          ridgePk: +ridgePk.toFixed(1), radiusEst: +radiusEst.toFixed(1) });

        // HOUGH CIRCLE WITNESS — the round-pill counterpart of the boundary
        // arcs. Every seam-family method needs a mask neck and the arc
        // witness needs cap/junction notches, but two flush ROUND pills have
        // neither: their union is a smooth peanut whose waist never dips
        // (measured: caps=1 notches=0 on true pairs across the t65 sweep).
        // What flush contact cannot hide is that each pill is still a
        // circle of KNOWN radius — radiusEst is contact-independent — and
        // the Hough transform finds circle centers from partial arcs alone.
        // Only computed when the pill population is round (unitLen ~ its own
        // diameter); capsules keep the arc witness.
        let houghPts = null, houghGray = null;
        // The unitLen arm alone is forgeable: glare-shattered gel caps
        // collapse unitLen (documented 21.7 vs a true ~100 on the advil
        // photos), which makes an elongated population read "round". The
        // shape template cannot be forged the same way — its aspect comes
        // from vouched single-pill outlines — so when one exists it must
        // AGREE the pills are round.
        const roundPop = unitLen > 0 && radiusEst >= MIN_PEAK
          && unitLen < 2.7 * radiusEst
          && (!template || template.aspect <= 1.3)
          // Independent agreement: on true circles the boundary's cap
          // curvature equals the interior thickness (measured 13.6 vs 14.6);
          // on glare-shattered gels the DT "radius" is half-LENGTH, not
          // half-width, and the two diverge (measured 32.1 vs 52.6 on the
          // advil photo that leaked through as "round" and gained 2 pills).
          && arcCalOk && arcCal.capR >= 0.7 * radiusEst && arcCal.capR <= 1.45 * radiusEst;
        if (roundPop) {
          try {
            // On the GRAYSCALE PHOTO, not the mask: a binary union of flush
            // circles has no interior edge, so mask-Hough returns one circle
            // per blob (measured: 23 for 30). The photo still shows each
            // pill's rim at the contact, and Canny inside HoughCircles reads
            // it. Centers are then gated to the foreground so board texture
            // cannot vote.
            const gray8 = track(new cv.Mat());
            cv.cvtColor(src, gray8, cv.COLOR_RGBA2GRAY);
            houghGray = gray8;
            const circles = track(new cv.Mat());
            cv.HoughCircles(gray8, circles, cv.HOUGH_GRADIENT, 1,
              Math.max(4, radiusEst * 1.5), 60, 13,
              Math.max(2, Math.round(radiusEst * 0.72)),
              Math.round(radiusEst * 1.28));
            houghPts = [];
            for (let i = 0; i < circles.cols; i++) {
              const hx = circles.data32F[i * 3], hy = circles.data32F[i * 3 + 1];
              // RIGID-BODY DEDUPE. Two real pills' centers cannot sit closer
              // than ~2R (tangency); a glare highlight rides ON a pill, so
              // its phantom circle lands 1.5-1.9R from the true center —
              // inside the band HoughCircles' own minDist (1.5R) admits.
              // Circles arrive strongest-first: keep the stronger, drop any
              // center that would interpenetrate it. Same non-intersection
              // law the placement physics enforces, applied to the census.
              let clash = false;
              for (const [kx, ky, kr] of houghPts) {
                if (Math.hypot(hx - kx, hy - ky) < radiusEst * 1.7) { clash = true; break; }
              }
              if (!clash) houghPts.push([hx, hy, circles.data32F[i * 3 + 2] || radiusEst]);
            }
            opts.debug?.({ stage: 'hough', circles: houghPts.length,
              r: +radiusEst.toFixed(1) });
          } catch { houghPts = null; }
        }
        // IMAGE-LEVEL CENSUS STRENGTH — may the census VETO other witnesses?
        // Same verification photometry as the top-up below (which recomputes
        // it later with identical inputs; bl is never rewritten). A census
        // is a trustworthy CONTRADICTOR only when it accounts for ~every
        // pill already counted: measured, the two legitimate mass-raise
        // undos run at 60/60 and 12/12 (1.00) while synthetic-noise-25 —
        // where the census misses 8 of 25 pills and undoing lost a real one
        // — runs at 17/24 (0.71). Bar 0.9: >=0.19 margin each way.
        let censusStrong = false;
        if (houghPts && houghGray && houghPts.length) {
          const gd5 = houghGray.data;
          const lum5 = (x, y) => {
            const xi = x | 0, yi = y | 0;
            return (xi < 0 || yi < 0 || xi >= w || yi >= h) ? 255 : gd5[yi * w + xi];
          };
          let vN = 0;
          for (const [hx, hy] of houghPts) {
            let ePos = 0, eNeg = 0, inS = 0, rimS = 0, freeSec = 0;
            const ins = [];
            for (let k3 = 0; k3 < 16; k3++) {
              const a3 = k3 * Math.PI / 8, cA = Math.cos(a3), sA = Math.sin(a3);
              const li = lum5(hx + cA * radiusEst * 0.78, hy + sA * radiusEst * 0.78);
              const lo = lum5(hx + cA * radiusEst * 1.24, hy + sA * radiusEst * 1.24);
              const oxi = (hx + cA * radiusEst * 1.24) | 0, oyi = (hy + sA * radiusEst * 1.24) | 0;
              const contact = oxi >= 0 && oyi >= 0 && oxi < w && oyi < h && bl[oyi * w + oxi];
              if (!contact) {
                freeSec++;
                if (li - lo >= 6) ePos++; else if (lo - li >= 6) eNeg++;
              }
              inS += lum5(hx + cA * radiusEst * 0.45, hy + sA * radiusEst * 0.45);
              rimS += lum5(hx + cA * radiusEst, hy + sA * radiusEst);
              if (k3 < 8) ins.push(lum5(hx + cA * radiusEst * 0.4, hy + sA * radiusEst * 0.4));
            }
            const edgeN = Math.max(ePos, eNeg);
            ins.push(lum5(hx, hy));
            const inM = ins.reduce((x2, y2) => x2 + y2, 0) / ins.length;
            const inStd = Math.sqrt(ins.reduce((x2, y2) => x2 + (y2 - inM) ** 2, 0) / ins.length);
            const needS = Math.max(5, Math.ceil(0.57 * freeSec));
            const needD = Math.max(6, Math.ceil(0.75 * freeSec));
            if ((inStd <= 16 && edgeN >= needS)
              || ((inS - rimS) / 16 >= 8 && edgeN >= needD)) vN++;
            else {
              const cxi = hx | 0, cyi = hy | 0;
              if (cxi >= 0 && cyi >= 0 && cxi < w && cyi < h && bl[cyi * w + cxi]) vN++;
            }
          }
          censusStrong = vN >= 0.9 * count;
          opts.debug?.({ stage: 'census-strength', vEff: vN, count, strong: censusStrong });
        }

        for (const a of ambiguous) {
          const { l, regs } = a;
          // A single pill of this blob's thickness can cover at most ~4*pi*peak^2
          // px. When crease-cut or erosion answers "1" for a blob far beyond
          // that, they did not measure one pill — they hit their documented
          // failure mode (invisible seams / no separating neck). Abstain.
          //
          // THE PEAK MUST NOT CERTIFY ITS OWN BLOB. This bound scales as
          // peak^2, and a fused raft inflates its own peak to the raft's
          // inradius — so the blob defines the very yardstick that decides
          // whether it is one pill. Measured on the adversarial hex raft:
          // peak 53.2 on 13px pills put the bound at 35566 px, so an 11163 px
          // 19-pill raft read "singleable" and crease/ero were admitted at 1,
          // out-voting a correct ws:19 and mass:21.
          //
          // radiusEst comes from the photo's autocorrelation pitch, not from
          // the blob, so it is immune (the same reasoning as the lensingle
          // veto below). When it says the blob is several pills wide, no
          // abstention-waiver is owed to the seam-reading methods.
          const singleable = blobAreas[l] <= 4 * Math.PI * peaks[l] * peaks[l]
            && !(radiusEst > 0 && blobAreas[l] > 4 * Math.PI * radiusEst * radiusEst);

          // Length veto on the mass vote. A blob no longer than one pill
          // cannot contain two of them end to end, whatever its area says.
          // This is what catches the on-edge population: when many pills lie
          // on their narrow side, the area-calibrated unit collapses toward
          // the on-edge area and mass reads 2 on every FLAT single pill. The
          // major axis does not collapse, so it arbitrates. Only applied to
          // shrink an over-reading mass vote, never to raise one.
          const majL = (blobAxis.get(l) || {}).major || 0;
          const minL = (blobAxis.get(l) || {}).minor || 0;
          // The length veto is only valid for pills laid END TO END. Two
          // pills SIDE BY SIDE are barely longer than one but twice as wide,
          // so length alone silences the one method that can see them.
          // Measured under-counts, all with every method voting 1: blob 17 on
          // r-5de0d534 (massR 1.81, lenR 1.27), blob 17 on r-9e5ac6c9
          // (1.81 / 1.29), blob 9 on r-7ff7fd99 (2.00 / 1.10), blob 7 on
          // r-f5d11815 (2.30 / 1.20) -- heavy but short, i.e. abreast.
          // So the blob must be single in BOTH axes for the veto to apply.
          // An on-edge pill only ever gets NARROWER, so widthSingle stays
          // true for it and the on-edge protection this veto exists for is
          // preserved exactly.
          const widthSingle = !(unitMinor > 0) || minL <= 0 || minL <= 1.35 * unitMinor;
          let lenSingle = unitLen > 0 && majL > 0 && majL <= 1.35 * unitLen && widthSingle;
          // A fused raft defeats the length veto by defining the very scale it
          // is measured against: with one blob in the photo, unitLen IS the
          // raft's own length, so a 19-pill hex disc reads majL 120 <= 1.35 *
          // unitLen and mass is forced to vote 1. Measured on the adversarial
          // suite, that veto is what held the count at 1 even after the seeding
          // was fixed — the watershed voted 19, mass/crease/ero all voted 1 on
          // this reasoning, and the panel went with the majority.
          //
          // The autocorrelation radius is derived from the photo's repeating
          // pitch, not from the blob, so it is immune. If the blob is many
          // pill-diameters long it is not one pill, whatever unitLen says.
          if (lenSingle && radiusEst > 0 && majL > 3 * radiusEst) {
            opts.debug?.({ stage: 'lensingle-veto', blob: l, majL: +majL.toFixed(1),
              unitLen: +unitLen.toFixed(1), radiusEst: +radiusEst.toFixed(1) });
            lenSingle = false;
          }
          // Round-up on a heavy fraction the BASELINE already claims. Plain
          // rounding throws away real evidence at the .3-.5 band: a clump
          // holding one flat pill plus one lying ON EDGE measures ~k+0.4
          // units, because an on-edge caplet projects only ~0.6-0.75x a flat
          // one's area. Measured on r-dbe1f2d8: a 3-pill clump read 2.40
          // units and the vote rounded it to 2, losing a pill the watershed
          // had already found. Only rounds toward a count the baseline
          // independently reached, so it can never invent pills on its own.
          const massFrac = unitOk ? blobAreas[l] / unit : 0;
          // "The baseline independently reached" must mean MARKER evidence,
          // not the baseline's own area quotient: when unitsSum exceeds the
          // watershed marker count, the extra unit came from area/unit — the
          // SAME measurement massFrac is — so rounding toward it is mass
          // corroborating itself. Measured on synth2-cc-light s298 blob 33:
          // a shadow-bloated 2-capsule blob (regs 2, ws 2, ero 2, massFrac
          // 2.31) had unitsSum 3 from the quotient; the round-up made mass
          // vote 3, which then vetoed (distancePairVsMass) the ws+ero
          // descent the pixels themselves corroborate. The motivating
          // round-up case keeps firing: r-dbe1f2d8's 3-pill clump read 2.40
          // units with the watershed itself at 3 markers (regs 3 >= ceil 3).
          const heavyFraction = massFrac - Math.floor(massFrac) >= 0.3
            && Math.ceil(massFrac) === a.unitsSum
            && regs.length >= Math.ceil(massFrac);
          // Webbing discount. Rounding a fractional mass UP claims pill
          // material that was never measured. That extrapolation is exactly
          // wrong when the blob carries the side-by-side junction signature
          // (a distance-transform peak far above one pill's ridge half-width
          // -- the same 1.5x ridgePk signature junctionInflated uses): pills
          // touching along their flanks fill the crevice between them with
          // mask webbing, and that webbing IS the fraction. When the
          // watershed independently found exactly floor(massFrac) pills, two
          // cross-family witnesses agree the fraction is webbing, not a
          // buried pill. Measured on r-fd69dff9 blob 12: four flat caplets
          // touching flank-to-flank read massFrac 4.67 with peak 16.8
          // against ridgePk 7.8, ws 4 -- and the round-up to 5 invented a
          // pill (20 counted for 19). Both conditions are required: on
          // r-fd69dff9 blob 9 (truth 3, massFrac 3.10, ws 2) the watershed
          // sits BELOW the floor, so the discount stays out of the way and
          // mass still rescues the pill ws missed.
          const webbedFloor = ridgePk > 0 && peaks[l] > 1.5 * ridgePk
            && regs.length === Math.floor(massFrac);
          const massV = lenSingle ? 1
            : webbedFloor ? Math.max(1, Math.floor(massFrac))
              : (heavyFraction ? Math.ceil(massFrac) : Math.max(1, a.k0));
          // Panel votes (each method abstains when it has no evidence).
          const votes = [];
          if (regs.length >= 1) votes.push({ m: 'ws', v: regs.length }); // 1. watershed markers
          if (unitPlausible) votes.push({ m: 'mass', v: massV }); // 2. pixel mass
          const blobPieces = unitOk
            ? pieces.filter((p) => p.blob === l && p.area >= 0.5 * unit) : [];
          if (blobPieces.length >= 2 || (blobPieces.length === 1 && singleable)) {
            votes.push({ m: 'crease', v: blobPieces.length });        // 3. crease-cut pieces
          }
          const ero = erosionCores(bl, dd, w, l, a.box, peaks[l]);    // 4. erosion split
          if (ero >= 2 || singleable) votes.push({ m: 'ero', v: ero });

          // 5. boundary-arc interval [arcLo, arcHi] (see the witness block
          // above countPills). kJ uses the FLOOR: junction notches only ever
          // under-count contacts (cycles, fans and rafts hide them), so an
          // odd J must not round up — measured, round-half-up invented a pill
          // on synth2-rc-light-large-n12-t65-s159 from one noise notch.
          // A blob whose boundary sheds >=2 low-quality cap runs is too
          // RAGGED to witness at all (paper smears on the lined set read 9
          // caps of which 4 are wiggles; genuine clumps shed 0-1).
          let arcLo = 0, arcHi = 0, arcS = null;
          if (arcCalOk && a.box) {
            arcS = boundaryArcStats(bl, w, l, a.box, arcCal.capR);
            if (arcS && arcS.caps - arcS.qcaps >= 2) arcS = null;
            if (arcS) {
              const elong = template ? template.aspect >= 1.35 : arcS.capFrac < 0.75;
              const kJ = arcS.notches > 0 ? Math.floor(arcS.notches / 2) + 1 : 1;
              arcLo = Math.max(kJ, elong ? Math.ceil(arcS.clusters / 2) : arcS.clusters);
              arcHi = Math.max(kJ, arcS.clusters, arcLo);
              arcInfoByBlob.set(l, { clusters: arcS.clusters, elong });
              opts.debug?.({ stage: 'arc', blob: l, caps: arcS.caps,
                qcaps: arcS.qcaps, clusters: arcS.clusters, notches: arcS.notches,
                capFrac: +arcS.capFrac.toFixed(2), elong, kJ, arcLo, arcHi });
            }
          }

          // 6. SEAM witness (luma-relief persistence; see seamSpectrum).
          // Computed eagerly only under debug (the measurement harness reads
          // the full spectrum); in production it is computed lazily below,
          // only for blobs where a raise candidate actually needs certifying.
          let seam = (opts.debug && a.box)
            ? seamSpectrum(src.data, w, h, bl, w, l, a.box) : null;
          if (seam && opts.debug) {
            opts.debug({ stage: 'seam', blob: l, box: a.box, n: seam.n,
              p10: +seam.p10.toFixed(1), p25: +seam.p25.toFixed(1),
              p50: +seam.p50.toFixed(1), p75: +seam.p75.toFixed(1),
              p90: +seam.p90.toFixed(1),
              survivor: seam.survivor,
              spectrum: seam.events.slice(0, 24).map((e) => +e.v.toFixed(2)),
              pts: seam.events.slice(0, 24).map((e) => [e.x, e.y]),
              nEvents: seam.events.length });
          }

          // >=2 agreeing methods win; ties in agreement go to the value
          // nearest the vote median. No valid agreement => keep the baseline
          // answer for this blob but flag it LOW-CONFIDENCE.
          const tally = new Map();
          for (const { m, v } of votes) {
            if (!tally.has(v)) tally.set(v, []);
            tally.get(v).push(m);
          }
          const medV = median(votes.map((x) => x.v));
          let k = 0, ks = [];
          for (const [v, ms] of tally) {
            if (ms.length > ks.length
              || (ms.length === ks.length && k && Math.abs(v - medV) < Math.abs(k - medV))) { k = v; ks = ms; }
          }

          // STACKED-CLUMP MASS OVERRIDE.
          // Plain majority cannot rescue a deeply merged clump, because three
          // of the four methods read the same failing evidence: watershed,
          // crease and erosion all need a visible SEAM between pills. When
          // pills overlap or stack, there is no seam, so those three agree on
          // a low answer and out-vote the one method that still sees the
          // truth. Measured on r-f5d11815's top cluster: ws:3, crease:3,
          // ero:1 against mass:6 — the blob holds 5.9 units of pill material
          // and spans 2.4 pill-lengths, but the majority froze it at 3.
          //
          // Mass may only overrule that majority when a measurement OUTSIDE
          // the area calibration independently agrees the blob is big enough:
          // the major axis must span at least (k-0.5) pill-lengths, and the
          // blob must be genuinely thick (a flat single pill can never be),
          // so a mis-calibrated unit alone can never trigger this.
          const massVoteRaw = votes.find((x) => x.m === 'mass');
          let moFrom = -1; // pre-raise k of a sole-dissenter one-step massoverride
          if (massVoteRaw && massVoteRaw.v > k) {
            const mv = massVoteRaw.v;
            // Length arm must be STRICT. A lone caplet already measures ~1.1
            // pill-lengths, so a (mv-0.5) test lets "long enough for 2" pass on
            // a single pill — measured on synth2-rc-wood-*, that inflated 12
            // pills to 16. Requiring the blob to span nearly the full mv
            // pill-lengths keeps only genuine end-to-end chains.
            const lenRoom = unitLen > 0 && majL > 0 && majL >= (mv - 0.15) * unitLen;
            // TRIED AND REJECTED: a WIDTH arm (`boxRoom`) letting mass
            // override when the bounding box major*minor could physically
            // hold mv pills abreast, intended for the side-by-side pairs the
            // length arm cannot see. It did NOT fix the blobs it targeted
            // (r-5de0d534/r-9e5ac6c9 blob 17, r-f5d11815 blob 7 stayed at 1)
            // and it broke r-dbe1f2d8 from 19 to 20, net 13/20 -> 12/20 on
            // the real corpus. A bounding box is too loose a witness: one fat
            // pill plus its shadow fills the same box as a genuine pair.
            // The `stacked` arm let pixel mass multiply a blob's count with NO
            // length corroboration, on the theory that stacked pills hide
            // area. Photos for this app are single-layer by construction (the
            // capture guidance forbids piles), so a thick blob means pills
            // TOUCHING, not stacked -- and touching pills do not hide area.
            // Measured on r-fd69dff9: blob 12 fired stacked with lenRoom
            // false and jumped 1 -> 5 units; blob 9 jumped 2 -> 3. Requiring
            // real thickness AND enough length for at least a pair keeps the
            // genuine deep-pile rescue while refusing to invent pills inside
            // a blob the major axis says is too short to hold them.
            // SINGLE-LAYER COROLLARY. The capture guidance forbids piles, so
            // "stacked" can only ever mean pills TOUCHING end-to-end, and the
            // length arm is the honest witness for that. When the shape model
            // has already been caught mis-reading this photo (splotchRefused —
            // the population guard fired, meaning solidity/circularity could
            // not tell pills from junk), the derived scale it shares with
            // unitLen is not trustworthy enough to invent a pill with NO
            // length corroboration. Measured on s-0bfc44d8: unitLen collapsed
            // to 53.0 against a true bead major of ~83, so a LONE bead cleared
            // the 1.5x span test and four singles were doubled on this arm.
            const stacked = peaks[l] >= 1.35 * radiusEst
              && unitLen > 0 && majL >= 1.5 * unitLen
              && !(splotchRefused && !lenRoom);

            // PHYSICAL CAPACITY INVARIANT.
            // A blob can never hold more pills than fit inside it. The
            // distance-transform peak measures the blob's own half-thickness,
            // so a pill of that thickness covers at least pi*peak^2 px -- a
            // bound derived from the blob's geometry alone, never from the
            // area calibration. That independence is the point: when the unit
            // is corrupted, every calibration-based number is wrong together,
            // and only a self-contained measurement can catch it.
            //
            // Measured on t2-advil-scatter-dark-1 (28 glossy tablets whose
            // printed text and specular highlights punch the mask into ~30
            // sub-pill fragments): unitfix took the unit to 226 against a
            // true tablet of ~8500 px, so each real tablet read as ~38 pills
            // and massoverride multiplied it on the `stacked` branch with
            // lenRoom:false. Count came out 283 vs 28.
            //
            // pi*peak^2 understates a caplet (whose area exceeds a circle of
            // its half-width), so the 2x headroom keeps genuine end-to-end
            // chains and overlapping clumps intact; it only bites when a
            // claim exceeds what the pixels can physically contain.
            //
            // THE PEAK MUST BE ONE PILL'S, NOT THE CLUMP'S. capacity scales as
            // 1/peak^2, so an over-large peak caps the count too low. A blob's
            // own peak is exactly that when pills touch SIDE BY SIDE: the two
            // pills' material merges at the junction and the distance transform
            // there runs well above one pill's half-width. Measured on
            // c-2448027d, whose 19 caplets sit in six touching groups: blob 6
            // holds 5 pills but peaks at 25 against a real half-width of 9, so
            // capacity came out 4 and capped a correct mass vote of 5; blob 7
            // holds 4, capped at 3. The photo counted 7.
            //
            // The ridge median measured above IS one pill's half-width (it is
            // the median crest of the medial axis, which each pill keeps in a
            // clump), so it is the honest denominator.
            //
            // NARROWLY SCOPED. Relaxing this invariant for every blob is not
            // safe -- it is the only thing standing between a corrupted unit
            // and an invented count, and measured on the full corpus a blanket
            // relaxation broke 6 exact images (t2-advil-scatter-dark-1 28->31,
            // lined-69204ff4 19->38) for 3 fixed, a net -3.
            //
            // So it applies only where the side-by-side geometry it targets is
            // actually present, which requires BOTH:
            //   - the all-clumps unit rescue fired (clumpUnitFired), i.e. this
            //     photo has no isolated pill to calibrate from at all, and
            //   - this blob's own peak is materially above one pill's
            //     half-width (>1.5x), which is the junction-merge signature of
            //     pills abreast rather than a lone pill or an end-to-end chain.
            // On every photo that already counts correctly, the rescue does not
            // fire and this reduces to the original invariant exactly.
            const junctionInflated = clumpUnitFired && ridgePk > 0
              && peaks[l] > 1.5 * ridgePk;
            const capPeak = junctionInflated ? ridgePk : peaks[l];
            const capacity = peaks[l] >= MIN_PEAK
              ? Math.max(1, Math.floor((2 * blobAreas[l]) / (Math.PI * capPeak * capPeak)))
              : Infinity;
            if ((lenRoom || stacked) && mv <= capacity) {
              opts.debug?.({ stage: 'massoverride', blob: l, from: k, to: mv, lenRoom, stacked, capacity });
              // Remember a ONE-STEP raise that mass forced against every
              // other witness (all non-mass votes at the pre-raise k): the
              // round-population census gets a chance to undo it below.
              // Multi-step raises (deep piles, r-f5d11815 blob 1: ws 3,
              // ero 1, mass 6) never qualify — there the witnesses disagree
              // among themselves and mass is the only method that can see.
              if (mv === k + 1
                && votes.every((x) => x.m === 'mass' || x.v === k)) moFrom = k;
              k = mv;
              ks = ['mass', 'len'];
            } else if (lenRoom || stacked) {
              opts.debug?.({ stage: 'massoverride-capped', blob: l, from: k, want: mv, capacity });
            }
          }
          // Independence guards. The four methods form two families that fail
          // together: {ws, ero} both read the distance transform (weak necks
          // merge for both), {mass, crease} both lean on the unit calibration.
          // A 2-member coalition is only trustworthy when it either crosses
          // families without opposition, or nothing credible opposes it:
          // - crease+erosion pair alone: shared buried-seam/merged-core bias;
          // - ws+erosion pair alone with a calibrated mass dissenting: weak
          //   necks fooling the distance family while pixel mass sees more;
          // - any agreement below the watershed marker count contradicts
          //   direct thickness-peak evidence.
          const independent = ks.length >= 3 || ks.includes('ws') || ks.includes('mass');
          const massVote = votes.find((x) => x.m === 'mass');
          const distancePairVsMass = ks.length === 2 && ks.includes('ws') && ks.includes('ero')
            && massVote && massVote.v !== k;
          // A downward override that pixel mass contradicts is the whole
          // seam-reading family under-reading an overlapped clump — reject it.
          // Mass CORROBORATING the baseline counts as contradiction too: when
          // the watershed found k pills and the pixel mass independently says
          // the same, a reduction is being driven purely by methods that need
          // a visible seam (crease/erosion), which overlapping pills do not
          // have. Measured on r-7ff7fd99: ws:2, crease:2, ero:2 talked a blob
          // down from 3 to 2 while mass read exactly 3 — one real pill lost.
          const massContradicts = k < a.unitsSum && massVote && massVote.v >= a.unitsSum;
          // Length floor on downward overrides. A blob spanning N pill-lengths
          // holds at least N pills end to end, whatever the distance-transform
          // family reads at a weak neck. Pills touching END TO END produce the
          // long thin blobs the {ws, ero} pair systematically under-splits;
          // the major axis is the one measurement that neck weakness cannot
          // corrupt. Only blocks REDUCTIONS below that floor.
          const lenFloor = unitLen > 0 && majL > 0
            ? Math.floor(majL / unitLen + 0.15) : 0;
          const belowLenFloor = k < a.unitsSum && lenFloor >= 2 && k < lenFloor;
          // Mass+length corroborated INCREASE. The `broadAmbiguity` clause
          // below exists to stop the panel overriding a calibration that the
          // clear-blob majority has certified — but it also froze the one
          // case the panel gets right: a clump that pixel mass AND the major
          // axis both say holds more pills than the watershed found. Measured
          // on the real corpus: r-f5d11815's top cluster is 5.9 units of mass
          // spanning 2.4 pill-lengths, yet stayed at the watershed's 3.
          // Length is independent of the area calibration, so when it
          // separately confirms the blob is long enough to hold k pills, the
          // increase rests on two non-distance measurements and is safe.
          // Either kind of corroboration counts: the blob is long enough to
          // lay k pills end to end, OR it is thick enough that the pills must
          // be stacked (the case the seam-reading methods cannot see at all).
          const lenSupportsK = unitLen > 0 && majL > 0 && majL >= (k - 0.5) * unitLen;
          const thickSupportsK = peaks[l] >= 1.35 * radiusEst;
          const massSupportsK = massVote && massVote.v === k;
          const corroboratedRise = k > a.unitsSum && massSupportsK
            && (lenSupportsK || thickSupportsK);
          // Mass-corroborated DESCENT — the mirror of corroboratedRise.
          // The clause above admits an override only when it RAISES the
          // baseline, so a panel that agreed on a LOWER count had its answer
          // discarded no matter how well corroborated it was. That asymmetry
          // is not principled: the clause exists to protect a calibration the
          // clear-blob majority certified, and pixel mass IS that calibration.
          // When mass itself votes for the lower number, deferring to the
          // baseline overrides the calibration rather than protecting it.
          //
          // Measured on r-554c3c1a's one ambiguous blob: 3719 px against a
          // unit of 740.9 is 5.02 units, and the watershed independently found
          // 5 markers (ws:5, mass:5 — a cross-family agreement, crease and
          // ero dissenting at 2 and 3 from buried seams). The baseline claimed
          // 6, so the image counted 20 for 19 pills while the panel had 5
          // in hand. The blob population certifies the unit: 12 of 14 blobs
          // sit within 0.10 of exactly one unit.
          //
          // Deliberately narrower than the rise case: mass must vote for k
          // EXACTLY (massSupportsK), not merely fail to contradict it. That
          // single requirement is what keeps this from firing on the descents
          // the panel is right to refuse. Surveyed over all 20 real photos,
          // seven blobs have a rejected descent, and on six of them mass
          // dissents UPWARD (ws:2 vs mass:3 on r-681ce773, r-7ff7fd99,
          // r-96e5f08f, r-dbe1f2d8 x2) — the seam-reading under-count that
          // massContradicts already exists to block. Exactly one blob in the
          // corpus has mass voting for the descent: this one.
          const corroboratedDescent = k < a.unitsSum && massSupportsK;
          // COMBINER SEAM (bake-off). Variant A is the shipping veto
          // cascade, unchanged; B/C reinterpret the SAME evidence with a
          // weighted score so no single bit can kill a well-supported
          // answer. tools/bakeoff.mjs A/B/C-tests them on one corpus and
          // aborts if A ever diverges from the stored baseline — the seam
          // must be inert by construction.
          const vetoA = ks.length >= 2 && independent && !distancePairVsMass
            && !massContradicts && !belowLenFloor && k >= regs.length
            && (broadAmbiguity || k === a.unitsSum || corroboratedRise
              || corroboratedDescent);
          let agreed = vetoA;
          if (COMBINER !== 'A') {
            // Weighted evidence. Each condition contributes rather than
            // vetoes; weights reflect how often each has been RIGHT in this
            // project's measured history: cross-family agreement and the
            // baseline match are strong, the distance-family objections are
            // weaker (they are the ones that fail on flush contact).
            let sc = 0;
            sc += ks.length >= 2 ? 1.0 : 0;                  // >=2 methods concur
            sc += independent ? 0.8 : 0;                     // from different families
            sc += (k === a.unitsSum) ? 1.0 : 0;              // matches the baseline
            sc += corroboratedRise || corroboratedDescent ? 0.9 : 0;
            sc += broadAmbiguity ? 0.4 : 0;
            sc -= distancePairVsMass ? 0.7 : 0;
            sc -= massContradicts ? 0.9 : 0;
            sc -= belowLenFloor ? 1.2 : 0;                   // physical floor: hard
            sc -= (k < regs.length) ? 1.2 : 0;               // fewer than markers: hard
            const BAR = COMBINER === 'C' ? 1.5 : 1.8;
            agreed = sc >= BAR;
            if (agreed !== vetoA) opts.debug?.({ stage: 'combiner', blob: l,
              variant: COMBINER, score: +sc.toFixed(2), bar: BAR, vetoA, now: agreed });
          }
          opts.debug?.({ stage: 'panel', blob: l, votes, k, agreed, base: a.unitsSum,
            massFrac: +massFrac.toFixed(2) });

          // ARC RECONCILIATION. kMass is the RAW mass ratio, before the
          // length veto — the veto exists for end-to-end reasoning and is
          // blind to side-by-side pairs, which is exactly where the arcs see
          // caps. Two firing modes, both measured corpus-wide (survey in the
          // session scratchpad; zero currently-exact images change):
          //
          //   RAISE TO THE FLOOR. The blob's boundary shows arcLo pills'
          //   worth of junctions/caps AND the raw pixel mass independently
          //   agrees (kMass >= arcLo), yet the panel settled below the
          //   floor: the whole seam-reading family missed a flush contact.
          //   Raise to arcLo — no further than the boundary itself certifies,
          //   because mass habitually overshoots by one on webbed junctions
          //   (measured: truth = arcLo on r-cc7a2ada blob 9 with kMass 4,
          //   truth = 2 on r-f5d11815 blob 7 with kMass 2).
          //
          //   CAP THE OVER-SPLIT. Every pill of a tree-shaped elongated
          //   clump shows on the boundary, so a count above arcHi is
          //   over-division (a shattered watershed or an inflated mass
          //   vote). When mass ALSO exceeds the interval the calibration is
          //   suspect for this blob and the midpoint is the honest point
          //   estimate (each capsule shows 1-2 caps with equal prior) — but
          //   only on a WIDE interval; a narrow one holds too little cap
          //   evidence to justify the drop (measured: a kraft 3-clump read
          //   [2,2] from two merged caps and lost a real pill).
          let arcTo = 0;
          const kMass = unitOk ? Math.round(massFrac) : 0;
          if (arcS && arcLo >= 1) {
            const kFinal0 = agreed ? k : a.unitsSum;
            const elong = template ? template.aspect >= 1.35 : arcS.capFrac < 0.75;
            const treeish = kMass <= arcS.clusters + 2;
            if (kFinal0 < arcLo && kMass >= arcLo) {
              arcTo = arcLo;
            } else if (kFinal0 > arcHi && treeish && elong) {
              arcTo = kMass > arcHi
                ? (arcHi > arcLo ? Math.round((arcLo + arcHi) / 2) : 0)
                : Math.max(kMass, arcLo);
            }
            if (arcTo === kFinal0) arcTo = 0;
            if (arcTo) opts.debug?.({ stage: 'arcrec', blob: l, from: kFinal0,
              to: arcTo, arcLo, arcHi, kMass, agreed });
          }
          // HOUGH RECONCILIATION (round populations). Raise a blob to the
          // number of circle centers standing on it, when pixel mass
          // independently supports at least that many — the same two-witness
          // rule as arcrec, with Hough playing the boundary's role. Never a
          // descent, and capped by mass so stray accumulator peaks on
          // textured board cannot invent pills.
          if (houghPts && massFrac > 0) {
            const kFinal0h = agreed ? k : a.unitsSum;
            // ONE verification for every circle, photometry-free (the colour
            // metric's failure is why pills go missing in the first place):
            //   edge support  — >= 9 of 16 radial luma steps at the rim; the
            //     boundary Canny voted for must be real all the way around.
            //   pill face     — either SMOOTH (camouflaged white pill:
            //     measured interior std 1.4-2.3) or a shaded dome whose
            //     interior clears its rim by >= 8 luma (coloured pills:
            //     std up to 15.4, in-rim delta 8.5-35). Junction phantoms
            //     between pills have neither signature.
            // Assignment is soft (most of the core on THIS blob) because a
            // half-eroded pill's center pixel is a hole.
            let hV = 0, circOn = 0;
            const rr2 = Math.max(2, radiusEst * 0.45);
            const lum2 = (x, y) => {
              const xi = x | 0, yi = y | 0;
              return (xi < 0 || yi < 0 || xi >= w || yi >= h || !houghGray) ? 255
                : houghGray.data[yi * w + xi];
            };
            for (const [hx, hy] of houghPts) {
              const tally = new Map();
              for (const [ox, oy] of [[0, 0], [rr2, 0], [-rr2, 0], [0, rr2], [0, -rr2],
                                      [rr2 * 0.7, rr2 * 0.7], [-rr2 * 0.7, rr2 * 0.7],
                                      [rr2 * 0.7, -rr2 * 0.7], [-rr2 * 0.7, -rr2 * 0.7]]) {
                const xi = Math.round(hx + ox), yi = Math.round(hy + oy);
                if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
                const lb = bl[yi * w + xi];
                if (lb) tally.set(lb, (tally.get(lb) || 0) + 1);
              }
              let bestL = 0, bestN = 0;
              for (const [lb, n2] of tally) if (n2 > bestN) { bestN = n2; bestL = lb; }
              if (bestL !== l || bestN < 2) continue;
              circOn++;
              let ePos = 0, eNeg = 0, inS = 0, rimS = 0, freeSec = 0;
              const ins = [];
              for (let k3 = 0; k3 < 16; k3++) {
                const a3 = k3 * Math.PI / 8, cA = Math.cos(a3), sA = Math.sin(a3);
                const li = lum2(hx + cA * radiusEst * 0.78, hy + sA * radiusEst * 0.78);
                const lo = lum2(hx + cA * radiusEst * 1.24, hy + sA * radiusEst * 1.24);
                const oxi = (hx + cA * radiusEst * 1.24) | 0, oyi = (hy + sA * radiusEst * 1.24) | 0;
                const contact = oxi >= 0 && oyi >= 0 && oxi < w && oyi < h && bl[oyi * w + oxi];
                if (!contact) {
                  freeSec++;
                  if (li - lo >= 6) ePos++; else if (lo - li >= 6) eNeg++;
                }
                inS += lum2(hx + cA * radiusEst * 0.45, hy + sA * radiusEst * 0.45);
                rimS += lum2(hx + cA * radiusEst, hy + sA * radiusEst);
                if (k3 < 8) ins.push(lum2(hx + cA * radiusEst * 0.4, hy + sA * radiusEst * 0.4));
              }
              // A disc edge steps the same DIRECTION all the way round; a
              // grain ring or noise ridge alternates. Coherence, not just
              // magnitude.
              const edgeN = Math.max(ePos, eNeg);
              ins.push(lum2(hx, hy));
              const inM = ins.reduce((x2, y2) => x2 + y2, 0) / ins.length;
              const inStd = Math.sqrt(ins.reduce((x2, y2) => x2 + (y2 - inM) ** 2, 0) / ins.length);
              // Smooth faces earn the loose edge bar; DOME faces (bright
              // interior over rim) must be near-unanimous on the rim —
              // glossy glare on a textured board fakes the dome signature
              // but never a coherent ring (measured: advil-dark counted +5
              // and +14 from glare circles; ibuprofen countertop 13 -> 59).
              // Owned circles get a looser face bar (coloured pills measure
              // std up to 15.4, dome deltas from 6.7) because the raise
              // below is mass-corroborated: material must back every pill.
              const needS = Math.max(5, Math.ceil(0.57 * freeSec));
              const needD = Math.max(6, Math.ceil(0.75 * freeSec));
              if ((inStd <= 16 && edgeN >= needS)
                || ((inS - rimS) / 16 >= 6 && edgeN >= needD)) hV++;
              opts.debug?.({ stage: 'hverify', blob: l, hx: +hx.toFixed(0), hy: +hy.toFixed(0),
                edgeN, freeSec, needS, inStd: +inStd.toFixed(1), dome: +((inS - rimS) / 16).toFixed(1) });
            }
            // Raise only, and never beyond what the blob box can physically
            // hold at this radius. For ROUND populations the circles beat
            // the notch-based arc reading, so a hough answer replaces an
            // arcrec one (arcrec fired above; overwrite is intentional).
            const cap = Math.max(1, Math.round(
              ((a.box.x1 - a.box.x0 + 2 * radiusEst) * (a.box.y1 - a.box.y0 + 2 * radiusEst))
              / (Math.PI * radiusEst * radiusEst * 0.9)));
            // Mass corroboration is the glare-killer: an under-split
            // cluster has the material for every circle (massFrac ~ hV); a
            // glare phantom adds a pill the mask cannot back (mass stays at
            // k, so massFrac < hV - 0.6 and the raise is refused).
            hV = Math.max(hV, Math.min(circOn, Math.floor(massFrac + 0.55)));
            // For ROUND populations the circles beat the notch-based arc
            // reading in BOTH directions: an arc raise beyond the number of
            // circles standing on the blob is a notch misread (wood grain
            // notches measured arcLo 2 on true singles with circOn 1).
            // Only when the vouched template itself is round: on mixed
            // populations the census is partial (hough saw 24 of 35 on the
            // mixed wood photo) and must not veto the arc witness.
            // Suppress an arc raise beyond the on-blob circle census ONLY
            // when the blob geometrically cannot hold the extra pill: its
            // area is one pill of its own thickness (wood-grain notches
            // measured arcLo 2 on true singles with circOn 1, area ~ pi*pk^2).
            // True pairs the census under-covers (noisy boards) measure
            // ~2*pi*pk^2 and keep their raise.
            if (arcTo > circOn) {
              opts.debug?.({ stage: 'arccap', blob: l, arcTo, circOn,
                area: blobAreas[l], lim: +(1.55 * Math.PI * peaks[l] * peaks[l]).toFixed(0), pk: +peaks[l].toFixed(1) });
              if (blobAreas[l] <= 1.55 * Math.PI * peaks[l] * peaks[l])
                arcTo = Math.min(arcTo, Math.max(kFinal0h, circOn));
            }
            opts.debug?.({ stage: 'hsum', blob: l, hV, circOn, kFinal0h, arcTo, cap, massFrac: +massFrac.toFixed(2) });
            if (hV > Math.max(kFinal0h, arcTo) && hV <= cap) {
              arcTo = hV;
              opts.debug?.({ stage: 'houghrec', blob: l, from: kFinal0h, to: hV, cap });
            }
            // HOUGH-CENSUS DESCENT — the mirror of houghrec, one unit only.
            // A watershed marker split by a ring-shaped DT (unfilled shine
            // bay in a low-contrast pill face) or a junction marker leaves
            // the baseline one ABOVE what census + mass independently agree
            // on. houghrec is raise-only by design, consolidation needs a
            // smooth convex outline (the bay breaks it), and the panel's
            // `k >= regs.length` floor pins every other path to the marker
            // count — so nothing can take the baseline DOWN even when every
            // other witness reads lower.
            // Fire only when the evidence is unanimous and the step is 1:
            //   - every circle standing on this blob verified (hV===circOn),
            //   - pixel mass sits within 0.25 of exactly circOn. Measured
            //     both sides: every true descent's |massFrac - circOn| is
            //     <= 0.17 (s142 blobs 3/11/14/27/43 at 0.83-0.89 for circOn
            //     1; s112 blob 10 at 8.11 for circOn 8); every descent that
            //     must NOT fire misses by >= 0.39 (s140 blob 8, a shredded
            //     camouflage cluster, massFrac 0.61 with the census under-
            //     covering; s231 blob 29, shadow-bloated wood 5-clump,
            //     massFrac 6.23 vs circOn 5). 0.25 is the geometric
            //     midpoint, ~1.5x margin each way,
            //   - the baseline is exactly circOn+1 (never a multi-step drop),
            //   - the panel did NOT agree on the baseline (we only override
            //     the un-corroborated fallback, never a certified answer),
            //   - no arc/hough raise already claimed this blob.
            // Measured: synth2 s142 blobs 3/14/27/43 (hV=circOn=1,
            // kFinal0h=2, massFrac 0.83-0.89 — four split singles, +4) and
            // s112 blob 10 (hV=circOn=8, kFinal0h=9, massFrac 8.11 — 9
            // markers on 8 pills, +1); in both photos the image-level census
            // equalled the true count exactly (120 circles for 120 pills).
            if (!arcTo && !agreed && circOn >= 1 && hV === circOn
              && kFinal0h === circOn + 1
              && Math.abs(massFrac - circOn) < 0.25) {
              arcTo = circOn;
              opts.debug?.({ stage: 'houghdesc', blob: l, from: kFinal0h,
                to: circOn, massFrac: +massFrac.toFixed(2) });
            }
            // MASS-RAISE CENSUS UNDO — the `agreed` counterpart of the
            // descent above, scoped to exactly one pathology: a soft
            // contact-shadow bloats the mask, mass reads ~k+1, and
            // massoverride's length arm raises a count that EVERY other
            // witness contradicts. Fire only when:
            //   - massoverride made a one-step raise with mass the sole
            //     dissenter (all non-mass votes at the pre-raise k, recorded
            //     as moFrom above; multi-step pile rescues never qualify),
            //   - every circle standing on this blob verified AND their
            //     number is exactly the pre-raise k (hV === circOn ===
            //     moFrom): the census sees no material for the extra pill
            //     anywhere on the blob. A census that under-covers (camo)
            //     breaks hV === circOn or lands below moFrom and abstains.
            // Measured: s231 blob 29 (ws 5, ero 5, arcLo=arcHi 5, hV=circOn
            // 5, massFrac 6.23 -> raised to 6, one shadow-bloated unit; the
            // blob's own seam spectrum holds exactly 4 strong events —
            // 36.5-72.8 luma vs a 6.55 cliff — i.e. 5 pills) and s237 blob
            // 11 (ws 1, crease 1, ero 1, hV=circOn 1, massFrac 2.07 -> a
            // single pill plus its cast shadow raised to 2; seam top event
            // 10.0 vs floorT 97.3 refuses the pair). Real-photo massoverride
            // rescues are caplet populations with no hough census at all
            // (r-f5d11815: houghPts null), and deep-clump interiors fail
            // circle verification (contact sectors starve freeSec), so
            // hV < circOn there and the undo abstains.
            // ... and the blob's own seams must REFUSE the raised count.
            // A census that under-covers a genuine clump makes the first
            // two witnesses lie together (measured on synthetic-noise-25
            // blob 6: a true 3-clump with massFrac exactly 3.00 where only
            // 2 circles verified — undoing there lost a real pill). Real
            // pill-pill contacts carry luma-relief merge events the shadow
            // lobe cannot fake: the shadow's "seam" is a step into darkness,
            // not a valley between two bright domes. Measured refusals on
            // the true undos: s231 5th event 6.55 vs floorT 19.2, s237 top
            // event 10.0 vs floorT 97.3; noise-25's real 3-clump certifies
            // its 2nd event at full depth and keeps the raise.
            // ... and only a COMPLETE census may contradict (censusStrong,
            // measured above: the legit undos run 60/60 and 12/12 verified-
            // to-counted; synthetic-noise-25, where the census misses 8 of
            // 25 pills and the mass raise was RIGHT — massFrac exactly 3.00
            // on a true 3-clump with 2 circles — runs 17/24 and abstains),
            // and the blob's own seams must ALSO refuse the raised count
            // (s231's 5th event 6.55 vs floorT 19.2; s237's top event 10.0
            // vs 97.3 — a shadow lobe is a step into darkness, not a valley
            // between two bright domes).
            if (!arcTo && moFrom >= 1 && kFinal0h === moFrom + 1
              && circOn === moFrom && hV === circOn && censusStrong) {
              if (!seam && a.box) seam = seamSpectrum(src.data, w, h, bl, w, l, a.box);
              const iqrU = seam ? Math.max(1, seam.p75 - seam.p25) : 0;
              const seamCertifies = !!seam && seam.events.length >= kFinal0h - 1
                && seam.events[kFinal0h - 2].v >= 0.67 * iqrU;
              opts.debug?.({ stage: 'houghdesc-mo-eval', blob: l,
                from: kFinal0h, to: moFrom, massFrac: +massFrac.toFixed(2),
                seamCertifies,
                ev: seam && seam.events[kFinal0h - 2] ? +seam.events[kFinal0h - 2].v.toFixed(2) : null,
                floorT: seam ? +(0.67 * iqrU).toFixed(1) : null });
              if (!seamCertifies) {
                arcTo = moFrom;
                opts.debug?.({ stage: 'houghdesc-mo', blob: l, from: kFinal0h,
                  to: moFrom, massFrac: +massFrac.toFixed(2) });
              }
            }
          }

          // SEAM RE-PARTITION — the hybrid routing step. The panel's seam-
          // blind majority (ws/crease/ero all need a mask neck) habitually
          // freezes a grouped clump below the mass vote, and massoverride's
          // length arm cannot see pills lying ABREAST. This is where the
          // luma-relief persistence localizer (docs/dense-separation-research
          // .md: 81.3% per-pill recall vs the DT family's 74.8%) is routed in
          // — for exactly the clump regions where the settled answer is
          // contested, and nowhere else.
          //
          // It does not COUNT. The research proved k-selection by threshold
          // has no global constant (r-f5d11815 vs r-7ff7fd99 need opposite
          // image-level settings), and at region level the measured per-blob
          // windows are just as hostile: the two lined rafts' k=16 windows,
          // (12.0,12.7) vs (12.7,13.7) absolute luma, do not even intersect
          // EACH OTHER; r-7ff7fd99 blob 11's 4th seam (19.3, IQR 27.3) and
          // r-76385b11 blob 13's false 2nd event (17.3, IQR 25.9) sit ~5%
          // apart in every normalization tried. No threshold, however
          // self-calibrated, takes both sides of those pairs.
          //
          // So the seam witness CERTIFIES a candidate someone else proposed:
          //   A1: the mass vote itself (massV > the blob's settled answer);
          //   A2: arcHi when mass overshoots the boundary interval.
          // A candidate k is certified iff the blob's own luma relief holds
          // at least k-1 merge events of persistence >= 0.67 * the blob's
          // luma IQR. Self-calibrated: a blob whose seams measure ~0 (flat
          // synthetic raft, buried flush contact) certifies nothing and the
          // witness ABSTAINS rather than votes.
          //
          // THE 0.67 CONSTANT, measured corpus-wide on the 48-image design
          // set (24 real+lined with per-pill centers, 24 dense synth): every
          // FALSE proposal on labeled blobs certifies at <= 0.469 of the
          // blob's IQR (worst: c-2448027d blob 6, mass wants 7 over truth 5,
          // event depth 21.7 vs IQR 46.3); every TRUE proposal certifies at
          // >= 0.965 (c-2448027d blob 1, 4th pill's seam 29.6 vs IQR 30.7;
          // blob 3, 3rd pill's seam 24.7 vs IQR 22.0). The populations are
          // 2.06x apart with no overlap — the same acceptance bar
          // docs/lined-paper-fix.md set for the chain-density gate (1.4x, no
          // overlap). 0.67 is the geometric midpoint, >=1.4x margin each way.
          //
          // The certified k must then survive a PARTITION-VALIDITY veto (the
          // cells of the k-basin partition must classify like this photo's
          // own pills — see below), the raise is capped by the physical-
          // capacity invariant, and it only ever RAISES: the on-edge single
          // population that dooms every unsolicited-split scheme proposes
          // nothing and is never touched.
          //
          // Tried and REJECTED, both measured on the design set (session
          // scratchpad lat/):
          //   - kSeam by event-counting at any per-blob threshold: r-7ff7fd99
          //     blob 11's 4th seam (19.3 luma, IQR 27.3) vs r-76385b11 blob
          //     13's false 2nd event (17.3 luma, IQR 25.9) sit ~5% apart in
          //     every normalization — a genuine region-level proof pair.
          //   - partition-shape as the ACCEPTOR (choose smallest k whose
          //     cells classify pill-like, no depth floor): a (k-1)-partition
          //     of k tight pills still yields pill-shaped cells (measured:
          //     r-7ff7fd99 blob 11 at k=3, the lined rafts at k=14), and
          //     half-cells of a split single classify as clean circles
          //     (r-d87c4d5f blob 17 halves: resid 0.012/0.181) — output
          //     shape alone can neither find the buried pill nor refuse the
          //     false split. It works only as a veto on top of the floor.
          //   - ceil(massFrac) as a third candidate arm: the on-edge single
          //     population at massFrac 1.30-1.35 proposes k=2 everywhere and
          //     broke 4-6 real photos at every floor setting.
          let seamTo = 0, seamConf = 'high', seamCellsOut = null;
          {
            const kFinal0 = arcTo || (agreed ? k : a.unitsSum);
            const massW = votes.find((x) => x.m === 'mass');
            const cands = [];
            if (massW && massW.v > kFinal0) cands.push({ v: massW.v, conf: 'high' }); // A1
            if (massW && arcS && arcHi >= 1 && massW.v > arcHi && arcHi > kFinal0) {
              // mass overshoots the boundary interval: also offer the
              // boundary's own ceiling, per the arcrec philosophy ("no
              // further than the boundary certifies"). Flagged low — the
              // witnesses genuinely disagree above arcHi.
              cands.push({ v: arcHi, conf: 'low' });                          // A2
            }
            if (cands.length) {
              // Physical-capacity invariant, as in massoverride. The peak
              // may be junction-inflated (pills ABREAST merge material at
              // the contact and the DT there runs above one pill's
              // half-width); >1.5x the ridge median is that signature, and
              // the ridge median IS one pill's half-width, so it is the
              // honest denominator. Unlike massoverride this does not also
              // require clumpUnitFired: here the raise must additionally be
              // seam-certified below, so the blanket-relaxation hazard that
              // motivated the narrow scope there does not arise.
              const capPeakS = (ridgePk > 0 && peaks[l] > 1.5 * ridgePk)
                ? ridgePk : peaks[l];
              const capacityS = peaks[l] >= MIN_PEAK
                ? Math.max(1, Math.floor((2 * blobAreas[l]) / (Math.PI * capPeakS * capPeakS)))
                : Infinity;
              if (!seam && a.box) seam = seamSpectrum(src.data, w, h, bl, w, l, a.box);
              if (seam && seam.events.length) {
                const iqr = Math.max(1, seam.p75 - seam.p25);
                const floorT = 0.67 * iqr;
                const okC = cands.filter((cd) => cd.v > kFinal0 && cd.v <= capacityS
                  && seam.events.length >= cd.v - 1 && seam.events[cd.v - 2].v >= floorT)
                  .sort((x2, y2) => x2.v - y2.v);
                if (okC.length) {
                  // PARTITION-VALIDITY ACCEPTANCE (cell-shape veto). Before
                  // adopting the certified k, partition the blob into k luma
                  // basins grown from the top-k persistence maxima and
                  // require every cell to classify like a pill of THIS photo
                  // (same oriented-extent fit as the shipped per-region
                  // geometry pass, same single-pill residual bar as the
                  // shape template) and the cells to be mutually size-
                  // coherent (same medication => same size; flat-vs-on-edge
                  // spans <=1.67x, so 2.2x is generous headroom while a
                  // pill+webbing-fragment split measures far beyond it).
                  // Measured on the accepted design-set fires: worst cell
                  // residual 0.103 vs bar 0.30, worst size ratio 1.37.
                  const kAcc = okC[0].v;
                  const cells = seamCells(seam, kAcc);
                  const residBar = template
                    ? Math.max(0.30, 4 * template.residual + 0.12) : 0.30;
                  let ok = !!cells && cells.length === kAcc;
                  if (ok) {
                    let nLo = Infinity, nHi = 0;
                    for (const cl of cells) {
                      if (cl.n < 20 || cl.err > residBar) { ok = false; break; }
                      if (cl.n < nLo) nLo = cl.n;
                      if (cl.n > nHi) nHi = cl.n;
                    }
                    if (ok && nHi > 2.2 * nLo) ok = false;
                  }
                  // PHOTOMETRIC ACCEPTANCE (the second, independent half of
                  // the render-and-verify test): each hypothesized pill's
                  // interior must be MADE of pill pixels, not just shaped
                  // like one. Sampled on the distance-from-background map;
                  // the bar is the photo's own Otsu segmentation cut, so it
                  // is constant-free. Only meaningful when the mask came
                  // from color distance in the first place.
                  let photoOk = true;
                  if (ok && cells) {
                    const dd8 = distBg.data;
                    for (const cl of cells) {
                      cl.photo = pillPhotoScore(dd8, w, h, cl);
                      if (usedColorDist && cl.photo < otsuThr) photoOk = false;
                    }
                  }
                  // TEMPLATE-ASPECT CONSISTENCY. One medication means the
                  // cells of a re-partition must look like THAT medication.
                  // Measured (advil-2 recount): a seam raise 2 -> 3 shipped
                  // cells of aspect 1.7 and 1.54 for ROUND tablets (template
                  // aspect ~1.05) — pill fragments, and the extra unit drew
                  // a second ring inside one pill. Round templates only:
                  // capsule medications legitimately produce elongated cells
                  // (the r-cc7a2ada / c-2448027d wins live there).
                  if (ok && cells && template && template.aspect <= 1.25) {
                    for (const cl of cells) {
                      if (cl.aspect > template.aspect * 1.35) { photoOk = false; break; }
                    }
                  }
                  opts.debug?.({ stage: 'seamcells', blob: l, k: kAcc,
                    valid: ok, photoOk,
                    cells: cells ? cells.map((cl) => ({ n: cl.n,
                      err: +cl.err.toFixed(3), aspect: +cl.aspect.toFixed(2),
                      photo: cl.photo != null ? +cl.photo.toFixed(1) : null })) : null,
                    otsuThr: +otsuThr.toFixed(1) });
                  if (ok && photoOk) {
                    seamTo = kAcc;
                    seamConf = okC[0].conf;
                    seamCellsOut = cells;
                    opts.debug?.({ stage: 'seamrec', blob: l, from: kFinal0,
                      to: seamTo, conf: seamConf, floorT: +floorT.toFixed(1),
                      iqr: +iqr.toFixed(1), massV: massW.v, arcLo, arcHi,
                      capacity: capacityS });
                  } else {
                    // The seams certify the depth but the resulting cells
                    // fail the photo's own pill-shape bar or read
                    // background-like inside: the witnesses disagree
                    // irreconcilably. Keep the count, flag it — never
                    // silently pick.
                    lowConfidence++;
                    opts.debug?.({ stage: 'seaminvalid', blob: l, kFinal0, kAcc,
                      shapeOk: ok, photoOk });
                  }
                }
              }
            }
          }
          if (seamTo) {
            if (seamConf === 'low') lowConfidence++;
            count -= a.unitsSum;
            count += seamTo;
            // OUTPUT CONTRACT: one multi-unit region per re-partitioned
            // clump, carrying per-pill placements in `pills` — cell basin
            // centroids (the localizer's proven strength: 81.3% per-pill
            // recall) with each cell's own oriented extents, plus the
            // photometric score normalized to the partition's median so the
            // display can color per-pill hypotheses. `arc: true` exempts the
            // region from fragment consolidation for the same reason as the
            // arc witness: this raise exists precisely because the outline
            // under-reports the pills inside it.
            const medPhoto = median(seamCellsOut.map((cl) => cl.photo || 0)) || 1;
            const pills = seamCellsOut.map((cl) => ({
              cx: cl.cx, cy: cl.cy, theta: +cl.theta.toFixed(3),
              major: +cl.major.toFixed(1), minor: +cl.minor.toFixed(1),
              valid: +Math.min(1, (cl.photo || 0) / medPhoto).toFixed(2),
            }));
            regions.push({ cx: a.sx / blobAreas[l], cy: a.sy / blobAreas[l],
              area: blobAreas[l], units: seamTo, confidence: seamConf,
              arc: true, seam: true, pills });
            continue;
          }
          if (arcTo) {
            // Route the arc answer through the same accounting as an agreed
            // panel: replace this blob's baseline units with arcTo. Mass
            // landing inside the interval is cross-family corroboration;
            // outside it, the answer is honest but uncertain — flag it.
            const conf = kMass >= arcLo && kMass <= arcHi ? 'high' : 'low';
            if (conf === 'low') lowConfidence++;
            count -= a.unitsSum;
            count += arcTo;
            // `arc: true` exempts these regions from fragment consolidation:
            // that stage's premise ("a smooth convex outline is ONE pill")
            // is measurably false for a flush side-by-side pair — measured
            // on r-f5d11815 blob 7, truth 2, whose pair outline scores
            // solidity 0.934 / fill 0.931 / defect 0.41x and sails through
            // every consolidation gate. The arc witness reads the same
            // outline at cap scale, where the two pills are still visible.
            const singlesA = regs.filter((r) => r.units === 1);
            if (singlesA.length === arcTo) {
              for (const r of singlesA) regions.push({ ...r, units: 1, confidence: conf, arc: true });
            } else {
              const area = blobAreas[l];
              regions.push({ cx: a.sx / area, cy: a.sy / area, area, units: arcTo, confidence: conf, arc: true });
            }
            continue;
          }
          if (!agreed) {
            // Keep the baseline count for this blob. If some independent
            // method reproduces it, that IS a 2-method agreement on the
            // baseline answer — high confidence. Otherwise flag it.
            const corroborated = votes.some((x) => x.m !== 'ws' && x.v === a.unitsSum);
            const conf = corroborated ? 'high' : 'low';
            if (!corroborated) lowConfidence++;
            for (const r of regs) regions.push({ ...r, confidence: conf });
            continue;
          }

          // Badge placement: watershed pill centers when they match k, else
          // crease-piece centers, else one range badge at the blob centroid.
          const singles = regs.filter((r) => r.units === 1);
          const pieceCenters = blobPieces
            .filter((p) => p.area >= 0.55 * unit && p.area <= 1.8 * unit)
            .map((p) => ({ cx: p.sx / p.area, cy: p.sy / p.area, area: p.area }));
          count -= a.unitsSum;
          count += k;
          if (singles.length === k) {
            for (const r of singles) regions.push({ ...r, units: 1, confidence: 'high' });
          } else if (pieceCenters.length === k) {
            for (const p of pieceCenters) regions.push({ ...p, units: 1, confidence: 'high' });
          } else {
            const area = blobAreas[l];
            regions.push({ cx: a.sx / area, cy: a.sy / area, area, units: k, confidence: 'high' });
          }
        }

        // HOUGH TOP-UP (round populations). Image-level arbitration, after
        // every per-blob channel has spoken. Measured across the round
        // synthetic family, the verified circle census is more accurate
        // than the assembled pipeline (170/186 exact raw); its remaining
        // failure modes — phantom rings on coarse texture, zero circles on
        // dark boards — are exactly what the verification and the
        // raise-only rule below neutralize. Per-blob reconciliation still
        // runs first because it fixes counts AND placements; this catches
        // what no blob-level channel can: a pill whose mask fragments were
        // counted under other labels while the pill itself went unclaimed
        // (measured: camouflaged white pills, owned by their own crumbs,
        // invisible to both houghrec and an unowned-circle test).
        if (houghPts && houghGray && houghPts.length) {
          const gd2 = houghGray.data;
          const lum3 = (x, y) => {
            const xi = x | 0, yi = y | 0;
            return (xi < 0 || yi < 0 || xi >= w || yi >= h) ? 255 : gd2[yi * w + xi];
          };
          const verified = [];
          let massBacked = 0;
          for (const [hx, hy] of houghPts) {
            let ePos = 0, eNeg = 0, inS = 0, rimS = 0, freeSec = 0;
            const ins = [];
            for (let k3 = 0; k3 < 16; k3++) {
              const a3 = k3 * Math.PI / 8, cA = Math.cos(a3), sA = Math.sin(a3);
              const li = lum3(hx + cA * radiusEst * 0.78, hy + sA * radiusEst * 0.78);
              const lo = lum3(hx + cA * radiusEst * 1.24, hy + sA * radiusEst * 1.24);
              const oxi = (hx + cA * radiusEst * 1.24) | 0, oyi = (hy + sA * radiusEst * 1.24) | 0;
              const contact = oxi >= 0 && oyi >= 0 && oxi < w && oyi < h && bl[oyi * w + oxi];
              if (!contact) {
                freeSec++;
                if (li - lo >= 6) ePos++; else if (lo - li >= 6) eNeg++;
              }
              inS += lum3(hx + cA * radiusEst * 0.45, hy + sA * radiusEst * 0.45);
              rimS += lum3(hx + cA * radiusEst, hy + sA * radiusEst);
              if (k3 < 8) ins.push(lum3(hx + cA * radiusEst * 0.4, hy + sA * radiusEst * 0.4));
            }
            const edgeN = Math.max(ePos, eNeg);
            ins.push(lum3(hx, hy));
            const inM = ins.reduce((x2, y2) => x2 + y2, 0) / ins.length;
            const inStd = Math.sqrt(ins.reduce((x2, y2) => x2 + (y2 - inM) ** 2, 0) / ins.length);
            const needS = Math.max(5, Math.ceil(0.57 * freeSec));
            const needD = Math.max(6, Math.ceil(0.75 * freeSec));
            if ((inStd <= 16 && edgeN >= needS)
              || ((inS - rimS) / 16 >= 8 && edgeN >= needD)) verified.push([hx, hy, inStd]);
            else {
              // Mass-backed budget credit: a failed circle whose core stands
              // on counted material is a real pill the photometry cannot see
              // (clump interior); it widens the budget but is never a
              // placement site.
              const cxi = hx | 0, cyi = hy | 0;
              if (cxi >= 0 && cyi >= 0 && cxi < w && cyi < h && bl[cyi * w + cxi]) massBacked++;
            }
          }
          // A census that dwarfs the mask count is the PHANTOM signature,
          // not a rescue: legitimate camouflage recoveries measured +8-15%
          // (29->30, 111->120); the failures measured +104% and +354%
          // (advil glare, ibuprofen countertop). Bound the rescue.
          const vEff = verified.length + massBacked;
          opts.debug?.({ stage: 'htopup-pre', verified: verified.length, massBacked, count });
          if (vEff > count && vEff <= count * 1.25 + 2) {
            // The uncounted pills are the verified circles farthest from any
            // counted detection — place the top-up there.
            const dets = [];
            for (const g2 of regions) dets.push([g2.cx, g2.cy]);
            // A candidate for ADDITION must wear the camouflage profile —
            // the one scenario this rescue exists for. A pill invisible to
            // the mask matches the board, so its face is nearly featureless:
            // measured std 1.4-2.3 on true rescues, >6 on every phantom
            // (glare cores, wood grain, noise). Counted pills keep whatever
            // texture they like; ADDITIONS must be smooth.
            const ranked = verified.map(([hx, hy]) => {
              let dmin = 1e9;
              for (const [dx2, dy2] of dets) {
                const d3 = Math.hypot(hx - dx2, hy - dy2);
                if (d3 < dmin) dmin = d3;
              }
              return { hx, hy, dmin };
            }).sort((x2, y2) => y2.dmin - x2.dmin);
            const add = vEff - count;
            // RESIDUAL-MATERIAL GATE for additions. An added pill must be
            // MADE of something the surface model cannot explain: sample the
            // distance-from-background map under the disc interior and on
            // the free annulus just outside it. A real pill — even one so
            // camouflaged the mask lost it entirely — still sits FARTHER
            // from the surface model than the surface right beside it; a
            // phantom ring on board texture has no such lift because the
            // disc IS the board. Measured across every top-up candidate in
            // the corpus (23 real, 3 phantom): real rescues lift dbIn-dbOut
            // by +11..+39 (worst: s154 (870,194) at +12, s160 (433,101) at
            // +11 — both fully mask-lost whites on light board) while the
            // three phantoms measure -4, 0, -4 (s250 (303,94)/(104,345) on
            // bare wood grain, s218 (816,245) on noise). Bar 6 = geometric
            // midpoint, ~1.8x margin each way. Witnesses tried and REJECTED
            // on the same measurements: interior smoothness inStd (round-2:
            // true rescues 1.6-15.2 overlap phantoms 5.0-13.3), mask crumbs
            // under the disc (real camo pills on light board measure 0.00
            // exactly like phantoms — refusing them broke s150 120->114,
            // s154 120->117, s160 30->29), interior-vs-annulus colour
            // distance (gap 22.0 vs 24.1 — no real margin). Skip (not
            // break) on refusal: ranking is by dmin and a real candidate
            // can sit below a phantom (measured on s250: phantom, real,
            // phantom in that order — the real one must still be placed).
            const sd4 = src.data;
            const dd8b = distBg.data;
            const candProfile = (hx, hy) => {
              let mOn = 0, mAll = 0;
              const dbIn = [], dbOut = [];
              const inC = [[], [], []], outC = [[], [], []];
              for (let a4 = 0; a4 < 12; a4++) {
                const cA = Math.cos(a4 * Math.PI / 6), sA = Math.sin(a4 * Math.PI / 6);
                for (const rf of [0.25, 0.5, 0.72]) {
                  const xi = Math.round(hx + cA * radiusEst * rf), yi = Math.round(hy + sA * radiusEst * rf);
                  if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
                  mAll++;
                  if (bl[yi * w + xi]) mOn++;
                  const o4 = (yi * w + xi) * 4;
                  dbIn.push(dd8b[yi * w + xi]);
                  inC[0].push(sd4[o4]); inC[1].push(sd4[o4 + 1]); inC[2].push(sd4[o4 + 2]);
                }
                for (const rf of [1.4, 1.6]) {
                  const xi = Math.round(hx + cA * radiusEst * rf), yi = Math.round(hy + sA * radiusEst * rf);
                  if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
                  if (bl[yi * w + xi]) continue; // annulus: free surface only
                  const o4 = (yi * w + xi) * 4;
                  dbOut.push(dd8b[yi * w + xi]);
                  outC[0].push(sd4[o4]); outC[1].push(sd4[o4 + 1]); outC[2].push(sd4[o4 + 2]);
                }
              }
              const med4 = (arr) => { const s4 = arr.slice().sort((p, q) => p - q); return s4.length ? s4[s4.length >> 1] : 0; };
              let annD = 0;
              if (outC[0].length >= 6) {
                for (let c4 = 0; c4 < 3; c4++) { const dd4 = med4(inC[c4]) - med4(outC[c4]); annD += dd4 * dd4; }
                annD = Math.sqrt(annD);
              } else annD = -1; // annulus starved (crowded): no reading
              return { maskFrac: mAll ? mOn / mAll : 0, annD, nOut: outC[0].length,
                dbIn: med4(dbIn), dbOut: outC[0].length >= 6 ? med4(dbOut) : -1 };
            };
            let added = 0;
            for (let i2 = 0; i2 < ranked.length && added < add; i2++) {
              const { hx, hy, dmin } = ranked[i2];
              // a real uncounted pill does not sit on a counted center
              if (dmin < radiusEst * 1.3) { opts.debug?.({ stage: 'htopup-blocked', hx: +hx.toFixed(0), hy: +hy.toFixed(0), dmin: +dmin.toFixed(1) }); break; }   // ranked by dmin: rest are closer
              const prof = candProfile(hx, hy);
              // Starved annulus (crowded site, dbOut unreadable): fall back
              // to mask backing — crowded sites have material to show.
              const phantom = prof.dbOut >= 0
                ? (prof.dbIn - prof.dbOut) < 6
                : prof.maskFrac < 0.30;
              opts.debug?.({ stage: 'htopup-cand', hx: +hx.toFixed(0), hy: +hy.toFixed(0),
                dmin: +dmin.toFixed(1), maskFrac: +prof.maskFrac.toFixed(2),
                annD: +prof.annD.toFixed(1), nOut: prof.nOut,
                dbIn: prof.dbIn, dbOut: prof.dbOut, otsuThr: +otsuThr.toFixed(1), phantom });
              if (phantom) continue;
              regions.push({ cx: hx, cy: hy, area: Math.PI * radiusEst * radiusEst,
                units: 1, confidence: 'high', arc: true, hough: true });
              added++;
            }
            count += added;
            if (added) opts.debug?.({ stage: 'hough-topup', added, verified: verified.length });
          }
        }
      }
    }

    // Fragment consolidation (the outline can't lie): a connected blob whose
    // outer contour is a single convex ellipse IS one pill. Engravings
    // (PFE / 3CL) crease the interior and fragment the watershed into many
    // regions, but they cannot change the convex outline. Merge everything
    // inside a pill-shaped contour into exactly one counted pill. Touching
    // chains are convex-DEFICIENT, so they are never touched by this.
    {
      const contoursC = new cv.MatVector();
      const hierC = track(new cv.Mat());
      cv.findContours(bw, contoursC, hierC, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const idMask = track(cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1));
      const ells = [null];
      let cid = 0;
      for (let i = 0; i < contoursC.size() && cid < 254; i++) {
        const c = contoursC.get(i);
        const area = cv.contourArea(c);
        if (area < absFloor || c.rows < 5) continue;
        const hull = new cv.Mat();
        cv.convexHull(c, hull);
        const hullArea = cv.contourArea(hull);
        hull.delete();
        const solidity = hullArea ? area / hullArea : 0;
        const e = cv.fitEllipse(c);
        const ea = Math.PI * (e.size.width / 2) * (e.size.height / 2);
        const fillR = ea ? area / ea : 0;
        const aspect = Math.max(e.size.width, e.size.height) / Math.max(1, Math.min(e.size.width, e.size.height));
        // Neck test: a tangent PAIR of pills has two inward cusps where they
        // meet (deep convexity defects); a single pill — even heavily
        // engraved — has a smooth convex outline. Depth is scaled by the
        // minor half-axis so the gate is size-invariant.
        let maxDefect = 0;
        {
          const hullIdx = new cv.Mat();
          cv.convexHull(c, hullIdx, false, false);
          const defects = new cv.Mat();
          try {
            cv.convexityDefects(c, hullIdx, defects);
            for (let d = 0; d < defects.rows; d++) {
              const depth = defects.data32S[d * 4 + 3] / 256;
              if (depth > maxDefect) maxDefect = depth;
            }
          } catch { /* degenerate contour: treat as no defects */ }
          hullIdx.delete(); defects.delete();
        }
        // Threshold rationale: a tangent PAIR's neck defect is ~1.0x the
        // minor half-axis (two-circle geometry); an engraving/shadow notch
        // biting into a single pill's outline measures <=0.45x. 0.5x sits
        // in the gap and is robust to browser-vs-Node JPEG decode drift.
        const minorHalf = Math.min(e.size.width, e.size.height) / 2;
        const smoothOutline = maxDefect <= 0.5 * minorHalf;
        // Frame-edge guard. Consolidation's whole premise is that the OUTLINE
        // cannot lie: a smooth convex outline means one pill, and a clump of
        // touching pills betrays itself with neck cusps. That premise fails
        // where the FRAME cuts the blob — the image border slices the necks
        // off, so a clump of several pills running out of shot presents a
        // smooth arc and gets merged into one. Measured on a real photo: a
        // frame-edge clump of three pills consolidated to a single count, and
        // no later stage could recover it. A blob riding the border has not
        // shown enough of itself for the outline argument to hold.
        let touchesFrame = false;
        {
          const r = cv.boundingRect(c);
          touchesFrame = r.x <= 1 || r.y <= 1
            || r.x + r.width >= src.cols - 1 || r.y + r.height >= src.rows - 1;
        }
        opts.debug?.({ stage: 'contour', area: Math.round(area), solidity: +solidity.toFixed(3), fillR: +fillR.toFixed(3), aspect: +aspect.toFixed(2), maxDefect: +maxDefect.toFixed(1), minorHalf: +minorHalf.toFixed(1), touchesFrame });
        if (!touchesFrame && solidity >= 0.92 && fillR >= 0.85 && fillR <= 1.15 && aspect <= 3.5 && smoothOutline) {
          cid++;
          cv.drawContours(idMask, contoursC, i, new cv.Scalar(cid), -1);
          ells.push({ cx: e.center.x, cy: e.center.y, rx: e.size.width / 2, ry: e.size.height / 2, angle: e.angle, area });
        }
      }
      contoursC.delete();
      if (cid) {
        // Size sanity: consolidation says "this smooth ellipse is ONE pill".
        // A contour many times larger than the typical counted region is a
        // tangent CLUMP whose outline happens to look smooth — merging it
        // would erase dozens of pills, and (worse) it flips on and off with
        // tiny exposure changes, which is what made live counts unstable.
        const regionAreas = regions.map((r) => r.area / Math.max(1, r.units)).sort((a, b) => a - b);
        const medRegion = regionAreas.length ? regionAreas[regionAreas.length >> 1] : 0;
        let maxPill = medRegion ? medRegion * 3 : Infinity;

        // The size guard calibrates against the median COUNTED REGION, which
        // is circular when engraving has shattered every pill: the median is
        // then a fragment, and the real pill — several times larger — is
        // rejected as "too big to be one pill". Measured on r-90dbe20e (three
        // close-up PFE/3CL/PHK caplets on fabric): pills of ~46k px against a
        // maxPill of ~32k, so all three stayed fragmented and 3 counted as 11.
        //
        // When EVERY smooth-outline contour is bigger than the cap, the cap
        // is the thing that is wrong, not the contours. Those contours passed
        // solidity, ellipse-fill and the neck-cusp test, so they are single
        // pills whatever the fragment median says. Raise the cap to admit
        // them, but only in that unanimous case — a mixed scene, where some
        // pills do match the median, keeps the original clump protection.
        //
        // A FUSED RAFT IS ALSO ONE SMOOTH CONTOUR. The unanimity test cannot
        // tell "the median is a shattered fragment" from "the whole photo is
        // one tangent raft" — both present every smooth contour above the
        // cap. Raising the cap in the second case merges the entire raft into
        // a single pill. Measured on the adversarial hex raft: one 10967 px
        // contour lifted the cap to 16449 and 19 correct regions consolidated
        // to 1.
        //
        // radiusEst is the autocorrelation pitch, independent of any contour,
        // so it can referee: a contour holding many pill-areas is a clump
        // however smooth its outline. Only blocks the RAISE — the original
        // fragment rescue is untouched whenever the contour really is
        // pill-sized.
        if (cid && medRegion) {
          const smoothAreas = ells.slice(1).map((e) => e.area);
          const pillArea = radiusEst > 0 ? Math.PI * radiusEst * radiusEst : 0;
          if (smoothAreas.length && smoothAreas.every((a) => a > maxPill)) {
            const medSmooth = median(smoothAreas);
            if (pillArea > 0 && medSmooth > 3 * pillArea) {
              opts.debug?.({ stage: 'consolidate-cap-refused', med: +medSmooth.toFixed(0),
                pillArea: +pillArea.toFixed(0), ratio: +(medSmooth / pillArea).toFixed(1) });
            } else {
              maxPill = medSmooth * 1.5;
              opts.debug?.({ stage: 'consolidate-cap', from: medRegion * 3, to: maxPill, contours: smoothAreas.length });
            }
          }
        }

        const im = idMask.data;
        const merged = new Map();
        const keep = [];
        for (const r of regions) {
          const k = im[Math.round(r.cy) * w + Math.round(r.cx)];
          // Arc-witnessed regions are exempt: the boundary-arc analysis has
          // already read this outline at cap scale and found several pills
          // (see the arc reconciliation block for the measured counter-case
          // to "the outline can't lie").
          if (!k || ells[k].area > maxPill || r.arc) { keep.push(r); continue; }
          merged.set(k, (merged.get(k) || 0) + r.units);
        }
        for (const [k, unitsSum] of merged) {
          const e = ells[k];
          count += 1 - unitsSum;
          keep.push({ cx: e.cx, cy: e.cy, area: e.area, units: 1, ellipse: e });
        }
        if (merged.size) opts.debug?.({ stage: 'consolidate', pills: merged.size });
        regions = keep;
      }
    }

    let boundaries = null;
    // (built AFTER the per-region geometry pass below, which derives each
    // final region's watershed label — see the overlay-honesty note there)

    // PER-REGION GEOMETRY. Every counted region gets classified against the
    // primitive catalogue (circle / ellipse / capsule / roundrect) with a fit
    // residual, computed from its own second moments over the label map. This
    // is what the debug views show per pill: not just "a blob of N px" but
    // "a capsule, aspect 2.3, fill 0.81, residual 0.04". One pass, output-only
    // — no counting decision depends on it.
    if (regions.length && activeMd) {
      // Eleven code paths create regions and only one records its label, so
      // derive it instead: sample the label map at the region's centroid.
      //
      // THE PREMISE IS FALSE FOR CLUMPS. "Convex-ish regions always contain
      // their centroid" holds for one pill, but a multi-pill raft is CONCAVE
      // and its centroid lands in the GAP BETWEEN PILLS — which is
      // background. Measured on synth2-rc-light-small-n30-t65-s140: the
      // mid-left 8-pill raft (area 6151) has centroid (255,398), that pixel
      // is background, and activeMd carries the BACKGROUND label there. The
      // region therefore adopted the background's label, and the clump
      // placer — which collects "every pixel whose activeMd equals my
      // label" — handed Lloyd 727841 pixels (a 998x748 sheet covering the
      // whole frame, 118x the region's own area) instead of the raft's 6151.
      // Lloyd dutifully partitioned the BACKGROUND into 8 cells and scattered
      // 8 capsules across the image: rings on bare board far from any pill,
      // while the raft itself received no placement at all (its 8 pills all
      // scored MISS with "nearest detection 113-281px").
      //
      // FIX: a sampled label has to be CORROBORATED before it is trusted.
      // The label's own pixel population must be in the same league as the
      // region's measured area; the background fails this by two orders of
      // magnitude. When the centroid sample is rejected, fall back to the
      // nearest labelled pixel that does corroborate — for a raft that is one
      // of its own pills, which is the honest answer.
      {
        const lblPop = new Map();
        for (let i = 0; i < activeMd.length; i++) {
          const L = activeMd[i];
          if (L > 0) lblPop.set(L, (lblPop.get(L) || 0) + 1);
        }
        // A region may legitimately be one member of a larger labelled blob
        // (consolidation splits), so allow generous headroom; the failure we
        // are excluding is off by ~118x, not by 3x.
        const plausible = (L, r) => {
          if (!(L > 0)) return false;
          const n = lblPop.get(L) || 0;
          const a = r.area || 0;
          return a <= 0 ? n > 0 : n <= a * 8;
        };
        for (const r of regions) {
          if (r.label != null) continue;
          const cxi = Math.round(r.cx), cyi = Math.round(r.cy);
          const lbl = activeMd[cyi * w + cxi];
          if (plausible(lbl, r)) { r.label = lbl; continue; }
          // Centroid sample is background (or another region's sheet). Spiral
          // outward for the nearest pixel whose label DOES corroborate.
          const maxR = Math.max(4, Math.round(Math.sqrt(Math.max(1, r.area || 1))));
          let found = 0;
          for (let rad = 1; rad <= maxR && !found; rad++) {
            for (let dy = -rad; dy <= rad && !found; dy++) {
              for (let dx = -rad; dx <= rad; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
                const x2 = cxi + dx, y2 = cyi + dy;
                if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
                const L2 = activeMd[y2 * w + x2];
                if (plausible(L2, r)) { found = L2; break; }
              }
            }
          }
          if (found) r.label = found;
          else opts.debug?.({ stage: 'labelmiss', cx: cxi, cy: cyi, area: r.area,
            sampled: lbl, pop: lblPop.get(lbl) || 0 });
        }
      }
      const acc = new Map();
      for (const r of regions) if (r.label != null) acc.set(r.label, { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 });
      for (let i = 0; i < activeMd.length; i++) {
        const a = acc.get(activeMd[i]);
        if (!a) continue;
        const x = i % w, y = (i / w) | 0;
        a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
      }
      // First pass gave second moments; use them only for ORIENTATION. The
      // discriminating quantities (fill, aspect) must come from the tight
      // oriented-box EXTENTS, because moment-derived fill is ~pi/4 for EVERY
      // convex shape by construction — measured: all primitives reported fill
      // 0.77-0.784 and capsules classified as 'capsule' exactly 0% of the
      // time (94% 'ellipse'). fitPrimitive's ideals are bounding-box fills
      // (ellipse 0.785, stadium at aspect 2 -> 0.89, roundrect 0.95+), so the
      // measurement has to be in the same convention.
      for (const a of acc.values()) {
        if (a.n < 20) continue;
        const mx = a.sx / a.n, my = a.sy / a.n;
        const cxx = a.sxx / a.n - mx * mx, cxy = a.sxy / a.n - mx * my, cyy = a.syy / a.n - my * my;
        a.th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        a.mx = mx; a.my = my;
        a.pLo = Infinity; a.pHi = -Infinity; a.qLo = Infinity; a.qHi = -Infinity;
      }
      for (let i = 0; i < activeMd.length; i++) {
        const a = acc.get(activeMd[i]);
        if (!a || a.n < 20 || a.th === undefined) continue;
        const x = (i % w) - a.mx, y = ((i / w) | 0) - a.my;
        const c = Math.cos(a.th), sn = Math.sin(a.th);
        const pp = x * c + y * sn, q = -x * sn + y * c;
        if (pp < a.pLo) a.pLo = pp; if (pp > a.pHi) a.pHi = pp;
        if (q < a.qLo) a.qLo = q; if (q > a.qHi) a.qHi = q;
      }
      for (const r of regions) {
        const a = r.label != null ? acc.get(r.label) : null;
        if (!a || a.n < 20 || a.th === undefined) continue;
        const e1 = a.pHi - a.pLo + 1, e2 = a.qHi - a.qLo + 1;
        const major = Math.max(e1, e2), minor = Math.max(1, Math.min(e1, e2));
        const aspect = major / minor;
        const fill = a.n / (major * minor);
        const f = fitPrimitive(fill, aspect);
        r.shape = {
          primitive: f.primitive,
          residual: +f.err.toFixed(3),
          aspect: +aspect.toFixed(2),
          fill: +fill.toFixed(3),
          major: +major.toFixed(1),
          minor: +minor.toFixed(1),
          // Orientation, so a hypothesis layer can DRAW the fitted primitive
          // back onto the photo and validate it against the pixels.
          theta: +a.th.toFixed(4),
        };
        // TEMPLATE CORROBORATION. A single whose fitted outline matches the
        // medication's own template is confirmed by GEOMETRY even when the
        // consensus panel was thin (field report: isolated pills wearing
        // "20?" — the panel's mass voter abstains on odd-unit photos and a
        // lone ws vote reads as doubt, but the shape residual says plainly
        // "this is one pill of the right shape").
        if ((r.units || 1) === 1 && r.confidence === 'low'
          && f.err <= 0.08 && aspect < 4) {
          r.confidence = 'high';
          r.geoCorroborated = 1;
        }
      }
      // lowConfidence drives the amber messaging; keep it in sync with the
      // per-region upgrades above.
      lowConfidence = regions.reduce((n2, g2) => n2 + (g2.confidence === 'low' ? 1 : 0), 0);

      // ---- STAMP ROUTER (candidate) ----
      // Last-resort arbitration by stamp-peel-repeat (js/stamp.js), mirroring
      // the seam router's accounting: replace counts for exactly the
      // contested material, per-pill placements attached, `arc: true`
      // consolidation exemption, evidence dossier per placed pill.
      //
      // FIRE CONDITION (weak evidence only — normal photos pay just these
      // O(w*h) scans, never the stamp itself):
      //   - a region the panel flagged low with no witness upgrade, OR
      //   - a single whose area exceeds 1.25x the thickness-implied pill
      //     area with no witness (the pair-merge corruption signature), OR
      //   - pill-scale foreground no region owns (uncounted material), OR
      //   - explained-foreground < 0.65 (low-conf + unowned material
      //     dominates the mask).
      // The stamp's raft/otsu retries additionally require the BEIGE
      // signature — cleaned mask explains <0.65 of the otsu mask. The shiny
      // signature (glare-shredded blobs, HIGH otsu coverage) must not reach
      // them: measured, that path was a +4 overcount on the shiny pair.
      // learned stamp kernel (data-driven silhouette), surfaced by the
      // arbiter when the photo's pills are not stadiums — the template card
      // must show it instead of the parametric silhouette
      let stampKernelCard = null;
      if (opts.variant === 'consensus' && stampOtsu && regions.length) {
        const tS0 = Date.now();
        const bwd = bw.data;
        // ---- HIGH-CONTRAST SEPARATION PROBE (measurement only) ----
        if (opts.hcProbe) {
          const sdp2 = src.data;
          const bgc = dfb.color;
          const bgLuma2 = 0.299 * bgc[0] + 0.587 * bgc[1] + 0.114 * bgc[2];
          // foreground population = current mask pixels
          const fgL = [], fgB = [], fgR = [], fgG = [];
          for (let i = 0; i < w * h; i++) {
            if (!bwd[i]) continue;
            if ((i % 3) !== 0) continue;
            const q = i * 4;
            fgR.push(sdp2[q]); fgG.push(sdp2[q + 1]); fgB.push(sdp2[q + 2]);
            fgL.push(0.299 * sdp2[q] + 0.587 * sdp2[q + 1] + 0.114 * sdp2[q + 2]);
          }
          const mL = median(fgL) || 0, mB = median(fgB) || 0;
          const mR = median(fgR) || 0, mG = median(fgG) || 0;
          // per-channel separation, normalised
          const sepL = (mL - bgLuma2);
          const sepB = (mB - bgc[2]);
          const sepR = (mR - bgc[0]);
          const sepG = (mG - bgc[1]);
          opts.debug?.({ stage: 'hcprobe',
            bg: bgc.map((v) => Math.round(v)),
            fg: [Math.round(mR), Math.round(mG), Math.round(mB)],
            bgLuma: +bgLuma2.toFixed(1), fgLuma: +mL.toFixed(1),
            sepL: +sepL.toFixed(1), sepR: +sepR.toFixed(1),
            sepG: +sepG.toFixed(1), sepB: +sepB.toFixed(1) });
        }
        let totalFgS = 0;
        for (let i = 0; i < bwd.length; i++) if (bwd[i]) totalFgS++;
        let nO = 0, nI = 0;
        for (let i = 0; i < bwd.length; i++) if (stampOtsu[i]) { nO++; if (bwd[i]) nI++; }
        const cover = nO ? nI / nO : 1;
        const singlesS = regions.filter((g) => (g.units || 1) === 1 && g.shape);
        const tMajS = median(singlesS.map((g) => g.shape.major)) || 0;
        const tMinS = median(singlesS.map((g) => g.shape.minor)) || 0;
        const IMPLIED_S = radiusEst > 0
          ? stampStadArea(Math.max(2 * radiusEst, tMinS > 0 ? tMajS * 2 * radiusEst / tMinS : 2 * radiusEst), 2 * radiusEst)
          : (tMajS && tMinS ? stampStadArea(tMajS, tMinS) : 0);
        // region -> final-mask blob label (bl from the shared labeling above)
        const lblAt = (x0, y0) => {
          const xi = Math.max(0, Math.min(w - 1, x0 | 0)), yi = Math.max(0, Math.min(h - 1, y0 | 0));
          if (bl[yi * w + xi] > 0) return bl[yi * w + xi];
          for (let rr = 1; rr < 8; rr++) for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
            const X = xi + dx, Y = yi + dy;
            if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
            if (bl[Y * w + X] > 0) return bl[Y * w + X];
          }
          return 0;
        };
        const pipeByLbl = new Float64Array(peaks.length);
        for (const g of regions) { const l = lblAt(g.cx, g.cy); if (l > 0 && l < pipeByLbl.length) pipeByLbl[l] += (g.units || 1); }
        const witS = (g) => !!(g.arc || g.seam || g.hough || g.geoCorroborated);
        const lowRegs = regions.filter((g) => g.confidence === 'low');
        const oversized = IMPLIED_S > 0
          ? regions.filter((g) => (g.units || 1) === 1 && g.shape && !witS(g)
            && g.confidence !== 'low' && g.area > 1.25 * IMPLIED_S)
          : [];
        const unownedFloor = Math.max(absFloor * 2, 0.3 * IMPLIED_S);
        const unownedLbl = new Set();
        let unownedArea = 0;
        for (let l = 1; l < peaks.length; l++) {
          if (pipeByLbl[l] || !blobAreas[l]) continue;
          if (blobAreas[l] >= unownedFloor && peaks[l] >= MIN_PEAK) { unownedLbl.add(l); unownedArea += blobAreas[l]; }
        }
        const unownedSeeds = [];
        if (unownedLbl.size) {
          const need = new Set(unownedLbl);
          for (let i = 0; i < bl.length && need.size; i++) {
            const l = bl[i];
            if (need.has(l)) { need.delete(l); unownedSeeds.push([i % w, (i / w) | 0]); }
          }
        }
        const unownedBlobs = unownedLbl.size;
        const lowAreaS = lowRegs.reduce((a, g) => a + g.area, 0);
        const explainedFrac = totalFgS ? 1 - (lowAreaS + unownedArea) / totalFgS : 1;
        const reasons = [];
        if (lowRegs.length) reasons.push(`low-conf(${lowRegs.length})`);
        if (oversized.length) reasons.push(`oversized(${oversized.length})`);
        if (unownedBlobs) reasons.push(`unowned(${unownedBlobs})`);
        if (explainedFrac < 0.65) reasons.push(`explained(${explainedFrac.toFixed(2)})`);
        const fired = lowRegs.length > 0 || oversized.length > 0 || unownedBlobs > 0
          || explainedFrac < 0.65;
        // PER-BLOB ROUTING (hidden-contact signature). A multi-unit blob of
        // an ELONGATED template whose boundary sheds at most 2*units-2 cap
        // clusters is hiding at least one cap pair in a flush contact —
        // exactly the geometry where the watershed partition can absorb a
        // whole pill while every per-cell audit stays green (r-7ff7fd99
        // blob 11: 4 clusters for units=3, per-cell areas 0.87-0.90x
        // implied, residuals 0.041-0.053 — truth 4; the correctly-counted
        // neighbours read 6 clusters for 3 and 4 for 2). Those blobs are
        // routed to the stamp with their regions DEMOTED from anchor
        // (env.noAnchor) and their arbitration is RAISE-ONLY
        // (env.raiseOnly): the routing hypothesis is under-count, so the
        // stamp may only add, never lower.
        const routedRegs = [];
        if (arcInfoByBlob.size) {
          const regsByLblR = new Map();
          for (const g of regions) {
            const l = lblAt(g.cx, g.cy);
            if (!regsByLblR.has(l)) regsByLblR.set(l, []);
            regsByLblR.get(l).push(g);
          }
          for (const [l, ai] of arcInfoByBlob) {
            if (!ai.elong || ai.clusters <= 0) continue;
            const u = l < pipeByLbl.length ? pipeByLbl[l] : 0;
            if (u < 2) continue;
            const regsL = regsByLblR.get(l) || [];
            if (!regsL.length) continue;
            // regions the pipeline actively certified stay out of this path
            if (regsL.some((g) => witS(g) || g.confidence === 'low')) continue;
            if (ai.clusters <= 2 * u - 2) routedRegs.push(...regsL);
          }
        }
        if (routedRegs.length) reasons.push(`hidden-contact(${routedRegs.length})`);
        // OFFLINE ONLY (whole-image sweep observation). Forces the stamp's env
        // construction + calibration to run on images the router would skip,
        // so a sweep can be scored against photos the pipeline believes it
        // already understands. Never set in production; when unset this
        // expression is exactly the original condition.
        const forceStamp = !!opts.forceStamp;
        if (!fired && !routedRegs.length && !forceStamp) {
          opts.debug?.({ stage: 'stamp', fired: false, reason: 'strong-evidence',
            before: count, after: count,
            explained: { frac: +explainedFrac.toFixed(3), cover: +cover.toFixed(3) },
            ms: Date.now() - tS0 });
        } else {
          // heavy inputs, built only on fired images
          const lumaS = new Float32Array(w * h);
          const sd = src.data;
          for (let i = 0; i < w * h; i++) lumaS[i] = 0.299 * sd[i * 4] + 0.587 * sd[i * 4 + 1] + 0.114 * sd[i * 4 + 2];
          const fgFinalS = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) fgFinalS[i] = bwd[i] ? 1 : 0;
          const fgOtsuS = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) fgOtsuS[i] = stampOtsu[i] ? 1 : 0;
          const iw = srcImageFull.width, ih = srcImageFull.height, idat = srcImageFull.data;
          const sampleRGBS = (x, y) => {
            let cr = 0, cg = 0, cb = 0, n = 0;
            for (let dy = -4; dy <= 4; dy += 4) for (let dx = -4; dx <= 4; dx += 4) {
              const X = Math.min(iw - 1, Math.max(0, Math.round((x + dx) * iw / w)));
              const Y = Math.min(ih - 1, Math.max(0, Math.round((y + dy) * ih / h)));
              const i = (Y * iw + X) * 4; cr += idat[i]; cg += idat[i + 1]; cb += idat[i + 2]; n++;
            }
            return [cr / n, cg / n, cb / n];
          };
          // CHROMATIC RESCUE INPUT (glare-mask rescue). Glare/deep shadow can
          // erase a pill's mask material below every witness's floor — the
          // shiny beads and the cream-caplet periphery both lose whole pills
          // this way, and no amount of stamping the FINAL mask can recover
          // material that is not there. The chromaticity-residual map
          // (chromaticDistance) was measured to produce near-perfect bead
          // masks exactly where colour-distance fails, but applied globally
          // it destroys white-caplet photos — so it is never used to segment.
          // It is handed to the stamp as RESCUE MATERIAL only: stamp.js
          // splices it into the neighbourhood of contested blobs the peel
          // could not explain, re-runs the peel there, and accepts only
          // dossier-verified, raise-only, per-blob wins (retry (d)).
          // Built only when the beige signature is absent (cover >= 0.5 —
          // the purge retries own that side) and something is contested.
          let fgChromaS = null;
          if (cover >= 0.5 && (unownedBlobs > 0 || lowRegs.length > 0 || oversized.length > 0)) {
            const chr = chromaticDistance(cv, src);
            cv.GaussianBlur(chr, chr, new cv.Size(5, 5), 0);
            const cbw = new cv.Mat();
            cv.threshold(chr, cbw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
            // a chroma map that floods the frame is reading texture, not pills
            const chrFrac = cv.countNonZero(cbw) / (w * h);
            if (chrFrac > 0 && chrFrac < 0.5) {
              fgChromaS = new Uint8Array(w * h);
              const cd2 = cbw.data;
              for (let i = 0; i < w * h; i++) fgChromaS[i] = cd2[i] ? 1 : 0;
            }
            opts.debug?.({ stage: 'chroma-input', frac: +chrFrac.toFixed(3), used: !!fgChromaS });
            chr.delete(); cbw.delete();
          }
          // HIGH-CONTRAST RESCUE INPUT. Built only when the pipeline shows the
          // majority-pill refine signature (the refine kept the board and shed
          // the pills) AND the stamp router already judged the evidence weak.
          // Both conditions are pipeline-distress signals measured upstream —
          // this never fires on a photo the pipeline handled cleanly. The mask
          // itself is self-calibrating (see highContrastMask); it is passed as
          // RESCUE MATERIAL and must out-explain the final mask to be adopted.
          let fgHCS = null;
          if (refineInverted) {
            const hcm = highContrastMask(cv, srcPreFlat, opts.debug);
            if (hcm) {
              const hcFrac = cv.countNonZero(hcm) / (w * h);
              // A mask that floods or empties the frame is reading the surface,
              // not the pills — same guard the chroma input uses.
              if (hcFrac > 0.005 && hcFrac < 0.5) {
                fgHCS = new Uint8Array(w * h);
                const hd = hcm.data;
                for (let i = 0; i < w * h; i++) fgHCS[i] = hd[i] ? 1 : 0;
              }
              opts.debug?.({ stage: 'hc-input', frac: +hcFrac.toFixed(3), used: !!fgHCS });
              hcm.delete();
            }
          }
          const verdict = stampArbitrate(cv, {
            w, h, fgFinal: fgFinalS, fgOtsu: fgOtsuS, cover, fgChroma: fgChromaS,
            fgHC: fgHCS,
            luma: lumaS, sampleRGB: sampleRGBS,
            regions, count,
            contestedRegions: lowRegs.concat(oversized, routedRegs),
            noAnchor: routedRegs.length ? new Set(routedRegs) : null,
            raiseOnly: routedRegs.length ? new Set(routedRegs) : null,
            unownedSeeds,
            // Independent scale. The stamp's own radiusEst is the median blob
            // DT peak, which is NOT contact-independent on a fused raft: one
            // blob means the raft's own inradius becomes the pill radius.
            // radiusEst here carries the autocorrelation pitch, measured from
            // the photo's repeating structure rather than from any blob.
            pitchR: radiusEst,
            debug: opts.debug,
            mqProbe: opts.mqProbe,   // offline match-quality validation hook only
          });
          if (verdict && verdict.kernel) stampKernelCard = verdict.kernel;
          const before = count;
          // FABRICATION GUARD. Stress battery: on ruled paper the otsu
          // retry can tile the RULING and fabricate 400 pills for 14. Every
          // legitimate rescue measured to date multiplies the count by at
          // most ~2.2x (beige 41 -> 90); a verdict beyond 3x + 8 is the
          // stamp counting the board, and the whole arbitration is refused.
          if (verdict && verdict.kernel) stampKernelUsed = verdict.kernel;
          if (verdict && verdict.fgUsed && verdict.maskUsed !== 'final') stampFgUsed = verdict.fgUsed;
          const fab = verdict && verdict.changed
            && (before + verdict.countDelta) > 3 * Math.max(1, before) + 8;
          // Under forceStamp the arbitration is OBSERVATION ONLY: on an image
          // the router would have skipped, the stamp's verdict must not be
          // allowed to move the count, or the forced run would no longer be
          // measuring the shipping pipeline. (On images the router WOULD have
          // fired on, `fired||routedRegs` is true and the verdict applies
          // exactly as in production.)
          const observeOnly = forceStamp && !fired && !routedRegs.length;
          if (observeOnly) {
            opts.debug?.({ stage: 'stamp', fired: 'forced-observe',
              before, after: before });
          } else if (fab) {
            opts.debug?.({ stage: 'stamp-reject', kind: 'fabrication',
              before, proposed: before + verdict.countDelta });
          } else if (verdict && verdict.changed) {
            regions = regions.filter((g) => !verdict.remove.has(g)).concat(verdict.add);
            count += verdict.countDelta;
            lowConfidence = regions.reduce((n2, g2) => n2 + (g2.confidence === 'low' ? 1 : 0), 0);
          }
          // DEBUG HONESTY (owner: stage 5 "wipes away a ton of data" — true,
          // and the count no longer flows through that wreckage when the
          // stamp arbitrates. Show the mask the count ACTUALLY used, so the
          // strip stops implying the crumbs did the counting.)
          if (emit && verdict && verdict.fgUsed && verdict.maskUsed && verdict.maskUsed !== 'final') {
            const mu = new Uint8ClampedArray(w * h * 4);
            for (let i2 = 0; i2 < w * h; i2++) {
              const on = verdict.fgUsed[i2];
              mu[i2 * 4] = on ? 60 : 0; mu[i2 * 4 + 1] = on ? 200 : 0;
              mu[i2 * 4 + 2] = on ? 255 : 0; mu[i2 * 4 + 3] = 255;
            }
            emit('mask-used', { data: mu, width: w, height: h });
          }
          opts.debug?.({ stage: 'stamp', fired: true, reason: reasons.join('+'),
            before, after: count,
            explained: { frac: +explainedFrac.toFixed(3), cover: +cover.toFixed(3),
              stampExpl: verdict ? +verdict.expl.toFixed(3) : null },
            maskUsed: verdict ? verdict.maskUsed : 'none',
            notes: verdict ? `${verdict.maskNote || ''}${verdict.retried || ''}${verdict.edgeNote || ''}` : '',
            ms: Date.now() - tS0 });
        }
      }

      // GEOMETRY STAGE (owner: "i want to see that you know what the shape
      // is"). Draw every fitted outline back onto the photo — singles from
      // their template fit, clump members from their placements — as a
      // first-class debug stage beside mask/markers. Green = confident,
      // amber = flagged. This is the render-and-verify layer made visible.
      if (emit) {
        const g8 = new Uint8ClampedArray(src.data);
        const putPx = (x, y, rr2, gg, bb) => {
          const xi = x | 0, yi = y | 0;
          if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return;
          for (let a2 = -1; a2 <= 0; a2++) for (let b2 = -1; b2 <= 0; b2++) {
            const i2 = ((yi + a2) * w + (xi + b2)) * 4;
            g8[i2] = rr2; g8[i2 + 1] = gg; g8[i2 + 2] = bb; g8[i2 + 3] = 255;
          }
        };
        const stadium = (cx, cy, major, minor, th, ok) => {
          const a2 = Math.max(0, (major - minor) / 2), rho = minor / 2;
          const c2 = Math.cos(th), s2 = Math.sin(th);
          for (let k2 = 0; k2 < 160; k2++) {
            const phi = k2 * Math.PI * 2 / 160;
            const cc = Math.abs(Math.cos(phi)), ss = Math.abs(Math.sin(phi));
            let R;
            if (ss < 1e-6) R = a2 + rho;
            else { const r1 = rho / ss; R = (r1 * cc <= a2) ? r1 : a2 * cc + Math.sqrt(Math.max(0, a2 * a2 * cc * cc - a2 * a2 + rho * rho)); }
            const lx = Math.cos(phi) * R, ly = Math.sin(phi) * R;
            putPx(cx + lx * c2 - ly * s2, cy + lx * s2 + ly * c2,
              ok ? 40 : 255, ok ? 220 : 176, ok ? 120 : 32);
          }
        };
        for (const r of regions) {
          const ok = r.confidence !== 'low';
          if (r.pills && r.pills.length) {
            for (const p2 of r.pills) stadium(p2.cx, p2.cy, p2.major, p2.minor, p2.theta, ok && p2.valid !== 0);
          } else if (r.shape) {
            stadium(r.cx, r.cy, r.shape.major, r.shape.minor, r.shape.theta, ok);
          }
        }
        emit('geometry', { data: g8, width: w, height: h });
        // ...and AGAIN after per-pill placement lands (see below). This stage
        // runs before PLACE AGREED CLUMPS, so a clump could only ever draw
        // its region ellipse — which is why a 14-pill cluster rendered as
        // ONE GIANT CIRCLE while its 14 Lloyd placements sat unused on the
        // region. Re-render once the placements exist.
        deferredGeometry = () => {
          const g9 = new Uint8ClampedArray(src.data);
          const putPx9 = (x, y, rr2, gg, bb) => {
            const xi = x | 0, yi = y | 0;
            if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return;
            for (let a2 = -1; a2 <= 0; a2++) for (let b2 = -1; b2 <= 0; b2++) {
              const i2 = ((yi + a2) * w + (xi + b2)) * 4;
              g9[i2] = rr2; g9[i2 + 1] = gg; g9[i2 + 2] = bb; g9[i2 + 3] = 255;
            }
          };
          const stadium9 = (cx, cy, major, minor, th, ok) => {
            const a2 = Math.max(0, (major - minor) / 2), rho = minor / 2;
            const c2 = Math.cos(th), s2 = Math.sin(th);
            for (let k2 = 0; k2 < 160; k2++) {
              const phi = k2 * Math.PI * 2 / 160;
              const cc = Math.abs(Math.cos(phi)), ss = Math.abs(Math.sin(phi));
              let R;
              if (ss < 1e-6) R = a2 + rho;
              else { const r1 = rho / ss; R = (r1 * cc <= a2) ? r1 : a2 * cc + Math.sqrt(Math.max(0, a2 * a2 * cc * cc - a2 * a2 + rho * rho)); }
              const lx = Math.cos(phi) * R, ly = Math.sin(phi) * R;
              putPx9(cx + lx * c2 - ly * s2, cy + lx * s2 + ly * c2,
                ok ? 40 : 255, ok ? 220 : 176, ok ? 120 : 32);
            }
          };
          for (const r of regions) {
            const ok = r.confidence !== 'low';
            if (r.pills && r.pills.length) {
              for (const p2 of r.pills) stadium9(p2.cx, p2.cy, p2.major, p2.minor, p2.theta, ok && p2.valid !== 0);
            } else if (r.shape) {
              stadium9(r.cx, r.cy, r.shape.major, r.shape.minor, r.shape.theta, ok);
            }
          }
          emit('geometry', { data: g9, width: w, height: h });
        };

        // TEMPLATE CARD (owner: "the debug needs to show the median /
        // assumed pill shape/stamp, to prove you understand what the pill
        // looks like"). Left: up to four vouched single pills CUT OUT of
        // this very photo, each wearing its fitted outline. Right: the
        // solid stamp silhouette actually used for placement, at true
        // scale. If the silhouette does not look like the cutouts, the
        // template is wrong and every downstream count inherits it — this
        // card makes that failure visible in one glance.
        {
          const singles2 = regions
            .filter((g2) => (g2.units || 1) === 1 && g2.shape && g2.shape.residual <= 0.12)
            .sort((a2, b2) => a2.shape.residual - b2.shape.residual)
            .slice(0, 4);
          const tMaj = median(singles2.map((g2) => g2.shape.major)) || 40;
          const tMin = median(singles2.map((g2) => g2.shape.minor)) || 18;
          const cell = Math.min(220, Math.max(46, Math.ceil(tMaj * 1.35)));
          const cardW = cell * (singles2.length + 1) + 8, cardH = cell + 8;
          const card = new Uint8ClampedArray(cardW * cardH * 4);
          for (let i2 = 0; i2 < cardW * cardH; i2++) {
            card[i2 * 4] = 16; card[i2 * 4 + 1] = 20; card[i2 * 4 + 2] = 24; card[i2 * 4 + 3] = 255;
          }
          const putC = (x, y, rr2, gg, bb) => {
            const xi = x | 0, yi = y | 0;
            if (xi < 0 || yi < 0 || xi >= cardW || yi >= cardH) return;
            const i2 = (yi * cardW + xi) * 4;
            card[i2] = rr2; card[i2 + 1] = gg; card[i2 + 2] = bb;
          };
          singles2.forEach((g2, k2) => {
            const ox = 4 + k2 * cell, oy = 4;
            // photo cutout centered in the cell
            for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
              const sx2 = (g2.cx - cell / 2 + dx) | 0, sy2 = (g2.cy - cell / 2 + dy) | 0;
              if (sx2 < 0 || sy2 < 0 || sx2 >= w || sy2 >= h) continue;
              const si2 = (sy2 * w + sx2) * 4;
              putC(ox + dx, oy + dy, src.data[si2], src.data[si2 + 1], src.data[si2 + 2]);
            }
            // fitted outline over the cutout
            const a2 = Math.max(0, (g2.shape.major - g2.shape.minor) / 2), rho = g2.shape.minor / 2;
            const c2 = Math.cos(g2.shape.theta), s2 = Math.sin(g2.shape.theta);
            for (let k3 = 0; k3 < 140; k3++) {
              const phi = k3 * Math.PI * 2 / 140;
              const cc = Math.abs(Math.cos(phi)), ss = Math.abs(Math.sin(phi));
              let R;
              if (ss < 1e-6) R = a2 + rho;
              else { const r1 = rho / ss; R = (r1 * cc <= a2) ? r1 : a2 * cc + Math.sqrt(Math.max(0, a2 * a2 * cc * cc - a2 * a2 + rho * rho)); }
              const lx = Math.cos(phi) * R, ly = Math.sin(phi) * R;
              putC(ox + cell / 2 + lx * c2 - ly * s2, oy + cell / 2 + lx * s2 + ly * c2, 40, 220, 120);
            }
          });
          // the stamp silhouette, solid, at true scale. When the arbiter
          // learned a data-driven kernel (pentagons, scored tablets...),
          // show THAT shape — the parametric stadium would be a lie about
          // what was actually stamped.
          {
            const ox = 4 + singles2.length * cell, oy = 4;
            const kk = stampKernelCard;
            if (kk && kk.grid) {
              for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
                const u = dx - cell / 2, v = dy - cell / 2;
                const gx2 = Math.floor((u / (kk.KSPAN * kk.maj) + 0.5) * kk.KG);
                const gy2 = Math.floor((v / (kk.KSPAN * kk.min) + 0.5) * kk.KG);
                if (gx2 < 0 || gy2 < 0 || gx2 >= kk.KG || gy2 >= kk.KG) continue;
                if (kk.grid[gy2 * kk.KG + gx2]) putC(ox + dx, oy + dy, 255, 176, 32);
              }
            } else {
              const a2 = Math.max(0, (tMaj - tMin) / 2), rho = tMin / 2;
              for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
                const u = dx - cell / 2, v = dy - cell / 2;
                const du = Math.max(0, Math.abs(u) - a2);
                if (du * du + v * v <= rho * rho) putC(ox + dx, oy + dy, 255, 176, 32);
              }
            }
          }
          emit('template', { data: card, width: cardW, height: cardH });

          // MATCH MAP (owner: "try to overlay [the expected shape] on the
          // images to see where it is matched"). The learned kernel — or
          // the stadium template when no kernel was learned — scored at
          // every position over the surface the count actually used.
          // Bright green = the expected pill fits here. Peaks should sit on
          // pills and nowhere else; a peak on board is a phantom-in-waiting,
          // a pill with no peak is a miss-in-waiting.
          {
            // Fallback surface = the colour-distance cut, NOT activeMd>0:
            // watershed gives the BACKGROUND a label too, so activeMd>0 is
            // ~the whole frame (first render: solid green everywhere).
            const surf = stampFgUsed
              || (() => { const f2 = new Uint8Array(w * h); const db2 = distBg.data;
                   for (let i2 = 0; i2 < w * h; i2++) f2[i2] = db2[i2] > otsuThr ? 1 : 0;
                   return f2; })();
            // sample points: kernel grid if learned, else stadium
            const pts2 = [];
            if (stampKernelUsed && stampKernelUsed.grid) {
              const kg = stampKernelUsed.grid, KG = stampKernelUsed.KG, SPAN = stampKernelUsed.KSPAN;
              const step2 = Math.max(1, (KG / 9) | 0);
              for (let gy = 0; gy < KG; gy += step2) for (let gx = 0; gx < KG; gx += step2) {
                if (kg[gy * KG + gx]) pts2.push([(gx / KG - 0.5) * SPAN, (gy / KG - 0.5) * SPAN]);
              }
            } else {
              const a3 = Math.max(0, (tMaj - tMin) / 2), rho3 = tMin / 2;
              const st3 = Math.max(2, tMin / 6);
              for (let u = -tMaj / 2; u <= tMaj / 2; u += st3) for (let v = -tMin / 2; v <= tMin / 2; v += st3) {
                const du = Math.max(0, Math.abs(u) - a3);
                if (du * du + v * v <= rho3 * rho3) pts2.push([u, v]);
              }
            }
            // 12 rotations, not 6: at 30-degree steps a capsule lying 15
            // degrees off every sample loses enough coverage to fall under
            // the bar, which is why isolated pills at arbitrary angles went
            // unmarked while stage 8 outlined them perfectly. 15-degree
            // steps bound the worst-case mismatch at 7.5 degrees.
            const rots = (tMaj / Math.max(1, tMin)) < 1.15
              ? [0, Math.PI / 5]
              : Array.from({ length: 12 }, (_, k3) => k3 * Math.PI / 12);
            const stride3 = Math.max(3, (tMin / 5) | 0);
            const heat = new Float32Array(w * h);
            const thMap = new Float32Array(w * h);
            let hMax = 0;
            for (let y = 0; y < h; y += stride3) for (let x = 0; x < w; x += stride3) {
              if (!surf[y * w + x]) continue;
              let best3 = 0, bth3 = 0;
              for (const th3 of rots) {
                const c3 = Math.cos(th3), s3 = Math.sin(th3);
                let inF = 0;
                for (const [u, v] of pts2) {
                  const xi = (x + u * c3 - v * s3) | 0, yi = (y + u * s3 + v * c3) | 0;
                  if (xi >= 0 && yi >= 0 && xi < w && yi < h && surf[yi * w + xi]) inF++;
                }
                const sc3 = inF / pts2.length;
                if (sc3 > best3) { best3 = sc3; bth3 = th3; }
              }
              heat[y * w + x] = best3;
              thMap[y * w + x] = bth3;
              if (best3 > hMax) hMax = best3;
            }
            const mmap = new Uint8ClampedArray(w * h * 4);
            for (let i2 = 0; i2 < w * h; i2++) {
              const p2 = i2 * 4;
              mmap[p2] = src.data[p2] * 0.30; mmap[p2 + 1] = src.data[p2 + 1] * 0.30;
              mmap[p2 + 2] = src.data[p2 + 2] * 0.30; mmap[p2 + 3] = 255;
            }
            // Raw coverage saturates inside piles (everything "fits" when
            // fully surrounded) — the diagnostic form is PEAKS: local maxima
            // at pill spacing, each drawn as the expected outline. Expect
            // one outline per pill; an outline on board = phantom risk, a
            // pill without one = miss risk.
            if (hMax > 0) {
              // width-only separation over-suggests along a capsule's axis;
              // geometric mean respects elongation (round: ~= tMin anyway)
              const sep = Math.max(4, (Math.sqrt(tMaj * tMin) * 0.8) | 0);
              // BAR CALIBRATED FROM THIS PHOTO'S OWN COUNTED PILLS, not
              // assumed. Measured on r-7ff7fd99: coverage at the twenty
              // hand-annotated TRUE centres ranges 0.63-0.95, because the
              // mask erodes each pill slightly and a template-sized stamp
              // therefore never reaches 1.0 on an isolated pill. A fixed
              // 0.75 cut dropped exactly the six pills scoring below it —
              // precisely the six marks missing from the render while
              // stage 8 outlined them perfectly. Take the counted
              // placements' own coverage and sit below their weakest.
              let BAR = 0.6;
              {
                const selfCov = [];
                for (const g2 of regions) {
                  const list = (g2.pills && g2.pills.length) ? g2.pills
                    : (g2.shape ? [{ cx: g2.cx, cy: g2.cy, theta: g2.shape.theta }] : []);
                  for (const q2 of list) {
                    const c4 = Math.cos(q2.theta), s4 = Math.sin(q2.theta);
                    let on = 0;
                    for (const [u, v] of pts2) {
                      const xi = (q2.cx + u * c4 - v * s4) | 0, yi = (q2.cy + u * s4 + v * c4) | 0;
                      if (xi >= 0 && yi >= 0 && xi < w && yi < h && surf[yi * w + xi]) on++;
                    }
                    selfCov.push(on / Math.max(1, pts2.length));
                  }
                }
                if (selfCov.length >= 4) {
                  selfCov.sort((x2, y2) => x2 - y2);
                  BAR = Math.max(0.45, selfCov[(selfCov.length * 0.1) | 0] * 0.95);
                }
              }
              const peaks2 = [];
              for (let y = 0; y < h; y += stride3) for (let x = 0; x < w; x += stride3) {
                const v3 = heat[y * w + x];
                if (v3 < BAR) continue;
                let isMax = true;
                for (let dy = -sep; dy <= sep && isMax; dy += stride3) for (let dx = -sep; dx <= sep; dx += stride3) {
                  const xi = x + dx, yi = y + dy;
                  if (xi < 0 || yi < 0 || xi >= w || yi >= h || (dx === 0 && dy === 0)) continue;
                  if (heat[yi * w + xi] > v3) { isMax = false; break; }
                }
                if (isMax) peaks2.push([x, y]);
              }
              // greedy min-separation cull (grid maxima tie on plateaus).
              // Sort by score first: keeping scan-order winners left two
              // marks on one pill in the reported render.
              peaks2.sort((p1, p2) => heat[p2[1] * w + p2[0]] - heat[p1[1] * w + p1[0]]);
              const kept2 = [];
              for (const [x, y] of peaks2) {
                let ok2 = true;
                for (const [kx, ky] of kept2) if (Math.hypot(x - kx, y - ky) < sep) { ok2 = false; break; }
                if (ok2) kept2.push([x, y]);
              }
              const putM = (x, y) => {
                const xi = x | 0, yi = y | 0;
                if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return;
                for (let a2 = -1; a2 <= 0; a2++) for (let b2 = -1; b2 <= 0; b2++) {
                  const p3 = ((yi + a2) * w + (xi + b2)) * 4;
                  mmap[p3] = 60; mmap[p3 + 1] = 255; mmap[p3 + 2] = 140;
                }
              };
              for (const [x, y] of kept2) {
                // expected outline at the peak, AT ITS WINNING ROTATION,
                // drawn at the SAME dims stage 8 uses so the two stages are
                // directly comparable (they were visibly different sizes).
                const a3 = Math.max(0, (tMaj - tMin) / 2), rho3 = tMin / 2;
                const th4 = thMap[y * w + x], c4 = Math.cos(th4), s4 = Math.sin(th4);
                for (let k3 = 0; k3 < 120; k3++) {
                  const phi = k3 * Math.PI * 2 / 120;
                  const cc = Math.abs(Math.cos(phi)), ss = Math.abs(Math.sin(phi));
                  let R;
                  if (ss < 1e-6) R = a3 + rho3;
                  else { const r1 = rho3 / ss; R = (r1 * cc <= a3) ? r1 : a3 * cc + Math.sqrt(Math.max(0, a3 * a3 * cc * cc - a3 * a3 + rho3 * rho3)); }
                  const lx = Math.cos(phi) * R, ly = Math.sin(phi) * R;
                  putM(x + lx * c4 - ly * s4, y + lx * s4 + ly * c4);
                }
                putM(x, y); putM(x + 1, y); putM(x, y + 1);
              }
            }
            emit('matchmap', { data: mmap, width: w, height: h });
          }
          const primCounts = {};
          for (const g2 of singles2) primCounts[g2.shape.primitive] = (primCounts[g2.shape.primitive] || 0) + 1;
          const domPrim = Object.entries(primCounts).sort((x2, y2) => y2[1] - x2[1])[0];
          out2Template = {
            primitive: domPrim ? domPrim[0] : 'stadium',
            major: +tMaj.toFixed(1), minor: +tMin.toFixed(1),
            aspect: +(tMaj / Math.max(1, tMin)).toFixed(2),
            fromSingles: singles2.length,
          };
        }
      }
    }

    // OVERLAY HONESTY. `boundaries` used to be every watershed -1 pixel —
    // the WATERSHED-TIME partition. Regions later merged or discarded by
    // consolidation/vetoes left their cut-lines in the overlay, rendering
    // scraggly borders on top of pills where no counted region exists, and
    // the debug reader took them for claimed pill boundaries. Keep only the
    // ridge pixels that touch at least one FINAL region's label; if label
    // derivation found nothing (rare non-watershed paths), fall back to the
    // full ridge set rather than blanking the overlay.
    if (withOverlay && activeMd) {
      const finalLbls = new Set();
      for (const r of regions) if (r.label != null) finalLbls.add(r.label);
      boundaries = new Uint8Array(activeMd.length);
      for (let i = 0; i < activeMd.length; i++) {
        if (activeMd[i] !== -1) continue;
        if (!finalLbls.size) { boundaries[i] = 1; continue; }
        const x = i % w;
        if ((x > 0 && finalLbls.has(activeMd[i - 1]))
          || (x < w - 1 && finalLbls.has(activeMd[i + 1]))
          || (i >= w && finalLbls.has(activeMd[i - w]))
          || (i + w < activeMd.length && finalLbls.has(activeMd[i + w]))) {
          boundaries[i] = 1;
        }
      }
    }

    // PLACE AGREED CLUMPS + ENFORCE PHYSICS (output-only; counts are settled).
    //
    // 1) PLACEMENT PARITY. The seam router attaches per-pill placements only
    //    to clumps whose count it re-partitioned. Clumps whose count was
    //    never in dispute stayed as bare "units: k" regions — drawn as a
    //    yellow ring, never as pills. Measured on the exact-tangency angle
    //    sweep: counts are 8/8 at EVERY contact angle, but parallel-flush
    //    pairs place 4/8 — counted, never placed. Every multi-pill region now
    //    gets placements: fixed-k Lloyd over the region's own pixels, seeded
    //    along its principal axis, template-sized from the photo's singles.
    //
    // 2) RIGID BODIES. The owner: "pills would be touching but not on top of
    //    each other — there's no intersection." A capsule is a line segment
    //    with radius, so interpenetration is EXACT: segment distance < sum of
    //    half-widths. First audit found 8 violating pairs (worst 6.1px) in
    //    shipped placements. A relaxation pass pushes violators apart along
    //    the contact normal; singles stay anchored (their own blob is the
    //    evidence for where they are), only clump members move.
    if (regions.length && activeMd) {
      const singlesG = regions.filter((g) => (g.units || 1) === 1 && g.shape);
      const tMajor = median(singlesG.map((g) => g.shape.major)) || 40;
      const tMinor = median(singlesG.map((g) => g.shape.minor)) || tMajor * 0.45;

      // pixels per label, one pass, only for labels that need placing
      const needPlace = regions.filter((g) => (g.units || 1) >= 2 && !(g.pills && g.pills.length) && g.label != null);
      if (needPlace.length) {
        const wantLbl = new Map(needPlace.map((g) => [g.label, []]));
        for (let i = 0; i < activeMd.length; i++) {
          const arr = wantLbl.get(activeMd[i]);
          if (arr) arr.push(i);
        }
        for (const g of needPlace) {
          const idx = wantLbl.get(g.label);
          if (!idx || idx.length < 40) continue;
          const k = g.units;
          const pxs = idx.map((i) => [i % w, (i / w) | 0]);
          // principal axis for seeding
          let mx = 0, my = 0;
          for (const [x, y] of pxs) { mx += x; my += y; }
          mx /= pxs.length; my /= pxs.length;
          let sxx = 0, sxy = 0, syy = 0;
          for (const [x, y] of pxs) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
          const th0 = 0.5 * Math.atan2(2 * sxy, sxx - syy);
          // A k-pill blob can be near-square (two horizontal pills stacked
          // vertically), making the principal axis a coin flip — seeding
          // along the wrong one splits every pill in half and every cell's
          // orientation comes out 90 degrees wrong (field report: vertical
          // capsules drawn over horizontal pills). So run Lloyd from BOTH
          // candidate axes and let the photo choose: score each partition by
          // its cells' interiors at TEMPLATE dims — a wrong-orientation
          // template sticks out of the pill material and samples background,
          // scoring visibly lower. Same render-and-verify principle as
          // everywhere else; no constant involved.
          const runLloyd = (axTheta) => {
            const ux = Math.cos(axTheta), uy = Math.sin(axTheta);
            let lo = Infinity, hi = -Infinity;
            for (const [x, y] of pxs) { const t = (x - mx) * ux + (y - my) * uy; if (t < lo) lo = t; if (t > hi) hi = t; }
            // SEEDING. The line seeding below is right for a CHAIN of pills
            // (a 1-D run along one axis) and catastrophic for a compact raft:
            // it drops all k seeds on a single straight line through the
            // centroid, so on a blob that is nearly as tall as it is wide the
            // seeds start within a few pixels of each other and Lloyd
            // converges to a degenerate partition — every centroid at the
            // centre of mass.
            //
            // Measured on synth2-rc-noise-small-n12-t65-s199 region 9: the
            // blob's unit count is CORRECT (claims 8, truly holds 8), yet all
            // eight placements landed in a 24x27px box — smaller than one
            // 27.6x27.2 pill — while the real pills were spread across the
            // raft. The count was right and the picture was nonsense.
            //
            // So seed by farthest-point sampling over the blob's own pixels
            // (k-means++ style, deterministic): take the pixel farthest from
            // the centroid, then repeatedly the pixel farthest from every seed
            // chosen so far. On a chain this reproduces the line; on a raft it
            // spreads into 2-D, which is the case that was broken.
            const spanT = hi - lo;
            const ext = (() => {           // extent perpendicular to the axis
              let plo = Infinity, phi = -Infinity;
              for (const [x, y] of pxs) {
                const s2 = -(x - mx) * uy + (y - my) * ux;
                if (s2 < plo) plo = s2; if (s2 > phi) phi = s2;
              }
              return phi - plo;
            })();
            let C;
            // A blob is "chain-like" when it is much longer than it is wide;
            // only then does a line of seeds describe where the pills are.
            if (spanT > 2.2 * ext || k <= 2) {
              C = Array.from({ length: k }, (_, i) => {
                const t = lo + spanT * (i + 0.5) / k;
                return [mx + ux * t, my + uy * t];
              });
            } else {
              // Grid seeding, not farthest-point. Farthest-point drives every
              // seed to the blob's EXTREMES, which is wrong for the pills in
              // the middle of a raft (measured: s172 got worse, 27 -> 38
              // overlapping pairs). A raft of same-size discs is close to a
              // regular packing, so lay seeds on a grid over the blob's
              // bounding box in its own axis frame, keep only cells that
              // contain blob pixels, and take the nearest actual pixel to each
              // — spread by construction, and always ON the blob.
              const cols = Math.max(1, Math.round(Math.sqrt(k * Math.max(spanT, 1) / Math.max(ext, 1))));
              const rows2 = Math.max(1, Math.ceil(k / cols));
              let plo = Infinity;
              for (const [x, y] of pxs) {
                const s3 = -(x - mx) * uy + (y - my) * ux;
                if (s3 < plo) plo = s3;
              }
              const cand = [];
              for (let gy = 0; gy < rows2; gy++) for (let gx = 0; gx < cols; gx++) {
                const t = lo + spanT * (gx + 0.5) / cols;
                const s3 = plo + ext * (gy + 0.5) / rows2;
                const px2 = mx + ux * t - uy * s3, py2 = my + uy * t + ux * s3;
                let bp = null, bd = Infinity;
                for (const p of pxs) {
                  const d2 = (p[0] - px2) ** 2 + (p[1] - py2) ** 2;
                  if (d2 < bd) { bd = d2; bp = p; }
                }
                if (bp) cand.push({ p: bp, d: bd });
              }
              // prefer cells whose centre actually landed on the blob
              cand.sort((a2, b2) => a2.d - b2.d);
              C = [];
              for (const c of cand) {
                if (C.length >= k) break;
                if (C.some((q) => (q[0] - c.p[0]) ** 2 + (q[1] - c.p[1]) ** 2 < 4)) continue;
                C.push([c.p[0], c.p[1]]);
              }
              while (C.length < k) C.push([mx, my]);
            }
            const asg = new Array(pxs.length).fill(0);
            for (let it = 0; it < 18; it++) {
              let moved = false;
              for (let i = 0; i < pxs.length; i++) {
                let b = 0, bd = Infinity;
                for (let c = 0; c < k; c++) {
                  const d2 = (pxs[i][0] - C[c][0]) ** 2 + (pxs[i][1] - C[c][1]) ** 2;
                  if (d2 < bd) { bd = d2; b = c; }
                }
                if (asg[i] !== b) { asg[i] = b; moved = true; }
              }
              const sum = Array.from({ length: k }, () => [0, 0, 0]);
              for (let i = 0; i < pxs.length; i++) { const s2 = sum[asg[i]]; s2[0] += pxs[i][0]; s2[1] += pxs[i][1]; s2[2]++; }
              for (let c = 0; c < k; c++) if (sum[c][2]) C[c] = [sum[c][0] / sum[c][2], sum[c][1] / sum[c][2]];
              // SEPARATION CONSTRAINT — the physics Lloyd cannot know.
              // Plain Lloyd partitions by DISTANCE ONLY, so nothing stops two
              // centroids from collapsing onto the same bright lump; on a
              // dense raft that is exactly what happens, and the result is k
              // outlines stacked on one pill while real pills go unclaimed.
              // But these are rigid same-size discs: two pill CENTRES can
              // never be closer than one pill width. Enforcing that during
              // the iteration is not a heuristic, it is the object model.
              const sep = tMinor * 0.92;   // touching is legal, closer is not
              for (let a3 = 0; a3 < k; a3++) for (let b3 = a3 + 1; b3 < k; b3++) {
                let dx3 = C[b3][0] - C[a3][0], dy3 = C[b3][1] - C[a3][1];
                let d3 = Math.hypot(dx3, dy3);
                if (d3 >= sep) continue;
                if (d3 < 1e-6) { dx3 = Math.cos(a3 * 2.399); dy3 = Math.sin(a3 * 2.399); d3 = 1; }
                const push = (sep - d3) / 2 / d3;
                C[a3][0] -= dx3 * push; C[a3][1] -= dy3 * push;
                C[b3][0] += dx3 * push; C[b3][1] += dy3 * push;
              }
              if (!moved) break;
            }
            // RECLAIM STARVED CELLS. The separation push can shove a centroid
            // off its own blob, where it wins no pixels and its pill is then
            // silently dropped by the n<15 filter below — the count says N but
            // only N-2 outlines are drawn, and the missing pills read as
            // misses. Pull any starved centroid back to the blob pixel that is
            // farthest from every healthy centroid: the emptiest real estate,
            // which is where an unclaimed pill actually is.
            {
              const cnt2 = new Array(k).fill(0);
              for (let i = 0; i < pxs.length; i++) cnt2[asg[i]]++;
              for (let c = 0; c < k; c++) {
                if (cnt2[c] >= 15) continue;
                let bp = null, bd = -1;
                for (const p of pxs) {
                  let nd = Infinity;
                  for (let c2 = 0; c2 < k; c2++) {
                    if (c2 === c || cnt2[c2] < 15) continue;
                    const d2 = (p[0] - C[c2][0]) ** 2 + (p[1] - C[c2][1]) ** 2;
                    if (d2 < nd) nd = d2;
                  }
                  if (nd > bd) { bd = nd; bp = p; }
                }
                // Respect the same separation the iteration enforces: a
                // reclaimed centroid dropped at the farthest pixel with no
                // spacing check simply lands on top of another pill, which is
                // how s111 kept 14 stacked pairs after the constraint went in.
                if (bp && bd >= (tMinor * 0.92) ** 2) C[c] = [bp[0], bp[1]];
              }
              // one settling pass so the reclaimed cells own their pixels
              for (let i = 0; i < pxs.length; i++) {
                let b = 0, bd2 = Infinity;
                for (let c = 0; c < k; c++) {
                  const d2 = (pxs[i][0] - C[c][0]) ** 2 + (pxs[i][1] - C[c][1]) ** 2;
                  if (d2 < bd2) { bd2 = d2; b = c; }
                }
                asg[i] = b;
              }
            }
            const cs2 = Array.from({ length: k }, () => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }));
            for (let i = 0; i < pxs.length; i++) {
              const a2 = cs2[asg[i]], [x, y] = pxs[i];
              a2.n++; a2.sx += x; a2.sy += y; a2.sxx += x * x; a2.sxy += x * y; a2.syy += y * y;
            }
            const pills2 = [];
            for (const a2 of cs2) {
              if (a2.n < 15) continue;
              const cx = a2.sx / a2.n, cy = a2.sy / a2.n;
              const cxx = a2.sxx / a2.n - cx * cx, cxy2 = a2.sxy / a2.n - cx * cy, cyy = a2.syy / a2.n - cy * cy;
              const th = 0.5 * Math.atan2(2 * cxy2, cxx - cyy);
              pills2.push({ cx, cy, theta: +th.toFixed(3), major: tMajor, minor: tMinor, photo: 0 });
            }
            let score = 0, bgSum = 0;
            for (const p2 of pills2) {
              const st2 = pillPhotoStats(distBg.data, w, h, p2, otsuThr);
              p2.photo = st2.mean; p2.bgFrac = st2.bgFrac;
              score += st2.mean; bgSum += st2.bgFrac;
            }
            return { pills: pills2, score, bgSum };
          };
          const candA = runLloyd(th0);
          const candB = runLloyd(th0 + Math.PI / 2);
          // Primary criterion: NO background inside the outlines (rigid pills
          // never contain board). Only when both are equally clean does the
          // stronger interior signal decide.
          const winner =
            candB.bgSum < candA.bgSum - 0.05 ? candB :
            candA.bgSum < candB.bgSum - 0.05 ? candA :
            (candB.score > candA.score ? candB : candA);
          const pills = winner.pills;
          if (candA.pills.length && candB.pills.length)
            opts.debug?.({ stage: 'placeaxis', label: g.label, k,
              a: +candA.score.toFixed(1), b: +candB.score.toFixed(1),
              chose: winner === candB ? 'perp' : 'principal' });

          // ---- STAMP-FOOTPRINT FIT (the diagonal-lasso cure) ----
          // MEASURED FAILURE: Lloyd partitions mask pixels BY DISTANCE ONLY.
          // On a fused blob its cells are Voronoi wedges, and a wedge's PCA
          // axis is the WEDGE's shape — not any pill's. On r-7ff7fd99 the
          // k=2 clump's two seeding axes scored 127.2 vs 127.5 (a 0.2%
          // margin — the race is a coin flip), and the winner posed one
          // capsule at 67 degrees, DIAGONALLY ACROSS two near-horizontal
          // caplets. On lined-503b3041's k=14 clump the wedge centroids
          // produced thetas of -370/-299/-159 degrees and centre errors up
          // to 48.6px against hand-annotated truth.
          //
          // THE FIX: stop letting a point-centroid define a cell. Run the
          // same alternating minimisation, but with the TEMPLATE SHAPE as
          // the cell:
          //   assign  — each pixel goes to the placement whose POSED STAMP
          //             FOOTPRINT best contains it (normalised capsule
          //             coordinate), so a cell can never be a wedge;
          //   update  — each placement re-poses (cx, cy, AND theta) by
          //             maximising the SAME fg/bg/seam objective the pose
          //             refiner already uses, over its own assigned pixels.
          // The centroid of a stamp is a stamp, so the fixed point is a
          // tiling of pill-shaped cells rather than a pie of wedges.
          //
          // Kept as a REFINEMENT of the Lloyd winner rather than a
          // replacement: Lloyd's k placements are a fine starting spread,
          // and only the pose is untrustworthy. If the fit fails to improve
          // the objective the Lloyd poses stand, so this can only help.
          // SCOPE OF THE FOOTPRINT FIT — both bounds are measured, not tuned.
          //
          // (a) k === 2. The fit maximises MASK COVERAGE by k template
          //     stamps. Measured against hand-annotated centres, that proxy
          //     tracks truth at k=2 (mean placement error 11.7->7.7 on
          //     r-7ff7fd99, 13.0->7.9 on r-cc7a2ada, 4.3->3.3 on
          //     r-dbe1f2d8) and INVERTS above it: r-f5d11815's k=6 clump
          //     went 8.5->30.6 and lined-503b3041's k=14 went 31.8->37.1
          //     even though the objective rose in every case (93->127.5,
          //     272->317). Above k=2 there are many ways to tile a blob
          //     with k capsules that cover it equally well, and coverage
          //     alone cannot pick the right one. Extending this fit to
          //     larger k needs a per-pill evidence term (cap arcs, kernel
          //     census), not a bigger search — left undone deliberately.
          //
          // (b) The blob must hold k pills. Two touching RIGID pills cannot
          //     occupy one pill's worth of area. s-0bfc44d8's two k=2
          //     clumps measure px/templateArea = 1.03 and 0.99 with exactly
          //     ONE annotated centre each — the count over-split them, and
          //     a coverage fit asked to spread two stamps over one pill's
          //     material drags the one CORRECT placement off its pill
          //     (label 49's best pill went from 1.2px off truth to 6.4px).
          //     Genuine k=2 clumps measure 1.75. Requiring 1.35 sits between
          //     the two populations and, being a geometric consequence of
          //     rigidity, needs no per-image tuning.
          const tplArea = Math.PI * (tMinor / 2) ** 2 + Math.max(0, tMajor - tMinor) * tMinor;
          const areaSupportsK = tplArea > 0 && pxs.length / tplArea >= 1.35;
          if (pills.length === k && k === 2 && areaSupportsK) {
            const halfA = Math.max(1e-3, (tMajor - tMinor) / 2), rhoT = Math.max(1e-3, tMinor / 2);
            // Signed capsule coordinate: 0 at the placement's spine, 1 on
            // its rim. This IS the stamp footprint — the assignment step
            // cannot produce a wedge because the level sets are capsules.
            const capsuleR = (px, py, p2) => {
              const c2 = Math.cos(p2.theta), s3 = Math.sin(p2.theta);
              const dx = px - p2.cx, dy = py - p2.cy;
              let t = dx * c2 + dy * s3;
              const n2 = -dx * s3 + dy * c2;
              if (t > halfA) t -= halfA; else if (t < -halfA) t += halfA; else t = 0;
              return Math.hypot(t, n2) / rhoT;
            };
            // Objective for one pose: mask foreground covered, minus
            // background claimed, minus interior seam samples. Identical in
            // spirit to poseScore below (which runs later and cannot see
            // this loop), so the two passes agree instead of fighting.
            const dbFit = distBg.data;
            // `mine` (optional) is the set of pixel indices this placement
            // owns. Samples that land on mask foreground belonging to a
            // SIBLING placement's cell score as claimed-territory, not as
            // covered pill. Without this the k stamps optimise independently
            // and simply pile onto the same locally-best pocket: measured on
            // r-7ff7fd99's k=2 clump, the free fit doubled the objective
            // (24.5 -> 50.0) by putting BOTH capsules at (156,205)/(159,203).
            // Exclusivity is what makes this a partition instead of k
            // independent searches.
            const fitScore = (cx, cy, th, mine) => {
              const c2 = Math.cos(th), s3 = Math.sin(th);
              const a2 = 0.46 * tMajor, b2 = 0.46 * tMinor;
              let inFg = 0, inBg = 0;
              const lums = [];
              for (let i2 = 0; i2 < 9; i2++) for (let j2 = 0; j2 < 5; j2++) {
                const u = (i2 / 8) * 2 - 1, v = (j2 / 4) * 2 - 1;
                if (u * u + v * v > 1.05) continue;
                const x = (cx + u * a2 * c2 - v * b2 * s3) | 0;
                const y = (cy + u * a2 * s3 + v * b2 * c2) | 0;
                if (x < 0 || y < 0 || x >= w || y >= h) { inBg++; continue; }
                if (activeMd[y * w + x] > 0) {
                  if (mine && !mine.has(y * w + x)) { inBg++; continue; }  // sibling's pixel
                  inFg++; lums.push(dbFit[y * w + x]);
                } else inBg++;
              }
              // A lasso across two pills has the DARK CONTACT SEAM running
              // through its middle: interior samples well below its own
              // median. That is exactly the signal that tells a straddling
              // pose from an honest one, and it is geometric (mask + local
              // contrast), not matchQuality — so it stays trustworthy on
              // lined images where the calibration pool is only ~4 singles
              // and matchQuality is documented to INVERT.
              let seam = 0;
              if (lums.length >= 6) {
                const sl = [...lums].sort((x2, y2) => x2 - y2);
                const medL = sl[sl.length >> 1];
                for (const L of lums) if (L < medL - 15) seam++;
              }
              return inFg - 2 * inBg - 1.5 * seam;
            };
            // ---- SEED: GREEDY STAMP COVER, not an axis sweep ----
            // The axis race is the other half of the bug. It offers exactly
            // two global orientations and asks the photo to pick one; when a
            // blob is two horizontal caplets stacked VERTICALLY, neither
            // candidate is right and the 0.2% score margin on r-7ff7fd99
            // proves the photo could not tell them apart. So seed with no
            // axis assumption at all: repeatedly place the single template
            // pose that claims the most still-unclaimed mask pixels (minus
            // twice the background it would swallow). That is pure shape
            // evidence — where does a pill-shaped thing actually fit — and
            // on r-7ff7fd99's k=2 clump it recovers (160,195)@15deg and
            // (153,211)@15deg against truth (163,196) and (163,216): 3.2px
            // and 11.2px, both near-horizontal like every pill in the photo.
            // Lloyd's answer for the same blob was (159,204)@67deg — the
            // diagonal lasso — and (134,210)@4deg.
            const greedySeed = () => {
              const left = new Set(pxs.map(([x, y]) => y * w + x));
              const out = [];
              // candidate centres: subsample the blob so cost stays linear-ish
              const step = Math.max(1, Math.round(Math.sqrt(pxs.length / 260)));
              const cands = pxs.filter((_, i) => i % step === 0);
              for (let n = 0; n < k; n++) {
                let best = null;
                for (const [cx, cy] of cands) {
                  // NO NEAR-DUPLICATES. Measured on r-f5d11815's k=6 clump:
                  // without this the greedy returned (178,107)+(175,108) both
                  // at 150deg and (183,130)+(183,131) both at 120deg — the
                  // claimed-pixel mask is a slightly smaller footprint than
                  // the gain probe, so a copy shifted by 3px still scored
                  // full gain. Two stamps on one pill is the same lasso
                  // failure wearing different clothes.
                  let tooClose = false;
                  for (const q of out) {
                    const dq = Math.hypot(q.cx - cx, q.cy - cy);
                    if (dq < 0.55 * tMinor) { tooClose = true; break; }
                    // also reject a near-parallel stamp riding the same spine
                    const cq = Math.cos(q.theta), sq = Math.sin(q.theta);
                    const perp = Math.abs(-(cx - q.cx) * sq + (cy - q.cy) * cq);
                    const along = Math.abs((cx - q.cx) * cq + (cy - q.cy) * sq);
                    if (perp < 0.45 * tMinor && along < 0.45 * tMajor) { tooClose = true; break; }
                  }
                  if (tooClose) continue;
                  for (let r2 = 0; r2 < 12; r2++) {
                    const th = r2 * Math.PI / 12;
                    const c2 = Math.cos(th), s3 = Math.sin(th);
                    const a2 = 0.46 * tMajor, b2 = 0.46 * tMinor;
                    let gain = 0, bad = 0;
                    for (let i2 = 0; i2 < 13; i2++) for (let j2 = 0; j2 < 7; j2++) {
                      const u = (i2 / 12) * 2 - 1, v = (j2 / 6) * 2 - 1;
                      if (u * u + v * v > 1.05) continue;
                      const px = Math.round(cx + u * a2 * c2 - v * b2 * s3);
                      const py = Math.round(cy + u * a2 * s3 + v * b2 * c2);
                      if (px < 0 || py < 0 || px >= w || py >= h || activeMd[py * w + px] !== g.label) { bad++; continue; }
                      if (left.has(py * w + px)) gain++;
                    }
                    const sc = gain - 2 * bad;
                    if (!best || sc > best.s) best = { s: sc, cx, cy, theta: th };
                  }
                }
                if (!best) break;
                out.push({ cx: best.cx, cy: best.cy, theta: best.theta });
                const c2 = Math.cos(best.theta), s3 = Math.sin(best.theta);
                const a2 = 0.46 * tMajor, b2 = 0.46 * tMinor;
                for (let i2 = 0; i2 < 25; i2++) for (let j2 = 0; j2 < 13; j2++) {
                  const u = (i2 / 24) * 2 - 1, v = (j2 / 12) * 2 - 1;
                  if (u * u + v * v > 1) continue;
                  const px = Math.round(best.cx + u * a2 * c2 - v * b2 * s3);
                  const py = Math.round(best.cy + u * a2 * s3 + v * b2 * c2);
                  if (px >= 0 && py >= 0 && px < w && py < h) left.delete(py * w + px);
                }
              }
              return out;
            };
            const seeded = greedySeed();
            const fit = seeded.length === k
              ? seeded
              : pills.map((p2) => ({ cx: p2.cx, cy: p2.cy, theta: p2.theta }));
            const own = Array.from({ length: k }, () => []);
            for (let it = 0; it < 6; it++) {
              // -- assign: nearest STAMP FOOTPRINT, not nearest point --
              for (let c = 0; c < k; c++) own[c].length = 0;
              for (let i2 = 0; i2 < pxs.length; i2++) {
                let b = 0, bd = Infinity;
                for (let c = 0; c < k; c++) {
                  const d2 = capsuleR(pxs[i2][0], pxs[i2][1], fit[c]);
                  if (d2 < bd) { bd = d2; b = c; }
                }
                own[b].push(pxs[i2]);
              }
              // -- update: re-pose each stamp on its own pixels --
              let moved = 0;
              for (let c = 0; c < k; c++) {
                const cell = own[c];
                if (cell.length < 12) continue;
                let sx = 0, sy = 0;
                for (const [x, y] of cell) { sx += x; sy += y; }
                const ccx = sx / cell.length, ccy = sy / cell.length;
                const mine = new Set();
                for (const [x, y] of cell) mine.add(y * w + x);
                // Coordinate ascent over (theta, cx, cy) from BOTH the
                // cell's own centroid and the incumbent pose, so a cell that
                // is still malformed early on can be rescued by the photo
                // instead of locking in its first bad guess.
                let best = { s: fitScore(fit[c].cx, fit[c].cy, fit[c].theta, mine), cx: fit[c].cx, cy: fit[c].cy, th: fit[c].theta };
                for (const [sx0, sy0] of [[ccx, ccy], [fit[c].cx, fit[c].cy]]) {
                  for (let r2 = 0; r2 < 12; r2++) {
                    const th = r2 * Math.PI / 12;
                    for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
                      const nx2 = sx0 + ox * 1.5, ny2 = sy0 + oy * 1.5;
                      const sc = fitScore(nx2, ny2, th, mine);
                      if (sc > best.s) best = { s: sc, cx: nx2, cy: ny2, th };
                    }
                  }
                }
                // fine polish around the winner
                for (let r2 = -3; r2 <= 3; r2++) {
                  const th = best.th + r2 * Math.PI / 48;
                  for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
                    const sc = fitScore(best.cx + ox * 0.7, best.cy + oy * 0.7, th, mine);
                    if (sc > best.s) best = { s: sc, cx: best.cx + ox * 0.7, cy: best.cy + oy * 0.7, th };
                  }
                }
                if (Math.hypot(best.cx - fit[c].cx, best.cy - fit[c].cy) > 0.4
                  || Math.abs(best.th - fit[c].theta) > 0.02) moved++;
                fit[c] = { cx: best.cx, cy: best.cy, theta: best.th };
              }
              if (!moved) break;
            }
            // ACCEPT ONLY ON MEASURED IMPROVEMENT. Total objective over all
            // k placements must beat the Lloyd poses, and no two fitted
            // placements may collapse onto each other (a degenerate fit
            // would trade a lasso for a duplicate).
            let sOld = 0, sNew = 0;
            for (let c = 0; c < k; c++) {
              sOld += fitScore(pills[c].cx, pills[c].cy, pills[c].theta);
              sNew += fitScore(fit[c].cx, fit[c].cy, fit[c].theta);
            }
            let collapsed = false;
            for (let a2 = 0; a2 < k && !collapsed; a2++) for (let b2 = a2 + 1; b2 < k; b2++)
              if (Math.hypot(fit[a2].cx - fit[b2].cx, fit[a2].cy - fit[b2].cy) < 0.45 * tMinor) { collapsed = true; break; }
            opts.debug?.({ stage: 'clumpfit', label: g.label, k,
              lloyd: +sOld.toFixed(1), fitted: +sNew.toFixed(1),
              collapsed, took: (sNew > sOld && !collapsed) });
            if (sNew > sOld && !collapsed) {
              for (let c = 0; c < k; c++) {
                pills[c].cx = fit[c].cx; pills[c].cy = fit[c].cy;
                pills[c].theta = +fit[c].theta.toFixed(3);
                const st3 = pillPhotoStats(distBg.data, w, h, pills[c], otsuThr);
                pills[c].photo = st3.mean; pills[c].bgFrac = st3.bgFrac;
              }
            }
          }

          if (pills.length) {
            const medP = median(pills.map((p2) => p2.photo)) || 1;
            for (const p2 of pills) {
              p2.valid = +((1 - (p2.bgFrac || 0)) * Math.min(1, p2.photo / medP)).toFixed(2);
              delete p2.photo; delete p2.bgFrac;
            }
            g.pills = pills;
            g.placed = 'lloyd';
          }
        }
      }

      // ---- POSE REFINEMENT: consume the residual signal ----
      // The owner, reading the residual view: "why isn't it clear that
      // ROTATING would fix the overlap?" It is — blue lobes (outline over
      // background) perpendicular to red lobes (mask no outline explains)
      // are exactly a rotation error, and red/blue displaced to one side is
      // a translation error. So each placed pill now locally optimizes its
      // pose against the mask itself: maximize (foreground covered) minus
      // (background claimed), over rotations up to ±90° and small shifts.
      // No constants beyond the search grid; the objective IS the residual.
      {
        const fgAt = (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return 0;
          return activeMd[(y | 0) * w + (x | 0)] > 0 ? 1 : 0;
        };
        const lumAt = (x, y) => {
          const i = ((y | 0) * w + (x | 0)) * 4;
          return (src.data[i] + src.data[i + 1] + src.data[i + 2]) / 3;
        };
        const poseScore = (p2, cx, cy, th) => {
          const c = Math.cos(th), s2 = Math.sin(th);
          const a = 0.46 * p2.major, b = 0.46 * p2.minor;
          let inFg = 0, inBg = 0;
          const lums = [];
          for (let i = 0; i < 9; i++) for (let j = 0; j < 5; j++) {
            const u = (i / 8) * 2 - 1, v = (j / 4) * 2 - 1;
            if (u * u + v * v > 1.05) continue;
            const x = cx + u * a * c - v * b * s2;
            const y = cy + u * a * s2 + v * b * c;
            if (fgAt(x, y)) { inFg++; lums.push(lumAt(x, y)); }
            else inBg++;
          }
          // SEAM AVOIDANCE (owner: "the pixels inside the outline should be
          // similar — a seam inside means you're covering two pills"). A pose
          // that straddles two pills crosses the dark contact line between
          // them; its interior then contains samples well below its own
          // median. Penalize those. The 15-luma margin sits below the
          // measured real-photo seam depth (19-64 luma) and above pill
          // speckle spread, so single-pill interiors are untouched.
          let seam = 0;
          if (lums.length >= 6) {
            const sl = [...lums].sort((x2, y2) => x2 - y2);
            const medL = sl[sl.length >> 1];
            for (const L of lums) if (L < medL - 15) seam++;
          }
          return inFg - 2 * inBg - 1.5 * seam;
        };
        // Would this pose put p2 inside another placed pill? Capsule-vs-capsule:
        // the closest approach of the two spines must clear the sum of the
        // half-widths. Every placement in the image is a candidate obstacle —
        // pills in neighbouring regions are just as solid as siblings.
        const allPlaced = [];
        for (const g of regions) if (g.pills) for (const q of g.pills) allPlaced.push(q);
        const spineMin = (ax, ay, ath, aMaj, aMin, B) => {
          const ah = Math.max(0, (aMaj - aMin) / 2);
          const bh = Math.max(0, ((B.major || 0) - (B.minor || 0)) / 2);
          const ac = Math.cos(ath), as = Math.sin(ath);
          const bc = Math.cos(B.theta || 0), bs = Math.sin(B.theta || 0);
          let best2 = Infinity;
          for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
            const t1 = ah ? -ah + 2 * ah * i / 8 : 0, t2 = bh ? -bh + 2 * bh * j / 8 : 0;
            const dx2 = (ax + ac * t1) - (B.cx + bc * t2);
            const dy2 = (ay + as * t1) - (B.cy + bs * t2);
            const dd = Math.hypot(dx2, dy2);
            if (dd < best2) best2 = dd;
            if (!bh) break;
          }
          return best2;
        };
        // Total penetration depth (px) this pose would have against all other
        // placed pills. 0 when merely touching. The refiner's score is in
        // "samples covered" units and poseScore tops out near 33, so a weight
        // of 1.5 makes ~2px of overlap cost about as much as one lost sample:
        // enough to push pills apart, not so much that a pill flees the photo.
        const PEN_W = 1.5;
        const penetration = (p2, nx2, ny2, th) => {
          const aMaj = p2.major || 0, aMin = p2.minor || 0;
          if (!(aMin > 0)) return 0;
          let tot = 0;
          for (const B of allPlaced) {
            if (B === p2 || !(B.minor > 0)) continue;
            const reach2 = (aMaj + (B.major || 0)) / 2 + 2;
            if (Math.abs(nx2 - B.cx) > reach2 || Math.abs(ny2 - B.cy) > reach2) continue;
            // 1px slack: touching pills are legal, interpenetrating ones are not
            const pen3 = (aMin + B.minor) / 2 - 1 - spineMin(nx2, ny2, th, aMaj, aMin, B);
            if (pen3 > 0) tot += pen3;
          }
          return tot;
        };
        const refinePoses = () => {
          for (const g of regions) {
            if (!g.pills) continue;
            // Stamp placements are already coordinate-ascent refined against
            // the mask the stamp counted on; in otsu mode that material is
            // invisible to activeMd and this refiner would drag the pills
            // onto the purged crescents. Leave them where the evidence is.
            if (g.stamp) continue;
            for (const p2 of g.pills) {
              // The incumbent pose pays the same penetration charge as every
              // challenger; otherwise an already-overlapping pill scores as if
              // it were free and nothing can beat it.
              let best = { s: poseScore(p2, p2.cx, p2.cy, p2.theta),
                cx: p2.cx, cy: p2.cy, th: p2.theta,
                pen: penetration(p2, p2.cx, p2.cy, p2.theta) };
              // ESCAPE RECOVERY: a placement mostly over background (shoved
              // there by collision resolution) needs reach, not fine-tuning —
              // widen the first pass's search radius until it can get home.
              const maxIn = 33; // samples inside the u,v disc
              const lost = best.s < maxIn * 0.2;
              for (let pass = 0; pass < 2; pass++) {
                const dth = pass === 0 ? Math.PI / 12 : Math.PI / 48;
                const dxy = pass === 0 ? (lost ? 6 : 2.5) : 1;
                const reach = pass === 0 && lost ? 3 : 1;
                for (let r2 = -6; r2 <= 6; r2++) {
                  const th = best.th + r2 * dth;
                  for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) {
                    const nx2 = best.cx + ox * dxy, ny2 = best.cy + oy * dxy;
                    // SOLID PILLS DO NOT INTERPENETRATE. Without this the
                    // refiner scores each pill purely on how much pill
                    // material it covers, which on a touching cluster is
                    // maximised at the SAME bright centre for every pill in
                    // the region — so it walked them all onto one bead and
                    // undid the collision resolution that had just run.
                    // Measured on synth2-rc-noise-small-n12-t65-s199: physics
                    // reported 17 pairs fixed and worstAfter 0, then this
                    // refiner re-stacked 8 full-size 27.6x27.2 pills into a
                    // 24x27 box (26 of 28 pairs overlapping, min separation
                    // 7.2px) while four real pills went undetected 35-94px
                    // away. The count still read 12/12 because the four
                    // phantoms cancelled the four misses.
                    // Score penetration rather than forbidding it outright. A
                    // hard veto cannot rescue a pill that is ALREADY inside a
                    // neighbour: every candidate move collides too, so the
                    // pose is frozen where it started (measured: s172 got
                    // worse, 23 -> 31 overlapping pairs). Charging for
                    // penetration instead lets a pill climb out — it will
                    // accept slightly less pill coverage to stop sharing a
                    // body with its neighbour, which is exactly the trade a
                    // human makes when reading a touching cluster.
                    // A candidate must not be MORE embedded than where we
                    // already are. Phrasing it as "no worse than the
                    // incumbent" rather than "zero overlap" is what lets an
                    // already-overlapping pill climb out: it can always move
                    // toward daylight, and can never move deeper in.
                    // (A soft penalty was tried instead and measured WORSE —
                    // 53 -> 86 overlapping pairs — because a pill will happily
                    // buy a little more pill coverage with a little more
                    // penetration, and in a touching cluster that trade is
                    // always available.)
                    const pen2 = penetration(p2, nx2, ny2, th);
                    if (pen2 > best.pen + 0.01) continue;
                    const sc = poseScore(p2, nx2, ny2, th);
                    // Prefer LESS penetration over more coverage, always: a
                    // physically impossible arrangement is not a better fit,
                    // however much pill material it happens to cover.
                    if (pen2 < best.pen - 0.01
                        || (Math.abs(pen2 - best.pen) <= 0.01 && sc > best.s)) {
                      best = { s: sc, cx: nx2, cy: ny2, th, pen: pen2 };
                    }
                  }
                }
              }
              p2.cx = best.cx; p2.cy = best.cy; p2.theta = +best.th.toFixed(3);
            }
          }
        };
        refinePoses();
        regions.__refinePoses = refinePoses;   // second pass after physics
        // `var` hoists past this block: invalid-placement recovery below
        // scores its relocation candidates with the SAME objective the
        // refiner uses (fg - bg - seam), not a photometry-only score, which
        // is degenerate inside pill crowds (any pose centered in a white
        // pocket reads 100% pill; only the seam term knows it straddles).
        var poseScoreHoisted = poseScore;
      }

      // ---- rigid-body relaxation over every placement ----
      const bodies = [];
      for (const g of regions) {
        if (g.pills) for (const p2 of g.pills) bodies.push({ p: p2, movable: !g.stamp, single: false });
        else if ((g.units || 1) === 1 && g.shape)
          bodies.push({ p: { cx: g.cx, cy: g.cy, theta: g.shape.theta || 0, major: g.shape.major, minor: g.shape.minor },
            movable: false, single: true, owner: g });
      }
      const closest = (A, B) => {
        const ah = Math.max(0, (A.major - A.minor) / 2), bh = Math.max(0, (B.major - B.minor) / 2);
        const ac = Math.cos(A.theta), as2 = Math.sin(A.theta), bc = Math.cos(B.theta), bs = Math.sin(B.theta);
        let best = Infinity, nx = 1, ny = 0;
        for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
          const t1 = -ah + 2 * ah * i / 16, t2 = -bh + 2 * bh * j / 16;
          const x1 = A.cx + ac * t1, y1 = A.cy + as2 * t1;
          const x2 = B.cx + bc * t2, y2 = B.cy + bs * t2;
          const dx = x1 - x2, dy = y1 - y2, d = Math.hypot(dx, dy);
          if (d < best) { best = d; if (d > 1e-6) { nx = dx / d; ny = dy / d; } }
        }
        return { d: best, nx, ny };
      };
      // TWO PINNED PILLS CANNOT BOTH BE RIGHT. A single-pill region's pose is
      // an ellipse fit to its OWN pixels, which is why it is trusted and never
      // moved. But when two such regions INTERPENETRATE, at least one of those
      // fits is wrong, and pinning both leaves physics reporting a collision
      // it is structurally unable to resolve. Measured on r-f5d11815: 16
      // bodies, only 3 movable, and 2 of the 3 collisions were pinned-vs-
      // pinned, so worstAfter came out identical to worstBefore (3.7 -> 3.7).
      // The same signature appears across the corpus -- physics clears big
      // overlaps (18 -> 0, 11.2 -> 0) and is completely inert on small ones
      // (2.2 -> 2.2, 1.7 -> 1.7, 1.3 -> 1.3), which is most of what remains.
      //
      // So a single-pill body becomes movable ONLY when its collision partner
      // is also pinned. Against a movable partner the old behaviour stands:
      // the trusted fit holds still and the uncertain placement yields.
      {
        let freed = 0;
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            if (!bodies[i].single || !bodies[j].single) continue;
            if (bodies[i].movable && bodies[j].movable) continue;
            const A = bodies[i].p, B = bodies[j].p;
            const reach = (A.major + B.major) / 2 + 4;
            if (Math.abs(A.cx - B.cx) > reach || Math.abs(A.cy - B.cy) > reach) continue;
            if (closest(A, B).d >= (A.minor + B.minor) / 2 - 0.75) continue;
            if (!bodies[i].movable) { bodies[i].movable = true; freed++; }
            if (!bodies[j].movable) { bodies[j].movable = true; freed++; }
          }
        }
        if (freed) opts.debug?.({ stage: 'physics-unpin', freed });
      }
      let pairsFixed = 0, worstBefore = 0, worstAfter = 0;
      for (let iter = 0; iter < 12; iter++) {
        let worst = 0;
        for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
          const A = bodies[i].p, B = bodies[j].p;
          const reach = (A.major + B.major) / 2 + 4;
          if (Math.abs(A.cx - B.cx) > reach || Math.abs(A.cy - B.cy) > reach) continue;
          const { d, nx, ny } = closest(A, B);
          const need = (A.minor + B.minor) / 2;
          const pen = need - d;
          if (pen <= 0.75) continue;
          if (iter === 0) { pairsFixed++; if (pen > worstBefore) worstBefore = pen; }
          if (pen > worst) worst = pen;
          const mA = bodies[i].movable, mB = bodies[j].movable;
          // Packed rigid pills resolve contact by ROTATING as much as by
          // sliding (the owner's point) — and a translation push can shove a
          // pill clean off the foreground. Try both: small counter-rotations
          // of each movable body, or the translation push; keep whichever
          // resolves the most penetration per unit of background claimed.
          const fgFrac = (P) => {
            const c2 = Math.cos(P.theta), s3 = Math.sin(P.theta);
            const a2 = 0.42 * P.major, b2 = 0.42 * P.minor;
            let f = 0, n2 = 0;
            for (let ii = 0; ii < 5; ii++) for (let jj = 0; jj < 3; jj++) {
              const u = (ii / 4) * 2 - 1, v = (jj / 2) * 2 - 1;
              if (u * u + v * v > 1.05) continue;
              n2++;
              if (activeMd[((P.cy + u * a2 * s3 + v * b2 * c2) | 0) * w +
                           ((P.cx + u * a2 * c2 - v * b2 * s3) | 0)] > 0) f++;
            }
            return n2 ? f / n2 : 0;
          };
          const trial = (dA, dB, rA, rB) => {
            const A2 = { ...A, cx: A.cx + nx * dA, cy: A.cy + ny * dA, theta: A.theta + rA };
            const B2 = { ...B, cx: B.cx - nx * dB, cy: B.cy - ny * dB, theta: B.theta + rB };
            const { d: d2 } = closest(A2, B2);
            const resolved = d2 - d;                      // how much gap gained
            const fg2 = (mA ? fgFrac(A2) : 1) + (mB ? fgFrac(B2) : 1);
            return { A2, B2, gain: resolved + 1.2 * fg2 };
          };
          const step = pen / 2 + 0.2;
          const cands = [];
          if (mA && mB) cands.push(trial(step, step, 0, 0));
          else if (mA) cands.push(trial(pen + 0.3, 0, 0, 0));
          else if (mB) cands.push(trial(0, pen + 0.3, 0, 0));
          const ROT = Math.PI / 16;
          if (mA) { cands.push(trial(0, 0, ROT, 0)); cands.push(trial(0, 0, -ROT, 0)); }
          if (mB) { cands.push(trial(0, 0, 0, ROT)); cands.push(trial(0, 0, 0, -ROT)); }
          if (cands.length) {
            // SEPARATION FIRST, COVERAGE SECOND. `gain` adds the foreground
            // term to the gap gained, so a rotation that resolves NOTHING but
            // keeps the pill on more material can outscore the translation
            // that actually separates the pair. That is why physics clears
            // large overlaps and is inert on small ones -- measured across the
            // corpus: 18 -> 0 and 11.2 -> 0, but 3.7 -> 3.7, 2.2 -> 2.2,
            // 1.7 -> 1.7, 1.3 -> 1.3. At pen 1.3 the rotation's coverage bonus
            // (2.40) simply beats the translation's (3.22 - its own coverage
            // loss), so nothing moves and the pair stays interpenetrating.
            //
            // Solids may not share pixels, so a candidate that ENDS the
            // overlap always beats one that does not; coverage only breaks
            // ties among candidates of the same class.
            const ends = (c) => closest(c.A2, c.B2).d >= need - 0.75;
            const clear = cands.filter(ends);
            if (clear.length) cands.length = 0, cands.push(...clear);
            const bestC = cands.sort((x2, y2) => y2.gain - x2.gain)[0];
            if (mA) { A.cx = bestC.A2.cx; A.cy = bestC.A2.cy; A.theta = bestC.A2.theta; }
            if (mB) { B.cx = bestC.B2.cx; B.cy = bestC.B2.cy; B.theta = bestC.B2.theta; }
          }
        }
        worstAfter = worst;
        if (worst <= 0.75) break;
      }
      // `worst` is measured BEFORE this iteration's pushes, so worstAfter has
      // always reported the penetration going INTO the final pass, never the
      // state physics actually left behind. That misreading is what made the
      // stage look inert on small overlaps (3.7 -> 3.7, 2.2 -> 2.2) when it
      // had in fact resolved them. Re-measure once the loop is done.
      {
        let w2 = 0;
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            const A = bodies[i].p, B = bodies[j].p;
            const reach = (A.major + B.major) / 2 + 4;
            if (Math.abs(A.cx - B.cx) > reach || Math.abs(A.cy - B.cy) > reach) continue;
            const pen2 = (A.minor + B.minor) / 2 - closest(A, B).d;
            if (pen2 > w2) w2 = pen2;
          }
        }
        worstAfter = w2;
      }
      if (pairsFixed) opts.debug?.({ stage: 'physics', pairs: pairsFixed,
        worstBefore: +worstBefore.toFixed(1), worstAfter: +worstAfter.toFixed(1),
        bodies: bodies.length, movable: bodies.filter((b) => b.movable).length });
      // settle poses once more after collisions moved anything
      if (pairsFixed && regions.__refinePoses) regions.__refinePoses();
      delete regions.__refinePoses;

      // ---- DEEP CLUSTER RESOLUTION -------------------------------------
      // The relaxation above can only MOVE pills, one at a time, each
      // accepting only moves that do not deepen its own penetration. Several
      // pills crossing what is really ONE pill at another angle is therefore
      // STABLE: no single pill improves by moving. Escaping needs DELETE and
      // MERGE, which are set-level moves. See js/cluster.js.
      //
      // Measured baseline before this existed: 197 overlapping pairs, 59
      // duplicates, worst penetration 85.1px, over 59 of 219 images.
      //
      // Defined here but RUN LAST (see the call site): invalid-placement
      // recovery and the photo-grounded fit gate both re-pose pills without
      // any overlap check, so a law enforced here would simply be undone.
      const drawnDims = (() => {
        // The SAME template the probe exports and the geometry gate audits.
        // An unfiltered median gave 27.6 against the audited 27.1, so the
        // solver cleared its own idea of overlap and left the gate's intact.
        const s2 = regions.filter((g2) => (g2.units || 1) === 1 && g2.shape
          && g2.shape.residual <= 0.12);
        const all = regions.filter((g2) => g2.shape);
        const mj = median(s2.map((g2) => g2.shape.major))
          || median(all.map((g2) => g2.shape.major)) || 40;
        const mn = median(s2.map((g2) => g2.shape.minor))
          || median(all.map((g2) => g2.shape.minor)) || 18;
        return { maj: +mj.toFixed(1), min: +mn.toFixed(1) };
      })();
      const asCap = (P) => ({ cx: P.cx, cy: P.cy, th: P.theta || 0,
        maj: drawnDims.maj, min: drawnDims.min });
      const penAt = (A, B) => clusterPen(asCap(A), asCap(B));

      regions.__runClusterSolve = () => {
        if (opts.clusterSolve === false) return;
        // Every DRAWN placement is a node, in both forms the probe exports:
        // multi-pill regions carry g.pills, single-pill regions only g.shape.
        // Single-pill regions and stamp poses are ANCHORS -- obstacles in the
        // collision graph, never moved or deleted, as the rigid-body pass
        // already treats them.
        const nodes = [];
        for (const g of regions) {
          if (g.pills && g.pills.length) {
            for (const p2 of g.pills) nodes.push({ p: p2, g, fixed: !!g.stamp });
          } else if ((g.units || 1) === 1 && g.shape && g.shape.minor > 0) {
            nodes.push({ p: { cx: g.cx, cy: g.cy, theta: g.shape.theta || 0,
              major: g.shape.major, minor: g.shape.minor }, g, fixed: true });
          }
        }
        if (nodes.length < 2) return;
        // CLUSTERS COME FROM THE COLLISION GRAPH, NOT REGION MEMBERSHIP:
        // pills interpenetrate across region boundaries and a per-region loop
        // is blind to exactly those pairs.
        const parent = nodes.map((_, i) => i);
        const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const A = nodes[i].p, B = nodes[j].p;
            if (!(A.minor > 0) || !(B.minor > 0)) continue;
            if (penAt(A, B) > 0.75) {
              const ra = find(i), rb = find(j);
              if (ra !== rb) parent[ra] = rb;
            }
          }
        }
        const comps = new Map();
        for (let i = 0; i < nodes.length; i++) {
          const r0 = find(i);
          if (!comps.has(r0)) comps.set(r0, []);
          comps.get(r0).push(i);
        }
        let solved = 0, candidates = 0, removed = 0;
        for (const idxs of comps.values()) {
          if (idxs.length < 2) continue;
          if (!idxs.some((k) => !nodes[k].fixed)) continue;   // nothing may move
          candidates++;
          const inSet = new Set(idxs);
          const members = idxs.map((k) => nodes[k]);
          const pills = members.map((m) => m.p);
          const pad = drawnDims.maj + 4;
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          for (const p2 of pills) {
            if (p2.cx - pad < bx0) bx0 = p2.cx - pad;
            if (p2.cy - pad < by0) by0 = p2.cy - pad;
            if (p2.cx + pad > bx1) bx1 = p2.cx + pad;
            if (p2.cy + pad > by1) by1 = p2.cy + pad;
          }
          const box = { x0: Math.max(0, Math.floor(bx0)), y0: Math.max(0, Math.floor(by0)),
            x1: Math.min(w - 1, Math.ceil(bx1)), y1: Math.min(h - 1, Math.ceil(by1)) };
          if (box.x1 <= box.x0 || box.y1 <= box.y0) continue;
          const area = (box.x1 - box.x0) * (box.y1 - box.y0);
          const st = area > 40000 ? 3 : area > 12000 ? 2 : 1;
          // Pills OUTSIDE this cluster are still solid. Without them the
          // solver clears its own cluster by shoving pills into neighbours it
          // cannot see -- measured on s261, both clusters reported 0 internal
          // overlap while the photo-wide count stayed at 5.
          const obstacles = [];
          for (let k = 0; k < nodes.length; k++) {
            if (inSet.has(k)) continue;
            const q = nodes[k].p;
            if (!(q.minor > 0)) continue;
            if (q.cx < box.x0 - pad || q.cx > box.x1 + pad) continue;
            if (q.cy < box.y0 - pad || q.cy > box.y1 + pad) continue;
            obstacles.push(asCap(q));
          }
          // Solve at the DRAWN size, so the arrangement certified legal is the
          // arrangement the user is actually shown.
          const r = solveCluster(
            pills.map((p2) => ({ cx: p2.cx, cy: p2.cy, th: p2.theta || 0,
              maj: drawnDims.maj, min: drawnDims.min })),
            activeMd, w, h, box, { rounds: 3, step: st, obstacles });
          if (!r.pills.length) continue;
          if (r.worstOverlap > 0.75) continue;      // accept only a LEGAL result
          if (r.pills.length > pills.length) continue;   // never invents pills
          // A DROPPED PLACEMENT MUST ALSO LEAVE THE COUNT.
          // Deletion was blocked outright after it once left 58 placements
          // behind a count of 60 on s300 -- but the cause there was ORDERING,
          // not the deletion itself: the solver ran mid-pipeline and the
          // count was re-derived downstream, so the decrement was discarded.
          // It now runs last, after the fit gate, and nothing reassigns count
          // afterwards, so a decrement sticks.
          //
          // Blocking it outright is expensive: measured on s111, all THREE
          // candidate clusters were rejected for wanting to drop a pill, so
          // the solver fixed nothing on an image with 17 overlapping pairs.
          // Corpus-wide the block cost roughly half the solver's benefit
          // (197 -> 80 pairs when deletion was allowed, 197 -> 145 without).
          //
          // The invariant that matters is not "never delete" but "the count
          // and the placements must agree", which is exactly what the
          // PHANTOM MASS stress check measures.
          // Assign each survivor to the region its nearest original came from:
          // a cluster spans several regions and the result order carries no
          // ownership, so index-matching scrambles them.
          const taken = new Set();
          const keepFor = new Map();
          for (const np of r.pills) {
            let bi = -1, bd = Infinity;
            for (let n = 0; n < members.length; n++) {
              if (taken.has(n)) continue;
              const d = Math.hypot(np.cx - members[n].p.cx, np.cy - members[n].p.cy);
              if (d < bd) { bd = d; bi = n; }
            }
            if (bi < 0) bi = 0; else taken.add(bi);
            const owner = members[bi].g;
            if (!keepFor.has(owner)) keepFor.set(owner, []);
            keepFor.get(owner).push({ cx: np.cx, cy: np.cy, theta: np.th,
              major: np.maj, minor: np.min });
          }
          removed += pills.length - r.pills.length;
          for (const g2 of new Set(members.map((m) => m.g))) {
            if (!g2.pills) continue;
            const mine = new Set(members.filter((m) => m.g === g2).map((m) => m.p));
            g2.pills = g2.pills.filter((p2) => !mine.has(p2)).concat(keepFor.get(g2) || []);
            g2.units = g2.pills.length || 1;
          }
          solved++;
        }
        if (solved) {
          opts.debug?.({ stage: 'clustersolve', clusters: solved, candidates, pillsRemoved: removed });
          if (removed) count -= removed;
        }
      };

      // INVALID-PLACEMENT RECOVERY. When a blob's count is short, one
      // placement has no pill of its own; collision resolution tends to
      // evict it onto bare board, where it draws as a runaway lasso over
      // nothing. Snap any placement that ended over background BACK onto
      // the densest foreground — physics exemption granted — and mark it
      // invalid. Two overlapping claims on the same material, one dashed
      // red, IS the honest picture of an under-count: the display shows
      // where the extra pill claim landed, and valid=0 feeds the flag.
      const strandedByLbl = new Map();
      for (const g of regions) {
        if (!g.pills || g.label == null) continue;
        for (const p2 of g.pills) {
          const st3 = pillPhotoStats(distBg.data, w, h, p2, otsuThr);
          if (st3.bgFrac > 0.3) {
            if (!strandedByLbl.has(g.label)) strandedByLbl.set(g.label, []);
            strandedByLbl.get(g.label).push({ g, p2, st3 });
          }
        }
      }
      if (strandedByLbl.size) {
        // Home is the blob's OWN pixels — searched globally. Physics can
        // pinball a surplus claim from anchored single to anchored single
        // until it pops out into open board, arbitrarily far from its blob;
        // any search centered on where it LANDED inherits that error. So
        // candidate centers come from the blob's label pixels themselves.
        const homePx = new Map([...strandedByLbl.keys()].map((l) => [l, []]));
        for (let i = 0; i < activeMd.length; i++) {
          const arr = homePx.get(activeMd[i]);
          if (arr) arr.push(i);
        }
        const segPts = (q) => {
          const a2 = Math.max(0, (q.major - q.minor) / 2), pts = [];
          for (let t = -1; t <= 1; t += 0.25)
            pts.push([q.cx + Math.cos(q.theta) * a2 * t, q.cy + Math.sin(q.theta) * a2 * t]);
          return pts;
        };
        // Cap-aware radial score: pillPhotoStats under-samples the cap ends
        // (a claim can hang both caps into board and still read bgFrac 0.04),
        // so score along 16 exact stadium radii out to 0.92R instead — the
        // same geometry the spoke proof draws.
        const radialR = (a2, rho, phi) => {
          const c = Math.abs(Math.cos(phi)), s4 = Math.abs(Math.sin(phi));
          if (s4 < 1e-6) return a2 + rho;
          const r1 = rho / s4;
          if (r1 * c <= a2) return r1;
          return a2 * c + Math.sqrt(Math.max(0, a2 * a2 * c * c - a2 * a2 + rho * rho));
        };
        const radialScore = (cand) => {
          const a2 = Math.max(0, (cand.major - cand.minor) / 2), rho = cand.minor / 2;
          let ok = 0, n3 = 0, sum = 0;
          for (let k2 = 0; k2 < 16; k2++) {
            const phi = k2 * Math.PI / 8, R = radialR(a2, rho, phi);
            const wx = Math.cos(cand.theta + phi), wy = Math.sin(cand.theta + phi);
            for (const t of [0.3, 0.6, 0.92]) {
              const x = (cand.cx + wx * R * t) | 0, y = (cand.cy + wy * R * t) | 0;
              if (x < 0 || y < 0 || x >= w || y >= h) { n3++; continue; }
              const v = distBg.data[y * w + x];
              n3++; sum += v; if (v > otsuThr) ok++;
            }
          }
          return n3 ? ok / n3 + 0.1 * (sum / n3) / 255 : 0;
        };
        for (const list of strandedByLbl.values()) for (const { g, p2, st3 } of list) {
          const idx = homePx.get(g.label) || [];
          const stride = Math.max(1, (idx.length / 160) | 0);
          const sibs = g.pills.filter((q) => q !== p2).map(segPts);
          let best = null;
          for (let ii = 0; ii < idx.length; ii += stride) {
            const cx4 = idx[ii] % w, cy4 = (idx[ii] / w) | 0;
            for (let r3 = 0; r3 < 8; r3++) {
              const th = r3 * Math.PI / 8;
              const cand = { ...p2, cx: cx4, cy: cy4, theta: th };
              // Photometry alone is degenerate inside a pill crowd: any pose
              // centered in white material reads ~100% pill even when it
              // straddles two. Combine the cap-aware radial read with the
              // refiner's own seam-aware objective, which knows the
              // difference (a straddling pose crosses the dark contact line).
              let sc = radialScore(cand)
                + 0.02 * poseScoreHoisted(cand, cand.cx, cand.cy, cand.theta);
              // soft anti-doubling: flush parallel neighbours legitimately
              // sit at core distance ~minor, so only penalize genuine
              // interpenetration, and gently — photometry breaks near-ties.
              const mine = segPts(cand);
              let coincident = false;
              for (const sp of sibs) {
                let dmin = 1e9;
                for (const [xa, ya] of mine) for (const [xb, yb] of sp) {
                  const d3 = Math.hypot(xa - xb, ya - yb);
                  if (d3 < dmin) dmin = d3;
                }
                // Two pills occupying the SAME place is not a near-tie the
                // photometry may break — it is one pill drawn twice while a
                // real one goes unplaced. The soft 0.75 factor cannot stop it:
                // the cleanest patch of white in a crowded blob outscores every
                // honest stand by more than 25%, so each stranded claim
                // independently migrates onto that one spot (measured:
                // r-554c3c1a blob 1, two claims both landing on the integer
                // pixel (183,202), count still 19 but two pills unoutlined).
                // Interpenetration is a graded judgement; co-location is not.
                if (dmin < p2.minor * 0.25) { coincident = true; break; }
                if (dmin < p2.minor * 0.75) { sc *= 0.75; }
              }
              if (coincident) continue;
              if (!best || sc > best.sc) best = { sc, cand };
            }
          }
          if (best) best.bg = pillPhotoStats(distBg.data, w, h, best.cand, otsuThr).bgFrac;
          if (best && best.bg < st3.bgFrac - 0.02) {
            p2.cx = best.cand.cx; p2.cy = best.cand.cy; p2.theta = +best.cand.theta.toFixed(3);
          }
          // Verdict where it finally stands. A recovered claim that reads
          // clean AND has its own material is a real pill again; only a
          // dirty stand or a doubled-up claim stays flagged.
          const stF = pillPhotoStats(distBg.data, w, h, p2, otsuThr);
          let doubled = 0;
          const seg = (q) => {
            const a2 = Math.max(0, (q.major - q.minor) / 2);
            return [q.cx - Math.cos(q.theta) * a2, q.cy - Math.sin(q.theta) * a2,
                    q.cx + Math.cos(q.theta) * a2, q.cy + Math.sin(q.theta) * a2];
          };
          const [ax0, ay0, ax1, ay1] = seg(p2);
          for (const q of g.pills) {
            if (q === p2) continue;
            const [bx0, by0, bx1, by1] = seg(q);
            let dmin = 1e9;
            for (let i2 = 0; i2 <= 8; i2++) for (let j2 = 0; j2 <= 8; j2++) {
              const xa = ax0 + (ax1 - ax0) * i2 / 8, ya = ay0 + (ay1 - ay0) * i2 / 8;
              const xb = bx0 + (bx1 - bx0) * j2 / 8, yb = by0 + (by1 - by0) * j2 / 8;
              const d2 = Math.hypot(xa - xb, ya - yb);
              if (d2 < dmin) dmin = d2;
            }
            if (dmin < (p2.minor + q.minor) / 2 * 0.8) { doubled = 1; break; }
          }
          p2.valid = (stF.bgFrac < 0.15 && !doubled) ? +(1 - stF.bgFrac).toFixed(2) : 0;
        }
      }
    }

    // ==================== PHOTO-GROUNDED FIT GATE ====================
    // Owner: "some of the boundaries are HORRIBLE ... the horrible-ness of
    // the fits makes me question how this entire app works." He is right,
    // and the reason is structural: every pose above this line was chosen by
    // optimising against a MASK -- Lloyd/watershed partitioning, then
    // refinePoses' inFg - 2*inBg - 1.5*seam. Nothing in the shipping path
    // ever asked the PHOTO "does this outline actually sit on a pill?"
    //
    // matchQuality has been able to answer that question for some time --
    // rim edge support, interior homogeneity, seam crossing, gradient
    // orientation agreement, every one of them self-calibrated from this
    // photo's own verified singles -- but it was EMIT-ONLY, consumed nowhere
    // except the offline sweep. A bad placement therefore had no mechanism
    // to be corrected or rejected. This block gives it one, in three stages:
    //
    //   1. SCORE  every final placement; attach the score (p.mq) so it is
    //             inspectable downstream instead of being thrown away.
    //   2. REFINE poses that score poorly -- bounded coordinate ascent on
    //             (x, y, theta) maximising matchQuality.
    //   3. FLAG   what still cannot clear the photo's own calibrated bar
    //             (valid = 0; the display already dashes those).
    //
    // Every threshold here is derived from the photo's own verified pills
    // through calibrateMatch/scoreFromComponents, never from a fixed
    // constant -- the same discipline matchQuality itself is built on.
    if (regions.length) try {
      const fitFg = new Uint8Array(w * h);
      for (let i2 = 0; i2 < w * h; i2++) fitFg[i2] = activeMd && activeMd[i2] > 0 ? 1 : 0;
      const fitLuma = new Float64Array(w * h);
      for (let i2 = 0; i2 < w * h; i2++) {
        const j2 = i2 * 4;
        fitLuma[i2] = 0.299 * src.data[j2] + 0.587 * src.data[j2 + 1] + 0.114 * src.data[j2 + 2];
      }
      // interior depth: buildSeamMask's crease rule needs ">=3px deep" so
      // that pill RIMS (which are dark too) do not read as seam.
      const fitDd = new Float64Array(w * h);
      for (let y2 = 1; y2 < h - 1; y2++) for (let x2 = 1; x2 < w - 1; x2++) {
        const i2 = y2 * w + x2;
        if (!fitFg[i2]) continue;
        let d2 = 6;
        for (let rr = 1; rr <= 5; rr++) {
          let edge = false;
          for (let a2 = -rr; a2 <= rr && !edge; a2++) {
            const cand = [[x2 + a2, y2 - rr], [x2 + a2, y2 + rr],
              [x2 - rr, y2 + a2], [x2 + rr, y2 + a2]];
            for (const [X, Y] of cand) {
              if (X < 0 || Y < 0 || X >= w || Y >= h || !fitFg[Y * w + X]) { edge = true; break; }
            }
          }
          if (edge) { d2 = rr; break; }
        }
        fitDd[i2] = d2;
      }
      const fitRGB = (x2, y2) => {
        const xi = Math.max(0, Math.min(w - 1, x2 | 0)), yi = Math.max(0, Math.min(h - 1, y2 | 0));
        const i2 = (yi * w + xi) * 4;
        return [src.data[i2], src.data[i2 + 1], src.data[i2 + 2]];
      };
      // Calibration pool: this photo's OWN verified singles -- one blob, one
      // pill, a fitted shape the pipeline is confident about. These are the
      // placements nobody disputes, so what THEY measure is the definition of
      // "pill-like on this photo". Same pool discipline as stamp.js's mqPool.
      // A region holding exactly ONE pill is the undisputed case whether the
      // pipeline expressed it as a bare shape or as a single-element pills[]:
      // both mean "one blob, one pill, nobody is arguing". Taking only the
      // former collapsed the pool to 4 on lined-503b3041 (5 regions for 18
      // pills -- the pile is a single multi-pill blob), which is too thin for
      // a population statistic and left the bar calibrated on almost nothing.
      const fitPool = regions.filter((g) => (g.units || 1) === 1 && g.shape
        && g.shape.major > 0 && g.shape.minor > 0 && g.confidence !== 'low'
        && !(g.pills && g.pills.length > 1))
        .map((g) => {
          const p3 = (g.pills && g.pills.length === 1) ? g.pills[0] : null;
          return p3
            ? { cx: p3.cx, cy: p3.cy, theta: p3.theta !== undefined ? p3.theta : g.shape.theta,
                shape: { major: p3.major || g.shape.major, minor: p3.minor || g.shape.minor,
                  theta: p3.theta !== undefined ? p3.theta : g.shape.theta } }
            : { cx: g.cx, cy: g.cy, theta: g.shape.theta, shape: g.shape };
        });
      // Every shipped placement, paired with the object that owns its pose.
      const fitPlaces = [];
      for (const g of regions) {
        if (g.pills && g.pills.length) {
          for (const p2 of g.pills) {
            const maj = p2.major || (g.shape && g.shape.major);
            const min = p2.minor || (g.shape && g.shape.minor);
            if (maj > 0 && min > 0) fitPlaces.push({ o: p2, g, maj, min });
          }
        } else if (g.shape && g.shape.major > 0 && g.shape.minor > 0) {
          fitPlaces.push({ o: g, g, maj: g.shape.major, min: g.shape.minor });
        }
      }
      // A calibrator needs enough undisputed pills to have an opinion. Below
      // that, "the photo's own bar" is not a population statistic and we must
      // not pretend otherwise -- score nothing rather than gate on noise.
      if (fitPool.length >= 4 && fitPlaces.length) {
        const fitEnv = { w, h, fg: fitFg, luma: fitLuma, dd: fitDd, sampleRGB: fitRGB,
          maj: median(fitPlaces.map((f) => f.maj)), min: median(fitPlaces.map((f) => f.min)),
          seam: null, kern: null };
        const cpool = fitPool.map((g) => fitRGB(g.cx, g.cy));
        fitEnv.refCol = [0, 1, 2].map((ch) => median(cpool.map((c) => c[ch])));
        fitEnv.seam = buildSeamMask(fitEnv, fitPool);
        const fitCal = calibrateMatch(fitEnv, fitPool);
        if (fitCal && fitCal.q50 > 1e-6) {
          const poseTh = (o) => (o.theta !== undefined ? o.theta
            : (o.shape ? o.shape.theta : 0)) || 0;
          const setPose = (o, x2, y2, th) => {
            o.cx = x2; o.cy = y2;
            if (o.theta !== undefined) o.theta = +th.toFixed(3);
            else if (o.shape) o.shape.theta = +th.toFixed(3);
            else o.theta = +th.toFixed(3);
          };
          const Q = (f, x2, y2, th) => {
            const m = matchQuality(fitEnv, { x: x2, y: y2, th, maj: f.maj, min: f.min }, fitCal);
            return (m && m.q !== null && isFinite(m.q)) ? m : null;
          };

          // ---- stage 1: SCORE every final placement -----------------------
          for (const f of fitPlaces) {
            f.th0 = poseTh(f.o); f.x0 = f.o.cx; f.y0 = f.o.cy;
            const m = Q(f, f.x0, f.y0, f.th0);
            f.m0 = m; f.q0 = m ? m.q : null;
          }
          const scored = fitPlaces.filter((f) => f.q0 !== null);

          // THE BAR, taken from the photo itself. cal.selfQ holds the
          // verified singles scored at their OWN poses, so its low percentile
          // is "how bad a placement this photo's undisputed pills ever look".
          // A fit below that is worse than any real pill here actually is --
          // the only evidence-grounded definition of "bad" available without
          // inventing a constant. The 0.7*q50 companion is the same ratio
          // sweepWholeImage already uses for its own bar.
          // The bar is the WORST a verified single on this photo actually
          // scores, not a percentile of them. Using the 20th percentile
          // assumes a fifth of this photo's undisputed pills are misfits,
          // which is exactly backwards: they are the ground truth. Measured
          // on t3-cream-caplets-wood -- 48/48 exact, every outline visibly
          // tight -- a p20 bar condemned 11 of 48 correct placements, while
          // that photo's own calibrator scores real singles as low as 0.030.
          // Anything at or above the worst verified single is, by this
          // photo's own evidence, as pill-like as a pill here; only what
          // falls BELOW every real pill is unambiguously bad.
          // TWO bars, because refining and condemning carry opposite risks.
          //
          // refineBar (generous): a placement scoring below what a TYPICAL
          // verified single scores has room to improve, and trying costs
          // nothing -- the ascent is bounded and only accepted on a measured
          // gain, so a placement that was already right cannot be made wrong.
          // This is the 20th percentile of the photo's own singles.
          //
          // flagBar (strict): condemning a placement is destructive, so it
          // must clear a much higher standard of evidence -- BELOW EVERY
          // verified single on this photo. Measured on t3-cream-caplets-wood
          // (48/48 exact, every outline visibly tight), a p20 flag bar
          // condemned 11 of 48 correct placements, because that photo's own
          // calibrator scores real singles as low as 0.030. Anything at or
          // above the worst real pill is, by this photo's own evidence, as
          // pill-like as a pill here.
          const selfSorted = [...fitCal.selfQ].sort((a2, b2) => a2 - b2);
          const refineBar = Math.max(
            selfSorted[Math.max(0, Math.floor(0.2 * (selfSorted.length - 1)))],
            0.7 * fitCal.q50);
          // A POISONED CALIBRATOR CANNOT SET ITS OWN FLOOR. flagBar is the
          // WORST verified single on the photo, which is right when the pool
          // really is pills -- that guard exists because a p20 bar condemned
          // 11 of 48 correct placements on t3-cream-caplets-wood, whose real
          // singles score as low as 0.030.
          //
          // But on a SHATTERED mask the pool is mostly board texture, so its
          // worst sample is noise and the bar collapses to nothing. Measured
          // on adv-cross-noise: pool 244, q50 0.724, flagBar 0.02, and ZERO
          // of 261 placements flagged on an image where 254 are spurious.
          //
          // Only in that case fall back to the relative bar (0.7 * q50), which
          // is derived from the pool's MEDIAN rather than its worst member and
          // so survives contamination. Healthy photos are untouched: measured,
          // r-7ff7fd99 also carries a low bar (0.027) and must keep it.
          const flagBar = shatteredMask
            ? 0.7 * fitCal.q50
            : Math.min(selfSorted[0], 0.7 * fitCal.q50);

          // CAN THIS PHOTO'S CALIBRATOR ACTUALLY TELL GOOD FROM BAD?
          // Measured against the hand-annotated centres, the metric's ability
          // to rank a spurious placement below a real one depends almost
          // entirely on how many undisputed singles it was calibrated on:
          //
          //     pool >= 11  ->  AUC 0.71 - 1.00   (r-f5d11815 1.00,
          //                     r-554c3c1a 0.91, s-0bfc44d8 0.90,
          //                     r-7ff7fd99 0.83, s-eb90778f 0.73)
          //     pool <=  4  ->  AUC 0.56 - 0.63   (lined-503b3041 0.615,
          //                     lined-69204ff4 0.612, lined-bfdbfef9 0.563,
          //                     c-2448027d 0.625)
          //
          // and on lined-503b3041 it is INVERTED inside the pile: the bad
          // cross-pill lassos score 0.616 while the true in-pile pills score
          // 0.571. Flagging on a calibrator that weak is a coin toss dressed
          // up as evidence -- it would dash correct outlines as often as
          // wrong ones. So the VERDICT (stage 3) requires a calibrator with a
          // real population behind it. Scoring and refinement still run: a
          // score is only reported, and refinement is bounded and accepted
          // only on measured improvement, so neither can invent a pill.
          const canJudge = fitPool.length >= 11;

          // ---- stage 2: REFINE the poor scorers ---------------------------
          // Bounded coordinate ascent on (x, y, theta) maximising the photo
          // metric. Two bounds keep this a REFINEMENT rather than a silent
          // re-detection:
          //   (a) the pose may not travel more than half a pill width, so a
          //       placement cannot walk off onto its neighbour; and
          //   (b) the end pose must remain nearer its own origin than any
          //       OTHER placement's origin, or two claims collapse onto one
          //       pill and the count doubles up on the same material.
          // Only sub-bar placements are refined: a fit that already matches
          // this photo's own pills has nothing to gain, and moving it would
          // risk exactly the drift the bounds exist to prevent.
          const origins = scored.map((f) => [f.x0, f.y0]);
          let nRef = 0, nImp = 0;
          for (const f of scored) {
            if (f.q0 >= refineBar) continue;
            nRef++;
            const cap = 0.5 * f.min;               // (a) half a pill width
            let best = { q: f.q0, x: f.x0, y: f.y0, th: f.th0, m: f.m0 };
            for (let round = 0; round < 8; round++) {
              let improved = false;
              for (const [dx, dy, dth] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
                [0, 0, Math.PI / 48], [0, 0, -Math.PI / 48],
                [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0]]) {
                const x2 = best.x + dx, y2 = best.y + dy, th2 = best.th + dth;
                if (Math.hypot(x2 - f.x0, y2 - f.y0) > cap) continue;
                const m = Q(f, x2, y2, th2);
                if (m && m.q > best.q) { best = { q: m.q, x: x2, y: y2, th: th2, m }; improved = true; }
              }
              if (!improved) break;
            }
            if (best.q <= f.q0 + 1e-6) continue;
            // (b) reject a refinement that ended nearer a DIFFERENT
            // placement than its own origin: that is a migration, not a fit.
            const ownD = Math.hypot(best.x - f.x0, best.y - f.y0);
            let nearer = false;
            for (let k2 = 0; k2 < origins.length; k2++) {
              if (scored[k2] === f) continue;
              if (Math.hypot(best.x - origins[k2][0], best.y - origins[k2][1]) < ownD) { nearer = true; break; }
            }
            if (nearer) continue;
            setPose(f.o, best.x, best.y, best.th);
            f.qF = best.q; f.mF = best.m; nImp++;
          }

          // ---- stage 3: FLAG what stays below the photo's own bar ---------
          // Marked valid = 0 so the display dashes it. An honest "this
          // outline is not sitting on a pill" beats a confident wrong line,
          // which is the owner's actual complaint.
          //
          // NOT dropped from the count. A placement can score badly because
          // the pill is genuinely there but photometrically awkward -- glare,
          // deep occlusion in a pile -- and on this corpus dropping on
          // evidence this indirect costs real counts (measured: it breaks
          // previously-exact images) while flagging costs nothing. Rejection
          // stays available through mqBad for a caller that wants it.
          // FILL OVERLAP (IoU) AGAINST THE MASK.
          // `cover` is the fraction of the STAMP that lands on foreground, so
          // it can only see material the stamp wrongly claims -- never mask
          // the stamp MISSES. A stamp straddling two pills therefore scores
          // cover 1.0 while sitting over the gap between them, and one at the
          // wrong angle scores well while its ends hang off the pill.
          //
          // Measured on the owner's screenshot case (r-7ff7fd99): cover reads
          // 0.930 across all 19 placements while IoU reads 0.670, and the
          // visibly wrong outlines drop to 0.36. On lined-bfdbfef9 a placement
          // with NO pill under it scores cover 1.000 against IoU 0.439 -- cover
          // is not merely blind there, it is actively misleading.
          //
          // IoU is symmetric: it charges for stamp-on-background AND for
          // mask-the-stamp-missed, which is exactly what "would the filled
          // shape line up" means.
          // fitFg is activeMd > 0 -- the watershed LABEL map, ~98% non-zero --
          // so measuring against it gives every placement the same meaningless
          // ~0.29. The binary mask is distBg > otsuThr, the same surface the
          // probe exports as `surf`.
          const iouFg = new Uint8Array(w * h);
          { const db3 = distBg.data;
            for (let i3 = 0; i3 < w * h; i3++) iouFg[i3] = db3[i3] > otsuThr ? 1 : 0; }
          const iouOf = (o) => {
            const th = (o.theta !== undefined ? o.theta : (o.shape ? o.shape.theta : 0)) || 0;
            const mj = fitEnv.maj, mn = fitEnv.min;
            const aa = Math.max(0, (mj - mn) / 2), rr = mn / 2;
            const c2 = Math.cos(th), s2 = Math.sin(th);
            const R2 = Math.ceil(mj / 2) + 2;
            let inter = 0, only = 0, missed = 0;
            for (let dy = -R2; dy <= R2; dy++) {
              for (let dx = -R2; dx <= R2; dx++) {
                const x = Math.round(o.cx + dx), y = Math.round(o.cy + dy);
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                const u = dx * c2 + dy * s2, v = -dx * s2 + dy * c2;
                const du = Math.max(0, Math.abs(u) - aa);
                const inStamp = du * du + v * v <= rr * rr;
                const onFg = iouFg[y * w + x] > 0;
                if (inStamp && onFg) inter++;
                else if (inStamp) only++;
                else if (onFg) missed++;
              }
            }
            const uni = inter + only + missed;
            return uni ? inter / uni : 0;
          };
          let nFlag = 0, nIou = 0;
          for (const f of scored) {
            const q = f.qF !== undefined ? f.qF : f.q0;
            const m = f.mF !== undefined ? f.mF : f.m0;
            f.o.mq = +q.toFixed(3);
            let qi = iouOf(f.o);
            // IOU-DRIVEN RE-POSE. The refiner above climbs on the photometric
            // score alone, which is blind to a stamp sitting at the wrong
            // angle or straddling two pills -- those score well on `cover` and
            // on q while their filled shape plainly does not line up. A low
            // IoU says a better pose exists; measured, 16 of 34 placements on
            // s-eb90778f have one within reach (mean gain 0.089 IoU), and
            // 2-3 of 19 on the real caplet photos.
            //
            // Only run on placements that are actually poor, and only ADOPT a
            // clear improvement, so a well-fitted pill is never nudged.
            if (qi < 0.60) {
              const th0 = (f.o.theta !== undefined ? f.o.theta
                : (f.o.shape ? f.o.shape.theta : 0)) || 0;
              const x00 = f.o.cx, y00 = f.o.cy;
              let bq = qi, bx = x00, by = y00, bt = th0;
              for (let dth = -6; dth <= 6; dth++) {
                for (let ox = -3; ox <= 3; ox++) for (let oy = -3; oy <= 3; oy++) {
                  const nx = x00 + ox * 1.5, ny = y00 + oy * 1.5;
                  const nt = th0 + dth * Math.PI / 36;
                  const v = iouOf({ cx: nx, cy: ny, theta: nt });
                  if (v > bq) { bq = v; bx = nx; by = ny; bt = nt; }
                }
              }
              // A BETTER FIT THAT CREATES AN OVERLAP IS NOT BETTER. Optimising
              // each placement in isolation pushes pills into their
              // neighbours: measured, the first version took the geometry gate
              // from 80 to 89 overlapping pairs and 16 to 24 duplicates. The
              // cluster solver learned the same lesson; solids may not share
              // pixels, whatever the score says.
              const aa2 = Math.max(0, (fitEnv.maj - fitEnv.min) / 2);
              const nbrs = [];
              for (const g2 of scored) {
                if (g2.o === f.o) continue;
                if (Math.abs(g2.o.cx - x00) > 2 * fitEnv.maj) continue;
                if (Math.abs(g2.o.cy - y00) > 2 * fitEnv.maj) continue;
                const ot = (g2.o.theta !== undefined ? g2.o.theta
                  : (g2.o.shape ? g2.o.shape.theta : 0)) || 0;
                nbrs.push([g2.o.cx - Math.cos(ot) * aa2, g2.o.cy - Math.sin(ot) * aa2,
                  g2.o.cx + Math.cos(ot) * aa2, g2.o.cy + Math.sin(ot) * aa2]);
              }
              const clash = (nx, ny, nt) => {
                const sx = nx - Math.cos(nt) * aa2, sy = ny - Math.sin(nt) * aa2;
                const ex = nx + Math.cos(nt) * aa2, ey = ny + Math.sin(nt) * aa2;
                const seg = (ax, ay, bx, by, cx2, cy2) => {
                  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
                  let t = L2 ? ((cx2 - ax) * vx + (cy2 - ay) * vy) / L2 : 0;
                  t = t < 0 ? 0 : t > 1 ? 1 : t;
                  return Math.hypot(cx2 - (ax + t * vx), cy2 - (ay + t * vy));
                };
                for (const [ox2, oy2, px2, py2] of nbrs) {
                  const gap = Math.min(seg(ox2, oy2, px2, py2, sx, sy), seg(ox2, oy2, px2, py2, ex, ey),
                    seg(sx, sy, ex, ey, ox2, oy2), seg(sx, sy, ex, ey, px2, py2));
                  if (fitEnv.min - gap > 0.75) return true;
                }
                return false;
              };
              if (bq > qi + 0.05 && !clash(bx, by, bt)) {
                f.o.cx = bx; f.o.cy = by;
                if (f.o.theta !== undefined) f.o.theta = +bt.toFixed(3);
                else if (f.o.shape) f.o.shape.theta = +bt.toFixed(3);
                else f.o.theta = +bt.toFixed(3);
                qi = bq;
                nIou++;
              }
            }
            f.o.iou = +qi.toFixed(3);
            if (m && m.qRel !== null && m.qRel !== undefined) f.o.mqRel = +m.qRel.toFixed(3);
            if (q < flagBar && canJudge) { f.o.mqBad = 1; f.o.valid = 0; nFlag++; }
          }
          opts.debug?.({ stage: 'fitgate', iouReposed: nIou, pool: fitPool.length, n: scored.length,
            refineBar: +refineBar.toFixed(3), flagBar: +flagBar.toFixed(3),
            q50: +fitCal.q50.toFixed(3),
            refined: nRef, improved: nImp, flagged: nFlag, canJudge: canJudge ? 1 : 0,
            qBefore: +median(scored.map((f) => f.q0)).toFixed(3),
            qAfter: +median(scored.map((f) => (f.qF !== undefined ? f.qF : f.q0))).toFixed(3) });
        }
      }
    } catch (e) { opts.debug?.({ stage: 'fitgate', error: String((e && e.message) || e) }); }

    if (deferredGeometry) { try { deferredGeometry(); } catch { /* debug only */ } }

    const out = { count, regions, scale, boundaries, width: w, height: h, unitArea, thr: otsuThr };
    if (out2Template) out.templateInfo = out2Template;
    // For the interactive stamp tester (/pill/stamp): the exact shape and
    // the exact surface the counter used, so what the user probes is what
    // the algorithm sees — not a lookalike.
    // ENFORCE THE PHYSICAL LAW LAST. Invalid-placement recovery relocates a
    // stranded claim on background fraction alone (it checks co-location but
    // not interpenetration) and the fit gate re-poses for match quality --
    // measured on s261, running the solver before them left 0 overlapping
    // pairs and those two stages put 3 back at 19.1px.
    if (regions.__runClusterSolve) { regions.__runClusterSolve(); delete regions.__runClusterSolve; }

    if (opts.exportProbe) {
      // Self-contained: the probe must NOT depend on the template card
      // (that card only builds when opts.stages is set — the tester passes
      // exportProbe alone and got probe:null, crashing on kernel access).
      if (!out2Template) {
        const s2 = regions.filter((g2) => (g2.units || 1) === 1 && g2.shape
          && g2.shape.residual <= 0.12);
        const tM = median(s2.map((g2) => g2.shape.major))
          || median(regions.filter((g) => g.shape).map((g) => g.shape.major)) || 40;
        const tN = median(s2.map((g2) => g2.shape.minor))
          || median(regions.filter((g) => g.shape).map((g) => g.shape.minor)) || 18;
        out2Template = { primitive: 'stadium', major: +tM.toFixed(1), minor: +tN.toFixed(1),
          aspect: +(tM / Math.max(1, tN)).toFixed(2), fromSingles: s2.length };
      }
      const surfP = stampFgUsed || (() => {
        const f2 = new Uint8Array(w * h); const db2 = distBg.data;
        for (let i2 = 0; i2 < w * h; i2++) f2[i2] = db2[i2] > otsuThr ? 1 : 0;
        return f2; })();
      // also ship the CLEANED mask — the owner's misses live in the gap
      // between "threshold had it" and "cleaning kept it"
      const cleanP = new Uint8Array(w * h);
      for (let i2 = 0; i2 < w * h; i2++) cleanP[i2] = activeMd && activeMd[i2] > 0 ? 1 : 0;
      out.probe = { w, h, surf: surfP, clean: cleanP, scale,
        maj: out2Template.major, min: out2Template.minor,
        kernel: stampKernelUsed ? { grid: stampKernelUsed.grid, KG: stampKernelUsed.KG,
          span: stampKernelUsed.KSPAN } : null,
        placements: regions.flatMap((g) => (g.pills && g.pills.length)
          ? g.pills.map((p2) => [p2.cx, p2.cy, p2.theta])
          : (g.shape ? [[g.cx, g.cy, g.shape.theta]] : [])),
        // Per-placement fill overlap against the mask, in the same order as
        // `placements`. This is the "would the filled shape line up" number;
        // `cover` cannot express it because it only charges for stamp pixels
        // on background, never for mask the stamp missed.
        placementIou: regions.flatMap((g) => (g.pills && g.pills.length)
          ? g.pills.map((p2) => (p2.iou === undefined ? null : p2.iou))
          : (g.shape ? [g.iou === undefined ? null : g.iou] : [])) };
    }
    if (opts.variant === 'consensus') out.lowConfidence = lowConfidence;
    if (opts.variant === 'consensus' && consensusEligible <= 2 && regions.length) {
      // With <=2 countable blobs, the unit area is calibrated from the very
      // blobs being judged — a solid 50-pill cluster with invisible seams is
      // indistinguishable from one big pill (mass ratio 1 by construction).
      // Nothing independent certifies the count, so never let it pass silently.
      if (!lowConfidence) {
        out.lowConfidence = 1;
        const biggest = regions.reduce((a, r) => (r.area > a.area ? r : a));
        biggest.confidence = 'low';
      }
    }
    // CONFIDENCE SCORE (0..1). Not a probability — a summary of how much the
    // evidence agrees with itself. Every term is measured from this image, so
    // it degrades honestly on the exact conditions we know break counting:
    //   shapeAgreement  do the blobs look like ONE medication? (same-med prior)
    //   unitClarity     is there a tight cluster of single-pill areas to
    //                   calibrate on, or is the size model guesswork?
    //   clumpBurden     how much of the count came from dividing merged
    //                   masses rather than from seeing separate pills
    //   flagPenalty     regions the consensus panel itself distrusts
    // Measured behaviour: high scores concentrate on images we count exactly,
    // and the paper-towel/lined failures score low.
    if (regions.length) {
      const areas = regions.map((r) => r.area).filter((a) => a > 0).sort((a, b) => a - b);
      const u = unitArea > 0 ? unitArea : (areas[areas.length >> 1] || 1);
      // Singles: blobs within 35% of the unit. A healthy photo is mostly these.
      const singles = areas.filter((a) => a > u * 0.65 && a < u * 1.35);
      const unitClarity = Math.min(1, singles.length / Math.max(3, areas.length * 0.4));
      // Spread of the singles: identical pills should cluster tightly.
      let shapeAgreement = 0.5;
      if (singles.length >= 3) {
        const m = singles.reduce((s, a) => s + a, 0) / singles.length;
        const cv2 = Math.sqrt(singles.reduce((s, a) => s + (a - m) ** 2, 0) / singles.length) / m;
        shapeAgreement = Math.max(0, 1 - cv2 * 3); // cv 0.10 -> 0.70, cv 0.33 -> 0
      }
      // How much of the count is inferred from clumps rather than observed?
      const fromClumps = areas.reduce((s, a) => s + Math.max(0, Math.round(a / u) - 1), 0);
      const clumpBurden = count > 0 ? Math.min(1, fromClumps / count) : 1;
      const flagPenalty = count > 0 ? Math.min(1, (out.lowConfidence || 0) / count) : 1;
      // CROSS-CHECK: an independent estimate from pure area division. When two
      // methods that share no arithmetic land on the same number, that is real
      // corroboration; when they diverge the count is a guess wearing a
      // number. This term does the most work — without it a confidently wrong
      // count (r-cc7a2ada, 17 vs 19) scored as high as a correct one.
      const areaEstimate = areas.reduce((s, a) => s + Math.max(1, Math.round(a / u)), 0);
      const divergence = count > 0 ? Math.abs(areaEstimate - count) / count : 1;
      const agreement = Math.max(0, 1 - divergence * 4); // 5% apart -> 0.80, 25% -> 0
      const score = 0.25 * shapeAgreement + 0.20 * unitClarity
                  + 0.15 * (1 - clumpBurden) + 0.10 * (1 - flagPenalty)
                  + 0.30 * agreement;
      out.confidence = Math.max(0, Math.min(1, +score.toFixed(3)));
      out.confidenceParts = {
        shapeAgreement: +shapeAgreement.toFixed(3),
        unitClarity: +unitClarity.toFixed(3),
        clumpBurden: +clumpBurden.toFixed(3),
        agreement: +agreement.toFixed(3),
        areaEstimate,
        flagged: out.lowConfidence || 0,
      };
    } else {
      out.confidence = 0;
    }

    if (opts.returnImage) out.image = new Uint8ClampedArray(src.data); // RGBA at processed resolution
    return out;
  } finally {
    mats.forEach((m) => m.delete());
  }
}

// Draw detection results onto a 2D canvas. By default clears first (for a
// dedicated overlay canvas stacked on the photo); pass {clear:false} to draw
// on top of an already-rendered photo.
// Number pills the way a person actually counts them: finish one cluster
// before moving to the next, and read each cluster left-to-right in rows.
//
// Sorting by raw y made numbering jump, because two pills side by side differ
// by a few pixels of y. Pure row-banding is better but still walks straight
// through the gap between two separate groups. Pills come in clumps, so
// cluster first (single-link on centre distance, ~1.6 pill widths), then place
// the clusters in that same banded reading order by their centres.
export function readingOrder(regions) {
  if (regions.length < 2) return [...regions];

  const sizes = regions.map((r) => Math.sqrt(Math.max(1, r.area))).sort((a, b) => a - b);
  const unit = sizes[sizes.length >> 1] || 24;   // typical pill width
  const near = unit * 1.6;                       // same-cluster if closer
  const band = Math.max(12, unit * 0.75);        // one row of pills

  const parent = regions.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const dx = regions[i].cx - regions[j].cx, dy = regions[i].cy - regions[j].cy;
      if (dx * dx + dy * dy <= near * near) parent[find(i)] = find(j);
    }
  }

  const groups = new Map();
  regions.forEach((r, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const byRow = (a, b) => {
    const rowA = Math.round(a.cy / band), rowB = Math.round(b.cy / band);
    return rowA !== rowB ? rowA - rowB : a.cx - b.cx;
  };

  // WITHIN a cluster, walk NEAREST-NEIGHBOUR from the top-left member rather
  // than sorting by row. Row-sorting a clump makes the numbers hop back and
  // forth across it; walking the chain means adjacent pills get adjacent
  // numbers, which is how a person counts a pile they are pointing at.
  const walk = (members) => {
    if (members.length < 3) return [...members].sort(byRow);
    const left = members.slice().sort(byRow);
    const out = [left.shift()];
    while (left.length) {
      const cur = out[out.length - 1];
      let best = 0, bestD = Infinity;
      for (let i = 0; i < left.length; i++) {
        const d = (left[i].cx - cur.cx) ** 2 + (left[i].cy - cur.cy) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      out.push(left.splice(best, 1)[0]);
    }
    return out;
  };

  const clusters = [...groups.values()].map((members) => ({
    members: walk(members),
    cx: members.reduce((s, r) => s + r.cx, 0) / members.length,
    cy: members.reduce((s, r) => s + r.cy, 0) / members.length,
  }));
  clusters.sort(byRow);
  return clusters.flatMap((c) => c.members);
}

export function drawOverlay(ctx, result, displayScale, opts = {}) {
  const { regions, boundaries, width } = result;
  if (opts.clear !== false) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // THE PLATE. Owner's framing: "imagine a plate on a dinner table, with
  // pills on the plate" — the pills form one working region, and whatever
  // lies outside it (table edge, placemat, a strip of white tablecloth) is
  // not data. Measured motivation: a photo whose right margin caught the
  // table edge produced a 45x351px blob counted as NINE pills.
  //
  // Drawn rather than enforced. The counter still counts what it counts;
  // this shades everything outside the pill region so a mis-scoped frame is
  // obvious in the viewfinder ("some pills right on the edge") instead of
  // silently inflating the number. The hull is deliberately generous — it
  // exists to show scope, not to crop.
  if (opts.plate !== false && regions.length >= 3) {
    // Robust to strays. A convex hull is defined by its most extreme points,
    // so one false detection on the tablecloth drags the whole boundary out
    // to the frame edge (observed exactly that). Drop the farthest tail from
    // the median center first, so the plate describes where the pills ARE
    // rather than where the worst outlier is.
    const all = regions.map((r) => [r.cx * displayScale, r.cy * displayScale]);
    const medOf = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
    const mx0 = medOf(all.map((p) => p[0])), my0 = medOf(all.map((p) => p[1]));
    const dists = all.map(([x, y]) => Math.hypot(x - mx0, y - my0));
    const medD = medOf(dists) || 1;
    // keep points within 2.5x the median radius — a real spread-out layout
    // stays intact (its median radius grows with it); a lone flyer does not
    const pts = all.filter((_, i) => dists[i] <= Math.max(medD * 3.5, 1));
    const cx = pts.reduce((a, p) => a + p[0], 0) / (pts.length || 1);
    const cy = pts.reduce((a, p) => a + p[1], 0) / (pts.length || 1);
    // typical pill radius on screen, for the margin
    const rad = regions.reduce((a, r) => a + Math.sqrt((r.area || 0) / Math.PI), 0)
      / regions.length * displayScale;
    // Margin measured against the per-pill truth corpus: at 1.9x pill-radius
    // 17 of 444 annotated pills fell outside the plate, at 3.4x only 6 (and
    // those are detection misses on the lined set, not plate errors). The
    // plate must never exclude a real pill — it is a scope hint, not a crop.
    const margin = Math.max(18, rad * 3.4);
    // convex hull (monotone chain) of the pill centers, then inflate
    const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (arr) => {
      const h = [];
      for (const p of arr) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
        h.push(p);
      }
      h.pop();
      return h;
    };
    const hull = pts.length >= 3 ? [...half(sorted), ...half([...sorted].reverse())] : [];
    if (hull.length >= 3) {
      const inflated = hull.map(([x, y]) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
        return [x + (dx / d) * margin, y + (dy / d) * margin];
      });
      ctx.save();
      // shade OUTSIDE the plate: full-canvas path minus the hull (even-odd)
      ctx.beginPath();
      ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.moveTo(inflated[0][0], inflated[0][1]);
      for (let i = inflated.length - 1; i > 0; i--) ctx.lineTo(inflated[i][0], inflated[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(6, 10, 20, 0.42)';
      ctx.fill('evenodd');
      ctx.beginPath();
      ctx.moveTo(inflated[0][0], inflated[0][1]);
      for (let i = 1; i < inflated.length; i++) ctx.lineTo(inflated[i][0], inflated[i][1]);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 6]);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (boundaries) {
    ctx.fillStyle = 'rgba(61, 220, 151, 0.9)';
    const s = displayScale;
    for (let i = 0; i < boundaries.length; i++) {
      if (!boundaries[i]) continue;
      ctx.fillRect((i % width) * s, ((i / width) | 0) * s, Math.max(1, s), Math.max(1, s));
    }
  }

  // Numbered badge per pill; a region covering N pills gets a range badge
  // like "12–14" with an amber ring. Numbering follows CLUSTER reading order
  // (see readingOrder below) so one group is finished before the next starts.
  const ordered = readingOrder(regions);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Fitted ellipses (geometry variant): green = verified pill shape,
  // amber = convex-deficient cluster counted by mass.
  for (const r of ordered) {
    if (!r.ellipse) continue;
    const e = r.ellipse;
    ctx.beginPath();
    ctx.ellipse(e.cx * displayScale, e.cy * displayScale, e.rx * displayScale, e.ry * displayScale, (e.angle * Math.PI) / 180, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = r.cls === 'pill' ? 'rgba(47,179,128,0.95)' : 'rgba(255,176,32,0.95)';
    ctx.stroke();
  }

  // COMPACT BADGES. Field report on the old 15px white discs: "all this
  // crap is taking up too much room... why can't we just show center dots,
  // shrink the font." The photo is the product; badges annotate it without
  // covering it:
  //   - every INDIVIDUALLY PLACED pill gets its own small dot — a clump
  //     with placements renders as N dots, not one fat "8–9" range badge;
  //   - uncertainty lives in the ring colour (amber) alone. The old "20?"
  //     text shouted doubt on top of the colour that already said it.
  const drawDot = (x, y, label, warn) => {
    const rad = label.length > 2 ? 11 : 8.5;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = warn ? '#ffb020' : '#18a06a';
    ctx.stroke();
    ctx.fillStyle = '#0a0f19';
    ctx.font = `bold ${label.length > 2 ? 8.5 : 9.5}px system-ui, sans-serif`;
    ctx.fillText(label, x, y);
  };
  let n = 1;
  for (const r of ordered) {
    const low = r.confidence === 'low'; // consensus panel could not agree here
    if (r.pills && r.pills.length === r.units && r.units > 1) {
      for (const p of r.pills) {
        drawDot(p.cx * displayScale, p.cy * displayScale, String(n++), low || p.valid === 0);
      }
    } else if (r.units > 1) {
      drawDot(r.cx * displayScale, r.cy * displayScale, `${n}–${n + r.units - 1}`, true);
      n += r.units;
    } else {
      drawDot(r.cx * displayScale, r.cy * displayScale, String(n++), low);
    }
  }
}
