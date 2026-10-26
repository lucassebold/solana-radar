'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadarApp } = require('../src/app');
const { makeCfg, cand } = require('./util');

let hasSqlite = true;
try { require('node:sqlite'); } catch (e) { hasSqlite = false; }

const ok = () => ({ txs: 100, buys: 20, sells: 20, tokenSwaps: 0, transfersIn: 0, transfersOut: 0, other: 0, spanHours: 5 });
const limitError = () => Object.assign(new Error('Helius rate limit reached'), { kind: 'limit' });

function build(over, cands, perWallet, store) {
  const app = new RadarApp(makeCfg(Object.assign({ watchlistMode: 'frozen', auditEnabled: true, heliusKey: 'k' }, over)), () => {}, store);
  const seen = [];
  app.fetchCandidates = async () => ({ calls: 1, entries: cands });
  app.auditWallet = async (key, wallet) => { seen.push(wallet); const r = perWallet(wallet, seen.length); if (r instanceof Error) throw r; return r; };
  app.fetchTokens = async () => new Map();
  return { app, seen };
}

test('freeze guard: a rate limit that cuts the audit short does NOT fix a tiny list (the bug seen in production)', async () => {
  const cands = Array.from({ length: 30 }, (_, i) => cand(i, 20));
  // wallets 0..7 are audited fine, then Helius keeps answering 429
  const { app } = build({ minTracked: 2, rankingSize: 20 }, cands, (w, n) => n <= 8 ? ok() : limitError());
  await app.refreshRanking();
  assert.strictEqual(app.frozenAt, null, 'not fixed: 8 verified wallets would have been fixed forever');
  assert.strictEqual(app.status.ranking.frozen, false);
  assert.strictEqual(app.status.audit.complete, false);
  assert.ok(/rate limit/.test(app.status.audit.error));
  assert.ok(app._retryTimer, 'a retry is scheduled');
  app.stop();
});

test('freeze guard: a single rate-limit answer is retried and the audit goes on', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
  let hits = 0;
  const { app, seen } = build({ minTracked: 2, rankingSize: 6 }, cands, w => (w === cands[2].wallet && hits++ < 2) ? limitError() : ok());
  await app.refreshRanking();
  assert.strictEqual(hits, 3, 'wallet 2 failed twice and succeeded on the third try');
  assert.ok(app.frozenAt, 'the audit completed, so the list is fixed');
  assert.strictEqual(app.candidates.length, 6, 'nobody was lost to the transient limit');
  assert.strictEqual(app.status.audit.unverified, 0);
  assert.strictEqual(seen.length, 8, '6 wallets + 2 retried attempts');
  app.stop();
});

test('freeze guard: hitting the daily call cap does not fix the list either', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 20));
  const { app } = build({ minTracked: 2, rankingSize: 10, auditMaxCallsPerDay: 4 }, cands, () => ok());
  await app.refreshRanking();
  assert.strictEqual(app.frozenAt, null);
  assert.strictEqual(app.status.audit.calls, 4);
  assert.ok(app._retryTimer);
  app.stop();
});

test('freeze guard: an audit that simply ran out of candidates (everything checked) is complete', async () => {
  const cands = Array.from({ length: 4 }, (_, i) => cand(i, 20));
  const { app } = build({ minTracked: 2, rankingSize: 50 }, cands, () => ok());
  await app.refreshRanking();
  assert.ok(app.frozenAt, 'all 4 candidates were checked: nothing was cut short');
  assert.strictEqual(app.status.audit.complete, true);
  assert.strictEqual(app._retryTimer, undefined);
  app.stop();
});

test('freeze guard: only one retry is ever scheduled, and stop() cancels it', async () => {
  const cands = Array.from({ length: 10 }, (_, i) => cand(i, 20));
  const { app } = build({ minTracked: 2, auditMaxCallsPerDay: 2 }, cands, () => ok());
  await app.refreshRanking();
  const first = app._retryTimer;
  assert.ok(first);
  await app.refreshRanking();
  assert.strictEqual(app._retryTimer, first, 'not stacked');
  app.stop();
});

if (hasSqlite) {
  const { Store } = require('../src/store');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'radar-wl2-'));
  const rm = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* windows may hold the file briefly */ } };

  test('freeze guard: the retry continues where the audit stopped, without paying for the same wallets again', async () => {
    const dir = tmp();
    try {
      const cands = Array.from({ length: 8 }, (_, i) => cand(i, 20));
      const store = new Store(dir);
      const first = build({ minTracked: 2, rankingSize: 8, auditMaxCallsPerDay: 3 }, cands, () => ok(), store);
      await first.app.refreshRanking();
      assert.strictEqual(first.app.frozenAt, null);
      assert.strictEqual(first.seen.length, 3);
      first.app.stop();
      // the cap is lifted (next day / bigger cap): a new run on the same database
      const second = build({ minTracked: 2, rankingSize: 8, auditMaxCallsPerDay: 100 }, cands, () => ok(), store);
      await second.app.refreshRanking();
      assert.strictEqual(second.seen.length, 5, 'only the 5 wallets that were not checked yet');
      assert.strictEqual(second.seen.filter(w => first.seen.indexOf(w) >= 0).length, 0, 'no wallet audited twice');
      assert.ok(second.app.frozenAt, 'now it is complete and the list is fixed');
      assert.strictEqual(second.app.candidates.length, 8);
      second.app.stop();
      store.close();
    } finally { rm(dir); }
  });

  test('audit summary: after a restart the dashboard shows the audit totals kept in the database', async () => {
    const dir = tmp();
    try {
      const cands = Array.from({ length: 6 }, (_, i) => cand(i, 20));
      const bad = new Set([cands[1].wallet, cands[4].wallet]);
      let store = new Store(dir);
      const first = build({ minTracked: 2, rankingSize: 6 }, cands, w => bad.has(w) ? { txs: 100, buys: 2, sells: 3, tokenSwaps: 0, transfersIn: 70, transfersOut: 0, other: 0, spanHours: 4 } : ok(), store);
      await first.app.refreshRanking();
      first.app.stop();
      store.close();

      store = new Store(dir);
      const second = build({ minTracked: 2 }, cands, () => ok(), store);
      second.app._loadAuditSummary();
      assert.strictEqual(second.app.status.audit.checked, 6);
      assert.strictEqual(second.app.status.audit.flagged, 2);
      assert.ok(second.app.status.audit.lastRunAt);
      store.close();
    } finally { rm(dir); }
  });
}
