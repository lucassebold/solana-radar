'use strict';
const fs = require('fs');
const path = require('path');

// Checkpoints (ms after the alert) at which the token price is recorded to measure how alerts played out.
const CHECKPOINTS = [['5m', 5 * 60e3], ['15m', 15 * 60e3], ['1h', 3600e3], ['4h', 4 * 3600e3]];
const CHECKPOINT_GRACE_MS = 30 * 60e3; // a checkpoint missed by more than this (e.g. downtime) is skipped, not faked

// SQLite history (built-in node:sqlite, Node 22+). One local file; keep it on a persistent volume in production.
class Store {
  constructor(dir, log) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'radar.db');
    this.log = log || (() => {});
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        signature TEXT NOT NULL, wallet TEXT NOT NULL, mint TEXT NOT NULL,
        side TEXT NOT NULL, sol REAL, tokens REAL, ts INTEGER NOT NULL,
        UNIQUE (signature, wallet, mint, side)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades (mint, side, ts);
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades (ts);
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, side TEXT NOT NULL, mint TEXT NOT NULL, kind TEXT,
        first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, wallet_count INTEGER NOT NULL,
        emitted_at INTEGER NOT NULL, symbol TEXT, name TEXT, buys TEXT NOT NULL, entry_price REAL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_emitted ON alerts (emitted_at);
      CREATE TABLE IF NOT EXISTS alert_prices (
        alert_id TEXT NOT NULL, checkpoint TEXT NOT NULL, ts INTEGER NOT NULL,
        price_native REAL, price_usd REAL,
        PRIMARY KEY (alert_id, checkpoint)
      );
      CREATE TABLE IF NOT EXISTS wallet_activity (
        hour INTEGER NOT NULL, wallet TEXT NOT NULL, events INTEGER NOT NULL,
        PRIMARY KEY (hour, wallet)
      );
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT PRIMARY KEY, events INTEGER NOT NULL DEFAULT 0,
        mgmt_credits INTEGER NOT NULL DEFAULT 0, madeonsol_calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wallet_audit (
        wallet TEXT PRIMARY KEY, audited_at INTEGER NOT NULL,
        txs INTEGER, buys INTEGER, sells INTEGER, token_swaps INTEGER, transfers_in INTEGER, transfers_out INTEGER, other INTEGER,
        flagged INTEGER NOT NULL, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS watchlist (
        wallet TEXT PRIMARY KEY, position INTEGER NOT NULL, frozen_at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, updated_at INTEGER
      );
    `);
    this._insertTrade = this.db.prepare('INSERT OR IGNORE INTO trades (signature, wallet, mint, side, sol, tokens, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.persistent = true;
  }

  // Inserts trades; returns only the ones that were NEW (a redelivered event is dropped here, even across restarts).
  insertTrades(trades) {
    const fresh = [];
    this.db.exec('BEGIN');
    try {
      trades.forEach(t => {
        const r = this._insertTrade.run(t.signature, t.wallet, t.mint, t.side, t.solAmount, t.tokenAmount, t.ts);
        if (r.changes > 0) fresh.push(t);
      });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return fresh;
  }

  tradesSince(sinceTs) {
    return this.db.prepare('SELECT signature, wallet, mint, side, sol AS solAmount, tokens AS tokenAmount, ts FROM trades WHERE ts >= ? ORDER BY ts').all(sinceTs);
  }

  saveAlert(a) {
    this.db.prepare(`
      INSERT INTO alerts (id, side, mint, kind, first_ts, last_ts, wallet_count, emitted_at, symbol, name, buys, entry_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, first_ts = excluded.first_ts, last_ts = excluded.last_ts,
        wallet_count = excluded.wallet_count, buys = excluded.buys,
        symbol = COALESCE(alerts.symbol, excluded.symbol), name = COALESCE(alerts.name, excluded.name),
        entry_price = COALESCE(alerts.entry_price, excluded.entry_price)
    `).run(a.id, a.side, a.mint, a.kind, a.firstTs, a.lastTs, a.walletCount, a.emittedAt, a.symbol, a.name, JSON.stringify(a.buys), a.entryPrice);
  }

  recentAlerts(limit) {
    return this.db.prepare('SELECT * FROM alerts ORDER BY emitted_at DESC LIMIT ?').all(limit).map(r => ({
      id: r.id, side: r.side, mint: r.mint, kind: r.kind, firstTs: r.first_ts, lastTs: r.last_ts,
      walletCount: r.wallet_count, emittedAt: r.emitted_at, symbol: r.symbol, name: r.name,
      buys: JSON.parse(r.buys), entryPrice: r.entry_price
    }));
  }

  saveToken(mint, symbol, name) {
    this.db.prepare('INSERT INTO tokens (mint, symbol, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, updated_at = excluded.updated_at')
      .run(mint, symbol, name, Date.now());
  }

  symbols(mints) {
    const out = new Map();
    const stmt = this.db.prepare('SELECT symbol FROM tokens WHERE mint = ?');
    mints.forEach(m => { const r = stmt.get(m); if (r && r.symbol) out.set(m, r.symbol); });
    return out;
  }

  addPrice(alertId, checkpoint, ts, priceNative, priceUsd) {
    this.db.prepare('INSERT OR IGNORE INTO alert_prices (alert_id, checkpoint, ts, price_native, price_usd) VALUES (?, ?, ?, ?, ?)')
      .run(alertId, checkpoint, ts, priceNative, priceUsd);
  }

  // Alerts that still have checkpoints due at `now`: [{id, mint, emittedAt, due:[checkpoint names]}]
  alertsDueForPrice(now) {
    const maxAge = CHECKPOINTS[CHECKPOINTS.length - 1][1] + CHECKPOINT_GRACE_MS;
    const rows = this.db.prepare('SELECT id, mint, emitted_at FROM alerts WHERE emitted_at >= ?').all(now - maxAge);
    const have = this.db.prepare('SELECT checkpoint FROM alert_prices WHERE alert_id = ?');
    const out = [];
    rows.forEach(r => {
      const done = new Set(have.all(r.id).map(x => x.checkpoint));
      const due = CHECKPOINTS.filter(([name, off]) => !done.has(name) && now >= r.emitted_at + off && now <= r.emitted_at + off + CHECKPOINT_GRACE_MS).map(c => c[0]);
      if (due.length) out.push({ id: r.id, mint: r.mint, emittedAt: r.emitted_at, due });
    });
    return out;
  }

  // Recurring co-buyers: pairs of wallets that bought the same token within `windowMs` of each other,
  // counted in distinct tokens. Only pairs seen together in >= minCount tokens.
  pairs(sinceTs, windowMs, minCount, limit) {
    const rows = this.db.prepare(`
      SELECT a.wallet AS a, b.wallet AS b, COUNT(DISTINCT a.mint) AS n, MAX(MAX(a.ts, b.ts)) AS lastTs
      FROM trades a JOIN trades b
        ON a.mint = b.mint AND a.side = 'buy' AND b.side = 'buy' AND a.wallet < b.wallet
       AND ABS(a.ts - b.ts) <= ? AND a.ts >= ? AND b.ts >= ?
      GROUP BY a.wallet, b.wallet HAVING n >= ?
      ORDER BY n DESC, lastTs DESC LIMIT ?
    `).all(windowMs, sinceTs, sinceTs, minCount, limit);
    const mintsStmt = this.db.prepare(`
      SELECT a.mint AS mint, MAX(MAX(a.ts, b.ts)) AS ts
      FROM trades a JOIN trades b ON a.mint = b.mint AND a.side = 'buy' AND b.side = 'buy'
       AND a.wallet = ? AND b.wallet = ? AND ABS(a.ts - b.ts) <= ? AND a.ts >= ? AND b.ts >= ?
      GROUP BY a.mint ORDER BY ts DESC LIMIT 3
    `);
    return rows.map(r => ({ a: r.a, b: r.b, count: r.n, lastTs: r.lastTs, mints: mintsStmt.all(r.a, r.b, windowMs, sinceTs, sinceTs) }));
  }

  // How past alerts played out: price change from the price at alert time to each checkpoint.
  performance() {
    const rows = this.db.prepare(`
      SELECT a.side AS side, p.checkpoint AS cp, p0.price_native AS p0, p.price_native AS p1
      FROM alerts a
      JOIN alert_prices p0 ON p0.alert_id = a.id AND p0.checkpoint = 'emit'
      JOIN alert_prices p ON p.alert_id = a.id AND p.checkpoint != 'emit'
      WHERE p0.price_native > 0 AND p.price_native > 0
    `).all();
    const acc = {};
    rows.forEach(r => {
      const key = r.side + '|' + r.cp;
      (acc[key] = acc[key] || []).push(r.p1 / r.p0 - 1);
    });
    const out = { buy: [], sell: [] };
    CHECKPOINTS.forEach(([name]) => {
      ['buy', 'sell'].forEach(side => {
        const v = (acc[side + '|' + name] || []).sort((x, y) => x - y);
        if (!v.length) return;
        out[side].push({ checkpoint: name, n: v.length, medianPct: median(v) * 100, positivePct: v.filter(x => x > 0).length / v.length * 100 });
      });
    });
    return out;
  }

  // --- credit / quota accounting ---
  // Webhook events delivered per wallet per hour (used to measure how noisy each wallet really is).
  addActivity(hour, countsByWallet) {
    const stmt = this.db.prepare('INSERT INTO wallet_activity (hour, wallet, events) VALUES (?, ?, ?) ON CONFLICT(hour, wallet) DO UPDATE SET events = events + excluded.events');
    this.db.exec('BEGIN');
    try { countsByWallet.forEach((n, w) => stmt.run(hour, w, n)); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // Measured events/day per wallet over the last `hours`: Map(wallet -> eventsPerDay).
  // A wallet's window starts at its first recorded hour (conservative: quiet wallets look slightly busier).
  // The window is the REAL elapsed time since the wallet's first recorded hour (not whole hours), and wallets observed
  // for less than `minHours` are left out: a few minutes of data say nothing reliable about events/day.
  activityRates(nowMs, hours, minHours) {
    const since = Math.floor(nowMs / 3600e3) - hours;
    const rows = this.db.prepare('SELECT wallet, SUM(events) AS ev, MIN(hour) AS first FROM wallet_activity WHERE hour > ? GROUP BY wallet').all(since);
    const out = new Map();
    rows.forEach(r => {
      const elapsed = Math.min(hours, (nowMs - r.first * 3600e3) / 3600e3);
      if (elapsed < (minHours || 0)) return;
      out.set(r.wallet, r.ev / Math.max(elapsed, 1 / 12) * 24);
    });
    return out;
  }

  // delta: {events, mgmt, calls}; day is YYYY-MM-DD (UTC).
  addUsage(day, delta) {
    this.db.prepare(`INSERT INTO usage (day, events, mgmt_credits, madeonsol_calls) VALUES (?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET events = events + excluded.events, mgmt_credits = mgmt_credits + excluded.mgmt_credits, madeonsol_calls = madeonsol_calls + excluded.madeonsol_calls`)
      .run(day, delta.events || 0, delta.mgmt || 0, delta.calls || 0);
  }

  // Helius credits recorded since a day (inclusive): events (1 credit each) + webhook management credits.
  creditsSince(day) {
    const r = this.db.prepare('SELECT COALESCE(SUM(events), 0) AS ev, COALESCE(SUM(mgmt_credits), 0) AS mg FROM usage WHERE day >= ?').get(day);
    return r.ev + r.mg;
  }

  madeonsolCalls(day) {
    const r = this.db.prepare('SELECT madeonsol_calls AS c FROM usage WHERE day = ?').get(day);
    return r ? r.c : 0;
  }

  // --- frozen watchlist: the wallets chosen once (after the behaviour audit) and kept fixed ---
  loadWatchlist() {
    const rows = this.db.prepare('SELECT wallet, frozen_at, data FROM watchlist ORDER BY position').all();
    if (!rows.length) return null;
    return { frozenAt: rows[0].frozen_at, entries: rows.map(r => JSON.parse(r.data)) };
  }

  saveWatchlist(entries, ts) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM watchlist');
      const stmt = this.db.prepare('INSERT INTO watchlist (wallet, position, frozen_at, data) VALUES (?, ?, ?, ?)');
      entries.forEach((e, i) => stmt.run(e.wallet, i, ts, JSON.stringify(e)));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  clearWatchlist() { this.db.exec('DELETE FROM watchlist'); }

  // --- wallet behaviour audit (cached so each wallet is checked rarely) ---
  // Fresh audits (not older than minAuditedAt) for the given wallets: Map(wallet -> {flagged, reason, auditedAt}).
  getAudits(wallets, minAuditedAt) {
    const out = new Map();
    const stmt = this.db.prepare('SELECT flagged, reason, audited_at FROM wallet_audit WHERE wallet = ? AND audited_at >= ?');
    wallets.forEach(w => { const r = stmt.get(w, minAuditedAt); if (r) out.set(w, { flagged: r.flagged === 1, reason: r.reason, auditedAt: r.audited_at }); });
    return out;
  }

  saveAudit(wallet, m, v, ts) {
    this.db.prepare('INSERT INTO wallet_audit (wallet, audited_at, txs, buys, sells, token_swaps, transfers_in, transfers_out, other, flagged, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET audited_at = excluded.audited_at, txs = excluded.txs, buys = excluded.buys, sells = excluded.sells, token_swaps = excluded.token_swaps, transfers_in = excluded.transfers_in, transfers_out = excluded.transfers_out, other = excluded.other, flagged = excluded.flagged, reason = excluded.reason')
      .run(wallet, ts, m.txs, m.buys, m.sells, m.tokenSwaps, m.transfersIn, m.transfersOut, m.other, v.flag ? 1 : 0, v.reason);
  }

  // Totals of everything audited so far (used to fill the dashboard after a restart).
  auditSummary() {
    const r = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(flagged), 0) AS f, MAX(audited_at) AS t FROM wallet_audit').get();
    return { checked: r.c, flagged: r.f, lastAt: r.t };
  }

  auditsSince(ts) {
    return this.db.prepare('SELECT COUNT(*) AS c FROM wallet_audit WHERE audited_at >= ?').get(ts).c;
  }

  prune(cutoffTs) {
    this.db.prepare('DELETE FROM wallet_audit WHERE audited_at < ?').run(Date.now() - 60 * 86400e3);
    this.db.prepare('DELETE FROM wallet_activity WHERE hour < ?').run(Math.floor(Date.now() / 3600e3) - 24 * 8);
    this.db.prepare('DELETE FROM usage WHERE day < ?').run(new Date(Date.now() - 70 * 86400e3).toISOString().slice(0, 10));
    this.db.prepare('DELETE FROM trades WHERE ts < ?').run(cutoffTs);
    const old = this.db.prepare('SELECT id FROM alerts WHERE emitted_at < ?').all(cutoffTs).map(r => r.id);
    old.forEach(id => {
      this.db.prepare('DELETE FROM alert_prices WHERE alert_id = ?').run(id);
      this.db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
    });
  }

  close() { try { this.db.close(); } catch (e) { /* already closed */ } }
}

function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Used when SQLite is unavailable (old Node, unwritable disk): the radar keeps working, without history.
class NullStore {
  constructor() { this.persistent = false; this.file = null; }
  insertTrades(trades) { return trades; }
  tradesSince() { return []; }
  saveAlert() {}
  recentAlerts() { return []; }
  saveToken() {}
  symbols() { return new Map(); }
  addPrice() {}
  alertsDueForPrice() { return []; }
  pairs() { return []; }
  performance() { return { buy: [], sell: [] }; }
  loadWatchlist() { return null; }
  saveWatchlist() {}
  clearWatchlist() {}
  getAudits() { return new Map(); }
  saveAudit() {}
  auditsSince() { return 0; }
  auditSummary() { return { checked: 0, flagged: 0, lastAt: null }; }
  addActivity() {}
  activityRates() { return new Map(); }
  addUsage() {}
  creditsSince() { return 0; }
  madeonsolCalls() { return 0; }
  prune() {}
  close() {}
}

function openStore(dir, log) {
  try { return new Store(dir, log); } catch (e) {
    (log || console.log)('history disabled (could not open SQLite in ' + dir + '): ' + e.message);
    return new NullStore();
  }
}

module.exports = { Store, NullStore, openStore, CHECKPOINTS };
