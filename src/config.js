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

const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

module.exports = {
  port: num('PORT', 3000),
  heliusKey: process.env.HELIUS_API_KEY || '',
  madeonsolKey: process.env.MADEONSOL_API_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  publicUrl,
  rankingSize: num('RANKING_SIZE', 50),
  rankingRefreshMs: num('RANKING_REFRESH_HOURS', 6) * 3600 * 1000,
  windowMs: num('WINDOW_MINUTES', 5) * 60 * 1000,
  minWallets: num('MIN_WALLETS', 3),
  minBuySol: num('MIN_BUY_SOL', 0.01),
  // Warning only (does not block): more webhook events/day than this would exceed ~1M Helius credits/month.
  dailyEventWarn: num('DAILY_EVENT_WARN', 30000)
};
