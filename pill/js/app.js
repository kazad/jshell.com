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
    els.video.srcObject = state.stream;
    await els.video.play();
    els.cameraFallback.hidden = true;
    els.shutter.disabled = false;
    els.liveToggle.disabled = false;
    setLive(true); // live counting is the default state
  } catch (e) {
    console.warn('Camera unavailable:', e.name);
    els.cameraFallback.hidden = false;
    els.shutter.disabled = true;
    els.liveToggle.disabled = true;
  }
}

function grabFrame() {
  const c = document.createElement('canvas');
  c.width = els.video.videoWidth;
  c.height = els.video.videoHeight;
  c.getContext('2d').drawImage(els.video, 0, 0);
  return c;
}

// ---------- live mode ----------
// Live is the default state: the camera counts continuously, on-device.
// The count is smoothed over recent analyses; when it holds steady the chip
// locks green and "Use this count" commits it as a full-res record.

const LIVE_WINDOW = 5;
const liveCounts = [];
let liveLocked = false;

function liveMapping() {
  // Video renders with object-fit: cover — map processed coords onto the box.
  const box = els.video.getBoundingClientRect();
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const s = Math.max(box.width / vw, box.height / vh);
  return { box, s, ox: (box.width - vw * s) / 2, oy: (box.height - vh * s) / 2 };
}

function liveTick() {
  if (!state.cv || state.busy || els.video.readyState < 2 || document.hidden) return;
  let r;
  try {
    r = countPills(state.cv, grabFrame(), { maxDim: 640, overlay: false, variant: 'baseline' });
  } catch { return; }

  liveCounts.push(r.count);
  if (liveCounts.length > LIVE_WINDOW) liveCounts.shift();
  const sorted = [...liveCounts].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const spread = sorted[sorted.length - 1] - sorted[0];
  const stable = liveCounts.length === LIVE_WINDOW && spread <= Math.max(1, med * 0.02);

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

function setLive(on) {
  state.live = on;
  els.liveToggle.classList.toggle('active', on);
  els.liveCount.hidden = !on;
  els.liveOverlay.hidden = !on;
  els.useCount.hidden = true;
  liveCounts.length = 0;
  liveLocked = false;
  els.liveCount.classList.remove('stable');
  clearInterval(state.liveTimer);
  if (on) state.liveTimer = setInterval(liveTick, 500);
}

// ---------- counting ----------

async function analyze(sourceCanvas) {
  if (!state.cv) { els.status.classList.remove('fade'); els.status.textContent = 'Engine still loading…'; return; }
  state.busy = true;
  els.shutter.classList.add('working');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))); // let UI paint

  try {
    const result = countPills(state.cv, sourceCanvas, { maxDim: 1280, variant: 'consensus' });
    state.result = result;
    state.count = result.count;
    showResult(sourceCanvas, result);
  } catch (e) {
    console.error('count failed', e);
    alert('Could not analyze that image.');
  } finally {
    state.busy = false;
    els.shutter.classList.remove('working');
  }
}

function showResult(sourceCanvas, result) {
  const maxW = Math.min(900, els.resultScreen.clientWidth || window.innerWidth);
  const displayScaleFromSource = Math.min(1, maxW / sourceCanvas.width);
  const dw = Math.round(sourceCanvas.width * displayScaleFromSource);
  const dh = Math.round(sourceCanvas.height * displayScaleFromSource);

  els.photoCanvas.width = dw;
  els.photoCanvas.height = dh;
  els.photoCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, dw, dh);

  els.overlayCanvas.width = dw;
  els.overlayCanvas.height = dh;
  // result coords are in processed-resolution space; map to display px
  const overlayScale = dw / result.width;
  drawOverlay(els.overlayCanvas.getContext('2d'), result, overlayScale);

  updateCountUI();
  showScreen('result');
}

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
  const h = loadHistory();
  h.unshift(entry);
  saveHistory(h.slice(0, 200));
  els.medName.value = '';
  showScreen('camera');
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
    return `<div class="history-item">
      <img src="${e.thumb}" alt="" />
      <div class="history-meta">
        <div class="history-count">${e.count} pills${adjusted}</div>
        <div class="history-sub">${e.name ? e.name + ' · ' : ''}${when}${target}</div>
      </div>
      <button class="icon-btn history-del" data-i="${i}" aria-label="Delete">✕</button>
    </div>`;
  }).join('');
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

els.shutter.addEventListener('click', () => analyze(grabFrame()));

els.uploadBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (!file) return;
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
