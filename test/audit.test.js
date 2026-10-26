'use strict';
const { classifyTx, verdict } = require('../src/audit');
const { RadarApp } = require('../src/app');
const { makeCfg, cand } = require('./util');

const real = require('./fixtures/real_buy.json');
const notBuy = require('./fixtures/not_buy.json');
const WSOL = 'So11111111111111111111111111111111111111112';

// Builds a transaction seen from wallet W: native change in SOL, token changes {mint: amount}.
function tx(W, sol, tokens) {
  return { signature: 's', timestamp: 1000, accountData: [
    { account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: Object.keys(tokens).map(m => ({ userAccount: W, mint: m, rawTokenAmount: { tokenAmount: String(tokens[m] * 1e6), decimals: 6 } })) }
  ] };
}

test('audit: classifies buys, sells, token swaps and plain transfers from balance changes', () => {
  assert.strictEqual(classifyTx(tx('W', -1, { M: 100 }), 'W', 0.01), 'buy');
  assert.strictEqual(classifyTx(tx('W', 1, { M: -100 }), 'W', 0.01), 'sell');
  assert.strictEqual(classifyTx(tx('W', 0, { A: -50, B: 80 }), 'W', 0.01), 'token_swap');
  assert.strictEqual(classifyTx(tx('W', 0, { M: 100 }), 'W', 0.01), 'transfer_in', 'tokens arrive, no SOL spent');
  assert.strictEqual(classifyTx(tx('W', 0, { M: -100 }), 'W', 0.01), 'transfer_out', 'tokens leave, no SOL received');
  assert.strictEqual(classifyTx(tx('W', -0.5, {}), 'W', 0.01), 'other', 'a SOL-only move is not a token action');
  assert.strictEqual(classifyTx(tx('W', 0, { [WSOL]: 5 }), 'W', 0.01), 'other', 'wrapped SOL alone is ignored');
});

test('audit: the captured real buy is a buy and the captured airdrop is a transfer in', () => {
  assert.strictEqual(classifyTx(real.tx, real.wallet, 0.01), 'buy');
  assert.strictEqual(classifyTx(notBuy.tx, notBuy.wallet, 0.01), 'transfer_in');
});

test('audit: verdict flags wallets whose token actions are mostly transfers, in either direction', () => {
  const o = { minActions: 15, maxTransferShare: 0.25 };
  // measured on real wallets: the #1 wallet had 2 buys, 10 sells, 76 transfers in
  const receiver = verdict({ buys: 2, sells: 10, transfersIn: 76, transfersOut: 0 }, o);
  assert.strictEqual(receiver.flag, true);
  assert.ok(/receives tokens/.test(receiver.reason));
  // another had 45 buys, 0 sells, 21 transfers out
  const sender = verdict({ buys: 45, sells: 0, transfersIn: 0, transfersOut: 21 }, o);
  assert.strictEqual(sender.flag, true);
  assert.ok(/sends tokens out/.test(sender.reason));
  // normal traders from the same sample
  assert.strictEqual(verdict({ buys: 37, sells: 23, transfersIn: 0, transfersOut: 0 }, o).flag, false);
  assert.strictEqual(verdict({ buys: 29, sells: 30, transfersIn: 3, transfersOut: 0 }, o).flag, false);
});

test('audit: too little activity is not judged (and therefore not flagged)', () => {
  const v = verdict({ buys: 1, sells: 1, transfersIn: 5, transfersOut: 0 }, { minActions: 15, maxTransferShare: 0.25 });
  assert.strictEqual(v.flag, false);
  assert.ok(/not enough activity/.test(v.reason));
});

// ---- app level: audit wired into the candidate list (no network) ----

const metrics = over => Object.assign({ txs: 100, buys: 20, sells: 20, tokenSwaps: 0, transfersIn: 0, transfersOut: 0, other: 0, spanHours: 5 }, over);

function auditedApp(over, cands, perWallet) {
  const app = new RadarApp(makeCfg(Object.assign({ auditEnabled: true, heliusKey: 'k' }, over)), () => {});
  const seen = [];
  app.auditWallet = async (key, wallet) => { seen.push(wallet); const r = perWallet(wallet); if (r instanceof Error) throw r; return r; };
  app.fetchTokens = async () => new Map();
  app.fetchCandidates = async () => ({ calls: 1, entries: cands });
  return { app, seen };
}

test('audit: pass-through wallets are removed from the candidates, the rest keep their order', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
  const bad = new Set([cands[0].wallet, cands[2].wallet]);
  const { app } = auditedApp({}, cands, w => bad.has(w) ? metrics({ buys: 2, sells: 5, transfersIn: 60 }) : metrics());
  await app.refreshRanking();
  assert.deepStrictEqual(app.candidates.map(c => c.wallet), [cands[1], cands[3], cands[4], cands[5]].map(c => c.wallet));
  assert.strictEqual(app.status.audit.flagged, 2);
  assert.strictEqual(app.flagged.size, 2);
  assert.strictEqual(app._mem.used, 600, 'six history calls at 100 credits each are counted');
});

test('audit: stops looking once it has enough clean wallets (saves calls)', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 20));
  const { app, seen } = auditedApp({ rankingSize: 3 }, cands, () => metrics());
  await app.refreshRanking();
  assert.strictEqual(seen.length, 3, 'only 3 wallets were audited');
  assert.strictEqual(app.candidates.length, 10, 'the unaudited tail is kept after the clean ones');
});

test('audit: a wallet whose history cannot be read is kept (unverified), and a rate limit stops further calls', async () => {
  const cands = Array.from({ length: 5 }, (_, i) => cand(i, 20));
  const limit = Object.assign(new Error('Helius rate limit reached'), { kind: 'limit' });
  const { app, seen } = auditedApp({}, cands, w => w === cands[1].wallet ? limit : metrics());
  await app.refreshRanking();
  assert.strictEqual(seen.length, 2, 'after the rate limit no more calls are made');
  assert.strictEqual(app.candidates.length, 5, 'nobody is dropped because of an error');
  assert.strictEqual(app.status.audit.unverified, 4);
  assert.ok(/rate limit/.test(app.status.audit.error));
});

test('audit: the daily call cap is respected; beyond it wallets stay unverified', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
  const { app, seen } = auditedApp({ auditMaxCallsPerDay: 2 }, cands, () => metrics({ buys: 1, sells: 1, transfersIn: 50 }));
  await app.refreshRanking();
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(app.status.audit.flagged, 2);
  assert.strictEqual(app.candidates.length, 4, 'the 2 audited bad wallets are out, the 4 unaudited ones stay');
});

test('audit: disabled (or no Helius key) means no calls and nothing excluded', async () => {
  const cands = Array.from({ length: 4 }, (_, i) => cand(i, 20));
  const a = auditedApp({ auditEnabled: false }, cands, () => { throw new Error('must not be called'); });
  await a.app.refreshRanking();
  assert.strictEqual(a.app.candidates.length, 4);
  const b = auditedApp({ heliusKey: '' }, cands, () => { throw new Error('must not be called'); });
  await b.app.refreshRanking();
  assert.strictEqual(b.app.candidates.length, 4);
});

test('audit: a watched wallet that the audit later rejects is dropped from the webhook right away', async () => {
  const cands = Array.from({ length: 12 }, (_, i) => cand(i, 20));
  const verdictOf = { current: () => metrics() };
  const { app } = auditedApp({ publicUrl: 'https://example.test' }, cands, w => verdictOf.current(w));
  const calls = [];
  app.helius = { ensureWebhook: async (k, u, s, wallets) => { calls.push(wallets.slice()); return { action: 'updated', id: 'x' }; }, deleteWebhook: async () => true };
  await app.refreshRanking();
  assert.strictEqual(calls.length, 1);
  const victim = cands[0].wallet;
  assert.ok(calls[0].indexOf(victim) >= 0);
  // later the victim is audited again (verdict changed) and now looks like a pass-through wallet
  verdictOf.current = w => w === victim ? metrics({ buys: 1, sells: 1, transfersIn: 80 }) : metrics();
  app._mem.audits = 0;
  app.cfg = makeCfg({ auditEnabled: true, heliusKey: 'k', publicUrl: 'https://example.test', auditMaxAgeHours: 0 });
  await app.refreshRanking();
  assert.strictEqual(calls.length, 2, 'webhook edited immediately even though only 1 wallet changed');
  assert.strictEqual(calls[1].indexOf(victim), -1);
});
