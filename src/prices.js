'use strict';
const { request, parseJson } = require('./http');

const WSOL = 'So11111111111111111111111111111111111111112';
const BATCH = 30; // DexScreener accepts up to 30 addresses per call

// Token symbol/name/price via DexScreener (public API, free, no key).
// Returns Map(mint -> {symbol, name, priceNative, priceUsd}). priceNative = SOL per token (only when the pair is quoted in SOL).
// Failures return an empty/partial map: callers must treat a missing mint as "unknown", never as zero.
async function fetchTokens(mints) {
  const out = new Map();
  const unique = Array.from(new Set(mints.filter(Boolean)));
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    let json = null;
    try {
      const res = await request('GET', 'https://api.dexscreener.com/latest/dex/tokens/' + chunk.map(encodeURIComponent).join(','), { timeout: 8000 });
      json = res.status === 200 ? parseJson(res.body) : null;
    } catch (e) { json = null; }
    const pairs = json && Array.isArray(json.pairs) ? json.pairs : [];
    const best = new Map(); // mint -> pair with the most liquidity
    pairs.forEach(p => {
      if (!p.baseToken || !chunk.includes(p.baseToken.address)) return;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const cur = best.get(p.baseToken.address);
      if (!cur || liq > ((cur.liquidity && cur.liquidity.usd) || 0)) best.set(p.baseToken.address, p);
    });
    best.forEach((p, mint) => {
      const native = p.quoteToken && p.quoteToken.address === WSOL ? Number(p.priceNative) : NaN;
      const usd = Number(p.priceUsd);
      out.set(mint, {
        symbol: p.baseToken.symbol || null,
        name: p.baseToken.name || null,
        priceNative: Number.isFinite(native) && native > 0 ? native : null,
        priceUsd: Number.isFinite(usd) && usd > 0 ? usd : null
      });
    });
  }
  return out;
}

module.exports = { fetchTokens };
