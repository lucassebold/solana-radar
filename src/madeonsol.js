'use strict';
const { request, parseJson, scrub } = require('./http');

const BASE = 'https://madeonsol.com/api/v1';

class SourceError extends Error {
  constructor(message, kind) { super(message); this.kind = kind || 'error'; } // 'limit' | 'error'
}

// Missing fields become null (never 0). pnl is in SOL ("realized PnL in SOL" in the docs).
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// KOL leaderboard entry. avg_roi: the docs do not define its unit; it is treated as a percentage (see README).
function normalizeEntry(e) {
  const trades = num(e.buy_count) === null && num(e.sell_count) === null ? null : (num(e.buy_count) || 0) + (num(e.sell_count) || 0);
  return {
    wallet: e.wallet,
    name: typeof e.name === 'string' && e.name ? e.name : null,
    pnlSol: num(e.pnl),
    roiPct: num(e.avg_roi),
    winRatePct: num(e.win_rate),
    trades,
    tradesPerDay: trades === null ? null : trades / 30,
    holdMinutes: num(e.median_hold_minutes_30d),
    lastSeen: null,
    complete: e.completeness === 'complete',
    source: 'kol'
  };
}

// Alpha-wallet entry (early buyers of Pump.fun tokens, bots excluded by the source). win_rate is a 0..1 fraction and
// roi is a fraction too (total_sol_sold / total_sol_bought - 1), so both are converted to percentages.
function normalizeAlpha(e) {
  const trades = num(e.total_buys) === null && num(e.total_sells) === null ? null : (num(e.total_buys) || 0) + (num(e.total_sells) || 0);
  const last = typeof e.last_seen === 'string' ? Date.parse(e.last_seen) : NaN;
  return {
    wallet: e.wallet,
    name: null,
    pnlSol: num(e.net_pnl_sol),
    roiPct: num(e.roi) === null ? null : e.roi * 100,
    winRatePct: num(e.win_rate) === null ? null : e.win_rate * 100,
    trades,
    tradesPerDay: trades === null ? null : trades / 30,
    holdMinutes: null,
    lastSeen: Number.isFinite(last) ? last : null,
    complete: e.unknown_realizations === 0,
    source: 'alpha'
  };
}

async function get(apiKey, pathAndQuery) {
  let res;
  try {
    res = await request('GET', BASE + pathAndQuery, { headers: { Authorization: 'Bearer ' + apiKey } });
  } catch (e) {
    throw new SourceError('MadeOnSol unreachable: ' + scrub(e.message, [apiKey]), 'error');
  }
  if (res.status === 429) throw new SourceError('MadeOnSol rate limit reached', 'limit');
  const json = parseJson(res.body);
  if (res.status !== 200 || !json || !Array.isArray(json.leaderboard)) {
    const code = json && (json.error || json.message);
    throw new SourceError('MadeOnSol responded ' + res.status + (code ? ' (' + scrub(code, [apiKey]) + ')' : ''), 'error');
  }
  return json.leaderboard.filter(e => e && typeof e.wallet === 'string' && e.wallet.length >= 32);
}

// Candidate wallets, best first. Returns {entries, calls} so the caller can account for API quota.
//  source 'alpha': /alpha/leaderboard, 30 days by profit, 100 per page (free tier: up to 500 entries)
//  source 'kol'  : /kol/leaderboard, 30 days by profit (free tier: 50 entries), scalpers removed by minimum hold time
async function fetchCandidates(apiKey, o) {
  if (o.source === 'kol') {
    const rows = await get(apiKey, '/kol/leaderboard?period=30d&sort=pnl&limit=50');
    return { entries: rows.map(normalizeEntry).filter(e => e.holdMinutes !== null && e.holdMinutes >= o.minHoldMinutes), calls: 1 };
  }
  const pages = Math.max(1, Math.ceil(o.poolSize / 100));
  let rows = [];
  let calls = 0;
  for (let p = 0; p < pages; p++) {
    const page = await get(apiKey, '/alpha/leaderboard?period=30d&sort=pnl&limit=100&offset=' + (p * 100));
    calls++;
    rows = rows.concat(page);
    if (page.length < 100) break;
  }
  return { entries: rows.map(normalizeAlpha), calls };
}

module.exports = { fetchCandidates, normalizeEntry, normalizeAlpha, SourceError };
