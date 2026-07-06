/* InstaCalc /evolve — layouts 1–10 */
(function () {
  const { esc, mini, thumb, editor, CALCS, CATEGORIES, cat, define } = IC;

  /* ============ 1. GOOGLE — one box, zero chrome ============ */
  define({
    id: 'google', name: 'One Box', app: 'Google', wire: 'center',
    note: 'The homepage IS the calculator. One input, instant answer card, gallery demoted to trending links.',
    css: `
.l-google{background:#fff;color:#202124;display:flex;flex-direction:column}
.l-google .g-top{display:flex;justify-content:flex-end;gap:18px;padding:16px 22px;font-size:13px}
.l-google .g-top a{color:#202124;text-decoration:none}
.l-google .g-top a:hover{text-decoration:underline}
.l-google .g-top .g-btn{background:#1a73e8;color:#fff;padding:8px 16px;border-radius:5px;font-weight:500}
.l-google .g-mid{flex:1;display:flex;flex-direction:column;align-items:center;padding-top:9vh}
.l-google .g-logo{font-size:64px;font-weight:600;letter-spacing:-2px;margin-bottom:28px}
.l-google .g-logo .c1{color:#4285f4}.l-google .g-logo .c2{color:#ea4335}.l-google .g-logo .c3{color:#fbbc05}.l-google .g-logo .c4{color:#34a853}
.l-google .g-box{width:min(584px,90vw);display:flex;align-items:center;gap:12px;border:1px solid #dfe1e5;border-radius:24px;padding:12px 20px;box-shadow:none;transition:box-shadow .15s}
.l-google .g-box:focus-within{box-shadow:0 1px 6px rgba(32,33,36,.28);border-color:transparent}
.l-google .g-box input{flex:1;border:0;outline:0;font:16px/1.4 ui-monospace,Menlo,monospace;color:#202124}
.l-google .g-card{width:min(584px,90vw);margin-top:18px;border:1px solid #dfe1e5;border-radius:12px;padding:18px 22px;text-align:right}
.l-google .g-card .g-expr{color:#70757a;font:13px ui-monospace,Menlo,monospace;margin-bottom:6px;text-align:right}
.l-google .g-card .g-val{font-size:34px;font-weight:500;color:#202124;font-family:ui-monospace,Menlo,monospace}
.l-google .g-btns{margin-top:26px;display:flex;gap:12px}
.l-google .g-btns button{background:#f8f9fa;border:1px solid #f8f9fa;border-radius:4px;padding:10px 16px;font-size:14px;color:#3c4043}
.l-google .g-btns button:hover{border-color:#dadce0;box-shadow:0 1px 1px rgba(0,0,0,.1)}
.l-google .g-trend{margin-top:34px;font-size:13px;color:#70757a}
.l-google .g-trend a{color:#1a73e8;text-decoration:none;margin:0 8px}
.l-google .g-foot{background:#f2f2f2;color:#70757a;font-size:14px;padding:14px 26px;display:flex;justify-content:space-between}
.l-google .g-foot a{color:#70757a;text-decoration:none;margin-right:22px}`,
    render() {
      const trend = CALCS.slice(0, 4).map(c => `<a>${esc(c.title)}</a>`).join(' · ');
      return `
<div class="g-top"><a>Gallery</a><a>My Calcs</a><a>Docs</a><a class="g-btn">Sign in</a></div>
<div class="g-mid">
  <div class="g-logo"><span class="c1">I</span><span class="c2">n</span><span class="c3">s</span><span class="c1">t</span><span class="c4">a</span><span class="c2">C</span><span class="c1">a</span><span class="c3">l</span><span class="c4">c</span></div>
  <div class="g-box">🔍 <input id="g-in" value="30 guests * $18 + $250 venue + $120 music" spellcheck="false"> 🎲</div>
  <div class="g-card"><div class="g-expr" id="g-expr">30*18 + 250 + 120 =</div><div class="g-val" id="g-val">910</div></div>
  <div class="g-btns"><button>InstaCalc Search</button><button>I’m Feeling Lucky</button></div>
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
.l-reddit{background:#f6f7f8;color:#1c1c1c;font-size:14px}
.l-reddit .r-top{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #edeff1;display:flex;align-items:center;gap:16px;padding:8px 20px}
.l-reddit .r-logo{font-weight:800;font-size:18px;color:#0f6bd7;white-space:nowrap}
.l-reddit .r-logo span{color:#ff4500}
.l-reddit .r-search{flex:1;max-width:640px;background:#f6f7f8;border:1px solid #edeff1;border-radius:20px;padding:8px 16px;color:#878a8c}
.l-reddit .r-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.l-reddit .r-actions .btn{border:1px solid #0f6bd7;color:#0f6bd7;background:#fff;border-radius:999px;padding:6px 14px;font-weight:700;font-size:13px}
.l-reddit .r-actions .btn.solid{background:#0f6bd7;color:#fff}
.l-reddit .r-body{display:grid;grid-template-columns:210px minmax(0,660px) 300px;gap:22px;max-width:1240px;margin:20px auto;padding:0 16px}
.l-reddit .r-rail{font-size:13px}
.l-reddit .r-rail h4{font-size:10px;letter-spacing:.08em;color:#878a8c;text-transform:uppercase;margin:16px 0 6px 10px}
.l-reddit .r-rail a{display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:6px;color:#1c1c1c;text-decoration:none}
.l-reddit .r-rail a:hover{background:#e8f0fb}
.l-reddit .r-rail a.on{background:#e8f0fb;font-weight:700}
.l-reddit .r-post{background:#fff;border:1px solid #ccc;border-radius:6px;display:flex;margin-bottom:12px;overflow:hidden}
.l-reddit .r-post:hover{border-color:#898989}
.l-reddit .r-vote{width:42px;background:#f8f9fa;padding:8px 0;text-align:center;color:#878a8c;font-weight:700;font-size:12px}
.l-reddit .r-vote .up:hover{color:#ff4500;cursor:pointer}.l-reddit .r-vote .dn:hover{color:#7193ff;cursor:pointer}
.l-reddit .r-main{padding:10px 14px;flex:1;min-width:0}
.l-reddit .r-meta{font-size:12px;color:#878a8c;margin-bottom:4px}
.l-reddit .r-meta b{color:#1c1c1c}
.l-reddit .r-title{font-size:17px;font-weight:600;margin-bottom:8px}
.l-reddit .r-prev{border:1px solid #edeff1;border-radius:6px;padding:10px 12px;background:#fcfcfd;max-width:420px}
.l-reddit .r-foot{display:flex;gap:16px;margin-top:8px;font-size:12px;color:#878a8c;font-weight:700}
.l-reddit .r-foot span:hover{background:#f0f1f2;border-radius:3px;cursor:pointer}
.l-reddit .r-side>div{background:#fff;border:1px solid #ccc;border-radius:6px;padding:14px;margin-bottom:14px}
.l-reddit .r-side h3{font-size:15px;margin-bottom:8px}
.l-reddit .r-side p{font-size:13px;color:#555;line-height:1.5}
.l-reddit .r-side .btn{display:block;width:100%;text-align:center;background:#0f6bd7;color:#fff;border:0;border-radius:999px;padding:8px;font-weight:700;margin-top:10px}
.l-reddit .r-side .btn.ghost{background:#fff;color:#0f6bd7;border:1px solid #0f6bd7}
.l-reddit .r-open{background:#fff;border:1px solid #ccc;border-radius:6px;padding:14px;margin-bottom:12px}
.l-reddit .r-open h3{font-size:15px;margin-bottom:8px}
.l-reddit .r-open .ic-calc{background:#fcfcfd;border:1px solid #edeff1;border-radius:6px;padding:10px 14px;--icr:#0f6bd7}
.l-reddit .r-open .ic-calc textarea{height:230px}`,
    render() {
      const rails = CATEGORIES.map((c, i) => `<a class="${i === 0 ? 'on' : ''}">${c.icon} c/${c.id}</a>`).join('');
      const posts = CALCS.slice(0, 6).map((c, i) => `
<div class="r-post">
  <div class="r-vote"><div class="up">▲</div>${(3400 - i * 412).toLocaleString()}<div class="dn">▼</div></div>
  <div class="r-main">
    <div class="r-meta"><b>c/${c.cat}</b> · Posted by u/${esc(c.author)} ${c.age} ago</div>
    <div class="r-title">${esc(c.title)}</div>
    <div class="r-prev" style="--icr:hsl(${c.hue},55%,38%)">${mini(c)}</div>
    <div class="r-foot"><span>💬 ${c.comments} comments</span><span>🔀 remix (${Math.round(c.comments * 3.7)})</span><span>↗ share</span><span>☆ save</span></div>
  </div>
</div>`).join('');
      return `
<div class="r-top">
  <div class="r-logo">insta<span>calc</span></div>
  <div class="r-search">🔍 Search calculators, topics, people…</div>
  <div class="r-actions"><button class="btn">Browse Gallery</button><button class="btn solid">+ Create Calc</button><span style="font-size:20px">👤</span></div>
</div>
<div class="r-body">
  <div class="r-rail">
    <h4>Feeds</h4><a class="on">🏠 Home</a><a>🔥 Popular</a><a>🌐 All</a>
    <h4>Topics</h4>${rails}
  </div>
  <div>
    <div class="r-open">
      <div class="r-meta">✏️ Your draft · autosaved · <b>share when ready</b></div>
      <h3>🎉 ${IC.DEMO_TITLE}</h3>
      ${editor('')}
    </div>
    ${posts}
  </div>
  <div class="r-side">
    <div><h3>📐 About InstaCalc</h3><p>The calculator that shows its work. Build a calc in seconds, share it like a link, remix anyone’s math.</p><button class="btn">Create Calc</button><button class="btn ghost">Browse Gallery</button></div>
    <div><h3>📈 Trending today</h3><p>${CALCS.slice(6, 10).map(c => '· ' + esc(c.title)).join('<br>')}</p></div>
  </div>
</div>`;
    }
  });

  /* ============ 3. WIKIPEDIA — the reference work ============ */
  define({
    id: 'wikipedia', name: 'The Reference', app: 'Wikipedia', wire: 'doc',
    note: 'Every calc is an encyclopedia article: dense internal links, contents rail, live calc as the “infobox”. Authority through plainness.',
    css: `
.l-wiki{background:#fff;color:#202122;font-family:Georgia,'Times New Roman',serif}
.l-wiki .w-top{display:flex;align-items:center;gap:14px;padding:10px 22px;border-bottom:1px solid #a2a9b1;font-family:sans-serif;font-size:13px}
.l-wiki .w-mark{font-family:Georgia,serif;font-size:22px}
.l-wiki .w-mark b{font-weight:700}
.l-wiki .w-tag{color:#54595d;font-size:12px}
.l-wiki .w-search{margin-left:auto;display:flex}
.l-wiki .w-search input{border:1px solid #a2a9b1;padding:6px 10px;width:260px;font-size:13px}
.l-wiki .w-search button{border:1px solid #a2a9b1;border-left:0;background:#f8f9fa;padding:6px 12px}
.l-wiki .w-cols{display:grid;grid-template-columns:176px minmax(0,1fr);max-width:1200px;margin:0 auto}
.l-wiki .w-nav{padding:20px 14px;font-family:sans-serif;font-size:12.5px;border-right:1px solid #eaecf0}
.l-wiki .w-nav h4{color:#54595d;font-weight:400;font-size:12px;margin:14px 0 4px;border-bottom:1px solid #eaecf0;padding-bottom:3px}
.l-wiki .w-nav a{display:block;color:#3366cc;text-decoration:none;padding:2px 0}
.l-wiki .w-nav a:hover{text-decoration:underline}
.l-wiki .w-art{padding:20px 34px 60px}
.l-wiki .w-tabs{font-family:sans-serif;font-size:13px;border-bottom:1px solid #a2a9b1;display:flex;gap:0;margin-bottom:12px}
.l-wiki .w-tabs span{padding:8px 14px;border:1px solid #a2a9b1;border-bottom:0;background:#f8f9fa;color:#3366cc}
.l-wiki .w-tabs span.on{background:#fff;color:#202122}
.l-wiki h1{font-weight:400;font-size:30px;border-bottom:1px solid #a2a9b1;padding-bottom:4px;margin-bottom:8px}
.l-wiki .w-hat{font-style:italic;color:#54595d;font-size:13.5px;margin-bottom:14px}
.l-wiki p{font-size:15px;line-height:1.62;margin-bottom:12px;max-width:62ch}
.l-wiki p a{color:#3366cc;text-decoration:none}
.l-wiki p a:hover{text-decoration:underline}
.l-wiki .w-info{float:right;width:320px;margin:0 0 16px 26px;border:1px solid #a2a9b1;background:#f8f9fa;font-family:sans-serif;font-size:12px}
.l-wiki .w-info .cap{background:#eaecf0;text-align:center;font-weight:700;padding:6px;font-size:13px}
.l-wiki .w-info .ic-calc{padding:10px 12px;--icr:#036;background:#fff}
.l-wiki .w-info .ic-calc textarea{height:224px;font-size:12.5px}
.l-wiki .w-info .rowi{display:flex;justify-content:space-between;padding:5px 12px;border-top:1px solid #eaecf0}
.l-wiki .w-info .rowi b{font-weight:700}
.l-wiki h2{font-weight:400;font-size:21px;border-bottom:1px solid #a2a9b1;margin:22px 0 10px;padding-bottom:3px}
.l-wiki .w-see{font-size:14px;line-height:1.8;columns:2;max-width:60ch}
.l-wiki .w-see a{color:#3366cc;text-decoration:none}`,
    render() {
      const nav = CATEGORIES.map(c => `<a>${c.name} (${c.count})</a>`).join('');
      const see = CALCS.slice(0, 8).map(c => `<div>• <a>${esc(c.title)}</a></div>`).join('');
      return `
<div class="w-top">
  <div>📖</div><div><div class="w-mark">Insta<b>Calc</b></div><div class="w-tag">The free calculator library — 1,642 calcs and counting</div></div>
  <div class="w-search"><input placeholder="Search InstaCalc"><button>Search</button></div>
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
    <div class="w-hat">From InstaCalc, the calculator anyone can edit. Maintained by <a>u/kazad</a>; last updated 3 hours ago.</div>
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
.l-mcm{background:#fff;color:#333;font-size:13px;font-family:Arial,Helvetica,sans-serif}
.l-mcm .m-head{background:#a1c93a;background:linear-gradient(#b5d24b,#96b93a);padding:8px 18px;display:flex;align-items:center;gap:20px}
.l-mcm .m-logo{font-weight:700;font-size:20px;color:#1a3300;letter-spacing:-.5px}
.l-mcm .m-logo span{font-weight:400}
.l-mcm .m-search{flex:1;max-width:560px;display:flex}
.l-mcm .m-search input{flex:1;border:1px solid #7a941f;padding:8px 12px;font-size:14px;outline:none}
.l-mcm .m-search button{background:#2d4a00;color:#fff;border:0;padding:8px 18px;font-weight:700}
.l-mcm .m-head .m-links{margin-left:auto;color:#1a3300;font-size:12px;display:flex;gap:14px}
.l-mcm .m-cols{display:grid;grid-template-columns:198px minmax(0,1fr)}
.l-mcm .m-rail{border-right:1px solid #ddd;padding:10px 0}
.l-mcm .m-rail h4{font-size:11px;text-transform:uppercase;color:#777;padding:8px 14px 4px}
.l-mcm .m-rail a{display:flex;justify-content:space-between;padding:4px 14px;color:#0053a0;text-decoration:none}
.l-mcm .m-rail a:hover{background:#ffefac}
.l-mcm .m-rail a i{color:#999;font-style:normal}
.l-mcm .m-main{padding:14px 22px}
.l-mcm .m-crumb{color:#777;font-size:12px;margin-bottom:8px}
.l-mcm .m-title{font-size:19px;font-weight:700;margin-bottom:2px}
.l-mcm .m-sub{color:#777;margin-bottom:12px}
.l-mcm table{border-collapse:collapse;width:100%}
.l-mcm th{background:#f2f2f2;border:1px solid #ddd;font-size:11px;text-transform:uppercase;color:#555;padding:6px 10px;text-align:left}
.l-mcm td{border:1px solid #ddd;padding:7px 10px;vertical-align:top}
.l-mcm tr:hover td{background:#fffbe6}
.l-mcm td .nm{color:#0053a0;font-weight:700;cursor:pointer}
.l-mcm td .ds{color:#777;font-size:12px;margin-top:2px}
.l-mcm .m-open{background:#2d4a00;color:#fff;border:0;padding:5px 14px;font-weight:700;font-size:12px;cursor:pointer}
.l-mcm .m-thumbcell{width:130px}
.l-mcm .ic-mini{font-size:9.5px;line-height:1.5}
.l-mcm .m-inline{border:2px solid #96b93a;margin-bottom:16px}
.l-mcm .m-inline .cap{background:#eef5d8;padding:6px 12px;font-weight:700;display:flex;justify-content:space-between}
.l-mcm .m-inline .ic-calc{padding:8px 12px;--icr:#2d4a00}
.l-mcm .m-inline .ic-calc textarea{height:170px;font-size:12.5px;line-height:24px}
.l-mcm .m-inline .ic-out{line-height:24px}`,
    render() {
      const rail = CATEGORIES.map(c => `<a>${c.name}<i>${c.count}</i></a>`).join('');
      const rows = CALCS.map(c => `
<tr>
  <td class="m-thumbcell" style="--icr:#2d4a00">${mini(c, 2)}</td>
  <td><div class="nm">${esc(c.title)}</div><div class="ds">${esc(c.desc)}</div></td>
  <td>${cat(c.cat).name}</td>
  <td>${c.lines.length} inputs · 6 steps</td>
  <td>${c.uses}</td>
  <td>${c.rating} ★</td>
  <td><button class="m-open">Open</button></td>
</tr>`).join('');
      return `
<div class="m-head">
  <div class="m-logo">INSTACALC<span>®</span></div>
  <div class="m-search"><input placeholder="Search 1,642 calculators (e.g. “mortgage”, “mpg”, “tip”)"><button>GO</button></div>
  <div class="m-links"><span>Order history → My Calcs</span><span>Help</span></div>
</div>
<div class="m-cols">
  <div class="m-rail"><h4>Browse by category</h4>${rail}<h4>Filter</h4><a>Live editable<i>1,204</i></a><a>With charts<i>318</i></a><a>Forkable<i>1,642</i></a></div>
  <div class="m-main">
    <div class="m-crumb">All calculators › Everyday & Fun › Events</div>
    <div class="m-title">Party Budget — open calc</div>
    <div class="m-sub">Spec it like a part: edit values below, results update in-line. Cert: shared-link reproducible.</div>
    <div class="m-inline"><div class="cap"><span>PARTY BUDGET, 30-GUEST, LIVE</span><span>SKU IC-18340</span></div>${editor('')}</div>
    <div class="m-title" style="font-size:16px">All calculators <span style="color:#777;font-weight:400">(showing 16 of 1,642)</span></div>
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
    note: 'Calcs as destinations: big friendly search pill, category chips, image-forward cards with ratings and saves.',
    css: `
.l-abnb{background:#fff;color:#222}
.l-abnb .a-top{position:sticky;top:0;background:#fff;z-index:10;display:flex;align-items:center;gap:20px;padding:14px 40px;border-bottom:1px solid #eee}
.l-abnb .a-logo{color:#e84b64;font-weight:800;font-size:20px;display:flex;gap:6px;align-items:center}
.l-abnb .a-pill{margin:0 auto;display:flex;align-items:center;border:1px solid #ddd;border-radius:999px;box-shadow:0 3px 12px rgba(0,0,0,.08);overflow:hidden}
.l-abnb .a-pill div{padding:12px 20px;font-size:13px;border-right:1px solid #eee}
.l-abnb .a-pill div b{display:block;font-size:12px}
.l-abnb .a-pill div span{color:#717171}
.l-abnb .a-pill .go{border:0;background:#e84b64;color:#fff;border-radius:999px;margin:6px;padding:10px 12px;font-weight:700}
.l-abnb .a-user{display:flex;gap:12px;align-items:center;font-size:14px;font-weight:600}
.l-abnb .a-chips{display:flex;gap:28px;padding:16px 40px;border-bottom:1px solid #eee;overflow-x:auto}
.l-abnb .a-chip{text-align:center;font-size:12px;color:#717171;white-space:nowrap;padding-bottom:8px;border-bottom:2px solid transparent;cursor:pointer}
.l-abnb .a-chip:hover,.l-abnb .a-chip.on{color:#222;border-color:#222}
.l-abnb .a-chip .i{font-size:22px;display:block;margin-bottom:4px}
.l-abnb .a-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:24px;padding:24px 40px 60px}
.l-abnb .a-card{cursor:pointer}
.l-abnb .ic-thumb{border-radius:14px;padding:18px;height:180px;display:flex;flex-direction:column;justify-content:center;position:relative}
.l-abnb .ic-thumb .hrt{position:absolute;top:12px;right:14px;font-size:18px;opacity:.85}
.l-abnb .a-card .t{display:flex;justify-content:space-between;margin-top:10px;font-size:14.5px}
.l-abnb .a-card .t b{font-weight:600}
.l-abnb .a-card .s{color:#717171;font-size:13.5px}
.l-abnb .a-card .p{font-size:13.5px;margin-top:3px}
.l-abnb .a-hero{margin:26px 40px 0;background:#f7f7f7;border-radius:16px;padding:22px 26px;display:grid;grid-template-columns:1.1fr 1fr;gap:30px;align-items:center}
.l-abnb .a-hero h2{font-size:24px;margin-bottom:8px}
.l-abnb .a-hero p{color:#717171;font-size:14.5px;line-height:1.5;max-width:44ch}
.l-abnb .a-hero .cta{margin-top:14px;background:#e84b64;border:0;color:#fff;font-weight:700;border-radius:8px;padding:12px 20px}
.l-abnb .a-hero .ic-calc{background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.09);padding:14px 18px;--icr:#e84b64}
.l-abnb .a-hero .ic-calc textarea{height:200px}`,
    render() {
      const chips = CATEGORIES.map((c, i) => `<div class="a-chip ${i === 0 ? 'on' : ''}"><span class="i">${c.icon}</span>${c.name}</div>`).join('');
      const cards = CALCS.slice(0, 8).map(c => `
<div class="a-card">
  ${thumb(c).replace('class="ic-thumb ', 'class="ic-thumb ').replace('</div>', '<span class="hrt">🤍</span></div>')}
  <div class="t"><b>${esc(c.title)}</b><span>★ ${c.rating}</span></div>
  <div class="s">by ${esc(c.author)} · ${cat(c.cat).name}</div>
  <div class="p"><b>Free</b> · ${c.uses} uses</div>
</div>`).join('');
      return `
<div class="a-top">
  <div class="a-logo">⌂ instacalc</div>
  <div class="a-pill"><div><b>What</b><span>Any calculation</span></div><div><b>Category</b><span>All categories</span></div><div><b>Level</b><span>Any complexity</span></div><button class="go">🔍</button></div>
  <div class="a-user"><span>Create a calc</span><span>🌐</span><span>☰ 👤</span></div>
</div>
<div class="a-chips">${chips}</div>
<div class="a-hero">
  <div><h2>Try one right now</h2><p>Every calc is live — change a number, watch everything downstream update. When it’s right, share it like a link.</p><button class="cta">Start from this template</button></div>
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
.l-cl{background:#fff;color:#000;font-family:'Times New Roman',Times,serif;font-size:15px;padding:18px 26px}
.l-cl .c-head{display:flex;align-items:baseline;gap:16px;margin-bottom:4px}
.l-cl .c-head h1{font-family:Arial,sans-serif;font-size:20px;color:#551a8b;font-weight:700}
.l-cl .c-head span{color:#666;font-size:13px}
.l-cl .c-search{margin:8px 0 14px}
.l-cl .c-search input{border:1px solid #999;padding:4px 8px;width:280px;font-size:14px}
.l-cl .c-search button{font-size:13px;padding:4px 10px}
.l-cl .c-cols{display:grid;grid-template-columns:repeat(4,1fr);gap:0 28px;max-width:1080px}
.l-cl h3{font-family:Arial,sans-serif;font-size:14px;background:#ece8dc;padding:2px 6px;margin:10px 0 4px}
.l-cl li{list-style:none;line-height:1.55}
.l-cl a{color:#00e;text-decoration:none}
.l-cl a:visited{color:#551a8b}
.l-cl a:hover{text-decoration:underline}
.l-cl .c-note{color:#666;font-size:12px}
.l-cl .c-calc{max-width:520px;border:1px solid #999;margin:6px 0 14px;padding:8px 12px;--icr:#551a8b}
.l-cl .c-calc .ic-calc textarea{height:210px;font-size:13px;line-height:25px}
.l-cl .c-calc .ic-out{line-height:25px}
.l-cl .c-foot{margin-top:22px;color:#666;font-size:12px}`,
    render() {
      const col = (catId) => {
        const c = cat(catId);
        const items = CALCS.filter(x => x.cat === catId);
        const extra = ['see all ' + (c.count) + ' →'];
        return `<h3>${c.name.toLowerCase()}</h3><ul>${items.map(x => `<li><a>${esc(x.title.toLowerCase())}</a> <span class="c-note">${x.uses}</span></li>`).join('')}<li><a>${extra}</a></li></ul>`;
      };
      return `
<div class="c-head"><h1>instacalc</h1><span>calculators for everything · everywhere · free</span></div>
<div class="c-search"><input placeholder="search calcs"> <button>go</button> <span class="c-note">1,642 calcs · updated 3 min ago</span></div>
<b style="font-family:Arial,sans-serif;font-size:14px">open calc: party budget</b> <span class="c-note">(edit numbers, share the url)</span>
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
.l-hn{background:#f6f6ef;color:#222;font-family:Verdana,Geneva,sans-serif;font-size:13px}
.l-hn .h-bar{background:#0f6bd7;padding:5px 10px;display:flex;align-items:center;gap:10px;color:#fff}
.l-hn .h-bar b{border:1px solid #fff;padding:1px 4px;font-size:12px}
.l-hn .h-bar a{color:#fff;text-decoration:none;font-size:12.5px}
.l-hn .h-bar .r{margin-left:auto}
.l-hn .h-list{max-width:880px;margin:0 auto;padding:10px 16px 40px}
.l-hn .h-item{display:flex;gap:6px;padding:3px 0;align-items:baseline}
.l-hn .h-rank{color:#828282;min-width:22px;text-align:right}
.l-hn .h-vote{color:#828282;cursor:pointer}
.l-hn .h-title a{color:#000;text-decoration:none;font-size:13.5px}
.l-hn .h-title .dom{color:#828282;font-size:11px}
.l-hn .h-sub{color:#828282;font-size:11px;margin-left:28px;padding-bottom:4px}
.l-hn .h-sub a{color:#828282}
.l-hn .h-embed{margin:6px 0 10px 28px;max-width:560px;background:#fff;border:1px solid #e0e0d1;padding:8px 12px;--icr:#0f6bd7}
.l-hn .h-embed .ic-calc textarea{height:216px;font-size:12.5px;line-height:26px}
.l-hn .h-embed .ic-out{line-height:26px}
.l-hn .h-more{color:#828282;margin:12px 0 0 28px}
.l-hn .h-foot{border-top:2px solid #0f6bd7;max-width:880px;margin:0 auto;padding:10px 16px;color:#828282;font-size:11.5px;text-align:center}`,
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
<div class="h-bar"><b>iC</b><a><b style="border:0;padding:0">InstaCalc News</b></a><a>new</a> | <a>top</a> | <a>show</a> | <a>gallery</a> | <a>submit calc</a><a class="r">login</a></div>
<div class="h-list">${items}<div class="h-more">More ›</div></div>
<div class="h-foot">Guidelines | FAQ | Lists | API | Search — applications open for InstaCalc batch W26</div>`;
    }
  });

  /* ============ 8. AMAZON — search + facets + trust signals ============ */
  define({
    id: 'amazon', name: 'The Superstore', app: 'Amazon', wire: 'both',
    note: 'Search-dominant with facet filters and heavy trust signals: star ratings, usage counts, “used this month”. Calc gets a Buy-Box.',
    css: `
.l-amz{background:#fff;color:#0f1111;font-size:14px;font-family:Arial,sans-serif}
.l-amz .z-top{background:#131921;color:#fff;display:flex;align-items:center;gap:16px;padding:10px 18px}
.l-amz .z-logo{font-weight:700;font-size:20px}
.l-amz .z-logo span{color:#febd69}
.l-amz .z-loc{font-size:12px;color:#ccc}
.l-amz .z-loc b{color:#fff;display:block;font-size:13px}
.l-amz .z-search{flex:1;display:flex;border-radius:6px;overflow:hidden}
.l-amz .z-search select{border:0;background:#f3f3f3;color:#555;padding:0 8px;font-size:12px}
.l-amz .z-search input{flex:1;border:0;padding:10px 12px;font-size:14px;outline:none}
.l-amz .z-search button{border:0;background:#febd69;padding:0 16px;font-size:16px}
.l-amz .z-acct{font-size:12px;color:#ccc}
.l-amz .z-acct b{color:#fff;display:block;font-size:13px}
.l-amz .z-sub{background:#232f3e;color:#ddd;display:flex;gap:18px;padding:8px 18px;font-size:13px}
.l-amz .z-sub b{color:#fff}
.l-amz .z-cols{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0}
.l-amz .z-facets{padding:16px 18px;border-right:1px solid #e7e7e7;font-size:13px}
.l-amz .z-facets h4{font-size:14px;margin:12px 0 6px}
.l-amz .z-facets label{display:block;padding:2px 0;color:#0f1111}
.l-amz .z-facets .stars{color:#de7921}
.l-amz .z-res{padding:16px 24px}
.l-amz .z-count{color:#565959;font-size:13px;margin-bottom:10px}
.l-amz .z-count b{color:#c45500}
.l-amz .z-row{display:grid;grid-template-columns:190px minmax(0,1fr) 200px;gap:18px;border-bottom:1px solid #e7e7e7;padding:16px 0}
.l-amz .ic-thumb{border-radius:8px;height:130px;padding:14px;display:flex;align-items:center}
.l-amz .z-t{font-size:17px;color:#0f6bd7;font-weight:500;cursor:pointer}
.l-amz .z-t:hover{color:#c45500}
.l-amz .z-stars{color:#de7921;font-size:13px}
.l-amz .z-stars span{color:#0f6bd7}
.l-amz .z-used{color:#565959;font-size:12.5px}
.l-amz .z-bullets{color:#333;font-size:13px;margin-top:6px;line-height:1.5}
.l-amz .z-buy{border:1px solid #e7e7e7;border-radius:8px;padding:12px}
.l-amz .z-free{font-size:20px;font-weight:700}
.l-amz .z-inst{color:#007600;font-size:12.5px;margin:4px 0}
.l-amz .z-use{width:100%;border:0;background:#ffd814;border-radius:999px;padding:8px;font-size:13px;margin-top:6px;cursor:pointer}
.l-amz .z-save{width:100%;border:0;background:#ffa41c;border-radius:999px;padding:8px;font-size:13px;margin-top:6px;cursor:pointer}
.l-amz .z-hero{margin:0 24px;border:2px solid #febd69;border-radius:8px;margin-top:16px;padding:12px 16px;--icr:#c45500}
.l-amz .z-hero .cap{font-weight:700;margin-bottom:4px}
.l-amz .z-hero .ic-calc textarea{height:100px;line-height:24px;font-size:13px}
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
  <div class="z-buy"><div class="z-free">Free</div><div class="z-inst">Instant — runs in your browser</div><div class="z-used">Ships from: instacalc.com</div><button class="z-use">Use now</button><button class="z-save">Save to My Calcs</button></div>
</div>`).join('');
      return `
<div class="z-top">
  <div class="z-logo">insta<span>calc</span></div>
  <div class="z-loc">Deliver to<b>📍 Everyone, free</b></div>
  <div class="z-search"><select><option>All categories</option></select><input placeholder="Search calculators"><button>🔍</button></div>
  <div class="z-acct">Hello, kalid<b>My Calcs & Lists</b></div>
  <div class="z-acct">Returns<b>& Remixes</b></div>
  <div style="font-size:20px">🧺<span style="font-size:12px"> Collection</span></div>
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
.l-yt{background:#fff;color:#0f0f0f}
.l-yt .y-top{position:sticky;top:0;z-index:10;background:#fff;display:flex;align-items:center;gap:18px;padding:8px 20px}
.l-yt .y-burger{font-size:20px}
.l-yt .y-logo{font-weight:800;font-size:19px;letter-spacing:-.5px}
.l-yt .y-logo span{background:#1a73e8;color:#fff;border-radius:4px;padding:1px 5px;margin-right:3px}
.l-yt .y-search{flex:1;max-width:560px;margin:0 auto;display:flex}
.l-yt .y-search input{flex:1;border:1px solid #ccc;border-radius:20px 0 0 20px;padding:9px 16px;font-size:14px;outline:none}
.l-yt .y-search button{border:1px solid #ccc;border-left:0;background:#f8f8f8;border-radius:0 20px 20px 0;padding:0 20px}
.l-yt .y-right{display:flex;gap:16px;align-items:center;font-size:14px}
.l-yt .y-create{border:1px solid #ddd;border-radius:18px;padding:7px 14px;background:#f2f2f2;font-weight:500}
.l-yt .y-body{display:grid;grid-template-columns:210px minmax(0,1fr)}
.l-yt .y-rail{padding:12px 8px;font-size:14px}
.l-yt .y-rail a{display:flex;gap:16px;align-items:center;padding:8px 14px;border-radius:10px;color:#0f0f0f;text-decoration:none}
.l-yt .y-rail a.on,.l-yt .y-rail a:hover{background:#f2f2f2}
.l-yt .y-rail a.on{font-weight:600}
.l-yt .y-rail hr{border:0;border-top:1px solid #eee;margin:10px 0}
.l-yt .y-rail h4{font-size:13px;color:#606060;padding:6px 14px}
.l-yt .y-chips{display:flex;gap:10px;padding:10px 24px;overflow-x:auto;position:sticky;top:53px;background:#fff}
.l-yt .y-chip{background:#f2f2f2;border-radius:8px;padding:6px 12px;font-size:13.5px;white-space:nowrap;cursor:pointer}
.l-yt .y-chip.on{background:#0f0f0f;color:#fff}
.l-yt .y-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:22px 16px;padding:16px 24px 60px}
.l-yt .ic-thumb{border-radius:12px;height:170px;padding:18px;display:flex;align-items:center;position:relative}
.l-yt .ic-thumb .len{position:absolute;bottom:8px;right:10px;background:rgba(0,0,0,.8);color:#fff;font-size:11px;padding:2px 5px;border-radius:4px;font-weight:600}
.l-yt .y-meta{display:flex;gap:12px;margin-top:10px}
.l-yt .y-av{width:36px;height:36px;border-radius:50%;background:#1a73e8;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
.l-yt .y-t{font-weight:600;font-size:14.5px;line-height:1.35}
.l-yt .y-s{color:#606060;font-size:13px;margin-top:3px}
.l-yt .y-player{margin:14px 24px 0;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px}
.l-yt .y-screen{background:#0f1420;border-radius:14px;padding:20px 24px;--icr:#7db4ff;color:#e8ecf4}
.l-yt .y-screen .cap{color:#fff;font-weight:600;font-size:16px;margin-bottom:8px}
.l-yt .y-screen .ic-calc textarea{height:230px}
.l-yt .y-upnext{font-size:13px}
.l-yt .y-upnext h4{margin-bottom:8px;font-size:14px}
.l-yt .y-nextrow{display:flex;gap:10px;margin-bottom:10px}
.l-yt .y-nextrow .ic-thumb{height:64px;width:112px;padding:8px;border-radius:8px;flex:none}
.l-yt .y-nextrow .ic-mini{font-size:7.5px;line-height:1.4}
.l-yt .y-nextrow b{font-size:13px;font-weight:600;display:block}
.l-yt .y-nextrow span{color:#606060;font-size:12px}`,
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
<div class="y-top">
  <span class="y-burger">☰</span><div class="y-logo"><span>▶</span>InstaCalc</div>
  <div class="y-search"><input placeholder="Search calcs"><button>🔍</button></div>
  <div class="y-right"><button class="y-create">+ Create</button><span>🔔</span><span>👤</span></div>
</div>
<div class="y-body">
  <div class="y-rail">
    <a class="on">🏠 Home</a><a>⚡ Quick calcs</a><a>📚 Subscriptions</a><hr>
    <a>🗂 My calcs</a><a>🕘 History</a><a>❤️ Saved</a><hr>
    <h4>Authors you follow</h4><a>Ⓢ sarah_m</a><a>Ⓚ kazad</a><a>Ⓜ mathfan42</a>
  </div>
  <div>
    <div class="y-player">
      <div class="y-screen"><div class="cap">▶ Party Budget — now playing (edit anything)</div>${editor('')}</div>
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
    note: 'Dark library with horizontal shelves (“Made for you”, “Trending”) and playlists as calc collections. The open calc lives in a persistent now-playing bar.',
    css: `
.l-sp{background:#121212;color:#fff;display:flex;flex-direction:column;height:100vh}
.l-sp .s-cols{flex:1;display:grid;grid-template-columns:230px minmax(0,1fr);min-height:0}
.l-sp .s-rail{background:#000;padding:20px 12px;font-size:14px;overflow-y:auto}
.l-sp .s-logo{font-weight:800;font-size:20px;padding:0 12px 18px;letter-spacing:-.5px}
.l-sp .s-logo span{color:#1db954}
.l-sp .s-rail a{display:flex;gap:14px;align-items:center;padding:8px 12px;color:#b3b3b3;text-decoration:none;font-weight:700;border-radius:6px}
.l-sp .s-rail a.on,.l-sp .s-rail a:hover{color:#fff}
.l-sp .s-rail h4{color:#6a6a6a;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:18px 12px 6px}
.l-sp .s-rail .pl{font-weight:400;color:#b3b3b3;font-size:13.5px}
.l-sp .s-main{overflow-y:auto;background:linear-gradient(#3b2667 0,#121212 320px);padding:22px 28px 40px}
.l-sp .s-hi{font-size:26px;font-weight:800;margin-bottom:16px}
.l-sp .s-quick{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:28px}
.l-sp .s-qt{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.12);border-radius:6px;overflow:hidden;font-weight:700;font-size:14px;cursor:pointer}
.l-sp .s-qt:hover{background:rgba(255,255,255,.2)}
.l-sp .s-qt .qi{width:52px;height:52px;display:flex;align-items:center;justify-content:center;font-size:22px;flex:none}
.l-sp h3{font-size:20px;font-weight:800;margin:8px 0 14px}
.l-sp .s-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:16px;margin-bottom:30px}
.l-sp .s-card{background:#181818;border-radius:8px;padding:14px;cursor:pointer;transition:background .15s}
.l-sp .s-card:hover{background:#282828}
.l-sp .s-card .art{border-radius:6px;height:120px;padding:12px;display:flex;align-items:center;margin-bottom:10px;box-shadow:0 6px 18px rgba(0,0,0,.4);overflow:hidden}
.l-sp .s-card .ic-mini{font-size:8.5px;min-width:0;flex:1}
.l-sp .s-card b{font-size:14px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l-sp .s-card span{color:#a7a7a7;font-size:12.5px}
.l-sp .s-now{background:#181818;border-top:1px solid #282828;display:grid;grid-template-columns:280px minmax(0,1fr) 280px;align-items:center;padding:10px 18px;gap:14px}
.l-sp .s-now .tr{display:flex;gap:12px;align-items:center;min-width:0}
.l-sp .s-now .tr .art{width:52px;height:52px;border-radius:6px;background:hsl(28,42%,16%);display:flex;align-items:center;justify-content:center;font-size:20px;flex:none}
.l-sp .s-now .tr b{font-size:13.5px;display:block}
.l-sp .s-now .tr span{color:#a7a7a7;font-size:11.5px}
.l-sp .s-ctrl{text-align:center;font-size:13px;color:#d0d0d0}
.l-sp .s-ctrl .btns{font-size:17px;letter-spacing:14px;margin-bottom:4px}
.l-sp .s-ctrl .bar{height:4px;border-radius:2px;background:#4d4d4d;position:relative;max-width:480px;margin:0 auto}
.l-sp .s-ctrl .bar i{position:absolute;left:0;top:0;bottom:0;width:62%;background:#1db954;border-radius:2px}
.l-sp .s-live{--icr:#1db954;font-size:12px;justify-self:end;width:280px;background:#000;border-radius:8px;padding:6px 12px}
.l-sp .s-live .ic-calc textarea{height:56px;line-height:18px;font-size:11px}
.l-sp .s-live .ic-out{line-height:18px;font-size:11px}`,
    render() {
      const quick = CALCS.slice(0, 6).map(c => `<div class="s-qt"><div class="qi" style="background:hsl(${c.hue},42%,22%)">${cat(c.cat).icon}</div>${esc(c.title)}</div>`).join('');
      const shelf = (list) => list.map(c => `
<div class="s-card"><div class="art" style="background:hsl(${c.hue},40%,20%);--icr:hsl(${c.hue},60%,65%)">${mini(c)}</div><b>${esc(c.title)}</b><span>${esc(c.author)} · ${c.uses} uses</span></div>`).join('');
      return `
<div class="s-cols">
  <div class="s-rail">
    <div class="s-logo">Insta<span>Calc</span></div>
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
  <div class="tr"><div class="art">🎉</div><div><b>Party Budget</b><span>kazad · total: $910 · per guest: $30.33</span></div><span style="color:#1db954">♥</span></div>
  <div class="s-ctrl"><div class="btns">⤮ ⏮ ▶ ⏭ ⟲</div><div class="bar"><i></i></div></div>
  <div class="s-live">${editor('', 'guests = 30\ntotal = guests*18 + 370')}</div>
</div>`;
    }
  });

})();
