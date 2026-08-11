// STAMP-PEEL-REPEAT — the merged stamp machinery (tools/stamp-v-merged.mjs)
// as a browser-safe ES module. No Node APIs: only the cv module handle and
// typed arrays, same contract as js/counter.js.
//
// Recipe provenance (verified offline, see tools/stamp-v-merged.mjs header):
//   1. Candidate discovery + template: thickness-vetted mask candidates
//      (connectedComponents+DT, cross-extent ~= 2x own DT peak, DT peak in
//      [0.55,1.5]x radiusEst, stadium IoU >= 0.8, inner-half waist vet at
//      0.68x peak), medoid cluster (18%) template, q25 aggregation, 0.92
//      shrink, minor-vs-thickness cross-check (>25% disagreement ->
//      thickness-derived minor).
//   2. Arbitration chassis: trust-tested pipeline anchors (units==1,
//      residual<=0.06, ASYMMETRIC area band — only above-implied
//      disqualifies, minor in [0.7,1.3]x2Rthick) pre-claimed at 0.95 inset;
//      peel only contested material; coordinate-ascent refine to 1px/pi/48.
//   3. Peel score = coverage with a DT-graded background penalty
//      (-1.4*min(1, dtOut/(MIN/4))); claimed pixels NEUTRAL, 0.5 overlap cap;
//      seeds allowed on claimed fg; tau self-calibrated on the candidates at
//      their own poses incl. EXACT theta (factor 0.6).
//   4. Dossier checks per stamp: interior-photometry claim-but-don't-count;
//      bg-facing boundary edge-support gate, veto-not-break (12 fails).
//   5. Weak-evidence retries, accept-only-if-explains-more: (a) pre-purge
//      otsu-mask rerun, (b) DT-maxima circle-template raft pass, (c) on-edge
//      second pass. INTEGRATION SCOPING: (a) and (b) additionally require
//      the beige signature — the cleaned mask explains <0.65 of the otsu
//      mask (env.cover < 0.65). The shiny signature (glare-shredded blobs
//      with HIGH otsu coverage) must never trigger them: measured, that path
//      was the +4 overcount on the shiny pair.
//
// INTEGRATION SCOPING vs the offline tool (counter calls this as a
// LAST-RESORT arbiter, so normal photos never pay its cost):
//   - The main peel is restricted (allow mask) to CONTESTED blobs: blobs
//     holding a low-confidence or oversized-unwitnessed region, plus
//     pill-scale foreground blobs no region owns. Anchor claims and the
//     self-calibration stay image-wide (they are what "a real pill scores
//     here" means).
//   - Per-blob arbitration runs ONLY over those contested blobs; everywhere
//     else the pipeline's verdict stands untouched.
//   - When the otsu rerun wins (the mask purged real material — beige), the
//     per-blob fallback is skipped: the pipeline's own units are corrupt by
//     construction there (measured: 96/90 with fallback vs 90 exact without)
//     and the stamp's placements replace the non-anchor accounting outright.

const K = 12;
const MIN_PEAK = 4;
const EDGE_OFF = 1.8;

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const q25 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length * 0.25) | 0] : 0; };
export const stadArea = (maj, min) => { const a = (maj - min) / 2, rho = min / 2; return min * (maj - min) + Math.PI * rho * rho; };

// stamp interior points (unrotated [u,v]) and boundary points ([u,v,nu,nv])
function basePts(maj, min) {
  const a = (maj - min) / 2, rho = min / 2, pts = [];
  const step = Math.max(1.2, min / 7);
  for (let u = -maj / 2; u <= maj / 2; u += step) for (let v = -min / 2; v <= min / 2; v += step) {
    const du = Math.max(0, Math.abs(u) - a);
    if (du * du + v * v > rho * rho) continue;
    pts.push([u, v]);
  }
  return pts;
}
function boundPts(maj, min) {
  const a = (maj - min) / 2, rho = min / 2, bd = [];
  const stepLen = 2.5;
  const nArc = Math.max(4, Math.round(Math.PI * rho / stepLen));
  for (let j = 0; j < nArc; j++) {
    const phi = -Math.PI / 2 + (j + 0.5) * Math.PI / nArc;
    bd.push([a + rho * Math.cos(phi), rho * Math.sin(phi), Math.cos(phi), Math.sin(phi)]);
  }
  for (let j = 0; j < nArc; j++) {
    const phi = Math.PI / 2 + (j + 0.5) * Math.PI / nArc;
    bd.push([-a + rho * Math.cos(phi), rho * Math.sin(phi), Math.cos(phi), Math.sin(phi)]);
  }
  const nFlat = Math.max(1, Math.round(2 * a / stepLen));
  if (a > 0.5) for (let j = 0; j < nFlat; j++) {
    const u = -a + (j + 0.5) * 2 * a / nFlat;
    bd.push([u, rho, 0, 1]); bd.push([u, -rho, 0, -1]);
  }
  return bd;
}

// ===================== DATA-DRIVEN STAMP KERNEL =====================
// The parametric stadium family cannot represent pentagons, scored tablets
// or hearts: measured on t2-salmon-pentagon-tablets-teal, the fitted circle
// template clips every corner, explains only 0.736 of the mask and reads 81
// for an audited 90. The kernel is the MEDIAN SILHOUETTE learned from the
// photo itself: each thickness-vetted single candidate's binary mask is
// rotation-normalized (principal axis to 0, plus an IoU alignment search —
// valid because only near-isotropic shapes need it), resampled onto a
// common KG x KG grid in units of its own fitted major/minor, averaged, and
// thresholded at 0.5. The stadium remains the fallback when evidence is
// thin (cands < 4), the silhouette is unstable across candidates (median
// aligned IoU < KERNEL_ALIGN_MIN), or the silhouette IS a stadium (IoU vs
// the parametric stadium >= KERNEL_STAD_MAX — then the kernel would only
// add numeric drift, never information).
const KG = 64;          // kernel grid resolution
const KSPAN = 1.3;      // grid covers KSPAN*maj x KSPAN*min about the centre
// Measured separation on the corpus: a REAL consistent non-stadium shape
// aligns tightly (pentagon otsu 0.955, s301 rounds 0.936, stable beige
// rounds 0.98+); glare-shredded or eroded masks align at 0.86-0.905
// (s-eb90778f final 0.862 / chroma 0.905 — activating there cost a real
// bead, 36-for-37). 0.92 sits in the measured gap.
const KERNEL_ALIGN_MIN = 0.92;
const KERNEL_STAD_MAX = 0.93;

function kernAt(kern, u, v, maj, min) {
  const gx = Math.floor((u / (KSPAN * maj) + 0.5) * KG);
  const gy = Math.floor((v / (KSPAN * min) + 0.5) * KG);
  if (gx < 0 || gy < 0 || gx >= KG || gy >= KG) return 0;
  return kern.g[gy * KG + gx];
}

// interior sample points of the kernel silhouette (same density as basePts)
function basePtsK(maj, min, kern) {
  const pts = [], step = Math.max(1.2, min / 7);
  const HU = KSPAN * maj / 2, HV = KSPAN * min / 2;
  for (let u = -HU; u <= HU; u += step) for (let v = -HV; v <= HV; v += step) {
    if (kernAt(kern, u, v, maj, min)) pts.push([u, v]);
  }
  return pts.length >= 8 ? pts : basePts(maj, min);
}

// boundary points + outward normals from the silhouette's own contour.
// Normals transform with the inverse scale (surface-normal law); at the
// learned aspect the scale is ~uniform so this is exact where it matters.
function boundPtsK(maj, min, kern) {
  const raw = [];
  for (const [pu, pv, gu, gv] of kern.bnd) {
    const u = pu * maj, v = pv * min;
    let nx = gu / Math.max(1e-6, maj), ny = gv / Math.max(1e-6, min);
    const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    raw.push([u, v, nx, ny, Math.atan2(v, u)]);
  }
  raw.sort((A, B) => A[4] - B[4]);
  const bd = [], stepLen = 2.5;
  let last = null;
  for (const p of raw) {
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < stepLen) continue;
    bd.push([p[0], p[1], p[2], p[3]]); last = p;
  }
  return bd.length >= 6 ? bd : boundPts(maj, min);
}

const gridIoU = (A, B) => {
  let i = 0, u = 0;
  for (let k = 0; k < KG * KG; k++) { if (A[k] && B[k]) i++; if (A[k] || B[k]) u++; }
  return u ? i / u : 0;
};

// resample one candidate blob's mask into its normalized frame; rot is an
// extra in-plane alignment rotation applied in that frame.
function sampleCandGrid(b, rot, lab, w, h) {
  const g = new Uint8Array(KG * KG);
  const ct = Math.cos(b.theta), st = Math.sin(b.theta);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let gy = 0; gy < KG; gy++) for (let gx = 0; gx < KG; gx++) {
    const nu = ((gx + 0.5) / KG - 0.5) * KSPAN, nv = ((gy + 0.5) / KG - 0.5) * KSPAN;
    const ru = nu * cr - nv * sr, rv = nu * sr + nv * cr;
    const u = ru * b.major, v = rv * b.minor;
    const x = Math.round(b.cx + u * ct - v * st), y = Math.round(b.cy + u * st + v * ct);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (lab[y * w + x] === b.l) g[gy * KG + gx] = 1;
  }
  return g;
}

// Learn the median silhouette from the vetted single candidates. Returns
// { kernel|null, medAlign, iouStad, note } — the caller applies the gates.
function learnKernel(cands, lab, w, h) {
  const grids = cands.map((b) => sampleCandGrid(b, 0, lab, w, h));
  // medoid reference: the candidate whose unrotated grid agrees most with
  // the rest (a mis-fit candidate must not define the frame)
  let ref = 0, refSum = -1;
  for (let i = 0; i < grids.length; i++) {
    let s = 0;
    for (let j = 0; j < grids.length; j++) if (j !== i) s += gridIoU(grids[i], grids[j]);
    if (s > refSum) { refSum = s; ref = i; }
  }
  const mean = new Float32Array(KG * KG);
  const aligns = [];
  for (let i = 0; i < grids.length; i++) {
    let bestG = grids[i], bestI = gridIoU(grids[i], grids[ref]);
    if (i !== ref) {
      // alignment search mod the shape's own symmetry (10-degree steps);
      // principal-axis theta is noise for near-isotropic shapes (a regular
      // pentagon's covariance is ~isotropic), so averaging without this
      // would round the corners right back off
      for (let k = 1; k < 36; k++) {
        const g2 = sampleCandGrid(cands[i], k * Math.PI / 18, lab, w, h);
        const io = gridIoU(g2, grids[ref]);
        if (io > bestI) { bestI = io; bestG = g2; }
      }
    }
    aligns.push(bestI);
    for (let k = 0; k < KG * KG; k++) mean[k] += bestG[k];
  }
  for (let k = 0; k < KG * KG; k++) mean[k] /= grids.length;
  const kg = new Uint8Array(KG * KG);
  for (let k = 0; k < KG * KG; k++) kg[k] = mean[k] >= 0.5 ? 1 : 0;
  // fill interior holes (imprints/score lines carve the mask): flood the
  // outside from the border, everything unreached becomes silhouette
  {
    const out = new Uint8Array(KG * KG), st = [];
    for (let k = 0; k < KG; k++) {
      for (const i2 of [k, (KG - 1) * KG + k, k * KG, k * KG + KG - 1]) {
        if (!kg[i2] && !out[i2]) { out[i2] = 1; st.push(i2); }
      }
    }
    while (st.length) {
      const i2 = st.pop(), x2 = i2 % KG, y2 = (i2 / KG) | 0;
      if (x2 > 0 && !kg[i2 - 1] && !out[i2 - 1]) { out[i2 - 1] = 1; st.push(i2 - 1); }
      if (x2 < KG - 1 && !kg[i2 + 1] && !out[i2 + 1]) { out[i2 + 1] = 1; st.push(i2 + 1); }
      if (y2 > 0 && !kg[i2 - KG] && !out[i2 - KG]) { out[i2 - KG] = 1; st.push(i2 - KG); }
      if (y2 < KG - 1 && !kg[i2 + KG] && !out[i2 + KG]) { out[i2 + KG] = 1; st.push(i2 + KG); }
    }
    for (let k = 0; k < KG * KG; k++) if (!kg[k] && !out[k]) kg[k] = 1;
  }
  const medAlign = med(aligns);
  // parametric stadium at the candidates' own median fit, same grid
  const cMaj = med(cands.map((c) => c.major)), cMin = med(cands.map((c) => c.minor));
  const sg = new Uint8Array(KG * KG);
  {
    const a = (cMaj - cMin) / 2, rho = cMin / 2, rho2 = rho * rho;
    for (let gy = 0; gy < KG; gy++) for (let gx = 0; gx < KG; gx++) {
      const u = (((gx + 0.5) / KG - 0.5) * KSPAN) * cMaj;
      const v = (((gy + 0.5) / KG - 0.5) * KSPAN) * cMin;
      const du = Math.max(0, Math.abs(u) - a);
      if (du * du + v * v <= rho2) sg[gy * KG + gx] = 1;
    }
  }
  const iouStad = gridIoU(kg, sg);
  let nFg = 0;
  for (let k = 0; k < KG * KG; k++) if (kg[k]) nFg++;
  const areaFrac = (nFg / (KG * KG)) * KSPAN * KSPAN; // area in maj*min units
  // boundary cells + normals from the mean-field gradient (radial fallback)
  const bnd = [];
  for (let gy = 1; gy < KG - 1; gy++) for (let gx = 1; gx < KG - 1; gx++) {
    const i2 = gy * KG + gx;
    if (!kg[i2]) continue;
    if (kg[i2 - 1] && kg[i2 + 1] && kg[i2 - KG] && kg[i2 + KG]) continue;
    let gxv = 0, gyv = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const m = mean[(gy + dy) * KG + gx + dx];
      gxv += dx * m; gyv += dy * m;
    }
    let nx = -gxv, ny = -gyv;
    const L = Math.hypot(nx, ny);
    const pu = ((gx + 0.5) / KG - 0.5) * KSPAN, pv = ((gy + 0.5) / KG - 0.5) * KSPAN;
    if (L < 1e-6) { const r = Math.hypot(pu, pv) || 1; nx = pu / r; ny = pv / r; }
    else { nx /= L; ny /= L; }
    bnd.push([pu, pv, nx, ny]);
  }
  return { kernel: { g: kg, mean, bnd, areaFrac, medAlign, iouStad },
    medAlign, iouStad, cMaj, cMin };
}

// 4-connected labeling of a 0/1 foreground map (no cv Mats needed here).
function labelBlobs(fg, w, h) {
  const blob = new Int32Array(w * h).fill(-1);
  let nBlobs = 0;
  const stack = [];
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!fg[i0] || blob[i0] !== -1) continue;
    const b = nBlobs++;
    stack.length = 0; stack.push(i0); blob[i0] = b;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0 && fg[i - 1] && blob[i - 1] === -1) { blob[i - 1] = b; stack.push(i - 1); }
      if (x < w - 1 && fg[i + 1] && blob[i + 1] === -1) { blob[i + 1] = b; stack.push(i + 1); }
      if (y > 0 && fg[i - w] && blob[i - w] === -1) { blob[i - w] = b; stack.push(i - w); }
      if (y < h - 1 && fg[i + w] && blob[i + w] === -1) { blob[i + w] = b; stack.push(i + w); }
    }
  }
  const blobArea = new Float64Array(nBlobs);
  const sx = new Float64Array(nBlobs), sy = new Float64Array(nBlobs);
  for (let i = 0; i < w * h; i++) if (fg[i]) {
    const b = blob[i]; blobArea[b]++; sx[b] += i % w; sy[b] += (i / w) | 0;
  }
  return { blob, nBlobs, blobArea, sx, sy };
}

// Last-resort stamp arbitration. env:
//   w, h            working-scale dims (same as counter's)
//   fgFinal         Uint8Array(w*h) 0/1 — the counter's FINAL mask
//   fgOtsu          Uint8Array(w*h) 0/1 — the pre-purge otsu mask (or null)
//   cover           |final AND otsu| / |otsu| — the beige-vs-shiny signature
//   luma            Float32Array(w*h) from the pre-dist (flattened) image
//   sampleRGB       (x,y at working scale) -> [r,g,b] off the ORIGINAL photo
//   regions         the pipeline's counted regions (shape where known)
//   count           the pipeline's count
//   contestedRegions regions the counter distrusts (low-conf / oversized)
//   unownedSeeds    [x,y] per pill-scale foreground blob no region owns
//   debug           optional event sink
// Returns null (nothing to change) or
//   { maskUsed, expl, retried, edgeNote, before, after, countDelta,
//     remove: Set<region>, add: region[] }.
export function stampArbitrate(cv, env) {
  const { w, h, fgFinal, fgOtsu, fgChroma, cover, luma, sampleRGB, regions, count,
    contestedRegions, unownedSeeds, debug } = env;
  const SHRINK = env.shrink || 0.92;
  const TAUF = env.tauf || 0.6;

  const pipeSingles = regions.filter((g) => (g.units || 1) === 1 && g.shape);

  function claimStadium(claimed, cx, cy, maj, min, th, inset, kern) {
    const c = Math.cos(th), s = Math.sin(th);
    if (kern) {
      // rasterize the learned silhouette instead of the stadium
      const R = KSPAN * Math.max(maj, min) / 2 + 1;
      for (let y = Math.max(0, (cy - R) | 0); y <= Math.min(h - 1, (cy + R) | 0); y++) {
        for (let x = Math.max(0, (cx - R) | 0); x <= Math.min(w - 1, (cx + R) | 0); x++) {
          const rx = x - cx, ry = y - cy;
          const u = (rx * c + ry * s) / inset, v = (-rx * s + ry * c) / inset;
          if (kernAt(kern, u, v, maj, min)) claimed[y * w + x] = 1;
        }
      }
      return;
    }
    const a = inset * (maj - min) / 2, rho = inset * min / 2, R = maj / 2 + 1;
    for (let y = Math.max(0, (cy - R) | 0); y <= Math.min(h - 1, (cy + R) | 0); y++) {
      for (let x = Math.max(0, (cx - R) | 0); x <= Math.min(w - 1, (cx + R) | 0); x++) {
        const rx = x - cx, ry = y - cy;
        const u = rx * c + ry * s, v = -rx * s + ry * c;
        const du = Math.max(0, Math.abs(u) - a);
        if (du * du + v * v <= rho * rho * 1.05) claimed[y * w + x] = 1;
      }
    }
  }

  // ======================= per-mask analysis =======================
  // o: { allow: Uint8Array|null (main-peel restriction), raftOK: bool }
  function analyze(fg, tag, o) {
    const fgMat = new cv.Mat(h, w, cv.CV_8UC1); fgMat.data.set(fg);
    const labMat = new cv.Mat(); const nLab = cv.connectedComponents(fgMat, labMat);
    const distMat = new cv.Mat(); cv.distanceTransform(fgMat, distMat, cv.DIST_L2, 3);
    const lab = labMat.data32S, dd = distMat.data32F;

    // distance-to-foreground (chamfer 3-4, /3 ~= px) for the GRADED bg penalty
    const dtOut = new Float32Array(w * h);
    {
      const INF = 1e9;
      for (let i = 0; i < w * h; i++) dtOut[i] = fg[i] ? 0 : INF;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (dtOut[i] === 0) continue;
        let v = dtOut[i];
        if (x > 0) v = Math.min(v, dtOut[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, dtOut[i - w] + 3);
          if (x > 0) v = Math.min(v, dtOut[i - w - 1] + 4);
          if (x < w - 1) v = Math.min(v, dtOut[i - w + 1] + 4);
        }
        dtOut[i] = v;
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x; if (dtOut[i] === 0) continue;
        let v = dtOut[i];
        if (x < w - 1) v = Math.min(v, dtOut[i + 1] + 3);
        if (y < h - 1) {
          v = Math.min(v, dtOut[i + w] + 3);
          if (x < w - 1) v = Math.min(v, dtOut[i + w + 1] + 4);
          if (x > 0) v = Math.min(v, dtOut[i + w - 1] + 4);
        }
        dtOut[i] = v;
      }
      for (let i = 0; i < w * h; i++) dtOut[i] /= 3;
    }

    const acc = Array.from({ length: nLab }, () => ({ a: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, peak: 0 }));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = lab[i]; if (!l) continue;
      const b = acc[l]; b.a++; b.sx += x; b.sy += y; b.sxx += x * x; b.syy += y * y; b.sxy += x * y;
      if (dd[i] > b.peak) b.peak = dd[i];
    }
    const blobs = [];
    const byLabel = new Map();
    for (let l = 1; l < nLab; l++) {
      const b = acc[l]; if (b.a < 60) continue;
      const cx = b.sx / b.a, cy = b.sy / b.a;
      const vxx = b.sxx / b.a - cx * cx, vyy = b.syy / b.a - cy * cy, vxy = b.sxy / b.a - cx * cy;
      const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
      const bl = { l, area: b.a, cx, cy, peak: b.peak, theta,
        uMin: 1e9, uMax: -1e9, vMin: 1e9, vMax: -1e9, c: Math.cos(theta), s: Math.sin(theta) };
      blobs.push(bl); byLabel.set(l, bl);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; const b = byLabel.get(lab[i]); if (!b) continue;
      const rx = x - b.cx, ry = y - b.cy;
      const u = rx * b.c + ry * b.s, v = -rx * b.s + ry * b.c;
      if (u < b.uMin) b.uMin = u; if (u > b.uMax) b.uMax = u;
      if (v < b.vMin) b.vMin = v; if (v > b.vMax) b.vMax = v;
    }
    for (const b of blobs) { b.extMaj = b.uMax - b.uMin; b.extMin = b.vMax - b.vMin; }

    // per-candidate stadium fit by IoU against the blob's own pixels
    function fitStamp(b) {
      const R = b.extMaj / 2 + 4;
      const x0 = Math.max(0, (b.cx - R) | 0), x1 = Math.min(w - 1, (b.cx + R) | 0);
      const y0 = Math.max(0, (b.cy - R) | 0), y1 = Math.min(h - 1, (b.cy + R) | 0);
      const c = b.c, s = b.s;
      const evalIoU = (maj, min) => {
        const a = (maj - min) / 2, rho = min / 2, rho2 = rho * rho;
        let inter = 0, stampOnly = 0, blobOnly = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const rx = x - b.cx, ry = y - b.cy;
          const u = rx * c + ry * s, v = -rx * s + ry * c;
          const du = Math.max(0, Math.abs(u) - a);
          const inSt = du * du + v * v <= rho2;
          const inBl = lab[y * w + x] === b.l;
          if (inSt && inBl) inter++; else if (inSt) stampOnly++; else if (inBl) blobOnly++;
        }
        return inter / (inter + stampOnly + blobOnly);
      };
      let best = { iou: -1 };
      for (let pass = 0; pass < 2; pass++) {
        const cm = pass ? best.maj : b.extMaj, cn = pass ? best.min : Math.min(b.extMin, 2.2 * b.peak);
        const span = pass ? 0.08 : 0.25, steps = pass ? 2 : 4;
        for (let i = -steps; i <= steps; i++) for (let j = -steps; j <= steps; j++) {
          const maj = cm * (1 + span * i / steps), min = cn * (1 + span * j / steps);
          if (min < 4 || maj < min) continue;
          const iou = evalIoU(maj, min);
          if (iou > best.iou) best = { iou, maj, min };
        }
      }
      return best;
    }

    // contact-independent thickness witness
    const radiusEst = med(blobs.filter((b) => b.peak >= MIN_PEAK).map((b) => b.peak));

    // thickness-vetted single candidates
    const preCands = blobs.filter((b) => {
      if (b.peak < MIN_PEAK) return false;
      if (b.peak < 0.55 * radiusEst || b.peak > 1.5 * radiusEst) return false;
      const t = b.extMin / (2 * b.peak); if (t < 0.7 || t > 1.5) return false;
      if (b.extMaj > 6 * b.extMin) return false;
      return true;
    });
    const cands = [];
    for (const b of preCands) {
      const f = fitStamp(b);
      if (f.iou < 0.8) continue;
      // waist vet on the INNER HALF of the spine, threshold 0.68x peak
      const a = (f.maj - f.min) / 2;
      if (a >= 3) {
        let waist = 1e9;
        const n = Math.max(3, Math.ceil(a * 0.55));
        for (let i = -n; i <= n; i++) {
          const su = 0.55 * a * i / n;
          const x = Math.round(b.cx + su * b.c), y = Math.round(b.cy + su * b.s);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const v = dd[y * w + x]; if (v < waist) waist = v;
        }
        if (waist < 0.68 * b.peak) continue;
        b.waistR = waist / b.peak;
      }
      b.major = f.maj; b.minor = f.min; b.iou = f.iou;
      cands.push(b);
    }
    // medoid cluster (18%) of fits, q25 aggregated
    function medoidTemplate(list) {
      let best = null, bestN = -1;
      for (const c of list) {
        const grp = list.filter((o2) => Math.abs(o2.major - c.major) <= 0.18 * c.major && Math.abs(o2.minor - c.minor) <= 0.18 * c.minor);
        if (grp.length > bestN || (grp.length === bestN && c.major > best.cMaj)) {
          best = { maj: q25(grp.map((o2) => o2.major)), min: q25(grp.map((o2) => o2.minor)), n: grp.length, cMaj: c.major };
          bestN = grp.length;
        }
      }
      return best;
    }
    const vettedPipe = pipeSingles.filter((g) => {
      const t = g.shape.minor / (2 * radiusEst); return t >= 0.75 && t <= 1.25;
    });
    let MAJ, MIN, tplSrc, clusterFrac = 0;
    if (cands.length >= 3) {
      const t = medoidTemplate(cands); MAJ = t.maj; MIN = t.min;
      tplSrc = `cluster(${t.n}/${cands.length})`; clusterFrac = t.n / cands.length;
    } else if (cands.length >= 1) {
      MAJ = med(cands.map((c) => c.major)); MIN = med(cands.map((c) => c.minor));
      tplSrc = `cands(${cands.length})`; clusterFrac = 0.5;
    } else if (vettedPipe.length >= 2) {
      MAJ = med(vettedPipe.map((g) => g.shape.major)); MIN = med(vettedPipe.map((g) => g.shape.minor));
      tplSrc = `vettedPipe(${vettedPipe.length})`;
    } else {
      MIN = 2 * radiusEst;
      const pm = med(pipeSingles.map((g) => g.shape.major));
      MAJ = pm >= MIN ? pm : MIN; tplSrc = 'thicknessOnly';
    }
    // minor-vs-thickness cross-check: disagree >25% -> thickness-derived minor
    if (Math.abs(MIN - 2 * radiusEst) > 0.25 * 2 * radiusEst) {
      MIN = 2 * radiusEst; if (MAJ < MIN) MAJ = MIN; tplSrc += '+minVet';
    }
    const MAJ0 = MAJ, MIN0 = MIN;         // unshrunk (anchor trust test)
    MAJ *= SHRINK; MIN *= SHRINK;
    const D0 = Math.max(2, MIN / 4);

    // ---- DATA-DRIVEN STAMP KERNEL: learn the median silhouette from the
    // vetted candidates; keep the stadium unless the evidence is strong
    // (>= 4 candidates), stable (median aligned IoU), and genuinely
    // non-stadium (IoU vs the parametric stadium below KERNEL_STAD_MAX).
    let kernel = null;
    if (cands.length >= 4) {
      const lk = learnKernel(cands, lab, w, h);
      const active = lk.medAlign >= KERNEL_ALIGN_MIN && lk.iouStad < KERNEL_STAD_MAX;
      if (active) kernel = lk.kernel;
      debug?.({ stage: 'stampkernel', tag, cands: cands.length,
        medAlign: +lk.medAlign.toFixed(3), iouStad: +lk.iouStad.toFixed(3),
        active, areaFrac: +lk.kernel.areaFrac.toFixed(3),
        grid: Array.from(lk.kernel.g).join('') });
    } else {
      debug?.({ stage: 'stampkernel', tag, cands: cands.length, active: false });
    }
    // area of one template pill under the active shape model
    const shapeArea = (maj, min) => kernel ? kernel.areaFrac * maj * min : stadArea(maj, min);

    // ---- ANCHORS (trust test, ASYMMETRIC area band: only area ABOVE implied
    // disqualifies — below-implied is mask erosion on a real single).
    const IMPLIED = radiusEst > 0
      ? shapeArea(Math.max(2 * radiusEst, MAJ0 * (2 * radiusEst) / MIN0 || MAJ0), 2 * radiusEst)
      : shapeArea(MAJ0, MIN0);
    const anchors = [], contested = [];
    const noAnchor = env.noAnchor || null;
    for (const g of regions) {
      const rel = g.area / IMPLIED;
      const minRel = radiusEst > 0 && g.shape ? g.shape.minor / (2 * radiusEst) : 1;
      const ok = (g.units || 1) === 1 && g.shape && g.shape.residual <= 0.06
        && rel <= 1.25 && minRel >= 0.7 && minRel <= 1.3
        && !(noAnchor && noAnchor.has(g));
      (ok ? anchors : contested).push(g);
    }

    // ---- scoring (graded bg penalty; claimed NEUTRAL)
    // strictBg (per-blob routed peels only): the dt grading exists to
    // forgive shallow mask erosion at a trusted pill's rim. Inside a ROUTED
    // blob that forgiveness is exactly wrong — the seam between two flush
    // pills survives only as a dotted line of interior holes (r-7ff7fd99
    // pair: holes at (221,294),(222,294),(223,298), dtOut ~1px), and graded
    // scoring lets a stamp laid diagonally ACROSS both pills read 0.976
    // while the true per-pill pose reads 0.951. Flat penalty makes every
    // hole under the stamp count, flipping that order.
    // Routed-peel seam evidence (strictBg mode). Between flush pills the
    // pill boundary survives only as a DOTTED line of 1-2px interior holes
    // (r-7ff7fd99 A|B pair) or a dark contact-shadow crease (its B|g
    // junction, luma 55 vs pill 188) — both far too thin for the sparse
    // 2.66px point sample to hit reliably, and the dt-graded bg penalty
    // forgives what it does hit. seamMask marks those px; a sample point
    // that SEES one within 2px scores -1 instead of +1, so a stamp laid
    // across two pills collects the whole line while a true per-pill pose
    // (0.92-shrunk, seam at its boundary) collects almost none.
    let strictBg = false;
    let seamMask = null;
    function covScore(pts, cx, cy, th, claimed) {
      const c = Math.cos(th), s = Math.sin(th);
      let sum = 0;
      for (const [u, v] of pts) {
        const x = (cx + u * c - v * s) | 0, y = (cy + u * s + v * c) | 0;
        if (x < 0 || y < 0 || x >= w || y >= h) { sum -= 1.4; continue; }
        const i = y * w + x;
        if (claimed[i]) continue;                       // neutral
        if (fg[i]) {
          let seam = false;
          // CORE points only (|v| <= pts.vCore): a seam under the stamp's
          // spine means it straddles two pills; a seam at its long edge is
          // just the neighbour's boundary. Radius symmetric variants fail
          // both ways (r=2 blinds the true pose whose edge rides the seam
          // at 1.3px; r=1 lets the cross pose slip between the seam dots —
          // both measured on the r-7ff7fd99 pair).
          if (strictBg && seamMask && pts.vCore !== undefined && Math.abs(v) <= pts.vCore) {
            for (let dy = -2; dy <= 2 && !seam; dy++) {
              const Y = y + dy;
              if (Y < 0 || Y >= h) continue;
              for (let dx = -2; dx <= 2; dx++) {
                const X = x + dx;
                if (X >= 0 && X < w && seamMask[Y * w + X]) { seam = true; break; }
              }
            }
          }
          sum += seam ? -1 : 1;
        } else sum -= strictBg ? 1.4 : 1.4 * Math.min(1, dtOut[i] / D0);
      }
      return sum / pts.length;
    }
    function overlapFrac(pts, cx, cy, th, claimed) {
      const c = Math.cos(th), s = Math.sin(th);
      let n = 0, cl = 0;
      for (const [u, v] of pts) {
        const x = (cx + u * c - v * s) | 0, y = (cy + u * s + v * c) | 0;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        n++; if (claimed[y * w + x]) cl++;
      }
      return n ? cl / n : 0;
    }
    // Edge support judged on BG-FACING boundary sectors only; a stamp with no
    // free bg-facing boundary has nothing for this gate to check (returns
    // applicable:false -> gate auto-passes; coverage + photometry still apply).
    function edgeScore(bd, cx, cy, th, claimed) {
      const c = Math.cos(th), s = Math.sin(th);
      let sum = 0, nFree = 0;
      for (const [u, v, nu, nv] of bd) {
        const bx = cx + u * c - v * s, by = cy + u * s + v * c;
        const nx = nu * c - nv * s, ny = nu * s + nv * c;
        const xo = (bx + EDGE_OFF * nx) | 0, yo = (by + EDGE_OFF * ny) | 0;
        const xi = (bx - EDGE_OFF * nx) | 0, yi = (by - EDGE_OFF * ny) | 0;
        if (xo < 0 || yo < 0 || xo >= w || yo >= h || xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const io = yo * w + xo;
        if (claimed[io]) continue;
        if (fg[io]) continue;                     // seam-facing: not this gate's business
        const g = Math.abs(luma[io] - luma[yi * w + xi]);
        sum += Math.min(1, g / G0); nFree++;
      }
      return { e: nFree ? sum / nFree : 0, applicable: nFree >= bd.length * 0.25 };
    }
    // coordinate-ascent refine to 1px / pi/48
    // `barrier` (split-rescue re-peels): vetoed poses act as WALLS during
    // the climb, not post-hoc rejections. Without it every start cell in a
    // flush-pair slab funnels into the one (vetoed) cross-pill maximum and
    // the whole re-peel returns empty (measured: got 0 from all 3 tries).
    function refine(pts, x0, y0, th0, claimed, barrier) {
      let best = { s: covScore(pts, x0, y0, th0, claimed), x: x0, y: y0, th: th0 };
      for (let round = 0; round < 8; round++) {
        let improved = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          if (barrier && barrier(best.x + dx, best.y + dy, best.th)) continue;
          const sc = covScore(pts, best.x + dx, best.y + dy, best.th, claimed);
          if (sc > best.s) { best = { s: sc, x: best.x + dx, y: best.y + dy, th: best.th }; improved = true; }
        }
        for (const dth of [Math.PI / 48, -Math.PI / 48, Math.PI / 24, -Math.PI / 24]) {
          if (barrier && barrier(best.x, best.y, best.th + dth)) continue;
          const sc = covScore(pts, best.x, best.y, best.th + dth, claimed);
          if (sc > best.s) { best = { ...best, s: sc, th: best.th + dth }; improved = true; }
        }
        if (!improved) break;
      }
      return best;
    }

    const mainPts = kernel ? basePtsK(MAJ, MIN, kernel) : basePts(MAJ, MIN);
    const mainBd = kernel ? boundPtsK(MAJ, MIN, kernel) : boundPts(MAJ, MIN);

    // edge-gate calibration: G0 = 0.6 x median boundary |luma step| of the
    // pool at their own poses.
    let G0 = 20;
    const pool = cands.length >= 3 ? cands : (pipeSingles.length ? pipeSingles : cands);
    {
      const gs = [];
      for (const g of pool) {
        const th = (g.theta !== undefined ? g.theta : (g.shape ? g.shape.theta : 0)) || 0;
        const c = Math.cos(th), s = Math.sin(th);
        for (const [u, v, nu, nv] of mainBd) {
          const bx = g.cx + u * c - v * s, by = g.cy + u * s + v * c;
          const nx = nu * c - nv * s, ny = nu * s + nv * c;
          const xo = (bx + EDGE_OFF * nx) | 0, yo = (by + EDGE_OFF * ny) | 0;
          const xi = (bx - EDGE_OFF * nx) | 0, yi = (by - EDGE_OFF * ny) | 0;
          if (xo >= 0 && yo >= 0 && xo < w && yo < h && xi >= 0 && yi >= 0 && xi < w && yi < h)
            gs.push(Math.abs(luma[yo * w + xo] - luma[yi * w + xi]));
        }
      }
      if (gs.length) G0 = Math.max(6, 0.6 * med(gs));
    }

    // ---- SELF-CALIBRATION on candidates at their own poses incl. EXACT theta
    const none = new Uint8Array(w * h);
    const selfScores = [], selfEdges = [];
    // kernel shapes need the full 2*pi (a pentagon has no 180-degree
    // symmetry); same angular resolution as K over pi
    const selfN = kernel ? 2 * K : K, selfSpan = kernel ? 2 * Math.PI : Math.PI;
    for (const g of pool) {
      let best = -9, bth = 0;
      for (let k = 0; k < selfN; k++) {
        const th = k * selfSpan / selfN;
        const sc = covScore(mainPts, g.cx, g.cy, th, none);
        if (sc > best) { best = sc; bth = th; }
      }
      const exTh = g.theta !== undefined ? g.theta : (g.shape ? g.shape.theta : undefined);
      if (exTh !== undefined) {
        const sc = covScore(mainPts, g.cx, g.cy, exTh, none);
        if (sc > best) { best = sc; bth = exTh; }
      }
      selfScores.push(best);
      const se = edgeScore(mainBd, g.cx, g.cy, bth, none);
      if (se.applicable) selfEdges.push(se.e);
    }
    const TAU = TAUF * med(selfScores);
    const EDGE_GATE = 0.45 * med(selfEdges);

    // interior photometry reference
    const colPool = (cands.length ? cands : pipeSingles).map((g) => sampleRGB(g.cx, g.cy));
    const refCol = [0, 1, 2].map((ch) => med(colPool.map((c) => c[ch])));
    const colDist = (c) => Math.abs(c[0] - refCol[0]) + Math.abs(c[1] - refCol[1]) + Math.abs(c[2] - refCol[2]);
    const colThr = Math.max(75, 3 * med(colPool.map(colDist)));

    // Crease threshold for routed peels, self-calibrated like the strategy
    // doc's other knobs: pill level from the pool's own centres, bg level
    // from the mask complement. A contact shadow between flush pills reads
    // near (often below) bg; a stamp interior crossing one is riding two
    // pills. Skipped (creaseT = -1) when pills are not clearly brighter
    // than the board — the signal does not exist there.
    if (o.slabTie) {
      const poolC = cands.length ? cands : pipeSingles;
      const cs = poolC.map((g) => {
        const xi = Math.max(0, Math.min(w - 1, g.cx | 0)), yi = Math.max(0, Math.min(h - 1, g.cy | 0));
        return luma[yi * w + xi];
      });
      const pillL = med(cs);
      const bgs = [];
      for (let i = 0; i < w * h; i += 17) if (!fg[i]) bgs.push(luma[i]);
      const bgL = med(bgs);
      const creaseT = poolC.length && pillL > bgL + 30
        ? pillL - 0.6 * (pillL - bgL) : -1;
      seamMask = new Uint8Array(w * h);
      const inA = (i) => !o.allow || o.allow[i];
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        if (!inA(i)) continue;
        if (fg[i]) {
          // interior-only (>=3px deep): pill RIMS are also dark — without
          // the depth guard the whole outline ring reads as seam and every
          // true pose collapses (measured: sc=1 fit 0.714 on the target).
          if (creaseT >= 0 && luma[i] < creaseT && dd[i] >= 3) seamMask[i] = 1;
        } else if ((fg[i - 2] && fg[i + 2]) || (fg[i - 2 * w] && fg[i + 2 * w])) {
          seamMask[i] = 1; // enclosed interior hole (seam remnant), not open bg
        }
      }
    }

    // ---- claims: anchors pre-claim their own fitted stadium at 0.95 inset
    let claimed = new Uint8Array(w * h);
    const claimAnchors = (cl) => { for (const g of anchors) claimStadium(cl, g.cx, g.cy, g.shape.major, g.shape.minor, g.shape.theta, 0.95); };
    claimAnchors(claimed);

    // ---- generic peel pass with incremental score grid ----
    function peelPass(o2) {
      const { maj, min, tau, claimed: cl, allow, useEdgeGate, slabTie, src = 'main' } = o2;
      strictBg = !!slabTie;
      // the learned kernel drives the MAIN peel only; the circle-raft and
      // on-edge retries carry their own (parametric) template hypotheses
      const useK = !!(kernel && src === 'main');
      const pts = useK ? basePtsK(maj, min, kernel) : basePts(maj, min);
      const bd = useK ? boundPtsK(maj, min, kernel) : boundPts(maj, min);
      if (slabTie) pts.vCore = 0.3 * min;
      const Kn = useK ? 2 * K : (maj / min < 1.02 ? 1 : K);
      const thSpan = useK ? 2 * Math.PI : Math.PI;
      const stride = Math.max(2, (min / 3) | 0);
      const gw = Math.ceil(w / stride), gh = Math.ceil(h / stride);
      const gs = new Float32Array(gw * gh).fill(-9);
      const gk = new Uint8Array(gw * gh);
      const rescore = (gx, gy) => {
        const x = gx * stride, y = gy * stride, gi = gy * gw + gx;
        // seeds allowed on claimed fg: claim bleed can cover a remaining
        // flush pill's centre; the score itself polices over-claims
        if (x >= w || y >= h || !fg[y * w + x] || (allow && !allow[y * w + x])) { gs[gi] = -9; return; }
        let bs = -9, bk = 0;
        for (let k = 0; k < Kn; k++) { const sc = covScore(pts, x, y, k * thSpan / Kn, cl); if (sc > bs) { bs = sc; bk = k; } }
        gs[gi] = bs; gk[gi] = bk;
      };
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) rescore(gx, gy);
      const placed = [], vetoes = [];
      const VETO2 = (0.6 * min) * (0.6 * min);
      const vetoed = (x, y, th) => {
        for (const v of vetoes) {
          const dx = v.x - x, dy = v.y - y;
          if (dx * dx + dy * dy >= (v.r2 || VETO2)) continue;
          let dt2 = Math.abs(((th - v.th) % Math.PI + Math.PI) % Math.PI);
          if (dt2 > Math.PI / 2) dt2 = Math.PI - dt2;
          if (dt2 < Math.PI / 8) return true;
        }
        return false;
      };
      const localRescore = (px, py) => {
        const R = Math.ceil((maj + stride) / stride);
        const cgx = (px / stride) | 0, cgy = (py / stride) | 0;
        for (let gy = Math.max(0, cgy - R); gy <= Math.min(gh - 1, cgy + R); gy++)
          for (let gx = Math.max(0, cgx - R); gx <= Math.min(gw - 1, cgx + R); gx++) rescore(gx, gy);
      };
      let fails = 0;
      if (o2.seedVetoes) vetoes.push(...o2.seedVetoes);
      for (let iter = 0; iter < 400; iter++) {
        let bi = -1, bs = tau;
        for (let i = 0; i < gs.length; i++) if (gs[i] > bs) { bs = gs[i]; bi = i; }
        if (bi < 0) break;
        // SLAB TIE-BREAK (per-blob routed peels only). Inside a flush
        // side-by-side pair the coverage score is FLAT at ~1.0 — a stamp
        // laid diagonally across both pills scores exactly like one laid on
        // a pill, and the greedy argmax picks by scan order (measured on
        // r-7ff7fd99: diagonal at (209,296) fit 1.0 left two 9px strips no
        // later stamp could claim, expl 0.63). Real pills hug the blob
        // BOUNDARY, so among near-tied cells (within 0.04) prefer the pose
        // whose boundary has the most bg contact.
        if (slabTie) {
          let bc = -1;
          // 0.12 pool, floor tau: at grid resolution a true per-pill pose
          // sits up to stride/2 off-centre and eats seam/rim penalties the
          // cross-pill pose avoids (measured 0.90 vs 1.0); contact ranks
          // within the pool, seam-aware refine keeps the basin.
          for (let i = 0; i < gs.length; i++) {
            if (gs[i] < Math.max(bs - 0.12, tau)) continue;
            const x = (i % gw) * stride, y = ((i / gw) | 0) * stride;
            const th = gk[i] * thSpan / Kn;
            const c = Math.cos(th), s = Math.sin(th);
            let free = 0;
            for (const [u, v, nu, nv] of bd) {
              const bx = x + u * c - v * s, by = y + u * s + v * c;
              const nx = nu * c - nv * s, ny = nu * s + nv * c;
              const xo = (bx + EDGE_OFF * nx) | 0, yo = (by + EDGE_OFF * ny) | 0;
              if (xo < 0 || yo < 0 || xo >= w || yo >= h || !fg[yo * w + xo]) free++;
            }
            const f = free / bd.length;
            if (f > bc) { bc = f; bi = i; }
          }
          bs = gs[bi];
        }
        let best = { s: gs[bi], x: (bi % gw) * stride, y: ((bi / gw) | 0) * stride, k: gk[bi] };
        const pts0 = best;
        const barrier = o2.seedVetoes ? vetoed : null;
        for (let dy = -stride; dy <= stride; dy += 2) for (let dx = -stride; dx <= stride; dx += 2) {
          for (let k = 0; k < Kn; k++) {
            if (barrier && barrier(pts0.x + dx, pts0.y + dy, k * thSpan / Kn)) continue;
            const sc = covScore(pts, pts0.x + dx, pts0.y + dy, k * thSpan / Kn, cl);
            if (sc > best.s) best = { s: sc, x: pts0.x + dx, y: pts0.y + dy, k };
          }
        }
        const rf = refine(pts, best.x, best.y, best.k * thSpan / Kn, cl, barrier);
        if (rf.s < tau) { gs[bi] = -9; continue; }
        if (vetoed(rf.x, rf.y, rf.th)) { gs[bi] = -9; continue; }
        // 0.5 overlap cap: mostly re-claiming an explained pill
        if (overlapFrac(pts, rf.x, rf.y, rf.th, cl) > 0.5) { gs[bi] = -9; continue; }
        // boundary edge-support gate with pose-specific veto, veto-not-break
        const eg = edgeScore(bd, rf.x, rf.y, rf.th, cl);
        if (useEdgeGate) {
          if (eg.applicable && eg.e < EDGE_GATE) {
            vetoes.push({ x: rf.x, y: rf.y, th: rf.th });
            gs[bi] = -9; fails++;
            if (fails >= 12) break;
            continue;
          }
        }
        fails = 0;
        // FIT FLOOR. Measured on the beige-2 gap phantom: the one false
        // placement in 91 scored fit 0.637 while all 90 real pills scored
        // 1.0 — a stamp that fits its own template this poorly is riding a
        // seam or an interstice, not a pill.
        const sMed = med(selfScores);
        if (sMed > 0 && rf.s < 0.7 * sMed) {
          debug?.({ stage: 'stampveto', kind: 'fit-floor', x: rf.x, y: rf.y,
            fit: +rf.s.toFixed(3) });
          claimStadium(cl, rf.x, rf.y, maj, min, rf.th, 0.9, useK ? kernel : null);
          localRescore(rf.x, rf.y);
          continue;
        }
        // interior photometry: claim-but-don't-count on obvious non-pill
        const cdv = colDist(sampleRGB(rf.x, rf.y));
        claimStadium(cl, rf.x, rf.y, maj, min, rf.th, 0.9, useK ? kernel : null);
        localRescore(rf.x, rf.y);
        // Allowance clamped: self-calibration ballooned past 516 on the
        // pentagon photo (varied faces inflate colThr) and the veto never
        // fired; 320 keeps every measured real pill (max 137 + margin).
        if (cdv > Math.max(200, Math.min(2.5 * colThr, 320))) {
          // CHROMA VOUCH (pile re-tile only, o.chromaVouch set). Material
          // the chroma rescue restored fails colour-distance BY
          // CONSTRUCTION — that is why it needed rescuing (measured on the
          // cream piles: 10 vetoes at fit 0.7-1.0, photo 203-464, all on
          // shadowed periphery caplets). For those peels the chromaticity
          // map IS the photometric evidence: an interior >= 0.6 covered by
          // chroma material passes the dossier bit (the leather phantom
          // reads 0.00 there and still dies).
          let chrOK = false, chrF = -1;
          if (o.chromaVouch) {
            let nT = 0, nC = 0;
            const R3 = Math.max(4, Math.round(min / 2 * 0.8));
            for (let dy = -R3; dy <= R3; dy++) for (let dx = -R3; dx <= R3; dx++) {
              if (dx * dx + dy * dy > R3 * R3) continue;
              const X = (rf.x + dx) | 0, Y = (rf.y + dy) | 0;
              if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
              nT++; if (o.chromaVouch[X + Y * w]) nC++;
            }
            chrF = nT ? nC / nT : 0;
            chrOK = chrF >= 0.6;
          }
          if (!chrOK) {
            debug?.({ stage: 'stampveto', kind: 'photometry', x: rf.x, y: rf.y,
              fit: +rf.s.toFixed(3), photo: Math.round(cdv),
              ...(chrF >= 0 ? { chr: +chrF.toFixed(2) } : {}) });
            continue;
          }
          debug?.({ stage: 'stampnote', kind: 'photometry-chroma-vouched',
            x: rf.x, y: rf.y, photo: Math.round(cdv) });
        }
        placed.push({ x: rf.x, y: rf.y, th: rf.th, s: rf.s, maj, min, src,
          photo: Math.round(cdv), edge: eg.applicable ? +eg.e.toFixed(3) : null });
      }
      strictBg = false;
      return placed;
    }

    const totalFg = fg.reduce((a, b) => a + b, 0);
    const explained = (cl) => {
      let n = 0; for (let i = 0; i < w * h; i++) if (fg[i] && cl[i]) n++;
      return n / Math.max(1, totalFg);
    };

    let placed = peelPass({ maj: MAJ, min: MIN, tau: TAU, claimed, allow: o.allow, useEdgeGate: true, slabTie: o.slabTie });
    let expl = explained(claimed);

    // SPLIT RESCUE (routed peels only). Between truly flush pills there can
    // be ZERO local evidence — measured on the r-7ff7fd99 pair: raw luma at
    // the contact reads 216 vs 218 at the pill centres, no mask holes on
    // the spine — so a stamp laid across both pills scores 1.0 and greedy
    // keeps it, stranding two half-pill strips (expl 0.63). The evidence
    // for "two" is GLOBAL: a 2-tiling explains ~0.95 of the slab. One-step
    // lookahead: for each placed stamp, re-peel its freed material with
    // that pose vetoed (tight radius 0.35*min — the true pair poses sit
    // only ~half a minor away and must stay reachable); accept only if at
    // least 2 stamps place and newly explained material exceeds a third of
    // a pill.
    if (o.slabTie && placed.length) {
      const R2 = (0.35 * MIN) * (0.35 * MIN);
      const margin = 0.35 * shapeArea(MAJ, MIN) / Math.max(1, totalFg);
      let tries = 0;
      for (const p of [...placed]) {
        if (tries >= 4) break;
        if (p.src !== 'main') continue;
        tries++;
        const claimedR = new Uint8Array(w * h);
        claimAnchors(claimedR);
        for (const q of placed) if (q !== p) claimStadium(claimedR, q.x, q.y, q.maj, q.min, q.th, 0.9, q.src === 'main' ? kernel : null);
        const others = placed.filter((q) => q !== p);
        const placedR = peelPass({ maj: MAJ, min: MIN, tau: TAU, claimed: claimedR,
          allow: o.allow, useEdgeGate: true, slabTie: o.slabTie,
          seedVetoes: [{ x: p.x, y: p.y, th: p.th, r2: R2 }] });
        const explR = explained(claimedR);
        if (placedR.length >= 2 && explR > expl + margin) {
          debug?.({ stage: 'stampsplit', x: Math.round(p.x), y: Math.round(p.y),
            was: 1, now: placedR.length, expl: +expl.toFixed(3), explR: +explR.toFixed(3) });
          placed = others.concat(placedR);
          claimed = claimedR;
          expl = explR;
        }
      }
    }

    // ---- retry (b): DT-maxima circle-template raft pass, gated by weak
    // evidence AND the beige signature (o.raftOK); accept only if it
    // explains more.
    let retried = '';
    if (o.raftOK && expl < 0.65 && clusterFrac < 0.7) {
      const bigArea = 3 * shapeArea(MAJ, MIN);
      const bigLabels = new Set(blobs.filter((b) => b.area > bigArea).map((b) => b.l));
      const findMaxima = (RAD) => {
        const out = [];
        for (let y = RAD; y < h - RAD; y += 2) for (let x = RAD; x < w - RAD; x += 2) {
          const i = y * w + x;
          if (!bigLabels.has(lab[i]) || dd[i] < MIN_PEAK) continue;
          let isMax = true;
          for (let dy = -RAD; dy <= RAD && isMax; dy += 2) for (let dx = -RAD; dx <= RAD; dx += 2) {
            if (dd[(y + dy) * w + x + dx] > dd[i]) { isMax = false; break; }
          }
          if (isMax) out.push({ x, y, r: dd[i] });
        }
        return out;
      };
      let maxima = findMaxima(5);
      if (maxima.length >= 5) {
        const r1 = med(maxima.map((o2) => o2.r));
        const RAD2 = Math.max(5, Math.round(0.7 * r1)) | 0;
        if (RAD2 > 5) maxima = findMaxima(RAD2);
      }
      if (maxima.length >= 5) {
        const lmRad = med(maxima.map((o2) => o2.r));
        const DIA = SHRINK * 2 * lmRad;
        if (Math.abs(DIA - MIN) > 0.2 * MIN || Math.abs(DIA - MAJ) > 0.2 * MAJ) {
          const cPts = basePts(DIA, DIA);
          const ss = maxima.map((o2) => covScore(cPts, o2.x, o2.y, 0, none)).sort((a, b) => a - b);
          const tauC = 0.7 * ss[ss.length >> 1];
          const claimedC = new Uint8Array(w * h);
          claimAnchors(claimedC);
          const placedC = peelPass({ maj: DIA, min: DIA, tau: tauC, claimed: claimedC, useEdgeGate: false, src: 'circle' });
          const explC = explained(claimedC);
          if (explC > expl + 0.1) {
            placed = placedC; claimed = claimedC; expl = explC;
            MAJ = DIA; MIN = DIA; retried = ` circleRetry(dia=${DIA.toFixed(0)} lm=${maxima.length})`;
          } else retried = ` circleRetryRejected(explC=${explC.toFixed(2)})`;
        }
      }
    }

    // ---- retry (c): on-edge second pass — same length, ~2/3 width,
    // restricted to thin blobs.
    let edgeNote = '';
    if (expl < 0.65) {
      const thin = blobs.filter((b) => {
        if (b.peak < 3 || b.peak >= 0.55 * radiusEst) return false;
        if (b.extMaj < 0.7 * MAJ / SHRINK || b.extMaj > 1.35 * MAJ / SHRINK) return false;
        const t = b.extMin / (2 * b.peak); return t >= 0.7 && t <= 1.6;
      });
      const eCands = [];
      for (const b of thin) {
        const f = fitStamp(b);
        if (f.iou < 0.78) continue;
        eCands.push({ ...b, major: f.maj, minor: f.min });
      }
      if (eCands.length >= 1) {
        const eMaj = SHRINK * med(eCands.map((c) => c.major)), eMin = SHRINK * med(eCands.map((c) => c.minor));
        if (eMin < 0.85 * MIN) {
          const ePts = basePts(eMaj, eMin);
          const ss = eCands.map((g) => {
            let best = covScore(ePts, g.cx, g.cy, g.theta, none);
            for (let k = 0; k < K; k++) best = Math.max(best, covScore(ePts, g.cx, g.cy, k * Math.PI / K, none));
            return best;
          }).sort((a, b) => a - b);
          const tauE = Math.max(0.55, 0.7 * ss[ss.length >> 1]);
          const thinLabels = new Set(thin.map((b) => b.l));
          const allow = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) if (thinLabels.has(lab[i])) allow[i] = 1;
          const before = explained(claimed);
          const claimedSnap = new Uint8Array(claimed);
          const placedE = peelPass({ maj: eMaj, min: eMin, tau: tauE, claimed, allow, useEdgeGate: false, src: 'edge' });
          const after = explained(claimed);
          if (after > before) { // accept-only-if-explains-more
            placed = placed.concat(placedE);
            expl = after;
            edgeNote = ` edge(${placedE.length} @${eMaj.toFixed(0)}x${eMin.toFixed(0)})`;
          } else {
            claimed.set(claimedSnap);
          }
        }
      }
    }

    // PHYSICS RE-SEAT (kernel analyses only). On the pentagon honeycomb the
    // coverage score is a plateau inside every pill, so a placement can sit
    // up to ~stride/2 off-centre; the physics check then reads a REAL
    // neighbour pair as interpenetration and kills it (measured: 7 vetoes,
    // d 38-53 vs need 53.9, all seven on true pills — the whole remaining
    // undercount). Second chance, the owner's own recipe ("try the stamp at
    // various positions"): rebuild the claim map WITHOUT the loser, let the
    // stamp re-refine into the freed material (the claims themselves form
    // the gradient that pushes it off the winner), then accept only if the
    // new pose clears physics against every kept placement AND scores past
    // the fit floor on the freed material. A phantom (advil double-ring)
    // has no freed material — its pill stays claimed by the winner — so it
    // re-scores near zero and stays dead.
    const reseat = !kernel ? null : (loser, kept) => {
      reseat._why = null;
      const clR = new Uint8Array(w * h);
      claimAnchors(clR);
      for (const q of kept) if (!q.anchor) {
        claimStadium(clR, q.x, q.y, q.maj, q.min, q.th, 0.9, q.src === 'main' ? kernel : null);
      }
      const segP = (q) => {
        const a2 = Math.max(0, (q.maj - q.min) / 2), pts2 = [];
        for (let t = -1; t <= 1; t += 0.34)
          pts2.push([q.x + Math.cos(q.th) * a2 * t, q.y + Math.sin(q.th) * a2 * t]);
        return pts2;
      };
      const clearOf = (P) => kept.every((q) => {
        let dmin = 1e9;
        for (const [xa, ya] of segP(P)) for (const [xb, yb] of segP(q)) {
          const d3 = Math.hypot(xa - xb, ya - yb);
          if (d3 < dmin) dmin = d3;
        }
        return dmin >= 0.72 * (P.min + q.min) / 2;
      });
      // greedy refine cannot escape the coverage plateau (measured: all 7
      // losers re-refined to their own vetoed pose). Explicit position
      // search instead — every pose in a template-radius window that
      // ALREADY clears physics — then a 1px barrier-guarded polish.
      // Scoring is over UNCLAIMED points only: in a honeycomb a true pill's
      // rim points sit under its neighbours' 0.9-inset claims and dilute
      // plain coverage below the fit floor (measured 0.683/0.624 on real
      // pills); what matters is whether the FREED material reads as pill.
      // The free-fraction guard is what keeps phantoms dead: a double-ring
      // sits on material its winner still claims (free ~0), a real pill's
      // own body is free (measured 0.55-0.9).
      const scoreFree = (cx2, cy2, th2) => {
        const c2 = Math.cos(th2), s2 = Math.sin(th2);
        let sum = 0, nf = 0;
        for (const [u, v] of mainPts) {
          const x2 = (cx2 + u * c2 - v * s2) | 0, y2 = (cy2 + u * s2 + v * c2) | 0;
          if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) { sum -= 1.4; nf++; continue; }
          const i2 = y2 * w + x2;
          if (clR[i2]) continue;
          nf++;
          if (fg[i2]) sum += 1; else sum -= 1.4 * Math.min(1, dtOut[i2] / D0);
        }
        return { s: nf ? sum / nf : -9, free: nf / mainPts.length };
      };
      const RW = Math.max(6, (0.55 * loser.min) | 0);
      const barrier = (x2, y2, th2) => !clearOf({ x: x2, y: y2, th: th2, maj: loser.maj, min: loser.min });
      let seed = null;
      for (let dy = -RW; dy <= RW; dy += 3) for (let dx = -RW; dx <= RW; dx += 3) {
        const x2 = loser.x + dx, y2 = loser.y + dy;
        for (let dk = -2; dk <= 2; dk++) {
          const th2 = loser.th + dk * Math.PI / 12;
          if (barrier(x2, y2, th2)) continue;
          const sc = scoreFree(x2, y2, th2);
          if (!seed || sc.s > seed.s) seed = { s: sc.s, free: sc.free, x: x2, y: y2, th: th2 };
        }
      }
      let rf = seed || { s: -9, free: 0, x: loser.x, y: loser.y, th: loser.th };
      if (seed) {
        for (let round = 0; round < 8; round++) {
          let improved = false;
          for (const [dx, dy, dth] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
            [0, 0, Math.PI / 48], [0, 0, -Math.PI / 48]]) {
            const x2 = rf.x + dx, y2 = rf.y + dy, th2 = rf.th + dth;
            if (barrier(x2, y2, th2)) continue;
            const sc = scoreFree(x2, y2, th2);
            if (sc.s > rf.s) { rf = { s: sc.s, free: sc.free, x: x2, y: y2, th: th2 }; improved = true; }
          }
          if (!improved) break;
        }
      }
      const sMed = med(selfScores);
      const why = (k2) => (reseat._why = k2, debug?.({ stage: 'reseatfail', why: k2,
        from: [Math.round(loser.x), Math.round(loser.y)],
        to: [Math.round(rf.x), Math.round(rf.y)], s: +rf.s.toFixed(3),
        free: +(+rf.free).toFixed(2) }));
      if (rf.free < 0.35) return why('free'), null;
      if (rf.s < Math.max(TAU, sMed > 0 ? 0.7 * sMed : 0)) return why('floor'), null;
      const P = { x: rf.x, y: rf.y, th: rf.th, maj: loser.maj, min: loser.min };
      if (!clearOf(P)) return why('physics'), null;
      if (overlapFrac(mainPts, rf.x, rf.y, rf.th, clR) > 0.5) return why('overlap'), null;
      const cdv = colDist(sampleRGB(rf.x, rf.y));
      if (cdv > Math.max(200, Math.min(2.5 * colThr, 320))) return why('photo'), null;
      return { x: rf.x, y: rf.y, th: rf.th, s: rf.s, maj: loser.maj, min: loser.min,
        src: 'main', photo: Math.round(cdv), edge: null };
    };

    fgMat.delete(); labMat.delete(); distMat.delete();
    return { placed, anchors, claimed, expl, fg, MAJ, MIN, TAU, tplSrc, clusterFrac,
      cands, radiusEst, selfMed: med(selfScores), retried, edgeNote, tag, kernel, reseat,
      colDist, colThr };
  }

  // one-pill area under the shape model a given analysis actually used
  const resArea = (r, maj, min) => r.kernel ? r.kernel.areaFrac * maj * min : stadArea(maj, min);

  // ======================= main flow =======================
  // Label the FINAL mask once: attribution, allow mask, and arbitration all
  // read this one labeling.
  const { blob, nBlobs, blobArea, sx: bSx, sy: bSy } = labelBlobs(fgFinal, w, h);
  const blobAt = (x, y, maxR = 8) => {
    const xi = Math.max(0, Math.min(w - 1, x | 0)), yi = Math.max(0, Math.min(h - 1, y | 0));
    if (blob[yi * w + xi] >= 0) return blob[yi * w + xi];
    for (let rr = 1; rr < maxR; rr++) for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      const X = xi + dx, Y = yi + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      if (blob[Y * w + X] >= 0) return blob[Y * w + X];
    }
    return -1;
  };

  const attrR = Math.max(8, 16); // region attribution reach (refined below once MAJ known)
  const regsByBlob = new Map();
  const pipeByBlob = new Float64Array(nBlobs);
  for (const g of regions) {
    const b = blobAt(g.cx, g.cy, attrR);
    if (b < 0) continue;
    pipeByBlob[b] += (g.units || 1);
    if (!regsByBlob.has(b)) regsByBlob.set(b, []);
    regsByBlob.get(b).push(g);
  }

  // Contested blobs: the counter's distrusted regions, plus pill-scale
  // foreground no region owns (a blob with no region has no witness at all —
  // the counter picked those blobs by its own labeling; map by seed pixel).
  const arbitrable = new Set();
  // Per-blob routed blobs (env.raiseOnly regions) arbitrate RAISE-ONLY: the
  // routing hypothesis is a hidden flush contact (under-count), so a stamp
  // read BELOW the pipeline is never actionable there. A blob is raise-only
  // only when every contested region attributed to it came from routing.
  const raiseOnly = env.raiseOnly || null;
  const raiseBlobs = new Set(), nonRaiseBlobs = new Set();
  for (const g of contestedRegions) {
    const b = blobAt(g.cx, g.cy, attrR);
    if (b >= 0) {
      arbitrable.add(b);
      if (raiseOnly && raiseOnly.has(g)) raiseBlobs.add(b); else nonRaiseBlobs.add(b);
    }
  }
  for (const [ux, uy] of unownedSeeds || []) {
    const b = blobAt(ux, uy, 4);
    if (b >= 0 && !pipeByBlob[b]) arbitrable.add(b);
  }
  if (!arbitrable.size && cover >= 0.65) return null;

  // Main-peel restriction: only contested material may be peeled. Anchor
  // claims and self-calibration remain image-wide.
  const allow = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (fgFinal[i] && arbitrable.has(blob[i])) allow[i] = 1;

  const raftOK = cover < 0.65;
  const slabTie = raiseBlobs.size > 0;
  let res = analyze(fgFinal, 'final', { allow, raftOK, slabTie });
  let maskNote = '';
  // retry (a): pre-purge otsu-mask rerun — weak evidence AND beige signature;
  // accept only if it explains its own material better.
  if (res.expl < 0.65 && res.clusterFrac < 0.7 && fgOtsu && cover < 0.65) {
    const res2 = analyze(fgOtsu, 'otsu', { allow: null, raftOK });
    // The otsu retry exists to recover PURGED material — a purged mask means
    // the pipeline UNDERcounts, so the retry's verdict must be a raise. A
    // lower total says the retry's premise is false here (measured:
    // cream-caplets-on-wood read 7 against a pipeline 128 because the fused
    // wood+pill otsu mask corrupted the template — an inflated stamp
    // explains 0.69 of anything).
    const total2 = res2.anchors.length + res2.placed.length;
    // Direction rule, measured three ways. must-raise exists for template
    // corruption (cream-caplets: fused wood+pill otsu mask -> 7-for-47,
    // cover 0.404). But when the purge was CATASTROPHIC the pipeline's own
    // count is untrustworthy in EITHER direction — shadow-crescent shatter
    // OVERcounts (lightblue-1: cover 0.126, pipeline 150-for-70 while the
    // rejected stamp answer was 80 explaining 0.73). Below cover 0.35 the
    // better-explaining answer wins regardless of direction; above it the
    // raise requirement stands.
    if (res2.expl > res.expl + 0.1 && (total2 > count || cover < 0.35)) { res = res2; maskNote = 'otsu'; }
    else maskNote = `otsuRejected(expl=${res2.expl.toFixed(2)},total=${total2})`;
  }

  // ---- retry (d): CHROMA-MASK GLARE RESCUE. Glare/deep shadow erases pill
  // material below every witness's floor; the peel then leaves the contested
  // fragments unexplained because there is nothing to tile (measured on the
  // shiny pair: expl 0.13-0.26 over 12-13 unowned shreds at cover ~0.98).
  // The counter hands in the chromaticity-residual mask (measured to produce
  // near-perfect bead bodies exactly where colour-distance fails, but
  // destructive as a global segmenter — 1/7 white-caplet photos die) as
  // env.fgChroma, RESCUE MATERIAL only. Splice it into the FINAL mask, but
  // ONLY inside the neighbourhood of contested material: everywhere else the
  // mask — and therefore the pipeline's verdict — is untouched by
  // construction. Fires only when at least ~half a pill of contested
  // material is still unexplained after the main peel and retries (a-c).
  // Acceptance is per-blob, raise-only, dossier-verified (see the
  // chroma-adds block after the main arbitration).
  let chromaRes = null, chromaNote = '';
  if (maskNote !== 'otsu' && fgChroma && arbitrable.size) {
    const AREA0 = resArea(res, res.MAJ / SHRINK, res.MIN / SHRINK);
    let unexpl = 0;
    for (let i = 0; i < w * h; i++) if (allow[i] && !res.claimed[i]) unexpl++;
    if (unexpl > 0.6 * AREA0) {
      // neighbourhood = within one template-major of contested material
      // (chamfer 3-4 distance to the allow set)
      const REACH = Math.max(8, res.MAJ / SHRINK);
      const nb = new Float32Array(w * h);
      const INF = 1e9;
      for (let i = 0; i < w * h; i++) nb[i] = allow[i] ? 0 : INF;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (nb[i] === 0) continue;
        let v = nb[i];
        if (x > 0) v = Math.min(v, nb[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, nb[i - w] + 3);
          if (x > 0) v = Math.min(v, nb[i - w - 1] + 4);
          if (x < w - 1) v = Math.min(v, nb[i - w + 1] + 4);
        }
        nb[i] = v;
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x; if (nb[i] === 0) continue;
        let v = nb[i];
        if (x < w - 1) v = Math.min(v, nb[i + 1] + 3);
        if (y < h - 1) {
          v = Math.min(v, nb[i + w] + 3);
          if (x < w - 1) v = Math.min(v, nb[i + w + 1] + 4);
          if (x > 0) v = Math.min(v, nb[i + w - 1] + 4);
        }
        nb[i] = v;
      }
      const lim = REACH * 3; // chamfer units (3 per px)
      const hybrid = new Uint8Array(fgFinal);
      const allowC = new Uint8Array(w * h);
      let addedPx = 0;
      for (let i = 0; i < w * h; i++) {
        const near = nb[i] <= lim;
        if (near && fgChroma[i] && !hybrid[i]) { hybrid[i] = 1; addedPx++; }
        if (near && hybrid[i]) allowC[i] = 1;
      }
      debug?.({ stage: 'chromagate', unexpl: +(unexpl / AREA0).toFixed(2),
        added: +(addedPx / AREA0).toFixed(2) });
      // enough new material to hide at least a third of a pill, else the
      // chroma map agrees with the mask and there is nothing to rescue
      if (addedPx > 0.35 * AREA0) {
        const resC = analyze(hybrid, 'chroma', { allow: allowC, raftOK: false });
        // Keep only if the retry explains ITS OWN material better — the
        // hybrid is a superset of the final mask, so a higher fraction of a
        // larger mask means the restored material really is tileable pill
        // bodies, not chroma noise. The chroma result NEVER replaces the
        // final-mask analysis (that forfeited the final arbitration's own
        // wins, measured: cream 43 -> 42): it is held aside and its
        // dossier-verified UNOWNED adds are applied on top, after the
        // normal arbitration (see the chroma-adds block below).
        if (resC.expl > res.expl) chromaRes = resC;
        else chromaNote = ` chromaRejected(expl=${resC.expl.toFixed(2)})`;
      }
    }
  }

  // STAMP PHYSICS. The owner's rigid-body law, third application: pills
  // cannot interpenetrate, so neither can placements. Measured (advil-3):
  // two stamps 47px apart with 82px stadiums — ~37px of impossible overlap
  // — slipped the 0.5 overlap cap AND the 0.7 fit floor (0.75) and drew a
  // second ring inside one pill. Pairwise core check; the LOWER-fit
  // placement of a violating pair dies. Anchors are never dropped (their
  // own blob is the evidence for where they are).
  {
    const segPts2 = (q) => {
      const a2 = Math.max(0, (q.maj - q.min) / 2), pts2 = [];
      for (let t = -1; t <= 1; t += 0.34)
        pts2.push([q.x + Math.cos(q.th) * a2 * t, q.y + Math.sin(q.th) * a2 * t]);
      return pts2;
    };
    const segDist = (A, B) => {
      let dmin = 1e9;
      for (const [xa, ya] of segPts2(A)) for (const [xb, yb] of segPts2(B)) {
        const d3 = Math.hypot(xa - xb, ya - yb);
        if (d3 < dmin) dmin = d3;
      }
      return dmin;
    };
    const anchorsGeo = res.anchors.map((g) => ({
      x: g.cx, y: g.cy, th: (g.shape && g.shape.theta) || 0,
      maj: (g.shape && g.shape.major) || res.MAJ, min: (g.shape && g.shape.minor) || res.MIN,
      s: 9, anchor: true }));
    const all = anchorsGeo.concat(res.placed);
    const dead = new Set();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      if (dead.has(A) || dead.has(B)) continue;
      // 0.72, not 0.9: the template is q25-shrunk and real pills vary, so
      // true hex-raft tangents measure down to ~0.85x nominal (0.9 culled 5
      // real beige pills); the advil double-ring sits at 0.63x. The band
      // between is empty on every measured photo.
      const need = 0.72 * (A.min + B.min) / 2;
      const dAB = segDist(A, B);
      if (dAB >= need) continue;
      const loser = A.anchor ? B : B.anchor ? A : (A.s <= B.s ? A : B);
      if (loser.anchor) continue;   // two anchors never fight
      dead.add(loser);
      const winner = loser === A ? B : A;
      debug?.({ stage: 'stampveto', kind: 'physics',
        x: Math.round(loser.x), y: Math.round(loser.y), fit: +(+loser.s).toFixed(3),
        wx: Math.round(winner.x), wy: Math.round(winner.y), wfit: +(+winner.s).toFixed(3),
        d: +dAB.toFixed(1), need: +need.toFixed(1) });
    }
    if (dead.size) {
      let kept = all.filter((p2) => !dead.has(p2));
      const rescued = [];
      // CHAIN RE-SEAT bookkeeping (depth 2, once per loser, no recursion):
      // maps an original kept placement to its re-seated pose so res.placed
      // can be rewritten; a moved neighbour is never moved again.
      const movedFrom = new Map();
      if (res.reseat) {
        for (const loser of dead) {
          if (loser.src !== 'main') continue;
          let r2 = res.reseat(loser, kept.concat(rescued));
          // CHAIN RE-SEAT. Measured residual (salmon pentagon honeycomb):
          // a physics loser is a REAL pill, but its re-seat window has
          // free=0 because TWO neighbours are mutually off-centre — every
          // pose is barrier-blocked or claimed. Second link of the owner's
          // recipe: free the strongest-overlap NEIGHBOUR first (re-seat it
          // within its own window under the full guard set), then retry the
          // loser against the recentred claims. Both moves must pass every
          // re-seat guard or the whole chain is reverted; a phantom still
          // dies because its neighbour recentres onto the same single pill
          // body and the retry finds free ~0 again. Bounded: one neighbour,
          // one retry, a moved neighbour is never chained again.
          if (!r2 && res.reseat._why === 'free') {
            let N = null, dN = 1e9;
            for (const q of kept) {
              if (q.anchor || q.src !== 'main' || movedFrom.has(q)) continue;
              const d3 = segDist(loser, q);
              if (d3 < dN) { dN = d3; N = q; }
            }
            if (N && dN < (loser.min + N.min) / 2) {
              const keptSansN = kept.filter((q) => q !== N);
              const rN = res.reseat(N, keptSansN.concat(rescued));
              if (rN) {
                const r2b = res.reseat(loser, keptSansN.concat([rN], rescued));
                if (r2b) {
                  kept = keptSansN.concat([rN]);
                  movedFrom.set(N, rN);
                  movedFrom.set(rN, rN); // a chain product is not chained again
                  r2 = r2b;
                  debug?.({ stage: 'stampchain',
                    nFrom: [Math.round(N.x), Math.round(N.y)],
                    nTo: [Math.round(rN.x), Math.round(rN.y)], nFit: +rN.s.toFixed(3) });
                }
              }
            }
          }
          if (r2) {
            rescued.push(r2);
            debug?.({ stage: 'stampreseat', from: [Math.round(loser.x), Math.round(loser.y)],
              to: [Math.round(r2.x), Math.round(r2.y)], fit: +r2.s.toFixed(3) });
          }
        }
      }
      res.placed = res.placed.filter((p2) => !dead.has(p2))
        .map((p2) => movedFrom.get(p2) || p2).concat(rescued);
    }
  }

  const mkPill = (p) => ({
    cx: p.x, cy: p.y, theta: +p.th.toFixed(3),
    major: +p.maj.toFixed(1), minor: +p.min.toFixed(1),
    valid: +Math.max(0, Math.min(1, res.selfMed > 0 ? p.s / res.selfMed : 1)).toFixed(2),
    fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge,
  });
  const emitPlace = (p, b) => debug?.({ stage: 'stampplace', mask: res.tag, blob: b,
    x: Math.round(p.x), y: Math.round(p.y), th: +p.th.toFixed(3),
    fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge });

  const anchorSet = new Set(res.anchors);
  const remove = new Set();
  const add = [];
  let countDelta = 0;

  if (maskNote === 'otsu') {
    // The pipeline's mask purged real material; its per-blob units are
    // corrupt by construction. Keep only the trust-tested anchors, replace
    // everything else with the stamp's placements (grouped by otsu blob).
    const ol = labelBlobs(fgOtsu, w, h);
    const oAt = (x, y) => {
      const xi = Math.max(0, Math.min(w - 1, x | 0)), yi = Math.max(0, Math.min(h - 1, y | 0));
      if (ol.blob[yi * w + xi] >= 0) return ol.blob[yi * w + xi];
      for (let rr = 1; rr < 8; rr++) for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const X = xi + dx, Y = yi + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        if (ol.blob[Y * w + X] >= 0) return ol.blob[Y * w + X];
      }
      return -1;
    };
    for (const g of regions) if (!anchorSet.has(g)) remove.add(g);
    const byB = new Map();
    for (const p of res.placed) {
      const b = oAt(p.x, p.y);
      if (!byB.has(b)) byB.set(b, []);
      byB.get(b).push(p);
      emitPlace(p, b);
    }
    for (const [b, ps] of byB) {
      const pills = ps.map(mkPill);
      const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
      const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
      add.push({ cx, cy, area: b >= 0 ? ol.blobArea[b] : ps.length * resArea(res, res.MAJ, res.MIN),
        units: ps.length, confidence: 'high', arc: true, stamp: true, pills });
    }
    const total = res.anchors.length + res.placed.length;
    countDelta = total - count;
  } else {
    // per-blob arbitration, scoped to the contested blobs only
    const stampByBlob = new Float64Array(nBlobs);
    const placedByBlob = new Map();
    const anchorsByBlob = new Map();
    for (const g of res.anchors) {
      const b = blobAt(g.cx, g.cy, attrR);
      if (b < 0) continue;
      stampByBlob[b]++;
      if (!anchorsByBlob.has(b)) anchorsByBlob.set(b, []);
      anchorsByBlob.get(b).push(g);
    }
    for (const p of res.placed) {
      const b = blobAt(p.x, p.y);
      if (b < 0) continue;
      stampByBlob[b]++;
      if (!placedByBlob.has(b)) placedByBlob.set(b, []);
      placedByBlob.get(b).push(p);
      emitPlace(p, b);
    }
    const claimedFgPerBlob = new Float64Array(nBlobs);
    for (let i = 0; i < w * h; i++) if (fgFinal[i] && res.claimed[i]) claimedFgPerBlob[blob[i]]++;
    const AREA = resArea(res, res.MAJ / SHRINK, res.MIN / SHRINK);
    // Blobs that are THEMSELVES thickness-vetted stadium candidates (IoU >=
    // 0.8, waist-vetted): an unowned blob may only be added as a pill on
    // that evidence, or on an edge/raft-pass placement (those passes carry
    // their own template vet). A main-peel hit on an unvetted unowned blob
    // is the glare-shred signature — measured on the shiny pair, accepting
    // those read +8 phantoms while the pipeline's count was already closer.
    const candBlobs = new Set();
    for (const c of res.cands || []) {
      const b = blobAt(c.cx, c.cy);
      if (b >= 0) candBlobs.add(b);
    }
    for (const b of arbitrable) {
      let sc = stampByBlob[b];
      const pc = pipeByBlob[b];
      if (!sc && !pc) continue;
      const visible = blobArea[b] / AREA;
      if (!pc) {
        // Unowned adds need independent template evidence: an edge/raft-pass
        // placement (those carry their own template vet), or the blob is
        // itself a vetted stadium candidate at FULL pill size. A main-peel
        // hit on a sub-pill blob is the light-speck signature (measured:
        // rc-light-small +1 phantom at visible 0.65; the real recoveries —
        // s301 tilted pills via edge-src, shiny beads at visible ~1 — pass).
        const psAll = placedByBlob.get(b) || [];
        const ps = psAll.filter((p) => p.src !== 'main' || (candBlobs.has(b) && visible >= 0.8));
        if (ps.length !== psAll.length) {
          debug?.({ stage: 'stampveto', kind: 'unowned-unvetted', blob: b,
            visible: +visible.toFixed(2), dropped: psAll.length - ps.length });
          placedByBlob.set(b, ps);
          sc = (anchorsByBlob.get(b) || []).length + ps.length;
        }
        if (!sc) continue;
      }
      const uv = (blobArea[b] - claimedFgPerBlob[b]) / AREA;
      // blind = the mask underrepresents the pipeline's units (rc-light
      // specks) — but NOT when the stamp explained most of what IS visible
      // (glare-fattened singles; measured claimedFrac<0.5 keeps sanity exact).
      const claimedFrac = blobArea[b] > 0 ? claimedFgPerBlob[b] / blobArea[b] : 0;
      const blind = visible < pc - 0.5 && claimedFrac < 0.5;
      let stampWins = !(sc < pc && (uv > 0.45 || blind));
      // A RAISE must come from a stamp read that truly explains the blob:
      // outnumbering the pipeline while leaving the material unexplained is
      // the bad-tiling signature. Measured: the genuine raise (advil 23->25)
      // reads claimedFrac 0.85; the phantom raises (s302 1->2, s202 6->7,
      // s138 5->6 — all on exact pipelines) read 0.61-0.63, and the
      // t3-white-round-yellow-2 raft raise (40 -> 43 against an audited 40:
      // stadArea of the circle-of-minor-axis template under-measures the
      // tilted elliptical pills ~10%, so "visible" inflates to 43.49 and
      // the peel tiles 3 extra discs) reads 0.79. The bar sits between the
      // worst measured phantom (0.79) and the measured genuine raise (0.85).
      if (sc > pc && pc > 0 && claimedFrac < 0.82) stampWins = false;
      // Raise-only for per-blob routed blobs (see raiseBlobs above).
      if (sc < pc && raiseBlobs.has(b) && !nonRaiseBlobs.has(b)) stampWins = false;
      debug?.({ stage: 'stampblob', blob: b, sc, pc,
        visible: +visible.toFixed(2), uv: +uv.toFixed(2),
        claimedFrac: +claimedFrac.toFixed(2), win: stampWins ? 'stamp' : 'pipe' });
      if (!stampWins || sc === pc) continue;
      const keptAnchors = anchorsByBlob.get(b) || [];
      const regs = regsByBlob.get(b) || [];
      for (const g of regs) if (!keptAnchors.includes(g)) remove.add(g);
      const ps = placedByBlob.get(b) || [];
      if (ps.length) {
        const pills = ps.map(mkPill);
        const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
        const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
        add.push({ cx, cy, area: Math.max(1, blobArea[b] - keptAnchors.reduce((a, g) => a + g.area, 0)),
          units: ps.length, confidence: 'high', arc: true, stamp: true, pills });
      }
      countDelta += sc - pc;
    }
  }

  // ---- CHROMA ADDS (retry (d) acceptance). Applied ON TOP of the normal
  // arbitration: pure raise-only additions of pills whose mask material
  // glare erased. A hybrid-mask blob qualifies only if
  //   (1) NO pipeline region owns it (pc = 0 — the pipeline never saw it),
  //   (2) it is itself a thickness-vetted stadium candidate at full pill
  //       size (the same independent template evidence the per-blob branch
  //       demands of unowned adds; measured on both shiny photos, every
  //       phantom placement was cand=false while every cand=true blob was
  //       a real bead),
  //   (3) its stamp read claims its material (claimedFrac >= 0.5 — a
  //       perfect single placement claims ~0.69 of one pill, restored
  //       blobs run to ~1.4x pill area, real beads measured 0.52-0.72),
  //   (4) no already-counted region or already-added pill sits within a
  //       pill of it (physics/dedup vs the normal arbitration's verdict).
  if (chromaRes) {
    const hl = labelBlobs(chromaRes.fg, w, h);
    const hAt = (x, y) => {
      const xi = Math.max(0, Math.min(w - 1, x | 0)), yi = Math.max(0, Math.min(h - 1, y | 0));
      if (hl.blob[yi * w + xi] >= 0) return hl.blob[yi * w + xi];
      for (let rr = 1; rr < 8; rr++) for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const X = xi + dx, Y = yi + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        if (hl.blob[Y * w + X] >= 0) return hl.blob[Y * w + X];
      }
      return -1;
    };
    const pipeByH = new Float64Array(hl.nBlobs);
    for (const g of regions) {
      const b = hAt(g.cx, g.cy);
      if (b >= 0) pipeByH[b] += (g.units || 1);
    }
    const placedByH = new Map();
    for (const p of chromaRes.placed) {
      const b = hAt(p.x, p.y);
      if (b < 0) continue;
      if (!placedByH.has(b)) placedByH.set(b, []);
      placedByH.get(b).push(p);
    }
    const clFgByH = new Float64Array(hl.nBlobs);
    for (let i = 0; i < w * h; i++) if (chromaRes.fg[i] && chromaRes.claimed[i] && hl.blob[i] >= 0) clFgByH[hl.blob[i]]++;
    const AREAH = resArea(chromaRes, chromaRes.MAJ / SHRINK, chromaRes.MIN / SHRINK);
    const candH = new Set();
    for (const c of chromaRes.cands || []) {
      const b = hAt(c.cx, c.cy);
      if (b >= 0) candH.add(b);
    }
    // BIDIRECTIONAL ARBITRATION — bounded phantom REMOVAL, chroma-rescue
    // images only (the narrowest safe scope: retry (d) fired and was
    // accepted, so the chroma map is measured-good on this photo). The
    // honest finding on the shiny leather photo: a units=2 region sits on
    // bare leather — its footprint holds ZERO chroma material (measured
    // 0.00 against 0.88-1.00 for every real region on both shiny photos, a
    // 0.88 margin) — while the pipeline's count carries it. Dossier per
    // removed unit, all bits required:
    //   (1) no witness at all (no census circle, no arc, no seam, no geo),
    //   (2) no chroma material under the region's own footprint (<= 0.10),
    //   (3) the chroma+stamp read of its hybrid blob CONTRADICTS the
    //       pipeline: chroma-evidenced reads (anchors + placements whose
    //       interior holds >= 0.5 chroma material — the blob-65 phantom
    //       placement reads 0.00 there and does not vouch) < pipeline units,
    //   (4) photometry corroboration (photo >= 80: the centre does not read
    //       as the pill reference; measured weak on glare faces — the
    //       chroma bit is the separator, this bit only blocks removals of
    //       photometrically-perfect pills).
    // Guards: the chroma channel must be MEANINGFUL on this photo (median
    // region chromaFrac >= 0.7 — on white-pill photos where chroma reads
    // nothing everywhere, absence proves nothing and no removal fires);
    // total decrease capped at 25% of the pipeline count.
    {
      const chrUnder = (cx2, cy2, R2) => {
        let nT = 0, nC = 0;
        const R3 = Math.max(4, Math.round(R2));
        for (let dy = -R3; dy <= R3; dy++) for (let dx = -R3; dx <= R3; dx++) {
          if (dx * dx + dy * dy > R3 * R3) continue;
          const X = (cx2 + dx) | 0, Y = (cy2 + dy) | 0;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          nT++; if (fgChroma[X + Y * w]) nC++;
        }
        return nT ? nC / nT : 0;
      };
      const regChr = (g) => chrUnder(g.cx, g.cy, Math.sqrt((g.area || 1) / Math.PI / (g.units || 1)));
      const allChr = regions.map(regChr).sort((a, b) => a - b);
      const medChrAll = allChr.length ? allChr[allChr.length >> 1] : 0;
      if (fgChroma && medChrAll >= 0.7) {
        // chroma-evidenced stamp reads per hybrid blob
        const evidByH = new Map();
        for (const g of chromaRes.anchors) {
          const b = hAt(g.cx, g.cy);
          if (b >= 0) evidByH.set(b, (evidByH.get(b) || 0) + 1);
        }
        for (const [b, ps] of placedByH) {
          let n2 = 0;
          for (const p of ps) if (chrUnder(p.x, p.y, chromaRes.MIN / SHRINK / 2 * 0.8) >= 0.5) n2++;
          evidByH.set(b, (evidByH.get(b) || 0) + n2);
        }
        let budget = Math.floor(0.25 * count);
        for (const g of regions) {
          if (budget <= 0) break;
          if (anchorSet.has(g) || remove.has(g)) continue;
          if (g.arc || g.seam || g.hough || g.geoCorroborated) continue;
          const b = hAt(g.cx, g.cy);
          if (b < 0) continue;
          const cf = regChr(g);
          if (cf > 0.10) continue;
          const kEvid = evidByH.get(b) || 0;
          const pcH2 = pipeByH[b];
          if (kEvid >= pcH2) continue;
          const photo2 = Math.round(chromaRes.colDist(sampleRGB(g.cx, g.cy)));
          if (photo2 < 80) continue;
          const m2 = Math.min(g.units || 1, Math.round(pcH2 - kEvid), budget);
          if (m2 <= 0) continue;
          remove.add(g);
          if ((g.units || 1) > m2) add.push({ ...g, units: (g.units || 1) - m2 });
          pipeByH[b] -= m2;
          budget -= m2;
          countDelta -= m2;
          debug?.({ stage: 'phantomremove', cx: Math.round(g.cx), cy: Math.round(g.cy),
            units: g.units || 1, removed: m2, blobH: b,
            chromaFrac: +cf.toFixed(2), kEvid, pcH: pcH2, photo: photo2 });
        }
      }
    }

    // PER-PILE RE-TILE (chroma-rescue images only). The cream failure mode:
    // chroma-restored periphery pills merge INTO the big pile blobs, so no
    // pipeline-unowned blob exists for the raise-only adds path — the pile
    // itself must be re-tiled on the hybrid mask. Full peel of the pile
    // with the learned template, chroma-vouched photometry (restored
    // material fails colour-distance by construction), rigid-body physics
    // across the result. Acceptance, all bits measured:
    //   (1) the pile really was fed by the rescue (>= 1 pill-area of
    //       chroma-restored material inside it; measured 3.09/8.34 on the
    //       cream piles vs 0.03 on the s-eb90778f clump the lever must not
    //       touch),
    //   (2) RAISE-ONLY (pile > pc): the re-tile hypothesis is that the
    //       pipeline counted the pile before its periphery material
    //       existed — an under-count premise, same discipline as the
    //       routed-blob and chroma-adds paths. Measured, the peel under-
    //       reads dense piles it cannot fully explain (cream bottom pile
    //       25 v pc 26 with 8.4 pill-areas unclaimed; shiny blob64 16 v 17
    //       with physDrop 8) — those reads must never lower the count.
    //   (3) the tiling is physics-consistent as placed (physDrop <=
    //       0.15 x pile; measured 1/11 on the accepted cream pile vs 8/21
    //       on the shiny glare blob),
    //   (4) the tiling explains the pile's material (claimedFrac >= 0.75;
    //       measured 0.793 accepted vs 0.462 on the s-eb clump),
    //   (5) fabrication cap: the raise is bounded (pile <= 1.5 x pc).
    {
      const chromaAddByH = new Float64Array(hl.nBlobs);
      for (let i = 0; i < w * h; i++)
        if (chromaRes.fg[i] && !fgFinal[i] && hl.blob[i] >= 0) chromaAddByH[hl.blob[i]]++;
      const regsByH = new Map();
      for (const g of regions) {
        const b = hAt(g.cx, g.cy);
        if (!regsByH.has(b)) regsByH.set(b, []);
        regsByH.get(b).push(g);
      }
      for (let b = 0; b < hl.nBlobs; b++) {
        if (pipeByH[b] < 6) continue;
        if (chromaAddByH[b] < 1.0 * AREAH) continue;
        const allowP = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (hl.blob[i] === b) allowP[i] = 1;
        const resP = analyze(chromaRes.fg, 'pile' + b, { allow: allowP, raftOK: false,
          chromaVouch: fgChroma });
        // count on this pile: anchors attributed to it + placements inside it
        const aOn = resP.anchors.filter((g) => hAt(g.cx, g.cy) === b);
        const pOn = resP.placed.filter((p) => hAt(p.x, p.y) === b);
        // physics among them (same law as the main block)
        const segPts4 = (q) => {
          const a2 = Math.max(0, (q.maj - q.min) / 2), pts2 = [];
          for (let t = -1; t <= 1; t += 0.34)
            pts2.push([q.x + Math.cos(q.th) * a2 * t, q.y + Math.sin(q.th) * a2 * t]);
          return pts2;
        };
        const sd4 = (A, B) => {
          let dmin = 1e9;
          for (const [xa, ya] of segPts4(A)) for (const [xb, yb] of segPts4(B)) {
            const d3 = Math.hypot(xa - xb, ya - yb);
            if (d3 < dmin) dmin = d3;
          }
          return dmin;
        };
        const geoA = aOn.map((g) => ({ x: g.cx, y: g.cy, th: (g.shape && g.shape.theta) || 0,
          maj: (g.shape && g.shape.major) || resP.MAJ, min: (g.shape && g.shape.minor) || resP.MIN,
          s: 9, anchor: true }));
        const allP = geoA.concat(pOn);
        const deadP = new Set();
        for (let i = 0; i < allP.length; i++) for (let j = i + 1; j < allP.length; j++) {
          const A = allP[i], B = allP[j];
          if (deadP.has(A) || deadP.has(B)) continue;
          if (sd4(A, B) >= 0.72 * (A.min + B.min) / 2) continue;
          const L = A.anchor ? B : B.anchor ? A : (A.s <= B.s ? A : B);
          if (!L.anchor) deadP.add(L);
        }
        let clP = 0, pileA = 0;
        for (let i = 0; i < w * h; i++) if (hl.blob[i] === b) { pileA++; if (resP.claimed[i]) clP++; }
        debug?.({ stage: 'piletile', blob: b, pc: pipeByH[b],
          pile: allP.length - deadP.size, anchors: aOn.length, placed: pOn.length,
          physDrop: deadP.size, expl: +resP.expl.toFixed(3),
          claimedFrac: pileA ? +(clP / pileA).toFixed(3) : 0,
          visible: +(pileA / AREAH).toFixed(2),
          chromaAdded: +(chromaAddByH[b] / AREAH).toFixed(2),
          poses: allP.filter((p) => !deadP.has(p)).map((p) => [Math.round(p.x), Math.round(p.y),
            +(+p.th || 0).toFixed(2), p.anchor ? 1 : 0]) });
        const pile = allP.length - deadP.size;
        const pcH2 = pipeByH[b];
        const clFrac = pileA ? clP / pileA : 0;
        if (pile <= pcH2) continue;                      // (2) raise-only
        if (pile > 1.5 * pcH2) continue;                 // (5) fabrication cap
        if (deadP.size > 0.15 * pile) continue;          // (3) physics-consistent
        if (clFrac < 0.75) continue;                     // (4) explains the pile
        const keptP = pOn.filter((p) => !deadP.has(p));
        const regsB = regsByH.get(b) || [];
        const aSet = new Set(aOn);
        for (const g of regsB) if (!aSet.has(g)) remove.add(g);
        const pills = keptP.map((p) => ({
          cx: p.x, cy: p.y, theta: +p.th.toFixed(3),
          major: +p.maj.toFixed(1), minor: +p.min.toFixed(1),
          valid: +Math.max(0, Math.min(1, resP.selfMed > 0 ? p.s / resP.selfMed : 1)).toFixed(2),
          fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge,
        }));
        const cxP = keptP.reduce((a, p) => a + p.x, 0) / Math.max(1, keptP.length);
        const cyP = keptP.reduce((a, p) => a + p.y, 0) / Math.max(1, keptP.length);
        add.push({ cx: cxP, cy: cyP,
          area: Math.max(1, pileA - aOn.reduce((a, g) => a + (g.area || 0), 0)),
          units: pile - aOn.length, confidence: 'high', arc: true, stamp: true, pills });
        countDelta += pile - pcH2;
        for (const p of keptP) debug?.({ stage: 'stampplace', mask: 'pile', blob: b,
          x: Math.round(p.x), y: Math.round(p.y), th: +p.th.toFixed(3),
          fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge });
        debug?.({ stage: 'piletile-accept', blob: b, pc: pcH2, pile,
          physDrop: deadP.size, claimedFrac: +clFrac.toFixed(3) });
      }
    }

    // dedup/physics targets: every surviving region (centre reach) and
    // every pill the normal arbitration just added (full rigid-body
    // segment distance — chromaRes placements never went through the main
    // physics block, so interpenetration is enforced here: measured, a
    // fit-0.518 second stamp landed 25px down-spine inside an already
    // stamped bead and only the segment check sees that)
    const centers = [];
    for (const g of regions) if (!remove.has(g)) centers.push([g.cx, g.cy]);
    const stamps = [];
    for (const r2 of add) {
      if (r2.pills) for (const p2 of r2.pills) stamps.push({ x: p2.cx, y: p2.cy, th: p2.theta || 0, maj: p2.major || chromaRes.MAJ, min: p2.minor || chromaRes.MIN });
      else centers.push([r2.cx, r2.cy]);
    }
    const segPts3 = (q) => {
      const a2 = Math.max(0, (q.maj - q.min) / 2), pts2 = [];
      for (let t = -1; t <= 1; t += 0.34)
        pts2.push([q.x + Math.cos(q.th) * a2 * t, q.y + Math.sin(q.th) * a2 * t]);
      return pts2;
    };
    const segDist3 = (A, B) => {
      let dmin = 1e9;
      for (const [xa, ya] of segPts3(A)) for (const [xb, yb] of segPts3(B)) {
        const d3 = Math.hypot(xa - xb, ya - yb);
        if (d3 < dmin) dmin = d3;
      }
      return dmin;
    };
    const NEAR = 0.72 * (chromaRes.MIN / SHRINK);
    const clear = (p) => {
      if (!centers.every(([bx, by]) => Math.hypot(bx - p.x, by - p.y) >= NEAR)) return false;
      const P = { x: p.x, y: p.y, th: p.th, maj: p.maj, min: p.min };
      return stamps.every((q) => segDist3(P, q) >= 0.72 * (P.min + q.min) / 2);
    };
    let nAdd = 0;
    for (const [b, ps] of placedByH) {
      const pc = pipeByH[b];
      const visible = hl.blobArea[b] / AREAH;
      const claimedFrac = hl.blobArea[b] > 0 ? clFgByH[b] / hl.blobArea[b] : 0;
      const ok = !pc && candH.has(b) && visible >= 0.8 && claimedFrac >= 0.5;
      // per-placement dossier floor: every real rescued bead measured fits
      // 0.88-1.0; the one phantom read 0.518. Accepted placements join the
      // physics set IMMEDIATELY so same-blob siblings are checked too.
      const kept = [];
      if (ok) {
        for (const p of ps.slice().sort((a2, b2) => b2.s - a2.s)) {
          if (p.s < 0.75 || !clear(p)) continue;
          kept.push(p);
          stamps.push({ x: p.x, y: p.y, th: p.th, maj: p.maj, min: p.min });
        }
      }
      debug?.({ stage: 'chromablob', blob: b, sc: ps.length, pc,
        visible: +visible.toFixed(2), cand: candH.has(b),
        claimedFrac: +claimedFrac.toFixed(2),
        win: kept.length ? 'chroma' : 'pipe' });
      if (!kept.length) continue;
      for (const p of kept) {
        debug?.({ stage: 'stampplace', mask: 'chroma', blob: b,
          x: Math.round(p.x), y: Math.round(p.y), th: +p.th.toFixed(3),
          fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge });
      }
      const pills = kept.map((p) => ({
        cx: p.x, cy: p.y, theta: +p.th.toFixed(3),
        major: +p.maj.toFixed(1), minor: +p.min.toFixed(1),
        valid: +Math.max(0, Math.min(1, chromaRes.selfMed > 0 ? p.s / chromaRes.selfMed : 1)).toFixed(2),
        fit: +p.s.toFixed(3), photo: p.photo, edge: p.edge,
      }));
      const cx = kept.reduce((a, p) => a + p.x, 0) / kept.length;
      const cy = kept.reduce((a, p) => a + p.y, 0) / kept.length;
      add.push({ cx, cy, area: hl.blobArea[b], units: kept.length,
        confidence: 'high', arc: true, stamp: true, chroma: true, pills });
      countDelta += kept.length;
      nAdd += kept.length;
    }
    chromaNote = ` chroma(+${nAdd})`;

    if (debug) for (const p of chromaRes.placed) {
      const b = hAt(p.x, p.y);
      let nC = 0, nT = 0;
      const R2 = Math.round(Math.max(4, chromaRes.MIN / SHRINK / 2 * 0.8));
      for (let dy = -R2; dy <= R2; dy++) for (let dx = -R2; dx <= R2; dx++) {
        if (dx * dx + dy * dy > R2 * R2) continue;
        const X = (p.x + dx) | 0, Y = (p.y + dy) | 0;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        nT++; if (fgChroma && fgChroma[X + Y * w]) nC++;
      }
      debug({ stage: 'chromaplaceaudit', x: Math.round(p.x), y: Math.round(p.y),
        blobH: b, fit: +p.s.toFixed(3), chr: nT ? +(nC / nT).toFixed(2) : 0 });
    }
    // PHANTOM AUDIT (measurement pass for bidirectional arbitration —
    // chroma-rescue images only). For every pipeline region: what does the
    // chroma+stamp read of its material say? Emitted for every region so
    // thresholds are set from measured values, not guessed.
    if (debug) {
      const anchorsByH = new Map();
      for (const g of chromaRes.anchors) {
        const b = hAt(g.cx, g.cy);
        if (!anchorsByH.has(b)) anchorsByH.set(b, 0);
        anchorsByH.set(b, anchorsByH.get(b) + 1);
      }
      for (const g of regions) {
        const b = hAt(g.cx, g.cy);
        const scH = (b >= 0 ? (placedByH.get(b) || []).length + (anchorsByH.get(b) || 0) : 0);
        const rad = Math.max(4, Math.sqrt((g.area || 1) / Math.PI / (g.units || 1)));
        let nPx = 0, nChr = 0, nFg = 0;
        const R = Math.round(rad);
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          const X = (g.cx + dx) | 0, Y = (g.cy + dy) | 0;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          nPx++;
          if (fgChroma && fgChroma[X + Y * w]) nChr++;
          if (fgFinal[X + Y * w]) nFg++;
        }
        debug({ stage: 'phantomaudit', cx: Math.round(g.cx), cy: Math.round(g.cy),
          units: g.units || 1, conf: g.confidence,
          anchor: anchorSet.has(g), removed: remove.has(g),
          wit: !!(g.arc || g.seam || g.hough || g.geoCorroborated),
          hough: !!g.hough,
          blobH: b, scH, pcH: b >= 0 ? pipeByH[b] : -1,
          chromaFrac: nPx ? +(nChr / nPx).toFixed(2) : 0,
          fgFrac: nPx ? +(nFg / nPx).toFixed(2) : 0,
          photo: Math.round(chromaRes.colDist(sampleRGB(g.cx, g.cy))),
          colThr: Math.round(chromaRes.colThr) });
      }
    }
  }
  maskNote += chromaNote;

  // learned-silhouette handoff for the counter's template card: the card
  // must show the shape the stamp ACTUALLY used, not the assumed stadium
  const kernelOut = res.kernel ? {
    grid: res.kernel.g, KG, KSPAN,
    maj: res.MAJ / SHRINK, min: res.MIN / SHRINK,
    areaFrac: res.kernel.areaFrac,
    medAlign: res.kernel.medAlign, iouStad: res.kernel.iouStad,
  } : null;
  if (!remove.size && !add.length && countDelta === 0) {
    return { fgUsed: res.fg, maskUsed: res.tag, expl: res.expl, retried: res.retried, edgeNote: res.edgeNote,
      maskNote, remove, add, countDelta: 0, changed: false, kernel: kernelOut };
  }
  return { fgUsed: res.fg, maskUsed: res.tag, expl: res.expl, retried: res.retried, edgeNote: res.edgeNote,
    maskNote, remove, add, countDelta, changed: true, kernel: kernelOut };
}
