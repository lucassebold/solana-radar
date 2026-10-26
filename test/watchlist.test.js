'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadarApp } = require('../src/app');
const { makeCfg, cand } = require('./util');

let hasSqlite = true;
try { require('node:sqlite'); } catch (e) { hasSqlite = false; }

const ok = () => ({ txs: 100, buys: 20, sells: 20, tokenSwaps: 0, transfersIn: 0, transfersOut: 0, other: 0, spanHours: 5 });
const bad = () => ({ txs: 100, buys: 2, sells: 5, tokenSwaps: 0, transfersIn: 60, transfersOut: 0, other: 0, spanHours: 5 });

// An app wired to fake sources; `spy` counts the external calls so tests can prove none happen once the list is fixed.
function frozenApp(over, cands, perWallet, store) {
  const app = new RadarApp(makeCfg(Object.assign({ watchlistMode: 'frozen', auditEnabled: true, heliusKey: 'k' }, over)), () => {}, store);
  const spy = { fetch: 0, audit: 0 };
  app.fetchCandidates = async () => { spy.fetch++; return { calls: 1, entries: cands }; };
  app.auditWallet = async (key, wallet) => { spy.audit++; const r = perWallet(wallet); if (r instanceof Error) throw r; return r; };
  app.fetchTokens = async () => new Map();
  return { app, spy };
}

test('watchlist: after the first audit the list is fixed with the clean wallets only', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 20));
  const dirty = new Set([cands[0].wallet, cands[3].wallet]);
  const { app } = frozenApp({ rankingSize: 6 }, cands, w => dirty.has(w) ? bad() : ok());
  await app.refreshRanking();
  assert.ok(app.frozenAt, 'frozen');
  assert.strictEqual(app.status.ranking.frozen, true);
  assert.deepStrictEqual(app.candidates.map(c => c.wallet), [1, 2, 4, 5, 6, 7].map(i => cands[i].wallet), 'the 6 best clean wallets, in order');
  assert.strictEqual(app.candidates.some(c => dirty.has(c.wallet)), false);
});

test('watchlist: once fixed there are no more ranking calls and no more audits', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 20));
  const { app, spy } = frozenApp({ rankingSize: 5 }, cands, () => ok());
  await app.refreshRanking();
  const before = app.candidates.map(c => c.wallet);
  assert.strictEqual(spy.fetch, 1);
  const auditsAfterFirst = spy.audit;
  await app.refreshRanking();
  await app.refreshRanking();
  assert.strictEqual(spy.fetch, 1, 'MadeOnSol is not called again');
  assert.strictEqual(spy.audit, auditsAfterFirst, 'no new history calls');
  assert.deepStrictEqual(app.candidates.map(c => c.wallet), before, 'same wallets');
  assert.strictEqual(app.status.ranking.error, null);
});

test('watchlist: wallets the audit could not check are never fixed into the list', async () => {
  const cands = Array.from({ length: 8 }, (_, i) => cand(i, 20));
  const flaky = new Set([cands[0].wallet, cands[1].wallet]);
  const { app } = frozenApp({ rankingSize: 4, minTracked: 3 }, cands, w => flaky.has(w) ? new Error('Helius history responded 500') : ok());
  await app.refreshRanking();
  assert.ok(app.frozenAt);
  assert.strictEqual(app.candidates.some(c => flaky.has(c.wallet)), false, 'unverified wallets stay out of the fixed list');
  assert.strictEqual(app.candidates.length, 4);
});

test('watchlist: with too few verified wallets nothing is fixed yet and the next refresh tries again', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
  const { app, spy } = frozenApp({ minTracked: 5 }, cands, w => w === cands[0].wallet ? ok() : new Error('Helius history responded 500'));
  await app.refreshRanking();
  assert.strictEqual(app.frozenAt, null, 'not fixed: only 1 verified wallet');
  assert.strictEqual(app.status.ranking.frozen, false);
  await app.refreshRanking();
  assert.strictEqual(spy.fetch, 2, 'tried again');
});

test('watchlist: dynamic mode keeps refreshing (nothing is fixed)', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
  const { app, spy } = frozenApp({ watchlistMode: 'dynamic' }, cands, () => ok());
  await app.refreshRanking();
  await app.refreshRanking();
  assert.strictEqual(app.frozenAt, null);
  assert.strictEqual(spy.fetch, 2);
});

test('watchlist: the credit budget still works on the fixed list (it trims noisy wallets, it never adds new ones)', async () => {
  const cands = Array.from({ length: 12 }, (_, i) => cand(i, 20));
  const { app } = frozenApp({ rankingSize: 12 }, cands, () => ok());
  await app.refreshRanking();
  const fixed = new Set(app.candidates.map(c => c.wallet));
  app.cfg = makeCfg({ watchlistMode: 'frozen', creditsUsedOffset: 895000, minTracked: 3 }); // allowance collapses
  await app._rebalance();
  assert.ok(app.ranking.length < 12, 'trimmed');
  assert.ok(app.ranking.every(r => fixed.has(r.wallet)), 'only wallets from the fixed list');
});

if (hasSqlite) {
  const { Store } = require('../src/store');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'radar-wl-'));
  const rm = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* windows may hold the file briefly */ } };

  test('watchlist: the fixed list survives a restart and no external call is made', async () => {
    const dir = tmp();
    try {
      const cands = Array.from({ length: 8 }, (_, i) => cand(i, 20));
      let store = new Store(dir);
      let { app } = frozenApp({ rankingSize: 5 }, cands, () => ok(), store);
      await app.refreshRanking();
      const chosen = app.candidates.map(c => c.wallet);
      assert.strictEqual(chosen.length, 5);
      store.close();

      store = new Store(dir);
      const second = frozenApp({ rankingSize: 5 }, cands, () => ok(), store);
      second.app._loadWatchlist();
      assert.deepStrictEqual(second.app.candidates.map(c => c.wallet), chosen, 'same wallets, same order');
      assert.ok(second.app.frozenAt);
      await second.app.refreshRanking();
      assert.strictEqual(second.spy.fetch, 0, 'no MadeOnSol call after the restart');
      assert.strictEqual(second.spy.audit, 0, 'no history call after the restart');
      assert.ok(second.app.ranking.length > 0, 'and the watched list is rebuilt from the fixed one');
      store.close();
    } finally { rm(dir); }
  });

  test('watchlist: WATCHLIST_RESET discards the saved list so a new one is chosen', async () => {
    const dir = tmp();
    try {
      const cands = Array.from({ length: 8 }, (_, i) => cand(i, 20));
      let store = new Store(dir);
      let first = frozenApp({ rankingSize: 5 }, cands, () => ok(), store);
      await first.app.refreshRanking();
      store.close();

      store = new Store(dir);
      const fresh = Array.from({ length: 8 }, (_, i) => cand(100 + i, 20));
      const second = frozenApp({ rankingSize: 5, watchlistReset: true }, fresh, () => ok(), store);
      second.app._loadWatchlist();
      assert.strictEqual(second.app.frozenAt, null, 'the saved list was discarded');
      await second.app.refreshRanking();
      assert.strictEqual(second.spy.fetch, 1, 'a new selection was made');
      assert.ok(second.app.candidates.every(c => fresh.some(f => f.wallet === c.wallet)));
      store.close();
    } finally { rm(dir); }
  });
}
