'use strict';
const { parseTrades } = require('./buyParser');
const { ConvergenceDetector } = require('./detector');
const { fetchRanking } = require('./madeonsol');
const { ensureWebhook } = require('./helius');
const { fetchTokens } = require('./prices');
const { NullStore } = require('./store');

const MAX_ALERTS = 10;
const MIN = 60 * 1000;

// Orchestrates: ranking -> wallet list -> webhook -> trades -> detection -> alerts -> history.
// State lives in memory and is mirrored to the store (SQLite) so it survives restarts.
class RadarApp {
  constructor(cfg, log, store) {
    this.cfg = cfg;
    this.log = log || console.log;
    this.store = store || new NullStore();
    this.fetchTokens = fetchTokens; // injectable in tests
    this.detectors = {
      buy: new ConvergenceDetector({ windowMs: cfg.windowMs, minWallets: cfg.minWallets }),
      sell: new ConvergenceDetector({ windowMs: cfg.windowMs, minWallets: cfg.minWallets })
    };
    this.ranking = [];
    this.walletInfo = new Map(); // address -> ranking entry
    this.alerts = [];            // newest first
    this.pairs = [];             // recurring co-buyers
    this.performance = { buy: [], sell: [] };
    this.listeners = new Set();
    this.status = {
      startedAt: Date.now(),
      ranking: { updatedAt: null, error: null, limited: false, loading: true },
      webhook: { mode: cfg.publicUrl ? 'live' : 'local', registered: false, error: null, lastEventAt: null, eventsToday: 0, eventsDay: dayKey(), warn: false },
      storage: { enabled: this.store.persistent, durable: cfg.durable, retentionDays: cfg.retentionDays }
    };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach(fn => { try { fn(this.snapshot()); } catch (e) { /* client went away */ } }); }

  snapshot() {
    return {
      now: Date.now(), windowMs: this.cfg.windowMs, minWallets: this.cfg.minWallets,
      status: this.status, ranking: this.ranking, alerts: this.alerts,
      pairs: this.pairs, performance: this.performance
    };
  }

  isMonitored(addr) { return this.walletInfo.has(addr); }

  async start() {
    this._restore();
    await this.refreshRanking();
    this._timers = [
      setInterval(() => this.refreshRanking(), this.cfg.rankingRefreshMs),
      setInterval(() => { this.detectors.buy.prune(Date.now()); this.detectors.sell.prune(Date.now()); }, MIN),
      setInterval(() => this.priceJob(), MIN),
      setInterval(() => this.analyticsJob(), 5 * MIN),
      setInterval(() => this.maintenanceJob(), 6 * 3600 * 1000)
    ];
    this._timers.forEach(t => { if (t.unref) t.unref(); });
    this.analyticsJob();
    this.maintenanceJob();
    this.priceJob();
  }

  stop() { (this._timers || []).forEach(clearInterval); }

  // Rebuilds in-memory state from the store after a restart: recent alerts, and the detector windows
  // (so a wave in progress continues and an alert already sent is not sent again).
  _restore() {
    const now = Date.now();
    try {
      const alerts = this.store.recentAlerts(50);
      this.alerts = alerts.slice(0, MAX_ALERTS).map(a => Object.assign({ priceNow: null, sinceEntryPct: null }, a));
      alerts.forEach(a => {
        if (a.lastTs >= now - 4 * this.cfg.windowMs) {
          this.detectors[a.side].restoreAlert(a.mint, { id: a.id.slice(a.side.length + 1), wallets: a.buys.map(b => b.wallet), firstTs: a.firstTs, lastTs: a.lastTs });
        }
      });
      const trades = this.store.tradesSince(now - 2 * this.cfg.windowMs);
      trades.forEach(t => this.detectors[t.side].seed(t));
      if (alerts.length || trades.length) this.log('restored ' + alerts.length + ' alerts and ' + trades.length + ' recent trades from history');
    } catch (e) { this.log('restore error: ' + e.message); }
  }

  async refreshRanking() {
    const st = this.status.ranking;
    try {
      const ranking = await fetchRanking(this.cfg.madeonsolKey, this.cfg.rankingSize);
      if (!ranking.length) throw new Error('Empty ranking');
      this.ranking = ranking;
      this.walletInfo = new Map(ranking.map(r => [r.wallet, r]));
      st.updatedAt = Date.now(); st.error = null; st.limited = false;
      this.log('ranking updated: ' + ranking.length + ' wallets');
      await this._syncWebhook();
    } catch (e) {
      st.error = e.message; st.limited = e.kind === 'limit'; // keeps the previous ranking
      this.log('ranking error: ' + e.message);
    } finally {
      st.loading = false;
      this._emit();
    }
  }

  async _syncWebhook() {
    const wh = this.status.webhook;
    if (!this.cfg.publicUrl) { wh.registered = false; return; }
    try {
      const r = await ensureWebhook(this.cfg.heliusKey, this.cfg.publicUrl + '/webhook/helius', this.cfg.webhookSecret, this.ranking.map(x => x.wallet));
      wh.registered = true; wh.error = null;
      this.log('Helius webhook: ' + r.action);
    } catch (e) {
      wh.registered = false; wh.error = e.message;
      this.log('webhook error: ' + e.message);
    }
  }

  // Receives the webhook body (array of Helius enhanced transactions).
  handleWebhook(txs) {
    if (!Array.isArray(txs)) return 0;
    const wh = this.status.webhook;
    const today = dayKey();
    if (wh.eventsDay !== today) { wh.eventsDay = today; wh.eventsToday = 0; wh.warn = false; }
    wh.eventsToday += txs.length;
    wh.lastEventAt = Date.now();
    wh.warn = wh.eventsToday > this.cfg.dailyEventWarn;

    let all = [];
    txs.forEach(tx => { all = all.concat(parseTrades(tx, a => this.walletInfo.has(a), this.cfg.minBuySol)); });
    let fresh = all;
    try { fresh = this.store.insertTrades(all); } catch (e) { this.log('history write error: ' + e.message); }

    let count = 0;
    fresh.forEach(t => {
      const out = this.detectors[t.side].addBuy(t);
      if (out) { this._publish(t.side, out); count++; }
    });
    this._emit();
    return count;
  }

  _publish(side, out) {
    const a = out.alert;
    const first = a.buys.find(b => b.solAmount > 0 && b.tokenAmount > 0);
    const view = {
      id: side + ':' + a.id, side, kind: out.kind, mint: a.mint, symbol: null, name: null,
      walletCount: a.walletCount, firstTs: a.firstTs, lastTs: a.lastTs, emittedAt: Date.now(),
      entryPrice: first ? first.solAmount / first.tokenAmount : null, // SOL per token paid/received by the first wallet
      priceNow: null, sinceEntryPct: null,
      buys: a.buys.map(b => {
        const w = this.walletInfo.get(b.wallet);
        return { wallet: b.wallet, label: w ? w.name : null, ts: b.ts, solAmount: b.solAmount, signature: b.signature };
      })
    };
    const i = this.alerts.findIndex(x => x.id === view.id);
    if (i >= 0) {
      const old = this.alerts[i];
      Object.assign(view, { symbol: old.symbol, name: old.name, emittedAt: old.emittedAt, priceNow: old.priceNow, sinceEntryPct: old.sinceEntryPct, entryPrice: old.entryPrice || view.entryPrice });
      this.alerts.splice(i, 1);
    }
    this.alerts.unshift(view);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
    this.log('ALERT ' + side + ' ' + out.kind + ': ' + a.walletCount + ' wallets on ' + a.mint);
    try { this.store.saveAlert(view); } catch (e) { this.log('history write error: ' + e.message); }
    this._scheduleAnalytics();

    if (out.kind === 'new' || !view.symbol) this._enrich(view, out.kind === 'new');
  }

  // Looks up symbol/name/price for an alert; records the price at alert time (baseline for the track record).
  async _enrich(view, recordEmit) {
    const info = (await this.fetchTokens([view.mint])).get(view.mint);
    if (!info) return;
    view.symbol = info.symbol; view.name = info.name;
    this._applyPrice(view, info.priceNative);
    try {
      this.store.saveToken(view.mint, info.symbol, info.name);
      this.store.saveAlert(view);
      if (recordEmit && info.priceNative) this.store.addPrice(view.id, 'emit', Date.now(), info.priceNative, info.priceUsd);
    } catch (e) { this.log('history write error: ' + e.message); }
    this._emit();
  }

  _applyPrice(view, priceNative) {
    if (!priceNative) return;
    view.priceNow = priceNative;
    view.sinceEntryPct = view.entryPrice ? (priceNative / view.entryPrice - 1) * 100 : null;
  }

  // Every minute: refresh prices of the alerts on screen and record due checkpoints (5m/15m/1h/4h after the alert).
  async priceJob() {
    try {
      const due = this.store.alertsDueForPrice(Date.now());
      const mints = this.alerts.map(a => a.mint).concat(due.map(d => d.mint));
      if (!mints.length) return;
      const prices = await this.fetchTokens(mints);
      this.alerts.forEach(a => {
        const p = prices.get(a.mint);
        if (!p) return;
        if (!a.symbol) { a.symbol = p.symbol; a.name = p.name; }
        this._applyPrice(a, p.priceNative);
      });
      const now = Date.now();
      due.forEach(d => {
        const p = prices.get(d.mint);
        if (!p || !p.priceNative) return; // unknown price: retry next minute (within the grace period), never record zero
        d.due.forEach(cp => this.store.addPrice(d.id, cp, now, p.priceNative, p.priceUsd));
      });
      this._emit();
    } catch (e) { this.log('price job error: ' + e.message); }
  }

  // Every 5 minutes: recurring co-buyer pairs and the alert track record.
  async analyticsJob() {
    try {
      const since = Date.now() - this.cfg.pairsDays * 24 * 3600 * 1000;
      const pairs = this.store.pairs(since, this.cfg.windowMs, this.cfg.pairsMinCount, 15);
      const mints = Array.from(new Set(pairs.reduce((acc, p) => acc.concat(p.mints.map(m => m.mint)), [])));
      let symbols = this.store.symbols(mints);
      const missing = mints.filter(m => !symbols.has(m));
      if (missing.length) {
        const fetched = await this.fetchTokens(missing);
        fetched.forEach((info, mint) => { if (info.symbol) { symbols.set(mint, info.symbol); this.store.saveToken(mint, info.symbol, info.name); } });
      }
      this.pairs = pairs.map(p => ({
        a: p.a, b: p.b, aLabel: this._label(p.a), bLabel: this._label(p.b), count: p.count, lastTs: p.lastTs,
        mints: p.mints.map(m => ({ mint: m.mint, ts: m.ts, symbol: symbols.get(m.mint) || null }))
      }));
      this.performance = this.store.performance();
      this._emit();
    } catch (e) { this.log('analytics error: ' + e.message); }
  }

  // Refresh pairs/track record shortly after an alert (debounced so a burst of alerts costs one query).
  _scheduleAnalytics() {
    if (this._analyticsTimer) return;
    this._analyticsTimer = setTimeout(() => { this._analyticsTimer = null; this.analyticsJob(); }, 20 * 1000);
    if (this._analyticsTimer.unref) this._analyticsTimer.unref();
  }

  _label(addr) { const w = this.walletInfo.get(addr); return w ? w.name : null; }

  maintenanceJob() {
    try { this.store.prune(Date.now() - this.cfg.retentionDays * 24 * 3600 * 1000); } catch (e) { this.log('maintenance error: ' + e.message); }
  }
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

module.exports = { RadarApp };
