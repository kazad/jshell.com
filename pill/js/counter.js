// Pill counting pipeline: threshold -> morphology -> distance transform -> watershed.
// Touching pills are split by watershed; oversized regions get an area-ratio fallback.
// Environment-agnostic: runs in the browser and in Node (see tools/count-cli.mjs).

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
function colorDist(dr, dg, db) {
  const dl = (dr + dg + db) / 3;
  const cr = dr - dl, cg = dg - dl, cb = db - dl;
  const chroma2 = cr * cr + cg * cg + cb * cb;
  // Shadow = luminance-dominant darkening. On saturated surfaces (wood),
  // shading is multiplicative, so deep shadows shift chroma proportionally —
  // the gate must scale with |dl| rather than stay absolute.
  const lumaW = dl < 0 && chroma2 < Math.max(400, 0.5 * dl * dl) ? 0.12 : 1;
  return Math.min(255, Math.sqrt(chroma2 + lumaW * dl * dl) | 0);
}

// Per-pixel color distance from the NEAREST background color, as a CV_8U Mat.
// Also returns a raw (shadow-damping-free) map: white pill bodies that sit
// slightly darker than a light background look like shadows to the damped
// metric, but the rescue stage can re-examine them in the raw map where its
// pill-shape filters (not luma damping) reject actual cast shadows.
function distanceFromBackground(cv, rgbaMat) {
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
      const v = colorDist(dr, dg, db);
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
    const accept = pillLike.length >= 3 && score >= 0.5;
    debug?.({ stage: 'refine', blobArea, kept, keptRatio: +keptRatio.toFixed(3),
      pillLike: pillLike.length, pillRatio: +pillRatio.toFixed(3), score: +score.toFixed(3), thr, accept });
    if (accept) {
      refined++;
    } else {
      for (let i = 0; i < ll.length; i++) if (ll[i] === blob) mask[i] = 255;
    }
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
  const confirmed = [...pre.values()].filter((p) => p.area >= absFloor && p.peak >= 4);
  if (confirmed.length < 1) return 0;
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
    if (!p) { p = { area: 0, peak: 0, dtSum: 0, newArea: 0, lumSum: 0 }; pieces.set(ll[i], p); }
    p.area++;
    p.dtSum += dd[i];
    if (!mask[i]) {
      p.newArea++;
      const q = i * 4;
      p.lumSum += (sd[q] + sd[q + 1] + sd[q + 2]) / 3;
    }
    if (dd[i] > p.peak) p.peak = dd[i];
  }
  debug?.({ stage: 'rescue', t2, medA, medP, pieces: [...pieces.values()].filter((p) => p.area > 2.2 * medA).map((p) => `a${p.area | 0}p${p.peak.toFixed(1)}m${(p.dtSum / p.area / p.peak).toFixed(2)}n${(p.newArea / p.area).toFixed(2)}`).slice(0, 40) });
  // Unit pill radius implied by the confirmed-pill median area (medP is
  // unreliable pre-fillHoles: specular holes flatten the distance peak).
  const rUnit = Math.sqrt(medA / Math.PI);
  const good = new Set([...pieces.entries()]
    .filter(([, p]) => (p.area >= Math.max(absFloor, 0.45 * medA) && p.area <= 2.2 * medA
      && p.peak >= Math.max(4, 0.5 * medP) && p.area <= 4 * Math.PI * p.peak * p.peak)
      // Touching CHAIN of same-medication pills: single-pill thickness but a
      // multi-unit area. Watershed + area-split handle the separation later.
      // The new material must not be darker than the background — a pill
      // glued to its own shadow ring mimics a chain geometrically, but its
      // new material is shadow (dark), not pill (bright).
      || (p.area > 2.2 * medA && p.area <= 12 * medA
        && p.peak >= 0.8 * rUnit && p.peak <= 1.35 * rUnit
        && p.lumSum >= (bgLum - 6) * p.newArea))
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

// Pills are solid: any background component fully enclosed by foreground is
// an artifact (specular highlight, engraving) — fill it.
function fillHoles(cv, bw, debug) {
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
  const md = bw.data;
  for (let i = 0; i < ll.length; i++) {
    if (ll[i] && !touchesBorder[ll[i]]) md[i] = 255;
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

  const src = cv.matFromImageData(toImageData(source));
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

    // Level out vignettes and lighting gradients before any color reasoning.
    flattenIllumination(cv, src);

    // Segment by color distance from the background (est. from the border) —
    // works for colored pills that grayscale Otsu lumps into the background.
    const dfb = distanceFromBackground(cv, src);
    const distBg = track(dfb.mat);
    const distBgRaw = track(dfb.raw);
    cv.GaussianBlur(distBgRaw, distBgRaw, new cv.Size(5, 5), 0);
    if (emit) emit('bgcolor', dfb.color);
    cv.GaussianBlur(distBg, distBg, new cv.Size(5, 5), 0);
    if (emit) emit('distmap', grayToStage(distBg));
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

    // Plates/trays segment as one huge blob; re-segment those against their
    // own surface color (twice, for nested surfaces like table -> plate).
    if (refineOversizedBlobs(cv, src, bw, absFloor, opts.debug)) refineOversizedBlobs(cv, src, bw, absFloor, opts.debug);

    // Faint pills hidden below a bimodal Otsu split (white pills next to
    // colored ones on a light tray) get a second chance.
    if (usedColorDist) {
      const bgLum = (dfb.color[0] + dfb.color[1] + dfb.color[2]) / 3;
      rescueSecondMode(cv, distBg, bw, absFloor, src, bgLum, opts.debug);
    }

    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    const anchor = new cv.Point(-1, -1);
    cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel, anchor, 2);
    cv.morphologyEx(bw, bw, cv.MORPH_CLOSE, kernel, anchor, 2);
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
      for (let i = 0; i < dd.length; i++) dnd[i] = Math.min(255, (dd[i] / mm.maxVal) * 255) | 0;
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
    const radiusEst = median(candPeaks) || mm.maxVal;

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
    for (let i = 0; i < bl.length; i++) {
      const l = bl[i];
      if (!l || peaks[l] < MIN_PEAK) { sf[i] = 0; continue; }
      if (peaks[l] <= 1.4 * radiusEst) {
        sf[i] = dd[i] >= 0.6 * peaks[l] ? 255 : 0;
      } else {
        sf[i] = dd[i] >= pileFloor && dd[i] >= dm[i] ? 255 : 0;
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
      if (!s) { s = { area: 0, sx: 0, sy: 0, peak: 0 }; stats.set(l, s); }
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
    for (const [lbl, s] of stats) {
      if (s.area < minArea) continue;
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
      if (wellFormed.length >= 3) {
        const medGood = median(wellFormed.map((s) => s.area));
        const kept = [];
        for (const r of regions) {
          const sh = shapes[io[Math.round(r.cy) * w + Math.round(r.cx)] || 0];
          const misshapen = sh && (sh.solidity < 0.88 || sh.circularity < 0.50);
          const undersized = sh && sh.area < 0.75 * medGood;
          if (misshapen && undersized) { count -= r.units; continue; } // splotch
          kept.push(r);
        }
        if (kept.length !== regions.length) {
          opts.debug?.({ stage: 'splotch', removed: regions.length - kept.length, medGood });
        }
        regions = kept;
      }
    }

    let activeMd = md;
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
        if (blobAreas[l] >= absFloor && peaks[l] >= MIN_PEAK) blobList.push(l);
      }
      let unit = estimateUnitArea(blobList.map((l) => blobAreas[l]));

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
      if (pieces.length >= blobList.length * 2 && unit2 >= Math.max(absFloor, minPlausibleUnit)) unit = unit2;
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
      const unitLen = estimateUnitLength(blobList.map((l) => (blobAxis.get(l) || {}).major || 0).filter((m) => m > 0));
      opts.debug?.({ stage: 'lengthcal', unitLen, unit });

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

        for (const a of ambiguous) {
          const { l, regs } = a;
          // A single pill of this blob's thickness can cover at most ~4*pi*peak^2
          // px. When crease-cut or erosion answers "1" for a blob far beyond
          // that, they did not measure one pill — they hit their documented
          // failure mode (invisible seams / no separating neck). Abstain.
          const singleable = blobAreas[l] <= 4 * Math.PI * peaks[l] * peaks[l];

          // Length veto on the mass vote. A blob no longer than one pill
          // cannot contain two of them end to end, whatever its area says.
          // This is what catches the on-edge population: when many pills lie
          // on their narrow side, the area-calibrated unit collapses toward
          // the on-edge area and mass reads 2 on every FLAT single pill. The
          // major axis does not collapse, so it arbitrates. Only applied to
          // shrink an over-reading mass vote, never to raise one.
          const majL = (blobAxis.get(l) || {}).major || 0;
          const lenSingle = unitLen > 0 && majL > 0 && majL <= 1.35 * unitLen;
          const massV = lenSingle ? 1 : Math.max(1, a.k0);
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
          // A downward override that pixel mass contradicts UPWARD (mass
          // saw even more material than the baseline counted) is the whole
          // geometry family under-reading an overlapped clump — reject it.
          const massContradicts = k < a.unitsSum && massVote && massVote.v > a.unitsSum;
          const agreed = ks.length >= 2 && independent && !distancePairVsMass
            && !massContradicts && k >= regs.length
            && (broadAmbiguity || k === a.unitsSum);
          opts.debug?.({ stage: 'panel', blob: l, votes, k, agreed, base: a.unitsSum });
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
        opts.debug?.({ stage: 'contour', area: Math.round(area), solidity: +solidity.toFixed(3), fillR: +fillR.toFixed(3), aspect: +aspect.toFixed(2), maxDefect: +maxDefect.toFixed(1), minorHalf: +minorHalf.toFixed(1) });
        if (solidity >= 0.92 && fillR >= 0.85 && fillR <= 1.15 && aspect <= 3.5 && smoothOutline) {
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
        const maxPill = medRegion ? medRegion * 3 : Infinity;

        const im = idMask.data;
        const merged = new Map();
        const keep = [];
        for (const r of regions) {
          const k = im[Math.round(r.cy) * w + Math.round(r.cx)];
          if (!k || ells[k].area > maxPill) { keep.push(r); continue; }
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
    if (withOverlay) {
      boundaries = new Uint8Array(activeMd.length);
      for (let i = 0; i < activeMd.length; i++) if (activeMd[i] === -1) boundaries[i] = 1;
    }

    const out = { count, regions, scale, boundaries, width: w, height: h, unitArea, thr: otsuThr };
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
    if (opts.returnImage) out.image = new Uint8ClampedArray(src.data); // RGBA at processed resolution
    return out;
  } finally {
    mats.forEach((m) => m.delete());
  }
}

// Draw detection results onto a 2D canvas. By default clears first (for a
// dedicated overlay canvas stacked on the photo); pass {clear:false} to draw
// on top of an already-rendered photo.
export function drawOverlay(ctx, result, displayScale, opts = {}) {
  const { regions, boundaries, width } = result;
  if (opts.clear !== false) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (boundaries) {
    ctx.fillStyle = 'rgba(61, 220, 151, 0.9)';
    const s = displayScale;
    for (let i = 0; i < boundaries.length; i++) {
      if (!boundaries[i]) continue;
      ctx.fillRect((i % width) * s, ((i / width) | 0) * s, Math.max(1, s), Math.max(1, s));
    }
  }

  // Numbered badge per pill (reading order); a region covering N pills gets
  // a range badge like "12–14" with an amber ring.
  const ordered = [...regions].sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
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

  let n = 1;
  for (const r of ordered) {
    const x = r.cx * displayScale, y = r.cy * displayScale;
    const multi = r.units > 1;
    const low = r.confidence === 'low'; // consensus panel could not agree here
    const label = low ? (multi ? `${n}–${n + r.units - 1}?` : `${n}?`)
      : (multi ? `${n}–${n + r.units - 1}` : String(n));
    n += r.units;
    const rad = multi || low ? 15 : 11;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = multi || low ? '#ffb020' : '#18a06a';
    ctx.stroke();
    ctx.fillStyle = '#0a0f19';
    ctx.font = `bold ${multi || low ? 10 : 12}px system-ui, sans-serif`;
    ctx.fillText(label, x, y);
  }
}
