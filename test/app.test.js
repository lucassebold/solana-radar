'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { RadarApp } = require('../src/app');
const { normalizeEntry } = require('../src/madeonsol');
const { sameSet } = require('../src/helius');
const { scrub } = require('../src/http');

const { makeCfg } = require('./util');
const cfg = makeCfg();
const SOL = 1e9;

// Synthetic buy transaction (only inside automated tests; it never reaches the UI).
function txBuy(wallet, mint, sol, ts, sig) {
  return { signature: sig, timestamp: ts, accountData: [
    { account: wallet, nativeBalanceChange: -sol * SOL, tokenBalanceChanges: [
      { userAccount: wallet, mint, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } } ] } ] };
}

function appWith(wallets) {
  const app = new RadarApp(cfg, () => {});
  app.fetchTokens = async () => new Map(); // no network in tests
  app.walletInfo = new Map(wallets.map(w => [w, { wallet: w, name: 'kol-' + w }]));
  return app;
}

test('a webhook with 3 monitored wallets buying the same token publishes 1 alert', () => {
  const app = appWith(['A', 'B', 'C']);
  const t = 1800000000;
  app.handleWebhook([txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 2, t + 30, 's2')]);
  assert.strictEqual(app.alerts.length, 0);
  app.handleWebhook([txBuy('C', 'MINT', 3, t + 60, 's3')]);
  assert.strictEqual(app.alerts.length, 1);
  assert.strictEqual(app.alerts[0].walletCount, 3);
  assert.strictEqual(app.alerts[0].buys[0].label, 'kol-A');
});

test('a redelivered webhook (Helius retry) does not duplicate the alert', () => {
  const app = appWith(['A', 'B', 'C']);
  const t = 1800000000;
  const batch = [txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 1, t + 10, 's2'), txBuy('C', 'MINT', 1, t + 20, 's3')];
  app.handleWebhook(batch);
  app.handleWebhook(batch);
  assert.strictEqual(app.alerts.length, 1);
});

test('buys from wallets outside the ranking are ignored', () => {
  const app = appWith(['A', 'B']);
  const t = 1800000000;
  app.handleWebhook([txBuy('A', 'MINT', 1, t, 's1'), txBuy('B', 'MINT', 1, t + 10, 's2'), txBuy('X', 'MINT', 1, t + 20, 's3')]);
  assert.strictEqual(app.alerts.length, 0);
});

test('an invalid webhook body does not throw', () => {
  const app = appWith(['A']);
  assert.strictEqual(app.handleWebhook({ not: 'an array' }), 0);
  assert.strictEqual(app.handleWebhook(null), 0);
});

test('the daily event counter grows and the volume warning fires', () => {
  const app = appWith(['A']);
  app.cfg = Object.assign({}, cfg, { dailyEventWarn: 2 });
  app.handleWebhook([{ signature: 'a' }, { signature: 'b' }, { signature: 'c' }]);
  assert.strictEqual(app.status.webhook.eventsToday, 3);
  assert.strictEqual(app.status.webhook.warn, true);
});

test('ranking: missing fields become null, never 0', () => {
  const e = normalizeEntry({ wallet: 'W'.repeat(40), name: null, pnl: 12.5 });
  assert.strictEqual(e.pnlSol, 12.5);
  assert.strictEqual(e.roiPct, null);
  assert.strictEqual(e.winRatePct, null);
  assert.strictEqual(e.trades, null);
  const f = normalizeEntry({ wallet: 'W'.repeat(40), pnl: 0, win_rate: 0, buy_count: 3, sell_count: 2 });
  assert.strictEqual(f.pnlSol, 0, 'a real zero stays zero');
  assert.strictEqual(f.trades, 5);
});

test('a ranking error/rate limit keeps the previous ranking and flags the state', async () => {
  // Patch the HTTP client so MadeOnSol answers 429, then reload the modules that captured it.
  const httpMod = require('../src/http');
  const orig = httpMod.request;
  httpMod.request = () => Promise.resolve({ status: 429, headers: {}, body: '{}' });
  delete require.cache[require.resolve('../src/madeonsol')];
  delete require.cache[require.resolve('../src/app')];
  const { RadarApp: Fresh } = require('../src/app');
  const app = new Fresh(cfg, () => {});
  app.ranking = [{ wallet: 'A' }];
  await app.refreshRanking();
  httpMod.request = orig;
  assert.strictEqual(app.status.ranking.limited, true);
  assert.ok(app.status.ranking.error);
  assert.strictEqual(app.ranking.length, 1, 'previous ranking preserved');
});

test('sameSet compares lists regardless of order', () => {
  assert.ok(sameSet(['a', 'b', 'c'], ['c', 'a', 'b']));
  assert.ok(!sameSet(['a', 'b'], ['a', 'c']));
  assert.ok(!sameSet(['a'], ['a', 'b']));
});

test('scrub masks secrets in messages', () => {
  assert.strictEqual(scrub('error with key=abc123 end', ['abc123']), 'error with key=*** end');
});

// --- server: webhook authentication ---
function post(port, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, path: urlPath, method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(body);
  });
}

test('server: a webhook without the right secret gets 401; with it, 200', async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  // Invalid MadeOnSol key on purpose: the server boots, the ranking fails (handled) and the endpoint stays up.
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: require('os').tmpdir() + '/solana-radar-test-' + port, MADEONSOL_API_KEY: 'invalid-test-key', HELIUS_API_KEY: 'invalid-test-key', PUBLIC_URL: 'http://localhost:' + port, WEBHOOK_SECRET: 'test-secret-123456' }),
    stdio: 'ignore'
  });
  try {
    await new Promise(r => setTimeout(r, 1200));
    const noAuth = await post(port, '/webhook/helius', { 'Content-Type': 'application/json' }, '[]');
    const badAuth = await post(port, '/webhook/helius', { 'Content-Type': 'application/json', Authorization: 'wrong' }, '[]');
    const ok = await post(port, '/webhook/helius', { 'Content-Type': 'application/json', Authorization: 'test-secret-123456' }, '[]');
    assert.strictEqual(noAuth, 401);
    assert.strictEqual(badAuth, 401);
    assert.strictEqual(ok, 200);
  } finally { child.kill(); }
});
