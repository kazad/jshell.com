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
  const { w, h, fgFinal, fgOtsu, cover, luma, sampleRGB, regions, count,
    contestedRegions, unownedSeeds, debug } = env;
  const SHRINK = env.shrink || 0.92;
  const TAUF = env.tauf || 0.6;

  const pipeSingles = regions.filter((g) => (g.units || 1) === 1 && g.shape);

  function claimStadium(claimed, cx, cy, maj, min, th, inset) {
    const c = Math.cos(th), s = Math.sin(th);
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

    // ---- ANCHORS (trust test, ASYMMETRIC area band: only area ABOVE implied
    // disqualifies — below-implied is mask erosion on a real single).
    const IMPLIED = radiusEst > 0
      ? stadArea(Math.max(2 * radiusEst, MAJ0 * (2 * radiusEst) / MIN0 || MAJ0), 2 * radiusEst)
      : stadArea(MAJ0, MIN0);
    const anchors = [], contested = [];
    for (const g of regions) {
      const rel = g.area / IMPLIED;
      const minRel = radiusEst > 0 && g.shape ? g.shape.minor / (2 * radiusEst) : 1;
      const ok = (g.units || 1) === 1 && g.shape && g.shape.residual <= 0.06
        && rel <= 1.25 && minRel >= 0.7 && minRel <= 1.3;
      (ok ? anchors : contested).push(g);
    }

    // ---- scoring (graded bg penalty; claimed NEUTRAL)
    function covScore(pts, cx, cy, th, claimed) {
      const c = Math.cos(th), s = Math.sin(th);
      let sum = 0;
      for (const [u, v] of pts) {
        const x = (cx + u * c - v * s) | 0, y = (cy + u * s + v * c) | 0;
        if (x < 0 || y < 0 || x >= w || y >= h) { sum -= 1.4; continue; }
        const i = y * w + x;
        if (claimed[i]) continue;                       // neutral
        if (fg[i]) sum += 1;
        else sum -= 1.4 * Math.min(1, dtOut[i] / D0);
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
    function refine(pts, x0, y0, th0, claimed) {
      let best = { s: covScore(pts, x0, y0, th0, claimed), x: x0, y: y0, th: th0 };
      for (let round = 0; round < 8; round++) {
        let improved = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const sc = covScore(pts, best.x + dx, best.y + dy, best.th, claimed);
          if (sc > best.s) { best = { s: sc, x: best.x + dx, y: best.y + dy, th: best.th }; improved = true; }
        }
        for (const dth of [Math.PI / 48, -Math.PI / 48, Math.PI / 24, -Math.PI / 24]) {
          const sc = covScore(pts, best.x, best.y, best.th + dth, claimed);
          if (sc > best.s) { best = { ...best, s: sc, th: best.th + dth }; improved = true; }
        }
        if (!improved) break;
      }
      return best;
    }

    const mainPts = basePts(MAJ, MIN), mainBd = boundPts(MAJ, MIN);

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
    for (const g of pool) {
      let best = -9, bth = 0;
      for (let k = 0; k < K; k++) {
        const th = k * Math.PI / K;
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

    // ---- claims: anchors pre-claim their own fitted stadium at 0.95 inset
    let claimed = new Uint8Array(w * h);
    const claimAnchors = (cl) => { for (const g of anchors) claimStadium(cl, g.cx, g.cy, g.shape.major, g.shape.minor, g.shape.theta, 0.95); };
    claimAnchors(claimed);

    // ---- generic peel pass with incremental score grid ----
    function peelPass(o2) {
      const { maj, min, tau, claimed: cl, allow, useEdgeGate, src = 'main' } = o2;
      const pts = basePts(maj, min), bd = boundPts(maj, min);
      const Kn = maj / min < 1.02 ? 1 : K;
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
        for (let k = 0; k < Kn; k++) { const sc = covScore(pts, x, y, k * Math.PI / Kn, cl); if (sc > bs) { bs = sc; bk = k; } }
        gs[gi] = bs; gk[gi] = bk;
      };
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) rescore(gx, gy);
      const placed = [], vetoes = [];
      const VETO2 = (0.6 * min) * (0.6 * min);
      const vetoed = (x, y, th) => {
        for (const v of vetoes) {
          const dx = v.x - x, dy = v.y - y;
          if (dx * dx + dy * dy >= VETO2) continue;
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
      for (let iter = 0; iter < 400; iter++) {
        let bi = -1, bs = tau;
        for (let i = 0; i < gs.length; i++) if (gs[i] > bs) { bs = gs[i]; bi = i; }
        if (bi < 0) break;
        let best = { s: gs[bi], x: (bi % gw) * stride, y: ((bi / gw) | 0) * stride, k: gk[bi] };
        const pts0 = best;
        for (let dy = -stride; dy <= stride; dy += 2) for (let dx = -stride; dx <= stride; dx += 2) {
          for (let k = 0; k < Kn; k++) {
            const sc = covScore(pts, pts0.x + dx, pts0.y + dy, k * Math.PI / Kn, cl);
            if (sc > best.s) best = { s: sc, x: pts0.x + dx, y: pts0.y + dy, k };
          }
        }
        const rf = refine(pts, best.x, best.y, best.k * Math.PI / Kn, cl);
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
        // interior photometry: claim-but-don't-count on obvious non-pill
        const cdv = colDist(sampleRGB(rf.x, rf.y));
        claimStadium(cl, rf.x, rf.y, maj, min, rf.th, 0.9);
        localRescore(rf.x, rf.y);
        if (cdv > Math.max(200, 2.5 * colThr)) {
          debug?.({ stage: 'stampveto', kind: 'photometry', x: rf.x, y: rf.y,
            fit: +rf.s.toFixed(3), photo: Math.round(cdv) });
          continue;
        }
        placed.push({ x: rf.x, y: rf.y, th: rf.th, s: rf.s, maj, min, src,
          photo: Math.round(cdv), edge: eg.applicable ? +eg.e.toFixed(3) : null });
      }
      return placed;
    }

    const totalFg = fg.reduce((a, b) => a + b, 0);
    const explained = (cl) => {
      let n = 0; for (let i = 0; i < w * h; i++) if (fg[i] && cl[i]) n++;
      return n / Math.max(1, totalFg);
    };

    let placed = peelPass({ maj: MAJ, min: MIN, tau: TAU, claimed, allow: o.allow, useEdgeGate: true });
    let expl = explained(claimed);

    // ---- retry (b): DT-maxima circle-template raft pass, gated by weak
    // evidence AND the beige signature (o.raftOK); accept only if it
    // explains more.
    let retried = '';
    if (o.raftOK && expl < 0.65 && clusterFrac < 0.7) {
      const bigArea = 3 * stadArea(MAJ, MIN);
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

    fgMat.delete(); labMat.delete(); distMat.delete();
    return { placed, anchors, claimed, expl, fg, MAJ, MIN, TAU, tplSrc, clusterFrac,
      cands, radiusEst, selfMed: med(selfScores), retried, edgeNote, tag };
  }

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
  for (const g of contestedRegions) {
    const b = blobAt(g.cx, g.cy, attrR);
    if (b >= 0) arbitrable.add(b);
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
  let res = analyze(fgFinal, 'final', { allow, raftOK });
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
    if (res2.expl > res.expl + 0.1 && total2 > count) { res = res2; maskNote = 'otsu'; }
    else maskNote = `otsuRejected(expl=${res2.expl.toFixed(2)},total=${total2})`;
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
      add.push({ cx, cy, area: b >= 0 ? ol.blobArea[b] : ps.length * stadArea(res.MAJ, res.MIN),
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
    const AREA = stadArea(res.MAJ / SHRINK, res.MIN / SHRINK);
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
      // s138 5->6 — all on exact pipelines) read 0.61-0.63.
      if (sc > pc && pc > 0 && claimedFrac < 0.75) stampWins = false;
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

  if (!remove.size && !add.length && countDelta === 0) {
    return { maskUsed: res.tag, expl: res.expl, retried: res.retried, edgeNote: res.edgeNote,
      maskNote, remove, add, countDelta: 0, changed: false };
  }
  return { maskUsed: res.tag, expl: res.expl, retried: res.retried, edgeNote: res.edgeNote,
    maskNote, remove, add, countDelta, changed: true };
}
