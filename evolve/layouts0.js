/* InstaCalc /evolve — layout 0: THE STUDIO (recommended synthesis).
   The browse+create combo: Google's instant editor front and center,
   Notion's workspace rail, YouTube's up-next, McMaster/Airbnb gallery,
   Linear's ⌘K. One screen where making a calc and finding a calc coexist. */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  define({
    id: 'combo', name: 'The Studio', app: 'the best of all 20', wire: 'split', rec: true,
    note: '★ Recommended combo — the full notebook editor IS the landing page (zero clicks to calculating), with Notion’s workspace rail, YouTube’s up-next, a McMaster-dense gallery below, Linear’s ⌘K. Create and browse never fight for the screen.',
    css: `
.l-combo{font-size:13.5px}
.l-combo .c-k{flex:1;max-width:520px;margin:0 auto;border-radius:8px;cursor:text}
.l-combo .c-k kbd{margin-left:auto;border:1px solid var(--color-border);border-radius:4px;padding:1px 6px;font:10.5px 'JetBrains Mono',monospace;color:var(--color-text-muted)}
.l-combo .c-acts{display:flex;gap:8px;align-items:center}
.l-combo .c-av{width:28px;height:28px;border-radius:50%;background:var(--color-surface-hover);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}
.l-combo .c-cols{display:grid;grid-template-columns:225px minmax(0,1fr) 285px;gap:0;align-items:start}
.l-combo .c-rail{position:sticky;top:45px;height:calc(100vh - 45px);overflow-y:auto;border-right:1px solid var(--color-border);padding:14px 10px;background:var(--color-header)}
.l-combo .c-rail h4{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);padding:14px 10px 5px}
.l-combo .c-rail h4:first-child{padding-top:0}
.l-combo .c-rail a{display:flex;align-items:center;gap:9px;padding:5.5px 10px;border-radius:6px;color:var(--color-text-muted);text-decoration:none;font-size:13px}
.l-combo .c-rail a:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-combo .c-rail a.on{background:var(--color-surface-hover);color:var(--color-text-main);font-weight:600;box-shadow:inset 2px 0 0 var(--color-accent-blue)}
.l-combo .c-rail a i{font-style:normal;margin-left:auto;font:10.5px 'JetBrains Mono',monospace;color:var(--color-text-muted)}
.l-combo .c-main{padding:18px 22px 60px;min-width:0}
.l-combo .c-doc{overflow:hidden}
.l-combo .c-dochead{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--color-border)}
.l-combo .c-title{font-size:17px;font-weight:700;letter-spacing:-.01em}
.l-combo .c-by{color:var(--color-text-muted);font-size:12px;margin-top:2px}
.l-combo .c-by .pub{color:var(--color-success)}
.l-combo .c-docacts{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-combo .c-docacts .ic-btn b{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:var(--color-text-muted);margin-left:2px}
.l-combo .c-doc .ic-calc{border:0;border-radius:0;padding:14px 18px;font-size:14.5px}
.l-combo .c-doc .ic-calc textarea{height:232px}
.l-combo .c-docfoot{display:flex;align-items:center;gap:14px;padding:10px 18px;border-top:1px solid var(--color-border);background:var(--color-header);font-size:12.5px;color:var(--color-text-muted)}
.l-combo .c-docfoot .add{color:var(--color-text-main);cursor:pointer}
.l-combo .c-docfoot .add:hover{color:var(--color-accent-blue)}
.l-combo .c-docfoot .chips{margin-left:auto;display:flex;gap:6px}
.l-combo .c-bhead{display:flex;align-items:baseline;gap:18px;margin:26px 2px 12px}
.l-combo .c-bhead h3{font-size:16px;font-weight:700;letter-spacing:-.01em}
.l-combo .c-tabs{display:flex;gap:4px}
.l-combo .c-tabs span{padding:4px 11px;border-radius:6px;color:var(--color-text-muted);font-size:12.5px;cursor:pointer}
.l-combo .c-tabs span:hover{color:var(--color-text-main)}
.l-combo .c-tabs span.on{background:var(--color-surface-hover);color:var(--color-text-main);font-weight:600}
.l-combo .c-vt{margin-left:auto;color:var(--color-text-muted);font-size:13px;letter-spacing:4px}
.l-combo .c-vt b{color:var(--color-text-main)}
.l-combo .c-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:14px}
.l-combo .c-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;padding:12px;cursor:pointer;transition:border-color .12s,transform .12s}
.l-combo .c-card:hover{border-color:var(--color-text-muted);transform:translateY(-1px)}
.l-combo .c-card .ic-thumb{border-radius:7px;padding:12px;height:96px;display:flex;align-items:center;margin-bottom:10px}
.l-combo .c-card .ic-mini{font-size:9.5px;min-width:0;flex:1}
.l-combo .c-card b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-combo .c-card .m{color:var(--color-text-muted);font-size:11.5px;margin-top:3px;display:flex;justify-content:space-between}
.l-combo .c-side{position:sticky;top:45px;height:calc(100vh - 45px);overflow-y:auto;border-left:1px solid var(--color-border);padding:18px 16px}
.l-combo .c-side h4{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);margin:0 0 10px}
.l-combo .c-side h4.later{margin-top:22px}
.l-combo .c-next{display:flex;gap:10px;padding:7px 6px;border-radius:8px;cursor:pointer;align-items:center}
.l-combo .c-next:hover{background:var(--color-surface-hover)}
.l-combo .c-nexti{width:42px;height:42px;border-radius:8px;background:var(--color-surface-hover);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center;font-size:17px;flex:none}
.l-combo .c-next b{font-size:12px;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-combo .c-next span{color:var(--color-text-muted);font-size:11px}
.l-combo .c-tr{display:flex;gap:8px;align-items:baseline;padding:5px 6px;border-radius:6px;font-size:12.5px;cursor:pointer}
.l-combo .c-tr:hover{background:var(--color-surface-hover)}
.l-combo .c-tr .rk{font:10.5px 'JetBrains Mono',monospace;color:var(--color-text-muted);width:14px}
.l-combo .c-tr .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-combo .c-tr .up{font:10.5px 'JetBrains Mono',monospace;color:var(--color-success)}
.l-combo .c-cta{margin-top:22px;padding:14px;text-align:left}
.l-combo .c-cta b{font-size:13px;display:block;margin-bottom:4px}
.l-combo .c-cta p{color:var(--color-text-muted);font-size:12px;line-height:1.5;margin-bottom:10px}`,
    render() {
      const rail = `
<h4>Workspace</h4>
<a class="on">🏠 Home</a><a>🧮 My calcs<i>12</i></a><a>👥 Shared<i>4</i></a><a>⭐ Starred</a>
<h4>Collections</h4>
<a>🎉 Events</a><a>🏠 House hunt</a><a>💼 Consulting</a><a style="color:var(--color-text-muted)">＋ New collection</a>
<h4>Gallery</h4>
${CATEGORIES.slice(0, 7).map(c => `<a>${c.icon} ${c.name}<i>${c.count}</i></a>`).join('')}
<a style="color:var(--color-accent-blue)">Browse all 1,642 →</a>`;
      const cards = CALCS.slice(0, 6).map(c => `
<div class="c-card">${thumb(c)}<b>${esc(c.title)}</b><div class="m"><span>${esc(c.author)} · ${c.uses} uses</span><span>★ ${c.rating}</span></div></div>`).join('');
      const next = CALCS.slice(6, 10).map(c => `
<div class="c-next"><div class="c-nexti">${cat(c.cat).icon}</div><div style="min-width:0"><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div></div>`).join('');
      const trending = CALCS.slice(0, 5).map((c, i) => `
<div class="c-tr"><span class="rk">${i + 1}</span><span class="nm">${esc(c.title)}</span><span class="up">▲ ${Math.round(340 - i * 52)}</span></div>`).join('');
      return `
<div class="ic-topbar">
  <span class="ic-brand">Insta<span>Calc</span></span>
  <div class="ic-search c-k">🔍 <input placeholder="Search 1,642 calcs — or just type math…"><kbd>⌘K</kbd></div>
  <div class="c-acts"><span class="ic-btn">⑂ Remix</span><span class="ic-btn primary">＋ New calc</span><span class="c-av">K</span></div>
</div>
<div class="c-cols">
  <div class="c-rail">${rail}</div>
  <div class="c-main">
    <div class="c-doc ic-card">
      <div class="c-dochead">
        <div><div class="c-title">🎉 Party Budget</div><div class="c-by">by kazad · autosaved just now · <span class="pub">● public link</span></div></div>
        <div class="c-docacts"><span class="ic-btn">☆ Star<b>2.4k</b></span><span class="ic-btn">⑂ Remix<b>312</b></span><span class="ic-btn primary">↗ Share</span></div>
      </div>
      ${editor('')}
      <div class="c-docfoot"><span class="add">＋ Add a line</span><span>results update as you type</span><div class="chips"><span class="ic-tag">events</span><span class="ic-tag">budgeting</span><span class="ic-tag">everyday</span></div></div>
    </div>
    <div class="c-bhead"><h3>Browse the gallery</h3>
      <div class="c-tabs"><span class="on">Trending</span><span>New</span><span>Finance</span><span>For you</span></div>
      <div class="c-vt"><b>▦</b> ☰</div>
    </div>
    <div class="c-grid">${cards}</div>
  </div>
  <div class="c-side">
    <h4>Up next</h4>${next}
    <h4 class="later">Trending today</h4>${trending}
    <div class="c-cta ic-card"><b>Start from a template</b><p>Skip the blank page — 1,642 working calcs to remix.</p><span class="ic-btn">Browse templates</span></div>
  </div>
</div>`;
    }
  });

})();
