(function () {
  'use strict';
  var state = null;
  var lastFetchOk = 0;
  var BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

  function $(id) { return document.getElementById(id); }
  // All third-party text goes in through textContent (never innerHTML).
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function link(href, text) {
    var a = h('a', null, text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  function short(a) { return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }
  function fmt(n, d) { return n === null || n === undefined ? null : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function hhmmss(ts) { return new Date(ts).toLocaleTimeString('en-US', { hour12: false }); }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return Math.floor(s / 3600) + ' h ago';
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function notice(el, cls, text) { clear(el); if (text) el.appendChild(h('div', 'notice ' + cls, text)); }

  function renderPill() {
    var pill = $('pill'), txt = $('pillText');
    var cls = 'pill pill-wait', msg = 'connecting…';
    if (state) {
      var wh = state.status.webhook, rk = state.status.ranking;
      if (rk.loading) { msg = 'loading data…'; }
      else if (rk.limited) { cls = 'pill pill-err'; msg = 'rate limit reached'; }
      else if (!state.ranking.length) { cls = 'pill pill-err'; msg = 'no ranking'; }
      else if (wh.paused) { cls = 'pill pill-warn'; msg = wh.pausedReason === 'manual' ? 'paused · radar off' : 'paused · credit limit'; }
      else if (wh.mode === 'local') { cls = 'pill pill-warn'; msg = 'local mode · radar off'; }
      else if (wh.error || !wh.registered) { cls = 'pill pill-err'; msg = 'radar error'; }
      else { cls = 'pill pill-ok'; msg = 'live · ~seconds delay'; }
    }
    if (Date.now() - lastFetchOk > 45000 && lastFetchOk) { cls = 'pill pill-err'; msg = 'server unreachable'; }
    pill.className = cls; txt.textContent = msg;
  }

  function renderSummary() {
    $('sumWallets').textContent = state && state.ranking.length ? String(state.ranking.length) : '—';
    $('sumRule').textContent = state ? state.minWallets + '+ in ' + Math.round(state.windowMs / 60000) + ' min' : '—';
  }

  function renderAlerts() {
    var box = $('alerts'), meta = $('radarMeta');
    clear(box);
    if (!state) { box.appendChild(h('div', 'skeleton')); box.appendChild(h('div', 'skeleton')); return; }
    var wh = state.status.webhook;
    renderBudget();
    if (wh.paused && wh.pausedReason === 'manual' && wh.error) notice($('radarNotice'), 'err', 'Paused (RADAR_PAUSED is set) but the webhook could NOT be deleted, so Helius may still be sending events and charging credits: ' + wh.error + '. It is retried every 10 minutes; you can also delete it in the Helius dashboard.');
    else if (wh.paused && wh.pausedReason === 'manual') notice($('radarNotice'), 'warn', 'Radar paused manually (RADAR_PAUSED is set): the webhook is deleted, so no buys arrive and no Helius credits are spent. The ranking keeps updating. Remove the variable and restart to resume.');
    else if (wh.paused) notice($('radarNotice'), 'err', 'Radar paused: the Helius credit budget for this cycle is used up. It resumes automatically when the cycle resets.');
    else if (wh.mode === 'local') notice($('radarNotice'), 'warn', 'Local mode: no webhook configured (PUBLIC_URL is empty), so the radar receives no buys. The ranking works normally.');
    else if (wh.error) notice($('radarNotice'), 'err', 'Helius webhook error: ' + wh.error);
    else if (wh.warn) notice($('radarNotice'), 'warn', 'High event volume today (' + wh.eventsToday + '): it may exceed the free Helius credit limit.');
    else notice($('radarNotice'), '', '');

    meta.textContent = wh.lastEventAt ? 'last buy received ' + ago(wh.lastEventAt) : (wh.registered ? 'waiting for buys…' : '');

    if (!state.alerts.length) {
      box.appendChild(h('div', 'empty', state.status.ranking.loading ? 'Loading…' : 'No alerts yet. The radar fires when ' + state.minWallets + ' or more monitored wallets buy the same token within ' + Math.round(state.windowMs / 60000) + ' min.'));
      return;
    }
    state.alerts.forEach(function (a, i) {
      if (i === 1) box.appendChild(h('div', 'history-title', 'Previous alerts'));
      box.appendChild(alertCard(a, i === 0));
    });
  }

  function alertCard(a, latest) {
    var sell = a.side === 'sell';
    var card = h('div', 'alert' + (sell ? ' sell' : '') + (latest ? ' latest' : ' old'));
    var head = h('div', 'alert-head');
    var left = h('div');
    var tok = h('div', 'token');
    tok.appendChild(h('span', 'side' + (sell ? ' sell' : ''), sell ? 'SELL' : 'BUY'));
    tok.appendChild(document.createTextNode(a.symbol || 'Token'));
    if (a.name) tok.appendChild(h('small', null, a.name));
    if (a.kind === 'update') tok.appendChild(h('span', 'tag', 'updated'));
    left.appendChild(tok);
    left.appendChild(h('div', 'mint', a.mint));
    left.appendChild(h('div', 'when', (sell ? 'sells' : 'buys') + ' between ' + hhmmss(a.firstTs) + ' and ' + hhmmss(a.lastTs) + ' · alert ' + ago(a.emittedAt)));
    left.appendChild(priceLine(a, sell));
    head.appendChild(left);
    head.appendChild(h('span', 'badge' + (sell ? ' sell' : ''), a.walletCount + ' wallets'));
    card.appendChild(head);

    if (BASE58.test(a.mint)) {
      var links = h('div', 'links');
      links.appendChild(link('https://dexscreener.com/solana/' + a.mint, 'Chart (DexScreener)'));
      links.appendChild(link('https://solscan.io/token/' + a.mint, 'Token (Solscan)'));
      card.appendChild(links);
    }
    var buys = h('div', 'buys');
    a.buys.forEach(function (b) {
      var row = h('div', 'buy');
      var w = h('span', 'w');
      w.appendChild(BASE58.test(b.wallet) ? link('https://solscan.io/account/' + b.wallet, short(b.wallet)) : h('span', null, short(b.wallet)));
      if (b.label) w.appendChild(h('span', 'nm', b.label));
      row.appendChild(w);
      row.appendChild(h('span', 'sol', b.solAmount === null ? '— SOL' : fmt(b.solAmount, 2) + ' SOL'));
      row.appendChild(h('span', 't', hhmmss(b.ts)));
      var tx = h('span', 'tx');
      if (BASE58.test(b.signature)) tx.appendChild(link('https://solscan.io/tx/' + b.signature, 'tx'));
      row.appendChild(tx);
      buys.appendChild(row);
    });
    card.appendChild(buys);
    return card;
  }

  // SOL price with 3 significant digits (token prices are tiny), never rounded to 0.
  function fmtPrice(p) { return p === null || p === undefined ? null : Number(p.toPrecision(3)).toString().indexOf('e') >= 0 ? p.toExponential(2) : Number(p.toPrecision(3)).toString(); }

  function priceLine(a, sell) {
    var line = h('div', 'price');
    if (a.sinceEntryPct === null || a.sinceEntryPct === undefined || a.priceNow === null || a.priceNow === undefined) {
      line.textContent = 'price since first ' + (sell ? 'sell' : 'buy') + ': unavailable';
      return line;
    }
    var pct = a.sinceEntryPct;
    line.appendChild(document.createTextNode('since first ' + (sell ? 'sell' : 'buy') + ': '));
    // For a buy alert up is good (green); for a sell alert a drop after the sell is the "good" outcome.
    var good = sell ? pct < 0 : pct > 0;
    var b = h('b', good ? 'pos' : (pct === 0 ? '' : 'neg'), (pct > 0 ? '+' : '') + fmt(pct, 1) + '%');
    line.appendChild(b);
    line.appendChild(document.createTextNode(' · now ' + fmtPrice(a.priceNow) + ' SOL'));
    return line;
  }

  // Helius credit budget: how much of the cycle's credits is used and how many wallets fit.
  function renderBudget() {
    var box = $('budgetLine');
    clear(box);
    var b = state && state.status.budget;
    if (!b || state.status.webhook.mode === 'local') return;
    function item(label, value) {
      var s = h('span', null, label + ' ');
      s.appendChild(h('b', null, value));
      return s;
    }
    box.appendChild(item('watching', b.tracked + ' of ' + b.candidates + ' eligible wallets'));
    box.appendChild(item('credits', fmt(b.used, 0) + ' / ' + fmt(b.planCredits, 0) + ' (' + fmt(b.usedPct, 1) + '%)'));
    if (b.plannedPerDay !== null && b.allowancePerDay !== null) {
      box.appendChild(item('expected', '~' + fmt(b.plannedPerDay, 0) + ' events/day'));
      box.appendChild(item('allowance', fmt(b.allowancePerDay, 0) + '/day'));
    }
    if (b.skippedNoisy) box.appendChild(item('skipped as too noisy', String(b.skippedNoisy)));
    var wh = state.status.webhook;
    box.appendChild(item('today', fmt(wh.eventsToday, 0) + ' transactions in ' + fmt(wh.pushesToday || 0, 0) + ' deliveries'));
    box.appendChild(item('counting', b.creditUnit === 'push' ? '1 credit per delivery' : '1 credit per transaction'));
    var bar = h('div', 'bar');
    var fill = h('i', b.usedPct >= 90 ? 'err' : b.usedPct >= 70 ? 'warn' : '');
    fill.style.width = Math.min(100, b.usedPct) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
  }

  function renderStorage() {
    var el = $('storageNotice');
    if (!state) { notice(el, '', ''); return; }
    var st = state.status.storage;
    if (!st || !st.enabled) notice(el, 'warn', 'History is off (SQLite unavailable): alerts and co-buyer stats will not survive a restart.');
    else if (!st.durable) notice(el, 'warn', 'History is stored on a non-persistent disk: attach a volume to the service or it is lost on every redeploy.');
    else notice(el, '', '');
  }

  function renderPairs() {
    var box = $('pairsBox'), meta = $('pairsMeta');
    clear(box);
    if (!state) return;
    var pairs = state.pairs || [];
    meta.textContent = pairs.length ? pairs.length + ' pairs' : '';
    if (!pairs.length) {
      box.appendChild(h('div', 'empty', 'No recurring pairs yet. They appear once two wallets have bought the same tokens together at least twice.'));
      return;
    }
    var wrap = h('div', 'table-wrap'), table = h('table'), thead = h('thead'), hr = h('tr');
    ['Wallets', 'Tokens together', 'Last together', 'Recent tokens'].forEach(function (t, i) { hr.appendChild(h('th', i === 1 ? 'num' : null, t)); });
    thead.appendChild(hr); table.appendChild(thead);
    var body = h('tbody');
    pairs.forEach(function (p) {
      var tr = h('tr');
      var td = h('td');
      [[p.a, p.aLabel], [p.b, p.bLabel]].forEach(function (w, i) {
        if (i) td.appendChild(document.createTextNode(' + '));
        td.appendChild(BASE58.test(w[0]) ? link('https://solscan.io/account/' + w[0], short(w[0])) : h('span', null, short(w[0])));
        if (w[1]) td.appendChild(h('span', 'nm', w[1]));
      });
      tr.appendChild(td);
      tr.appendChild(h('td', 'num', String(p.count)));
      tr.appendChild(h('td', null, ago(p.lastTs)));
      var tk = h('td', 'tokens wrap');
      p.mints.forEach(function (m) {
        var label = m.symbol || short(m.mint);
        tk.appendChild(BASE58.test(m.mint) ? link('https://dexscreener.com/solana/' + m.mint, label) : h('span', null, label));
      });
      tr.appendChild(tk);
      body.appendChild(tr);
    });
    table.appendChild(body); wrap.appendChild(table); box.appendChild(wrap);
  }

  function renderPerf() {
    var box = $('perfBox');
    clear(box);
    if (!state) return;
    var perf = state.performance || { buy: [], sell: [] };
    if (!perf.buy.length && !perf.sell.length) {
      box.appendChild(h('div', 'empty', 'No track record yet. Prices are recorded 5 min, 15 min, 1 h and 4 h after each alert.'));
      return;
    }
    [['buy', 'Buy alerts'], ['sell', 'Sell alerts']].forEach(function (g) {
      var rows = perf[g[0]];
      if (!rows.length) return;
      box.appendChild(h('div', 'perf-title', g[1]));
      var wrap = h('div', 'table-wrap'), table = h('table'), thead = h('thead'), hr = h('tr');
      ['After alert', 'Alerts measured', 'Median change', 'Higher than at alert'].forEach(function (t, i) { hr.appendChild(h('th', i ? 'num' : null, t)); });
      thead.appendChild(hr); table.appendChild(thead);
      var body = h('tbody');
      rows.forEach(function (r) {
        var tr = h('tr');
        tr.appendChild(h('td', null, r.checkpoint));
        tr.appendChild(h('td', 'num', String(r.n)));
        tr.appendChild(h('td', 'num ' + (r.medianPct > 0 ? 'pos' : r.medianPct < 0 ? 'neg' : ''), (r.medianPct > 0 ? '+' : '') + fmt(r.medianPct, 1) + '%'));
        tr.appendChild(h('td', 'num', fmt(r.positivePct, 0) + '%'));
        body.appendChild(tr);
      });
      table.appendChild(body); wrap.appendChild(table); box.appendChild(wrap);
    });
  }

  function rankMeta() {
    var rk = state.status.ranking;
    $('rankMeta').textContent = rk.updatedAt ? 'updated ' + ago(rk.updatedAt) + ' (' + hhmmss(rk.updatedAt) + ')' : '';
  }

  function renderRanking() {
    var body = $('rankBody');
    clear(body);
    if (!state) { notice($('rankNotice'), '', 'Loading ranking…'); return; }
    var rk = state.status.ranking;
    if (rk.limited) notice($('rankNotice'), 'err', 'MadeOnSol rate limit reached. ' + (state.ranking.length ? 'Showing the last ranking received.' : ''));
    else if (rk.error) notice($('rankNotice'), 'err', 'Error querying MadeOnSol: ' + rk.error + (state.ranking.length ? ' (showing the last ranking received)' : ''));
    else if (rk.loading) notice($('rankNotice'), '', 'Loading ranking…');
    else notice($('rankNotice'), '', '');
    rankMeta();

    state.ranking.forEach(function (r, i) {
      var tr = h('tr');
      tr.appendChild(h('td', 'num na', String(i + 1)));
      var td = h('td');
      var addr = BASE58.test(r.wallet) ? link('https://solscan.io/account/' + r.wallet, short(r.wallet)) : h('span', null, short(r.wallet));
      addr.className = 'addr'; td.appendChild(addr);
      if (r.name) td.appendChild(h('span', 'nm', r.name));
      tr.appendChild(td);
      tr.appendChild(numCell(r.pnlSol, 1, '', true));
      tr.appendChild(numCell(r.roiPct, 1, '%', true));
      tr.appendChild(numCell(r.winRatePct, 1, '%', false));
      tr.appendChild(numCell(r.trades, 0, '', false));
      body.appendChild(tr);
    });
  }

  function numCell(v, d, suffix, signed) {
    var td = h('td', 'num');
    if (v === null || v === undefined) { td.className = 'num na'; td.textContent = '—'; td.title = 'not provided by the source'; return td; }
    td.textContent = (signed && v > 0 ? '+' : '') + fmt(v, d) + suffix;
    if (signed) td.className = 'num ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    return td;
  }

  function render() { renderPill(); renderStorage(); renderSummary(); renderAlerts(); renderPairs(); renderPerf(); renderRanking(); }
  function setState(s) { state = s; lastFetchOk = Date.now(); render(); }

  // Real time over SSE (the browser reconnects by itself); polling every 20 s as a safety net.
  function poll() {
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(setState).catch(function () { renderPill(); });
  }
  if (window.EventSource) {
    var es = new EventSource('/events');
    es.onmessage = function (e) { try { setState(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
  }
  setInterval(poll, 20000);
  poll();
  setInterval(function () { if (state) { renderPill(); renderAlerts(); rankMeta(); } }, 5000);
  render();
})();
