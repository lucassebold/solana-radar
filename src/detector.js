'use strict';

const MAX_BUYS_PER_MINT = 500;

// Detecta convergencia: >= minWallets carteiras DISTINTAS comprando o mesmo mint em uma janela movel.
// Estado so em memoria. Um alerta so e (re)emitido quando entra uma carteira que ainda nao estava nele
// (sem spam); uma nova onda so e emitida depois que a anterior ficou fora da janela.
class ConvergenceDetector {
  constructor(opts) {
    this.windowMs = opts.windowMs;
    this.minWallets = opts.minWallets;
    this.buysByMint = new Map();   // mint -> [{wallet, ts, solAmount, signature}]
    this.seen = new Map();         // signature|wallet|mint -> ts (deduplicacao)
    this.alertByMint = new Map();  // mint -> {id, wallets:Set, firstTs, lastTs}
  }

  // Retorna null ou {kind:'new'|'update', alert}.
  addBuy(buy) {
    const key = buy.signature + '|' + buy.wallet + '|' + buy.mint;
    if (this.seen.has(key)) return null; // evento repetido (reenvio do webhook)
    this.seen.set(key, buy.ts);

    let list = this.buysByMint.get(buy.mint);
    if (!list) { list = []; this.buysByMint.set(buy.mint, list); }
    list.push({ wallet: buy.wallet, ts: buy.ts, solAmount: buy.solAmount, signature: buy.signature });
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_BUYS_PER_MINT) list.splice(0, list.length - MAX_BUYS_PER_MINT);

    const group = this._bestGroupContaining(list, buy);
    if (!group) return null;
    const wallets = new Set(group.map(b => b.wallet));
    if (wallets.size < this.minWallets) return null;

    const firstTs = group[0].ts;
    const lastTs = group[group.length - 1].ts;
    const prev = this.alertByMint.get(buy.mint);
    const sameWave = prev && prev.lastTs >= firstTs - this.windowMs && firstTs <= prev.lastTs + this.windowMs;

    if (sameWave) {
      let hasNew = false;
      wallets.forEach(w => { if (!prev.wallets.has(w)) hasNew = true; });
      if (!hasNew) return null; // mesmo grupo: nao repete o alerta
      const merged = new Set(prev.wallets);
      wallets.forEach(w => merged.add(w));
      prev.wallets = merged;
      prev.lastTs = Math.max(prev.lastTs, lastTs);
      prev.firstTs = Math.min(prev.firstTs, firstTs);
      return { kind: 'update', alert: this._build(buy.mint, prev, list) };
    }
    const state = { id: buy.mint + ':' + firstTs, wallets, firstTs, lastTs };
    this.alertByMint.set(buy.mint, state);
    return { kind: 'new', alert: this._build(buy.mint, state, list) };
  }

  // Melhor janela [t, t+windowMs] que contem a compra recem-chegada, escolhendo a com mais carteiras distintas.
  _bestGroupContaining(list, buy) {
    let best = null;
    let bestCount = 0;
    for (let i = 0; i < list.length; i++) {
      const start = list[i].ts;
      if (start > buy.ts) break;
      const members = [];
      for (let j = i; j < list.length && list[j].ts - start <= this.windowMs; j++) members.push(list[j]);
      if (members[members.length - 1].ts < buy.ts) continue;
      const count = new Set(members.map(b => b.wallet)).size;
      if (count > bestCount) { best = members; bestCount = count; }
    }
    return best;
  }

  // Monta o alerta com UMA compra (a primeira) por carteira, dentro do periodo da onda.
  _build(mint, state, list) {
    const firstByWallet = new Map();
    list.forEach(b => {
      if (b.ts < state.firstTs || b.ts > state.lastTs) return;
      if (!state.wallets.has(b.wallet)) return;
      if (!firstByWallet.has(b.wallet)) firstByWallet.set(b.wallet, b);
    });
    const buys = Array.from(firstByWallet.values()).sort((a, b) => a.ts - b.ts);
    return {
      id: state.id,
      mint,
      walletCount: buys.length,
      firstTs: state.firstTs,
      lastTs: state.lastTs,
      buys: buys.map(b => ({ wallet: b.wallet, ts: b.ts, solAmount: b.solAmount, signature: b.signature }))
    };
  }

  // Descarta dados antigos. `now` em ms. Mantem memoria limitada.
  prune(now) {
    const cutoff = now - this.windowMs * 2;
    this.buysByMint.forEach((list, mint) => {
      const kept = list.filter(b => b.ts >= cutoff);
      if (kept.length) this.buysByMint.set(mint, kept); else this.buysByMint.delete(mint);
    });
    this.seen.forEach((ts, key) => { if (ts < cutoff) this.seen.delete(key); });
    this.alertByMint.forEach((s, mint) => { if (s.lastTs < now - this.windowMs * 4) this.alertByMint.delete(mint); });
  }
}

module.exports = { ConvergenceDetector };
