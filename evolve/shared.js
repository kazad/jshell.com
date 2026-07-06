/* InstaCalc /evolve — shared data, live-calc engine, and helpers.
   Every layout renders the SAME product (calcs, gallery, search) with different bones. */

window.IC = (function () {
  const IC = {};

  /* ---------------- data ---------------- */

  IC.CATEGORIES = [
    { id: 'finance',     name: 'Finance',          icon: '💰', count: 412 },
    { id: 'health',      name: 'Health & Fitness', icon: '💪', count: 187 },
    { id: 'home',        name: 'Home & DIY',       icon: '🔨', count: 143 },
    { id: 'cooking',     name: 'Cooking',          icon: '🍳', count: 96 },
    { id: 'travel',      name: 'Travel',           icon: '✈️', count: 88 },
    { id: 'business',    name: 'Business',         icon: '📈', count: 205 },
    { id: 'education',   name: 'Education',        icon: '🎓', count: 117 },
    { id: 'conversions', name: 'Conversions',      icon: '🔁', count: 230 },
    { id: 'fun',         name: 'Everyday & Fun',   icon: '🎉', count: 164 },
  ];

  IC.CALCS = [
    { id: 'mortgage',  title: 'Mortgage Payoff Planner',      author: 'sarah_m',    cat: 'finance',     uses: '24.1k', rating: 4.8, comments: 84,  age: '2d',  hue: 210,
      desc: 'See how extra payments shorten a 30-year loan.',
      lines: [['loan = 320,000', '320,000'], ['rate = 6.2%', '0.062'], ['payment / mo', '$1,962']] },
    { id: 'tipsplit',  title: 'Tip & Bill Splitter',          author: 'kazad',      cat: 'fun',         uses: '18.3k', rating: 4.9, comments: 41,  age: '5h',  hue: 28,
      desc: 'Split the check, tip included, no arguments.',
      lines: [['bill = 86.40', '86.40'], ['tip = 20%', '17.28'], ['each (4 ppl)', '$25.92']] },
    { id: 'compound',  title: 'Compound Interest Visualizer', author: 'mathfan42',  cat: 'finance',     uses: '31.2k', rating: 4.7, comments: 129, age: '1d',  hue: 150,
      desc: 'Watch $100/month become a small fortune.',
      lines: [['monthly = 100', '100'], ['years = 30', '30'], ['future value', '$117,606']] },
    { id: 'recipe',    title: 'Recipe Scaler',                author: 'chefdata',   cat: 'cooking',     uses: '9.8k',  rating: 4.9, comments: 22,  age: '3d',  hue: 350,
      desc: 'Serves 4 → serves 11, without the mental math.',
      lines: [['serves = 4 → 11', '2.75x'], ['flour = 2 cups', '5.5 cups'], ['butter = 6 tbsp', '16.5 tbsp']] },
    { id: 'roadtrip',  title: 'Road Trip Fuel Cost',          author: 'nomadic',    cat: 'travel',      uses: '7.4k',  rating: 4.6, comments: 17,  age: '6d',  hue: 190,
      desc: 'Miles, MPG, gas price → total damage.',
      lines: [['miles = 1,240', '1,240'], ['mpg = 31', '31'], ['fuel cost', '$156']] },
    { id: 'freelance', title: 'Freelance Hourly Rate',        author: 'indiehacker',cat: 'business',    uses: '12.6k', rating: 4.8, comments: 96,  age: '12h', hue: 262,
      desc: 'Back into your rate from the income you want.',
      lines: [['target = 90k/yr', '90,000'], ['billable hrs', '1,100'], ['rate', '$82/hr']] },
    { id: 'bmi',       title: 'BMI & Calorie Target',         author: 'fitcoach',   cat: 'health',      uses: '15.9k', rating: 4.5, comments: 63,  age: '1d',  hue: 90,
      desc: 'A gentler take on the classic formula.',
      lines: [['weight = 172 lb', '78 kg'], ['height = 5\'10"', '1.78 m'], ['BMI', '24.7']] },
    { id: 'runway',    title: 'Startup Runway',               author: 'foundr',     cat: 'business',    uses: '8.8k',  rating: 4.7, comments: 54,  age: '4d',  hue: 12,
      desc: 'Cash ÷ burn = months of sleep you have left.',
      lines: [['cash = 480k', '480,000'], ['burn = 42k/mo', '42,000'], ['runway', '11.4 mo']] },
    { id: 'paint',     title: 'Paint Coverage Estimator',     author: 'diyanne',    cat: 'home',        uses: '5.2k',  rating: 4.6, comments: 12,  age: '1w',  hue: 45,
      desc: 'Walls, coats, and how many gallons to buy.',
      lines: [['area = 640 ft²', '640'], ['coats = 2', '2'], ['gallons', '3.6']] },
    { id: 'retire',    title: 'Retirement Savings Projector', author: 'futureme',   cat: 'finance',     uses: '22.4k', rating: 4.8, comments: 201, age: '8h',  hue: 220,
      desc: 'When can you actually stop working?',
      lines: [['saved = 240k', '240,000'], ['save/mo = 1,500', '1,500'], ['at 65', '$1.9M']] },
    { id: 'unitpro',   title: 'Unit Converter Pro',           author: 'kazad',      cat: 'conversions', uses: '40.7k', rating: 4.9, comments: 310, age: '3h',  hue: 175,
      desc: 'Length, mass, energy, weirdness — all of it.',
      lines: [['16 km → miles', '9.94 mi'], ['3 cups → ml', '710 ml'], ['72°F → C', '22.2°C']] },
    { id: 'loancmp',   title: 'Loan Comparison',              author: 'sarah_m',    cat: 'finance',     uses: '11.1k', rating: 4.7, comments: 45,  age: '2d',  hue: 205,
      desc: '15yr vs 30yr, side by side, no spreadsheet.',
      lines: [['15yr / mo', '$2,741'], ['30yr / mo', '$1,962'], ['interest saved', '$213k']] },
    { id: 'pace',      title: 'Workout Pace Calculator',      author: 'runnerd',    cat: 'health',      uses: '6.3k',  rating: 4.6, comments: 19,  age: '5d',  hue: 130,
      desc: 'Race pace, splits, and finish-time targets.',
      lines: [['10k goal = 52:00', '52:00'], ['pace / km', '5:12'], ['pace / mi', '8:22']] },
    { id: 'solar',     title: 'Solar Panel ROI',              author: 'greenwatt',  cat: 'home',        uses: '4.9k',  rating: 4.5, comments: 31,  age: '1w',  hue: 55,
      desc: 'Payback period for a rooftop install.',
      lines: [['install = 18k', '18,000'], ['savings/yr', '1,750'], ['payback', '10.3 yr']] },
    { id: 'gpa',       title: 'GPA Calculator',               author: 'profplum',   cat: 'education',   uses: '13.7k', rating: 4.7, comments: 58,  age: '1d',  hue: 285,
      desc: 'Weighted credits, semester and cumulative.',
      lines: [['credits = 16', '16'], ['points = 54.4', '54.4'], ['GPA', '3.40']] },
    { id: 'tripbudget',title: 'Currency Trip Budget',         author: 'nomadic',    cat: 'travel',      uses: '5.7k',  rating: 4.6, comments: 14,  age: '3d',  hue: 330,
      desc: 'Daily budget in their money and yours.',
      lines: [['budget = €85/day', '€85'], ['days = 12', '12'], ['total', '$1,118']] },
  ];

  IC.DEMO = `# Party budget 🎉
guests = 30
costPerPerson = 18
food = guests * costPerPerson
venue = 250
music = 120
total = food + venue + music
perGuest = total / guests`;

  IC.DEMO_TITLE = 'Party Budget';

  /* ---------------- helpers ---------------- */

  IC.esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  IC.cat = id => IC.CATEGORIES.find(c => c.id === id) || { name: id, icon: '📐' };

  IC.fmt = v => {
    const a = Math.abs(v);
    if (a >= 1e12) return v.toExponential(2);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 4 : 2 });
  };

  /* the tiny live evaluator: `name = expr` lines, %, $ and , tolerated */
  IC.evalText = function (text) {
    const scope = {};
    return text.split('\n').map(line => {
      const t = line.trim();
      if (!t || /^(#|\/\/)/.test(t)) return { txt: '', cls: '' };
      let expr = t, name = null;
      const m = t.match(/^([a-zA-Z_$][\w$]*)\s*=(?!=)\s*(.+)$/);
      if (m) { name = m[1]; expr = m[2]; }
      expr = expr
        .replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
        .replace(/[$,]/g, '')
        .replace(/\^/g, '**');
      try {
        const keys = Object.keys(scope);
        const fn = new Function(...keys, 'sqrt', 'abs', 'round', 'floor', 'ceil', 'min', 'max', 'pow', 'log', 'PI', 'E',
          '"use strict"; return (' + expr + ');');
        const v = fn(...keys.map(k => scope[k]),
          Math.sqrt, Math.abs, Math.round, Math.floor, Math.ceil, Math.min, Math.max, Math.pow, Math.log, Math.PI, Math.E);
        if (typeof v !== 'number' || !isFinite(v)) throw new Error('nan');
        if (name) scope[name] = v;
        return { txt: IC.fmt(v), cls: 'r' };
      } catch (e) {
        return { txt: '· · ·', cls: 'err' };
      }
    });
  };

  /* live editor component: textarea + aligned result column */
  IC.editor = function (cls, text) {
    return `<div class="ic-calc ${cls || ''}"><textarea spellcheck="false">${IC.esc(text || IC.DEMO)}</textarea><div class="ic-out"></div></div>`;
  };

  IC.bind = function (root) {
    root.querySelectorAll('.ic-calc').forEach(c => {
      const ta = c.querySelector('textarea'), out = c.querySelector('.ic-out');
      if (!ta || !out) return;
      const run = () => {
        out.innerHTML = IC.evalText(ta.value)
          .map(r => `<div class="${r.cls}">${IC.esc(r.txt)} </div>`).join('');
      };
      ta.addEventListener('input', run);
      ta.addEventListener('scroll', () => { out.scrollTop = ta.scrollTop; });
      run();
    });
  };

  /* static mini preview (gallery thumbnails) */
  IC.mini = function (calc, n) {
    const rows = calc.lines.slice(0, n || 3)
      .map(l => `<div class="ml"><span>${IC.esc(l[0])}</span><b>${IC.esc(l[1])}</b></div>`).join('');
    return `<div class="ic-mini">${rows}</div>`;
  };

  /* card-art thumbnail: theme-neutral panel with mini preview inside */
  IC.thumb = function (calc, cls) {
    return `<div class="ic-thumb ${cls || ''}">${IC.mini(calc)}</div>`;
  };

  /* layout registry */
  IC.LAYOUTS = [];
  IC.define = def => IC.LAYOUTS.push(def);

  return IC;
})();
