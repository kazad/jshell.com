/* InstaCalc /evolve — layouts 1–10.
   Each borrows a familiar app's STRUCTURE only; the skin is today's
   InstaCalc/jshell theme (tokens in index.html, mirroring assets/tool.css). */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  const BRAND = (extra) => `<span class="ic-brand ${extra || ''}">Insta<span>Calc</span></span>`;

  /* ============ 1. GOOGLE — one box, zero chrome ============ */
  define({
    id: 'google', name: 'One Box', app: 'Google', wire: 'center',
    note: 'The homepage IS the calculator. One input, instant answer card, gallery demoted to trending links.',
    css: `
.l-google{display:flex;flex-direction:column}
.l-google .g-top{display:flex;justify-content:flex-end;align-items:center;gap:18px;padding:14px 22px;font-size:13px}
.l-google .g-top a{color:var(--color-text-muted);text-decoration:none}
.l-google .g-top a:hover{color:var(--color-text-main)}
.l-google .g-mid{flex:1;display:flex;flex-direction:column;align-items:center;padding-top:9vh}
.l-google .g-logo{font-size:58px;margin-bottom:30px}
.l-google .g-box{width:min(584px,90vw);display:flex;align-items:center;gap:12px;background:var(--editor-bg);border:1px solid var(--color-border);border-radius:12px;padding:13px 20px;transition:border-color .15s,box-shadow .15s}
.l-google .g-box:focus-within{border-color:var(--color-accent-blue);box-shadow:0 0 0 3px var(--tint-blue)}
.l-google .g-box input{flex:1;border:0;outline:0;background:transparent;font:15px/1.4 'JetBrains Mono',ui-monospace,monospace;color:var(--color-text-main)}
.l-google .g-box .mic{color:var(--color-text-muted)}
.l-google .g-card{width:min(584px,90vw);margin-top:16px;background:var(--color-header);border:1px solid var(--color-border);border-radius:12px;padding:18px 22px;text-align:right}
.l-google .g-card .g-expr{color:var(--color-text-muted);font:12px 'JetBrains Mono',monospace;margin-bottom:6px}
.l-google .g-card .g-val{font-size:34px;font-weight:700;color:var(--color-success);font-family:'JetBrains Mono',monospace}
.l-google .g-btns{margin-top:26px;display:flex;gap:12px}
.l-google .g-trend{margin-top:34px;font-size:13px;color:var(--color-text-muted)}
.l-google .g-trend a{color:var(--color-accent-blue);text-decoration:none;margin:0 8px}
.l-google .g-trend a:hover{text-decoration:underline}
.l-google .g-foot{background:var(--color-header);border-top:1px solid var(--color-border);color:var(--color-text-muted);font-size:12px;padding:12px 26px;display:flex;justify-content:space-between}
.l-google .g-foot a{color:var(--color-text-muted);text-decoration:none;margin-right:22px}`,
    render() {
      const trend = CALCS.slice(0, 4).map(c => `<a>${esc(c.title)}</a>`).join(' · ');
      return `
<div class="g-top"><a>Gallery</a><a>My Calcs</a><a>Docs</a><span class="ic-btn primary">Sign in</span></div>
<div class="g-mid">
  <div class="g-logo">${BRAND()}</div>
  <div class="g-box">🔍 <input id="g-in" value="30 guests * $18 + $250 venue + $120 music" spellcheck="false"> <span class="mic">🎲</span></div>
  <div class="g-card"><div class="g-expr" id="g-expr">30*18 + 250 + 120 =</div><div class="g-val" id="g-val">910</div></div>
  <div class="g-btns"><span class="ic-btn">Calculate</span><span class="ic-btn">I’m Feeling Lucky</span></div>
  <div class="g-trend">Trending: ${trend}</div>
</div>
<div class="g-foot"><div><a>About</a><a>How it works</a></div><div><a>Privacy</a><a>Terms</a><a>Settings</a></div></div>`;
    },
    init(root) {
      const inp = root.querySelector('#g-in'), val = root.querySelector('#g-val'), ex = root.querySelector('#g-expr');
      const run = () => {
        const raw = inp.value.replace(/(\d+)\s+[a-zA-Z]+/g, '$1').replace(/[a-zA-Z]+/g, '').trim();
        const r = IC.evalText(raw)[0] || { txt: '…' };
        val.textContent = r.txt; ex.textContent = raw + ' =';
      };
      inp.addEventListener('input', run); run();
    }
  });

  /* ============ 2. REDDIT — vote-ranked calc feed ============ */
  define({
    id: 'reddit', name: 'The Feed', app: 'Reddit', wire: 'both',
    note: 'Gallery becomes a ranked feed: upvotes, remix counts, topic communities (c/finance). Great for discovery, calc opens in place.',
    css: `
.l-reddit{font-size:14px}
.l-reddit .r-search{flex:1;max-width:640px}
.l-reddit .r-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-reddit .r-body{display:grid;grid-template-columns:210px minmax(0,660px) 300px;gap:22px;max-width:1240px;margin:20px auto;padding:0 16px}
.l-reddit .r-rail{font-size:13px}
.l-reddit .r-rail h4{font-size:10px;letter-spacing:.08em;color:var(--color-text-muted);text-transform:uppercase;margin:16px 0 6px 10px;font-weight:700}
.l-reddit .r-rail a{display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:6px;color:var(--color-text-main);text-decoration:none;border-left:2px solid transparent}
.l-reddit .r-rail a:hover{background:var(--color-surface-hover)}
.l-reddit .r-rail a.on{background:var(--color-surface-hover);border-left-color:var(--color-accent-blue);font-weight:600}
.l-reddit .r-post{display:flex;margin-bottom:12px;overflow:hidden}
.l-reddit .r-post:hover{border-color:var(--color-text-muted)}
.l-reddit .r-vote{width:42px;background:var(--color-header);padding:8px 0;text-align:center;color:var(--color-text-muted);font-weight:700;font-size:12px;border-right:1px solid var(--color-border)}
.l-reddit .r-vote .up:hover{color:var(--color-success);cursor:pointer}
.l-reddit .r-vote .dn:hover{color:var(--color-accent-blue);cursor:pointer}
.l-reddit .r-main{padding:10px 14px;flex:1;min-width:0}
.l-reddit .r-meta{font-size:12px;color:var(--color-text-muted);margin-bottom:4px}
.l-reddit .r-meta b{color:var(--color-text-main)}
.l-reddit .r-title{font-size:16px;font-weight:600;margin-bottom:8px}
.l-reddit .r-prev{background:var(--editor-bg);border:1px solid var(--color-border);border-radius:6px;padding:10px 12px;max-width:420px}
.l-reddit .r-foot{display:flex;gap:16px;margin-top:8px;font-size:12px;color:var(--color-text-muted);font-weight:600}
.l-reddit .r-foot span:hover{color:var(--color-text-main);cursor:pointer}
.l-reddit .r-side>div{background:var(--color-header);border:1px solid var(--color-border);border-radius:8px;padding:14px;margin-bottom:14px}
.l-reddit .r-side h3{font-size:14px;margin-bottom:8px;font-weight:700}
.l-reddit .r-side p{font-size:13px;color:var(--color-text-muted);line-height:1.55}
.l-reddit .r-side .ic-btn{display:flex;justify-content:center;margin-top:10px}
.l-reddit .r-open{padding:14px;margin-bottom:12px;background:var(--color-header)}
.l-reddit .r-open h3{font-size:15px;margin:2px 0 8px}
.l-reddit .r-open .ic-calc textarea{height:230px}`,
    render() {
      const rails = CATEGORIES.map((c, i) => `<a class="${i === 0 ? 'on' : ''}">${c.icon} c/${c.id}</a>`).join('');
      const posts = CALCS.slice(0, 6).map((c, i) => `
<div class="r-post ic-card">
  <div class="r-vote"><div class="up">▲</div>${(3400 - i * 412).toLocaleString()}<div class="dn">▼</div></div>
  <div class="r-main">
    <div class="r-meta"><b>c/${c.cat}</b> · Posted by u/${esc(c.author)} ${c.age} ago</div>
    <div class="r-title">${esc(c.title)}</div>
    <div class="r-prev">${mini(c)}</div>
    <div class="r-foot"><span>💬 ${c.comments} comments</span><span>🔀 remix (${Math.round(c.comments * 3.7)})</span><span>↗ share</span><span>☆ save</span></div>
  </div>
</div>`).join('');
      return `
<div class="ic-topbar">
  ${BRAND()}
  <div class="ic-search r-search">🔍 Search calculators, topics, people…</div>
  <div class="r-actions"><span class="ic-btn">Browse Gallery</span><span class="ic-btn primary">+ Create Calc</span><span style="font-size:18px">👤</span></div>
</div>
<div class="r-body">
  <div class="r-rail">
    <h4>Feeds</h4><a class="on">🏠 Home</a><a>🔥 Popular</a><a>🌐 All</a>
    <h4>Topics</h4>${rails}
  </div>
  <div>
    <div class="r-open ic-card">
      <div class="r-meta">✏️ Your draft · autosaved · <b>share when ready</b></div>
      <h3>🎉 ${IC.DEMO_TITLE}</h3>
      ${editor('')}
    </div>
    ${posts}
  </div>
  <div class="r-side">
    <div><h3>📐 About InstaCalc</h3><p>The calculator that shows its work. Build a calc in seconds, share it like a link, remix anyone’s math.</p><span class="ic-btn primary">Create Calc</span> <span class="ic-btn">Browse Gallery</span></div>
    <div><h3>📈 Trending today</h3><p>${CALCS.slice(6, 10).map(c => '· ' + esc(c.title)).join('<br>')}</p></div>
  </div>
</div>`;
    }
  });

  /* ============ 3. WIKIPEDIA — the reference work ============ */
  define({
    id: 'wikipedia', name: 'The Reference', app: 'Wikipedia', wire: 'doc',
    note: 'Every calc is a reference article: dense internal links, contents rail, live calc as the “infobox”. Authority through plainness.',
    css: `
.l-wiki .w-top{justify-content:flex-start}
.l-wiki .w-tag{color:var(--color-text-muted);font-size:12px}
.l-wiki .w-search{margin-left:auto;width:280px}
.l-wiki .w-cols{display:grid;grid-template-columns:186px minmax(0,1fr);max-width:1200px;margin:0 auto}
.l-wiki .w-nav{padding:20px 14px;font-size:12.5px;border-right:1px solid var(--color-border)}
.l-wiki .w-nav h4{color:var(--color-text-muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin:14px 0 4px;border-bottom:1px solid var(--color-border);padding-bottom:3px}
.l-wiki .w-nav a{display:block;color:var(--color-accent-blue);text-decoration:none;padding:2px 0}
.l-wiki .w-nav a:hover{text-decoration:underline}
.l-wiki .w-art{padding:20px 34px 60px}
.l-wiki .w-tabs{font-size:13px;border-bottom:1px solid var(--color-border);display:flex;margin-bottom:14px}
.l-wiki .w-tabs span{padding:8px 14px;color:var(--color-text-muted);cursor:pointer;border-bottom:2px solid transparent}
.l-wiki .w-tabs span.on{color:var(--color-text-main);border-bottom-color:var(--color-accent-blue);font-weight:600}
.l-wiki h1{font-weight:700;font-size:28px;letter-spacing:-.02em;border-bottom:1px solid var(--color-border);padding-bottom:8px;margin-bottom:8px}
.l-wiki .w-hat{font-style:italic;color:var(--color-text-muted);font-size:13px;margin-bottom:14px}
.l-wiki p{font-size:14.5px;line-height:1.65;margin-bottom:12px;max-width:64ch;color:var(--color-text-main)}
.l-wiki p a{color:var(--color-accent-blue);text-decoration:none}
.l-wiki p a:hover{text-decoration:underline}
.l-wiki .w-info{float:right;width:330px;margin:0 0 16px 26px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-header);font-size:12px;overflow:hidden}
.l-wiki .w-info .cap{background:var(--color-surface-hover);text-align:center;font-weight:700;padding:7px;font-size:12.5px;border-bottom:1px solid var(--color-border)}
.l-wiki .w-info .ic-calc{border:0;border-radius:0}
.l-wiki .w-info .ic-calc textarea{height:224px;font-size:12.5px}
.l-wiki .w-info .rowi{display:flex;justify-content:space-between;padding:5px 12px;border-top:1px solid var(--color-border);color:var(--color-text-muted)}
.l-wiki .w-info .rowi b{font-weight:600;color:var(--color-text-main)}
.l-wiki h2{font-weight:700;font-size:19px;border-bottom:1px solid var(--color-border);margin:22px 0 10px;padding-bottom:4px}
.l-wiki .w-see{font-size:13.5px;line-height:1.9;columns:2;max-width:60ch}
.l-wiki .w-see a{color:var(--color-accent-blue);text-decoration:none}`,
    render() {
      const nav = CATEGORIES.map(c => `<a>${c.name} (${c.count})</a>`).join('');
      const see = CALCS.slice(0, 8).map(c => `<div>• <a>${esc(c.title)}</a></div>`).join('');
      return `
<div class="ic-topbar w-top">
  <div>${BRAND()}<div class="w-tag">The free calculator library — 1,642 calcs and counting</div></div>
  <div class="ic-search w-search">🔍 <input placeholder="Search InstaCalc"></div>
</div>
<div class="w-cols">
  <div class="w-nav">
    <h4>Navigation</h4><a>Main page</a><a>Featured calcs</a><a>Random calc</a><a>Recent changes</a>
    <h4>Contents</h4>${nav}
    <h4>Tools</h4><a>Create a calc</a><a>My calcs</a><a>Cite this calc</a>
  </div>
  <div class="w-art">
    <div class="w-tabs"><span class="on">Calc</span><span>Discussion</span><span>Edit</span><span>History (14)</span></div>
    <h1>Party budget calculator</h1>
    <div class="w-hat">From InstaCalc, the calculator anyone can edit. Maintained by <a style="color:var(--color-accent-blue)">u/kazad</a>; last updated 3 hours ago.</div>
    <div class="w-info">
      <div class="cap">Party budget — live</div>
      ${editor('')}
      <div class="rowi"><span>Author</span><b>kazad</b></div>
      <div class="rowi"><span>Category</span><b>Everyday & Fun</b></div>
      <div class="rowi"><span>Uses</span><b>18,340</b></div>
      <div class="rowi"><span>Remixes</span><b>152</b></div>
    </div>
    <p>A <b>party budget calculator</b> estimates the total cost of hosting an event by combining <a>per-guest costs</a> with fixed expenses such as <a>venue rental</a> and <a>entertainment</a>. Edit any value in the infobox — every dependent line recalculates instantly.</p>
    <p>The model assumes cost scales linearly with attendance. For events above ~75 guests, consider the <a>Catering Tiers</a> remix, which introduces volume discounts. Related conventions include the <a>50/30/20 rule</a> for household budgeting and the <a>per-head metric</a> common in event planning.</p>
    <h2>See also</h2>
    <div class="w-see">${see}</div>
  </div>
</div>`;
    }
  });

  /* ============ 4. McMASTER-CARR — the dense catalog ============ */
  define({
    id: 'mcmaster', name: 'The Catalog', app: 'McMaster-Carr', wire: 'leftrail',
    note: 'Ruthless density and speed: every calc is a part with specs. Filter rail, instant search, zero decoration. For power users.',
    css: `
.l-mcm{font-size:13px}
.l-mcm .m-search{flex:1;max-width:560px}
.l-mcm .m-links{margin-left:auto;color:var(--color-text-muted);font-size:12px;display:flex;gap:14px}
.l-mcm .m-cols{display:grid;grid-template-columns:198px minmax(0,1fr)}
.l-mcm .m-rail{border-right:1px solid var(--color-border);padding:10px 0;min-height:calc(100vh - 45px)}
.l-mcm .m-rail h4{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);padding:10px 14px 4px;font-weight:700}
.l-mcm .m-rail a{display:flex;justify-content:space-between;padding:4px 14px;color:var(--color-accent-blue);text-decoration:none}
.l-mcm .m-rail a:hover{background:var(--color-surface-hover)}
.l-mcm .m-rail a i{color:var(--color-text-muted);font-style:normal;font-family:'JetBrains Mono',monospace;font-size:11px}
.l-mcm .m-main{padding:14px 22px}
.l-mcm .m-crumb{color:var(--color-text-muted);font-size:12px;margin-bottom:8px}
.l-mcm .m-title{font-size:18px;font-weight:700;margin-bottom:2px;letter-spacing:-.01em}
.l-mcm .m-sub{color:var(--color-text-muted);margin-bottom:12px}
.l-mcm table{border-collapse:collapse;width:100%}
.l-mcm th{background:var(--color-header);border:1px solid var(--color-border);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-muted);padding:6px 10px;text-align:left}
.l-mcm td{border:1px solid var(--color-border);padding:7px 10px;vertical-align:top}
.l-mcm tr:hover td{background:var(--color-surface-hover)}
.l-mcm td .nm{color:var(--color-accent-blue);font-weight:600;cursor:pointer}
.l-mcm td .nm:hover{text-decoration:underline}
.l-mcm td .ds{color:var(--color-text-muted);font-size:12px;margin-top:2px}
.l-mcm td .uses{font-family:'JetBrains Mono',monospace;font-size:12px}
.l-mcm .m-thumbcell{width:132px}
.l-mcm .m-thumbcell .ic-mini{font-size:9.5px;line-height:1.5}
.l-mcm .m-inline{border:1px solid var(--color-border);border-left:3px solid var(--color-success);border-radius:6px;margin-bottom:16px;overflow:hidden;background:var(--color-header)}
.l-mcm .m-inline .cap{background:var(--color-surface-hover);padding:6px 12px;font-weight:700;display:flex;justify-content:space-between;font-size:11px;letter-spacing:.05em}
.l-mcm .m-inline .cap .sku{color:var(--color-text-muted);font-family:'JetBrains Mono',monospace}
.l-mcm .m-inline .ic-calc{border:0;border-radius:0}
.l-mcm .m-inline .ic-calc textarea{height:200px;font-size:12.5px;line-height:25px}
.l-mcm .m-inline .ic-out{line-height:25px}`,
    render() {
      const rail = CATEGORIES.map(c => `<a>${c.name}<i>${c.count}</i></a>`).join('');
      const rows = CALCS.map(c => `
<tr>
  <td class="m-thumbcell">${mini(c, 2)}</td>
  <td><div class="nm">${esc(c.title)}</div><div class="ds">${esc(c.desc)}</div></td>
  <td>${cat(c.cat).name}</td>
  <td class="uses">${c.lines.length} in · 6 steps</td>
  <td class="uses">${c.uses}</td>
  <td class="uses">${c.rating} ★</td>
  <td><span class="ic-btn" style="font-size:11px;padding:2px 10px">Open</span></td>
</tr>`).join('');
      return `
<div class="ic-topbar">
  ${BRAND()}
  <div class="ic-search m-search"><input placeholder="Search 1,642 calculators (e.g. “mortgage”, “mpg”, “tip”)"><span class="ic-btn primary" style="margin:-3px -8px -3px 0">GO</span></div>
  <div class="m-links"><span>My Calcs</span><span>Help</span></div>
</div>
<div class="m-cols">
  <div class="m-rail"><h4>Browse by category</h4>${rail}<h4>Filter</h4><a>Live editable<i>1,204</i></a><a>With charts<i>318</i></a><a>Forkable<i>1,642</i></a></div>
  <div class="m-main">
    <div class="m-crumb">All calculators › Everyday & Fun › Events</div>
    <div class="m-title">Party Budget — open calc</div>
    <div class="m-sub">Spec it like a part: edit values below, results update in-line. Cert: shared-link reproducible.</div>
    <div class="m-inline"><div class="cap"><span>PARTY BUDGET, 30-GUEST, LIVE</span><span class="sku">SKU IC-18340</span></div>${editor('')}</div>
    <div class="m-title" style="font-size:15px">All calculators <span style="color:var(--color-text-muted);font-weight:400">(showing 16 of 1,642)</span></div>
    <table>
      <tr><th>Preview</th><th>Calculator</th><th>Category</th><th>Spec</th><th>Uses</th><th>Rating</th><th></th></tr>
      ${rows}
    </table>
  </div>
</div>`;
    }
  });

  /* ============ 5. AIRBNB — browse like you're booking ============ */
  define({
    id: 'airbnb', name: 'The Marketplace', app: 'Airbnb', wire: 'grid',
    note: 'Calcs as destinations: big friendly search pill, category chips, preview-forward cards with ratings and saves.',
    css: `
.l-abnb .a-pill{margin:0 auto;display:flex;align-items:center;background:var(--editor-bg);border:1px solid var(--color-border);border-radius:999px;overflow:hidden}
.l-abnb .a-pill:hover{border-color:var(--color-text-muted)}
.l-abnb .a-pill div{padding:9px 20px;font-size:12px;border-right:1px solid var(--color-border)}
.l-abnb .a-pill div b{display:block;font-size:12px}
.l-abnb .a-pill div span{color:var(--color-text-muted)}
.l-abnb .a-pill .go{border:0;background:var(--color-accent-blue);color:#fff;border-radius:999px;margin:5px;padding:8px 11px;font-weight:700}
.l-abnb .a-user{display:flex;gap:12px;align-items:center;font-size:13px;font-weight:600;margin-left:auto}
.l-abnb .a-chips{display:flex;gap:26px;padding:14px 40px;border-bottom:1px solid var(--color-border);overflow-x:auto}
.l-abnb .a-chip{text-align:center;font-size:12px;color:var(--color-text-muted);white-space:nowrap;padding-bottom:8px;border-bottom:2px solid transparent;cursor:pointer}
.l-abnb .a-chip:hover,.l-abnb .a-chip.on{color:var(--color-text-main);border-color:var(--color-accent-blue)}
.l-abnb .a-chip .i{font-size:20px;display:block;margin-bottom:4px}
.l-abnb .a-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:22px;padding:24px 40px 60px}
.l-abnb .a-card{cursor:pointer}
.l-abnb .a-card .ic-thumb{border-radius:12px;padding:18px;height:170px;display:flex;flex-direction:column;justify-content:center;position:relative}
.l-abnb .a-card:hover .ic-thumb{border-color:var(--color-text-muted)}
.l-abnb .ic-thumb .hrt{position:absolute;top:12px;right:14px;font-size:16px;opacity:.7}
.l-abnb .a-card .t{display:flex;justify-content:space-between;margin-top:10px;font-size:14px}
.l-abnb .a-card .t b{font-weight:600}
.l-abnb .a-card .t .rt{color:var(--color-text-muted)}
.l-abnb .a-card .s{color:var(--color-text-muted);font-size:13px}
.l-abnb .a-card .p{font-size:13px;margin-top:3px}
.l-abnb .a-card .p b{color:var(--color-success)}
.l-abnb .a-hero{margin:26px 40px 0;background:var(--color-header);border:1px solid var(--color-border);border-radius:14px;padding:22px 26px;display:grid;grid-template-columns:1.1fr 1fr;gap:30px;align-items:center}
.l-abnb .a-hero h2{font-size:22px;margin-bottom:8px;letter-spacing:-.01em}
.l-abnb .a-hero p{color:var(--color-text-muted);font-size:14px;line-height:1.55;max-width:44ch}
.l-abnb .a-hero .cta{margin-top:14px}
.l-abnb .a-hero .ic-calc{box-shadow:var(--shadow)}
.l-abnb .a-hero .ic-calc textarea{height:200px}`,
    render() {
      const chips = CATEGORIES.map((c, i) => `<div class="a-chip ${i === 0 ? 'on' : ''}"><span class="i">${c.icon}</span>${c.name}</div>`).join('');
      const cards = CALCS.slice(0, 8).map(c => `
<div class="a-card">
  ${thumb(c).replace('</div>', '<span class="hrt">🤍</span></div>')}
  <div class="t"><b>${esc(c.title)}</b><span class="rt">★ ${c.rating}</span></div>
  <div class="s">by ${esc(c.author)} · ${cat(c.cat).name}</div>
  <div class="p"><b>Free</b> · ${c.uses} uses</div>
</div>`).join('');
      return `
<div class="ic-topbar">
  ${BRAND()}
  <div class="a-pill"><div><b>What</b><span>Any calculation</span></div><div><b>Category</b><span>All categories</span></div><div><b>Level</b><span>Any complexity</span></div><button class="go">🔍</button></div>
  <div class="a-user"><span>Create a calc</span><span>🌐</span><span class="ic-btn">☰ 👤</span></div>
</div>
<div class="a-chips">${chips}</div>
<div class="a-hero">
  <div><h2>Try one right now</h2><p>Every calc is live — change a number, watch everything downstream update. When it’s right, share it like a link.</p><span class="ic-btn primary cta">Start from this template</span></div>
  ${editor('')}
</div>
<div class="a-grid">${cards}</div>`;
    }
  });

  /* ============ 6. CRAIGSLIST — the honest directory ============ */
  define({
    id: 'craigslist', name: 'The Directory', app: 'Craigslist', wire: 'list',
    note: 'Zero design as a feature: the entire gallery on one page as plain links. Fastest possible scan; nothing competes with the content.',
    css: `
.l-cl{font-size:13.5px;padding:18px 26px}
.l-cl .c-head{display:flex;align-items:baseline;gap:16px;margin-bottom:4px}
.l-cl .c-head span{color:var(--color-text-muted);font-size:12px}
.l-cl .c-search{margin:10px 0 16px;display:flex;gap:8px;align-items:center}
.l-cl .c-search .ic-search{width:300px}
.l-cl .c-search .note{color:var(--color-text-muted);font-size:12px}
.l-cl .c-cols{display:grid;grid-template-columns:repeat(4,1fr);gap:0 28px;max-width:1080px}
.l-cl h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);background:var(--color-surface-hover);padding:3px 8px;margin:12px 0 5px;border-radius:4px}
.l-cl li{list-style:none;line-height:1.65}
.l-cl a{color:var(--color-accent-blue);text-decoration:none}
.l-cl a:hover{text-decoration:underline}
.l-cl .c-note{color:var(--color-text-muted);font-size:11px;font-family:'JetBrains Mono',monospace}
.l-cl .c-open{font-weight:700;font-size:13px}
.l-cl .c-calc{max-width:520px;margin:6px 0 14px}
.l-cl .c-calc .ic-calc textarea{height:210px;font-size:13px;line-height:25px}
.l-cl .c-calc .ic-out{line-height:25px}
.l-cl .c-foot{margin-top:22px;color:var(--color-text-muted);font-size:12px}`,
    render() {
      const col = (catId) => {
        const c = cat(catId);
        const items = CALCS.filter(x => x.cat === catId);
        return `<h3>${c.name}</h3><ul>${items.map(x => `<li><a>${esc(x.title.toLowerCase())}</a> <span class="c-note">${x.uses}</span></li>`).join('')}<li><a>see all ${c.count} →</a></li></ul>`;
      };
      return `
<div class="c-head">${BRAND()}<span>calculators for everything · everywhere · free</span></div>
<div class="c-search"><div class="ic-search">🔍 <input placeholder="search calcs"></div><span class="ic-btn">go</span><span class="note">1,642 calcs · updated 3 min ago</span></div>
<span class="c-open">open calc: party budget</span> <span class="c-note">(edit numbers, share the url)</span>
<div class="c-calc">${IC.editor('')}</div>
<div class="c-cols">
  <div>${col('finance')}${col('cooking')}</div>
  <div>${col('business')}${col('travel')}</div>
  <div>${col('health')}${col('home')}</div>
  <div>${col('conversions')}${col('education')}${col('fun')}</div>
</div>
<div class="c-foot">© instacalc — <a>help</a> · <a>safety</a> · <a>privacy</a> · <a>feedback</a> · <a>make a calc</a></div>`;
    }
  });

  /* ============ 7. HACKER NEWS — ranked minimalism ============ */
  define({
    id: 'hn', name: 'The Ranking', app: 'Hacker News', wire: 'list',
    note: 'Pure ranked list with points and comments. The first item expands inline — using a calc never leaves the list.',
    css: `
.l-hn{font-size:13px}
.l-hn .h-bar{gap:10px}
.l-hn .h-bar a{color:var(--color-text-muted);text-decoration:none;font-size:12.5px}
.l-hn .h-bar a:hover{color:var(--color-text-main)}
.l-hn .h-bar .r{margin-left:auto}
.l-hn .h-list{max-width:880px;margin:0 auto;padding:12px 16px 40px}
.l-hn .h-item{display:flex;gap:6px;padding:3px 0;align-items:baseline}
.l-hn .h-rank{color:var(--color-text-muted);min-width:22px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px}
.l-hn .h-vote{color:var(--color-text-muted);cursor:pointer}
.l-hn .h-vote:hover{color:var(--color-success)}
.l-hn .h-title a{color:var(--color-text-main);text-decoration:none;font-size:13.5px;font-weight:500}
.l-hn .h-title a:hover{color:var(--color-accent-blue)}
.l-hn .h-title .dom{color:var(--color-text-muted);font-size:11px;font-family:'JetBrains Mono',monospace}
.l-hn .h-sub{color:var(--color-text-muted);font-size:11.5px;margin-left:28px;padding-bottom:4px}
.l-hn .h-sub a{color:var(--color-text-muted)}
.l-hn .h-sub a:hover{color:var(--color-text-main)}
.l-hn .h-embed{margin:6px 0 10px 28px;max-width:560px}
.l-hn .h-embed .ic-calc textarea{height:216px;font-size:12.5px;line-height:26px}
.l-hn .h-embed .ic-out{line-height:26px}
.l-hn .h-more{color:var(--color-text-muted);margin:12px 0 0 28px}
.l-hn .h-foot{border-top:1px solid var(--color-border);max-width:880px;margin:0 auto;padding:10px 16px;color:var(--color-text-muted);font-size:11.5px;text-align:center}`,
    render() {
      const show = `
<div class="h-item"><span class="h-rank">1.</span><span class="h-vote">▲</span>
  <span class="h-title"><a>Show iC: Party Budget — a live calc, editable right here</a> <span class="dom">(instacalc.com/party-budget)</span></span></div>
<div class="h-sub">417 points by kazad 3h ago | <a>flag</a> | <a>hide</a> | <a>212 comments</a> | <a>remix</a></div>
<div class="h-embed">${editor('')}</div>`;
      const items = show + CALCS.map((c, i) => {
        const pts = 341 - i * 17;
        return `
<div class="h-item"><span class="h-rank">${i + 2}.</span><span class="h-vote">▲</span>
  <span class="h-title"><a>${esc(c.title)}</a> <span class="dom">(instacalc.com/${c.id})</span></span></div>
<div class="h-sub">${pts} points by ${esc(c.author)} ${c.age} ago | <a>flag</a> | <a>hide</a> | <a>${c.comments} comments</a> | <a>remix</a></div>`;
      }).join('');
      return `
<div class="ic-topbar h-bar">${BRAND()}<a>new</a> | <a>top</a> | <a>show</a> | <a>gallery</a> | <a>submit calc</a><a class="r">login</a></div>
<div class="h-list">${items}<div class="h-more">More ›</div></div>
<div class="h-foot">Guidelines | FAQ | Lists | API | Search — applications open for InstaCalc batch W26</div>`;
    }
  });

  /* ============ 8. AMAZON — search + facets + trust signals ============ */
  define({
    id: 'amazon', name: 'The Superstore', app: 'Amazon', wire: 'both',
    note: 'Search-dominant with facet filters and heavy trust signals: ratings, usage counts, “used this month”. Calc gets a Buy-Box.',
    css: `
.l-amz{font-size:13.5px}
.l-amz .z-search{flex:1;display:flex;padding:0}
.l-amz .z-search select{border:0;border-right:1px solid var(--color-border);background:var(--color-surface-hover);color:var(--color-text-muted);padding:0 8px;font-size:12px;border-radius:6px 0 0 6px;outline:none}
.l-amz .z-search input{flex:1;border:0;padding:8px 12px;font-size:13px;outline:none;background:transparent;color:var(--color-text-main)}
.l-amz .z-search .zgo{border:0;background:var(--color-accent);color:var(--color-bg);padding:0 14px;border-radius:0 6px 6px 0;font-weight:700}
.l-amz .z-acct{font-size:11px;color:var(--color-text-muted);line-height:1.3}
.l-amz .z-acct b{color:var(--color-text-main);display:block;font-size:12px}
.l-amz .z-sub{background:var(--color-header);border-bottom:1px solid var(--color-border);color:var(--color-text-muted);display:flex;gap:18px;padding:7px 18px;font-size:12.5px}
.l-amz .z-sub b{color:var(--color-text-main)}
.l-amz .z-cols{display:grid;grid-template-columns:230px minmax(0,1fr)}
.l-amz .z-facets{padding:16px 18px;border-right:1px solid var(--color-border);font-size:13px}
.l-amz .z-facets h4{font-size:12px;margin:12px 0 6px;font-weight:700}
.l-amz .z-facets label{display:block;padding:2px 0;color:var(--color-text-muted)}
.l-amz .z-facets label:hover{color:var(--color-text-main)}
.l-amz .z-facets .stars{color:var(--color-success)}
.l-amz .z-res{padding:16px 24px}
.l-amz .z-count{color:var(--color-text-muted);font-size:12.5px;margin-bottom:10px}
.l-amz .z-count b{color:var(--color-text-main)}
.l-amz .z-row{display:grid;grid-template-columns:190px minmax(0,1fr) 200px;gap:18px;border-bottom:1px solid var(--color-border);padding:16px 0}
.l-amz .z-row .ic-thumb{border-radius:8px;height:130px;padding:14px;display:flex;align-items:center}
.l-amz .z-t{font-size:16px;color:var(--color-accent-blue);font-weight:600;cursor:pointer}
.l-amz .z-t:hover{text-decoration:underline}
.l-amz .z-stars{color:var(--color-success);font-size:12.5px}
.l-amz .z-stars span{color:var(--color-text-muted)}
.l-amz .z-used{color:var(--color-text-muted);font-size:12px}
.l-amz .z-bullets{color:var(--color-text-main);font-size:12.5px;margin-top:6px;line-height:1.55;opacity:.9}
.l-amz .z-buy{border:1px solid var(--color-border);border-radius:8px;padding:12px;background:var(--color-header);height:fit-content}
.l-amz .z-free{font-size:19px;font-weight:700;color:var(--color-success)}
.l-amz .z-inst{color:var(--color-text-muted);font-size:12px;margin:4px 0}
.l-amz .z-buy .ic-btn{width:100%;justify-content:center;margin-top:6px}
.l-amz .z-hero{margin:16px 24px 0;border:1px solid var(--color-border);border-left:3px solid var(--color-success);border-radius:8px;padding:12px 16px;background:var(--color-header)}
.l-amz .z-hero .cap{font-weight:700;margin-bottom:8px;font-size:13px}
.l-amz .z-hero .ic-calc textarea{height:104px;line-height:24px;font-size:13px}
.l-amz .z-hero .ic-out{line-height:24px}`,
    render() {
      const rows = CALCS.slice(0, 6).map(c => `
<div class="z-row">
  ${thumb(c)}
  <div>
    <div class="z-t">${esc(c.title)}</div>
    <div class="z-stars">★★★★☆ <span>${(c.comments * 27).toLocaleString()}</span></div>
    <div class="z-used">${c.uses}+ used this month · by ${esc(c.author)}</div>
    <div class="z-bullets">• ${esc(c.desc)}<br>• Live editing — results update as you type<br>• Share as a link, remix with one click</div>
  </div>
  <div class="z-buy"><div class="z-free">Free</div><div class="z-inst">Instant — runs in your browser</div><div class="z-used">Ships from: instacalc.com</div><span class="ic-btn primary">Use now</span><span class="ic-btn">Save to My Calcs</span></div>
</div>`).join('');
      return `
<div class="ic-topbar">
  ${BRAND()}
  <div class="z-acct">Deliver to<b>📍 Everyone, free</b></div>
  <div class="ic-search z-search"><select><option>All categories</option></select><input placeholder="Search calculators"><button class="zgo">🔍</button></div>
  <div class="z-acct">Hello, kalid<b>My Calcs & Lists</b></div>
  <div class="z-acct">Returns<b>& Remixes</b></div>
</div>
<div class="z-sub"><b>☰ All</b><span>Today's Featured</span><span>Finance</span><span>Health</span><span>Conversions</span><span>New Releases</span><span>Editor's Picks</span></div>
<div class="z-hero"><div class="cap">⚡ Keep working: Party Budget (opened 5 min ago)</div>${editor('', 'guests = 30\ncostPerPerson = 18\ntotal = guests * costPerPerson + 370\nperGuest = total / guests')}</div>
<div class="z-cols">
  <div class="z-facets">
    <h4>Category</h4>${CATEGORIES.slice(0, 6).map(c => `<label><input type="checkbox"> ${c.name}</label>`).join('')}
    <h4>Avg. rating</h4><label><span class="stars">★★★★</span> & up</label><label><span class="stars">★★★</span> & up</label>
    <h4>Complexity</h4><label><input type="checkbox"> Quick (≤5 lines)</label><label><input type="checkbox"> Standard</label><label><input type="checkbox"> Deep model</label>
  </div>
  <div class="z-res"><div class="z-count">1–6 of over 1,600 results for <b>"calculators"</b></div>${rows}</div>
</div>`;
    }
  });

  /* ============ 9. YOUTUBE — thumbnail grid + collapsible rail ============ */
  define({
    id: 'youtube', name: 'The Channel Grid', app: 'YouTube', wire: 'both',
    note: 'Calcs as videos: preview thumbnails with a “6 steps” badge, author channels, chips for topics. Subscriptions = follow calc authors.',
    css: `
.l-yt .y-burger{font-size:18px;color:var(--color-text-muted)}
.l-yt .y-search{flex:1;max-width:560px;margin:0 auto;border-radius:999px}
.l-yt .y-right{display:flex;gap:12px;align-items:center;font-size:14px}
.l-yt .y-body{display:grid;grid-template-columns:210px minmax(0,1fr)}
.l-yt .y-rail{padding:12px 8px;font-size:13.5px}
.l-yt .y-rail a{display:flex;gap:14px;align-items:center;padding:7px 14px;border-radius:8px;color:var(--color-text-main);text-decoration:none}
.l-yt .y-rail a.on,.l-yt .y-rail a:hover{background:var(--color-surface-hover)}
.l-yt .y-rail a.on{font-weight:600}
.l-yt .y-rail hr{border:0;border-top:1px solid var(--color-border);margin:10px 0}
.l-yt .y-rail h4{font-size:11px;color:var(--color-text-muted);padding:6px 14px;text-transform:uppercase;letter-spacing:.06em}
.l-yt .y-chips{display:flex;gap:10px;padding:10px 24px;overflow-x:auto}
.l-yt .y-chip{background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:8px;padding:5px 12px;font-size:12.5px;white-space:nowrap;cursor:pointer;color:var(--color-text-muted)}
.l-yt .y-chip:hover{color:var(--color-text-main)}
.l-yt .y-chip.on{background:var(--color-accent);color:var(--color-bg);border-color:var(--color-accent);font-weight:600}
.l-yt .y-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:22px 16px;padding:16px 24px 60px}
.l-yt .y-grid .ic-thumb{border-radius:12px;height:170px;padding:18px;display:flex;align-items:center;position:relative}
.l-yt .ic-thumb .len{position:absolute;bottom:8px;right:10px;background:rgba(0,0,0,.75);color:#fff;font-size:10px;padding:2px 5px;border-radius:4px;font-weight:600;font-family:'JetBrains Mono',monospace}
body.light-theme .l-yt .ic-thumb .len{background:rgba(0,0,0,.65)}
.l-yt .y-meta{display:flex;gap:12px;margin-top:10px}
.l-yt .y-av{width:36px;height:36px;border-radius:50%;background:var(--color-surface-hover);border:1px solid var(--color-border);color:var(--color-text-main);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
.l-yt .y-t{font-weight:600;font-size:14px;line-height:1.35}
.l-yt .y-s{color:var(--color-text-muted);font-size:12.5px;margin-top:3px}
.l-yt .y-player{margin:14px 24px 0;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px}
.l-yt .y-screen{background:var(--editor-bg);border:1px solid var(--color-border);border-radius:14px;padding:20px 24px}
.l-yt .y-screen .cap{font-weight:700;font-size:15px;margin-bottom:8px}
.l-yt .y-screen .cap .live{color:var(--color-success);font-size:11px;font-family:'JetBrains Mono',monospace;margin-left:8px;text-transform:uppercase}
.l-yt .y-screen .ic-calc{border:0;padding:0;background:transparent}
.l-yt .y-screen .ic-calc textarea{height:230px}
.l-yt .y-upnext{font-size:13px}
.l-yt .y-upnext h4{margin-bottom:8px;font-size:13px;font-weight:700}
.l-yt .y-nextrow{display:flex;gap:10px;margin-bottom:10px}
.l-yt .y-nextrow .ic-thumb{height:64px;width:112px;padding:8px;border-radius:8px;flex:none}
.l-yt .y-nextrow .ic-mini{font-size:7.5px;line-height:1.4}
.l-yt .y-nextrow b{font-size:12.5px;font-weight:600;display:block}
.l-yt .y-nextrow span{color:var(--color-text-muted);font-size:11.5px}`,
    render() {
      const chips = ['All', ...CATEGORIES.map(c => c.name)].map((n, i) => `<div class="y-chip ${i === 0 ? 'on' : ''}">${n}</div>`).join('');
      const cards = CALCS.slice(4, 12).map(c => `
<div>
  ${thumb(c).replace('</div>', `<span class="len">${c.lines.length * 2} steps</span></div>`)}
  <div class="y-meta"><div class="y-av">${esc(c.author[0].toUpperCase())}</div>
    <div><div class="y-t">${esc(c.title)}</div><div class="y-s">${esc(c.author)} · ${c.uses} uses · ${c.age} ago</div></div></div>
</div>`).join('');
      const next = CALCS.slice(0, 4).map(c => `
<div class="y-nextrow">${thumb(c)}<div><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div></div>`).join('');
      return `
<div class="ic-topbar">
  <span class="y-burger">☰</span>${BRAND()}
  <div class="ic-search y-search">🔍 <input placeholder="Search calcs"></div>
  <div class="y-right"><span class="ic-btn">+ Create</span><span>🔔</span><span>👤</span></div>
</div>
<div class="y-body">
  <div class="y-rail">
    <a class="on">🏠 Home</a><a>⚡ Quick calcs</a><a>📚 Subscriptions</a><hr>
    <a>🗂 My calcs</a><a>🕘 History</a><a>❤️ Saved</a><hr>
    <h4>Authors you follow</h4><a>Ⓢ sarah_m</a><a>Ⓚ kazad</a><a>Ⓜ mathfan42</a>
  </div>
  <div>
    <div class="y-player">
      <div class="y-screen"><div class="cap">▶ Party Budget <span class="live">● live — edit anything</span></div>${editor('bare')}</div>
      <div class="y-upnext"><h4>Up next</h4>${next}</div>
    </div>
    <div class="y-chips">${chips}</div>
    <div class="y-grid">${cards}</div>
  </div>
</div>`;
    }
  });

  /* ============ 10. SPOTIFY — shelves + now-playing bar ============ */
  define({
    id: 'spotify', name: 'The Shelves', app: 'Spotify', wire: 'both',
    note: 'Library with horizontal shelves (“Made for you”, “Trending”) and playlists as calc collections. The open calc lives in a persistent now-playing bar.',
    css: `
.l-sp{display:flex;flex-direction:column;height:100vh}
.l-sp .s-cols{flex:1;display:grid;grid-template-columns:230px minmax(0,1fr);min-height:0}
.l-sp .s-rail{background:var(--color-header);border-right:1px solid var(--color-border);padding:20px 12px;font-size:13.5px;overflow-y:auto}
.l-sp .s-logo{padding:0 12px 18px;font-size:18px}
.l-sp .s-rail a{display:flex;gap:14px;align-items:center;padding:7px 12px;color:var(--color-text-muted);text-decoration:none;font-weight:600;border-radius:6px}
.l-sp .s-rail a.on,.l-sp .s-rail a:hover{color:var(--color-text-main);background:var(--color-surface-hover)}
.l-sp .s-rail h4{color:var(--color-text-muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:18px 12px 6px}
.l-sp .s-rail .pl{font-weight:400;font-size:13px}
.l-sp .s-main{overflow-y:auto;padding:22px 28px 40px}
.l-sp .s-hi{font-size:24px;font-weight:800;margin-bottom:16px;letter-spacing:-.02em}
.l-sp .s-quick{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:28px}
.l-sp .s-qt{display:flex;align-items:center;gap:12px;background:var(--color-surface-hover);border:1px solid var(--color-border);border-radius:8px;overflow:hidden;font-weight:600;font-size:13px;cursor:pointer}
.l-sp .s-qt:hover{border-color:var(--color-text-muted)}
.l-sp .s-qt .qi{width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;flex:none;background:var(--color-header);border-right:1px solid var(--color-border)}
.l-sp h3{font-size:18px;font-weight:800;margin:8px 0 14px;letter-spacing:-.01em}
.l-sp .s-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:16px;margin-bottom:30px}
.l-sp .s-card{background:var(--color-header);border:1px solid var(--color-border);border-radius:8px;padding:14px;cursor:pointer;transition:border-color .15s}
.l-sp .s-card:hover{border-color:var(--color-text-muted)}
.l-sp .s-card .art{border-radius:6px;height:110px;padding:12px;display:flex;align-items:center;margin-bottom:10px;background:var(--editor-bg);border:1px solid var(--color-border);overflow:hidden}
.l-sp .s-card .ic-mini{font-size:8.5px;min-width:0;flex:1}
.l-sp .s-card b{font-size:13.5px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-sp .s-card span{color:var(--color-text-muted);font-size:12px}
.l-sp .s-now{background:var(--color-header);border-top:1px solid var(--color-border);display:grid;grid-template-columns:280px minmax(0,1fr) 280px;align-items:center;padding:10px 18px;gap:14px}
.l-sp .s-now .tr{display:flex;gap:12px;align-items:center;min-width:0}
.l-sp .s-now .tr .art{width:48px;height:48px;border-radius:6px;background:var(--color-surface-hover);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center;font-size:18px;flex:none}
.l-sp .s-now .tr b{font-size:13px;display:block}
.l-sp .s-now .tr span{color:var(--color-text-muted);font-size:11px;font-family:'JetBrains Mono',monospace}
.l-sp .s-now .lk{color:var(--color-success)}
.l-sp .s-ctrl{text-align:center;font-size:13px;color:var(--color-text-muted)}
.l-sp .s-ctrl .btns{font-size:16px;letter-spacing:14px;margin-bottom:5px;color:var(--color-text-main)}
.l-sp .s-ctrl .bar{height:4px;border-radius:2px;background:var(--color-border);position:relative;max-width:480px;margin:0 auto}
.l-sp .s-ctrl .bar i{position:absolute;left:0;top:0;bottom:0;width:62%;background:var(--color-success);border-radius:2px}
.l-sp .s-live{justify-self:end;width:280px;font-size:11px}
.l-sp .s-live .ic-calc{padding:6px 12px}
.l-sp .s-live .ic-calc textarea{height:56px;line-height:18px;font-size:11px}
.l-sp .s-live .ic-out{line-height:18px;font-size:11px}`,
    render() {
      const quick = CALCS.slice(0, 6).map(c => `<div class="s-qt"><div class="qi">${cat(c.cat).icon}</div>${esc(c.title)}</div>`).join('');
      const shelf = (list) => list.map(c => `
<div class="s-card"><div class="art">${mini(c)}</div><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div>`).join('');
      return `
<div class="s-cols">
  <div class="s-rail">
    <div class="s-logo">${BRAND()}</div>
    <a class="on">🏠 Home</a><a>🔍 Search</a><a>📚 Your Library</a>
    <h4>Your collections</h4>
    <a class="pl">🎉 Wedding planning</a><a class="pl">🏠 House hunt</a><a class="pl">🏃 Marathon prep</a><a class="pl">💼 Freelance ops</a><a class="pl">＋ New collection</a>
  </div>
  <div class="s-main">
    <div class="s-hi">Good afternoon</div>
    <div class="s-quick">${quick}</div>
    <h3>Made for you</h3><div class="s-shelf">${shelf(CALCS.slice(0, 5))}</div>
    <h3>Trending calculators</h3><div class="s-shelf">${shelf(CALCS.slice(5, 10))}</div>
  </div>
</div>
<div class="s-now">
  <div class="tr"><div class="art">🎉</div><div><b>Party Budget</b><span>kazad · total: $910 · per guest: $30.33</span></div><span class="lk">♥</span></div>
  <div class="s-ctrl"><div class="btns">⤮ ⏮ ▶ ⏭ ⟲</div><div class="bar"><i></i></div></div>
  <div class="s-live">${editor('', 'guests = 30\ntotal = guests*18 + 370')}</div>
</div>`;
    }
  });

})();
