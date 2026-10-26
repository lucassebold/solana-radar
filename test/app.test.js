'use strict';
const http = require('http');
const { RadarApp } = require('../src/app');
const { normalizeEntry } = require('../src/madeonsol');
const { sameSet } = require('../src/helius');
const { scrub } = require('../src/http');

const cfg = { publicUrl: '', windowMs: 5 * 60 * 1000, minWallets: 3, minBuySol: 0.01, dailyEventWarn: 30000, rankingSize: 50, rankingRefreshMs: 1e9, madeonsolKey: 'k', heliusKey: 'h', webhookSecret: 's' };
const SOL = 1e9;

// transacao sintetica de compra (so nos testes automaticos; nunca aparece na tela)
function txBuy(wallet, mint, sol, ts, sig) {
  return { signature: sig, timestamp: ts, accountData: [
    { account: wallet, nativeBalanceChange: -sol * SOL, tokenBalanceChanges: [
      { userAccount: wallet, mint, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } } ] } ] };
}

function appWith(wallets) {
  const app = new RadarApp(cfg, () => {});
  app.walletInfo = new Map(wallets.map(w => [w, { wallet: w, name: 'kol-' + w }]));
  return app;
}

test('webhook com 3 carteiras monitoradas comprando o mesmo token publica 1 alerta', () => {
  const app = appWith(['A', 'B', 'C']);
  const t = 1800000000;
  app.handleWebhook([txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 2, t + 30, 's2')]);
  assert.strictEqual(app.alerts.length, 0);
  app.handleWebhook([txBuy('C', 'MINT', 3, t + 60, 's3')]);
  assert.strictEqual(app.alerts.length, 1);
  assert.strictEqual(app.alerts[0].walletCount, 3);
  assert.strictEqual(app.alerts[0].buys[0].label, 'kol-A');
});

test('reenvio do mesmo webhook (retry da Helius) nao duplica alerta', () => {
  const app = appWith(['A', 'B', 'C']);
  const t = 1800000000;
  const batch = [txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 1, t + 10, 's2'), txBuy('C', 'MINT', 1, t + 20, 's3')];
  app.handleWebhook(batch);
  app.handleWebhook(batch);
  assert.strictEqual(app.alerts.length, 1);
});

test('compras de carteiras fora do ranking sao ignoradas', () => {
  const app = appWith(['A', 'B']);
  const t = 1800000000;
  app.handleWebhook([txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 1, t + 10, 's2'), txBuy('X', 'MINT', 1, t + 20, 's3')]);
  assert.strictEqual(app.alerts.length, 0);
});

test('corpo invalido do webhook nao quebra', () => {
  const app = appWith(['A']);
  assert.strictEqual(app.handleWebhook({ nao: 'array' }), 0);
  assert.strictEqual(app.handleWebhook(null), 0);
});

test('contador de eventos do dia cresce e o aviso de volume dispara', () => {
  const app = appWith(['A']);
  app.cfg = Object.assign({}, cfg, { dailyEventWarn: 2 });
  app.handleWebhook([{ signature: 'a' }, { signature: 'b' }, { signature: 'c' }]);
  assert.strictEqual(app.status.webhook.eventsToday, 3);
  assert.strictEqual(app.status.webhook.warn, true);
});

test('ranking: campos ausentes viram null, nunca 0', () => {
  const e = normalizeEntry({ wallet: 'W'.repeat(40), name: null, pnl: 12.5 });
  assert.strictEqual(e.pnlSol, 12.5);
  assert.strictEqual(e.roiPct, null);
  assert.strictEqual(e.winRatePct, null);
  assert.strictEqual(e.trades, null);
  const f = normalizeEntry({ wallet: 'W'.repeat(40), pnl: 0, win_rate: 0, buy_count: 3, sell_count: 2 });
  assert.strictEqual(f.pnlSol, 0, 'zero real continua zero');
  assert.strictEqual(f.trades, 5);
});

test('erro/limite do ranking mantem o ranking anterior e sinaliza o estado', async () => {
  const httpMod = require('../src/http');
  const orig = httpMod.request;
  httpMod.request = () => Promise.resolve({ status: 429, headers: {}, body: '{}' });
  delete require.cache[require.resolve('../src/madeonsol')];
  delete require.cache[require.resolve('../src/app')];
  const { RadarApp: Fresh } = require('../src/app');
  const app2 = new Fresh(cfg, () => {});
  app2.ranking = [{ wallet: 'A' }];
  await app2.refreshRanking();
  httpMod.request = orig;
  assert.strictEqual(app2.status.ranking.limited, true);
  assert.ok(app2.status.ranking.error);
  assert.strictEqual(app2.ranking.length, 1, 'ranking anterior preservado');
});

test('sameSet compara listas sem depender da ordem', () => {
  assert.ok(sameSet(['a', 'b', 'c'], ['c', 'a', 'b']));
  assert.ok(!sameSet(['a', 'b'], ['a', 'c']));
  assert.ok(!sameSet(['a'], ['a', 'b']));
});

test('scrub remove segredos de mensagens', () => {
  assert.strictEqual(scrub('erro com key=abc123 fim', ['abc123']), 'erro com key=*** fim');
});

// --- servidor: autenticacao do webhook ---
function post(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, path, method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(body);
  });
}

test('servidor: webhook sem o segredo correto recebe 401; com segredo recebe 200', async () => {
  const { spawn } = require('child_process');
  const path = require('path');
  const port = 38000 + Math.floor(Math.random() * 1000);
  // MADEONSOL_API_KEY invalida: o servidor sobe, o ranking falha (erro tratado) e o endpoint continua de pe.
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), MADEONSOL_API_KEY: 'chave-invalida-teste', HELIUS_API_KEY: 'chave-invalida-teste', PUBLIC_URL: 'http://localhost:' + port, WEBHOOK_SECRET: 'segredo-de-teste-123456' }),
    stdio: 'ignore'
  });
  try {
    await new Promise(r => setTimeout(r, 1200));
    const noAuth = await post(port, '/webhook/helius', { 'Content-Type': 'application/json' }, '[]');
    const badAuth = await post(port, '/webhook/helius', { 'Content-Type': 'application/json', Authorization: 'errado' }, '[]');
    const ok = await post(port, '/webhook/helius', { 'Content-Type': 'application/json', Authorization: 'segredo-de-teste-123456' }, '[]');
    assert.strictEqual(noAuth, 401);
    assert.strictEqual(badAuth, 401);
    assert.strictEqual(ok, 200);
  } finally { child.kill(); }
});
