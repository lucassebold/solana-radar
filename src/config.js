'use strict';
const fs = require('fs');
const path = require('path');

// Loads .env (if present) without overriding variables already set in the environment.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t[0] === '#') return;
    const i = t.indexOf('=');
    if (i < 1) return;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  });
}

loadEnvFile(path.join(__dirname, '..', '.env'));

function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : def;
}

// History location. On Railway attach a Volume (it sets RAILWAY_VOLUME_MOUNT_PATH); locally ./data is used.
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const durable = Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) || !process.env.RAILWAY_ENVIRONMENT;

const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

module.exports = {
  port: num('PORT', 3000),
  heliusKey: process.env.HELIUS_API_KEY || '',
  madeonsolKey: process.env.MADEONSOL_API_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  publicUrl,
  dataDir,
  durable,
  retentionDays: num('RETENTION_DAYS', 90),
  pairsDays: num('PAIRS_DAYS', 30),
  pairsMinCount: num('PAIRS_MIN_COUNT', 2),
  rankingSize: num('RANKING_SIZE', 50),
  // Where candidate wallets come from: 'alpha' (default: early buyers, bots excluded) or 'kol' (KOL leaderboard).
  rankingSource: process.env.RANKING_SOURCE === 'kol' ? 'kol' : 'alpha',
  poolSize: num('POOL_SIZE', 300),            // candidates fetched (alpha: 100 per API call)
  maxInactiveDays: num('MAX_INACTIVE_DAYS', 14), // drop wallets not seen trading recently
  minHoldMinutes: num('MIN_HOLD_MINUTES', 5),    // kol source only: removes scalper bots
  // Helius credit budget (free plan: 1,000,000 credits per cycle; 1 credit per webhook event, 100 per webhook edit)
  heliusPlanCredits: num('HELIUS_PLAN_CREDITS', 1000000),
  budgetFraction: num('BUDGET_FRACTION', 0.9),   // we plan to use at most this share of the plan
  hardStopFraction: num('HARD_STOP_FRACTION', 0.97), // webhook is deleted (radar pauses) beyond this share
  billingDay: Math.min(28, Math.max(1, num('BILLING_DAY', 1))), // day of month the Helius cycle resets (UTC)
  creditsUsedOffset: num('CREDITS_USED_OFFSET', 0), // credits already spent this cycle before this app counted
  calibrationDefault: num('CALIBRATION_DEFAULT', 10), // events per leaderboard trade, until measured
  minTracked: num('MIN_TRACKED', 5),
  maxWalletShare: num('MAX_WALLET_SHARE', 0.15), // skip a wallet that alone would use more than this share of the daily allowance
  maxWebhookEditsPerDay: num('MAX_WEBHOOK_EDITS_PER_DAY', 6),
  madeonsolDailyLimit: num('MADEONSOL_DAILY_LIMIT', 150), // our own cap below the 200/day free quota
  rankingRefreshMs: num('RANKING_REFRESH_HOURS', 6) * 3600 * 1000,
  windowMs: num('WINDOW_MINUTES', 5) * 60 * 1000,
  minWallets: num('MIN_WALLETS', 3),
  minBuySol: num('MIN_BUY_SOL', 0.01),
  // Warning only (does not block): more webhook events/day than this would exceed ~1M Helius credits/month.
  dailyEventWarn: num('DAILY_EVENT_WARN', 30000)
};
