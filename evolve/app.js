/* InstaCalc /evolve — switcher + overview */
(function () {
  const stage = document.getElementById('stage');
  const styleEl = document.getElementById('layout-css');
  const overview = document.getElementById('overview');
  const ovGrid = document.getElementById('ov-grid');
  const q = new URLSearchParams(location.search);

  if (q.get('chrome') === '0') document.body.classList.add('no-chrome');

  /* theme: same convention as the rest of jshell (localStorage jshell_theme), ?theme= overrides */
  const applyTheme = t => document.body.classList.toggle('light-theme', t === 'light');
  const savedTheme = q.get('theme') || localStorage.getItem('jshell_theme') || 'dark';
  applyTheme(savedTheme);
  function toggleTheme() {
    const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
    localStorage.setItem('jshell_theme', next);
    applyTheme(next);
  }

  let idx = Math.max(0, IC.LAYOUTS.findIndex(l => l.id === q.get('l')));

  function wireHTML(kind) {
    const bar = '<div class="w-bar"></div>';
    switch (kind) {
      case 'topbar':   return `<div class="wire">${bar}<div class="w-row"><div class="w-main"></div></div></div>`;
      case 'leftrail': return `<div class="wire"><div class="w-row"><div class="w-rail"></div><div class="w-main"></div></div></div>`;
      case 'both':     return `<div class="wire">${bar}<div class="w-row"><div class="w-rail"></div><div class="w-main feed"></div></div></div>`;
      case 'center':   return `<div class="wire">${bar}<div class="w-row"><div class="w-center"></div></div></div>`;
      case 'grid':     return `<div class="wire">${bar}<div class="w-row"><div class="w-main grid"></div></div></div>`;
      case 'list':     return `<div class="wire">${bar}<div class="w-row"><div class="w-main feed"></div></div></div>`;
      case 'doc':      return `<div class="wire">${bar}<div class="w-row"><div class="w-rail"></div><div class="w-main"></div><div class="w-rail"></div></div></div>`;
      case 'split':    return `<div class="wire"><div class="w-row"><div class="w-rail"></div><div class="w-main"></div><div class="w-rail" style="width:32%"></div></div></div>`;
      case 'canvas':   return `<div class="wire"><div class="w-row"><div class="w-full"></div></div></div>`;
      case 'full':     return `<div class="wire"><div class="w-row"><div class="w-center" style="height:88%;width:34%"></div></div></div>`;
      default:         return `<div class="wire">${bar}<div class="w-row"><div class="w-main"></div></div></div>`;
    }
  }

  function show(i, push) {
    idx = ((i % IC.LAYOUTS.length) + IC.LAYOUTS.length) % IC.LAYOUTS.length;
    const L = IC.LAYOUTS[idx];
    styleEl.textContent = L.css;
    stage.innerHTML = `<div class="L l-x ${cssRoot(L)}">${L.render()}</div>`;
    const root = stage.firstElementChild;
    IC.bind(root);
    if (L.init) L.init(root);
    document.getElementById('sw-title').textContent = L.name;
    document.getElementById('sw-app').textContent = 'inspired by ' + L.app;
    document.getElementById('sw-count').textContent = (idx + 1) + '/' + IC.LAYOUTS.length;
    document.title = `InstaCalc /evolve — ${L.name} (${L.app})`;
    if (push !== false) {
      const u = new URL(location);
      u.searchParams.set('l', L.id);
      history.replaceState(null, '', u);
    }
    [...ovGrid.children].forEach((el, j) => el.classList.toggle('active', j === idx));
  }

  /* layout css classes are written as .l-google, .l-reddit, .l-wiki, etc — map ids */
  function cssRoot(L) {
    const map = { wikipedia: 'l-wiki', mcmaster: 'l-mcm', airbnb: 'l-abnb', craigslist: 'l-cl',
      amazon: 'l-amz', youtube: 'l-yt', spotify: 'l-sp', notion: 'l-no', linear: 'l-li',
      github: 'l-gh', stripe: 'l-st', excel: 'l-xl', figma: 'l-fg', pinterest: 'l-pin',
      apple: 'l-ap', slack: 'l-sl', tiktok: 'l-tk' };
    return map[L.id] || ('l-' + L.id);
  }

  /* overview grid */
  IC.LAYOUTS.forEach((L, i) => {
    const card = document.createElement('div');
    card.className = 'ov-card';
    card.innerHTML = `${wireHTML(L.wire)}<div class="ov-n">${i + 1}. ${L.name}<small>· ${L.app}</small></div><div class="ov-d">${L.note}</div><div class="ov-k">${L.wire} structure</div>`;
    card.addEventListener('click', () => { overview.classList.remove('open'); show(i); });
    ovGrid.appendChild(card);
  });

  document.getElementById('sw-prev').addEventListener('click', () => show(idx - 1));
  document.getElementById('sw-next').addEventListener('click', () => show(idx + 1));
  document.getElementById('sw-theme').addEventListener('click', toggleTheme);
  document.getElementById('sw-open').addEventListener('click', () => overview.classList.add('open'));
  document.getElementById('ov-close').addEventListener('click', () => overview.classList.remove('open'));

  document.addEventListener('keydown', e => {
    if (e.target.matches('textarea, input, [contenteditable]')) return;
    if (e.key === 'ArrowRight') show(idx + 1);
    else if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key.toLowerCase() === 'g') overview.classList.toggle('open');
    else if (e.key.toLowerCase() === 't') toggleTheme();
    else if (e.key === 'Escape') overview.classList.remove('open');
  });

  show(idx, false);
  /* first visit with no explicit layout: open the overview so the gallery is discoverable */
  if (!q.get('l') && q.get('chrome') !== '0') overview.classList.add('open');
})();
