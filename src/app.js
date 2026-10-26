'use strict';
const { parseTrades } = require('./buyParser');
const { ConvergenceDetector } = require('./detector');
const { fetchCandidates } = require('./madeonsol');
const helius = require('./helius');
const { fetchTokens } = require('./prices');
const { NullStore } = require('./store');
const budget = require('./budget');
const audit = require('./audit');

const MAX_ALERTS = 10;
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const UNKNOWN_TRADES_PER_DAY = 100; // assumed for a candidate whose trade count the source did not give

// Orchestrates: candidates -> budget-aware wallet selection -> webhook -> trades -> detection -> alerts -> history.
// State lives in memory and is mirrored to the store (SQLite) so it survives restarts.
class RadarApp {
  constructor(cfg, log, store) {
    this.cfg = cfg;
    this.log = log || console.log;
    this.store = store || new NullStore();
    this.fetchTokens = fetchTokens;           // injectable in tests
    this.fetchCandidates = fetchCandidates;   // injectable in tests
    this.helius = helius;                     // injectable in tests
    this.auditWallet = audit.auditWallet;     // injectable in tests
    this.flagged = new Map();                 // wallet -> why it was excluded (transfers dominate its activity)
    this.detectors = {
      buy: new ConvergenceDetector({ windowMs: cfg.windowMs, minWallets: cfg.minWallets }),
      sell: new ConvergenceDetector({ windowMs: cfg.windowMs, minWallets: cfg.minWallets })
    };
    this.candidates = [];        // every eligible wallet, best first
    this.frozenAt = null;        // set once the fixed watchlist has been chosen
    this._verified = [];         // candidates that passed the behaviour audit (or were judged normal)
    this.ranking = [];           // the wallets actually watched (a budget-fitting subset of the candidates)
    this.walletInfo = new Map(); // address -> ranking entry
    this.alerts = [];            // newest first
    this.pairs = [];             // recurring co-buyers
    this.performance = { buy: [], sell: [] };
    this.listeners = new Set();
    this.paused = false;
    this._buf = { events: 0, mgmt: 0, calls: 0 }; // usage not yet written to the store
    this._act = new Map();                         // hour -> Map(wallet -> events), not yet written
    this._mem = { used: 0, callsDay: dayKey(), calls: 0, audits: 0 }; // fallback accounting when there is no persistent store
    this._edits = { day: dayKey(), n: 0, lastAt: 0 };
    this.status = {
      startedAt: Date.now(),
      ranking: { updatedAt: null, error: null, limited: false, loading: true, frozen: false, frozenAt: null },
      webhook: { mode: cfg.publicUrl ? 'live' : 'local', registered: false, paused: false, pausedReason: null, error: null, lastEventAt: null, eventsToday: 0, pushesToday: 0, eventsDay: dayKey(), warn: false },
      audit: { enabled: !!(cfg.auditEnabled && cfg.heliusKey), checked: 0, flagged: 0, unverified: 0, calls: 0, error: null, lastRunAt: null },
      storage: { enabled: this.store.persistent, durable: cfg.durable, retentionDays: cfg.retentionDays },
      budget: { creditUnit: cfg.creditUnit, planCredits: cfg.heliusPlanCredits, used: 0, usedPct: 0, allowancePerDay: null, plannedPerDay: null, tracked: 0, candidates: 0, skippedNoisy: 0, calibration: null, paused: false, cycleStart: null, cycleEnd: null }
    };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach(fn => { try { fn(this.snapshot()); } catch (e) { /* client went away */ } }); }

  snapshot() {
    // Keep the credit counter fresh on screen (it is otherwise only recomputed by the 10-minute budget job).
    const now = Date.now();
    if (!this._usedAt || now - this._usedAt > 5000) {
      const b = this.status.budget;
      b.used = this.creditsUsed();
      b.usedPct = b.used / this.cfg.heliusPlanCredits * 100;
      this._usedAt = now;
    }
    return {
      now: Date.now(), windowMs: this.cfg.windowMs, minWallets: this.cfg.minWallets,
      status: this.status, ranking: this.ranking, alerts: this.alerts,
      pairs: this.pairs, performance: this.performance
    };
  }

  isMonitored(addr) { return this.walletInfo.has(addr); }

  async start() {
    this._restore();
    this._loadWatchlist();
    await this.refreshRanking();
    this._timers = [
      setInterval(() => this.refreshRanking(), this.cfg.rankingRefreshMs),
      setInterval(() => { this.detectors.buy.prune(Date.now()); this.detectors.sell.prune(Date.now()); }, MIN),
      setInterval(() => this.priceJob(), MIN),
      setInterval(() => this.analyticsJob(), 5 * MIN),
      setInterval(() => this.maintenanceJob(), 6 * HOUR),
      setInterval(() => this.flushUsage(), 30 * 1000),
      setInterval(() => this.budgetJob(), 10 * MIN)
    ];
    this._timers.forEach(t => { if (t.unref) t.unref(); });
    this.analyticsJob();
    this.maintenanceJob();
    this.priceJob();
  }

  stop() { (this._timers || []).forEach(clearInterval); this.flushUsage(); }

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

  // ---- quota / credit accounting -------------------------------------------------------------------------------

  // Helius credits spent in the current billing cycle (webhook events + webhook edits + configured offset).
  creditsUsed() {
    const day = budget.dayString(budget.cycleStart(Date.now(), this.cfg.billingDay));
    const base = this.store.persistent ? this.store.creditsSince(day) + this._buf.events + this._buf.mgmt : this._mem.used;
    return base + this.cfg.creditsUsedOffset;
  }

  callsToday() {
    const day = dayKey();
    if (this.store.persistent) return this.store.madeonsolCalls(day) + this._buf.calls;
    if (this._mem.callsDay !== day) { this._mem.callsDay = day; this._mem.calls = 0; }
    return this._mem.calls;
  }

  _addEvents(n) { this._buf.events += n; this._mem.used += n; }
  _addMgmt(n) { this._buf.mgmt += n; this._mem.used += n; }
  _addCalls(n) { this._buf.calls += n; this._mem.calls += n; this.flushUsage(); }

  // Writes buffered usage and per-wallet activity to the store (every 30 s, on stop).
  flushUsage() {
    const buf = this._buf; const act = this._act;
    this._buf = { events: 0, mgmt: 0, calls: 0 };
    this._act = new Map();
    if (!this.store.persistent) return;
    try {
      if (buf.events || buf.mgmt || buf.calls) this.store.addUsage(dayKey(), buf);
      act.forEach((counts, hour) => this.store.addActivity(hour, counts));
    } catch (e) { this.log('usage write error: ' + e.message); }
  }

  // ---- candidates, selection and the webhook -------------------------------------------------------------------

  async refreshRanking() {
    const st = this.status.ranking;
    const pages = this.cfg.rankingSource === 'kol' ? 1 : Math.max(1, Math.ceil(this.cfg.poolSize / 100));
    if (this.frozenAt) { // fixed list: no more ranking calls or audits, only the credit budget keeps working
      try { await this._rebalance(); } catch (e) { this.log('budget error: ' + e.message); }
      st.loading = false; this._emit();
      return;
    }
    try {
      if (this.callsToday() + pages > this.cfg.madeonsolDailyLimit) {
        const err = new Error('MadeOnSol daily call cap reached (self-imposed limit of ' + this.cfg.madeonsolDailyLimit + '/day)');
        err.kind = 'limit';
        throw err;
      }
      let res;
      try {
        res = await this.fetchCandidates(this.cfg.madeonsolKey, { source: this.cfg.rankingSource, poolSize: this.cfg.poolSize, minHoldMinutes: this.cfg.minHoldMinutes });
      } catch (e) { this._addCalls(1); throw e; }
      this._addCalls(res.calls);

      const now = Date.now();
      const maxAge = this.cfg.maxInactiveDays * 24 * HOUR;
      const eligible = res.entries
        .filter(e => e.pnlSol !== null && e.pnlSol > 0 && (e.lastSeen === null || now - e.lastSeen <= maxAge))
        .sort((a, b) => b.pnlSol - a.pnlSol);
      if (!eligible.length) throw new Error('No eligible wallets returned');
      const clean = await this._auditCandidates(eligible);
      if (!clean.length) throw new Error('Every candidate was excluded by the behaviour audit');
      this.candidates = clean;
      this._maybeFreeze();
      st.updatedAt = now; st.error = null; st.limited = false;
      this.log('candidates updated: ' + clean.length + ' usable of ' + eligible.length + ' eligible wallets (' + this.cfg.rankingSource + ')');
      await this._rebalance();
    } catch (e) {
      st.error = e.message; st.limited = e.kind === 'limit'; // keeps the previous list
      this.log('ranking error: ' + e.message);
    } finally {
      st.loading = false;
      this._emit();
    }
  }

  // ---- fixed watchlist ---------------------------------------------------------------------------------------------

  // In 'frozen' mode the list is chosen once (after the behaviour audit) and kept: saved in the store, reloaded on restart.
  _loadWatchlist() {
    const cfg = this.cfg;
    if (cfg.watchlistMode !== 'frozen') return;
    try {
      if (cfg.watchlistReset) { this.store.clearWatchlist(); this.log('watchlist reset: the saved fixed list was discarded, a new one will be chosen'); return; }
      const saved = this.store.loadWatchlist();
      if (!saved) return;
      this._setFrozen(saved.entries, saved.frozenAt);
      this.log('fixed watchlist loaded: ' + saved.entries.length + ' wallets chosen on ' + new Date(saved.frozenAt).toISOString().slice(0, 10));
    } catch (e) { this.log('watchlist load error: ' + e.message); }
  }

  _setFrozen(entries, ts) {
    this.candidates = entries;
    this.frozenAt = ts;
    const st = this.status.ranking;
    st.frozen = true; st.frozenAt = ts; st.updatedAt = ts; st.error = null; st.limited = false; st.loading = false;
  }

  // Fixes the list from the wallets that were actually verified (never from ones the audit could not check).
  _maybeFreeze() {
    if (this.cfg.watchlistMode !== 'frozen' || this.frozenAt) return;
    const chosen = this._verified.slice(0, this.cfg.rankingSize);
    if (chosen.length < this.cfg.minTracked) { this.log('not enough verified wallets to fix the list yet (' + chosen.length + '); will retry'); return; }
    const ts = Date.now();
    try { this.store.saveWatchlist(chosen, ts); } catch (e) { this.log('watchlist save error: ' + e.message); }
    this._setFrozen(chosen, ts);
    this.log('FIXED the watchlist with ' + chosen.length + ' audited wallets; no more ranking calls or audits (set WATCHLIST_RESET=true for one start to choose again)');
  }

  // Behaviour audit: walks the candidates best-first, reusing cached verdicts, and drops wallets whose token activity is
  // mostly transfers (pass-through / funnel wallets). Stops once enough clean wallets are found, at the depth limit, or
  // at the daily call cap. A wallet that cannot be judged (API error, cap reached, too little activity) is kept.
  async _auditCandidates(eligible) {
    const cfg = this.cfg;
    const info = this.status.audit;
    if (!info.enabled) { this._verified = eligible.slice(); return eligible; }
    const now = Date.now();
    const cached = this.store.getAudits(eligible.map(e => e.wallet), now - cfg.auditMaxAgeHours * HOUR);
    const dayStart = Date.parse(dayKey() + 'T00:00:00Z');
    let callsToday = this.store.persistent ? this.store.auditsSince(dayStart) : this._mem.audits;
    const clean = [];
    const verified = [];
    const tail = [];
    const flagged = new Map();
    let checked = 0, unverified = 0, calls = 0, stop = false;
    info.error = null;
    for (const e of eligible) {
      if (verified.length >= cfg.rankingSize || checked >= cfg.auditMaxWallets) { tail.push(e); continue; } // stop on VERIFIED wallets: unverified ones must not end the search early
      checked++;
      let row = cached.get(e.wallet);
      if (!row) {
        if (stop || callsToday >= cfg.auditMaxCallsPerDay) { unverified++; clean.push(e); continue; }
        try {
          const m = await this.auditWallet(cfg.heliusKey, e.wallet, cfg.minBuySol);
          callsToday++; calls++; this._mem.audits++;
          this._addMgmt(cfg.auditCallCredits);
          const v = audit.verdict(m, { minActions: cfg.auditMinActions, maxTransferShare: cfg.auditMaxTransferShare });
          try { this.store.saveAudit(e.wallet, m, v, Date.now()); } catch (err) { this.log('audit write error: ' + err.message); }
          row = { flagged: v.flag, reason: v.reason };
          if (cfg.auditDelayMs) await new Promise(r => setTimeout(r, cfg.auditDelayMs));
        } catch (err) {
          info.error = err.message;
          if (err.kind === 'limit') stop = true;
          unverified++; clean.push(e); continue;
        }
      }
      if (row.flagged) flagged.set(e.wallet, row.reason); else { clean.push(e); verified.push(e); }
    }
    this.flagged = flagged;
    this._verified = verified;
    Object.assign(info, { checked, flagged: flagged.size, unverified, calls, lastRunAt: Date.now() });
    if (calls || flagged.size) this.log('audit: checked ' + checked + ', excluded ' + flagged.size + ' pass-through wallets, ' + calls + ' new history calls, ' + unverified + ' unverified');
    return clean.concat(tail);
  }

  // Every 10 minutes: re-measure wallet noise and credit use, shrink/grow the watched list if needed.
  async budgetJob() {
    try { await this._rebalance(); } catch (e) { this.log('budget error: ' + e.message); }
    this._emit();
  }

  // Chooses which candidates to watch so the credits last the whole cycle, and keeps the webhook in sync.
  async _rebalance() {
    const now = Date.now();
    const cfg = this.cfg;
    const used = this.creditsUsed();
    const b = this.status.budget;
    b.used = used;
    b.usedPct = used / cfg.heliusPlanCredits * 100;
    b.cycleStart = budget.cycleStart(now, cfg.billingDay);
    b.cycleEnd = budget.cycleEnd(now, cfg.billingDay);
    b.candidates = this.candidates.length;

    // Hard stop: past this share of the plan the webhook is deleted and the radar pauses until the cycle resets.
    if (cfg.publicUrl && used >= cfg.heliusPlanCredits * cfg.hardStopFraction) { await this._pause(); b.paused = true; return; }
    if (this.paused) {
      this.paused = false; b.paused = false; this.status.webhook.paused = false; this.status.webhook.pausedReason = null;
      this.log('credits available again: resuming the radar');
      this.ranking = []; // forces a fresh selection + webhook re-creation below
    }
    if (cfg.paused && cfg.publicUrl) await this._manualPause(); // also retries a failed deletion
    if (!this.candidates.length) return;

    const allowance = budget.allowancePerDay({ planCredits: cfg.heliusPlanCredits, budgetFraction: cfg.budgetFraction, used, now, billingDay: cfg.billingDay });
    const measured = this.store.activityRates(now, 48, 0.5); // only wallets observed for 30+ min count as measured
    const perDay = new Map(this.candidates.filter(c => c.tradesPerDay !== null).map(c => [c.wallet, c.tradesPerDay]));
    const calib = budget.calibration(this.candidates.map(c => c.wallet), measured, perDay, cfg.calibrationDefault);
    const rateOf = c => measured.has(c.wallet)
      ? Math.max(1, measured.get(c.wallet))
      : Math.max(1, (c.tradesPerDay !== null ? c.tradesPerDay : UNKNOWN_TRADES_PER_DAY) * calib);

    const sel = budget.selectWallets({ candidates: this.candidates, rateOf, allowance, maxCount: cfg.rankingSize, minTracked: cfg.minTracked, maxShare: cfg.maxWalletShare, fill: 0.85 });
    const next = sel.selected.map(c => c.wallet);
    const current = this.ranking.map(r => r.wallet);
    const currentTotal = this.ranking.reduce((x, r) => x + rateOf(r), 0);
    const over = current.length > 0 && currentTotal > allowance * 1.1;
    const flaggedWatched = current.some(w => this.flagged.has(w)); // never keep watching a wallet the audit rejected

    if (this._edits.day !== dayKey()) this._edits = { day: dayKey(), n: 0, lastAt: 0 };
    const editOk = !current.length || over || flaggedWatched || (this._edits.n < cfg.maxWebhookEditsPerDay && now - this._edits.lastAt >= 30 * MIN);

    if (editOk && budget.shouldUpdateWebhook(current.length ? current : null, next, over || flaggedWatched)) {
      this.ranking = sel.selected;
      this.walletInfo = new Map(this.ranking.map(r => [r.wallet, r]));
      this.log('watching ' + next.length + ' of ' + this.candidates.length + ' wallets (~' + Math.round(sel.totalPerDay) + ' events/day, allowance ' + Math.round(allowance) + '/day' + (over ? ', over budget: trimmed' : '') + ')');
      await this._syncWebhook();
    } else {
      // Keep the watched list; just refresh its numbers.
      const fresh = new Map(this.candidates.map(c => [c.wallet, c]));
      this.ranking = this.ranking.map(r => fresh.get(r.wallet) || r);
      this.walletInfo = new Map(this.ranking.map(r => [r.wallet, r]));
    }
    Object.assign(b, {
      allowancePerDay: allowance, plannedPerDay: this.ranking.reduce((x, r) => x + rateOf(r), 0),
      tracked: this.ranking.length, skippedNoisy: sel.skippedNoisy.length, calibration: calib, paused: false
    });
  }

  async _syncWebhook() {
    const wh = this.status.webhook;
    if (!this.cfg.publicUrl) { wh.registered = false; return; }
    if (this.cfg.paused) { wh.paused = true; wh.pausedReason = 'manual'; wh.registered = false; return; } // _rebalance handles the deletion
    try {
      const r = await this.helius.ensureWebhook(this.cfg.heliusKey, this.cfg.publicUrl + '/webhook/helius', this.cfg.webhookSecret, this.ranking.map(x => x.wallet));
      wh.registered = true; wh.error = null;
      if (r.action !== 'unchanged') { this._addMgmt(100); this._edits.n++; this._edits.lastAt = Date.now(); }
      this.log('Helius webhook: ' + r.action);
    } catch (e) {
      wh.registered = false; wh.error = e.message;
      this.log('webhook error: ' + e.message);
    }
  }

  // RADAR_PAUSED=true: delete OUR webhook once per process (matched by URL) and never recreate it.
  async _manualPause() {
    const wh = this.status.webhook;
    wh.paused = true; wh.pausedReason = 'manual'; wh.registered = false;
    if (this._manualPauseDone) return;
    this._manualPauseDone = true;
    this.log('PAUSED by RADAR_PAUSED: deleting our Helius webhook (the ranking keeps updating, no credits are spent)');
    try {
      const deleted = await this.helius.deleteWebhook(this.cfg.heliusKey, this.cfg.publicUrl + '/webhook/helius');
      if (deleted) this._addMgmt(100);
      wh.error = null;
    } catch (e) { wh.error = e.message; this._manualPauseDone = false; this.log('pause error: ' + e.message); } // retried on the next budget tick
  }

  async _pause() {
    if (this.paused) return;
    this.paused = true;
    const wh = this.status.webhook;
    wh.paused = true; wh.pausedReason = 'budget'; wh.registered = false;
    this.log('PAUSED: Helius credits reached the hard stop; deleting the webhook until the cycle resets');
    try {
      const deleted = await this.helius.deleteWebhook(this.cfg.heliusKey, this.cfg.publicUrl + '/webhook/helius');
      if (deleted) this._addMgmt(100);
    } catch (e) { wh.error = e.message; this.log('pause error: ' + e.message); }
  }

  // ---- webhook events ------------------------------------------------------------------------------------------

  // Receives the webhook body (array of Helius enhanced transactions).
  handleWebhook(txs) {
    if (!Array.isArray(txs)) return 0;
    const wh = this.status.webhook;
    const today = dayKey();
    if (wh.eventsDay !== today) { wh.eventsDay = today; wh.eventsToday = 0; wh.pushesToday = 0; wh.warn = false; }
    wh.eventsToday += txs.length;
    wh.pushesToday += 1;
    wh.lastEventAt = Date.now();
    wh.warn = wh.eventsToday > this.cfg.dailyEventWarn;
    this._addEvents(this.cfg.creditUnit === 'push' ? 1 : txs.length); // credits: per delivery or per transaction
    this._countActivity(txs);

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

  // Attributes each delivered transaction to the watched wallets it touches (measures how noisy each wallet is).
  _countActivity(txs) {
    const hour = Math.floor(Date.now() / HOUR);
    let counts = this._act.get(hour);
    if (!counts) { counts = new Map(); this._act.set(hour, counts); }
    txs.forEach(tx => {
      const touched = new Set();
      if (tx && this.walletInfo.has(tx.feePayer)) touched.add(tx.feePayer);
      ((tx && tx.accountData) || []).forEach(a => {
        if (a && this.walletInfo.has(a.account)) touched.add(a.account);
        ((a && a.tokenBalanceChanges) || []).forEach(c => { if (c && this.walletInfo.has(c.userAccount)) touched.add(c.userAccount); });
      });
      touched.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
    });
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
      const symbols = this.store.symbols(mints);
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
