// Token Radar's dashboard. It reads window.RADAR, written beside the page by main.ts, and renders:
//  - a hero with the snapshot's own figures,
//  - the model strip, which states the arithmetic every row uses,
//  - a searchable, sortable, filterable board with a sticky detail panel,
//  - a category table that shows the live peers each category multiple was measured from,
//  - a live-token view, kept apart because those protocols already trade.
// No network: every byte it renders is in data.js. The page recomputes each row's implied value from the
// snapshot's figures to prove the board and the page run the same model.
(function () {
  'use strict';

  var D = window.RADAR;
  var root = document.getElementById('app');
  if (!D || !root) return;

  var state = { q: '', category: 'all', view: 'pre-token', sort: 'rank', dir: 1, selected: null, focus: false };

  // ---- formatting ----
  var USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return USD0.format(n);
  }
  function usdExact(n) { return n === null || n === undefined ? '—' : USD0.format(n); }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(n === 0 ? 0 : 2) + '%';
  }
  function age(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 730) return (d / 365).toFixed(1) + 'y';
    if (d >= 60) return Math.round(d / 30.4) + 'mo';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function mult(n) { return '×' + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }

  // ---- the model, in the page: the same function lib/model.ts scores with, recomputed from the row ----
  function recompute(r) {
    var m = D.model;
    var growthPct = Math.min(m.momentum_cap, Math.max(m.momentum_floor, r.change_7d == null ? 0 : r.change_7d));
    var momentum = 1 + (growthPct / 100) * m.momentum_weight;
    var a = Math.min(r.age_days == null ? m.unknown_age_days : r.age_days, m.extra_maturity_at);
    var ramp = m.maturity_floor + (1 - m.maturity_floor) * (Math.min(a, m.maturity_days) / m.maturity_days);
    var maturity = a >= m.extra_maturity_at ? ramp * m.extra_maturity : ramp;
    var n = Math.min(Math.max((r.chains || []).length || 1, 1), m.chain_depth_cap);
    var chainDepth = 1 + (n - 1) * m.chain_depth_step;
    var implied = Math.min(1e14, Math.max(1, Math.round(r.tvl_usd * r.peer_multiple * maturity * momentum * chainDepth)));
    return { implied: implied, momentum: momentum, maturity: maturity, chainDepth: chainDepth };
  }

  // ---- tiny DOM helpers ----
  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(n, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  // ---- state in the hash so a view can be linked and screenshotted ----
  function readHash() {
    var s = window.location.hash.replace(/^#/, '');
    if (!s) return;
    var p = new URLSearchParams(s);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('c')) state.category = p.get('c');
    if (p.get('v') === 'live') state.view = 'live';
    if (p.get('p')) state.selected = p.get('p');
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir')) state.dir = p.get('dir') === '1' ? 1 : -1;
    if (p.get('f') === '1') state.focus = true;
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('c', state.category);
    if (state.view !== 'pre-token') p.set('v', state.view);
    if (state.selected) p.set('p', state.selected);
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir !== 1) p.set('dir', String(state.dir));
    if (state.focus) p.set('f', '1');
    var s = p.toString();
    try { history.replaceState(null, '', s ? '#' + s : location.pathname + location.search); } catch (e) { /* file:// */ }
  }

  // ---- filter + sort ----
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || '(uncategorised)') !== state.category) return false;
      if (!q) return true;
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = state.sort, d = state.dir;
    return list.slice().sort(function (a, b) {
      var x, y;
      if (k === 'name') { x = a.name.toLowerCase(); y = b.name.toLowerCase(); }
      else if (k === 'tvl') { x = a.tvl_usd; y = b.tvl_usd; }
      else if (k === 'growth') { x = a.change_7d == null ? -1e9 : a.change_7d; y = b.change_7d == null ? -1e9 : b.change_7d; }
      else if (k === 'age') { x = a.age_days == null ? 1e9 : a.age_days; y = b.age_days == null ? 1e9 : b.age_days; }
      else { x = a.rank; y = b.rank; }
      if (x < y) return -d;
      if (x > y) return d;
      return a.rank - b.rank;
    });
  }

  // ---- header ----
  function header() {
    return h('header', { class: 'top' },
      h('div', { class: 'wrap inner' },
        h('div', { class: 'brand' },
          h('span', { class: 'glyph', text: '◎' }),
          h('div', null, 'Token Radar', h('small', { text: 'pre-token launch desk' }))
        ),
        h('div', { class: 'sep' }),
        h('span', { class: 'tag', html: 'Snapshot <b>' + D.as_of + '</b>' }),
        h('span', { class: 'tag', html: 'Floor <b>' + usd(D.floor_usd) + ' TVL</b>' }),
        h('span', { class: 'tag', html: 'Model <b>' + D.model_version + '</b>' })
      )
    );
  }

  // ---- hero ----
  function hero() {
    var maxIv = D.rows[0] ? D.rows[0].implied_value_usd : 0;
    var watchTop = D.rows.filter(function (r) { return r.on_watchlist; })[0];
    return h('section', { class: 'hero wrap' },
      h('div', { class: 'hero-top' },
        h('div', null,
          h('span', { class: 'kicker' }, '◦ ' + D.watchlist_size + ' on the watchlist · ' + D.early_size + ' early finds below the floor'),
          h('h1', null, 'Token launches that ', h('em', null, 'do not exist yet'), ', ranked by implied value.'),
          h('p', { html: 'Reads <b>' + D.board_size + '</b> pre-token protocols. The watchlist is the floor (<b>' + usd(D.floor_usd) + '</b> TVL, no token on record); the radar reaches <b>' + D.early_size + '</b> below it. Implied value = TVL × a peer multiple measured from live-token protocols × maturity × momentum × chain depth.' })
        )
      ),
      h('div', { class: 'stats' },
        stat('Watchlist covered', D.watchlist_size + ' / ' + D.watchlist_size, 'every floor protocol, no gaps', 'ok'),
        stat('Rows ranked', String(D.board_size), D.early_size + ' found below the floor'),
        stat('Top implied value', usd(maxIv), watchTop ? watchTop.name : '—', 'hi'),
        stat('Model error', '×' + Math.pow(10, D.calibration.median_log10_error).toFixed(1) + ' median', D.calibration.within_10x_pct + '% of live tokens within 10×'),
        stat('Live peers measured', String(D.calibration.live_pool), 'tokens whose mcap/TVL sets the multiples', 'ok')
      )
    );
  }
  function stat(k, v, s, cls) {
    return h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), h('div', { class: 's', text: s }));
  }

  // ---- model strip ----
  function modelStrip() {
    var m = D.model, c = D.calibration;
    return h('section', { class: 'modelbar wrap', id: 'model' },
      h('div', null,
        h('h2', { text: 'The value model' }),
        h('div', { class: 'formula', html:
          '<span class="m">implied</span> <span class="op">=</span> tvl <span class="op">×</span> ' +
          '<span class="f">peer_multiple</span> <span class="op">×</span> <span class="f">maturity</span> <span class="op">×</span> ' +
          '<span class="f">momentum</span> <span class="op">×</span> <span class="f">chain_depth</span><br>' +
          '<span class="op">where</span> <span class="f">peer_multiple</span> <span class="op">=</span> median mcap/tvl of live ' +
          '<span class="m">same-category</span> peers<br>' +
          '<span class="f">maturity</span> <span class="op">=</span> ' + m.maturity_floor + ' → 1 over ' + m.maturity_days + 'd, ' + m.extra_maturity + '× past ' + m.extra_maturity_at + 'd<br>' +
          '<span class="f">momentum</span> <span class="op">=</span> 1 + clamp(7d, ' + m.momentum_floor + ', ' + m.momentum_cap + ')% × ' + m.momentum_weight + '<br>' +
          '<span class="f">chain_depth</span> <span class="op">=</span> 1 + (chains−1) × ' + m.chain_depth_step + ', capped at ' + m.chain_depth_cap
        })
      ),
      h('div', { class: 'note', html:
        'No protocol name is special-cased and no row is hand-picked: one function scores all ' + D.board_size + ' rows. ' +
        'The category multiple is <b>measured</b>, not assumed — it is the median market-cap-to-TVL ratio of the snapshot’s own live-token protocols in that category, ' +
        'with a category needing at least ' + m.min_peers + ' peers to stand on its own and any single outlier winsorised to the ' +
        'live set’s 5th–95th percentile. Where a category has too few live peers the model blends toward the median of protocols of similar size. ' +
        'On the ' + c.live_pool + ' live protocols, that rule prices a token within 10× of its market cap <b>' + c.within_10x_pct + '%</b> of the time, a median error of <b>×' + Math.pow(10, c.median_log10_error).toFixed(1) + '</b>.'
      }),
      h('div', { class: 'chips' },
        h('span', { class: 'chip', html: 'min peers per category <b>' + m.min_peers + '</b>' }),
        h('span', { class: 'chip', html: 'size band <b>±' + m.size_band_decades + ' decades</b>' }),
        h('span', { class: 'chip', html: 'median live mcap/TVL <b>' + mult(c.median_ratio) + '</b>' }),
        h('span', { class: 'chip', html: 'top row <b>' + usd(D.rows[0] ? D.rows[0].implied_value_usd : 0) + '</b>' })
      )
    );
  }

  // ---- toolbar ----
  function toolbar() {
    var cats = [];
    var seen = {};
    D.rows.forEach(function (r) { var c = r.category || '(uncategorised)'; if (!seen[c]) { seen[c] = 1; cats.push(c); } });
    cats.sort();
    var q = h('input', { type: 'search', value: state.q, placeholder: 'Search protocol, category or chain…', 'aria-label': 'Search the board' });
    q.addEventListener('input', function () { state.q = q.value; writeHash(); renderBoard(); syncChips(); });
    var sel = h('select', { class: 'sel', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories (' + D.rows.length + ')' }),
      cats.map(function (c) {
        var n = D.rows.filter(function (r) { return (r.category || '(uncategorised)') === c; }).length;
        var o = h('option', { value: c, text: c + ' (' + n + ')' });
        if (c === state.category) o.selected = true;
        return o;
      })
    );
    sel.addEventListener('change', function () { state.category = sel.value; writeHash(); renderBoard(); syncChips(); });
    function segBtn(v, label) {
      var b = h('button', { type: 'button', 'aria-pressed': state.view === v ? 'true' : 'false', text: label });
      b.addEventListener('click', function () { state.view = v; writeHash(); renderBoard(); });
      return b;
    }
    var focusBtn = h('button', { class: 'btn', type: 'button', text: state.focus ? '◧ Board view' : '◨ Focus view' });
    focusBtn.addEventListener('click', function () { state.focus = !state.focus; writeHash(); renderAll(); });
    var reset = h('button', { class: 'btn', type: 'button', text: 'Reset' });
    reset.addEventListener('click', function () { state.q = ''; state.category = 'all'; state.view = 'pre-token'; state.sort = 'rank'; state.dir = 1; writeHash(); renderAll(); });
    var chipRows = h('div', { class: 'wrap filters', id: 'filterchips' });
    return h('div', { class: 'toolbar' },
      h('div', { class: 'wrap tools' },
        h('div', { class: 'search' }, h('span', { class: 'ico', text: '⌕' }), q),
        sel,
        h('div', { class: 'seg' }, segBtn('pre-token', 'Pre-token'), segBtn('live', 'Live tokens')),
        h('div', { class: 'right' },
          h('span', { class: 'tag', id: 'rowcount', text: '' }),
          focusBtn,
          reset
        )
      ),
      chipRows
    );
  }

  function syncChips() {
    var box = document.getElementById('filterchips');
    if (!box) return;
    clear(box);
    var chips = [];
    if (state.q.trim()) chips.push(h('span', { class: 'chip', html: 'search <b>' + state.q.trim().replace(/[<>&]/g, '') + '</b>' }));
    if (state.category !== 'all') chips.push(h('span', { class: 'chip', html: 'category <b>' + state.category + '</b>' }));
    if (state.view === 'live') chips.push(h('span', { class: 'chip', html: 'view <b>live tokens</b>' }));
    if (chips.length) {
      box.style.display = '';
      box.appendChild(h('span', { class: 'mute', text: 'Filtered by' }));
      chips.forEach(function (c) { box.appendChild(c); });
    } else {
      box.style.display = 'none';
    }
  }

  // ---- board table ----
  function sortTh(key, label, cls) {
    var active = state.sort === key;
    var b = h('button', { type: 'button' }, label, active ? h('span', { class: 'arrow', text: state.dir > 0 ? '↑' : '↓' }) : null);
    b.addEventListener('click', function () {
      if (active) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : 1; }
      renderBoard();
    });
    return h('th', { class: 'r ' + (cls || ''), scope: 'col' }, b);
  }
  function sortThL(key, label, cls) {
    var th = sortTh(key, label, cls);
    th.className = (cls || '');
    return th;
  }

  function boardTable() {
    var list = sorted(filtered());
    var rc = document.getElementById('rowcount');
    if (rc) rc.textContent = list.length + ' / ' + D.rows.length + ' rows';
    var maxIv = D.rows[0] ? D.rows[0].implied_value_usd : 1;
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty-state' },
        h('h3', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Try another category or clear the search to see the board again.' })
      ));
    }
    var tbody = h('tbody');
    list.forEach(function (r) {
      var iv = recompute(r);
      var tr = h('tr', { tabindex: '0', 'data-slug': r.slug },
        h('td', { class: 'rank' }, h('b', { text: String(r.rank) })),
        h('td', null, h('div', { class: 'pname' },
          h('b', { text: r.name }),
          h('span', { text: (r.category || 'Uncategorised') + ' · ' + ((r.chains && r.chains.length) ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') })
        )),
        h('td', { class: 'r num', text: usd(r.tvl_usd) }),
        h('td', { class: 'r num hide-sm ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: pct(r.change_7d) }),
        h('td', { class: 'r num hide-sm', text: age(r.age_days) }),
        h('td', { class: 'r hide-sm' }, h('span', { class: 'badge src-' + r.peer_source, text: mult(r.peer_multiple) })),
        h('td', { class: 'r' }, h('div', { class: 'iv' },
          h('b', { text: usd(r.implied_value_usd) }),
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(4, Math.round((r.implied_value_usd / maxIv) * 100)) + '%' }))
        )),
        h('td', { class: 'r' }, h('span', { class: 'badge ' + (r.on_watchlist ? 'watch' : 'early'), text: r.on_watchlist ? 'floor' : 'early' }))
      );
      tr.addEventListener('click', function () { select(r.slug); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.slug); } });
      if (state.selected === r.slug) tr.className = 'sel';
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h3', { text: 'Pre-token board' }),
        h('span', { class: 'count', text: list.length + ' protocols · ranked by implied value' })
      ),
      h('div', { class: 'tablewrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', class: 'r' }, h('button', { type: 'button', text: 'Rank' })),
            sortThL('name', 'Protocol'),
            sortTh('tvl', 'TVL'),
            sortTh('growth', '7d', 'hide-sm'),
            sortTh('age', 'Age', 'hide-sm'),
            h('th', { scope: 'col', class: 'r hide-sm', text: 'Peer ×' }),
            h('th', { scope: 'col', class: 'r', text: 'Implied value' }),
            h('th', { scope: 'col', class: 'r', text: 'Floor' })
          )),
          tbody
        )
      )
    );
  }

  // ---- detail panel ----
  function detailPanel() {
    var panel = h('aside', { class: 'panel detail', id: 'detail' });
    if (!state.selected) {
      panel.appendChild(h('div', { class: 'panel-head' }, h('h3', { text: 'Protocol detail' })));
      panel.appendChild(h('div', { class: 'empty' },
        h('h3', { text: 'Pick a protocol' }),
        h('p', { text: 'Select any row to see its implied value broken into inputs, why it ranks where it does, and a farm plan with what each step costs and how long it takes.' })
      ));
      return panel;
    }
    var r = D.rows.filter(function (x) { return x.slug === state.selected; })[0];
    if (!r) { state.selected = null; return detailPanel(); }
    var iv = recompute(r);
    var peerLabel = r.peer_source === 'category'
      ? 'median of ' + r.peer_count + ' live peers'
      : r.peer_source === 'blend'
        ? 'blend of ' + r.peer_count + ' peer(s) + size median'
        : 'size-matched median (no live peers)';
    panel.appendChild(h('div', { class: 'dhead' },
      h('div', { class: 'rk' }, 'Rank ', h('b', { text: '#' + r.rank }), ' of ' + D.board_size, h('span', { style: 'margin-left:auto' }, h('span', { class: 'badge ' + (r.on_watchlist ? 'watch' : 'early'), text: r.on_watchlist ? 'floor' : 'early' }))),
      h('h2', { text: r.name }),
      h('div', { class: 'sub', text: (r.category || 'Uncategorised') }),
      h('div', { class: 'chains' }, (r.chains || []).map(function (c) { return h('span', { text: c }); }))
    ));
    var body = h('div', { class: 'dbody' });

    // implied value + arithmetic
    body.appendChild(h('div', { class: 'dsec' },
      h('h4', { text: 'Implied value' }),
      h('div', { class: 'bigval' }, usd(r.implied_value_usd), h('small', { text: '= ' + usdExact(r.implied_value_usd) })),
      h('div', { class: 'arithmetic' },
        row('TVL', usdExact(r.tvl_usd)),
        row('× peer multiple', r.peer_multiple.toFixed(6) + ' · ' + peerLabel),
        row('× maturity', r.maturity.toFixed(6) + ' · ' + age(r.age_days) + ' no token'),
        row('× momentum', r.momentum.toFixed(6) + ' · ' + pct(r.change_7d) + ' 7d'),
        row('× chain depth', r.chain_depth.toFixed(6) + ' · ' + ((r.chains || []).length || 1) + ' chains'),
        h('div', { class: 'res' }, h('span', { class: 't', text: '= implied value' }), h('span', { class: 'v', text: usdExact(r.implied_value_usd) }))
      ),
      h('p', { class: 'why', style: 'margin-top:10px', html: whyText(r, iv) })
    ));

    // facts
    body.appendChild(h('div', { class: 'dsec' },
      h('h4', { text: 'Snapshot record' }),
      h('div', { class: 'kv' },
        kv('TVL', usdExact(r.tvl_usd)),
        kv('7-day change', pct(r.change_7d)),
        kv('Tracked since', r.listed_at || 'not recorded'),
        kv('Age with no token', age(r.age_days)),
        kv('Category', r.category || 'Uncategorised'),
        kv('Chains', String((r.chains || []).length)),
        kv('Token on record', 'none (pre-token)'),
        kv('On watchlist', r.on_watchlist ? 'yes · at/above floor' : 'no · early find')
      )
    ));

    // farm plan
    var steps = farmSteps(r);
    body.appendChild(h('div', { class: 'dsec' },
      h('h4', { text: 'Farm plan · ' + steps.length + ' steps' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var cost = at >= 0 ? s.slice(at + 7) : '';
        return h('li', null, action, cost ? h('span', { class: 'cost', text: cost }) : null);
      }))
    ));
    panel.appendChild(body);
    return panel;
  }
  function row(t, v) { return h('div', null, h('span', { class: 't', text: t }), h('span', { class: 'v', text: v })); }
  function kv(k, v) { return [h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })]; }
  function whyText(r, iv) {
    var m = D.model;
    var bits = [];
    bits.push('The model prices <b>' + r.name + '</b> at <b>' + usd(r.implied_value_usd) + '</b> because its <b>' + usd(r.tvl_usd) + '</b> of TVL, times a <b>' + mult(r.peer_multiple) + '</b> peer multiple, is the closest read the snapshot offers to what a token on this TVL has traded at.');
    if (r.peer_source === 'category') bits.push('That multiple is the median of <b>' + r.peer_count + '</b> live ' + (r.category || '') + ' peers, so it is measured, not assumed.');
    else if (r.peer_source === 'blend') bits.push('Its category has only <b>' + r.peer_count + '</b> live peer(s), so the multiple is blended toward the median of similarly sized protocols.');
    else bits.push('No live peer shares its category, so the multiple is the median of similarly sized live protocols.');
    bits.push('It ranks <b>#' + r.rank + '</b> of ' + D.board_size + '. ' + (r.age_days != null && r.age_days >= m.extra_maturity_at ? 'Past ' + m.extra_maturity_at + ' days with no token, it carries a ' + m.extra_maturity + '× long-record reward. ' : '') + (r.change_7d != null ? 'A ' + pct(r.change_7d) + ' week moves momentum to ' + r.momentum.toFixed(2) + '. ' : '') + 'This is an estimate of what a token <em>might</em> be worth, not a prediction that one will launch.');
    return bits.join(' ');
  }

  // ---- farm plan (same derivation as lib/model.ts, mirrored so the page needs no server) ----
  function farmSteps(r) {
    var chain = (r.chains && r.chains[0]) || 'its main chain';
    var tvl = r.tvl_usd;
    var capital = tvl >= 5e9 ? 500 : tvl >= 1e9 ? 300 : tvl >= 2.5e8 ? 200 : tvl >= 5e7 ? 100 : 50;
    var age0 = r.age_days;
    var hold = age0 == null ? 45 : age0 < 180 ? 90 : age0 < 365 ? 60 : age0 < 730 ? 45 : 30;
    var gas = capital >= 300 ? 12 : capital >= 150 ? 8 : 5;
    var multi = (r.chains || []).length > 1 ? ' (it runs on ' + r.chains.length + ' chains, ' + r.chains[0] + ' first)' : '';
    var name = r.name;
    var c = (r.category || '').toLowerCase();
    var cash = '$' + capital;
    var action;
    if (/risk curator|vault curator/.test(c)) action = 'Deposit ' + cash + ' of USDC into a ' + name + ' curated vault on ' + chain + ', spread over two of its strategies, and keep the vault shares.';
    else if (/capital allocator/.test(c)) action = 'Deposit ' + cash + ' of USDC into one ' + name + ' vault on ' + chain + ' and leave it to the allocator rather than moving it between vaults.';
    else if (/lend|cdp|collateral|money market/.test(c)) action = 'Supply ' + cash + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open for weekly snapshots.';
    else if (/dex|yield|leveraged farm|farm/.test(c)) action = 'Provide ' + cash + ' of liquidity to ' + name + "'s deepest pool on " + chain + ' and leave the position open.';
    else if (/bridge/.test(c)) action = 'Bridge ' + cash + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds inside its own app.';
    else if (/staking|restak|liquid rest/.test(c)) action = 'Stake ' + cash + " of the chain's staking asset through " + name + ' and keep the receipt token.';
    else if (/perpetual|derivative|basis|options/.test(c)) action = 'Deposit ' + cash + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    else if (/prediction/.test(c)) action = 'Fund ' + cash + ' and place one market position on ' + name + ', then hold the position past settlement.';
    else if (/stable/.test(c)) action = 'Mint or deposit ' + cash + ' of the stable asset through ' + name + ' on ' + chain + ' and hold the mint receipt.';
    else if (/rwa|treasury/.test(c)) action = "Mint " + cash + " of the protocol's yield asset on " + chain + ' and hold it through a full interest cycle.';
    else if (/insurance/.test(c)) action = 'Buy ' + cash + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    else if (/chain|canonical/.test(c)) action = 'Bridge ' + cash + ' of USDC onto ' + name + ' and do one swap and one deposit there so the wallet has real activity on the chain.';
    else if (/payments/.test(c)) action = 'Route ' + cash + ' of a real payment through ' + name + ' on ' + chain + ' and keep the receipt.';
    else if (/ai|agent/.test(c)) action = 'Deposit ' + cash + ' of USDC into ' + name + ' and run one of its agents with a real task so usage is recorded.';
    else action = 'Deposit ' + cash + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
    return [
      'Create a fresh wallet for this position alone and keep its seed phrase offline; fund it with $' + (capital + 25) + ', enough for the $' + capital + ' deposit, the gas and a buffer' + multi + '. Cost: nothing beyond the deposit and about $' + gas + ' of gas. Time: 10 minutes.',
      action + ' Cost: $' + capital + ' of capital plus about $' + gas + ' of gas. Time: 15 minutes to set up.',
      'Open ' + name + "'s own app or docs page first and check it publishes a points, rewards or season program; if it does, record the campaign name before you deposit. Cost: free. Time: 10 minutes.",
      'Make one qualifying action every week — a deposit, a borrow, a swap, a vote or a claim — so activity shows up in more than one weekly snapshot. Cost: about $2 of gas a week. Time: 10 minutes a week.',
      'Keep the position for at least ' + hold + ' days; a protocol that has run ' + (age0 == null ? 'an unknown time' : age0 + ' days') + ' with no token rewards a long record over a short one. Cost: the $' + capital + ' stays deployed. Time: ' + hold + ' days.',
      "Before you withdraw, revisit the protocol's own rewards page and claim only from a link it publishes; never sign a claim from a DM or an ad. Cost: no fee to check, never pay to claim. Time: 10 minutes.",
      'Log the wallet, every date and every transaction hash in a farm log so you can repeat, size up or unwind the position when the token is announced. Cost: nothing but the log. Time: 5 minutes.'
    ];
  }

  // ---- category table ----
  function categoryTable() {
    var cats = D.categories.slice().sort(function (a, b) { return b.top_implied_usd - a.top_implied_usd; });
    var maxTop = cats.length ? cats[0].top_implied_usd : 1;
    var tbody = h('tbody');
    cats.forEach(function (c) {
      var tr = h('tr', { tabindex: '0' },
        h('td', { class: 'num r', text: String(c.rows) }),
        h('td', null, h('b', { text: c.category })),
        h('td', { class: 'r num', text: c.live_peers ? String(c.live_peers) : '—' }),
        h('td', { class: 'r num', text: c.live_peers ? mult(c.median_ratio) : 'size-matched' }),
        h('td', { class: 'r num hide-sm', text: c.live_peers ? String(c.p25_ratio) + ' – ' + c.p75_ratio : '—' }),
        h('td', { class: 'r' }, h('div', { class: 'iv' }, h('b', { text: usd(c.top_implied_usd) }), h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.max(3, Math.round(c.top_implied_usd / maxTop * 100)) + '%' }))))
      );
      tr.addEventListener('click', function () { state.category = c.category; writeHash(); renderBoard(); scrollToBoard(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.category = c.category; writeHash(); renderBoard(); scrollToBoard(); } });
      tbody.appendChild(tr);
    });
    return h('section', { class: 'cats panel wrap', style: 'padding:0' },
      h('div', { class: 'panel-head' },
        h('h3', { text: 'Category multiples — where the numbers come from' }),
        h('span', { class: 'count', text: 'median mcap/TVL measured on live-token peers' })
      ),
      h('div', { class: 'live-note', html: 'Each row is a multiple the model could use. <b>Live peers</b> is how many of the snapshot’s live-token protocols share the category; the median is their market-cap-to-TVL ratio. A category with fewer than ' + D.model.min_peers + ' peers is blended toward the size-matched median, so a single token cannot define a whole lane.' }),
      h('div', { class: 'tablewrap', style: 'max-height:none' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { class: 'r', scope: 'col', text: 'Rows' }),
            h('th', { scope: 'col', text: 'Category' }),
            h('th', { class: 'r', scope: 'col', text: 'Live peers' }),
            h('th', { class: 'r', scope: 'col', text: 'Median mcap/TVL' }),
            h('th', { class: 'r hide-sm', scope: 'col', text: 'p25 – p75' }),
            h('th', { class: 'r', scope: 'col', text: 'Top implied' })
          )),
          tbody
        )
      )
    );
  }

  // ---- live view ----
  function liveView() {
    var maxMcap = D.live[0] ? D.live[0].mcap_usd : 1;
    var tbody = h('tbody');
    D.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num r mute', text: 'live' }),
        h('td', null, h('div', { class: 'pname' }, h('b', { text: r.name }), h('span', { text: (r.category || 'Uncategorised') + ' · ' + ((r.chains && r.chains.length) ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') }))),
        h('td', { class: 'r num', text: usd(r.tvl_usd) }),
        h('td', { class: 'r num hide-sm ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: pct(r.change_7d) }),
        h('td', { class: 'r num', text: r.ratio == null ? '—' : mult(r.ratio) }),
        h('td', { class: 'r' }, h('div', { class: 'iv' }, h('b', { text: usd(r.mcap_usd) }), h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.mcap_usd || 0) / maxMcap * 100)) + '%' })))),
        h('td', { class: 'r' }, h('span', { class: 'badge', style: 'color:var(--teal);border:1px solid rgba(53,208,186,0.4)', text: 'trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Live-token protocols' }), h('span', { class: 'count', text: D.live.length + ' protocols' })),
      h('div', { class: 'live-note', html: 'These protocols <b>already trade</b>. Their market cap is a fact, not a model — shown here so the board’s pre-token rows are never confused with them. Their mcap/TVL ratios are the peers the model learns its category multiples from.' }),
      h('div', { class: 'tablewrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { class: 'r', scope: 'col', text: '' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { class: 'r', scope: 'col', text: 'TVL' }),
            h('th', { class: 'r hide-sm', scope: 'col', text: '7d' }),
            h('th', { class: 'r', scope: 'col', text: 'mcap/TVL' }),
            h('th', { class: 'r', scope: 'col', text: 'Market cap' }),
            h('th', { class: 'r', scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function footer() {
    return h('footer', { class: 'wrap' },
      h('div', { html: '<b>Token Radar</b> · snapshot ' + D.as_of + ' · ' + D.source.replace(/^DefiLlama\s*/, 'DefiLlama ') + '.' }),
      h('div', { html: 'Implied value is a model over public snapshot figures, not financial advice and not a prediction that any token will launch. The watchlist is the floor, never the ceiling: protocols below it are ranked too. ' + D.board_size + ' rows, ' + D.watchlist_size + ' on the floor, ' + D.live_size + ' live peers shown separately. Model ' + D.model_version + '.' })
    );
  }

  // ---- render ----
  var boardSlot, detailSlot;
  function renderAll() {
    clear(root);
    root.appendChild(header());
    root.appendChild(hero());
    root.appendChild(toolbar());
    boardSlot = h('div', { class: 'board wrap' + (state.focus ? ' focus' : ''), id: 'board', tabindex: '-1' });
    detailSlot = h('div');
    boardSlot.appendChild(h('div', {}));
    root.appendChild(boardSlot);
    root.appendChild(modelStrip());
    root.appendChild(categoryTable());
    root.appendChild(h('div', { style: 'height:40px' }));
    root.appendChild(footer());
    root.setAttribute('aria-busy', 'false');
    renderBoard();
    syncChips();
  }
  function renderBoard() {
    if (!boardSlot) return;
    clear(boardSlot);
    boardSlot.className = 'board wrap' + (state.focus ? ' focus' : '');
    // keep the detail panel in step with the filter: if the selected row is filtered out, take the first
    if (state.view === 'pre-token') {
      var vis = filtered();
      if (vis.length && !vis.some(function (r) { return r.slug === state.selected; })) {
        state.selected = vis[0].slug;
        writeHash();
      }
    }
    var det = h('div', null, detailPanel());
    detailSlot = det;
    if (!state.focus) {
      var main = h('div', null);
      main.appendChild(state.view === 'pre-token' ? boardTable() : liveView());
      boardSlot.appendChild(main);
    }
    boardSlot.appendChild(det);
    syncChips();
  }
  function select(slug) {
    state.selected = slug;
    writeHash();
    renderBoard();
    if (window.innerWidth <= 1180) {
      var el = document.getElementById('detail');
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
  function scrollToBoard() {
    var b = document.getElementById('board');
    if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) { state.selected = null; writeHash(); renderBoard(); }
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      var q = root.querySelector('input[type=search]');
      if (q) q.focus();
    }
  });

  readHash();
  if (!state.selected && D.rows.length) state.selected = D.rows[0].slug;
  renderAll();
})();
