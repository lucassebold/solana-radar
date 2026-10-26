(function () {
  'use strict';
  var state = null;
  var lastFetchOk = 0;
  var BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

  function $(id) { return document.getElementById(id); }
  // Todo texto vindo de terceiros entra por textContent (nunca innerHTML).
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
  function fmt(n, d) { return n === null || n === undefined ? null : n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function hhmmss(ts) { return new Date(ts).toLocaleTimeString('pt-BR'); }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'há ' + s + ' s';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    return 'há ' + Math.floor(s / 3600) + ' h';
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function notice(el, cls, text) { clear(el); if (text) el.appendChild(h('div', 'notice ' + cls, text)); }

  function renderPill() {
    var pill = $('pill'), txt = $('pillText');
    var cls = 'pill pill-wait', msg = 'conectando…';
    if (state) {
      var wh = state.status.webhook, rk = state.status.ranking;
      if (rk.loading) { msg = 'carregando dados…'; }
      else if (rk.limited) { cls = 'pill pill-err'; msg = 'limite de requisições atingido'; }
      else if (!state.ranking.length) { cls = 'pill pill-err'; msg = 'sem ranking'; }
      else if (wh.mode === 'local') { cls = 'pill pill-warn'; msg = 'modo local · radar inativo'; }
      else if (wh.error || !wh.registered) { cls = 'pill pill-err'; msg = 'radar com erro'; }
      else { cls = 'pill pill-ok'; msg = 'ao vivo · atraso ~segundos'; }
    }
    if (Date.now() - lastFetchOk > 45000 && lastFetchOk) { cls = 'pill pill-err'; msg = 'sem conexão com o servidor'; }
    pill.className = cls; txt.textContent = msg;
  }

  function renderSummary() {
    $('sumWallets').textContent = state && state.ranking.length ? String(state.ranking.length) : '—';
    $('sumRule').textContent = state ? state.minWallets + '+ em ' + Math.round(state.windowMs / 60000) + ' min' : '—';
  }

  function renderAlerts() {
    var box = $('alerts'), meta = $('radarMeta');
    clear(box);
    if (!state) { box.appendChild(h('div', 'skeleton')); box.appendChild(h('div', 'skeleton')); return; }
    var wh = state.status.webhook;
    if (wh.mode === 'local') notice($('radarNotice'), 'warn', 'Modo local: sem webhook configurado (PUBLIC_URL vazio), então o radar não recebe compras. O ranking funciona normalmente.');
    else if (wh.error) notice($('radarNotice'), 'err', 'Erro no webhook da Helius: ' + wh.error);
    else if (wh.warn) notice($('radarNotice'), 'warn', 'Volume de eventos alto hoje (' + wh.eventsToday + '): pode estourar o limite grátis de créditos da Helius.');
    else notice($('radarNotice'), '', '');

    meta.textContent = wh.lastEventAt ? 'última compra recebida ' + ago(wh.lastEventAt) : (wh.registered ? 'aguardando compras…' : '');

    if (!state.alerts.length) {
      box.appendChild(h('div', 'empty', state.status.ranking.loading ? 'Carregando…' : 'Nenhum alerta ainda. O radar avisa quando ' + state.minWallets + ' ou mais carteiras monitoradas comprarem o mesmo token em ' + Math.round(state.windowMs / 60000) + ' min.'));
      return;
    }
    state.alerts.forEach(function (a, i) {
      if (i === 1) box.appendChild(h('div', 'history-title', 'Alertas anteriores'));
      box.appendChild(alertCard(a, i === 0));
    });
  }

  function alertCard(a, latest) {
    var card = h('div', 'alert' + (latest ? ' latest' : ' old'));
    var head = h('div', 'alert-head');
    var left = h('div');
    var tok = h('div', 'token', a.symbol || 'Token');
    if (a.name) tok.appendChild(h('small', null, a.name));
    if (a.kind === 'update') tok.appendChild(h('span', 'tag', 'atualizado'));
    left.appendChild(tok);
    left.appendChild(h('div', 'mint', a.mint));
    left.appendChild(h('div', 'when', 'compras entre ' + hhmmss(a.firstTs) + ' e ' + hhmmss(a.lastTs) + ' · alerta ' + ago(a.emittedAt)));
    head.appendChild(left);
    head.appendChild(h('span', 'badge', a.walletCount + ' carteiras'));
    card.appendChild(head);

    if (BASE58.test(a.mint)) {
      var links = h('div', 'links');
      links.appendChild(link('https://dexscreener.com/solana/' + a.mint, 'Gráfico (DexScreener)'));
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

  function renderRanking() {
    var body = $('rankBody'), meta = $('rankMeta');
    clear(body);
    if (!state) { notice($('rankNotice'), '', 'Carregando ranking…'); return; }
    var rk = state.status.ranking;
    if (rk.limited) notice($('rankNotice'), 'err', 'Limite de requisições da MadeOnSol atingido. ' + (state.ranking.length ? 'Mostrando o último ranking obtido.' : ''));
    else if (rk.error) notice($('rankNotice'), 'err', 'Erro ao consultar a MadeOnSol: ' + rk.error + (state.ranking.length ? ' (mostrando o último ranking obtido)' : ''));
    else if (rk.loading) notice($('rankNotice'), '', 'Carregando ranking…');
    else notice($('rankNotice'), '', '');
    meta.textContent = rk.updatedAt ? 'atualizado ' + ago(rk.updatedAt) + ' (' + hhmmss(rk.updatedAt) + ')' : '';

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
    if (v === null || v === undefined) { td.className = 'num na'; td.textContent = '—'; td.title = 'indisponível na fonte'; return td; }
    td.textContent = (signed && v > 0 ? '+' : '') + fmt(v, d) + suffix;
    if (signed) td.className = 'num ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    return td;
  }

  function render() { renderPill(); renderSummary(); renderAlerts(); renderRanking(); }
  function setState(s) { state = s; lastFetchOk = Date.now(); render(); }

  // Tempo real por SSE; se cair, o navegador reconecta sozinho. Polling a cada 20 s como rede de seguranca.
  function poll() {
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(setState).catch(function () { renderPill(); });
  }
  if (window.EventSource) {
    var es = new EventSource('/events');
    es.onmessage = function (e) { try { setState(JSON.parse(e.data)); } catch (err) { /* ignora */ } };
  }
  setInterval(poll, 20000);
  poll();
  setInterval(function () { if (state) { renderPill(); renderAlerts(); $('rankMeta').textContent = state.status.ranking.updatedAt ? 'atualizado ' + ago(state.status.ranking.updatedAt) + ' (' + hhmmss(state.status.ranking.updatedAt) + ')' : ''; } }, 5000);
  render();
})();
