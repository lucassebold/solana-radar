'use strict';
// History tests need the built-in node:sqlite (Node 22.13+).
const fs = require('fs');
const os = require('os');
const path = require('path');

let hasSqlite = true;
try { require('node:sqlite'); } catch (e) { hasSqlite = false; }
if (!hasSqlite) {
  console.log('  (history tests skipped: node:sqlite needs Node 22.13+)');
  return;
}

const { Store, CHECKPOINTS } = require('../src/store');
const { RadarApp } = require('../src/app');
const { parseTrades } = require('../src/buyParser');

const real = require('./fixtures/real_buy.json');
const notBuy = require('./fixtures/not_buy.json');

const MIN = 60 * 1000;
const SOL = 1e9;
const { makeCfg } = require('./util');
const cfg = makeCfg();

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows may keep the file briefly */ } }

// Synthetic transactions (only inside automated tests).
function tx(side, wallet, mint, sol, tokens, tsMs, sig) {
  const sign = side === 'buy' ? 1 : -1;
  return { signature: sig, timestamp: Math.floor(tsMs / 1000), accountData: [
    { account: wallet, nativeBalanceChange: -sign * sol * SOL, tokenBalanceChanges: [
      { userAccount: wallet, mint, rawTokenAmount: { tokenAmount: String(sign * tokens * 1e6), decimals: 6 } } ] } ] };
}
const t = (ms, tag) => ({ ms, sig: 'sig-' + tag + '-' + ms });

function appOn(dir, wallets) {
  const store = new Store(dir);
  const app = new RadarApp(cfg, () => {}, store);
  app.fetchTokens = async () => new Map();
  app.walletInfo = new Map(wallets.map(w => [w, { wallet: w, name: 'kol-' + w }]));
  return { app, store };
}

test('history: parseTrades also detects a sell (captured buy with the sign flipped)', () => {
  const copy = JSON.parse(JSON.stringify(real.tx));
  copy.accountData.forEach(a => {
    if (a.account === real.wallet) a.nativeBalanceChange = Math.abs(a.nativeBalanceChange);
    (a.tokenBalanceChanges || []).forEach(c => {
      if (c.userAccount === real.wallet) c.rawTokenAmount.tokenAmount = String(-Math.abs(Number(c.rawTokenAmount.tokenAmount)));
    });
  });
  const trades = parseTrades(copy, a => a === real.wallet, 0.01);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].side, 'sell');
  assert.ok(trades[0].solAmount > 9 && trades[0].tokenAmount > 0);
  assert.deepStrictEqual(parseTrades(notBuy.tx, a => a === notBuy.wallet, 0.01), [], 'the captured airdrop is neither buy nor sell');
});

test('history: trades are deduplicated, even across store re-opens', () => {
  const dir = tmpDir();
  try {
    let store = new Store(dir);
    const trade = { side: 'buy', wallet: 'A', mint: 'M', solAmount: 1, tokenAmount: 10, signature: 's1', ts: Date.now() };
    assert.strictEqual(store.insertTrades([trade]).length, 1);
    assert.strictEqual(store.insertTrades([trade]).length, 0);
    store.close();
    store = new Store(dir);
    assert.strictEqual(store.insertTrades([trade]).length, 0, 'still a duplicate after a restart');
    store.close();
  } finally { cleanup(dir); }
});

test('history: recurring co-buyer pairs are counted per distinct token, within the window only', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const now = Date.now();
    const mk = (w, m, off, i) => ({ side: 'buy', wallet: w, mint: m, solAmount: 1, tokenAmount: 1, signature: 'p' + i, ts: now - off });
    store.insertTrades([
      mk('A', 'M1', 60 * MIN, 1), mk('B', 'M1', 58 * MIN, 2),   // together on M1
      mk('A', 'M2', 40 * MIN, 3), mk('B', 'M2', 39 * MIN, 4),   // together on M2
      mk('A', 'M3', 30 * MIN, 5), mk('B', 'M3', 20 * MIN, 6),   // 10 min apart: NOT together
      mk('C', 'M1', 10 * MIN, 7)                                 // 48+ min after A/B on M1: not together
    ]);
    const pairs = store.pairs(now - 24 * 3600e3, 5 * MIN, 2, 10);
    assert.strictEqual(pairs.length, 1);
    assert.deepStrictEqual([pairs[0].a, pairs[0].b, pairs[0].count], ['A', 'B', 2]);
    assert.deepStrictEqual(pairs[0].mints.map(m => m.mint).sort(), ['M1', 'M2']);
    assert.strictEqual(store.pairs(now - 24 * 3600e3, 5 * MIN, 3, 10).length, 0, 'minCount filter');
    store.close();
  } finally { cleanup(dir); }
});

test('history: after a restart the last alert is restored and is not raised again', () => {
  const dir = tmpDir();
  try {
    const now = Date.now();
    let { app, store } = appOn(dir, ['A', 'B', 'C', 'D']);
    app.handleWebhook([tx('buy', 'A', 'MINT', 1, 100, now - 60e3, 'a1'), tx('buy', 'B', 'MINT', 1, 100, now - 40e3, 'a2'), tx('buy', 'C', 'MINT', 1, 100, now - 20e3, 'a3')]);
    assert.strictEqual(app.alerts.length, 1);
    store.close();

    // "restart": brand new app over the same database
    ({ app, store } = appOn(dir, ['A', 'B', 'C', 'D']));
    app._restore();
    assert.strictEqual(app.alerts.length, 1, 'last alert is back on screen');
    assert.strictEqual(app.alerts[0].walletCount, 3);
    // Helius redelivers the same events after the restart: no new alert
    app.handleWebhook([tx('buy', 'A', 'MINT', 1, 100, now - 60e3, 'a1'), tx('buy', 'B', 'MINT', 1, 100, now - 40e3, 'a2'), tx('buy', 'C', 'MINT', 1, 100, now - 20e3, 'a3')]);
    assert.strictEqual(app.alerts.length, 1);
    // a 4th wallet in the same wave updates the SAME alert instead of creating a new one
    app.handleWebhook([tx('buy', 'D', 'MINT', 1, 100, now - 5e3, 'a4')]);
    assert.strictEqual(app.alerts.length, 1);
    assert.strictEqual(app.alerts[0].kind, 'update');
    assert.strictEqual(app.alerts[0].walletCount, 4);
    store.close();
  } finally { cleanup(dir); }
});

test('history: a wave in progress continues across a restart', () => {
  const dir = tmpDir();
  try {
    const now = Date.now();
    let { app, store } = appOn(dir, ['A', 'B', 'C']);
    app.handleWebhook([tx('buy', 'A', 'MINT', 1, 100, now - 90e3, 'b1'), tx('buy', 'B', 'MINT', 1, 100, now - 60e3, 'b2')]);
    assert.strictEqual(app.alerts.length, 0);
    store.close();
    ({ app, store } = appOn(dir, ['A', 'B', 'C']));
    app._restore();
    app.handleWebhook([tx('buy', 'C', 'MINT', 1, 100, now - 10e3, 'b3')]);
    assert.strictEqual(app.alerts.length, 1, 'the 2 buys from before the restart count');
    store.close();
  } finally { cleanup(dir); }
});

test('history: 3 wallets selling the same token raise a SELL alert; buys and sells do not mix', () => {
  const dir = tmpDir();
  try {
    const now = Date.now();
    const { app, store } = appOn(dir, ['A', 'B', 'C']);
    app.handleWebhook([tx('buy', 'A', 'M', 1, 100, now - 50e3, 'c1'), tx('buy', 'B', 'M', 1, 100, now - 40e3, 'c2'), tx('sell', 'C', 'M', 1, 100, now - 30e3, 'c3')]);
    assert.strictEqual(app.alerts.length, 0, '2 buys + 1 sell is not a convergence');
    app.handleWebhook([tx('sell', 'A', 'S', 1, 100, now - 20e3, 'd1'), tx('sell', 'B', 'S', 1, 100, now - 15e3, 'd2'), tx('sell', 'C', 'S', 1, 100, now - 10e3, 'd3')]);
    assert.strictEqual(app.alerts.length, 1);
    assert.strictEqual(app.alerts[0].side, 'sell');
    assert.strictEqual(app.alerts[0].mint, 'S');
    store.close();
  } finally { cleanup(dir); }
});

test('history: the alert records the entry price (SOL per token) of the first wallet', () => {
  const dir = tmpDir();
  try {
    const now = Date.now();
    const { app, store } = appOn(dir, ['A', 'B', 'C']);
    app.handleWebhook([tx('buy', 'A', 'M', 2, 1000, now - 30e3, 'e1'), tx('buy', 'B', 'M', 1, 100, now - 20e3, 'e2'), tx('buy', 'C', 'M', 1, 100, now - 10e3, 'e3')]);
    assert.ok(Math.abs(app.alerts[0].entryPrice - 0.002) < 1e-9);
    app._applyPrice(app.alerts[0], 0.003);
    assert.ok(Math.abs(app.alerts[0].sinceEntryPct - 50) < 1e-6, '+50% since the first buy');
    store.close();
  } finally { cleanup(dir); }
});

test('history: checkpoints are due at the right times and a missed one is skipped, not faked', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const now = Date.now();
    const base = { side: 'buy', kind: 'new', firstTs: now, lastTs: now, walletCount: 3, symbol: null, name: null, buys: [], entryPrice: null };
    store.saveAlert(Object.assign({ id: 'buy:X:1', mint: 'X', emittedAt: now - 20 * MIN }, base));   // 5m, 15m due (1h not yet)
    store.saveAlert(Object.assign({ id: 'buy:W:1', mint: 'W', emittedAt: now - 70 * MIN }, base));   // 5m/15m missed (skipped), only 1h due
    store.saveAlert(Object.assign({ id: 'buy:Y:1', mint: 'Y', emittedAt: now - 3 * 3600e3 }, base)); // all missed/expired except 4h not yet
    store.saveAlert(Object.assign({ id: 'buy:Z:1', mint: 'Z', emittedAt: now - 2 * MIN }, base));    // nothing due yet
    let due = store.alertsDueForPrice(now);
    assert.deepStrictEqual(due.map(d => d.id).sort(), ['buy:W:1', 'buy:X:1']);
    assert.deepStrictEqual(due.find(d => d.id === 'buy:X:1').due, ['5m', '15m']);
    assert.deepStrictEqual(due.find(d => d.id === 'buy:W:1').due, ['1h']);
    store.addPrice('buy:X:1', '5m', now, 0.001, null);
    due = store.alertsDueForPrice(now);
    assert.deepStrictEqual(due.find(d => d.id === 'buy:X:1').due, ['15m']);
    assert.strictEqual(CHECKPOINTS.length, 4);
    store.close();
  } finally { cleanup(dir); }
});

test('history: track record = median and % positive of the price change after the alert, per side', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const now = Date.now();
    const base = { side: 'buy', kind: 'new', firstTs: now, lastTs: now, walletCount: 3, symbol: null, name: null, buys: [], entryPrice: null, emittedAt: now };
    const changes = { a: 1.5, b: 0.5, c: 1.1 }; // +50%, -50%, +10% at 1h
    Object.keys(changes).forEach(k => {
      store.saveAlert(Object.assign({ id: 'buy:' + k, mint: k }, base));
      store.addPrice('buy:' + k, 'emit', now, 1, null);
      store.addPrice('buy:' + k, '1h', now, changes[k], null);
    });
    store.saveAlert(Object.assign({ id: 'buy:noprice', mint: 'n' }, base));
    store.addPrice('buy:noprice', 'emit', now, null, null); // unknown price: excluded, not counted as zero
    const perf = store.performance();
    assert.strictEqual(perf.sell.length, 0);
    assert.strictEqual(perf.buy.length, 1);
    assert.strictEqual(perf.buy[0].checkpoint, '1h');
    assert.strictEqual(perf.buy[0].n, 3);
    assert.ok(Math.abs(perf.buy[0].medianPct - 10) < 1e-6);
    assert.ok(Math.abs(perf.buy[0].positivePct - 66.666) < 0.01);
    store.close();
  } finally { cleanup(dir); }
});

test('history: prune removes old trades and alerts but keeps recent ones', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const now = Date.now();
    store.insertTrades([
      { side: 'buy', wallet: 'A', mint: 'M', solAmount: 1, tokenAmount: 1, signature: 'old', ts: now - 100 * 24 * 3600e3 },
      { side: 'buy', wallet: 'A', mint: 'M', solAmount: 1, tokenAmount: 1, signature: 'new', ts: now }
    ]);
    const base = { side: 'buy', kind: 'new', firstTs: 0, lastTs: 0, walletCount: 3, symbol: null, name: null, buys: [], entryPrice: null };
    store.saveAlert(Object.assign({ id: 'buy:old', mint: 'M', emittedAt: now - 100 * 24 * 3600e3 }, base));
    store.saveAlert(Object.assign({ id: 'buy:new', mint: 'M', emittedAt: now }, base));
    store.prune(now - 90 * 24 * 3600e3);
    assert.deepStrictEqual(store.tradesSince(0).map(x => x.signature), ['new']);
    assert.deepStrictEqual(store.recentAlerts(10).map(x => x.id), ['buy:new']);
    store.close();
  } finally { cleanup(dir); }
});

test('history: if SQLite cannot open, the app falls back to no history instead of crashing', () => {
  const { openStore } = require('../src/store');
  const file = path.join(os.tmpdir(), 'radar-notadir-' + Date.now());
  fs.writeFileSync(file, 'x'); // a FILE where a directory is expected
  const s = openStore(path.join(file, 'sub'), () => {});
  try { assert.strictEqual(s.persistent, false); assert.deepStrictEqual(s.pairs(), []); }
  finally { fs.unlinkSync(file); }
});

test('credits: usage is summed from the cycle start only, and MadeOnSol calls are counted per day', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    store.addUsage('2026-09-30', { events: 5000 });            // previous cycle
    store.addUsage('2026-10-02', { events: 1000, mgmt: 100 });
    store.addUsage('2026-10-02', { events: 500, calls: 3 });
    store.addUsage('2026-10-03', { events: 200, calls: 1 });
    assert.strictEqual(store.creditsSince('2026-10-01'), 1800);
    assert.strictEqual(store.madeonsolCalls('2026-10-02'), 3);
    assert.strictEqual(store.madeonsolCalls('2026-10-09'), 0);
    store.close();
  } finally { cleanup(dir); }
});

test('credits: measured events/day per wallet (window starts at the wallet\'s first hour)', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const nowHour = Math.floor(Date.now() / 3600e3);
    const nowMs = (nowHour + 0.5) * 3600e3; // 30 min into the current hour
    store.addActivity(nowHour - 1, new Map([['busy', 100], ['quiet', 2]]));
    store.addActivity(nowHour, new Map([['busy', 100], ['fresh', 50]]));
    const r = store.activityRates(nowMs, 48, 0.5);
    // busy: 200 events over 1.5 h of real time -> 133.3/h -> 3200/day; quiet: 2 events over 1.5 h -> 32/day
    assert.ok(Math.abs(r.get('busy') - 3200) < 1e-6);
    assert.ok(Math.abs(r.get('quiet') - 32) < 1e-6);
    assert.strictEqual(r.has('nobody'), false);
    // fresh: first seen 30 min ago -> exactly at the minimum window, counted: 50 events / 0.5 h -> 2400/day
    assert.ok(Math.abs(r.get('fresh') - 2400) < 1e-6);
    assert.strictEqual(store.activityRates((nowHour + 0.4) * 3600e3, 48, 0.5).has('fresh'), false, 'under 30 min of observation: not trusted yet');
    store.close();
  } finally { cleanup(dir); }
});

test('app budget: wallets that measure noisy are dropped from the watched list, quiet ones stay', async () => {
  const dir = tmpDir();
  try {
    const { cand } = require('./util');
    const store = new Store(dir);
    const app = new RadarApp(makeCfg(), () => {}, store);
    app.fetchTokens = async () => new Map();
    app.candidates = Array.from({ length: 12 }, (_, i) => cand(i, 10)); // predicted ~100 events/day each
    const nowHour = Math.floor(Date.now() / 3600e3);
    // the first 4 wallets turn out to be extremely noisy in reality (2000 events in one hour each, observed for 2+ hours)
    store.addActivity(nowHour - 2, new Map(app.candidates.slice(0, 4).map(c => [c.wallet, 2000])));
    await app._rebalance();
    const tracked = new Set(app.ranking.map(r => r.wallet));
    app.candidates.slice(0, 4).forEach(c => assert.strictEqual(tracked.has(c.wallet), false, 'noisy wallet dropped'));
    app.candidates.slice(4).forEach(c => assert.strictEqual(tracked.has(c.wallet), true, 'quiet wallet kept'));
    assert.strictEqual(app.status.budget.skippedNoisy, 4);
    store.close();
  } finally { cleanup(dir); }
});

test('credits: usage and per-wallet activity buffered in memory are flushed to the store', () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    const app = new RadarApp(makeCfg(), () => {}, store);
    app.fetchTokens = async () => new Map();
    app.walletInfo = new Map([['A', { wallet: 'A' }]]);
    const tx = { signature: 's', timestamp: 1, feePayer: 'A', accountData: [{ account: 'A', nativeBalanceChange: 0 }] };
    app.handleWebhook([tx, tx, tx]);
    assert.strictEqual(app.creditsUsed(), 3, 'buffered events already count');
    app.flushUsage();
    assert.strictEqual(app.creditsUsed(), 3, 'and still count once flushed');
    const rate = store.activityRates(Date.now() + 3600e3, 48, 0).get('A'); // look an hour ahead so the window is >= 1 h
    assert.ok(rate > 0, 'wallet activity persisted (one wallet touched per transaction, not per field)');
    store.close();
  } finally { cleanup(dir); }
});
