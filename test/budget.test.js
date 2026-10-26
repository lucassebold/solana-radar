'use strict';
const B = require('../src/budget');
const { RadarApp } = require('../src/app');
const { normalizeAlpha, normalizeEntry } = require('../src/madeonsol');
const { makeCfg, cand } = require('./util');

const DAY = 24 * 3600 * 1000;
const U = (y, m, d, h) => Date.UTC(y, m - 1, d, h || 0);

test('budget: billing cycle boundaries (UTC)', () => {
  assert.strictEqual(B.cycleStart(U(2026, 10, 26), 1), U(2026, 10, 1));
  assert.strictEqual(B.cycleEnd(U(2026, 10, 26), 1), U(2026, 11, 1));
  assert.strictEqual(B.cycleStart(U(2026, 10, 10), 15), U(2026, 9, 15), 'before the billing day: the cycle started last month');
  assert.strictEqual(B.cycleEnd(U(2026, 10, 10), 15), U(2026, 10, 15));
  assert.strictEqual(B.cycleStart(U(2026, 1, 3), 5), U(2025, 12, 5), 'crosses the year boundary');
});

test('budget: daily allowance spreads the remaining credits over the days left', () => {
  const o = { planCredits: 1000000, budgetFraction: 0.9, billingDay: 1 };
  const start = B.allowancePerDay(Object.assign({ used: 0, now: U(2026, 10, 1) }, o));
  assert.ok(Math.abs(start - 900000 / 31) < 1, 'about 29k/day at the start of a 31-day cycle');
  const mid = B.allowancePerDay(Object.assign({ used: 450000, now: U(2026, 10, 16, 12) }, o));
  assert.ok(Math.abs(mid - 450000 / 15.5) < 1, 'on pace: same allowance');
  const behind = B.allowancePerDay(Object.assign({ used: 800000, now: U(2026, 10, 20) }, o));
  assert.ok(behind < 10000, 'overspent early: allowance shrinks');
  assert.strictEqual(B.allowancePerDay(Object.assign({ used: 950000, now: U(2026, 10, 20) }, o)), 0, 'budget exhausted');
});

test('budget: no binge early in the cycle (capped at 1.5x an even share)', () => {
  const o = { planCredits: 1000000, budgetFraction: 0.9, billingDay: 1, used: 0, now: U(2026, 10, 29) };
  const a = B.allowancePerDay(o); // 900k over ~3 days left would be 300k/day without the cap
  assert.ok(a <= 900000 / 31 * 1.5 + 1);
});

test('budget: calibration = measured events / leaderboard-predicted trades, with a default when data is thin', () => {
  const measured = new Map([['a', 400], ['b', 600]]);
  const lb = new Map([['a', 40], ['b', 60]]);
  assert.strictEqual(B.calibration(['a', 'b'], measured, lb, 10), 10);
  assert.strictEqual(B.calibration(['a', 'b'], new Map([['a', 200], ['b', 300]]), lb, 10), 5);
  assert.strictEqual(B.calibration(['a'], new Map(), lb, 7), 7, 'no measurement yet: default');
  assert.strictEqual(B.calibration(['a'], new Map([['a', 1]]), new Map([['a', 1]]), 7), 7, 'too little evidence: default');
});

test('budget: selectWallets keeps the best wallets that fit, skips noisy ones, still tries smaller ones', () => {
  const rates = { a: 100, b: 5000, c: 100, d: 900, e: 100 };
  const cands = Object.keys(rates).map(w => ({ wallet: w }));
  const r = B.selectWallets({ candidates: cands, rateOf: c => rates[c.wallet], allowance: 2000, maxCount: 10, minTracked: 1, maxShare: 0.5, fill: 0.85 });
  // b alone (5000) exceeds 50% of 2000 -> noisy. room = 1700: a(100)+c(100)+d(900)+e(100) = 1200 fits.
  assert.deepStrictEqual(r.selected.map(c => c.wallet), ['a', 'c', 'd', 'e']);
  assert.deepStrictEqual(r.skippedNoisy.map(c => c.wallet), ['b']);
  const tight = B.selectWallets({ candidates: cands, rateOf: c => rates[c.wallet], allowance: 1000, maxCount: 10, minTracked: 1, maxShare: 0.95, fill: 0.85 });
  // room = 850: a(100) ok, c(100), then d(900) does not fit, e(100) still fits
  assert.deepStrictEqual(tight.selected.map(c => c.wallet), ['a', 'c', 'e']);
});

test('budget: selectWallets respects maxCount and always keeps at least minTracked (cheapest first)', () => {
  const cands = [1, 2, 3, 4, 5, 6].map(i => ({ wallet: 'w' + i }));
  const capped = B.selectWallets({ candidates: cands, rateOf: () => 1, allowance: 1000, maxCount: 3, minTracked: 1, maxShare: 1, fill: 1 });
  assert.strictEqual(capped.selected.length, 3);
  const rates = { w1: 900, w2: 800, w3: 700, w4: 20, w5: 10, w6: 30 };
  const floor = B.selectWallets({ candidates: cands, rateOf: c => rates[c.wallet], allowance: 100, maxCount: 10, minTracked: 3, maxShare: 0.5, fill: 0.85 });
  assert.deepStrictEqual(floor.selected.map(c => c.wallet).sort(), ['w4', 'w5', 'w6'], 'cheapest three, even though the allowance is tiny');
});

test('budget: a webhook edit (100 credits) happens only for a real change, or immediately when over budget', () => {
  const cur = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  assert.strictEqual(B.shouldUpdateWebhook(null, cur, false), true, 'first registration');
  assert.strictEqual(B.shouldUpdateWebhook(cur, cur.slice(), false), false, 'identical');
  assert.strictEqual(B.shouldUpdateWebhook(cur, cur.slice(1).concat(['z']), false), false, 'one swapped: not worth 100 credits');
  assert.strictEqual(B.shouldUpdateWebhook(cur, cur.slice(0, 5).concat(['v', 'w', 'x', 'y', 'z']), false), true, 'half replaced');
  assert.strictEqual(B.shouldUpdateWebhook(cur, cur.slice(1), true), true, 'over budget: trim right away');
});

test('source: alpha entries are converted (fractions to percentages) and missing fields stay null', () => {
  const e = normalizeAlpha({ wallet: 'A'.repeat(40), net_pnl_sol: 6308.4, roi: 4.1458, win_rate: 0.8919, total_buys: 2402, total_sells: 729, last_seen: '2026-10-20T03:47:04+00:00', unknown_realizations: 0 });
  assert.ok(Math.abs(e.roiPct - 414.58) < 1e-6);
  assert.ok(Math.abs(e.winRatePct - 89.19) < 1e-6);
  assert.strictEqual(e.trades, 3131);
  assert.ok(Math.abs(e.tradesPerDay - 3131 / 30) < 1e-9);
  assert.strictEqual(e.lastSeen, Date.parse('2026-10-20T03:47:04+00:00'));
  assert.strictEqual(e.complete, true);
  const m = normalizeAlpha({ wallet: 'A'.repeat(40) });
  assert.strictEqual(m.pnlSol, null);
  assert.strictEqual(m.roiPct, null);
  assert.strictEqual(m.winRatePct, null);
  assert.strictEqual(m.trades, null);
  assert.strictEqual(m.tradesPerDay, null);
  assert.strictEqual(m.lastSeen, null);
  assert.strictEqual(normalizeEntry({ wallet: 'A'.repeat(40), median_hold_minutes_30d: 12 }).holdMinutes, 12);
});

test('source: alpha pool is fetched 100 per call and stops at a short page', async () => {
  const httpMod = require('../src/http');
  const orig = httpMod.request;
  const urls = [];
  const page = n => JSON.stringify({ leaderboard: Array.from({ length: n }, (_, i) => ({ wallet: 'W' + i + 'x'.repeat(40), net_pnl_sol: 10 })) });
  httpMod.request = (m, url) => { urls.push(url); return Promise.resolve({ status: 200, headers: {}, body: page(urls.length < 3 ? 100 : 40) }); };
  delete require.cache[require.resolve('../src/madeonsol')];
  try {
    const { fetchCandidates } = require('../src/madeonsol');
    const res = await fetchCandidates('k', { source: 'alpha', poolSize: 500, minHoldMinutes: 5 });
    assert.strictEqual(res.calls, 3);
    assert.strictEqual(res.entries.length, 240);
    assert.ok(urls[0].indexOf('period=30d') > 0 && urls[0].indexOf('sort=pnl') > 0 && urls[1].indexOf('offset=100') > 0);
  } finally { httpMod.request = orig; delete require.cache[require.resolve('../src/madeonsol')]; }
});

// ---- app-level budget behaviour (no network: fake Helius, fake sources) ----

function fakeHelius() {
  const calls = { ensure: [], del: 0 };
  return { calls, ensureWebhook: async (k, url, s, wallets) => { calls.ensure.push(wallets.slice()); return { action: 'created', id: 'x' }; }, deleteWebhook: async () => { calls.del++; return true; } };
}
function appWith(cfgOver, candidates) {
  const app = new RadarApp(makeCfg(cfgOver), () => {});
  app.helius = fakeHelius();
  app.fetchTokens = async () => new Map();
  app.candidates = candidates;
  return app;
}

test('app budget: watches only as many wallets as the daily allowance can afford', async () => {
  // 60 wallets * 100 trades/day * calibration 10 = 1000 events/day each. The allowance depends on today's date
  // (remaining credits / days left, capped at 1.5x an even share), so the expectation is derived from it.
  const cands = Array.from({ length: 60 }, (_, i) => cand(i, 100));
  const app = appWith({ publicUrl: 'https://example.test' }, cands);
  await app._rebalance();
  const expected = Math.min(50, Math.floor(app.status.budget.allowancePerDay * 0.85 / 1000));
  assert.strictEqual(app.ranking.length, expected);
  assert.ok(app.ranking.length * 1000 <= app.status.budget.allowancePerDay, 'the plan fits inside the allowance');
  assert.deepStrictEqual(app.ranking.map(r => r.wallet), cands.slice(0, app.ranking.length).map(c => c.wallet), 'best wallets first');
  assert.strictEqual(app.helius.calls.ensure.length, 1);
  assert.strictEqual(app.status.budget.tracked, app.ranking.length);
  assert.strictEqual(app._mem.used, 100, 'the webhook creation (100 credits) is counted');
});

test('app budget: a wallet that alone would eat too much of the allowance is skipped', async () => {
  const cands = [cand(0, 5000), cand(1, 50), cand(2, 50), cand(3, 50), cand(4, 50), cand(5, 50)];
  const app = appWith({}, cands); // 5000 * 10 = 50k/day > 15% of ~29k
  await app._rebalance();
  assert.ok(app.ranking.every(r => r.wallet !== cands[0].wallet));
  assert.strictEqual(app.ranking.length, 5);
  assert.strictEqual(app.status.budget.skippedNoisy, 1);
});

test('app budget: hard stop pauses the radar (webhook deleted) and resumes when credits are available', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 10));
  const app = appWith({ publicUrl: 'https://example.test', creditsUsedOffset: 980000 }, cands);
  await app._rebalance();
  assert.strictEqual(app.paused, true);
  assert.strictEqual(app.helius.calls.del, 1);
  assert.strictEqual(app.status.webhook.paused, true);
  assert.strictEqual(app.helius.calls.ensure.length, 0, 'no webhook while paused');
  app.cfg = makeCfg({ publicUrl: 'https://example.test', creditsUsedOffset: 0 }); // new cycle
  await app._rebalance();
  assert.strictEqual(app.paused, false);
  assert.strictEqual(app.helius.calls.ensure.length, 1, 'webhook re-created on resume');
  assert.ok(app.ranking.length > 0);
});

test('app budget: refresh is skipped (not fetched) when our own MadeOnSol daily cap would be exceeded', async () => {
  const app = appWith({ madeonsolDailyLimit: 5, poolSize: 300 }, []);
  let fetched = 0;
  app.fetchCandidates = async () => { fetched++; return { entries: [], calls: 3 }; };
  app._mem.calls = 4; // 4 used + 3 pages > 5
  await app.refreshRanking();
  assert.strictEqual(fetched, 0);
  assert.strictEqual(app.status.ranking.limited, true);
});

test('app budget: candidates are filtered (no profit, or inactive for too long) and counted as API calls', async () => {
  const app = appWith({}, []);
  const now = Date.now();
  const mk = (i, over) => Object.assign(cand(i, 20), over);
  app.fetchCandidates = async () => ({ calls: 3, entries: [
    mk(1, { pnlSol: 50 }), mk(2, { pnlSol: -5 }), mk(3, { pnlSol: null }),
    mk(4, { pnlSol: 70, lastSeen: now - 40 * DAY }), mk(5, { pnlSol: 90, lastSeen: null }), mk(6, { pnlSol: 60 })
  ] });
  await app.refreshRanking();
  assert.deepStrictEqual(app.candidates.map(c => c.pnlSol), [90, 60, 50], 'only profitable and recently active, best first');
  assert.strictEqual(app.callsToday(), 3);
});

test('app budget: a webhook edit is rate-limited, but trimming when over budget is immediate', async () => {
  const cands = Array.from({ length: 30 }, (_, i) => cand(i, 100));
  const app = appWith({ publicUrl: 'https://example.test' }, cands);
  await app._rebalance();
  assert.strictEqual(app.helius.calls.ensure.length, 1);
  await app._rebalance();
  assert.strictEqual(app.helius.calls.ensure.length, 1, 'nothing changed: no edit');
  app.cfg = makeCfg({ publicUrl: 'https://example.test', creditsUsedOffset: 820000 }); // allowance collapses
  await app._rebalance();
  assert.strictEqual(app.helius.calls.ensure.length, 2, 'over budget: trimmed right away');
  assert.ok(app.ranking.length < 24);
});

test('credits: the unit is configurable (per transaction by default, per delivery on request) and deliveries are counted', () => {
  const batch = [{ signature: 'a' }, { signature: 'b' }, { signature: 'c' }, { signature: 'd' }];
  const perEvent = appWith({}, []);
  perEvent.handleWebhook(batch);
  perEvent.handleWebhook(batch);
  assert.strictEqual(perEvent.creditsUsed(), 8, 'default: 1 credit per transaction');
  assert.strictEqual(perEvent.status.webhook.pushesToday, 2);
  assert.strictEqual(perEvent.status.webhook.eventsToday, 8);

  const perPush = appWith({ creditUnit: 'push' }, []);
  perPush.handleWebhook(batch);
  perPush.handleWebhook(batch);
  assert.strictEqual(perPush.creditsUsed(), 2, 'push mode: 1 credit per delivery');
  assert.strictEqual(perPush.status.webhook.eventsToday, 8, 'transactions are still counted for diagnostics');
});
