/* InstaCalc /evolve — layouts 11–20 */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  /* ============ 11. NOTION — workspace of pages ============ */
  define({
    id: 'notion', name: 'The Workspace', app: 'Notion', wire: 'leftrail',
    note: 'Calcs as pages in a personal workspace: sidebar tree, breadcrumbs, blocks. Gallery is a linked database at the bottom of the page.',
    css: `
.l-no{background:#fff;color:#37352f;display:grid;grid-template-columns:250px minmax(0,1fr)}
.l-no .n-side{background:#f7f6f3;padding:10px 8px;font-size:14px;overflow-y:auto}
.l-no .n-ws{display:flex;align-items:center;gap:8px;font-weight:600;padding:6px 10px;border-radius:6px}
.l-no .n-ws:hover{background:#efeeea}
.l-no .n-side a{display:flex;gap:8px;align-items:center;padding:4px 10px;border-radius:6px;color:#5f5e5b;text-decoration:none;font-size:13.5px}
.l-no .n-side a:hover{background:#efeeea}
.l-no .n-side a.on{background:#efeeea;color:#37352f;font-weight:600}
.l-no .n-side h4{font-size:11px;color:#9b9a97;font-weight:600;padding:14px 10px 4px}
.l-no .n-side .sub{padding-left:26px}
.l-no .n-page{overflow-y:auto;height:100vh}
.l-no .n-crumb{display:flex;gap:6px;align-items:center;padding:12px 18px;font-size:13.5px;color:#5f5e5b;position:sticky;top:0;background:#fff}
.l-no .n-crumb .share{margin-left:auto;display:flex;gap:14px;color:#37352f}
.l-no .n-doc{max-width:720px;margin:0 auto;padding:26px 24px 80px}
.l-no .n-icon{font-size:64px}
.l-no h1{font-size:38px;font-weight:700;letter-spacing:-.02em;margin:8px 0 18px}
.l-no .n-callout{background:#f1f1ef;border-radius:6px;padding:14px 16px;display:flex;gap:12px;font-size:14.5px;margin-bottom:18px}
.l-no .n-calc{--icr:#0b6e99;border:1px solid #e9e9e7;border-radius:8px;padding:12px 16px;margin-bottom:8px}
.l-no .n-calc .ic-calc textarea{height:224px;font-size:14px}
.l-no .n-add{color:#9b9a97;font-size:14px;padding:6px 2px;margin-bottom:26px}
.l-no h2{font-size:22px;font-weight:650;margin:22px 0 6px}
.l-no .n-dbbar{display:flex;gap:14px;font-size:13.5px;color:#9b9a97;border-bottom:1px solid #e9e9e7;padding-bottom:6px;margin-bottom:2px}
.l-no .n-dbbar b{color:#37352f;font-weight:600;border-bottom:2px solid #37352f;padding-bottom:6px;margin-bottom:-7px}
.l-no table{width:100%;border-collapse:collapse;font-size:13.5px}
.l-no td,.l-no th{border-bottom:1px solid #e9e9e7;padding:7px 8px;text-align:left}
.l-no th{color:#9b9a97;font-weight:500;font-size:12.5px}
.l-no td .pg{font-weight:600}
.l-no .n-chip{background:#dbeddb;color:#1c3829;border-radius:3px;padding:1px 7px;font-size:12px}
.l-no .n-chip.f{background:#fdecc8;color:#402c1b}
.l-no .n-chip.h{background:#d3e5ef;color:#183347}`,
    render() {
      const rows = CALCS.slice(0, 7).map((c, i) => `
<tr><td class="pg">${cat(c.cat).icon} ${esc(c.title)}</td><td><span class="n-chip ${['', 'f', 'h'][i % 3]}">${cat(c.cat).name}</span></td><td>${esc(c.author)}</td><td>${c.uses}</td><td>${c.age} ago</td></tr>`).join('');
      return `
<div class="n-side">
  <div class="n-ws">🧮 Kalid’s InstaCalc <span style="color:#9b9a97">⌄</span></div>
  <a>🔍 Search</a><a>🕘 Updates</a><a>⚙️ Settings</a>
  <h4>My calcs</h4>
  <a class="on">🎉 Party Budget</a><a class="sub">🍕 Catering remix</a><a>🏠 Mortgage vs Rent</a><a>✈️ Japan trip</a>
  <h4>Shared</h4><a>👥 Team budget Q3</a><a>👥 Sprint velocity</a>
  <h4>Explore</h4><a>🗂 Gallery</a><a>📋 Templates</a><a>🗑 Trash</a>
</div>
<div class="n-page">
  <div class="n-crumb">🎉 Party Budget <span style="color:#c9c8c5">/</span> <span>My calcs</span><div class="share"><span>Share</span><span>💬</span><span>⭐</span><span>⋯</span></div></div>
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
.l-li{background:#0d0e10;color:#e2e2e4;font-size:13px;display:grid;grid-template-columns:220px minmax(0,1fr) 380px;height:100vh}
.l-li .li-rail{border-right:1px solid #1f2023;padding:14px 10px;overflow-y:auto}
.l-li .li-ws{display:flex;align-items:center;gap:8px;font-weight:600;padding:4px 8px 14px}
.l-li .li-ws .cube{width:18px;height:18px;border-radius:4px;background:linear-gradient(135deg,#5e6ad2,#26b5ce);display:inline-block}
.l-li .li-rail a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:#9d9da6;text-decoration:none}
.l-li .li-rail a:hover{background:#17181b;color:#e2e2e4}
.l-li .li-rail a.on{background:#1c1e22;color:#fff}
.l-li .li-rail a kbd{margin-left:auto;color:#5c5d66;font-size:10.5px;font-family:inherit}
.l-li .li-rail h4{color:#5c5d66;font-size:11px;padding:14px 8px 4px;font-weight:500}
.l-li .li-main{overflow-y:auto;border-right:1px solid #1f2023}
.l-li .li-tabs{display:flex;gap:2px;align-items:center;padding:10px 14px;border-bottom:1px solid #1f2023;position:sticky;top:0;background:#0d0e10;z-index:2}
.l-li .li-tabs span{padding:4px 10px;border-radius:6px;color:#9d9da6;cursor:pointer}
.l-li .li-tabs span.on{background:#1c1e22;color:#fff}
.l-li .li-tabs .fl{margin-left:auto;border:1px solid #2a2c31;border-radius:6px;padding:3px 9px;color:#9d9da6}
.l-li .li-row{display:flex;align-items:center;gap:10px;padding:7px 16px;border-bottom:1px solid #141518;cursor:pointer}
.l-li .li-row:hover{background:#121316}
.l-li .li-row.sel{background:#16181d}
.l-li .dot{width:9px;height:9px;border-radius:50%;flex:none}
.l-li .li-id{color:#5c5d66;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;width:70px;flex:none}
.l-li .li-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-li .li-chip{border:1px solid #2a2c31;border-radius:999px;padding:1px 8px;font-size:11px;color:#9d9da6;flex:none}
.l-li .li-a{color:#5c5d66;font-size:11.5px;flex:none;width:26px;height:26px;border-radius:50%;background:#1c1e22;display:flex;align-items:center;justify-content:center}
.l-li .li-age{color:#5c5d66;font-size:11.5px;width:26px;text-align:right}
.l-li .li-peek{padding:16px;overflow-y:auto}
.l-li .li-peek .ph{display:flex;gap:8px;align-items:center;color:#9d9da6;font-size:12px;margin-bottom:10px}
.l-li .li-peek h2{font-size:16px;color:#fff;margin-bottom:10px}
.l-li .li-peek .ic-calc{--icr:#4cb782;background:#101114;border:1px solid #1f2023;border-radius:8px;padding:10px 14px}
.l-li .li-peek .ic-calc textarea{height:224px;font-size:12.5px;line-height:26px}
.l-li .li-peek .ic-out{line-height:26px}
.l-li .li-props{margin-top:14px;font-size:12.5px;color:#9d9da6;line-height:2}
.l-li .li-props b{color:#e2e2e4;font-weight:500;margin-left:14px}
.l-li .li-k{position:fixed;left:50%;top:16%;transform:translateX(-50%);width:540px;background:#17181c;border:1px solid #2a2c31;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.7);z-index:50;overflow:hidden}
.l-li .li-k .ki{padding:13px 16px;border-bottom:1px solid #232529;color:#e2e2e4;font-size:14px}
.l-li .li-k .ki span{color:#5c5d66}
.l-li .li-k .kr{display:flex;gap:10px;padding:9px 16px;color:#c9c9cf;font-size:13px;align-items:center}
.l-li .li-k .kr:hover,.l-li .li-k .kr.on{background:#1f2127}
.l-li .li-k .kr kbd{margin-left:auto;color:#5c5d66;font-size:11px}`,
    render() {
      const cols = ['#4cb782', '#f2c94c', '#5e6ad2', '#eb5757', '#26b5ce'];
      const rows = CALCS.map((c, i) => `
<div class="li-row ${i === 1 ? 'sel' : ''}"><span class="dot" style="background:${cols[i % 5]}"></span><span class="li-id">CALC-${140 + i}</span><span class="li-t">${esc(c.title)}</span><span class="li-chip">${cat(c.cat).name}</span><span class="li-a">${esc(c.author[0].toUpperCase())}</span><span class="li-age">${c.age}</span></div>`).join('');
      return `
<div class="li-rail">
  <div class="li-ws"><span class="cube"></span> InstaCalc <span style="color:#5c5d66">⌄</span></div>
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
  <div class="li-props">Status<b>● Live</b><br>Owner<b>kazad</b><br>Collection<b>Events</b><br>Uses<b>18,340</b><br>Shared<b>public link</b></div>
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
.l-gh{background:#fff;color:#1f2328;font-size:14px}
.l-gh .gh-top{background:#f6f8fa;border-bottom:1px solid #d1d9e0;display:flex;align-items:center;gap:14px;padding:12px 20px}
.l-gh .gh-top .mark{font-size:22px}
.l-gh .gh-search{border:1px solid #d1d9e0;border-radius:6px;padding:5px 10px;color:#59636e;font-size:13px;width:300px;background:#fff}
.l-gh .gh-search kbd{float:right;border:1px solid #d1d9e0;border-radius:4px;padding:0 4px;font-size:11px}
.l-gh .gh-top nav{display:flex;gap:14px;font-size:13.5px;font-weight:600}
.l-gh .gh-head{padding:16px 24px 0}
.l-gh .gh-name{font-size:19px;display:flex;align-items:center;gap:8px}
.l-gh .gh-name a{color:#0969da;text-decoration:none}
.l-gh .gh-name .pub{border:1px solid #d1d9e0;border-radius:999px;font-size:11.5px;color:#59636e;padding:1px 8px;font-weight:500}
.l-gh .gh-acts{float:right;display:flex;gap:8px}
.l-gh .gh-acts button{border:1px solid #d1d9e0;background:#f6f8fa;border-radius:6px;padding:4px 12px;font-size:12.5px;font-weight:600;color:#24292f}
.l-gh .gh-acts button b{background:#e8ebef;border-radius:999px;padding:0 7px;margin-left:5px}
.l-gh .gh-tabs{display:flex;gap:6px;padding:10px 24px 0;border-bottom:1px solid #d1d9e0;margin-top:8px}
.l-gh .gh-tabs span{padding:8px 12px;font-size:13.5px;color:#59636e;border-bottom:2px solid transparent;cursor:pointer}
.l-gh .gh-tabs span.on{border-color:#fd8c73;color:#1f2328;font-weight:600}
.l-gh .gh-tabs b{background:#e8ebef;border-radius:999px;padding:0 7px;font-size:11.5px;font-weight:500}
.l-gh .gh-body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;padding:20px 24px 60px;max-width:1200px}
.l-gh .gh-file{border:1px solid #d1d9e0;border-radius:8px;overflow:hidden}
.l-gh .gh-file .fh{background:#f6f8fa;border-bottom:1px solid #d1d9e0;padding:9px 14px;font-size:12.5px;color:#59636e;display:flex;gap:10px}
.l-gh .gh-file .fh b{color:#1f2328}
.l-gh .gh-code{display:flex;--icr:#0969da}
.l-gh .gh-lines{padding:12px 0;color:#8c959f;text-align:right;font:12.5px/28px ui-monospace,Menlo,monospace;width:44px;flex:none;user-select:none;background:#fff}
.l-gh .gh-code .ic-calc{flex:1;padding:12px 16px 12px 10px}
.l-gh .gh-code .ic-calc textarea{height:224px;font-size:13px}
.l-gh .gh-readme{border:1px solid #d1d9e0;border-radius:8px;margin-top:18px;padding:20px 26px}
.l-gh .gh-readme h2{border-bottom:1px solid #d8dee4;padding-bottom:6px;margin-bottom:10px;font-size:20px}
.l-gh .gh-readme p{line-height:1.6;margin-bottom:10px;color:#1f2328}
.l-gh .gh-readme code{background:#f0f2f4;border-radius:4px;padding:1px 5px;font-size:12.5px}
.l-gh .gh-side h4{font-size:14px;margin-bottom:8px}
.l-gh .gh-side p{color:#59636e;font-size:13.5px;line-height:1.5;margin-bottom:10px}
.l-gh .gh-side .topics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.l-gh .gh-side .topics span{background:#ddf4ff;color:#0969da;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.l-gh .gh-side .stat{font-size:13px;color:#59636e;line-height:1.9}
.l-gh .gh-side .stat b{color:#1f2328}
.l-gh .gh-side hr{border:0;border-top:1px solid #d8dee4;margin:14px 0}
.l-gh .gh-forks{font-size:13px;line-height:1.9;color:#59636e}
.l-gh .gh-forks a{color:#0969da;text-decoration:none}`,
    render() {
      const forks = CALCS.slice(1, 5).map(c => `<div>⑂ <a>${esc(c.author)}/${c.id}-remix</a> · ${c.age} ago</div>`).join('');
      return `
<div class="gh-top"><span class="mark">🧮</span><div class="gh-search">🔍 Type <b>/</b> to search calcs… <kbd>/</kbd></div>
<nav><span>Gallery</span><span>Trending</span><span>My Calcs</span><span style="margin-left:auto">＋ ▾ &nbsp; 👤</span></nav></div>
<div class="gh-head">
  <div class="gh-acts"><button>👁 Watch<b>41</b></button><button>⑂ Remix<b>312</b></button><button>☆ Star<b>2.4k</b></button></div>
  <div class="gh-name">📐 <a>kazad</a> / <a><b>party-budget</b></a> <span class="pub">Public</span></div>
</div>
<div class="gh-tabs"><span class="on">🧮 Calc</span><span>📄 README</span><span>💬 Questions <b>12</b></span><span>⑂ Remixes <b>312</b></span><span>🕘 History <b>14</b></span><span>📊 Insights</span></div>
<div class="gh-body">
  <div>
    <div class="gh-file">
      <div class="fh"><b>party-budget.calc</b><span>8 lines · live</span><span style="margin-left:auto">Raw · Blame · ✏️</span></div>
      <div class="gh-code"><div class="gh-lines">1<br>2<br>3<br>4<br>5<br>6<br>7<br>8</div>${editor('')}</div>
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
    note: 'A real marketing homepage: gradient hero, floating live product demo, social proof, feature triplet. For the logged-out first impression.',
    css: `
.l-st{background:#fff;color:#0a2540;font-size:15px}
.l-st .st-nav{display:flex;align-items:center;gap:26px;padding:18px 48px;position:absolute;width:100%;z-index:5;color:#fff;font-weight:500;font-size:14.5px}
.l-st .st-nav .mark{font-weight:800;font-size:20px}
.l-st .st-nav .right{margin-left:auto;display:flex;gap:18px;align-items:center}
.l-st .st-nav .btn{background:rgba(255,255,255,.2);border-radius:999px;padding:6px 16px}
.l-st .st-hero{position:relative;padding:110px 48px 80px;overflow:hidden;background:linear-gradient(150deg,#635bff 0%,#8f6ed5 30%,#e86ca4 60%,#ffc078 100%);clip-path:polygon(0 0,100% 0,100% 88%,0 100%)}
.l-st .st-hero .in{max-width:1150px;margin:0 auto;display:grid;grid-template-columns:1.1fr 1fr;gap:50px;align-items:center}
.l-st h1{font-size:52px;line-height:1.06;letter-spacing:-.03em;font-weight:800;color:#fff;margin-bottom:18px}
.l-st .st-hero p{color:rgba(255,255,255,.9);font-size:17px;line-height:1.55;max-width:46ch;margin-bottom:22px}
.l-st .st-cta{display:flex;gap:10px}
.l-st .st-cta input{border:0;border-radius:999px;padding:12px 18px;width:260px;font-size:14px;outline:none}
.l-st .st-cta button{border:0;border-radius:999px;background:#0a2540;color:#fff;font-weight:600;padding:12px 22px;font-size:14px}
.l-st .st-demo{background:#fff;border-radius:14px;box-shadow:0 30px 60px -12px rgba(50,50,93,.35),0 18px 36px -18px rgba(0,0,0,.4);padding:18px 20px;transform:rotate(-1.2deg);--icr:#635bff}
.l-st .st-demo .cap{display:flex;gap:6px;margin-bottom:10px}
.l-st .st-demo .cap i{width:10px;height:10px;border-radius:50%;background:#e5e7ee;display:block}
.l-st .st-demo .ic-calc textarea{height:224px}
.l-st .st-logos{text-align:center;color:#697386;padding:34px 20px 10px;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.l-st .st-logorow{display:flex;gap:44px;justify-content:center;padding:16px 0 30px;font-weight:700;font-size:17px;color:#adbdcc}
.l-st .st-feats{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:40px;padding:30px 40px 80px}
.l-st .st-feats .ic{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;margin-bottom:12px}
.l-st .st-feats h3{font-size:17px;margin-bottom:8px}
.l-st .st-feats p{color:#425466;font-size:14.5px;line-height:1.6}
.l-st .st-feats a{color:#635bff;font-weight:600;text-decoration:none;font-size:14.5px}`,
    render() {
      return `
<div class="st-nav"><span class="mark">InstaCalc</span><span>Gallery</span><span>Templates</span><span>Docs</span><span>Pricing</span>
<div class="right"><span>Sign in</span><span class="btn">Start now ›</span></div></div>
<div class="st-hero"><div class="in">
  <div>
    <h1>Calculation infrastructure for everyday life</h1>
    <p>Millions of decisions come down to a little math. Build a live, shareable calculator in seconds — no spreadsheet, no signup, no formulas hidden in cells.</p>
    <div class="st-cta"><input placeholder="Email address"><button>Start calculating</button></div>
  </div>
  <div class="st-demo"><div class="cap"><i></i><i></i><i></i></div>${editor('')}</div>
</div></div>
<div class="st-logos">Trusted for the math behind</div>
<div class="st-logorow"><span>WEDDINGS</span><span>STARTUPS</span><span>ROAD TRIPS</span><span>CLASSROOMS</span><span>RENOVATIONS</span></div>
<div class="st-feats">
  <div><div class="ic" style="background:#635bff">⚡</div><h3>Live by default</h3><p>Every value is editable, every result reactive. Readers don’t just see your math — they can push on it.</p><a>Try the editor ›</a></div>
  <div><div class="ic" style="background:#00d4ff">🔗</div><h3>Share like a link</h3><p>The whole calc lives in the URL. Send it, embed it, fork it — versioned and attributed automatically.</p><a>See sharing ›</a></div>
  <div><div class="ic" style="background:#ff5996">🗂</div><h3>A gallery of 1,600+</h3><p>Mortgages, marathons, recipes, runway. Start from working math instead of a blank page.</p><a>Browse gallery ›</a></div>
</div>`;
    }
  });

  /* ============ 15. EXCEL — ribbon + grid, the familiar ============ */
  define({
    id: 'excel', name: 'The Grid', app: 'Excel', wire: 'topbar',
    note: 'Meets spreadsheet users where they live: ribbon, formula bar, editable cells with row/column headers, sheet tabs as multiple calcs.',
    css: `
.l-xl{background:#f3f2f1;color:#252423;font-size:13px;display:flex;flex-direction:column;height:100vh;font-family:'Segoe UI',system-ui,sans-serif}
.l-xl .x-title{background:#107c41;color:#fff;display:flex;align-items:center;gap:14px;padding:7px 14px;font-size:13px}
.l-xl .x-title .sq{background:#fff;color:#107c41;font-weight:800;border-radius:3px;padding:1px 6px}
.l-xl .x-title .doc{font-weight:600}
.l-xl .x-title .r{margin-left:auto;display:flex;gap:16px}
.l-xl .x-ribbontabs{background:#f3f2f1;display:flex;gap:2px;padding:4px 10px 0;font-size:12.5px}
.l-xl .x-ribbontabs span{padding:6px 12px;cursor:pointer;border-radius:4px 4px 0 0}
.l-xl .x-ribbontabs span.on{background:#fff;color:#107c41;font-weight:600;box-shadow:0 -1px 3px rgba(0,0,0,.08)}
.l-xl .x-ribbon{background:#fff;border-bottom:1px solid #e1dfdd;display:flex;gap:0;padding:6px 12px}
.l-xl .x-grp{display:flex;gap:8px;align-items:center;padding:0 16px;border-right:1px solid #eee;flex-direction:column}
.l-xl .x-grp .btns{display:flex;gap:10px}
.l-xl .x-grp .b{text-align:center;font-size:11.5px;color:#444;cursor:pointer;padding:3px 6px;border-radius:4px}
.l-xl .x-grp .b:hover{background:#f3f2f1}
.l-xl .x-grp .b i{font-style:normal;display:block;font-size:17px}
.l-xl .x-grp .lbl{font-size:10px;color:#888}
.l-xl .x-fbar{background:#fff;border-bottom:1px solid #e1dfdd;display:flex;align-items:center;gap:8px;padding:4px 10px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.l-xl .x-name{border:1px solid #e1dfdd;padding:3px 10px;min-width:70px;color:#444}
.l-xl .x-fx{color:#888;font-style:italic;font-family:serif}
.l-xl .x-fexp{flex:1;border:1px solid #e1dfdd;padding:3px 10px;color:#222}
.l-xl .x-sheet{flex:1;overflow:auto;background:#fff}
.l-xl table{border-collapse:collapse;width:100%}
.l-xl th{background:#f8f7f6;border:1px solid #e1dfdd;color:#666;font-weight:400;font-size:11.5px;padding:4px 8px;min-width:90px}
.l-xl th.rn{min-width:34px;background:#f8f7f6}
.l-xl td{border:1px solid #e8e7e6;padding:4px 10px;font-size:13px;height:26px}
.l-xl td.rn{background:#f8f7f6;color:#666;text-align:center;font-size:11.5px}
.l-xl td.x-b{font-family:ui-monospace,Menlo,monospace;outline:none;min-width:280px}
.l-xl td.x-b:focus{box-shadow:inset 0 0 0 2px #107c41}
.l-xl td.x-c{font-family:ui-monospace,Menlo,monospace;text-align:right;color:#107c41;font-weight:600;min-width:120px}
.l-xl td.x-lbl{color:#666}
.l-xl .x-tabs{background:#f3f2f1;border-top:1px solid #e1dfdd;display:flex;align-items:center;gap:2px;padding:0 10px}
.l-xl .x-tabs span{padding:6px 16px;font-size:12.5px;cursor:pointer;border-right:1px solid #e1dfdd}
.l-xl .x-tabs span.on{background:#fff;color:#107c41;font-weight:600;border-top:2px solid #107c41}
.l-xl .x-status{background:#107c41;color:#eaf6ee;font-size:11.5px;padding:3px 14px;display:flex;gap:26px}`,
    render() {
      const lines = IC.DEMO.split('\n');
      const rows = lines.map((ln, i) => `
<tr><td class="rn">${i + 1}</td><td class="x-lbl">${ln.startsWith('#') ? '📝 note' : (ln.split('=')[0] || '').trim()}</td><td class="x-b" contenteditable="true" data-i="${i}">${esc(ln)}</td><td class="x-c" data-i="${i}"></td></tr>`).join('');
      return `
<div class="x-title"><span class="sq">iC</span><span class="doc">Party Budget.icalc — InstaCalc 365</span><span style="opacity:.7">⭳ AutoSave ✓</span><div class="r"><span>🔍 Search (Alt+Q)</span><span>Share ▾</span><span>👤 kalid</span></div></div>
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
<div class="x-status"><span>Ready</span><span id="x-sum">Sum: —</span><span>Live recalculation: ON</span><span style="margin-left:auto">100% ⊖—⊕</span></div>`;
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
.l-fg{background:#1e1e1e;color:#d4d4d4;font-size:12px;display:flex;flex-direction:column;height:100vh}
.l-fg .f-top{background:#2c2c2c;display:flex;align-items:center;gap:4px;padding:6px 10px}
.l-fg .f-top .tool{padding:7px 10px;border-radius:6px;font-size:14px;cursor:pointer}
.l-fg .f-top .tool.on{background:#0d99ff}
.l-fg .f-top .fname{margin:0 auto;color:#fff;font-size:13px}
.l-fg .f-top .fname span{color:#888}
.l-fg .f-top .share{background:#0d99ff;color:#fff;border:0;border-radius:6px;padding:6px 14px;font-weight:600;font-size:12px}
.l-fg .f-top .avs{display:flex;margin-right:10px}
.l-fg .f-top .avs i{width:24px;height:24px;border-radius:50%;border:2px solid #2c2c2c;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:10px;margin-left:-6px;color:#fff}
.l-fg .f-cols{flex:1;display:grid;grid-template-columns:240px minmax(0,1fr) 250px;min-height:0}
.l-fg .f-left{background:#2c2c2c;padding:10px 0;overflow-y:auto}
.l-fg .f-left .tabs{display:flex;gap:14px;padding:0 14px 10px;color:#888;font-weight:600}
.l-fg .f-left .tabs b{color:#fff}
.l-fg .f-left .pg{padding:5px 14px;color:#bbb}
.l-fg .f-left .pg.on{background:#0d99ff22;color:#fff}
.l-fg .f-left h5{color:#777;padding:12px 14px 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
.l-fg .f-left .ly{display:flex;gap:8px;padding:4px 14px 4px 26px;color:#bbb;cursor:pointer}
.l-fg .f-left .ly:hover{background:#383838}
.l-fg .f-left .ly.on{background:#0d99ff33;color:#fff}
.l-fg .f-canvas{background:#1e1e1e;background-image:radial-gradient(#333 1px,transparent 1px);background-size:22px 22px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
.l-fg .f-frame{width:520px;background:#fff;color:#1e1e1e;border-radius:10px;box-shadow:0 0 0 1px #0d99ff,0 20px 60px rgba(0,0,0,.5);position:relative;--icr:#0d99ff}
.l-fg .f-frame .fl{position:absolute;top:-22px;left:0;color:#0d99ff;font-size:11px;font-weight:600}
.l-fg .f-frame .hdl{position:absolute;width:8px;height:8px;background:#fff;border:1.5px solid #0d99ff;border-radius:2px}
.l-fg .f-frame .h1{top:-5px;left:-5px}.l-fg .f-frame .h2{top:-5px;right:-5px}.l-fg .f-frame .h3{bottom:-5px;left:-5px}.l-fg .f-frame .h4{bottom:-5px;right:-5px}
.l-fg .f-frame .cap{padding:14px 18px 0;font-weight:700;font-size:16px}
.l-fg .f-frame .ic-calc{padding:8px 18px 16px}
.l-fg .f-frame .ic-calc textarea{height:224px}
.l-fg .f-zoom{position:absolute;bottom:14px;right:16px;background:#2c2c2c;border-radius:6px;padding:5px 10px;color:#bbb}
.l-fg .f-right{background:#2c2c2c;padding:12px 14px;overflow-y:auto}
.l-fg .f-right .tabs{display:flex;gap:14px;color:#888;font-weight:600;border-bottom:1px solid #3a3a3a;padding-bottom:8px;margin-bottom:10px}
.l-fg .f-right .tabs b{color:#fff}
.l-fg .f-right h5{color:#fff;font-size:11.5px;margin:12px 0 8px}
.l-fg .f-right .prop{display:flex;justify-content:space-between;align-items:center;padding:4px 0;color:#bbb}
.l-fg .f-right .prop .val{background:#383838;border-radius:4px;padding:3px 8px;color:#fff;min-width:74px;text-align:center}
.l-fg .f-right hr{border:0;border-top:1px solid #3a3a3a;margin:12px 0}
.l-fg .f-right .sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:6px}`,
    render() {
      const layers = IC.DEMO.split('\n').map((l, i) => {
        const nm = l.startsWith('#') ? '💬 comment' : '𝑓 ' + (l.split('=')[0] || '').trim();
        return `<div class="ly ${i === 6 ? 'on' : ''}">${esc(nm)}</div>`;
      }).join('');
      return `
<div class="f-top">
  <span class="tool on">▢</span><span class="tool">▭</span><span class="tool">T</span><span class="tool">🖐</span><span class="tool">💬</span>
  <div class="fname">Party Budget <span>· InstaCalc · Drafts</span></div>
  <div class="avs"><i style="background:#e86ca4">K</i><i style="background:#26b5ce">S</i><i style="background:#5e6ad2">M</i></div>
  <button class="share">Share</button>
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
      ${editor('')}
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
    <div class="prop"><span><span class="sw" style="background:#0d99ff"></span>Accent</span><span class="val">0D99FF</span></div>
    <div class="prop"><span>Weight</span><span class="val">Semibold</span></div>
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
.l-pin{background:#fff;color:#111}
.l-pin .p-top{position:sticky;top:0;z-index:10;background:#fff;display:flex;gap:14px;align-items:center;padding:12px 18px}
.l-pin .p-logo{color:#e60023;font-size:24px;font-weight:800}
.l-pin .p-nav{display:flex;gap:6px}
.l-pin .p-nav span{padding:10px 16px;border-radius:999px;font-weight:600;font-size:15px;cursor:pointer}
.l-pin .p-nav span.on{background:#111;color:#fff}
.l-pin .p-search{flex:1;background:#efefef;border-radius:999px;padding:12px 18px;color:#767676;font-size:15px}
.l-pin .p-ico{font-size:20px;display:flex;gap:14px}
.l-pin .p-wall{columns:5 236px;column-gap:16px;padding:14px 18px 60px}
.l-pin .pin{break-inside:avoid;margin-bottom:16px;cursor:pointer;position:relative}
.l-pin .pin .bd{border-radius:16px;padding:18px;position:relative;overflow:hidden}
.l-pin .pin .save{position:absolute;top:10px;right:10px;background:#e60023;color:#fff;border:0;border-radius:999px;padding:8px 14px;font-weight:700;font-size:13px;opacity:0;transition:opacity .12s}
.l-pin .pin:hover .save{opacity:1}
.l-pin .pin .t{font-weight:600;font-size:14px;margin:8px 2px 2px}
.l-pin .pin .a{color:#767676;font-size:12.5px;margin-left:2px}
.l-pin .big{font-family:ui-monospace,Menlo,monospace}
.l-pin .big .q{font-size:12px;opacity:.7;margin-bottom:8px}
.l-pin .big .v{font-size:30px;font-weight:700}
.l-pin .pin .live{--icr:#e60023}
.l-pin .pin .live .ic-calc textarea{height:196px;font-size:12px;line-height:24px}
.l-pin .pin .live .ic-out{line-height:24px;font-size:12px}`,
    render() {
      const pins = [];
      pins.push(`<div class="pin"><div class="bd live" style="background:#fff;border:2px solid #e60023"><div class="t" style="margin:0 0 8px">🎉 Party Budget — live, tap to edit</div>${editor('')}</div><button class="save">Save</button><div class="t">Party Budget</div><div class="a">kazad · 18.3k uses</div></div>`);
      CALCS.forEach((c, i) => {
        const kind = i % 3;
        let body;
        if (kind === 0) body = `<div class="bd" style="background:hsl(${c.hue},45%,93%);--icr:hsl(${c.hue},60%,32%)">${mini(c, 3)}</div>`;
        else if (kind === 1) body = `<div class="bd big" style="background:hsl(${c.hue},50%,20%);color:#fff"><div class="q">${esc(c.lines[0][0])} → …</div><div class="v">${esc(c.lines[2][1])}</div></div>`;
        else body = `<div class="bd" style="background:hsl(${c.hue},45%,90%);--icr:hsl(${c.hue},60%,30%)">${mini(c, 2)}<div style="font-size:26px;margin-top:10px">${cat(c.cat).icon}</div></div>`;
        pins.push(`<div class="pin">${body}<button class="save">Save</button><div class="t">${esc(c.title)}</div><div class="a">${esc(c.author)} · ${c.uses} uses</div></div>`);
      });
      return `
<div class="p-top">
  <span class="p-logo">◉</span>
  <div class="p-nav"><span class="on">Home</span><span>Explore</span><span>Create</span></div>
  <div class="p-search">🔍 Search calcs — “wedding budget”, “pace”, “roi”…</div>
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
.l-ap{background:#fff;color:#1d1d1f;font-family:-apple-system,'SF Pro Display','Helvetica Neue',sans-serif}
.l-ap .ap-nav{background:rgba(251,251,253,.92);backdrop-filter:blur(10px);display:flex;justify-content:center;gap:38px;padding:13px 0;font-size:12.5px;color:#424245;position:sticky;top:0;z-index:10}
.l-ap .ap-hero{text-align:center;padding:72px 20px 30px}
.l-ap .ap-hero .k{font-size:19px;color:#6e6e73;font-weight:600}
.l-ap h1{font-size:64px;letter-spacing:-.03em;font-weight:700;margin:6px 0 8px}
.l-ap .ap-hero .sub{font-size:24px;color:#6e6e73;font-weight:400}
.l-ap .ap-links{margin-top:16px;display:flex;gap:30px;justify-content:center;font-size:19px}
.l-ap .ap-links a{color:#0066cc;text-decoration:none}
.l-ap .ap-links a:hover{text-decoration:underline}
.l-ap .ap-device{width:min(620px,92vw);margin:36px auto 0;background:#000;border-radius:34px;padding:16px;box-shadow:0 24px 70px rgba(0,0,0,.24)}
.l-ap .ap-screen{background:#fff;border-radius:22px;padding:20px 26px;--icr:#0066cc}
.l-ap .ap-screen .cap{font-weight:700;font-size:17px;margin-bottom:6px}
.l-ap .ap-screen .ic-calc textarea{height:224px;font-size:14.5px}
.l-ap .ap-band{background:#000;color:#f5f5f7;margin-top:78px;padding:66px 20px;text-align:center}
.l-ap .ap-band h2{font-size:44px;letter-spacing:-.02em;margin-bottom:8px}
.l-ap .ap-band .sub{color:#86868b;font-size:20px;margin-bottom:34px}
.l-ap .ap-row{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;max-width:1050px;margin:0 auto}
.l-ap .ap-card{width:225px;background:#1d1d1f;border-radius:18px;padding:18px;text-align:left}
.l-ap .ap-card .ic-mini{font-size:10px}
.l-ap .ap-card b{display:block;font-size:15px;margin-top:12px}
.l-ap .ap-card span{color:#86868b;font-size:12.5px}
.l-ap .ap-foot{color:#86868b;font-size:12px;text-align:center;padding:26px}`,
    render() {
      const cards = CALCS.slice(0, 4).map(c => `
<div class="ap-card" style="--icr:hsl(${c.hue},65%,64%)">${mini(c)}<b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div>`).join('');
      return `
<div class="ap-nav"><span></span><span>InstaCalc</span><span>Gallery</span><span>Create</span><span>Templates</span><span>Learn</span><span>Support</span><span>🔍</span></div>
<div class="ap-hero">
  <div class="k">InstaCalc</div>
  <h1>Math, beautifully shared.</h1>
  <div class="sub">Type it. See it. Send it. The calculator that shows its work.</div>
  <div class="ap-links"><a>Try it free ›</a><a>Browse the gallery ›</a></div>
  <div class="ap-device"><div class="ap-screen"><div class="cap">🎉 Party Budget</div>${editor('')}</div></div>
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
.l-sl{display:grid;grid-template-columns:64px 240px minmax(0,1fr);height:100vh;font-size:14px;color:#1d1c1d;background:#fff}
.l-sl .sl-ws{background:#19171d;display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 0}
.l-sl .sl-ws i{width:38px;height:38px;border-radius:10px;background:#3f3d42;color:#fff;display:flex;align-items:center;justify-content:center;font-style:normal;font-weight:700}
.l-sl .sl-ws i.on{background:#fff;color:#3f0e40}
.l-sl .sl-side{background:#3f0e40;color:#cfc3cf;padding:14px 0;overflow-y:auto}
.l-sl .sl-side .wsname{color:#fff;font-weight:800;font-size:16px;padding:0 16px 12px}
.l-sl .sl-side h4{padding:12px 16px 4px;font-size:13px;color:#bcabbc}
.l-sl .sl-side a{display:block;padding:4px 16px 4px 24px;color:#cfc3cf;text-decoration:none;border-radius:0}
.l-sl .sl-side a:hover{background:#350d36}
.l-sl .sl-side a.on{background:#1164a3;color:#fff}
.l-sl .sl-side a .n{background:#cd2553;color:#fff;border-radius:999px;font-size:11px;padding:0 7px;float:right}
.l-sl .sl-main{display:flex;flex-direction:column;min-width:0}
.l-sl .sl-chead{border-bottom:1px solid #e2e2e2;padding:10px 18px;display:flex;align-items:baseline;gap:12px}
.l-sl .sl-chead b{font-size:17px}
.l-sl .sl-chead span{color:#616061;font-size:13px}
.l-sl .sl-msgs{flex:1;overflow-y:auto;padding:14px 18px}
.l-sl .msg{display:flex;gap:10px;padding:7px 0}
.l-sl .msg .av{width:38px;height:38px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}
.l-sl .msg .who{font-weight:800}
.l-sl .msg .when{color:#616061;font-size:12px;margin-left:6px}
.l-sl .msg p{margin:2px 0 6px;line-height:1.45}
.l-sl .sl-card{border:1px solid #e2e2e2;border-left:4px solid #1164a3;border-radius:8px;max-width:480px;padding:12px 14px}
.l-sl .sl-card .cn{font-weight:800;color:#1264a3;margin-bottom:2px}
.l-sl .sl-card .cs{color:#616061;font-size:12.5px;margin-bottom:8px}
.l-sl .sl-card .ic-calc{--icr:#007a5a}
.l-sl .sl-card .ic-calc textarea{height:170px;font-size:12.5px;line-height:25px}
.l-sl .sl-card .ic-out{line-height:25px;font-size:12.5px}
.l-sl .sl-card.mini{--icr:#007a5a}
.l-sl .reacts{display:flex;gap:6px;margin-top:6px}
.l-sl .reacts span{background:#f8f8f8;border:1px solid #e2e2e2;border-radius:999px;padding:2px 9px;font-size:12px;cursor:pointer}
.l-sl .reacts span:hover{border-color:#1264a3}
.l-sl .sl-input{margin:0 18px 18px;border:1px solid #8d8d8d;border-radius:10px;padding:11px 14px;color:#616061}
.l-sl .sl-input b{float:right;color:#007a5a}`,
    render() {
      const chans = CATEGORIES.slice(0, 7).map((c, i) => `<a class="${i === 0 ? 'on' : ''}"># ${c.id}${i === 0 ? '<span class="n">3</span>' : ''}</a>`).join('');
      const m = (av, col, who, when, body) => `<div class="msg"><div class="av" style="background:${col}">${av}</div><div style="min-width:0"><span class="who">${who}</span><span class="when">${when}</span>${body}</div></div>`;
      const c2 = CALCS[0];
      return `
<div class="sl-ws"><i class="on">iC</i><i>W</i><i>＋</i></div>
<div class="sl-side">
  <div class="wsname">InstaCalc HQ ⌄</div>
  <a style="padding-left:16px">🧵 Threads</a><a style="padding-left:16px">📥 All DMs</a><a style="padding-left:16px">🗂 Gallery</a>
  <h4>▾ Channels</h4>${chans}<a>＋ Add channels</a>
  <h4>▾ Direct messages</h4><a>● sarah_m</a><a>● mathfan42</a><a>○ chefdata</a>
</div>
<div class="sl-main">
  <div class="sl-chead"><b># finance</b><span>☆ 2,341 members · Money math: mortgages, loans, FIRE, and “can I afford this?”</span></div>
  <div class="sl-msgs">
    ${m('S', '#e86ca4', 'sarah_m', '10:42 AM', `<p>Rebuilt the mortgage payoff calc so extra payments are a single variable — try dragging it 👇</p>
      <div class="sl-card mini"><div class="cn">📐 ${esc(c2.title)}</div><div class="cs">instacalc.com/${c2.id} · live calc · ${c2.uses} uses</div>${mini(c2)}</div>
      <div class="reacts"><span>📊 12</span><span>🔥 8</span><span>🤯 3</span><span>＋</span></div>`)}
    ${m('K', '#1164a3', 'kazad', '10:51 AM', `<p>Love it. Same trick works for event budgets — this one’s live, edit right here in the channel:</p>
      <div class="sl-card"><div class="cn">🎉 Party Budget</div><div class="cs">instacalc.com/party-budget · anyone can edit this preview</div>${editor('')}</div>
      <div class="reacts"><span>🎉 9</span><span>➗ 4</span><span>＋</span></div>`)}
    ${m('M', '#5e6ad2', 'mathfan42', '11:02 AM', `<p>remixed it for potlucks → <b>#fun</b>. Reply in thread with your per-guest numbers 🧵 <span class="when">14 replies</span></p>`)}
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
.l-tk{background:#000;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.l-tk .tk-top{position:absolute;top:16px;left:0;right:0;display:flex;justify-content:center;gap:22px;font-size:16px;font-weight:700;color:#aaa;z-index:5}
.l-tk .tk-top b{color:#fff;border-bottom:2px solid #fff;padding-bottom:4px}
.l-tk .tk-phone{width:min(430px,92vw);height:min(760px,88vh);border-radius:22px;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:26px}
.l-tk .tk-slide{padding-right:64px}
.l-tk .tk-slide .cap{font-size:20px;font-weight:800;margin-bottom:10px}
.l-tk .tk-slide .ic-calc textarea{height:230px;font-size:14px}
.l-tk .tk-slide .ic-mini{font-size:14px;line-height:2.2}
.l-tk .tk-meta{position:absolute;left:22px;bottom:24px;right:90px;z-index:4}
.l-tk .tk-meta .who{font-weight:800;font-size:16px}
.l-tk .tk-meta .who .fol{border:1px solid #fff;border-radius:4px;font-size:12px;padding:1px 8px;margin-left:8px;vertical-align:2px}
.l-tk .tk-meta .dsc{font-size:13.5px;color:#ddd;margin-top:4px;line-height:1.4}
.l-tk .tk-meta .frm{font-size:12.5px;color:#bbb;margin-top:6px;font-family:ui-monospace,Menlo,monospace}
.l-tk .tk-rail{position:absolute;right:14px;bottom:80px;display:flex;flex-direction:column;gap:18px;text-align:center;z-index:4;font-size:12px;font-weight:700}
.l-tk .tk-rail .b{cursor:pointer}
.l-tk .tk-rail .b i{font-style:normal;display:block;font-size:26px;background:rgba(255,255,255,.14);width:48px;height:48px;border-radius:50%;line-height:48px;margin:0 auto 4px}
.l-tk .tk-nav{position:absolute;right:-64px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px}
.l-tk .tk-nav button{width:44px;height:44px;border-radius:50%;border:0;background:#1c1c1c;color:#fff;font-size:18px}
.l-tk .tk-nav button:hover{background:#333}
.l-tk .tk-count{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);color:#888;font-size:12px}`,
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
      const feed = [{ live: true, title: '🎉 Party Budget', author: 'kazad', desc: 'POV: you volunteered to host 30 people. Edit the numbers — it’s live.', hue: 262, uses: '18.3k', comments: 41 },
        ...CALCS.map(c => ({ live: false, c, title: cat(c.cat).icon + ' ' + c.title, author: c.author, desc: c.desc, hue: c.hue, uses: c.uses, comments: c.comments }))];
      let i = 0;
      const phone = root.querySelector('#tk-phone'), count = root.querySelector('#tk-count');
      const show = () => {
        const f = feed[i];
        phone.style.background = `linear-gradient(160deg,hsl(${f.hue},45%,22%),hsl(${f.hue},60%,10%))`;
        phone.style.setProperty('--icr', `hsl(${f.hue},70%,70%)`);
        phone.innerHTML = `
<div class="tk-slide"><div class="cap">${f.title}</div>${f.live ? IC.editor('') : IC.mini(f.c)}</div>
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
