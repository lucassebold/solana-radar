'use strict';
const { parseBuys } = require('./buyParser');
const { ConvergenceDetector } = require('./detector');
const { fetchRanking } = require('./madeonsol');
const { ensureWebhook } = require('./helius');
const tokenInfo = require('./tokenInfo');

const MAX_ALERTS = 10;

// Orchestrates: ranking -> wallet list -> webhook -> buys -> detection -> alerts. Everything in memory.
class RadarApp {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || console.log;
    this.detector = new ConvergenceDetector({ windowMs: cfg.windowMs, minWallets: cfg.minWallets });
    this.ranking = [];
    this.walletInfo = new Map(); // address -> ranking entry
    this.alerts = [];            // newest first
    this.listeners = new Set();
    this.status = {
      startedAt: Date.now(),
      ranking: { updatedAt: null, error: null, limited: false, loading: true },
      webhook: { mode: cfg.publicUrl ? 'live' : 'local', registered: false, error: null, lastEventAt: null, eventsToday: 0, eventsDay: dayKey(), warn: false }
    };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach(fn => { try { fn(this.snapshot()); } catch (e) { /* client went away */ } }); }

  snapshot() {
    return { now: Date.now(), windowMs: this.cfg.windowMs, minWallets: this.cfg.minWallets, status: this.status, ranking: this.ranking, alerts: this.alerts };
  }

  isMonitored(addr) { return this.walletInfo.has(addr); }

  async start() {
    await this.refreshRanking();
    this._rankingTimer = setInterval(() => this.refreshRanking(), this.cfg.rankingRefreshMs);
    this._pruneTimer = setInterval(() => this.detector.prune(Date.now()), 60 * 1000);
    if (this._rankingTimer.unref) this._rankingTimer.unref();
    if (this._pruneTimer.unref) this._pruneTimer.unref();
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
    let count = 0;
    txs.forEach(tx => {
      parseBuys(tx, a => this.walletInfo.has(a), this.cfg.minBuySol).forEach(buy => {
        const out = this.detector.addBuy(buy);
        if (out) { this._publish(out); count++; }
      });
    });
    this._emit();
    return count;
  }

  _publish(out) {
    const a = out.alert;
    const view = {
      id: a.id, kind: out.kind, mint: a.mint, symbol: null, name: null,
      walletCount: a.walletCount, firstTs: a.firstTs, lastTs: a.lastTs, emittedAt: Date.now(),
      buys: a.buys.map(b => {
        const w = this.walletInfo.get(b.wallet);
        return { wallet: b.wallet, label: w ? w.name : null, ts: b.ts, solAmount: b.solAmount, signature: b.signature };
      })
    };
    const i = this.alerts.findIndex(x => x.id === view.id);
    if (i >= 0) { view.symbol = this.alerts[i].symbol; view.name = this.alerts[i].name; this.alerts.splice(i, 1); }
    this.alerts.unshift(view);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
    this.log('ALERT ' + out.kind + ': ' + a.walletCount + ' wallets on ' + a.mint);
    if (!view.symbol) {
      tokenInfo.lookup(a.mint).then(info => {
        if (info) { view.symbol = info.symbol; view.name = info.name; this._emit(); }
      });
    }
  }
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

module.exports = { RadarApp };
