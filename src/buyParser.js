'use strict';

// Mints that do not count as a traded token: wrapped SOL and stablecoins.
const WSOL = 'So11111111111111111111111111111111111111112';
const IGNORED_MINTS = {
  [WSOL]: true,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: true, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: true  // USDT
};

function tokenDelta(change) {
  const raw = change && change.rawTokenAmount;
  if (!raw) return 0;
  const amount = Number(raw.tokenAmount);
  const decimals = Number(raw.decimals) || 0;
  return Number.isFinite(amount) ? amount / Math.pow(10, decimals) : 0;
}

// Helius often mislabels Pump.fun transactions (they show up as TRANSFER/UNKNOWN), so the `type` field
// is ignored. Trades are derived from balance changes in `accountData` (validated against MadeOnSol's feed):
//   buy  = the wallet's token balance went UP and it spent SOL
//   sell = the wallet's token balance went DOWN and it received SOL
// isMonitored(address) -> boolean. Returns [{side, wallet, mint, solAmount, tokenAmount, signature, ts}].
function parseTrades(tx, isMonitored, minSol) {
  if (!tx || !tx.signature || tx.transactionError) return [];
  const accountData = Array.isArray(tx.accountData) ? tx.accountData : [];
  const nativeByWallet = {};
  const tokenByWallet = {};

  accountData.forEach(a => {
    if (a && a.account && isMonitored(a.account)) {
      nativeByWallet[a.account] = (nativeByWallet[a.account] || 0) + (Number(a.nativeBalanceChange) || 0);
    }
    (a && a.tokenBalanceChanges || []).forEach(c => {
      if (!c || !c.userAccount || !isMonitored(c.userAccount)) return;
      const w = tokenByWallet[c.userAccount] || (tokenByWallet[c.userAccount] = {});
      w[c.mint] = (w[c.mint] || 0) + tokenDelta(c);
    });
  });

  const ts = (Number(tx.timestamp) || 0) * 1000;
  const trades = [];
  Object.keys(tokenByWallet).forEach(wallet => {
    const tokens = tokenByWallet[wallet];
    const nativeDelta = nativeByWallet[wallet] || 0; // lamports
    const wsolDelta = tokens[WSOL] || 0;
    const solSpent = (nativeDelta < 0 ? -nativeDelta / 1e9 : 0) + (wsolDelta < 0 ? -wsolDelta : 0);
    const solReceived = (nativeDelta > 0 ? nativeDelta / 1e9 : 0) + (wsolDelta > 0 ? wsolDelta : 0);
    const traded = Object.keys(tokens).filter(m => !IGNORED_MINTS[m] && tokens[m] !== 0);

    if (solSpent >= minSol) {
      const bought = traded.filter(m => tokens[m] > 0);
      bought.forEach(mint => trades.push({
        side: 'buy', wallet, mint,
        // With several tokens in one transaction the SOL amount cannot be attributed to any one of them.
        solAmount: bought.length === 1 ? solSpent : null,
        tokenAmount: bought.length === 1 ? tokens[mint] : null,
        signature: tx.signature, ts
      }));
    } else if (solReceived >= minSol) {
      const sold = traded.filter(m => tokens[m] < 0);
      sold.forEach(mint => trades.push({
        side: 'sell', wallet, mint,
        solAmount: sold.length === 1 ? solReceived : null,
        tokenAmount: sold.length === 1 ? -tokens[mint] : null,
        signature: tx.signature, ts
      }));
    }
  });
  return trades;
}

function parseBuys(tx, isMonitored, minSol) {
  return parseTrades(tx, isMonitored, minSol).filter(t => t.side === 'buy');
}

module.exports = { parseTrades, parseBuys, WSOL };
