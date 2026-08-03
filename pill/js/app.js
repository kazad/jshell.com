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
  reportBtn: $('#report-btn'),
  zoomWrap: $('#zoom-wrap'),
  resultPhoto: $('#result-photo'),
  adjustBtn: $('#adjust-btn'),
  liveFps: $('#live-fps'),
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
    // Only claim "unavailable" if we truly have no working stream. A retry
    // (or a second init) must never hide a camera that is already running —
    // this produced the reported "Camera unavailable while counting" state.
    if (!state.stream) {
      els.cameraFallback.hidden = false;
      // NotAllowedError = permission denied, which is a user-fixable state,
      // not a broken app. Say how to fix it instead of "unavailable".
      const denied = e.name === 'NotAllowedError';
      els.cameraFallback.querySelector('p').textContent =
        denied ? 'Camera access is off' : 'Camera unavailable.';
      els.cameraFallback.querySelector('.sub').textContent = denied
        ? 'Allow it in Settings → Safari → Camera (or tap “aA” in the address bar → Website Settings). Tap here to pick a photo instead.'
        : `Tap here to choose a photo instead. (${e.name})`;
      els.shutter.disabled = true;
      els.liveToggle.disabled = true;
    }
    if (!retried) { retried = true; setTimeout(initCamera, 1500); }
  }
}
let retried = false;

// Single source of truth: the panel may only be visible when there is no
// live stream AND no frames are arriving. Any other state is a bug, so this
// watchdog corrects it continuously rather than relying on event ordering.
setInterval(() => {
  const framesFlowing = els.video.readyState >= 2 && els.video.videoWidth > 0;
  if ((state.stream || framesFlowing) && !els.cameraFallback.hidden) {
    els.cameraFallback.hidden = true;
    els.shutter.disabled = false;
    els.liveToggle.disabled = false;
  }
}, 400);

// The square capture region, in VIDEO pixel coordinates. It is the largest
// centered square inset by a margin — matching the on-screen guide, so what
// gets counted is exactly what the user framed.
const CAPTURE_INSET = 0.86; // square side = 86% of the short video edge

function captureRect() {
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const side = Math.round(Math.min(vw, vh) * CAPTURE_INSET);
  return { x: Math.round((vw - side) / 2), y: Math.round((vh - side) / 2), side };
}

function grabFrame() {
  const { x, y, side } = captureRect();
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  c.getContext('2d').drawImage(els.video, x, y, side, side, 0, 0, side, side);
  return c;
}

// Draw the guide to match captureRect() as it appears on screen (the preview
// is object-fit: cover, so the mapping must account for the crop).
function layoutGuide() {
  const g = document.getElementById('capture-guide');
  const box = els.preview.parentElement.getBoundingClientRect();
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  if (!vw || !box.width) { g.hidden = true; return; }
  g.hidden = false;
  const s = Math.max(box.width / vw, box.height / vh);      // cover scale
  const ox = (box.width - vw * s) / 2, oy = (box.height - vh * s) / 2;
  const r = captureRect();
  const L = ox + r.x * s, T = oy + r.y * s, S = r.side * s;
  const sq = g.querySelector('.guide-square');
  sq.style.cssText = `left:${L}px;top:${T}px;width:${S}px;height:${S}px`;
  const dims = {
    '.guide-top': `left:0;top:0;width:100%;height:${Math.max(0, T)}px`,
    '.guide-bottom': `left:0;top:${T + S}px;width:100%;bottom:0`,
    '.guide-left': `left:0;top:${T}px;width:${Math.max(0, L)}px;height:${S}px`,
    '.guide-right': `left:${L + S}px;top:${T}px;right:0;height:${S}px`,
  };
  for (const [sel, css] of Object.entries(dims)) g.querySelector(sel).style.cssText = css;
}

// A canvas can come back entirely black when iOS hasn't delivered a frame
// yet (app backgrounded, camera warming up). Uploading those wastes storage
// and poisons the test corpus with unsatisfiable images, so every capture is
// checked before it is analyzed or sent.
function isBlank(canvas) {
  const s = 32;
  const t = document.createElement('canvas');
  t.width = s; t.height = s;
  const ctx = t.getContext('2d');
  ctx.drawImage(canvas, 0, 0, s, s);
  const d = ctx.getImageData(0, 0, s, s).data;
  let max = 0, min = 255;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (l > max) max = l;
    if (l < min) min = l;
  }
  return max < 12 || max - min < 4; // all black, or a flat featureless frame
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
    layoutGuide();
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
  // Analyze ONLY real camera frames. Without this the loop counted an empty
  // canvas and produced phantom counts (observed: "~57" over a blank screen
  // while the camera was not running).
  if (!state.cv || state.busy || document.hidden) return;
  if (!state.stream || els.video.readyState < 2 || !els.video.videoWidth) {
    els.liveCount.hidden = true;
    els.liveOverlay.hidden = true;
    return;
  }
  const probe = grabFrame();
  els.liveCount.hidden = false;
  els.liveOverlay.hidden = false;
  let r;
  try {
    r = countPills(state.cv, probe, { maxDim: 640, overlay: false, variant: 'baseline', thrHint: liveThr });
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
  // Live frames are CROPPED to the capture square, so overlay coordinates are
  // relative to that square, not the whole video: offset by the crop origin.
  const rect = captureRect();
  ctx.save();
  ctx.translate(ox + rect.x * s, oy + rect.y * s);
  drawOverlay(ctx, r, s * (rect.side / r.width), { clear: false });
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
    if (isBlank(frame)) continue; // never upload an empty frame
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
  // Live counting analyses ~2 frames/sec; pausing stops BOTH the analysis and
  // the preview repaint so the camera work stops draining battery.
  els.liveToggle.classList.toggle('paused', !on);
  els.liveToggle.setAttribute('aria-label', on ? 'Pause live counting' : 'Resume live counting');
  const lbl = document.getElementById('live-label');
  if (lbl) lbl.textContent = on ? 'Live' : 'Paused';
  if (!on) {
    // Stop analysis, stop the preview repaint, and RELEASE the camera so the
    // hardware powers down (this is what actually saves battery, and it turns
    // off the phone's recording indicator).
    clearInterval(previewTimer);
    previewTimer = null;
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
      els.video.srcObject = null;
    }
    els.preview.hidden = true;
    els.liveOverlay.hidden = true;
    els.liveCount.hidden = true;
    els.helperTip.textContent = 'Camera paused — tap ▶ Live to start counting again. 🐾';
  } else if (!state.stream) {
    initCamera(); // re-acquire; it calls setLive(true) once frames flow
    return;
  } else if (!previewTimer) {
    startPreview();
  }
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
  if (on) {
    const fps = parseFloat(els.liveFps?.value || '2');
    state.liveTimer = setInterval(liveTick, Math.round(1000 / fps));
  }
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
    state.sourceCanvas = sourceCanvas; // full-res original, for re-cropping
    state.croppedCanvas = null;
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
  els.reportBtn.textContent = '⚠︎ Count is wrong — report it';
  els.reportBtn.classList.remove('sent');
  // A new photo always starts un-cropped.
  crop.on = false;
  document.getElementById('crop-box').hidden = true;
  els.adjustBtn.classList.remove('adjusting');
  els.adjustBtn.textContent = 'Adjust area';
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
  const availH = Math.min(window.innerHeight * 0.62, box.height || Infinity);
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
    build: state.build || null, // which deployed build produced this count
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

async function renderHistory() {
  // History is CLOUD-BACKED: every analyzed photo is uploaded, so the list
  // shows everything counted (not just the ones explicitly saved), survives
  // reinstalls, and is identical on every device. Local entries are merged in
  // as a fallback for anything not yet uploaded.
  els.historyList.innerHTML = '<p class="empty">Loading…</p>';
  let rows = [];
  try {
    const r = await fetch('api/history?limit=60', { cache: 'no-store' });
    const j = await r.json();
    if (j.ok) rows = j.rows;
  } catch { /* offline: fall back to local */ }

  const local = loadHistory();
  if (!rows.length) {
    rows = local.map((e) => ({ id: e.sid, ts: e.ts, count: e.detected ?? e.count,
      adjusted: e.count, target: e.target, med: e.name, note: e.note, thumb: e.thumb }));
  } else {
    const byId = new Map(local.filter((e) => e.sid).map((e) => [e.sid, e]));
    for (const row of rows) {
      const l = byId.get(row.id);
      if (l?.thumb) row.thumb = l.thumb; // instant local thumbnail if we have it
    }
  }

  els.historyClear.hidden = rows.length === 0;
  if (!rows.length) {
    els.historyList.innerHTML = '<p class="empty">No counts yet.</p>';
    return;
  }

  els.historyList.innerHTML = rows.map((e) => {
    const d = new Date(e.ts);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const shown = e.adjusted ?? e.count;
    const corrected = e.adjusted != null && e.adjusted !== e.count
      ? ` <span class="history-fix">(counted ${e.count})</span>` : '';
    const target = e.target ? ` · target ${e.target}` : '';
    const note = e.note ? `<div class="history-sub">📝 ${e.note}</div>` : '';
    const img = e.thumb ? e.thumb : (e.id ? `api/photo/${e.id}` : '');
    return `<div class="history-item" data-id="${e.id || ''}">
      ${img ? `<img src="${img}" alt="" loading="lazy" />` : '<div class="history-nothumb"></div>'}
      <div class="history-meta">
        <div class="history-count">${shown} pills${corrected}</div>
        <div class="history-sub">${e.med ? e.med + ' · ' : ''}${when}${target}</div>
        ${note}
      </div>
      <button class="icon-btn history-note" data-id="${e.id || ''}" aria-label="Fix count or add note">📝</button>
    </div>`;
  }).join('');

  els.historyList.querySelectorAll('.history-note').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      const truth = prompt('How many pills were actually there? (blank to skip)', '');
      const n = parseInt(truth, 10);
      const note = prompt('What went wrong? (optional)', '') || null;
      if (id && (Number.isFinite(n) || note)) {
        annotate({ adjusted: Number.isFinite(n) ? n : undefined, note }, id);
      }
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
// Snapshot = freeze + analyze properly. Live counting runs small and fast
// (640px, baseline) so it can keep up; a snapshot pauses the stream and runs
// the full-quality pass (1280px, consensus with self-flagging). Same camera,
// already streaming, so the capture itself is instant.
els.shutter.addEventListener('click', async () => {
  // Prefer the in-app viewfinder: it is the only path that shows the square
  // framing guide. If the stream is merely still warming up, wait briefly
  // rather than dropping the user into the guide-less native camera.
  if (els.video.readyState < 2 && state.stream) {
    els.helperTip.textContent = 'One moment — warming up the camera… 🐾';
    for (let i = 0; i < 12 && els.video.readyState < 2; i++) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  if (els.video.readyState >= 2) {
    const frame = grabFrame();
    if (isBlank(frame)) { els.helperTip.textContent = 'Camera’s still waking up — try that again in a second. 🐾'; return; }
    // FREEZE: stop live analysis so the frame can't change mid-count and the
    // phone's whole budget goes to the high-quality pass.
    freezeLive();
    analyze(frame);
  } else els.fileInput.click();
});

// Pause the live loop (keeping the stream open for an instant retake) and
// leave the captured frame on screen.
function freezeLive() {
  clearInterval(state.liveTimer);
  state.liveTimer = null;
  clearInterval(previewTimer);
  previewTimer = null;
  state.live = false;
  els.liveToggle.classList.add('paused');
  const lbl = document.getElementById('live-label');
  if (lbl) lbl.textContent = 'Paused';
}

// Import = library picker; the fallback panel and shutter open the camera
// directly (capture="environment"), so taking a photo stays ONE tap.
// "Import" opens the CAMERA by default (concrete accept + capture makes iOS
// skip the Photo Library / Take Photo / Choose File sheet). Long-press it to
// reach the photo library instead.
els.uploadBtn.addEventListener('click', () => els.fileInput.click());
{
  let holdTimer = null;
  const startHold = () => { holdTimer = setTimeout(() => { holdTimer = null; els.libraryInput.click(); }, 550); };
  const endHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  els.uploadBtn.addEventListener('touchstart', startHold, { passive: true });
  els.uploadBtn.addEventListener('touchend', endHold);
  els.uploadBtn.addEventListener('touchcancel', endHold);
  els.uploadBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); els.libraryInput.click(); });
}

// Tapping the logo forces an update: re-check the worker, drop caches, reload.
document.getElementById('brand-btn').addEventListener('click', async () => {
  const tag = document.getElementById('build-tag');
  tag.textContent = 'updating…';
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
    const keys = await caches.keys();
    // Keep the big wasm cache warm only if it is the current build's.
    await Promise.all(keys.map((k) => caches.delete(k)));
    await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
  } catch { /* proceed to reload regardless */ }
  location.reload();
});
els.cameraFallback.addEventListener('click', () => els.fileInput.click());
els.libraryInput.addEventListener('change', () => {
  const file = els.libraryInput.files[0];
  if (file) loadPhotoFile(file);
  els.libraryInput.value = '';
});
function loadPhotoFile(file) {
  const img = new Image();
  img.onload = () => {
    // Photos from the NATIVE camera (or the library) never saw our on-screen
    // guide, so apply the same centered-square rule here. That keeps frame
    // edges/corners — a known source of phantom "pills" — out of the count
    // regardless of which capture path produced the image.
    const side = Math.round(Math.min(img.naturalWidth, img.naturalHeight) * CAPTURE_INSET);
    const sx = Math.round((img.naturalWidth - side) / 2);
    const sy = Math.round((img.naturalHeight - side) / 2);
    const c = document.createElement('canvas');
    c.width = side;
    c.height = side;
    c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, side, side);
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
// Changing the rate restarts the loop at the new interval.
els.liveFps.addEventListener('change', () => { if (state.live) setLive(true); });
els.useCount.addEventListener('click', () => analyze(grabFrame())); // full-res commit
els.adjustMinus.addEventListener('click', () => { state.count = Math.max(0, state.count - 1); updateCountUI(); });
els.adjustPlus.addEventListener('click', () => { state.count += 1; updateCountUI(); });
els.targetInput.addEventListener('input', updateCountUI);
// Report a wrong count WITHOUT saving it as a good one: asks for the true
// count (pre-filled with the current, possibly +/- adjusted number) and an
// optional note, then labels the already-uploaded photo as a failure case.
// ---------- report sheet (replaces browser prompts) ----------
const sheet = {
  el: document.getElementById('report-sheet'),
  value: 0,
  machine: 0,
};

function openReportSheet() {
  sheet.machine = state.result?.count ?? state.count;
  sheet.value = state.count;
  document.getElementById('sheet-machine').textContent = `ValEye counted ${sheet.machine}`;
  document.getElementById('sheet-value').textContent = sheet.value;
  document.getElementById('sheet-note').value = '';
  sheet.el.hidden = false;
}
function closeReportSheet() { sheet.el.hidden = true; }
function bumpSheet(d) {
  sheet.value = Math.max(0, sheet.value + d);
  document.getElementById('sheet-value').textContent = sheet.value;
}

els.reportBtn.addEventListener('click', openReportSheet);
document.getElementById('sheet-minus').addEventListener('click', () => bumpSheet(-1));
document.getElementById('sheet-plus').addEventListener('click', () => bumpSheet(1));
document.getElementById('sheet-cancel').addEventListener('click', closeReportSheet);
sheet.el.addEventListener('click', (e) => { if (e.target === sheet.el) closeReportSheet(); });

document.getElementById('sheet-submit').addEventListener('click', () => {
  const n = sheet.value;
  const note = document.getElementById('sheet-note').value.trim() || null;
  closeReportSheet();

  if (!state.submissionId) {
    // Upload failed or still in flight: queue the photo WITH its labels so
    // the report is never lost.
    els.photoCanvas.toBlob((blob) => {
      if (!blob) return;
      const q = loadQueue();
      q.push({
        dataUrl: els.photoCanvas.toDataURL('image/jpeg', 0.8),
        meta: { count: sheet.machine, adjusted: n, lowConfidence: state.result?.lowConfidence ?? 0,
                variant: 'consensus', build: state.build || null, note: note || 'reported wrong' },
      });
      saveQueue(q);
      flushQueue();
    }, 'image/jpeg', 0.85);
  } else {
    annotate({ adjusted: n, note: note || 'reported wrong' });
  }

  state.count = n;
  updateCountUI();
  els.reportBtn.textContent = `✓ Reported — thank you! (actual: ${n})`;
  els.reportBtn.classList.add('sent');
  els.helperReact.textContent = 'Got it — I saved this one so I can learn from it. 🐾';
});


// ---------- crop editor: adjust the counted area, recount live ----------
// The count is the feedback: drag the box and the number updates in ~300ms,
// so the user is never cropping blind. The ORIGINAL full-res capture is kept,
// so repeated adjustments never compound quality loss.
const crop = { on: false, x: 0, y: 0, w: 0, h: 0, drag: null, timer: null };

function cropToPhotoScale() {
  // photo canvas pixels per source pixel
  return els.photoCanvas.width / (state.sourceCanvas?.width || els.photoCanvas.width);
}

function drawCropBox() {
  const box = document.getElementById('crop-box');
  const s = cropToPhotoScale();
  const disp = els.photoCanvas.getBoundingClientRect();
  const wrap = els.zoomWrap.getBoundingClientRect();
  const k = disp.width / els.photoCanvas.width; // css px per canvas px
  box.style.left = `${(els.photoCanvas.offsetLeft) + crop.x * s * k}px`;
  box.style.top = `${(els.photoCanvas.offsetTop) + crop.y * s * k}px`;
  box.style.width = `${crop.w * s * k}px`;
  box.style.height = `${crop.h * s * k}px`;
}

function recountCropped() {
  if (!state.sourceCanvas) return;
  const c = document.createElement('canvas');
  c.width = Math.max(16, Math.round(crop.w));
  c.height = Math.max(16, Math.round(crop.h));
  c.getContext('2d').drawImage(state.sourceCanvas,
    Math.round(crop.x), Math.round(crop.y), Math.round(crop.w), Math.round(crop.h),
    0, 0, c.width, c.height);
  try {
    const r = countPills(state.cv, c, { maxDim: 1280, variant: 'consensus' });
    state.result = r;
    state.count = r.count;
    state.croppedCanvas = c;
    els.countValue.textContent = r.count;
  } catch { /* keep previous count */ }
}

function setAdjust(on) {
  crop.on = on;
  const box = document.getElementById('crop-box');
  box.hidden = !on;
  els.adjustBtn.classList.toggle('adjusting', on);
  els.adjustBtn.textContent = on ? 'Done' : 'Adjust area';
  if (on) {
    const src = state.sourceCanvas;
    crop.x = 0; crop.y = 0; crop.w = src.width; crop.h = src.height;
    drawCropBox();
    els.helperReact.textContent = 'Drag the box to include just the pills — I’ll recount as you go. 🐾';
  } else {
    // Commit: re-render the result from the cropped image.
    if (state.croppedCanvas) showPhoto(state.croppedCanvas);
    if (state.result) showResult(state.croppedCanvas || state.sourceCanvas, state.result);
    updateCountUI();
  }
}

els.adjustBtn.addEventListener('click', () => setAdjust(!crop.on));

{
  const box = document.getElementById('crop-box');
  const pt = (e) => ({ x: e.clientX, y: e.clientY });
  let start = null, orig = null;
  const onDown = (e) => {
    if (!crop.on) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the photo-zoom handler steal it
    box.setPointerCapture(e.pointerId);
    crop.drag = e.target.dataset.h || 'move';
    start = pt(e);
    orig = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  };
  const onMove = (e) => {
    if (!crop.drag || !start) return;
    e.preventDefault();
    const s = cropToPhotoScale();
    const k = els.photoCanvas.getBoundingClientRect().width / els.photoCanvas.width;
    const dx = (e.clientX - start.x) / (s * k);
    const dy = (e.clientY - start.y) / (s * k);
    const src = state.sourceCanvas;
    const MIN = Math.max(40, src.width * 0.1);
    let { x, y, w, h } = orig;
    if (crop.drag === 'move') {
      x = Math.min(Math.max(0, orig.x + dx), src.width - w);
      y = Math.min(Math.max(0, orig.y + dy), src.height - h);
    } else {
      if (crop.drag.includes('l')) { x = Math.max(0, orig.x + dx); w = orig.w - (x - orig.x); }
      if (crop.drag.includes('r')) { w = Math.min(src.width - orig.x, orig.w + dx); }
      if (crop.drag.includes('t')) { y = Math.max(0, orig.y + dy); h = orig.h - (y - orig.y); }
      if (crop.drag.includes('b')) { h = Math.min(src.height - orig.y, orig.h + dy); }
      if (w < MIN) w = MIN;
      if (h < MIN) h = MIN;
    }
    crop.x = x; crop.y = y; crop.w = w; crop.h = h;
    drawCropBox();
    clearTimeout(crop.timer);
    crop.timer = setTimeout(recountCropped, 220); // live count, debounced
  };
  const onUp = (e) => {
    if (!crop.drag) return;
    crop.drag = null;
    clearTimeout(crop.timer);
    recountCropped();
  };
  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
}

els.retake.addEventListener('click', () => {
  setAdjust(false);
  showScreen('camera');
  if (state.stream) setLive(true); // un-freeze: the stream is still open
});
els.save.addEventListener('click', saveCurrentCount);
els.historyBtn.addEventListener('click', () => showScreen('history'));
els.historyBack.addEventListener('click', () => showScreen('camera'));
els.historyClear.addEventListener('click', () => {
  // Cloud history is the record of truth for testing/backtests, so this only
  // clears the local thumbnail cache — it never deletes uploaded evidence.
  if (confirm('Clear locally cached thumbnails? (Cloud history is kept for testing.)')) {
    saveHistory([]);
    renderHistory();
  }
});

// ---------- boot ----------

if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Auto-update: check for a new build on launch and whenever the app is
    // brought back to the foreground, then activate + reload once so the
    // phone can never sit on a stale build.
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 5 * 60 * 1000);

    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          nw.postMessage('skip-waiting');
        }
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }).catch(() => {});
}
initEngine();
initCamera();
showScreen('camera');
flushQueue(); // retry anything that failed to upload previously

// Build stamp beside the logo, read from the DEPLOYED service worker's cache
// name (deploy.sh rewrites it per build) — so it can never claim a version
// the running code isn't. Shown as MMDD-HHMM.
fetch('sw.js', { cache: 'no-store' })
  .then((r) => r.text())
  .then((t) => {
    const tag = document.getElementById('build-tag');
    const dated = t.match(/valeye-v(\d{4})(\d{4})-(\d{4})/); // deployed: vYYYYMMDD-HHMM
    if (dated) {
      tag.textContent = `${dated[2]}·${dated[3]}`;
      state.build = `v${dated[1]}${dated[2]}-${dated[3]}`;
      return;
    }
    const local = t.match(/valeye-(v[\w-]+)/); // dev: whatever sw.js says
    if (local) { tag.textContent = local[1]; state.build = local[1]; }
  })
  .catch(() => {});

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

