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
        && chainDensity(p) >= 0.55))
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
    if (a.n < 20 || a.th === undefined) return { n: a.n, err: Infinity, fill: 0, aspect: 0, cx: 0, cy: 0 };
    const e1 = a.pHi - a.pLo + 1, e2 = a.qHi - a.qLo + 1;
    const major = Math.max(e1, e2), minor = Math.max(1, Math.min(e1, e2));
    const aspect = major / minor;
    const fill = a.n / (major * minor);
    return { n: a.n, cx: rx0 + a.mx, cy: ry0 + a.my, fill, aspect, err: fitPrimitive(fill, aspect).err };
  });
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
      if (wellFormed.length >= 3) {
        const medGood = median(wellFormed.map((s) => s.area));
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
          if (misshapen && undersized) { count -= r.units; continue; } // splotch
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
          if (sh && sh.area < 0.45 * medGood) { count -= r.units; continue; }
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
      if (tplMajor > 0 && tplPool.length >= 5
        && (unitLen <= 0 || tplMajor > 1.4 * unitLen)) {
        const shortAreas = blobList
          .filter((l) => ((blobAxis.get(l) || {}).major || 0) > 0
            && (blobAxis.get(l).major) <= 1.35 * unitLen)
          .map((l) => blobAreas[l]);
        const shortAreMinor = shortAreas.length >= 3
          && tplArea > 0 && median(shortAreas) < 0.35 * tplArea;
        if (unitLen <= 0 || shortAreMinor) {
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
          // 8.8 is the measured median of (true single-pill area) / pk^2 across
          // the 24 hand-annotated photos, where it ranges 6.7-13.8 -- a 2.1x
          // spread across pills from 7.4px to 85.7px half-width. It is a SHAPE
          // constant, which is why it is so much tighter than the 3.0x spread
          // that caps the mass-division family in docs/splitting-bakeoff.md.
          const rescued = 8.8 * pk * pk;
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
          opts.debug({ stage: 'blobgeo', blob: l, area: blobAreas[l],
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
        const arcRef = ridgePk > 0 ? ridgePk : radiusEst;
        const arcCalOk = arcCal.capR >= MIN_PEAK * 0.75
          && arcCal.turnMass >= 4 * Math.PI
          && arcCal.capR >= 0.4 * arcRef && arcCal.capR <= 2.5 * arcRef;
        opts.debug?.({ stage: 'arccal', capR: +arcCal.capR.toFixed(1),
          turnMass: +arcCal.turnMass.toFixed(1), ok: arcCalOk,
          ridgePk: +ridgePk.toFixed(1), radiusEst: +radiusEst.toFixed(1) });

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
          const lenSingle = unitLen > 0 && majL > 0 && majL <= 1.35 * unitLen && widthSingle;
          // Round-up on a heavy fraction the BASELINE already claims. Plain
          // rounding throws away real evidence at the .3-.5 band: a clump
          // holding one flat pill plus one lying ON EDGE measures ~k+0.4
          // units, because an on-edge caplet projects only ~0.6-0.75x a flat
          // one's area. Measured on r-dbe1f2d8: a 3-pill clump read 2.40
          // units and the vote rounded it to 2, losing a pill the watershed
          // had already found. Only rounds toward a count the baseline
          // independently reached, so it can never invent pills on its own.
          const massFrac = unitOk ? blobAreas[l] / unit : 0;
          const heavyFraction = massFrac - Math.floor(massFrac) >= 0.3
            && Math.ceil(massFrac) === a.unitsSum;
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
            const stacked = peaks[l] >= 1.35 * radiusEst
              && unitLen > 0 && majL >= 1.5 * unitLen;

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
          const agreed = ks.length >= 2 && independent && !distancePairVsMass
            && !massContradicts && !belowLenFloor && k >= regs.length
            && (broadAmbiguity || k === a.unitsSum || corroboratedRise
              || corroboratedDescent);
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
                  opts.debug?.({ stage: 'seamcells', blob: l, k: kAcc, valid: ok,
                    cells: cells ? cells.map((cl) => ({ n: cl.n,
                      err: +cl.err.toFixed(3), aspect: +cl.aspect.toFixed(2) })) : null });
                  if (ok) {
                    seamTo = kAcc;
                    seamConf = okC[0].conf;
                    seamCellsOut = cells;
                    opts.debug?.({ stage: 'seamrec', blob: l, from: kFinal0,
                      to: seamTo, conf: seamConf, floorT: +floorT.toFixed(1),
                      iqr: +iqr.toFixed(1), massV: massW.v, arcLo, arcHi,
                      capacity: capacityS });
                  } else {
                    // The seams certify the depth but the resulting cells do
                    // not look like this photo's pills: the witnesses
                    // disagree irreconcilably. Keep the count, flag it —
                    // never silently pick.
                    lowConfidence++;
                    opts.debug?.({ stage: 'seaminvalid', blob: l, kFinal0, kAcc });
                  }
                }
              }
            }
          }
          if (seamTo) {
            if (seamConf === 'low') lowConfidence++;
            count -= a.unitsSum;
            count += seamTo;
            // Badge placement: the accepted cells' centroids ARE the pill
            // locations (basin centroids, the localizer's proven strength).
            // `arc: true` exempts them from fragment consolidation for the
            // same reason as the arc witness: this raise exists precisely
            // because the outline under-reports the pills inside it.
            for (const cl of seamCellsOut) {
              regions.push({ cx: cl.cx, cy: cl.cy, area: cl.n, units: 1,
                confidence: seamConf, arc: true, seam: true });
            }
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
        if (cid && medRegion) {
          const smoothAreas = ells.slice(1).map((e) => e.area);
          if (smoothAreas.length && smoothAreas.every((a) => a > maxPill)) {
            const medSmooth = median(smoothAreas);
            maxPill = medSmooth * 1.5;
            opts.debug?.({ stage: 'consolidate-cap', from: medRegion * 3, to: maxPill, contours: smoothAreas.length });
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
      // Convex-ish regions always contain their centroid, and a miss (label
      // <= 0 at a boundary pixel) just means that region skips classification.
      for (const r of regions) {
        if (r.label == null) {
          const lbl = activeMd[Math.round(r.cy) * w + Math.round(r.cx)];
          if (lbl > 0) r.label = lbl;
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
