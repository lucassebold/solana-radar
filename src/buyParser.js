'use strict';

// Mints que nao contam como "token comprado": SOL embrulhado e stablecoins.
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

// A Helius classifica mal as transacoes da Pump.fun (aparecem como TRANSFER/UNKNOWN), entao o campo
// `type` e ignorado. Uma compra e: o saldo do token aumentou na carteira E ela gastou SOL.
// Fonte: variacoes de saldo em `accountData` (validadas contra o feed da MadeOnSol).
// walletSet: objeto/Set-like com as carteiras monitoradas -> funcao has(addr).
function parseBuys(tx, isMonitored, minBuySol) {
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
  const buys = [];
  Object.keys(tokenByWallet).forEach(wallet => {
    const tokens = tokenByWallet[wallet];
    const nativeDelta = nativeByWallet[wallet] || 0; // lamports
    const wsolDelta = tokens[WSOL] || 0;
    const solSpent = (nativeDelta < 0 ? -nativeDelta / 1e9 : 0) + (wsolDelta < 0 ? -wsolDelta : 0);
    if (solSpent < minBuySol) return; // nao gastou SOL de verdade: airdrop, transferencia, venda
    const bought = Object.keys(tokens).filter(m => !IGNORED_MINTS[m] && tokens[m] > 0);
    bought.forEach(mint => {
      buys.push({
        wallet,
        mint,
        // Com varios tokens na mesma transacao nao da para atribuir o valor a um deles.
        solAmount: bought.length === 1 ? solSpent : null,
        signature: tx.signature,
        ts
      });
    });
  });
  return buys;
}

module.exports = { parseBuys, WSOL };
