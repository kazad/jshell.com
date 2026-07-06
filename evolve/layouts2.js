/* InstaCalc /evolve — layouts 11–20 (structure borrowed, skin = current jshell theme) */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  const BRAND = (extra) => `<span class="ic-brand ${extra || ''}">Insta<span>Calc</span></span>`;

  /* ============ 11. NOTION — workspace of pages ============ */
  define({
    id: 'notion', name: 'The Workspace', app: 'Notion', wire: 'leftrail',
    note: 'Calcs as pages in a personal workspace: sidebar tree, breadcrumbs, blocks. Gallery is a linked database at the bottom of the page.',
    css: `
.l-no{display:grid;grid-template-columns:250px minmax(0,1fr)}
.l-no .n-side{background:var(--color-header);border-right:1px solid var(--color-border);padding:10px 8px;font-size:13.5px;overflow-y:auto}
.l-no .n-ws{display:flex;align-items:center;gap:8px;font-weight:700;padding:6px 10px;border-radius:6px}
.l-no .n-ws:hover{background:var(--color-surface-hover)}
.l-no .n-side a{display:flex;gap:8px;align-items:center;padding:4px 10px;border-radius:6px;color:var(--color-text-muted);text-decoration:none;font-size:13px}
.l-no .n-side a:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-no .n-side a.on{background:var(--color-surface-hover);color:var(--color-text-main);font-weight:600}
.l-no .n-side h4{font-size:10px;color:var(--color-text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:14px 10px 4px}
.l-no .n-side .sub{padding-left:26px}
.l-no .n-page{overflow-y:auto;height:100vh}
.l-no .n-crumb{display:flex;gap:6px;align-items:center;padding:12px 18px;font-size:13px;color:var(--color-text-muted);position:sticky;top:0;background:var(--color-bg);border-bottom:1px solid var(--color-border);z-index:2}
.l-no .n-crumb .share{margin-left:auto;display:flex;gap:14px;color:var(--color-text-main)}
.l-no .n-doc{max-width:720px;margin:0 auto;padding:26px 24px 80px}
.l-no .n-icon{font-size:56px}
.l-no h1{font-size:34px;font-weight:800;letter-spacing:-.02em;margin:8px 0 18px}
.l-no .n-callout{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:8px;padding:13px 16px;display:flex;gap:12px;font-size:13.5px;margin-bottom:18px;color:var(--color-text-main)}
.l-no .n-callout b{font-family:'JetBrains Mono',monospace;background:var(--color-header);border:1px solid var(--color-border);border-radius:4px;padding:0 5px;font-size:12px}
.l-no .n-calc{margin-bottom:8px}
.l-no .n-calc .ic-calc textarea{height:224px}
.l-no .n-add{color:var(--color-text-muted);font-size:13.5px;padding:6px 2px;margin-bottom:26px}
.l-no h2{font-size:20px;font-weight:700;margin:22px 0 6px}
.l-no .n-dbbar{display:flex;gap:14px;font-size:13px;color:var(--color-text-muted);border-bottom:1px solid var(--color-border);padding-bottom:6px;margin-bottom:2px}
.l-no .n-dbbar b{color:var(--color-text-main);font-weight:600;border-bottom:2px solid var(--color-accent-blue);padding-bottom:6px;margin-bottom:-7px}
.l-no table{width:100%;border-collapse:collapse;font-size:13px}
.l-no td,.l-no th{border-bottom:1px solid var(--color-border);padding:7px 8px;text-align:left}
.l-no th{color:var(--color-text-muted);font-weight:500;font-size:12px}
.l-no td .pg{font-weight:600}
.l-no td .uses{font-family:'JetBrains Mono',monospace;font-size:12px}
.l-no .n-chip{background:var(--color-surface-hover);border:1px solid var(--color-border);color:var(--color-text-muted);border-radius:4px;padding:1px 7px;font-size:11px}`,
    render() {
      const rows = CALCS.slice(0, 7).map(c => `
<tr><td class="pg">${cat(c.cat).icon} ${esc(c.title)}</td><td><span class="n-chip">${cat(c.cat).name}</span></td><td>${esc(c.author)}</td><td class="uses">${c.uses}</td><td class="uses">${c.age} ago</td></tr>`).join('');
      return `
<div class="n-side">
  <div class="n-ws">🧮 ${BRAND()} <span style="color:var(--color-text-muted)">⌄</span></div>
  <a>🔍 Search</a><a>🕘 Updates</a><a>⚙️ Settings</a>
  <h4>My calcs</h4>
  <a class="on">🎉 Party Budget</a><a class="sub">🍕 Catering remix</a><a>🏠 Mortgage vs Rent</a><a>✈️ Japan trip</a>
  <h4>Shared</h4><a>👥 Team budget Q3</a><a>👥 Sprint velocity</a>
  <h4>Explore</h4><a>🗂 Gallery</a><a>📋 Templates</a><a>🗑 Trash</a>
</div>
<div class="n-page">
  <div class="n-crumb">🎉 Party Budget <span style="opacity:.4">/</span> <span>My calcs</span><div class="share"><span class="ic-btn">Share</span><span>💬</span><span>⭐</span><span>⋯</span></div></div>
  <div class="n-doc">
    <div class="n-icon">🎉</div>
    <h1>Party Budget</h1>
    <div class="n-callout">💡 <div>Every line is a block. Type <b>/</b> for formulas, tables, and charts — results update live as you edit.</div></div>
    <div class="n-calc">${editor('')}</div>
    <div class="n-add">＋ Add a line</div>
    <h2>Gallery</h2>
    <div class="n-dbbar"><b>⊞ All calcs</b><span>📈 By uses</span><span>🆕 Recent</span><span style="margin-left:auto">Filter · Sort · 🔍</span></div>
    <table><tr><th>Name</th><th>Category</th><th>Author</th><th>Uses</th><th>Edited</th></tr>${rows}</table>
  </div>
</div>`;
    }
  });

  /* ============ 12. LINEAR — keyboard-first density ============ */
  define({
    id: 'linear', name: 'The Command Line', app: 'Linear', wire: 'split',
    note: 'For heavy users: dense triage list, side peek, and a ⌘K palette as the primary navigation. Everything reachable without the mouse.',
    css: `
.l-li{font-size:13px;display:grid;grid-template-columns:220px minmax(0,1fr) 380px;height:100vh}
.l-li .li-rail{border-right:1px solid var(--color-border);background:var(--color-header);padding:14px 10px;overflow-y:auto}
.l-li .li-ws{display:flex;align-items:center;gap:8px;font-weight:700;padding:4px 8px 14px}
.l-li .li-ws .cube{width:18px;height:18px;border-radius:4px;background:linear-gradient(135deg,var(--color-accent-blue),var(--color-success));display:inline-block}
.l-li .li-rail a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:var(--color-text-muted);text-decoration:none}
.l-li .li-rail a:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-li .li-rail a.on{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-li .li-rail a kbd{margin-left:auto;color:var(--color-text-muted);font-size:10px;font-family:'JetBrains Mono',monospace;opacity:.7}
.l-li .li-rail h4{color:var(--color-text-muted);font-size:10.5px;padding:14px 8px 4px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.l-li .li-main{overflow-y:auto;border-right:1px solid var(--color-border)}
.l-li .li-tabs{display:flex;gap:2px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--color-border);position:sticky;top:0;background:var(--color-bg);z-index:2}
.l-li .li-tabs span{padding:4px 10px;border-radius:6px;color:var(--color-text-muted);cursor:pointer}
.l-li .li-tabs span.on{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-li .li-tabs .fl{margin-left:auto;border:1px solid var(--color-border);border-radius:6px;padding:3px 9px}
.l-li .li-row{display:flex;align-items:center;gap:10px;padding:7px 16px;border-bottom:1px solid var(--color-border);cursor:pointer}
.l-li .li-row:hover{background:var(--color-surface-hover)}
.l-li .li-row.sel{background:var(--color-surface-hover);box-shadow:inset 2px 0 0 var(--color-accent-blue)}
.l-li .dot{width:9px;height:9px;border-radius:50%;flex:none;border:1px solid var(--color-border)}
.l-li .dot.s{background:var(--color-success);border-color:transparent}
.l-li .dot.b{background:var(--color-accent-blue);border-color:transparent}
.l-li .dot.m{background:var(--color-text-muted);border-color:transparent}
.l-li .li-id{color:var(--color-text-muted);font-family:'JetBrains Mono',monospace;font-size:11px;width:70px;flex:none}
.l-li .li-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-li .li-chip{border:1px solid var(--color-border);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--color-text-muted);flex:none}
.l-li .li-a{color:var(--color-text-main);font-size:11px;flex:none;width:24px;height:24px;border-radius:50%;background:var(--color-surface-hover);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center}
.l-li .li-age{color:var(--color-text-muted);font-size:11px;width:26px;text-align:right;font-family:'JetBrains Mono',monospace}
.l-li .li-peek{padding:16px;overflow-y:auto;background:var(--color-header)}
.l-li .li-peek .ph{display:flex;gap:8px;align-items:center;color:var(--color-text-muted);font-size:12px;margin-bottom:10px;font-family:'JetBrains Mono',monospace}
.l-li .li-peek h2{font-size:16px;margin-bottom:10px;font-weight:700}
.l-li .li-peek .ic-calc textarea{height:224px;font-size:12.5px;line-height:26px}
.l-li .li-peek .ic-out{line-height:26px}
.l-li .li-props{margin-top:14px;font-size:12.5px;color:var(--color-text-muted);line-height:2}
.l-li .li-props b{color:var(--color-text-main);font-weight:500;margin-left:14px}
.l-li .li-props .lv{color:var(--color-success)}
.l-li .li-k{position:fixed;left:50%;top:16%;transform:translateX(-50%);width:540px;background:var(--color-header);border:1px solid var(--color-border);border-radius:12px;box-shadow:var(--shadow);z-index:50;overflow:hidden}
.l-li .li-k .ki{padding:13px 16px;border-bottom:1px solid var(--color-border);font-size:14px}
.l-li .li-k .ki span{color:var(--color-text-muted)}
.l-li .li-k .kr{display:flex;gap:10px;padding:9px 16px;color:var(--color-text-main);font-size:13px;align-items:center}
.l-li .li-k .kr:hover,.l-li .li-k .kr.on{background:var(--color-surface-hover)}
.l-li .li-k .kr kbd{margin-left:auto;color:var(--color-text-muted);font-size:11px;font-family:'JetBrains Mono',monospace}`,
    render() {
      const dots = ['s', 'b', 'm'];
      const rows = CALCS.map((c, i) => `
<div class="li-row ${i === 1 ? 'sel' : ''}"><span class="dot ${dots[i % 3]}"></span><span class="li-id">CALC-${140 + i}</span><span class="li-t">${esc(c.title)}</span><span class="li-chip">${cat(c.cat).name}</span><span class="li-a">${esc(c.author[0].toUpperCase())}</span><span class="li-age">${c.age}</span></div>`).join('');
      return `
<div class="li-rail">
  <div class="li-ws"><span class="cube"></span> InstaCalc <span style="color:var(--color-text-muted)">⌄</span></div>
  <a class="on">📥 Inbox <kbd>G I</kbd></a><a>🧮 My calcs <kbd>G M</kbd></a><a>🗂 Gallery <kbd>G G</kbd></a><a>⭐ Starred</a>
  <h4>Views</h4><a>🔥 Trending</a><a>🆕 New this week</a><a>👥 From people I follow</a>
  <h4>Collections</h4><a>🎉 Events</a><a>🏠 House hunt</a><a>💼 Consulting</a>
</div>
<div class="li-main">
  <div class="li-tabs"><span class="on">All</span><span>Active</span><span>Popular</span><span class="fl">⚙ Filter</span></div>
  ${rows}
</div>
<div class="li-peek">
  <div class="ph">CALC-141 · Party Budget <span style="margin-left:auto">⤢ Open full</span></div>
  <h2>🎉 Party Budget</h2>
  ${editor('')}
  <div class="li-props">Status<b class="lv">● Live</b><br>Owner<b>kazad</b><br>Collection<b>Events</b><br>Uses<b>18,340</b><br>Shared<b>public link</b></div>
</div>
<div class="li-k">
  <div class="ki">⌘K <span>— Type a command or search calcs…</span></div>
  <div class="kr on">🧮 New calc <kbd>C</kbd></div>
  <div class="kr">🗂 Browse gallery <kbd>G G</kbd></div>
  <div class="kr">🔍 “mortgage” — 12 calcs</div>
  <div class="kr">↗ Share current calc <kbd>⌘⇧S</kbd></div>
</div>`;
    }
  });

  /* ============ 13. GITHUB — calc as repository ============ */
  define({
    id: 'github', name: 'The Repo', app: 'GitHub', wire: 'doc',
    note: 'A calc is a repo: stars, forks (“remixes”), history, README. Naturally social + versioned — remix culture made explicit.',
    css: `
.l-gh{font-size:13.5px}
.l-gh .gh-search{width:300px}
.l-gh .gh-search kbd{margin-left:auto;border:1px solid var(--color-border);border-radius:4px;padding:0 5px;font-size:10px;font-family:'JetBrains Mono',monospace}
.l-gh .ic-topbar nav{display:flex;gap:14px;font-size:13px;font-weight:600;margin-left:auto;align-items:center}
.l-gh .gh-head{padding:16px 24px 0}
.l-gh .gh-name{font-size:18px;display:flex;align-items:center;gap:8px}
.l-gh .gh-name a{color:var(--color-accent-blue);text-decoration:none}
.l-gh .gh-name a:hover{text-decoration:underline}
.l-gh .gh-name .pub{border:1px solid var(--color-border);border-radius:999px;font-size:11px;color:var(--color-text-muted);padding:1px 8px;font-weight:500}
.l-gh .gh-acts{float:right;display:flex;gap:8px}
.l-gh .gh-acts .ic-btn b{background:var(--color-border);border-radius:999px;padding:0 7px;margin-left:2px;font-family:'JetBrains Mono',monospace;font-size:11px}
.l-gh .gh-tabs{display:flex;gap:6px;padding:10px 24px 0;border-bottom:1px solid var(--color-border);margin-top:8px}
.l-gh .gh-tabs span{padding:8px 12px;font-size:13px;color:var(--color-text-muted);border-bottom:2px solid transparent;cursor:pointer}
.l-gh .gh-tabs span:hover{color:var(--color-text-main)}
.l-gh .gh-tabs span.on{border-color:var(--color-accent-blue);color:var(--color-text-main);font-weight:600}
.l-gh .gh-tabs b{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:999px;padding:0 7px;font-size:11px;font-weight:500;font-family:'JetBrains Mono',monospace}
.l-gh .gh-body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;padding:20px 24px 60px;max-width:1200px}
.l-gh .gh-file{border:1px solid var(--color-border);border-radius:8px;overflow:hidden}
.l-gh .gh-file .fh{background:var(--color-header);border-bottom:1px solid var(--color-border);padding:9px 14px;font-size:12px;color:var(--color-text-muted);display:flex;gap:10px}
.l-gh .gh-file .fh b{color:var(--color-text-main);font-family:'JetBrains Mono',monospace}
.l-gh .gh-code{display:flex;background:var(--editor-bg)}
.l-gh .gh-lines{padding:12px 0;color:var(--color-text-muted);opacity:.6;text-align:right;font:12.5px/28px 'JetBrains Mono',monospace;width:44px;flex:none;user-select:none}
.l-gh .gh-code .ic-calc{flex:1;border:0;border-radius:0;padding:12px 16px 12px 10px}
.l-gh .gh-code .ic-calc textarea{height:224px;font-size:13px}
.l-gh .gh-readme{border:1px solid var(--color-border);border-radius:8px;margin-top:18px;padding:20px 26px}
.l-gh .gh-readme h2{border-bottom:1px solid var(--color-border);padding-bottom:6px;margin-bottom:10px;font-size:19px}
.l-gh .gh-readme p{line-height:1.6;margin-bottom:10px}
.l-gh .gh-readme code{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:4px;padding:1px 5px;font-size:12px;font-family:'JetBrains Mono',monospace}
.l-gh .gh-side h4{font-size:13.5px;margin-bottom:8px;font-weight:700}
.l-gh .gh-side p{color:var(--color-text-muted);font-size:13px;line-height:1.5;margin-bottom:10px}
.l-gh .gh-side .topics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.l-gh .gh-side .topics span{background:var(--tint-blue);color:var(--color-accent-blue);border-radius:999px;padding:2px 10px;font-size:11.5px;font-weight:600}
.l-gh .gh-side .stat{font-size:12.5px;color:var(--color-text-muted);line-height:1.9}
.l-gh .gh-side .stat b{color:var(--color-text-main);font-family:'JetBrains Mono',monospace}
.l-gh .gh-side hr{border:0;border-top:1px solid var(--color-border);margin:14px 0}
.l-gh .gh-forks{font-size:12.5px;line-height:1.9;color:var(--color-text-muted)}
.l-gh .gh-forks a{color:var(--color-accent-blue);text-decoration:none}
.l-gh .gh-forks a:hover{text-decoration:underline}`,
    render() {
      const forks = CALCS.slice(1, 5).map(c => `<div>⑂ <a>${esc(c.author)}/${c.id}-remix</a> · ${c.age} ago</div>`).join('');
      return `
<div class="ic-topbar">${BRAND()}<div class="ic-search gh-search">🔍 Type <b style="font-family:'JetBrains Mono',monospace">/</b> to search calcs… <kbd>/</kbd></div>
<nav><span>Gallery</span><span>Trending</span><span>My Calcs</span><span>＋ ▾</span><span>👤</span></nav></div>
<div class="gh-head">
  <div class="gh-acts"><span class="ic-btn">👁 Watch<b>41</b></span><span class="ic-btn">⑂ Remix<b>312</b></span><span class="ic-btn">☆ Star<b>2.4k</b></span></div>
  <div class="gh-name">📐 <a>kazad</a> / <a><b>party-budget</b></a> <span class="pub">Public</span></div>
</div>
<div class="gh-tabs"><span class="on">🧮 Calc</span><span>📄 README</span><span>💬 Questions <b>12</b></span><span>⑂ Remixes <b>312</b></span><span>🕘 History <b>14</b></span><span>📊 Insights</span></div>
<div class="gh-body">
  <div>
    <div class="gh-file">
      <div class="fh"><b>party-budget.calc</b><span>8 lines · live</span><span style="margin-left:auto">Raw · Blame · ✏️</span></div>
      <div class="gh-code"><div class="gh-lines">1<br>2<br>3<br>4<br>5<br>6<br>7<br>8</div>${editor('bare')}</div>
    </div>
    <div class="gh-readme">
      <h2>Party Budget</h2>
      <p>Estimate event costs from a per-guest rate plus fixed expenses. Change <code>guests</code> and watch <code>total</code> and <code>perGuest</code> recalculate.</p>
      <p><b>Remixing:</b> hit <code>⑂ Remix</code> to get your own editable copy with attribution back to this calc.</p>
    </div>
  </div>
  <div class="gh-side">
    <h4>About</h4><p>The party-planning math everyone redoes from scratch, done once, shared forever.</p>
    <div class="topics"><span>events</span><span>budgeting</span><span>everyday</span><span>beginner-friendly</span></div>
    <div class="stat">☆ <b>2,412</b> stars<br>⑂ <b>312</b> remixes<br>▶ <b>18.3k</b> uses<br>👁 <b>41</b> watching</div>
    <hr><h4>Remixes</h4><div class="gh-forks">${forks}</div>
    <hr><h4>Contributors</h4><p>Ⓚ Ⓢ Ⓜ Ⓙ +9</p>
  </div>
</div>`;
    }
  });

  /* ============ 14. STRIPE — polished product marketing ============ */
  define({
    id: 'stripe', name: 'The Pitch', app: 'Stripe', wire: 'canvas',
    note: 'A real marketing homepage: hero with a floating live product demo, social proof, feature triplet. For the logged-out first impression.',
    css: `
.l-st{font-size:15px}
.l-st .st-nav{display:flex;align-items:center;gap:26px;padding:16px 48px;position:absolute;width:100%;z-index:5;font-weight:500;font-size:14px;color:var(--color-text-main)}
.l-st .st-nav .right{margin-left:auto;display:flex;gap:14px;align-items:center}
.l-st .st-hero{position:relative;padding:100px 48px 80px;overflow:hidden;background:
  radial-gradient(60% 80% at 15% 10%, var(--tint-blue), transparent 60%),
  radial-gradient(50% 70% at 90% 80%, var(--tint-success), transparent 60%),
  var(--color-header);
  border-bottom:1px solid var(--color-border);clip-path:polygon(0 0,100% 0,100% 92%,0 100%)}
.l-st .st-hero .in{max-width:1150px;margin:0 auto;display:grid;grid-template-columns:1.1fr 1fr;gap:50px;align-items:center}
.l-st h1{font-size:48px;line-height:1.06;letter-spacing:-.03em;font-weight:800;margin-bottom:18px}
.l-st h1 em{font-style:normal;color:var(--color-success)}
.l-st .st-hero p{color:var(--color-text-muted);font-size:16px;line-height:1.6;max-width:46ch;margin-bottom:22px}
.l-st .st-cta{display:flex;gap:10px}
.l-st .st-cta .ic-search{width:260px}
.l-st .st-demo{box-shadow:var(--shadow);border-radius:14px;background:var(--editor-bg);border:1px solid var(--color-border);padding:16px 20px;transform:rotate(-1.2deg)}
.l-st .st-demo .cap{display:flex;gap:6px;margin-bottom:10px}
.l-st .st-demo .cap i{width:10px;height:10px;border-radius:50%;background:var(--color-border);display:block}
.l-st .st-demo .ic-calc{border:0;padding:0;background:transparent}
.l-st .st-demo .ic-calc textarea{height:224px}
.l-st .st-logos{text-align:center;color:var(--color-text-muted);padding:34px 20px 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.l-st .st-logorow{display:flex;gap:44px;justify-content:center;padding:14px 0 30px;font-weight:800;font-size:15px;color:var(--color-text-muted);opacity:.65;letter-spacing:.02em}
.l-st .st-feats{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:40px;padding:30px 40px 80px}
.l-st .st-feats .ic{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;margin-bottom:12px;background:var(--color-surface-hover);border:1px solid var(--color-border)}
.l-st .st-feats .ic.b{background:var(--tint-blue);border-color:transparent}
.l-st .st-feats .ic.g{background:var(--tint-success);border-color:transparent}
.l-st .st-feats h3{font-size:16px;margin-bottom:8px;font-weight:700}
.l-st .st-feats p{color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:6px}
.l-st .st-feats a{color:var(--color-accent-blue);font-weight:600;text-decoration:none;font-size:14px}
.l-st .st-feats a:hover{text-decoration:underline}`,
    render() {
      return `
<div class="st-nav">${BRAND()}<span>Gallery</span><span>Templates</span><span>Docs</span><span>Pricing</span>
<div class="right"><span>Sign in</span><span class="ic-btn primary">Start now ›</span></div></div>
<div class="st-hero"><div class="in">
  <div>
    <h1>Calculation infrastructure for <em>everyday life</em></h1>
    <p>Millions of decisions come down to a little math. Build a live, shareable calculator in seconds — no spreadsheet, no signup, no formulas hidden in cells.</p>
    <div class="st-cta"><div class="ic-search"><input placeholder="Email address"></div><span class="ic-btn primary">Start calculating</span></div>
  </div>
  <div class="st-demo"><div class="cap"><i></i><i></i><i></i></div>${editor('bare')}</div>
</div></div>
<div class="st-logos">Trusted for the math behind</div>
<div class="st-logorow"><span>WEDDINGS</span><span>STARTUPS</span><span>ROAD TRIPS</span><span>CLASSROOMS</span><span>RENOVATIONS</span></div>
<div class="st-feats">
  <div><div class="ic g">⚡</div><h3>Live by default</h3><p>Every value is editable, every result reactive. Readers don’t just see your math — they can push on it.</p><a>Try the editor ›</a></div>
  <div><div class="ic b">🔗</div><h3>Share like a link</h3><p>The whole calc lives in the URL. Send it, embed it, fork it — versioned and attributed automatically.</p><a>See sharing ›</a></div>
  <div><div class="ic">🗂</div><h3>A gallery of 1,600+</h3><p>Mortgages, marathons, recipes, runway. Start from working math instead of a blank page.</p><a>Browse gallery ›</a></div>
</div>`;
    }
  });

  /* ============ 15. EXCEL — ribbon + grid, the familiar ============ */
  define({
    id: 'excel', name: 'The Grid', app: 'Excel', wire: 'topbar',
    note: 'Meets spreadsheet users where they live: ribbon, formula bar, editable cells with row/column headers, sheet tabs as multiple calcs.',
    css: `
.l-xl{font-size:13px;display:flex;flex-direction:column;height:100vh}
.l-xl .x-title{background:var(--color-header);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:14px;padding:7px 14px;font-size:12.5px}
.l-xl .x-title .doc{font-weight:600;font-family:'JetBrains Mono',monospace;font-size:12px}
.l-xl .x-title .save{color:var(--color-success)}
.l-xl .x-title .r{margin-left:auto;display:flex;gap:16px;color:var(--color-text-muted)}
.l-xl .x-ribbontabs{background:var(--color-header);display:flex;gap:2px;padding:4px 10px 0;font-size:12.5px;border-bottom:1px solid var(--color-border)}
.l-xl .x-ribbontabs span{padding:6px 12px;cursor:pointer;color:var(--color-text-muted);border-bottom:2px solid transparent}
.l-xl .x-ribbontabs span:hover{color:var(--color-text-main)}
.l-xl .x-ribbontabs span.on{color:var(--color-text-main);border-bottom-color:var(--color-accent-blue);font-weight:600}
.l-xl .x-ribbon{background:var(--color-bg);border-bottom:1px solid var(--color-border);display:flex;padding:6px 12px}
.l-xl .x-grp{display:flex;gap:8px;align-items:center;padding:0 16px;border-right:1px solid var(--color-border);flex-direction:column}
.l-xl .x-grp .btns{display:flex;gap:10px}
.l-xl .x-grp .b{text-align:center;font-size:11px;color:var(--color-text-muted);cursor:pointer;padding:3px 6px;border-radius:4px}
.l-xl .x-grp .b:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-xl .x-grp .b i{font-style:normal;display:block;font-size:16px}
.l-xl .x-grp .lbl{font-size:9px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.08em}
.l-xl .x-fbar{background:var(--color-bg);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:8px;padding:4px 10px;font-family:'JetBrains Mono',monospace;font-size:12px}
.l-xl .x-name{border:1px solid var(--color-border);border-radius:4px;padding:3px 10px;min-width:70px;color:var(--color-text-muted)}
.l-xl .x-fx{color:var(--color-text-muted);font-style:italic}
.l-xl .x-fexp{flex:1;border:1px solid var(--color-border);border-radius:4px;padding:3px 10px;background:var(--editor-bg)}
.l-xl .x-sheet{flex:1;overflow:auto;background:var(--editor-bg)}
.l-xl table{border-collapse:collapse;width:100%}
.l-xl th{background:var(--color-header);border:1px solid var(--color-border);color:var(--color-text-muted);font-weight:500;font-size:11px;padding:4px 8px;min-width:90px}
.l-xl th.rn{min-width:34px}
.l-xl td{border:1px solid var(--color-border);padding:4px 10px;font-size:13px;height:27px}
.l-xl td.rn{background:var(--color-header);color:var(--color-text-muted);text-align:center;font-size:11px;font-family:'JetBrains Mono',monospace}
.l-xl td.x-b{font-family:'JetBrains Mono',monospace;outline:none;min-width:280px}
.l-xl td.x-b:focus{box-shadow:inset 0 0 0 2px var(--color-accent-blue)}
.l-xl td.x-c{font-family:'JetBrains Mono',monospace;text-align:right;color:var(--color-success);font-weight:700;min-width:120px}
.l-xl td.x-lbl{color:var(--color-text-muted)}
.l-xl .x-tabs{background:var(--color-header);border-top:1px solid var(--color-border);display:flex;align-items:center;gap:2px;padding:0 10px}
.l-xl .x-tabs span{padding:6px 16px;font-size:12px;cursor:pointer;color:var(--color-text-muted);border-right:1px solid var(--color-border)}
.l-xl .x-tabs span:hover{color:var(--color-text-main)}
.l-xl .x-tabs span.on{color:var(--color-text-main);font-weight:600;box-shadow:inset 0 2px 0 var(--color-accent-blue)}
.l-xl .x-status{background:var(--color-header);border-top:1px solid var(--color-border);color:var(--color-text-muted);font-size:11px;padding:4px 14px;display:flex;gap:26px;font-family:'JetBrains Mono',monospace}
.l-xl .x-status .ok{color:var(--color-success)}`,
    render() {
      const lines = IC.DEMO.split('\n');
      const rows = lines.map((ln, i) => `
<tr><td class="rn">${i + 1}</td><td class="x-lbl">${ln.startsWith('#') ? '📝 note' : (ln.split('=')[0] || '').trim()}</td><td class="x-b" contenteditable="true" data-i="${i}">${esc(ln)}</td><td class="x-c" data-i="${i}"></td></tr>`).join('');
      return `
<div class="x-title">${BRAND()}<span class="doc">Party Budget.icalc</span><span class="save">⭳ AutoSave ✓</span><div class="r"><span>🔍 Search (Alt+Q)</span><span>Share ▾</span><span>👤 kalid</span></div></div>
<div class="x-ribbontabs"><span>File</span><span class="on">Home</span><span>Insert</span><span>Formulas</span><span>Data</span><span>Gallery</span><span>Share</span></div>
<div class="x-ribbon">
  <div class="x-grp"><div class="btns"><span class="b"><i>📋</i>Paste</span><span class="b"><i>✂️</i>Cut</span></div><span class="lbl">Clipboard</span></div>
  <div class="x-grp"><div class="btns"><span class="b"><i>𝐁</i>Bold</span><span class="b"><i>％</i>Percent</span><span class="b"><i>$</i>Currency</span><span class="b"><i>.00</i>Decimals</span></div><span class="lbl">Format</span></div>
  <div class="x-grp"><div class="btns"><span class="b"><i>∑</i>AutoSum</span><span class="b"><i>𝑓x</i>Function</span><span class="b"><i>📈</i>Chart</span></div><span class="lbl">Formulas</span></div>
  <div class="x-grp"><div class="btns"><span class="b"><i>🗂</i>Browse<br>Gallery</span><span class="b"><i>🔗</i>Share<br>Link</span><span class="b"><i>⑂</i>Remix</span></div><span class="lbl">InstaCalc</span></div>
</div>
<div class="x-fbar"><span class="x-name">B7</span><span class="x-fx">fx</span><span class="x-fexp" id="x-fexp">total = food + venue + music</span></div>
<div class="x-sheet"><table>
  <tr><th class="rn"></th><th>A — label</th><th>B — formula (editable)</th><th>C — result</th></tr>
  ${rows}
</table></div>
<div class="x-tabs"><span class="on">Party Budget</span><span>Mortgage</span><span>Trip Plan</span><span>＋</span></div>
<div class="x-status"><span class="ok">Ready</span><span id="x-sum">Sum: —</span><span>Live recalculation: ON</span><span style="margin-left:auto">100% ⊖—⊕</span></div>`;
    },
    init(root) {
      const bs = [...root.querySelectorAll('.x-b')];
      const run = () => {
        const res = IC.evalText(bs.map(b => b.textContent).join('\n'));
        let sum = 0, n = 0;
        res.forEach((r, i) => {
          const c = root.querySelector(`.x-c[data-i="${i}"]`);
          if (c) c.textContent = r.txt;
          const v = parseFloat(r.txt.replace(/,/g, '')); if (r.cls === 'r' && !isNaN(v)) { sum += v; n++; }
        });
        const s = root.querySelector('#x-sum'); if (s) s.textContent = 'Sum: ' + IC.fmt(sum) + ' · Count: ' + n;
      };
      bs.forEach(b => {
        b.addEventListener('input', run);
        b.addEventListener('focus', () => { const f = root.querySelector('#x-fexp'); if (f) f.textContent = b.textContent; });
      });
      run();
    }
  });

  /* ============ 16. FIGMA — canvas + panels ============ */
  define({
    id: 'figma', name: 'The Canvas', app: 'Figma', wire: 'split',
    note: 'Calc as an object on an infinite canvas: layers panel lists every line, properties panel controls format/units/decimals. Community tab = gallery.',
    css: `
.l-fg{font-size:12.5px;display:flex;flex-direction:column;height:100vh}
.l-fg .f-top{background:var(--color-header);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:4px;padding:6px 10px}
.l-fg .f-top .tool{padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer;color:var(--color-text-muted)}
.l-fg .f-top .tool:hover{color:var(--color-text-main);background:var(--color-surface-hover)}
.l-fg .f-top .tool.on{background:var(--color-accent-blue);color:#fff}
.l-fg .f-top .fname{margin:0 auto;font-size:12.5px}
.l-fg .f-top .fname span{color:var(--color-text-muted)}
.l-fg .f-top .avs{display:flex;margin-right:10px}
.l-fg .f-top .avs i{width:24px;height:24px;border-radius:50%;border:2px solid var(--color-header);background:var(--color-surface-hover);display:flex;align-items:center;justify-content:center;font-style:normal;font-size:10px;margin-left:-6px;font-weight:700}
.l-fg .f-cols{flex:1;display:grid;grid-template-columns:240px minmax(0,1fr) 250px;min-height:0}
.l-fg .f-left{background:var(--color-header);border-right:1px solid var(--color-border);padding:10px 0;overflow-y:auto}
.l-fg .f-left .tabs{display:flex;gap:14px;padding:0 14px 10px;color:var(--color-text-muted);font-weight:600}
.l-fg .f-left .tabs b{color:var(--color-text-main)}
.l-fg .f-left .pg{padding:5px 14px;color:var(--color-text-muted)}
.l-fg .f-left .pg.on{background:var(--tint-blue);color:var(--color-text-main)}
.l-fg .f-left h5{color:var(--color-text-muted);padding:12px 14px 4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.l-fg .f-left .ly{display:flex;gap:8px;padding:4px 14px 4px 26px;color:var(--color-text-muted);cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11.5px}
.l-fg .f-left .ly:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-fg .f-left .ly.on{background:var(--tint-blue);color:var(--color-text-main)}
.l-fg .f-canvas{background:var(--color-bg);background-image:radial-gradient(var(--color-border) 1px,transparent 1px);background-size:22px 22px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
.l-fg .f-frame{width:520px;background:var(--editor-bg);border-radius:10px;box-shadow:0 0 0 1.5px var(--color-accent-blue),var(--shadow);position:relative}
.l-fg .f-frame .fl{position:absolute;top:-22px;left:0;color:var(--color-accent-blue);font-size:11px;font-weight:600;font-family:'JetBrains Mono',monospace}
.l-fg .f-frame .hdl{position:absolute;width:8px;height:8px;background:var(--color-bg);border:1.5px solid var(--color-accent-blue);border-radius:2px}
.l-fg .f-frame .h1{top:-5px;left:-5px}.l-fg .f-frame .h2{top:-5px;right:-5px}.l-fg .f-frame .h3{bottom:-5px;left:-5px}.l-fg .f-frame .h4{bottom:-5px;right:-5px}
.l-fg .f-frame .cap{padding:14px 18px 0;font-weight:700;font-size:15px}
.l-fg .f-frame .ic-calc{border:0;background:transparent;padding:8px 18px 16px}
.l-fg .f-frame .ic-calc textarea{height:224px}
.l-fg .f-zoom{position:absolute;bottom:14px;right:16px;background:var(--color-header);border:1px solid var(--color-border);border-radius:6px;padding:5px 10px;color:var(--color-text-muted);font-family:'JetBrains Mono',monospace;font-size:11px}
.l-fg .f-right{background:var(--color-header);border-left:1px solid var(--color-border);padding:12px 14px;overflow-y:auto}
.l-fg .f-right .tabs{display:flex;gap:14px;color:var(--color-text-muted);font-weight:600;border-bottom:1px solid var(--color-border);padding-bottom:8px;margin-bottom:10px}
.l-fg .f-right .tabs b{color:var(--color-text-main)}
.l-fg .f-right h5{font-size:11px;margin:12px 0 8px;font-weight:700}
.l-fg .f-right .prop{display:flex;justify-content:space-between;align-items:center;padding:4px 0;color:var(--color-text-muted)}
.l-fg .f-right .prop .val{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:4px;padding:3px 8px;color:var(--color-text-main);min-width:74px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px}
.l-fg .f-right hr{border:0;border-top:1px solid var(--color-border);margin:12px 0}
.l-fg .f-right .sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:6px;background:var(--color-success)}`,
    render() {
      const layers = IC.DEMO.split('\n').map((l, i) => {
        const nm = l.startsWith('#') ? '💬 comment' : '𝑓 ' + (l.split('=')[0] || '').trim();
        return `<div class="ly ${i === 6 ? 'on' : ''}">${esc(nm)}</div>`;
      }).join('');
      return `
<div class="f-top">
  <span class="tool on">▢</span><span class="tool">▭</span><span class="tool">T</span><span class="tool">🖐</span><span class="tool">💬</span>
  <div class="fname">${BRAND()} <span>· Party Budget · Drafts</span></div>
  <div class="avs"><i>K</i><i>S</i><i>M</i></div>
  <span class="ic-btn blue">Share</span>
</div>
<div class="f-cols">
  <div class="f-left">
    <div class="tabs"><b>Layers</b><span>Assets</span><span>Community</span></div>
    <div class="pg on">📄 Party Budget</div><div class="pg">📄 Mortgage vs Rent</div><div class="pg">📄 Japan Trip</div>
    <h5>Lines</h5>${layers}
    <h5>Community</h5>
    <div class="ly">🗂 Browse 1,642 calc templates…</div>
  </div>
  <div class="f-canvas">
    <div class="f-frame">
      <span class="fl">party-budget / main</span>
      <i class="hdl h1"></i><i class="hdl h2"></i><i class="hdl h3"></i><i class="hdl h4"></i>
      <div class="cap">🎉 Party Budget</div>
      ${editor('bare')}
    </div>
    <div class="f-zoom">75% ▾</div>
  </div>
  <div class="f-right">
    <div class="tabs"><b>Design</b><span>Prototype</span><span>Comments</span></div>
    <h5>Selected: total</h5>
    <div class="prop"><span>Format</span><span class="val">Currency $</span></div>
    <div class="prop"><span>Decimals</span><span class="val">− 2 +</span></div>
    <div class="prop"><span>Units</span><span class="val">USD</span></div>
    <div class="prop"><span>Rounding</span><span class="val">Half up</span></div>
    <hr><h5>Result style</h5>
    <div class="prop"><span><span class="sw"></span>Accent</span><span class="val">00FF88</span></div>
    <div class="prop"><span>Weight</span><span class="val">Bold</span></div>
    <hr><h5>Export</h5>
    <div class="prop"><span>Share link</span><span class="val">Copy ↗</span></div>
    <div class="prop"><span>Embed</span><span class="val">&lt;iframe&gt;</span></div>
  </div>
</div>`;
    }
  });

  /* ============ 17. PINTEREST — the masonry wall ============ */
  define({
    id: 'pinterest', name: 'The Wall', app: 'Pinterest', wire: 'grid',
    note: 'Pure visual browse: masonry of calc “pins” at mixed sizes — some show working, some just the big answer. Save to boards = collections.',
    css: `
.l-pin .p-nav{display:flex;gap:6px}
.l-pin .p-nav span{padding:8px 16px;border-radius:999px;font-weight:600;font-size:14px;cursor:pointer;color:var(--color-text-muted)}
.l-pin .p-nav span:hover{color:var(--color-text-main)}
.l-pin .p-nav span.on{background:var(--color-accent);color:var(--color-bg)}
.l-pin .p-search{flex:1;border-radius:999px}
.l-pin .p-ico{font-size:18px;display:flex;gap:14px;color:var(--color-text-muted)}
.l-pin .p-wall{columns:5 236px;column-gap:16px;padding:16px 18px 60px}
.l-pin .pin{break-inside:avoid;margin-bottom:16px;cursor:pointer;position:relative}
.l-pin .pin .bd{border-radius:14px;padding:16px;position:relative;overflow:hidden;background:var(--color-header);border:1px solid var(--color-border)}
.l-pin .pin:hover .bd{border-color:var(--color-text-muted)}
.l-pin .pin .save{position:absolute;top:10px;right:10px;background:var(--color-accent);color:var(--color-bg);border:0;border-radius:999px;padding:7px 14px;font-weight:700;font-size:12px;opacity:0;transition:opacity .12s}
.l-pin .pin:hover .save{opacity:1}
.l-pin .pin .t{font-weight:600;font-size:13.5px;margin:8px 2px 2px}
.l-pin .pin .a{color:var(--color-text-muted);font-size:12px;margin-left:2px}
.l-pin .big{font-family:'JetBrains Mono',monospace}
.l-pin .big .q{font-size:11px;color:var(--color-text-muted);margin-bottom:8px}
.l-pin .big .v{font-size:28px;font-weight:700;color:var(--color-success)}
.l-pin .pin .cat{font-size:24px;margin-top:10px}
.l-pin .pin .live-cap{font-weight:700;font-size:13px;margin-bottom:8px}
.l-pin .pin .live-cap .lv{color:var(--color-success);font-size:10px;font-family:'JetBrains Mono',monospace;text-transform:uppercase;margin-left:6px}
.l-pin .pin .bd.live{border-color:var(--color-success)}
.l-pin .pin .live .ic-calc{border:0;padding:0;background:transparent}
.l-pin .pin .live .ic-calc textarea{height:196px;font-size:12px;line-height:24px}
.l-pin .pin .live .ic-out{line-height:24px;font-size:12px}`,
    render() {
      const pins = [];
      pins.push(`<div class="pin"><div class="bd live"><div class="live-cap">🎉 Party Budget<span class="lv">● live — tap to edit</span></div>${editor('bare')}</div><button class="save">Save</button><div class="t">Party Budget</div><div class="a">kazad · 18.3k uses</div></div>`);
      CALCS.forEach((c, i) => {
        const kind = i % 3;
        let body;
        if (kind === 0) body = `<div class="bd">${mini(c, 3)}</div>`;
        else if (kind === 1) body = `<div class="bd big"><div class="q">${esc(c.lines[0][0])} → …</div><div class="v">${esc(c.lines[2][1])}</div></div>`;
        else body = `<div class="bd">${mini(c, 2)}<div class="cat">${cat(c.cat).icon}</div></div>`;
        pins.push(`<div class="pin">${body}<button class="save">Save</button><div class="t">${esc(c.title)}</div><div class="a">${esc(c.author)} · ${c.uses} uses</div></div>`);
      });
      return `
<div class="ic-topbar">
  ${BRAND()}
  <div class="p-nav"><span class="on">Home</span><span>Explore</span><span>Create</span></div>
  <div class="ic-search p-search">🔍 <input placeholder="Search calcs — “wedding budget”, “pace”, “roi”…"></div>
  <div class="p-ico"><span>🔔</span><span>💬</span><span>👤</span></div>
</div>
<div class="p-wall">${pins.join('')}</div>`;
    }
  });

  /* ============ 18. APPLE — one product, one story ============ */
  define({
    id: 'apple', name: 'The Keynote', app: 'Apple', wire: 'canvas',
    note: 'Radical focus: huge type, one device frame, generous whitespace. The gallery appears only as a teaser band. Sells the feeling, not the features.',
    css: `
.l-ap .ap-nav{background:var(--color-header);border-bottom:1px solid var(--color-border);display:flex;justify-content:center;align-items:center;gap:38px;padding:12px 0;font-size:12.5px;color:var(--color-text-muted);position:sticky;top:0;z-index:10}
.l-ap .ap-nav span:hover{color:var(--color-text-main)}
.l-ap .ap-hero{text-align:center;padding:72px 20px 30px}
.l-ap .ap-hero .k{font-size:17px;color:var(--color-text-muted);font-weight:600}
.l-ap h1{font-size:60px;letter-spacing:-.03em;font-weight:800;margin:6px 0 8px}
.l-ap h1 em{font-style:normal;color:var(--color-success)}
.l-ap .ap-hero .sub{font-size:22px;color:var(--color-text-muted);font-weight:400}
.l-ap .ap-links{margin-top:16px;display:flex;gap:30px;justify-content:center;font-size:17px}
.l-ap .ap-links a{color:var(--color-accent-blue);text-decoration:none}
.l-ap .ap-links a:hover{text-decoration:underline}
.l-ap .ap-device{width:min(620px,92vw);margin:36px auto 0;background:var(--color-header);border:1px solid var(--color-border);border-radius:34px;padding:14px;box-shadow:var(--shadow)}
.l-ap .ap-screen{background:var(--editor-bg);border:1px solid var(--color-border);border-radius:22px;padding:20px 26px}
.l-ap .ap-screen .cap{font-weight:700;font-size:16px;margin-bottom:6px}
.l-ap .ap-screen .ic-calc{border:0;background:transparent;padding:0}
.l-ap .ap-screen .ic-calc textarea{height:224px;font-size:14.5px}
.l-ap .ap-band{background:var(--color-header);border-top:1px solid var(--color-border);margin-top:78px;padding:66px 20px;text-align:center}
.l-ap .ap-band h2{font-size:40px;letter-spacing:-.02em;margin-bottom:8px;font-weight:800}
.l-ap .ap-band .sub{color:var(--color-text-muted);font-size:18px;margin-bottom:34px}
.l-ap .ap-row{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;max-width:1050px;margin:0 auto}
.l-ap .ap-card{width:225px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:16px;padding:18px;text-align:left}
.l-ap .ap-card .ic-mini{font-size:10px}
.l-ap .ap-card b{display:block;font-size:14px;margin-top:12px}
.l-ap .ap-card span{color:var(--color-text-muted);font-size:12px}
.l-ap .ap-foot{color:var(--color-text-muted);font-size:12px;text-align:center;padding:26px}`,
    render() {
      const cards = CALCS.slice(0, 4).map(c => `
<div class="ap-card">${mini(c)}<b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div>`).join('');
      return `
<div class="ap-nav"><span></span>${BRAND()}<span>Gallery</span><span>Create</span><span>Templates</span><span>Learn</span><span>Support</span><span>🔍</span></div>
<div class="ap-hero">
  <div class="k">InstaCalc</div>
  <h1>Math, beautifully <em>shared</em>.</h1>
  <div class="sub">Type it. See it. Send it. The calculator that shows its work.</div>
  <div class="ap-links"><a>Try it free ›</a><a>Browse the gallery ›</a></div>
  <div class="ap-device"><div class="ap-screen"><div class="cap">🎉 Party Budget</div>${editor('bare')}</div></div>
</div>
<div class="ap-band">
  <h2>Gallery. 1,642 calcs strong.</h2>
  <div class="sub">Start from working math — remix anything.</div>
  <div class="ap-row">${cards}</div>
</div>
<div class="ap-foot">Copyright © 2026 InstaCalc. All results reserved.</div>`;
    }
  });

  /* ============ 19. SLACK — calcs where the conversation is ============ */
  define({
    id: 'slack', name: 'The Clubhouse', app: 'Slack', wire: 'both',
    note: 'Community-first: topic channels, calcs shared as unfurled live cards inside conversation, reactions as lightweight ratings.',
    css: `
.l-sl{display:grid;grid-template-columns:56px 240px minmax(0,1fr);height:100vh;font-size:13.5px}
.l-sl .sl-ws{background:var(--editor-bg);border-right:1px solid var(--color-border);display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 0}
.l-sl .sl-ws i{width:36px;height:36px;border-radius:10px;background:var(--color-surface-hover);border:1px solid var(--color-border);color:var(--color-text-muted);display:flex;align-items:center;justify-content:center;font-style:normal;font-weight:700;font-size:12px}
.l-sl .sl-ws i.on{background:var(--color-accent);color:var(--color-bg);border-color:var(--color-accent)}
.l-sl .sl-side{background:var(--color-header);border-right:1px solid var(--color-border);color:var(--color-text-muted);padding:14px 0;overflow-y:auto}
.l-sl .sl-side .wsname{color:var(--color-text-main);font-weight:800;font-size:15px;padding:0 16px 12px;letter-spacing:-.01em}
.l-sl .sl-side h4{padding:12px 16px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.l-sl .sl-side a{display:block;padding:4px 16px 4px 24px;color:var(--color-text-muted);text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12.5px}
.l-sl .sl-side a:hover{background:var(--color-surface-hover);color:var(--color-text-main)}
.l-sl .sl-side a.on{background:var(--tint-blue);color:var(--color-text-main);box-shadow:inset 2px 0 0 var(--color-accent-blue)}
.l-sl .sl-side a .n{background:var(--color-accent-blue);color:#fff;border-radius:999px;font-size:10px;padding:0 7px;float:right}
.l-sl .sl-main{display:flex;flex-direction:column;min-width:0}
.l-sl .sl-chead{border-bottom:1px solid var(--color-border);padding:10px 18px;display:flex;align-items:baseline;gap:12px;background:var(--color-header)}
.l-sl .sl-chead b{font-size:15px;font-family:'JetBrains Mono',monospace}
.l-sl .sl-chead span{color:var(--color-text-muted);font-size:12.5px}
.l-sl .sl-msgs{flex:1;overflow-y:auto;padding:14px 18px}
.l-sl .msg{display:flex;gap:10px;padding:7px 0}
.l-sl .msg .av{width:36px;height:36px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;background:var(--color-surface-hover);border:1px solid var(--color-border);color:var(--color-text-main);font-size:13px}
.l-sl .msg .who{font-weight:800}
.l-sl .msg .when{color:var(--color-text-muted);font-size:11px;margin-left:6px;font-family:'JetBrains Mono',monospace}
.l-sl .msg p{margin:2px 0 6px;line-height:1.45}
.l-sl .msg p .ch{color:var(--color-accent-blue);font-weight:600}
.l-sl .sl-card{border:1px solid var(--color-border);border-left:3px solid var(--color-accent-blue);border-radius:8px;max-width:480px;padding:12px 14px;background:var(--color-header)}
.l-sl .sl-card .cn{font-weight:700;color:var(--color-accent-blue);margin-bottom:2px}
.l-sl .sl-card .cs{color:var(--color-text-muted);font-size:12px;margin-bottom:8px;font-family:'JetBrains Mono',monospace}
.l-sl .sl-card .ic-calc textarea{height:170px;font-size:12.5px;line-height:25px}
.l-sl .sl-card .ic-out{line-height:25px;font-size:12.5px}
.l-sl .reacts{display:flex;gap:6px;margin-top:6px}
.l-sl .reacts span{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:999px;padding:2px 9px;font-size:11.5px;cursor:pointer;color:var(--color-text-muted)}
.l-sl .reacts span:hover{border-color:var(--color-accent-blue);color:var(--color-text-main)}
.l-sl .sl-input{margin:0 18px 18px;border:1px solid var(--color-border);border-radius:10px;padding:11px 14px;color:var(--color-text-muted);background:var(--editor-bg)}
.l-sl .sl-input b{float:right;color:var(--color-success)}`,
    render() {
      const chans = CATEGORIES.slice(0, 7).map((c, i) => `<a class="${i === 0 ? 'on' : ''}"># ${c.id}${i === 0 ? '<span class="n">3</span>' : ''}</a>`).join('');
      const m = (av, who, when, body) => `<div class="msg"><div class="av">${av}</div><div style="min-width:0"><span class="who">${who}</span><span class="when">${when}</span>${body}</div></div>`;
      const c2 = CALCS[0];
      return `
<div class="sl-ws"><i class="on">iC</i><i>W</i><i>＋</i></div>
<div class="sl-side">
  <div class="wsname">InstaCalc HQ ⌄</div>
  <a style="padding-left:16px;font-family:Inter,sans-serif">🧵 Threads</a><a style="padding-left:16px;font-family:Inter,sans-serif">📥 All DMs</a><a style="padding-left:16px;font-family:Inter,sans-serif">🗂 Gallery</a>
  <h4>▾ Channels</h4>${chans}<a>＋ add channels</a>
  <h4>▾ Direct messages</h4><a>● sarah_m</a><a>● mathfan42</a><a>○ chefdata</a>
</div>
<div class="sl-main">
  <div class="sl-chead"><b># finance</b><span>☆ 2,341 members · Money math: mortgages, loans, FIRE, and “can I afford this?”</span></div>
  <div class="sl-msgs">
    ${m('S', 'sarah_m', '10:42 AM', `<p>Rebuilt the mortgage payoff calc so extra payments are a single variable — try dragging it 👇</p>
      <div class="sl-card"><div class="cn">📐 ${esc(c2.title)}</div><div class="cs">instacalc.com/${c2.id} · live calc · ${c2.uses} uses</div>${mini(c2)}</div>
      <div class="reacts"><span>📊 12</span><span>🔥 8</span><span>🤯 3</span><span>＋</span></div>`)}
    ${m('K', 'kazad', '10:51 AM', `<p>Love it. Same trick works for event budgets — this one’s live, edit right here in the channel:</p>
      <div class="sl-card"><div class="cn">🎉 Party Budget</div><div class="cs">instacalc.com/party-budget · anyone can edit this preview</div>${editor('bare')}</div>
      <div class="reacts"><span>🎉 9</span><span>➗ 4</span><span>＋</span></div>`)}
    ${m('M', 'mathfan42', '11:02 AM', `<p>remixed it for potlucks → <span class="ch">#fun</span>. Reply in thread with your per-guest numbers 🧵 <span class="when">14 replies</span></p>`)}
  </div>
  <div class="sl-input">Message #finance — paste a calc link to unfurl it live… <b>＋ 🧮 Aa 😊 ↑</b></div>
</div>`;
    }
  });

  /* ============ 20. TIKTOK — one calc at a time ============ */
  define({
    id: 'tiktok', name: 'The Stream', app: 'TikTok', wire: 'full',
    note: 'Full-screen, one calc at a time, swipe to browse. Remix/like/share as first-class gestures. Gallery becomes a For-You feed of math.',
    css: `
.l-tk{background:var(--editor-bg);height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.l-tk .tk-top{position:absolute;top:16px;left:0;right:0;display:flex;justify-content:center;gap:22px;font-size:15px;font-weight:700;color:var(--color-text-muted);z-index:5}
.l-tk .tk-top b{color:var(--color-text-main);border-bottom:2px solid var(--color-accent-blue);padding-bottom:4px}
.l-tk .tk-phone{width:min(430px,92vw);height:min(760px,88vh);border-radius:22px;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:26px;background:var(--color-header);border:1px solid var(--color-border);box-shadow:var(--shadow)}
.l-tk .tk-slide{padding-right:64px}
.l-tk .tk-slide .cap{font-size:19px;font-weight:800;margin-bottom:10px;letter-spacing:-.01em}
.l-tk .tk-slide .ic-calc{border:0;background:transparent;padding:0}
.l-tk .tk-slide .ic-calc textarea{height:230px;font-size:14px}
.l-tk .tk-slide .ic-mini{font-size:13px;line-height:2.2}
.l-tk .tk-meta{position:absolute;left:22px;bottom:24px;right:90px;z-index:4}
.l-tk .tk-meta .who{font-weight:800;font-size:15px}
.l-tk .tk-meta .who .fol{border:1px solid var(--color-accent-blue);color:var(--color-accent-blue);border-radius:5px;font-size:11px;padding:1px 8px;margin-left:8px;vertical-align:2px}
.l-tk .tk-meta .dsc{font-size:13px;color:var(--color-text-muted);margin-top:4px;line-height:1.4}
.l-tk .tk-meta .frm{font-size:11.5px;color:var(--color-success);margin-top:6px;font-family:'JetBrains Mono',monospace}
.l-tk .tk-rail{position:absolute;right:14px;bottom:80px;display:flex;flex-direction:column;gap:16px;text-align:center;z-index:4;font-size:11px;font-weight:700}
.l-tk .tk-rail .b{cursor:pointer;color:var(--color-text-muted)}
.l-tk .tk-rail .b:hover{color:var(--color-text-main)}
.l-tk .tk-rail .b i{font-style:normal;display:block;font-size:22px;background:var(--color-surface-hover);border:1px solid var(--color-border);width:46px;height:46px;border-radius:50%;line-height:44px;margin:0 auto 4px}
.l-tk .tk-nav{position:absolute;right:-64px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px}
.l-tk .tk-nav button{width:44px;height:44px;border-radius:50%;border:1px solid var(--color-border);background:var(--color-surface-hover);color:var(--color-text-main);font-size:17px}
.l-tk .tk-nav button:hover{border-color:var(--color-text-muted)}
.l-tk .tk-count{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);color:var(--color-text-muted);font-size:11.5px;font-family:'JetBrains Mono',monospace}`,
    render() {
      return `
<div class="tk-top"><span>Following</span><b>For You</b><span>Gallery</span><span style="position:absolute;right:22px">🔍</span></div>
<div style="position:relative">
  <div class="tk-phone" id="tk-phone"></div>
  <div class="tk-nav"><button id="tk-up">↑</button><button id="tk-dn">↓</button></div>
</div>
<div class="tk-count" id="tk-count"></div>`;
    },
    init(root) {
      const feed = [{ live: true, title: '🎉 Party Budget', author: 'kazad', desc: 'POV: you volunteered to host 30 people. Edit the numbers — it’s live.', uses: '18.3k', comments: 41 },
        ...CALCS.map(c => ({ live: false, c, title: cat(c.cat).icon + ' ' + c.title, author: c.author, desc: c.desc, uses: c.uses, comments: c.comments }))];
      let i = 0;
      const phone = root.querySelector('#tk-phone'), count = root.querySelector('#tk-count');
      const show = () => {
        const f = feed[i];
        phone.innerHTML = `
<div class="tk-slide"><div class="cap">${f.title}</div>${f.live ? IC.editor('bare') : IC.mini(f.c)}</div>
<div class="tk-meta"><div class="who">@${esc(f.author)}<span class="fol">Follow</span></div>
  <div class="dsc">${esc(f.desc)}</div>
  <div class="frm">♫ formula · ${f.live ? 'total = food + venue + music' : esc(f.c.lines[2][0] + ' = ' + f.c.lines[2][1])}</div></div>
<div class="tk-rail">
  <div class="b"><i>❤️</i>${f.uses}</div><div class="b"><i>💬</i>${f.comments}</div><div class="b"><i>🔀</i>Remix</div><div class="b"><i>↗</i>Share</div>
</div>`;
        if (f.live) IC.bind(phone);
        count.textContent = `calc ${i + 1} of ${feed.length} — swipe ↑↓ to browse the For-You feed`;
      };
      root.querySelector('#tk-up').addEventListener('click', () => { i = (i - 1 + feed.length) % feed.length; show(); });
      root.querySelector('#tk-dn').addEventListener('click', () => { i = (i + 1) % feed.length; show(); });
      show();
    }
  });

})();
