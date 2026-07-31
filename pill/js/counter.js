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

// Median RGB of the image border — an estimate of the background/tray color.
function borderColor(rgba, w, h) {
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const o = (y * w + x) * 4;
    rs.push(rgba[o]); gs.push(rgba[o + 1]); bs.push(rgba[o + 2]);
  };
  for (let y = 0; y < t; y++) {
    for (let x = 0; x < w; x += 3) { push(x, y); push(x, h - 1 - y); }
  }
  for (let x = 0; x < t; x++) {
    for (let y = t; y < h - t; y += 3) { push(x, y); push(w - 1 - x, y); }
  }
  return [median(rs), median(gs), median(bs)];
}

// Color difference vs a reference, damping only shadow-like shifts (darker
// than the reference at near-identical chroma). White pills on white counters
// keep full luminance weight; cast shadows don't.
function colorDist(dr, dg, db) {
  const dl = (dr + dg + db) / 3;
  const cr = dr - dl, cg = dg - dl, cb = db - dl;
  const chroma2 = cr * cr + cg * cg + cb * cb;
  const lumaW = dl < 0 && chroma2 < 400 ? 0.12 : 1;
  return Math.min(255, Math.sqrt(chroma2 + lumaW * dl * dl) | 0);
}

// Per-pixel color distance from the background color, as a CV_8U Mat.
function distanceFromBackground(cv, rgbaMat) {
  const w = rgbaMat.cols, h = rgbaMat.rows;
  const d = rgbaMat.data;
  const [br, bg, bb] = borderColor(d, w, h);
  const out = new cv.Mat(h, w, cv.CV_8UC1);
  const o = out.data;
  for (let i = 0, p = 0; i < o.length; i++, p += 4) {
    o[i] = colorDist(d[p] - br, d[p + 1] - bg, d[p + 2] - bb);
  }
  return { mat: out, color: [br, bg, bb] };
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

function refineOversizedBlobs(cv, src, bw, absFloor) {
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
    const thr = Math.max(12, otsuFromHist(hist, n));
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
    if (pillLike.length >= 3 && pillArea >= 0.4 * kept && kept <= 0.5 * blobArea) {
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
function rescueSecondMode(cv, distBg, bw, absFloor) {
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
  if (t2 < 8) return 0; // residual is flat noise, nothing hiding in it

  const cand = new cv.Mat(bw.rows, bw.cols, cv.CV_8UC1);
  const cd = cand.data;
  for (let i = 0; i < mask.length; i++) cd[i] = !mask[i] && db[i] > t2 ? 255 : 0;
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(cand, cand, cv.MORPH_OPEN, k, new cv.Point(-1, -1), 2);

  const lab = new cv.Mat();
  cv.connectedComponents(cand, lab);
  const dist = new cv.Mat();
  cv.distanceTransform(cand, dist, cv.DIST_L2, 5);
  const ll = lab.data32S, dd = dist.data32F;
  const pieces = new Map();
  for (let i = 0; i < ll.length; i++) {
    if (!ll[i]) continue;
    let p = pieces.get(ll[i]);
    if (!p) { p = { area: 0, peak: 0 }; pieces.set(ll[i], p); }
    p.area++;
    if (dd[i] > p.peak) p.peak = dd[i];
  }
  const good = new Set([...pieces.entries()]
    .filter(([, p]) => p.area >= Math.max(absFloor, 0.45 * medA) && p.area <= 2.2 * medA
      && p.peak >= Math.max(4, 0.5 * medP) && p.area <= 4 * Math.PI * p.peak * p.peak)
    .map(([l]) => l));
  let added = 0;
  if (good.size && good.size <= 500) {
    for (let i = 0; i < ll.length; i++) {
      if (good.has(ll[i])) { mask[i] = 255; added++; }
    }
  }
  k.delete(); cand.delete(); lab.delete(); dist.delete();
  return added;
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

    // Segment by color distance from the background (est. from the border) —
    // works for colored pills that grayscale Otsu lumps into the background.
    const dfb = distanceFromBackground(cv, src);
    const distBg = track(dfb.mat);
    if (emit) emit('bgcolor', dfb.color);
    cv.GaussianBlur(distBg, distBg, new cv.Size(5, 5), 0);
    if (emit) emit('distmap', grayToStage(distBg));
    const bw = track(new cv.Mat());
    cv.threshold(distBg, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

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
    if (refineOversizedBlobs(cv, src, bw, absFloor)) refineOversizedBlobs(cv, src, bw, absFloor);

    // Faint pills hidden below a bimodal Otsu split (white pills next to
    // colored ones on a light tray) get a second chance.
    if (usedColorDist) rescueSecondMode(cv, distBg, bw, absFloor);

    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    const anchor = new cv.Point(-1, -1);
    cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel, anchor, 2);
    cv.morphologyEx(bw, bw, cv.MORPH_CLOSE, kernel, anchor, 2);
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
    const areas = [...stats.values()].map((s) => s.area).filter((a) => a >= absFloor);
    const med = median(areas);
    const minArea = Math.max(absFloor, med * 0.3);

    const medPeak = median([...stats.values()].filter((s) => s.area >= minArea).map((s) => s.peak));
    let regions = [];
    let count = 0;
    for (const s of stats.values()) {
      if (s.area < minArea) continue;
      if (s.peak < MIN_PEAK) continue; // thin artifact (rim, engraving), not a pill
      // Oversized region => watershed under-split; estimate pills by area ratio.
      // 2.4x guard keeps mixed pill sizes (capsule vs tablet) from false splits;
      // splitting also requires pill-like thickness so rings/rims never multiply.
      const units = med > 0 && s.area > med * 2.4 && s.peak >= 0.8 * medPeak
        ? Math.max(1, Math.round(s.area / med)) : 1;
      count += units;
      regions.push({ cx: s.sx / s.area, cy: s.sy / s.area, area: s.area, units });
    }

    let activeMd = md;
    let unitArea = 0;

    // 'mass' variant: pixel-mass counting. Same medication => equal pill
    // area, so each blob's pixel count is ~an integer multiple of one pill's
    // area. Count = sum of round(blobArea / unitArea); watershed boundaries
    // are kept only for the overlay.
    if (opts.variant === 'mass') {
      const blobList = [];
      for (let l = 1; l < peaks.length; l++) {
        if (blobAreas[l] >= absFloor && peaks[l] >= MIN_PEAK) blobList.push(l);
      }
      const unit = estimateUnitArea(blobList.map((l) => blobAreas[l]));
      opts.debug?.({ stage: 'mass', blobs: blobList.length, unit });
      if (blobList.length >= 2 && unit >= absFloor) {
        const cent = new Map(blobList.map((l) => [l, { sx: 0, sy: 0, n: 0 }]));
        for (let i = 0; i < bl.length; i++) {
          const c = cent.get(bl[i]);
          if (c) { c.sx += i % w; c.sy += (i / w) | 0; c.n++; }
        }
        regions = [];
        count = 0;
        for (const l of blobList) {
          const units = Math.max(1, Math.round(blobAreas[l] / unit));
          count += units;
          const c = cent.get(l);
          regions.push({ cx: c.sx / c.n, cy: c.sy / c.n, area: blobAreas[l], units });
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

    let boundaries = null;
    if (withOverlay) {
      boundaries = new Uint8Array(activeMd.length);
      for (let i = 0; i < activeMd.length; i++) if (activeMd[i] === -1) boundaries[i] = 1;
    }

    const out = { count, regions, scale, boundaries, width: w, height: h, unitArea };
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
  let n = 1;
  for (const r of ordered) {
    const x = r.cx * displayScale, y = r.cy * displayScale;
    const multi = r.units > 1;
    const label = multi ? `${n}–${n + r.units - 1}` : String(n);
    n += r.units;
    const rad = multi ? 15 : 11;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = multi ? '#ffb020' : '#18a06a';
    ctx.stroke();
    ctx.fillStyle = '#0a0f19';
    ctx.font = `bold ${multi ? 10 : 12}px system-ui, sans-serif`;
    ctx.fillText(label, x, y);
  }
}
