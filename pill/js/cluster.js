// DEEP CLUSTER RESOLUTION — search over SETS of poses, with overlap as a
// HARD constraint rather than a price.
//
// The rigid-body relaxation that runs before this can only MOVE pills. Three
// failures follow structurally from that, and all three ship today (the
// geometry gate measures 197 overlapping pairs and 59 duplicates over 59 of
// 219 images):
//
//   1. It cannot DELETE. Several pills crossing what is really ONE pill at
//      another angle is a STABLE arrangement -- no single pill improves by
//      moving, so it survives every iteration.
//   2. It cannot judge a SET. Each pill is scored on the material it covers,
//      which inside a cluster is maximised at the same bright centre for all
//      of them, so they migrate onto each other.
//   3. Overlap is charged, not forbidden. Two solids resting on a table
//      cannot share pixels: such an arrangement is INVALID, not lower-scoring.
//
// Score is residual-driven matching pursuit -- explain each mask pixel ONCE:
//   +1 covered once   -1 unexplained   -3 covered twice   -2 pill on board
// A spurious pill therefore cannot pay for itself: it explains no new mask.

export const spineOf = (p) => {
  const a = Math.max(0, (p.maj - p.min) / 2);
  const c = Math.cos(p.th), s = Math.sin(p.th);
  return [p.cx - c * a, p.cy - s * a, p.cx + c * a, p.cy + s * a];
};

export function segSegDist(A, B) {
  const [ax, ay, bx, by] = A, [cx, cy, dx, dy] = B;
  const d = (px, py, qx, qy, rx, ry) => {
    const vx = rx - qx, vy = ry - qy, L = vx * vx + vy * vy;
    let t = L ? ((px - qx) * vx + (py - qy) * vy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (qx + t * vx), py - (qy + t * vy));
  };
  return Math.min(d(ax, ay, cx, cy, dx, dy), d(bx, by, cx, cy, dx, dy),
    d(cx, cy, ax, ay, bx, by), d(dx, dy, ax, ay, bx, by));
}

export const overlapDepth = (p, q) =>
  (p.min + q.min) / 2 - segSegDist(spineOf(p), spineOf(q));

export const insideStadium = (p, x, y) => {
  const [ax, ay, bx, by] = spineOf(p);
  const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
  let t = L ? ((x - ax) * vx + (y - ay) * vy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) <= p.min / 2;
};

export function maxOverlap(pills, obstacles) {
  let worst = 0;
  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) {
      const d = overlapDepth(pills[i], pills[j]);
      if (d > worst) worst = d;
    }
    if (obstacles) for (let k = 0; k < obstacles.length; k++) {
      const d = overlapDepth(pills[i], obstacles[k]);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

// Explain each mask pixel exactly once. Sampled on a stride for speed: the
// score is a ratio-like quantity, so a consistent stride does not bias the
// comparison between candidate sets.
export function scoreSet(pills, mask, w, h, box, step = 1) {
  const { x0, y0, x1, y1 } = box;
  let once = 0, miss = 0, dbl = 0, bg = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      let n = 0;
      for (let k = 0; k < pills.length; k++) {
        if (insideStadium(pills[k], x + 0.5, y + 0.5)) { n++; if (n > 1) break; }
      }
      const m = mask[y * w + x] ? 1 : 0;
      if (m && n === 1) once++;
      else if (m && n === 0) miss++;
      else if (m && n > 1) dbl++;
      else if (!m && n >= 1) bg++;
    }
  }
  return { score: once - miss - 3 * dbl - 2 * bg, once, miss, dbl, bg };
}

// Search over sets. Moves: separate a pair, merge a pair, delete, re-pose.
// Separate and merge are the two a per-pill refiner structurally cannot make.
// `opts.obstacles`: capsules that are NOT part of this cluster but are solid.
// Without them the solver optimises its cluster in isolation and shoves pills
// straight into their neighbours -- measured on s261, both clusters resolved
// to 0 internal overlap while the photo-wide count stayed at 5, because the
// separate move pushed pills into pills the solver could not see.
export function solveCluster(pills0, mask, w, h, box, opts = {}) {
  const TOL = opts.tol ?? 0.75;
  const OBS = opts.obstacles || [];
  const rounds = opts.rounds ?? 4;
  const step = opts.step ?? 1;
  const trace = [];
  let cur = pills0.map((p) => ({ ...p }));
  let curS = scoreSet(cur, mask, w, h, box, step);
  let curOv = maxOverlap(cur, OBS);
  trace.push({ move: 'init', n: cur.length, ...curS, ov: +curOv.toFixed(2) });

  // Validity is a DESTINATION, not a gate on every step: separating two
  // interpenetrating pills needs BOTH to move, and every intermediate is
  // still illegal. A move is admissible if it keeps the set legal or
  // strictly reduces the worst overlap. `byScore` judges on the pixel
  // explanation instead -- required for DELETE, because dropping one of
  // several concentric pills does not lower the worst overlap (the rest
  // still collide) yet is obviously right.
  const tryReplace = (set, label, byScore = false) => {
    const ov = maxOverlap(set, OBS);
    const admissible = ov <= TOL || ov < curOv - 1e-6;
    if (!admissible && !(byScore && ov <= curOv + 1e-6)) return false;
    const s = scoreSet(set, mask, w, h, box, step);
    const better = byScore
      ? (s.score > curS.score + 1e-6 && ov <= curOv + 1e-6)
      : curOv > TOL
        ? (ov < curOv - 1e-6 && s.score >= curS.score - 1e-6)
        : (s.score > curS.score + 1e-6);
    if (!better) return false;
    cur = set; curS = s; curOv = ov;
    trace.push({ move: label, n: cur.length, ...s, ov: +ov.toFixed(2) });
    return true;
  };

  for (let r = 0; r < rounds; r++) {
    let improved = false;

    // SEPARATE a colliding pair along their centre line, both at once.
    if (curOv > TOL) {
      for (let i = 0; i < cur.length; i++) {
        for (let j = i + 1; j < cur.length; j++) {
          const d = overlapDepth(cur[i], cur[j]);
          if (d <= TOL) continue;
          let ux = cur[j].cx - cur[i].cx, uy = cur[j].cy - cur[i].cy;
          const L = Math.hypot(ux, uy);
          if (L < 1e-6) { ux = 1; uy = 0; } else { ux /= L; uy /= L; }
          for (const push of [d * 0.6, d * 0.85, d * 1.1]) {
            const cand = cur.map((p, k) => (k === i
              ? { ...p, cx: p.cx - ux * push, cy: p.cy - uy * push }
              : k === j ? { ...p, cx: p.cx + ux * push, cy: p.cy + uy * push } : p));
            if (tryReplace(cand, 'separate', false)) { improved = true; break; }
          }
        }
      }
    }

    // MERGE a confusable pair into ONE pill, angled by the SECOND MOMENT of
    // the material they jointly cover -- the pixels choose the angle, not
    // either phantom. This is what resolves "several pills crossing one".
    for (let i = 0; i < cur.length && cur.length > 1; i++) {
      let done = false;
      for (let j = i + 1; j < cur.length; j++) {
        const A = cur[i], B = cur[j];
        if (Math.hypot(A.cx - B.cx, A.cy - B.cy) > Math.max(A.maj, B.maj)) continue;
        let sx = 0, sy = 0, n = 0;
        const { x0, y0, x1, y1 } = box;
        for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
          if (!mask[y * w + x]) continue;
          if (!insideStadium(A, x + 0.5, y + 0.5) && !insideStadium(B, x + 0.5, y + 0.5)) continue;
          sx += x + 0.5; sy += y + 0.5; n++;
        }
        if (n < 4) continue;
        const mx = sx / n, my = sy / n;
        let xx = 0, yy = 0, xy = 0;
        for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
          if (!mask[y * w + x]) continue;
          if (!insideStadium(A, x + 0.5, y + 0.5) && !insideStadium(B, x + 0.5, y + 0.5)) continue;
          const dx = x + 0.5 - mx, dy = y + 0.5 - my;
          xx += dx * dx; yy += dy * dy; xy += dx * dy;
        }
        const th = 0.5 * Math.atan2(2 * xy, xx - yy);
        const rest = cur.filter((_, k) => k !== i && k !== j);
        for (const t of [th, th + Math.PI / 2]) {
          if (tryReplace(rest.concat([{ ...A, cx: mx, cy: my, th: t }]), 'merge', true)) {
            improved = true; done = true; break;
          }
        }
        if (done) break;
      }
      if (done) break;
    }

    // DELETE a pill that carries little material of its own.
    for (let i = cur.length - 1; i >= 0; i--) {
      if (cur.length <= 1) break;
      const cand = cur.filter((_, k) => k !== i);
      const sWithout = scoreSet(cand, mask, w, h, box, step);
      const uniqueLoss = sWithout.miss - curS.miss;
      const own = Math.PI * (cur[i].min / 2) * (cur[i].min / 2) / (step * step);
      if (uniqueLoss > 0.45 * own) continue;      // it is carrying real mask
      if (tryReplace(cand, 'delete', true)) improved = true;
    }

    // RE-POSE one pill, accepted on the SET score.
    for (let i = 0; i < cur.length; i++) {
      let bestSet = null, bestScore = curS.score;
      for (let dth = -4; dth <= 4; dth++) {
        for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
          if (!dth && !ox && !oy) continue;
          const cand = cur.map((p, k) => (k === i
            ? { ...p, cx: p.cx + ox * 1.5, cy: p.cy + oy * 1.5, th: p.th + dth * Math.PI / 36 }
            : p));
          const ov = maxOverlap(cand, OBS);
          if (!(ov <= TOL || ov < curOv - 1e-6)) continue;
          const s = scoreSet(cand, mask, w, h, box, step);
          if (curOv > TOL ? ov < curOv - 1e-6 : s.score > bestScore + 1e-6) {
            bestScore = s.score; bestSet = cand;
          }
        }
      }
      if (bestSet) {
        cur = bestSet; curS = scoreSet(cur, mask, w, h, box, step);
        curOv = maxOverlap(cur, OBS); improved = true;
        trace.push({ move: 'pose', n: cur.length, ...curS, ov: +curOv.toFixed(2) });
      }
    }
    if (!improved) break;
  }
  return { pills: cur, score: curS, trace, worstOverlap: curOv };
}
