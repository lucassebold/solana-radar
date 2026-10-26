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
    if (wh.mode === 'local') notice($('radarNotice'), 'warn', 'Local mode: no webhook configured (PUBLIC_URL is empty), so the radar receives no buys. The ranking works normally.');
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
    var card = h('div', 'alert' + (latest ? ' latest' : ' old'));
    var head = h('div', 'alert-head');
    var left = h('div');
    var tok = h('div', 'token', a.symbol || 'Token');
    if (a.name) tok.appendChild(h('small', null, a.name));
    if (a.kind === 'update') tok.appendChild(h('span', 'tag', 'updated'));
    left.appendChild(tok);
    left.appendChild(h('div', 'mint', a.mint));
    left.appendChild(h('div', 'when', 'buys between ' + hhmmss(a.firstTs) + ' and ' + hhmmss(a.lastTs) + ' · alert ' + ago(a.emittedAt)));
    head.appendChild(left);
    head.appendChild(h('span', 'badge', a.walletCount + ' wallets'));
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

  function render() { renderPill(); renderSummary(); renderAlerts(); renderRanking(); }
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
