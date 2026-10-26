'use strict';
const { request, parseJson } = require('./http');

const cache = new Map(); // mint -> {symbol, name} (successes only)

// Token symbol/name via DexScreener (public API, free, no key). Failure => null (the UI shows the mint).
async function lookup(mint) {
  if (cache.has(mint)) return cache.get(mint);
  let info = null;
  try {
    const res = await request('GET', 'https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(mint), { timeout: 8000 });
    const json = res.status === 200 ? parseJson(res.body) : null;
    const pairs = json && Array.isArray(json.pairs) ? json.pairs.filter(p => p.baseToken && p.baseToken.address === mint) : [];
    if (pairs.length) {
      pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
      const t = pairs[0].baseToken;
      info = { symbol: t.symbol || null, name: t.name || null };
    }
  } catch (e) { info = null; }
  if (info) { if (cache.size > 500) cache.clear(); cache.set(mint, info); } // failures may be transient: not cached
  return info;
}

module.exports = { lookup };
