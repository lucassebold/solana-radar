'use strict';
const { ConvergenceDetector } = require('../src/detector');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
let n = 0;
function buy(wallet, mint, tMs, sol) {
  return { wallet, mint, ts: T0 + tMs, solAmount: sol === undefined ? 1 : sol, signature: 'sig' + (n++) };
}
function det() { return new ConvergenceDetector({ windowMs: 5 * MIN, minWallets: 3 }); }

test('3 carteiras distintas no mesmo mint em 5 min geram alerta', () => {
  const d = det();
  assert.strictEqual(d.addBuy(buy('A', 'M', 0)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 1 * MIN)), null);
  const out = d.addBuy(buy('C', 'M', 2 * MIN));
  assert.ok(out);
  assert.strictEqual(out.kind, 'new');
  assert.strictEqual(out.alert.walletCount, 3);
  assert.strictEqual(out.alert.mint, 'M');
});

test('a mesma carteira comprando varias vezes conta uma vez so', () => {
  const d = det();
  assert.strictEqual(d.addBuy(buy('A', 'M', 0)), null);
  assert.strictEqual(d.addBuy(buy('A', 'M', 1 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('A', 'M', 2 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 3 * MIN)), null); // so 2 distintas
});

test('compras de mints diferentes nao se misturam', () => {
  const d = det();
  d.addBuy(buy('A', 'M1', 0));
  d.addBuy(buy('B', 'M2', 1 * MIN));
  assert.strictEqual(d.addBuy(buy('C', 'M3', 2 * MIN)), null);
});

test('janela de 5 min: borda exata (5:00) conta, 5:01 nao', () => {
  let d = det();
  d.addBuy(buy('A', 'M', 0));
  d.addBuy(buy('B', 'M', 2 * MIN));
  assert.ok(d.addBuy(buy('C', 'M', 5 * MIN)), 'A em 0:00 e C em 5:00 cabem na janela');

  d = det();
  d.addBuy(buy('A', 'M', 0));
  d.addBuy(buy('B', 'M', 2 * MIN));
  assert.strictEqual(d.addBuy(buy('C', 'M', 5 * MIN + 1000)), null, 'A saiu da janela');
});

test('janela movel: as 3 compras podem comecar depois da primeira', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0));                       // fora da janela das demais
  d.addBuy(buy('B', 'M', 10 * MIN));
  d.addBuy(buy('C', 'M', 12 * MIN));
  const out = d.addBuy(buy('D', 'M', 14 * MIN));
  assert.ok(out);
  assert.strictEqual(out.alert.walletCount, 3);
  assert.ok(out.alert.buys.every(b => b.wallet !== 'A'));
});

test('evento repetido (mesma assinatura) e ignorado', () => {
  const d = det();
  const b = buy('A', 'M', 0);
  d.addBuy(b); d.addBuy(Object.assign({}, buy('B', 'M', MIN)));
  const third = buy('C', 'M', 2 * MIN);
  assert.ok(d.addBuy(third));
  assert.strictEqual(d.addBuy(third), null, 'reenvio do webhook nao gera outro alerta');
});

test('nao repete o alerta do mesmo grupo', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  assert.ok(d.addBuy(buy('C', 'M', 2 * MIN)));
  assert.strictEqual(d.addBuy(buy('A', 'M', 3 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 3.5 * MIN)), null);
});

test('carteira nova na mesma onda atualiza o alerta (sem spam de novos)', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  const first = d.addBuy(buy('C', 'M', 2 * MIN));
  const upd = d.addBuy(buy('D', 'M', 3 * MIN));
  assert.ok(upd);
  assert.strictEqual(upd.kind, 'update');
  assert.strictEqual(upd.alert.id, first.alert.id, 'mesmo alerta, so cresce');
  assert.strictEqual(upd.alert.walletCount, 4);
});

test('nova onda claramente distinta emite novo alerta', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  const first = d.addBuy(buy('C', 'M', 2 * MIN));
  d.addBuy(buy('A', 'M', 30 * MIN)); d.addBuy(buy('B', 'M', 31 * MIN));
  const second = d.addBuy(buy('C', 'M', 32 * MIN));
  assert.ok(second);
  assert.strictEqual(second.kind, 'new');
  assert.notStrictEqual(second.alert.id, first.alert.id);
});

test('compras chegando fora de ordem sao tratadas pelo horario do evento', () => {
  const d = det();
  d.addBuy(buy('C', 'M', 2 * MIN));
  d.addBuy(buy('A', 'M', 0));
  const out = d.addBuy(buy('B', 'M', 1 * MIN));
  assert.ok(out);
  assert.strictEqual(out.alert.walletCount, 3);
  assert.deepStrictEqual(out.alert.buys.map(b => b.wallet), ['A', 'B', 'C']);
});

test('alerta traz horario, valor e assinatura de cada carteira', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0, 2.5)); d.addBuy(buy('B', 'M', MIN, null));
  const out = d.addBuy(buy('C', 'M', 2 * MIN, 0.4));
  const b = out.alert.buys;
  assert.strictEqual(b[0].solAmount, 2.5);
  assert.strictEqual(b[1].solAmount, null, 'valor ausente continua ausente, nao vira 0');
  assert.ok(b[2].signature && b[2].ts === T0 + 2 * MIN);
});

test('prune descarta dados antigos e libera memoria', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  d.prune(T0 + 60 * MIN);
  assert.strictEqual(d.buysByMint.size, 0);
  assert.strictEqual(d.seen.size, 0);
});
