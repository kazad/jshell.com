/* InstaCalc /evolve — THE EASY SET.
   Four layouts that all pass the five tests (one noun; modes are lenses;
   jobs take turns via doorways; the editor is the resident; the tour is content).
   The point: once the tests hold, the arrangement is a taste call — every one
   of these is an easy decision. */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  const BRAND = () => `<span class="ic-brand">Insta<span>Calc</span></span>`;
  const SEG = (on) => `<span class="ez-seg">${['Notebook', 'Sheet', 'Form', 'Widget']
    .map(m => `<span class="${m === (on || 'Notebook') ? 'on' : ''}">${m}</span>`).join('')}</span>`;

  /* the tour IS the first calc you see */
  const TOUR = `# Welcome — this notebook is alive 🎉
# change any number and watch →
guests = 30
costPerPerson = 18
food = guests * costPerPerson
# name a value once, reuse it anywhere
venue = 250
total = food + venue
perGuest = total / guests
# share = copy the URL. that's it.`;

  const EZ_BASE = `
.ez-seg{display:inline-flex;background:var(--editor-bg);border:1px solid var(--color-border);border-radius:7px;padding:2px;font-size:11.5px;font-weight:600;color:var(--color-text-muted)}
.ez-seg span{padding:3px 11px;border-radius:5px;cursor:pointer}
.ez-seg span:hover{color:var(--color-text-main)}
.ez-seg span.on{background:var(--color-surface-hover);color:var(--color-text-main);box-shadow:0 0 0 1px var(--color-border)}
.ez-k{flex:1;max-width:460px;margin:0 auto;border-radius:8px;cursor:text}
.ez-k kbd{margin-left:auto;border:1px solid var(--color-border);border-radius:4px;padding:1px 6px;font:10.5px 'JetBrains Mono',monospace;color:var(--color-text-muted)}
.ez-by{color:var(--color-text-muted);font-size:11.5px}
.ez-by .ok{color:var(--color-success)}
.ez-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:9px;padding:10px;cursor:pointer;transition:border-color .12s}
.ez-card:hover{border-color:var(--color-text-muted)}
.ez-card .th{background:var(--color-header);border:1px solid var(--color-border);border-radius:6px;padding:9px 11px;height:74px;overflow:hidden;margin-bottom:8px}
.ez-card .ic-mini{font-size:9.5px}
.ez-card b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ez-card span{color:var(--color-text-muted);font-size:10.5px}`;

  /* ============ EASY 1 — THE PAGE (centered doc, doorways only) ============ */
  define({
    id: 'easy-page', name: 'The Page', app: 'the five tests', wire: 'center', easy: true,
    note: 'Easiest possible sentence: “a document editor with a library below it.” One centered column, doorways in the chrome (⌘K, icon rail), library below the fold, and the seeded calc IS the feature tour.',
    css: EZ_BASE + `
.l-easy-page .ep-cols{display:grid;grid-template-columns:46px minmax(0,1fr)}
.l-easy-page .ep-rail{border-right:1px solid var(--color-border);background:var(--color-header);padding:12px 0;display:flex;flex-direction:column;align-items:center;gap:6px;position:sticky;top:45px;height:calc(100vh - 45px)}
.l-easy-page .ep-rail span{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;color:var(--color-text-muted)}
.l-easy-page .ep-rail span:hover{background:var(--color-surface-hover)}
.l-easy-page .ep-rail span.on{background:var(--color-surface-hover);box-shadow:inset 2px 0 0 var(--color-accent-blue)}
.l-easy-page .ep-doc{max-width:700px;margin:0 auto;padding:34px 24px 20px;width:100%}
.l-easy-page .ep-head{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.l-easy-page .ep-head h1{font-size:24px;font-weight:800;letter-spacing:-.02em}
.l-easy-page .ep-head .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-easy-page .ep-meta{display:flex;gap:10px;align-items:center;margin-bottom:16px}
.l-easy-page .ic-calc{font-size:14.5px}
.l-easy-page .ic-calc textarea{height:296px}
.l-easy-page .ep-add{color:var(--color-text-muted);font-size:13px;padding:8px 2px}
.l-easy-page .ep-lib{max-width:700px;margin:26px auto 60px;padding:0 24px;width:100%}
.l-easy-page .ep-lib h3{font-size:14px;font-weight:700;display:flex;gap:10px;align-items:baseline}
.l-easy-page .ep-lib h3 small{color:var(--color-text-muted);font-weight:400;font-size:11.5px}
.l-easy-page .ep-lib .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}`,
    render() {
      const cards = CALCS.slice(0, 6).map(c => `
<div class="ez-card"><div class="th">${mini(c)}</div><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div>`).join('');
      return `
<div class="ic-topbar">${BRAND()}
  <div class="ic-search ez-k">🔍 <input placeholder="Search, commands, or math…"><kbd>⌘K</kbd></div>
  <span class="ic-btn primary">＋ New calc</span><span class="ic-btn">👤</span>
</div>
<div class="ep-cols">
  <div class="ep-rail"><span class="on" title="Home">🏠</span><span title="My calcs">🧮</span><span title="Starred">⭐</span><span title="Library">🗂</span></div>
  <div>
    <div class="ep-doc">
      <div class="ep-head"><h1>🎉 Party Budget</h1><div class="sp">${SEG()}<span class="ic-btn primary">↗ Share</span></div></div>
      <div class="ep-meta"><span class="ez-by">by kazad · autosaved <span class="ok">just now</span> · <span class="ok">● public link</span></span></div>
      ${editor('', TOUR)}
      <div class="ep-add">＋ Add a line</div>
    </div>
    <div class="ep-lib">
      <h3>Library <small>1,642 calcs · scroll for more, or press 🗂</small></h3>
      <div class="grid">${cards}</div>
    </div>
  </div>
</div>`;
    }
  });

  /* ============ EASY 2 — THE DESK (visible but quiet periphery) ============ */
  define({
    id: 'easy-desk', name: 'The Desk', app: 'the five tests', wire: 'split', easy: true,
    note: 'Ambient awareness without competition: mine on the left, everyone’s on the right — both deliberately dimmer and smaller than the stage. The periphery whispers; only the editor speaks at full volume.',
    css: EZ_BASE + `
.l-easy-desk .ed-cols{display:grid;grid-template-columns:200px minmax(0,1fr) 232px;align-items:start}
.l-easy-desk .ed-rail{position:sticky;top:45px;height:calc(100vh - 45px);overflow-y:auto;padding:16px 12px;border-right:1px solid var(--color-border);opacity:.72}
.l-easy-desk .ed-rail:hover,.l-easy-desk .ed-side:hover{opacity:1}
.l-easy-desk .ed-rail h4,.l-easy-desk .ed-side h4{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);margin:14px 0 6px}
.l-easy-desk .ed-rail h4:first-child,.l-easy-desk .ed-side h4:first-child{margin-top:0}
.l-easy-desk .ed-rail a{display:flex;gap:8px;align-items:center;padding:4.5px 8px;border-radius:6px;color:var(--color-text-muted);text-decoration:none;font-size:12.5px}
.l-easy-desk .ed-rail a:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-easy-desk .ed-rail a.on{background:var(--color-surface-hover);color:var(--color-text-main);font-weight:600;box-shadow:inset 2px 0 0 var(--color-accent-blue)}
.l-easy-desk .ed-main{padding:22px 26px}
.l-easy-desk .ed-dochead{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.l-easy-desk .ed-dochead h1{font-size:20px;font-weight:800;letter-spacing:-.015em}
.l-easy-desk .ed-dochead .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-easy-desk .ed-meta{margin-bottom:14px}
.l-easy-desk .ic-calc textarea{height:280px}
.l-easy-desk .ed-side{position:sticky;top:45px;height:calc(100vh - 45px);overflow-y:auto;padding:16px 14px;border-left:1px solid var(--color-border);opacity:.72;font-size:12px}
.l-easy-desk .ed-row{display:flex;gap:9px;align-items:center;padding:5px 6px;border-radius:7px;cursor:pointer}
.l-easy-desk .ed-row:hover{background:var(--color-surface-hover)}
.l-easy-desk .ed-row .ic{width:32px;height:32px;border-radius:7px;background:var(--color-surface-hover);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
.l-easy-desk .ed-row b{font-size:11.5px;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-easy-desk .ed-row span{color:var(--color-text-muted);font-size:10px}`,
    render() {
      const mine = ['🎉 Party Budget', '📐 Mortgage vs Rent', '✈️ Japan trip', '🍕 Catering remix'];
      const side = CALCS.slice(4, 9).map(c => `
<div class="ed-row"><div class="ic">${cat(c.cat).icon}</div><div style="min-width:0"><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div></div>`).join('');
      return `
<div class="ic-topbar">${BRAND()}
  <div class="ic-search ez-k">🔍 <input placeholder="Search, commands, or math…"><kbd>⌘K</kbd></div>
  <span class="ic-btn">⑂ Remix</span><span class="ic-btn primary">＋ New calc</span>
</div>
<div class="ed-cols">
  <div class="ed-rail">
    <h4>My calcs</h4>
    ${mine.map((m, i) => `<a class="${i === 0 ? 'on' : ''}">${m}</a>`).join('')}
    <h4>Collections</h4><a>🎉 Events</a><a>🏠 House hunt</a>
    <h4>Library</h4><a>🗂 Browse 1,642 →</a>
  </div>
  <div class="ed-main">
    <div class="ed-dochead"><h1>🎉 Party Budget</h1><div class="sp">${SEG()}<span class="ic-btn primary">↗ Share</span></div></div>
    <div class="ed-meta ez-by">by kazad · autosaved <span class="ok">just now</span> · ☆ 2.4k · ⑂ 312</div>
    ${editor('')}
  </div>
  <div class="ed-side">
    <h4>While you work</h4>${side}
    <h4>Trending</h4>
    ${CALCS.slice(0, 3).map((c, i) => `<div class="ed-row"><div class="ic" style="font-size:10px;font-family:'JetBrains Mono',monospace">${i + 1}</div><div style="min-width:0"><b>${esc(c.title)}</b><span>▲ ${340 - i * 60} today</span></div></div>`).join('')}
  </div>
</div>`;
    }
  });

  /* ============ EASY 3 — THE DRAWER (today's editor + library on demand) ============ */
  define({
    id: 'easy-drawer', name: 'The Drawer', app: 'the five tests', wire: 'canvas', easy: true,
    note: 'The most conservative easy answer: today’s full-bleed editor, untouched. The entire library — mine and everyone’s — lives in a drawer summoned by one key. Territory on demand; zero cost when closed.',
    css: EZ_BASE + `
.l-easy-drawer .dr-stage{display:flex;flex:1;min-height:0;justify-content:center}
.l-easy-drawer .dr-stage .ic-calc{width:min(720px,92%);margin:26px auto 0;font-size:15px;height:fit-content}
.l-easy-drawer .dr-stage .ic-calc textarea{height:300px}
.l-easy-drawer .dr-dochead{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--color-border)}
.l-easy-drawer .dr-dochead .in{display:flex;align-items:center;gap:12px;width:min(720px,92%);margin:0 auto}
.l-easy-drawer .dr-dochead h1{font-size:16px;font-weight:800}
.l-easy-drawer .dr-dochead .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-easy-drawer .dr-wrap{display:flex;flex-direction:column;height:calc(100vh - 45px)}
.l-easy-drawer .dr-dim{position:fixed;inset:45px 0 0 0;background:rgba(0,0,0,.45);z-index:30;display:none}
body.light-theme .l-easy-drawer .dr-dim{background:rgba(110,110,110,.25)}
.l-easy-drawer.dr-open .dr-dim{display:block}
.l-easy-drawer .drawer{position:fixed;left:0;top:45px;bottom:0;width:340px;background:var(--color-header);border-right:1px solid var(--color-border);box-shadow:var(--shadow);z-index:31;transform:translateX(-100%);transition:transform .25s ease;display:flex;flex-direction:column}
.l-easy-drawer.dr-open .drawer{transform:none}
.l-easy-drawer .drawer .dh{display:flex;gap:4px;padding:12px 14px;border-bottom:1px solid var(--color-border);align-items:center}
.l-easy-drawer .drawer .dh span{padding:4px 12px;border-radius:6px;font-size:12.5px;font-weight:600;color:var(--color-text-muted);cursor:pointer}
.l-easy-drawer .drawer .dh span.on{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-easy-drawer .drawer .dh .x{margin-left:auto;color:var(--color-text-muted);cursor:pointer}
.l-easy-drawer .drawer .dlist{flex:1;overflow-y:auto;padding:10px}
.l-easy-drawer .drow{display:flex;gap:10px;padding:8px;border-radius:8px;cursor:pointer;align-items:center}
.l-easy-drawer .drow:hover{background:var(--color-surface-hover)}
.l-easy-drawer .drow .pv{width:104px;flex:none;background:var(--editor-bg);border:1px solid var(--color-border);border-radius:6px;padding:6px 8px;overflow:hidden}
.l-easy-drawer .drow .pv .ic-mini{font-size:7.5px;line-height:1.6}
.l-easy-drawer .drow b{font-size:12.5px;font-weight:600;display:block}
.l-easy-drawer .drow span{color:var(--color-text-muted);font-size:11px}
.l-easy-drawer .drawer .df{padding:9px 14px;border-top:1px solid var(--color-border);color:var(--color-text-muted);font-size:11px}
.l-easy-drawer .drawer .df kbd{font:10px 'JetBrains Mono',monospace;border:1px solid var(--color-border);border-radius:3px;padding:0 4px}`,
    render() {
      const rows = CALCS.slice(0, 7).map(c => `
<div class="drow"><div class="pv">${mini(c, 2)}</div><div style="min-width:0"><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses · ★ ${c.rating}</span></div></div>`).join('');
      return `
<div class="ic-topbar">${BRAND()}
  <span class="ic-btn" id="dr-btn">🗂 Library <b style="font:10px 'JetBrains Mono',monospace;color:var(--color-text-muted)">L</b></span>
  <div class="ic-search ez-k">🔍 <input placeholder="Search, commands, or math…"><kbd>⌘K</kbd></div>
  <span class="ic-btn">⑂ Remix</span><span class="ic-btn primary">↗ Share</span>
</div>
<div class="dr-wrap">
  <div class="dr-dochead"><div class="in"><h1>🎉 Party Budget</h1><span class="ez-by">by kazad · autosaved <span class="ok">just now</span></span><div class="sp">${SEG()}</div></div></div>
  <div class="dr-stage">${editor('')}</div>
</div>
<div class="dr-dim" id="dr-dim"></div>
<div class="drawer">
  <div class="dh"><span class="on">🧮 Mine</span><span>🗂 Gallery</span><span>⭐ Starred</span><span class="x" id="dr-x">✕</span></div>
  <div class="dlist">${rows}</div>
  <div class="df"><kbd>L</kbd> toggles · <kbd>space</kbd> peeks · <kbd>↵</kbd> opens — your editor never moved</div>
</div>`;
    },
    init(root) {
      const open = v => root.classList.toggle('dr-open', v);
      root.querySelector('#dr-btn').addEventListener('click', () => open(!root.classList.contains('dr-open')));
      root.querySelector('#dr-x').addEventListener('click', () => open(false));
      root.querySelector('#dr-dim').addEventListener('click', () => open(false));
      open(true); /* shown open so the idea is visible; esc/✕/dim closes */
    }
  });

  /* ============ EASY 4 — THE DECK (my calcs as tabs; library is a tab) ============ */
  define({
    id: 'easy-deck', name: 'The Deck', app: 'the five tests', wire: 'topbar', easy: true,
    note: '“Browsing mine” dissolves into a tab strip — the same gesture as a browser. The Library is just another tab, because a list of calcs is itself a document. One noun all the way down.',
    css: EZ_BASE + `
.l-easy-deck .dk-tabs{display:flex;align-items:flex-end;gap:2px;background:var(--color-header);border-bottom:1px solid var(--color-border);padding:6px 10px 0}
.l-easy-deck .dk-tab{display:flex;gap:8px;align-items:center;padding:7px 14px;border:1px solid var(--color-border);border-bottom:0;border-radius:8px 8px 0 0;background:var(--color-header);color:var(--color-text-muted);font-size:12.5px;cursor:pointer;white-space:nowrap}
.l-easy-deck .dk-tab:hover{color:var(--color-text-main)}
.l-easy-deck .dk-tab.on{background:var(--color-bg);color:var(--color-text-main);font-weight:600;box-shadow:inset 0 2px 0 var(--color-accent-blue);position:relative;top:1px}
.l-easy-deck .dk-tab .x{color:var(--color-text-muted);font-size:10px}
.l-easy-deck .dk-tab.lib{margin-left:auto;border-style:dashed}
.l-easy-deck .dk-tab.plus{border-style:dashed;padding:7px 10px}
.l-easy-deck .dk-main{max-width:880px;margin:0 auto;padding:24px}
.l-easy-deck .dk-dochead{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.l-easy-deck .dk-dochead h1{font-size:21px;font-weight:800;letter-spacing:-.015em}
.l-easy-deck .dk-dochead .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-easy-deck .dk-meta{margin-bottom:14px}
.l-easy-deck .ic-calc{font-size:14.5px}
.l-easy-deck .ic-calc textarea{height:300px}
.l-easy-deck .dk-foot{max-width:880px;margin:6px auto 40px;padding:0 24px;color:var(--color-text-muted);font-size:12px;display:flex;gap:18px}
.l-easy-deck .dk-foot kbd{font:10.5px 'JetBrains Mono',monospace;border:1px solid var(--color-border);border-radius:3px;padding:0 4px}`,
    render() {
      return `
<div class="ic-topbar">${BRAND()}
  <div class="ic-search ez-k">🔍 <input placeholder="Search, commands, or math…"><kbd>⌘K</kbd></div>
  <span class="ic-btn">⑂ Remix</span><span class="ic-btn primary">↗ Share</span><span class="ic-btn">👤</span>
</div>
<div class="dk-tabs">
  <div class="dk-tab on">🎉 Party Budget <span class="x">✕</span></div>
  <div class="dk-tab">📐 Mortgage vs Rent <span class="x">✕</span></div>
  <div class="dk-tab">✈️ Japan trip <span class="x">✕</span></div>
  <div class="dk-tab plus">＋</div>
  <div class="dk-tab lib">🗂 Library · 1,642</div>
</div>
<div class="dk-main">
  <div class="dk-dochead"><h1>🎉 Party Budget</h1><div class="sp">${SEG()}</div></div>
  <div class="dk-meta ez-by">by kazad · autosaved <span class="ok">just now</span> · <span class="ok">● public link</span> · ☆ 2.4k · ⑂ 312</div>
  ${editor('')}
</div>
<div class="dk-foot"><span><kbd>⌘1–9</kbd> switch tabs</span><span><kbd>⌘T</kbd> new calc</span><span><kbd>⌘K</kbd> anything else</span><span style="margin-left:auto">the Library tab is just another document — a list of calcs</span></div>`;
    }
  });

})();
