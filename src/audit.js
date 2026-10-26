'use strict';
const { request, parseJson, scrub } = require('./http');
const { WSOL, IGNORED_MINTS } = require('./buyParser');

// Wallet behaviour audit. Some of the most "profitable" wallets are not traders: they RECEIVE tokens from other wallets
// by transfer and sell them (so the profit has no entry), or BUY and ship the tokens out to another wallet. Their
// trades say nothing about conviction and copying them is pointless. The audit classifies a wallet's recent
// transactions and flags the ones where transfers dominate.

// Classifies one transaction from the point of view of `wallet`, using balance changes (the Helius `type` is unreliable).
//   buy / sell        token balance moved AND SOL moved the opposite way
//   token_swap        one token went up and another went down (no SOL leg)
//   transfer_in/out   token balance moved with no SOL leg and no counter-token = a plain transfer between wallets
//   other             no (non-stable) token movement: SOL transfers, account closes, tips...
function classifyTx(tx, wallet, minSol) {
  let native = 0;
  const tok = {};
  (tx.accountData || []).forEach(a => {
    if (a.account === wallet) native += Number(a.nativeBalanceChange) || 0;
    (a.tokenBalanceChanges || []).forEach(c => {
      if (c.userAccount !== wallet || !c.rawTokenAmount) return;
      const d = Number(c.rawTokenAmount.tokenAmount) / Math.pow(10, Number(c.rawTokenAmount.decimals) || 0);
      if (Number.isFinite(d)) tok[c.mint] = (tok[c.mint] || 0) + d;
    });
  });
  const wsol = tok[WSOL] || 0;
  const spent = (native < 0 ? -native / 1e9 : 0) + (wsol < 0 ? -wsol : 0);
  const got = (native > 0 ? native / 1e9 : 0) + (wsol > 0 ? wsol : 0);
  const mints = Object.keys(tok).filter(m => !IGNORED_MINTS[m] && tok[m] !== 0);
  if (!mints.length) return 'other';
  const up = mints.some(m => tok[m] > 0);
  const down = mints.some(m => tok[m] < 0);
  if (up && down) return 'token_swap';
  if (up) return spent >= minSol ? 'buy' : 'transfer_in';
  return got >= minSol ? 'sell' : 'transfer_out';
}

class AuditError extends Error {
  constructor(message, kind) { super(message); this.kind = kind || 'error'; }
}

// Fetches the wallet's latest 100 transactions (Helius enhanced history) and tallies them.
async function auditWallet(apiKey, wallet, minSol) {
  let res;
  try {
    res = await request('GET', 'https://api-mainnet.helius-rpc.com/v0/addresses/' + encodeURIComponent(wallet) + '/transactions?limit=100&api-key=' + apiKey, { timeout: 20000 });
  } catch (e) { throw new AuditError('Helius history unreachable: ' + scrub(e.message, [apiKey]), 'error'); }
  if (res.status === 429) throw new AuditError('Helius rate limit reached', 'limit');
  const txs = parseJson(res.body);
  if (res.status !== 200 || !Array.isArray(txs)) throw new AuditError('Helius history responded ' + res.status, 'error');
  const m = { txs: 0, buys: 0, sells: 0, tokenSwaps: 0, transfersIn: 0, transfersOut: 0, other: 0, spanHours: 0 };
  const ok = txs.filter(t => t && !t.transactionError);
  ok.forEach(t => {
    m.txs++;
    const k = classifyTx(t, wallet, minSol);
    if (k === 'buy') m.buys++; else if (k === 'sell') m.sells++; else if (k === 'token_swap') m.tokenSwaps++;
    else if (k === 'transfer_in') m.transfersIn++; else if (k === 'transfer_out') m.transfersOut++; else m.other++;
  });
  if (ok.length > 1) m.spanHours = Math.abs(ok[0].timestamp - ok[ok.length - 1].timestamp) / 3600;
  return m;
}

// Decides from the tally. Only token-moving actions count (buys, sells, transfers): SOL-only noise is ignored.
// Not enough evidence => not flagged (we do not exclude a wallet we cannot judge).
function verdict(m, o) {
  const actions = m.buys + m.sells + m.transfersIn + m.transfersOut;
  if (actions < o.minActions) return { flag: false, reason: 'not enough activity to judge (' + actions + ' actions)' };
  const share = (m.transfersIn + m.transfersOut) / actions;
  if (share >= o.maxTransferShare) {
    return { flag: true, reason: (m.transfersIn >= m.transfersOut ? 'receives tokens by transfer' : 'sends tokens out by transfer') + ' (' + Math.round(share * 100) + '% of its token actions)' };
  }
  return { flag: false, reason: 'trades normally (' + Math.round(share * 100) + '% transfers)' };
}

module.exports = { classifyTx, auditWallet, verdict, AuditError };
