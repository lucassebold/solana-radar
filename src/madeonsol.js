'use strict';
const { request, parseJson, scrub } = require('./http');

const BASE = 'https://madeonsol.com/api/v1';

class SourceError extends Error {
  constructor(message, kind) { super(message); this.kind = kind || 'error'; } // 'limit' | 'error'
}

// Missing fields become null (never 0). pnl is in SOL ("realized PnL in SOL" in the docs).
// avg_roi: the docs do not define its unit; it is treated as a percentage (see README).
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function normalizeEntry(e) {
  return {
    wallet: e.wallet,
    name: typeof e.name === 'string' && e.name ? e.name : null,
    pnlSol: num(e.pnl),
    roiPct: num(e.avg_roi),
    winRatePct: num(e.win_rate),
    trades: num(e.buy_count) === null && num(e.sell_count) === null ? null : (num(e.buy_count) || 0) + (num(e.sell_count) || 0),
    complete: e.completeness === 'complete'
  };
}

async function fetchRanking(apiKey, size) {
  const url = BASE + '/kol/leaderboard?period=30d&sort=pnl&limit=' + size;
  let res;
  try {
    res = await request('GET', url, { headers: { Authorization: 'Bearer ' + apiKey } });
  } catch (e) {
    throw new SourceError('MadeOnSol unreachable: ' + scrub(e.message, [apiKey]), 'error');
  }
  if (res.status === 429) throw new SourceError('MadeOnSol rate limit reached', 'limit');
  const json = parseJson(res.body);
  if (res.status !== 200 || !json || !Array.isArray(json.leaderboard)) {
    const code = json && (json.error || json.message);
    throw new SourceError('MadeOnSol responded ' + res.status + (code ? ' (' + scrub(code, [apiKey]) + ')' : ''), 'error');
  }
  return json.leaderboard
    .filter(e => e && typeof e.wallet === 'string' && e.wallet.length >= 32)
    .map(normalizeEntry);
}

module.exports = { fetchRanking, normalizeEntry, SourceError };
