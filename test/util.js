'use strict';
// Explicit test configuration: never reads the real .env, never points at real services.
function makeCfg(over) {
  return Object.assign({
    port: 0, heliusKey: 'test-helius-key', madeonsolKey: 'test-madeonsol-key', webhookSecret: 'test-secret-123456', publicUrl: '',
    dataDir: '', durable: true, retentionDays: 90, pairsDays: 30, pairsMinCount: 2,
    rankingSize: 50, rankingSource: 'alpha', poolSize: 300, maxInactiveDays: 14, minHoldMinutes: 5,
    rankingRefreshMs: 1e9, windowMs: 5 * 60 * 1000, minWallets: 3, minBuySol: 0.01, dailyEventWarn: 30000,
    heliusPlanCredits: 1000000, budgetFraction: 0.9, hardStopFraction: 0.97, billingDay: 1, creditsUsedOffset: 0,
    calibrationDefault: 10, minTracked: 5, maxWalletShare: 0.15, maxWebhookEditsPerDay: 6, madeonsolDailyLimit: 150
  }, over || {});
}

// A candidate wallet as produced by src/madeonsol.js.
function cand(i, tradesPerDay, pnl) {
  return { wallet: 'W' + String(i).padStart(40, '0'), name: null, pnlSol: pnl === undefined ? 1000 - i : pnl, roiPct: 100, winRatePct: 60, trades: tradesPerDay * 30, tradesPerDay, holdMinutes: null, lastSeen: Date.now(), complete: true, source: 'alpha' };
}

module.exports = { makeCfg, cand };
