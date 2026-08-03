import { loadCV, countPills, drawOverlay } from './counter.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#engine-status'),
  video: $('#viewfinder'),
  cameraScreen: $('#camera-screen'),
  resultScreen: $('#result-screen'),
  historyScreen: $('#history-screen'),
  shutter: $('#shutter'),
  uploadBtn: $('#upload-btn'),
  fileInput: $('#file-input'),
  liveToggle: $('#live-toggle'),
  liveCount: $('#live-count'),
  photoCanvas: $('#photo-canvas'),
  overlayCanvas: $('#overlay-canvas'),
  countValue: $('#count-value'),
  targetInfo: $('#target-info'),
  targetInput: $('#target-input'),
  adjustMinus: $('#adjust-minus'),
  adjustPlus: $('#adjust-plus'),
  retake: $('#retake-btn'),
  save: $('#save-btn'),
  medName: $('#med-name'),
  historyBtn: $('#history-btn'),
  historyBack: $('#history-back'),
  historyList: $('#history-list'),
  historyClear: $('#history-clear'),
  cameraFallback: $('#camera-fallback'),
  helperTip: $('#helper-tip'),
  helperReact: $('#helper-react'),
  liveOverlay: $('#live-overlay'),
  useCount: $('#use-count'),
  preview: $('#preview-canvas'),
  libraryInput: $('#library-input'),
  zoomWrap: $('#zoom-wrap'),
  resultPhoto: $('#result-photo'),
};

const TIPS = [
  'Spread the pills out flat — no piles! — and I’ll count them. 🐾',
  'Shoot from straight above, like a bird (or a very tall dog).',
  'Pills can touch, just don’t stack them on top of each other!',
  'Plain backgrounds work best. Kitchen counters are my favorite.',
  'Set a target count and I’ll tell you if you’re over or short.',
];
let tipIndex = 0;

const state = {
  cv: null,
  stream: null,
  live: false,
  liveTimer: null,
  result: null,     // last countPills() result
  count: 0,         // possibly adjusted
  busy: false,
};

// ---------- engine ----------

async function initEngine() {
  els.status.textContent = 'Loading vision engine…';
  try {
    state.cv = await loadCV();
    els.status.textContent = 'Ready';
    els.status.classList.add('ready');
    setTimeout(() => els.status.classList.add('fade'), 1500);
  } catch (e) {
    console.error(e);
    els.status.textContent = 'Engine failed to load';
  }
}

// ---------- camera ----------

async function initCamera() {
  if (new URLSearchParams(location.search).has('nocam')) {
    els.cameraFallback.hidden = false;
    els.shutter.disabled = true;
    els.liveToggle.disabled = true;
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    // Stream acquired = camera works. Do NOT gate on play(): iOS Safari can
    // reject play() (Low Power Mode, autoplay policy) while frames still
    // flow — the preview just needs a retry, often on the first touch.
    els.video.srcObject = state.stream;
    els.cameraFallback.hidden = true;
    els.shutter.disabled = false;
    els.liveToggle.disabled = false;
    els.video.play().catch(() => { /* retried below on user gesture */ });
    const unlockPreview = () => els.video.play().catch(() => {});
    document.addEventListener('touchend', unlockPreview, { once: true, passive: true });
    document.addEventListener('click', unlockPreview, { once: true });
    els.video.addEventListener('loadeddata', () => { els.cameraFallback.hidden = true; }, { once: true });
    startPreview();
    setLive(true); // live counting is the default state
  } catch (e) {
    console.warn('Camera unavailable:', e.name);
    els.cameraFallback.hidden = false;
    els.cameraFallback.querySelector('.sub').textContent =
      `Tap here to choose a photo instead. (${e.name})`;
    els.shutter.disabled = true;
    els.liveToggle.disabled = true;
    // iOS occasionally fails transiently right after permission grant.
    if (!retried) { retried = true; setTimeout(initCamera, 1500); }
  }
}
let retried = false;

function grabFrame() {
  const c = document.createElement('canvas');
  c.width = els.video.videoWidth;
  c.height = els.video.videoHeight;
  c.getContext('2d').drawImage(els.video, 0, 0);
  return c;
}

// ---------- camera preview ----------
// The preview is CANVAS frames (~8fps), not the <video> element: iOS can
// refuse to render the element while still delivering frames to drawImage.
let previewTimer = null;
function startPreview() {
  els.preview.hidden = false;
  clearInterval(previewTimer);
  previewTimer = setInterval(() => {
    if (els.video.readyState < 2 || document.hidden) return;
    // Frames are flowing => the camera works. Make the contradictory
    // "Camera unavailable" state impossible regardless of init race.
    if (!els.cameraFallback.hidden) els.cameraFallback.hidden = true;
    if (els.shutter.disabled) { els.shutter.disabled = false; els.liveToggle.disabled = false; }
    const box = els.preview.parentElement.getBoundingClientRect();
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    if (!vw || !box.width) return;
    if (els.preview.width !== Math.round(box.width) || els.preview.height !== Math.round(box.height)) {
      els.preview.width = Math.round(box.width);
      els.preview.height = Math.round(box.height);
    }
    const s = Math.max(box.width / vw, box.height / vh);
    const ctx = els.preview.getContext('2d');
    ctx.drawImage(els.video, (box.width - vw * s) / 2, (box.height - vh * s) / 2, vw * s, vh * s);
  }, 125);
}

// ---------- live mode ----------
// Live is the default state: the camera counts continuously, on-device.
// The count is smoothed over recent analyses; when it holds steady the chip
// locks green and "Use this count" commits it as a full-res record.

// Live counting is intentionally CONSERVATIVE. On textured backgrounds the
// pipeline can be bistable frame to frame (a rescue branch toggling), so a
// single frame is never trusted: we keep a longer window, report the MODE
// (the value the scene keeps reproducing) rather than the latest reading,
// and only call it stable when a strong majority of recent frames agree.
const LIVE_WINDOW = 9;
const liveCounts = [];
let liveLocked = false;

function liveMapping() {
  // Video renders with object-fit: cover — map processed coords onto the box.
  const box = els.video.getBoundingClientRect();
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const s = Math.max(box.width / vw, box.height / vh);
  return { box, s, ox: (box.width - vw * s) / 2, oy: (box.height - vh * s) / 2 };
}

let liveThr = 0;
let lastWildReport = 0;

function liveTick() {
  if (!state.cv || state.busy || els.video.readyState < 2 || document.hidden) return;
  let r;
  try {
    r = countPills(state.cv, grabFrame(), { maxDim: 640, overlay: false, variant: 'baseline', thrHint: liveThr });
  } catch { return; }
  liveThr = r.thr || 0; // temporal threshold smoothing across frames

  liveCounts.push(r.count);
  if (liveCounts.length > LIVE_WINDOW) liveCounts.shift();

  // Mode with a tolerance band: cluster frames whose counts are within 2% of
  // each other and take the largest cluster's median. A bistable pipeline
  // branch produces a minority of wild outliers — they lose the vote.
  const sorted = [...liveCounts].sort((a, b) => a - b);
  let best = { size: 0, val: sorted[0] };
  for (let i = 0; i < sorted.length; i++) {
    const tol = Math.max(1, sorted[i] * 0.02);
    const grp = sorted.filter((v) => Math.abs(v - sorted[i]) <= tol);
    if (grp.length > best.size) best = { size: grp.length, val: grp[grp.length >> 1] };
  }
  const med = best.val;
  const agreement = best.size / liveCounts.length;
  const spread = sorted[sorted.length - 1] - sorted[0];
  // Stable = most frames agree, not merely "the last few were close".
  const stable = liveCounts.length === LIVE_WINDOW && agreement >= 0.7;

  // Wild variation while the window is full: auto-document it (3-frame
  // session tagged for review), at most once a minute.
  if (liveCounts.length === LIVE_WINDOW && spread > Math.max(4, med * 0.4)
      && Date.now() - lastWildReport > 60000) {
    lastWildReport = Date.now();
    reportSession('wild-variation');
  }

  if (stable !== liveLocked) {
    liveLocked = stable;
    els.liveCount.classList.toggle('stable', stable);
    els.useCount.hidden = !stable;
    if (stable) {
      const target = parseInt(els.targetInput.value, 10);
      els.helperTip.textContent = Number.isFinite(target) && target > 0
        ? (med === target ? `${med} — that’s your target! 🎾` :
           med < target ? `${med} so far — ${target - med} more to reach ${target}.` :
           `${med} — that’s ${med - target} over your target of ${target}.`)
        : `Holding steady at ${med}. Tap “Use this count” to save it.`;
    }
  }
  els.liveCount.textContent = stable ? `${med}` : `~ ${med}`;
  // Honest signal: churn means "hold still / improve the background", not a
  // number to trust. The chip says so instead of flickering silently.
  els.liveCount.classList.toggle('unsure', !stable && spread > Math.max(3, med * 0.15));

  // Badges on the glass (light: no boundaries, just numbered circles).
  const { box, s, ox, oy } = liveMapping();
  const c = els.liveOverlay;
  if (c.width !== Math.round(box.width) || c.height !== Math.round(box.height)) {
    c.width = Math.round(box.width);
    c.height = Math.round(box.height);
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.translate(ox, oy);
  drawOverlay(ctx, r, s * (els.video.videoWidth / r.width), { clear: false });
  ctx.restore();
}

// "Report count": when the live number is misbehaving, capture 3 consecutive
// frames as one marked session for offline review — deliberate uploads only,
// so continuous live view never floods storage.
async function reportSession(tag = 'session') {
  const sid = Math.random().toString(36).slice(2, 8);
  const btn = document.getElementById('session-btn');
  btn.disabled = true;
  for (let k = 1; k <= 3; k++) {
    const frame = grabFrame();
    const small = document.createElement('canvas');
    const s = Math.min(1, 900 / frame.width);
    small.width = Math.round(frame.width * s);
    small.height = Math.round(frame.height * s);
    small.getContext('2d').drawImage(frame, 0, 0, small.width, small.height);
    await new Promise((res) => small.toBlob((blob) => {
      if (!blob) return res();
      const fd = new FormData();
      fd.append('photo', blob, 'frame.jpg');
      fd.append('meta', JSON.stringify({
        count: liveCounts[liveCounts.length - 1] ?? null,
        variant: 'session',
        note: `session ${sid} ${tag} frame ${k}/3`,
      }));
      fetch('api/submit', { method: 'POST', body: fd }).catch(() => {}).finally(res);
    }, 'image/jpeg', 0.85));
    if (k < 3) await new Promise((r) => setTimeout(r, 400));
  }
  btn.disabled = false;
  els.helperTip.textContent = 'Got it — 3 frames sent for review. Thank you! 🐾';
}
document.getElementById('session-btn')?.addEventListener('click', reportSession);

function setLive(on) {
  state.live = on;
  els.liveToggle.classList.toggle('active', on);
  els.liveCount.hidden = !on;
  els.liveOverlay.hidden = !on;
  document.getElementById('session-btn').hidden = !on;
  els.useCount.hidden = true;
  liveCounts.length = 0;
  liveLocked = false;
  liveThr = 0;
  els.liveCount.classList.remove('stable');
  clearInterval(state.liveTimer);
  if (on) state.liveTimer = setInterval(liveTick, 500);
}

// ---------- counting ----------

async function analyze(sourceCanvas) {
  if (!state.cv) { els.status.classList.remove('fade'); els.status.textContent = 'Engine still loading…'; return; }
  state.busy = true;
  els.shutter.classList.add('working');

  // Perceived speed: show the captured photo IMMEDIATELY; the count and
  // overlay fill in when analysis lands a moment later.
  showPhoto(sourceCanvas);
  els.countValue.textContent = '…';
  els.targetInfo.textContent = '';
  els.helperReact.textContent = 'Counting… 👀';
  showScreen('result');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))); // let UI paint

  try {
    const result = countPills(state.cv, sourceCanvas, { maxDim: 1280, variant: 'consensus' });
    state.result = result;
    state.count = result.count;
    showResult(sourceCanvas, result);
    autoUpload(result); // every analyzed photo feeds the regression suite
  } catch (e) {
    console.error('count failed', e);
    alert('Could not analyze that image.');
  } finally {
    state.busy = false;
    els.shutter.classList.remove('working');
  }
}

function showPhoto(sourceCanvas) {
  const maxW = Math.min(900, els.resultScreen.clientWidth || window.innerWidth);
  const displayScaleFromSource = Math.min(1, maxW / sourceCanvas.width);
  const dw = Math.round(sourceCanvas.width * displayScaleFromSource);
  const dh = Math.round(sourceCanvas.height * displayScaleFromSource);

  els.photoCanvas.width = dw;
  els.photoCanvas.height = dh;
  els.photoCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, dw, dh);
  els.overlayCanvas.width = dw;
  els.overlayCanvas.height = dh;
  els.overlayCanvas.getContext('2d').clearRect(0, 0, dw, dh);
  resetZoom();
  requestAnimationFrame(syncOverlayBox); // after the screen is visible
}

function showResult(sourceCanvas, result) {
  // Photo is already on screen (showPhoto); add the overlay + numbers.
  const dw = els.photoCanvas.width;
  // result coords are in processed-resolution space; map to display px
  const overlayScale = dw / result.width;
  drawOverlay(els.overlayCanvas.getContext('2d'), result, overlayScale);
  updateCountUI();
  syncOverlayBox();
}

// ---------- result photo zoom (pinch / pan / double-tap) ----------
// Page zoom is locked (PWA feel); the photo itself zooms. Both canvases live
// in #zoom-wrap so they transform together and can never misalign.
const zoom = { s: 1, tx: 0, ty: 0 };
const zoomPts = new Map();
let lastDist = 0, lastTap = 0;

function applyZoom() {
  els.zoomWrap.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`;
}
function resetZoom() {
  zoom.s = 1; zoom.tx = 0; zoom.ty = 0;
  applyZoom();
}
function scaleAround(px, py, k) {
  const newS = Math.min(5, Math.max(1, zoom.s * k));
  const kEff = newS / zoom.s;
  zoom.s = newS;
  zoom.tx = px - (px - zoom.tx) * kEff;
  zoom.ty = py - (py - zoom.ty) * kEff;
  if (zoom.s === 1) { zoom.tx = 0; zoom.ty = 0; }
  applyZoom();
}
if (els.resultPhoto) {
  els.resultPhoto.addEventListener('pointerdown', (e) => {
    els.resultPhoto.setPointerCapture(e.pointerId);
    zoomPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoomPts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { // double-tap: toggle 2.5x at tap point
        const r = els.resultPhoto.getBoundingClientRect();
        if (zoom.s > 1) resetZoom();
        else scaleAround(e.clientX - r.left, e.clientY - r.top, 2.5);
      }
      lastTap = now;
    }
    if (zoomPts.size === 2) {
      const [a, b] = [...zoomPts.values()];
      lastDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  els.resultPhoto.addEventListener('pointermove', (e) => {
    if (!zoomPts.has(e.pointerId)) return;
    const prev = zoomPts.get(e.pointerId);
    zoomPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoomPts.size === 2) {
      const [a, b] = [...zoomPts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDist > 0) {
        const r = els.resultPhoto.getBoundingClientRect();
        scaleAround((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / lastDist);
      }
      lastDist = d;
    } else if (zoom.s > 1) {
      zoom.tx += e.clientX - prev.x;
      zoom.ty += e.clientY - prev.y;
      applyZoom();
    }
  });
  const endPt = (e) => { zoomPts.delete(e.pointerId); lastDist = 0; };
  els.resultPhoto.addEventListener('pointerup', endPt);
  els.resultPhoto.addEventListener('pointercancel', endPt);
}

// Size the zoom wrapper to the photo's aspect within the visible frame.
// Both canvases fill the wrapper (CSS 100%/100%), so overlay alignment is
// structural — there is no independent scaling left to disagree about.
function syncOverlayBox() {
  const cw = els.photoCanvas.width, ch = els.photoCanvas.height;
  if (!cw || !ch) return;
  const box = els.resultPhoto.getBoundingClientRect();
  const availW = box.width || window.innerWidth - 28;
  const availH = Math.min(window.innerHeight * 0.55, box.height || Infinity);
  const s = Math.min(availW / cw, availH / ch);
  els.zoomWrap.style.width = Math.round(cw * s) + 'px';
  els.zoomWrap.style.height = Math.round(ch * s) + 'px';
}
window.addEventListener('resize', syncOverlayBox);
window.addEventListener('orientationchange', () => setTimeout(syncOverlayBox, 200));

function updateCountUI() {
  els.countValue.textContent = state.count;
  const flagged = state.result?.lowConfidence || 0;
  const target = parseInt(els.targetInput.value, 10);
  if (flagged > 0) {
    els.helperReact.textContent = flagged === 1
      ? 'One group has a “?” badge — I’m not sure about it. Mind double-checking that spot for me? 🐾'
      : `${flagged} groups have “?” badges — please double-check those spots for me. 🐾`;
    els.targetInfo.textContent = Number.isFinite(target) && target > 0
      ? `${state.count} counted (target ${target}) — verify the ? areas first`
      : '';
    els.targetInfo.className = 'target-info over';
    return;
  }
  if (!Number.isFinite(target) || target <= 0) {
    els.targetInfo.textContent = '';
    els.targetInfo.className = 'target-info';
    els.helperReact.textContent = `I count ${state.count}! Check my badges and nudge with + / − if I missed one. 🐶`;
    return;
  }
  const diff = state.count - target;
  if (diff === 0) {
    els.targetInfo.textContent = `Exact — matches target of ${target}`;
    els.targetInfo.className = 'target-info ok';
    els.helperReact.textContent = 'Perfect match! Who’s a good counter? I am! 🎾';
  } else if (diff > 0) {
    els.targetInfo.textContent = `${diff} over target of ${target}`;
    els.targetInfo.className = 'target-info over';
    els.helperReact.textContent = `${diff} extra — take ${diff === 1 ? 'one' : 'some'} out and we’re golden(doodle).`;
  } else {
    els.targetInfo.textContent = `${-diff} short of target of ${target}`;
    els.targetInfo.className = 'target-info short';
    els.helperReact.textContent = `We need ${-diff} more. I’d fetch them if I could!`;
  }
}

// ---------- history ----------

const HISTORY_KEY = 'valeye-history';
const loadHistory = () => JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
const saveHistory = (h) => localStorage.setItem(HISTORY_KEY, JSON.stringify(h));

function saveCurrentCount() {
  const thumb = document.createElement('canvas');
  const s = 96 / Math.max(els.photoCanvas.width, els.photoCanvas.height);
  thumb.width = Math.round(els.photoCanvas.width * s);
  thumb.height = Math.round(els.photoCanvas.height * s);
  const tctx = thumb.getContext('2d');
  tctx.drawImage(els.photoCanvas, 0, 0, thumb.width, thumb.height);
  tctx.drawImage(els.overlayCanvas, 0, 0, thumb.width, thumb.height);

  const target = parseInt(els.targetInput.value, 10);
  const entry = {
    ts: Date.now(),
    count: state.count,
    detected: state.result?.count ?? state.count,
    target: Number.isFinite(target) && target > 0 ? target : null,
    name: els.medName.value.trim() || null,
    thumb: thumb.toDataURL('image/jpeg', 0.7),
  };
  entry.sid = state.submissionId || null;
  const h = loadHistory();
  h.unshift(entry);
  saveHistory(h.slice(0, 200));
  els.medName.value = '';

  // Saving IS labeling: the final (possibly +/- adjusted) count is human
  // ground truth. Attach it to the auto-uploaded photo.
  annotate({ adjusted: state.count, med: entry.name, target: entry.target });

  showScreen('camera');
}

// ---------- telemetry: every photo is a future test case ----------

// Uploads are durable: a failed send (offline, flaky signal) is queued in
// localStorage as a data URL and retried on the next app open / next photo,
// so no real-world test case is ever lost.
const QUEUE_KEY = 'valeye-upload-queue';
const loadQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const saveQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-20))); } catch {} };

async function postPhoto(blobOrDataUrl, meta) {
  const blob = typeof blobOrDataUrl === 'string'
    ? await (await fetch(blobOrDataUrl)).blob()
    : blobOrDataUrl;
  const fd = new FormData();
  fd.append('photo', blob, 'photo.jpg');
  fd.append('meta', JSON.stringify(meta));
  const res = await fetch('api/submit', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

async function flushQueue() {
  const q = loadQueue();
  if (!q.length) return;
  const left = [];
  for (const item of q) {
    try { await postPhoto(item.dataUrl, item.meta); } catch { left.push(item); }
  }
  saveQueue(left);
}

function autoUpload(result) {
  state.submissionId = null;
  const meta = {
    count: result.count,
    lowConfidence: result.lowConfidence ?? 0,
    variant: 'consensus',
  };
  els.photoCanvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      const j = await postPhoto(blob, meta);
      if (j.ok) state.submissionId = j.id;
      flushQueue(); // good connection — drain anything stranded earlier
    } catch {
      const q = loadQueue();
      q.push({ dataUrl: els.photoCanvas.toDataURL('image/jpeg', 0.8), meta });
      saveQueue(q);
    }
  }, 'image/jpeg', 0.85);
}
window.addEventListener('online', flushQueue);

function annotate(fields, sid = state.submissionId) {
  if (!sid) return;
  fetch('api/annotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: sid, ...fields }),
  }).catch(() => {});
}

function renderHistory() {
  const h = loadHistory();
  els.historyClear.hidden = h.length === 0;
  if (!h.length) {
    els.historyList.innerHTML = '<p class="empty">No saved counts yet.</p>';
    return;
  }
  els.historyList.innerHTML = h.map((e, i) => {
    const d = new Date(e.ts);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const adjusted = e.count !== e.detected ? ' (adjusted)' : '';
    const target = e.target ? ` · target ${e.target}` : '';
    const note = e.note ? `<div class="history-sub">📝 ${e.note}</div>` : '';
    return `<div class="history-item">
      <img src="${e.thumb}" alt="" />
      <div class="history-meta">
        <div class="history-count">${e.count} pills${adjusted}</div>
        <div class="history-sub">${e.name ? e.name + ' · ' : ''}${when}${target}</div>
        ${note}
      </div>
      <button class="icon-btn history-note" data-i="${i}" aria-label="Add note">📝</button>
      <button class="icon-btn history-del" data-i="${i}" aria-label="Delete">✕</button>
    </div>`;
  }).join('');
  els.historyList.querySelectorAll('.history-note').forEach((b) => {
    b.addEventListener('click', () => {
      const h2 = loadHistory();
      const entry = h2[parseInt(b.dataset.i, 10)];
      const note = prompt('What did the counter miss or get wrong?', entry.note || '');
      if (note == null) return;
      entry.note = note.trim() || null;
      saveHistory(h2);
      if (entry.sid) annotate({ note: entry.note }, entry.sid);
      renderHistory();
    });
  });
  els.historyList.querySelectorAll('.history-del').forEach((b) => {
    b.addEventListener('click', () => {
      const h2 = loadHistory();
      h2.splice(parseInt(b.dataset.i, 10), 1);
      saveHistory(h2);
      renderHistory();
    });
  });
}

// ---------- screens ----------

function showScreen(name) {
  els.cameraScreen.hidden = name !== 'camera';
  els.resultScreen.hidden = name !== 'result';
  els.historyScreen.hidden = name !== 'history';
  if (name === 'history') renderHistory();
  if (name === 'camera') {
    els.helperTip.textContent = TIPS[tipIndex++ % TIPS.length];
    if (state.live) setLive(true);
  }
  if (name !== 'camera') { clearInterval(state.liveTimer); }
}

// ---------- wiring ----------

// One tap = photo. If the in-page stream is live, capture from it instantly
// (no OS camera UI, no confirm step). Otherwise open the camera directly.
els.shutter.addEventListener('click', () => {
  if (els.video.readyState >= 2) analyze(grabFrame());
  else els.fileInput.click();
});

// Import = library picker; the fallback panel and shutter open the camera
// directly (capture="environment"), so taking a photo stays ONE tap.
els.uploadBtn.addEventListener('click', () => els.libraryInput.click());
els.cameraFallback.addEventListener('click', () => els.fileInput.click());
els.libraryInput.addEventListener('change', () => {
  const file = els.libraryInput.files[0];
  if (file) loadPhotoFile(file);
  els.libraryInput.value = '';
});
function loadPhotoFile(file) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    analyze(c);
  };
  img.src = URL.createObjectURL(file);
}

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (file) loadPhotoFile(file);
  els.fileInput.value = '';
});

els.liveToggle.addEventListener('click', () => setLive(!state.live));
els.useCount.addEventListener('click', () => analyze(grabFrame())); // full-res commit
els.adjustMinus.addEventListener('click', () => { state.count = Math.max(0, state.count - 1); updateCountUI(); });
els.adjustPlus.addEventListener('click', () => { state.count += 1; updateCountUI(); });
els.targetInput.addEventListener('input', updateCountUI);
els.retake.addEventListener('click', () => showScreen('camera'));
els.save.addEventListener('click', saveCurrentCount);
els.historyBtn.addEventListener('click', () => showScreen('history'));
els.historyBack.addEventListener('click', () => showScreen('camera'));
els.historyClear.addEventListener('click', () => {
  if (confirm('Delete all saved counts?')) { saveHistory([]); renderHistory(); }
});

// ---------- boot ----------

if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
initEngine();
initCamera();
showScreen('camera');
flushQueue(); // retry anything that failed to upload previously

// iOS Safari ignores user-scalable=no, so page zoom must be suppressed
// explicitly: block the proprietary gesture events (pinch) and swallow the
// second tap of a double-tap. The photo's own zoom handlers live on
// #result-photo and call stopPropagation, so they keep working.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
{
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch < 350 && !els.resultPhoto.contains(e.target)) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
  // Two-finger pinch anywhere outside the photo is page zoom — block it.
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 && !els.resultPhoto.contains(e.target)) e.preventDefault();
  }, { passive: false });
}

// iOS re-prompts for camera on every Safari *tab* visit, but an installed
// (Add to Home Screen) PWA keeps the grant. Nudge once, only where it helps.
(() => {
  const tip = document.getElementById('install-tip');
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!installed && iOS && !localStorage.getItem('valeye-install-tip-seen')) {
    tip.hidden = false;
    document.getElementById('install-dismiss').addEventListener('click', () => {
      tip.hidden = true;
      localStorage.setItem('valeye-install-tip-seen', '1');
    });
  }
})();
