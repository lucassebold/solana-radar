'use strict';
const { ConvergenceDetector } = require('../src/detector');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
let n = 0;
function buy(wallet, mint, tMs, sol) {
  return { wallet, mint, ts: T0 + tMs, solAmount: sol === undefined ? 1 : sol, signature: 'sig' + (n++) };
}
function det() { return new ConvergenceDetector({ windowMs: 5 * MIN, minWallets: 3 }); }

test('3 distinct wallets buying the same mint within 5 min raise an alert', () => {
  const d = det();
  assert.strictEqual(d.addBuy(buy('A', 'M', 0)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 1 * MIN)), null);
  const out = d.addBuy(buy('C', 'M', 2 * MIN));
  assert.ok(out);
  assert.strictEqual(out.kind, 'new');
  assert.strictEqual(out.alert.walletCount, 3);
  assert.strictEqual(out.alert.mint, 'M');
});

test('the same wallet buying several times counts only once', () => {
  const d = det();
  assert.strictEqual(d.addBuy(buy('A', 'M', 0)), null);
  assert.strictEqual(d.addBuy(buy('A', 'M', 1 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('A', 'M', 2 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 3 * MIN)), null); // only 2 distinct
});

test('buys of different mints do not mix', () => {
  const d = det();
  d.addBuy(buy('A', 'M1', 0));
  d.addBuy(buy('B', 'M2', 1 * MIN));
  assert.strictEqual(d.addBuy(buy('C', 'M3', 2 * MIN)), null);
});

test('5-minute window: the exact edge (5:00) counts, 5:01 does not', () => {
  let d = det();
  d.addBuy(buy('A', 'M', 0));
  d.addBuy(buy('B', 'M', 2 * MIN));
  assert.ok(d.addBuy(buy('C', 'M', 5 * MIN)), 'A at 0:00 and C at 5:00 fit in the window');

  d = det();
  d.addBuy(buy('A', 'M', 0));
  d.addBuy(buy('B', 'M', 2 * MIN));
  assert.strictEqual(d.addBuy(buy('C', 'M', 5 * MIN + 1000)), null, 'A left the window');
});

test('sliding window: the 3 buys may start after the first one', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0));                       // outside the window of the others
  d.addBuy(buy('B', 'M', 10 * MIN));
  d.addBuy(buy('C', 'M', 12 * MIN));
  const out = d.addBuy(buy('D', 'M', 14 * MIN));
  assert.ok(out);
  assert.strictEqual(out.alert.walletCount, 3);
  assert.ok(out.alert.buys.every(b => b.wallet !== 'A'));
});

test('a repeated event (same signature) is ignored', () => {
  const d = det();
  const b = buy('A', 'M', 0);
  d.addBuy(b); d.addBuy(Object.assign({}, buy('B', 'M', MIN)));
  const third = buy('C', 'M', 2 * MIN);
  assert.ok(d.addBuy(third));
  assert.strictEqual(d.addBuy(third), null, 'webhook redelivery does not raise another alert');
});

test('does not repeat the alert for the same group', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  assert.ok(d.addBuy(buy('C', 'M', 2 * MIN)));
  assert.strictEqual(d.addBuy(buy('A', 'M', 3 * MIN)), null);
  assert.strictEqual(d.addBuy(buy('B', 'M', 3.5 * MIN)), null);
});

test('a new wallet in the same wave updates the alert (no new-alert spam)', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  const first = d.addBuy(buy('C', 'M', 2 * MIN));
  const upd = d.addBuy(buy('D', 'M', 3 * MIN));
  assert.ok(upd);
  assert.strictEqual(upd.kind, 'update');
  assert.strictEqual(upd.alert.id, first.alert.id, 'same alert, it only grows');
  assert.strictEqual(upd.alert.walletCount, 4);
});

test('a clearly distinct new wave raises a new alert', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  const first = d.addBuy(buy('C', 'M', 2 * MIN));
  d.addBuy(buy('A', 'M', 30 * MIN)); d.addBuy(buy('B', 'M', 31 * MIN));
  const second = d.addBuy(buy('C', 'M', 32 * MIN));
  assert.ok(second);
  assert.strictEqual(second.kind, 'new');
  assert.notStrictEqual(second.alert.id, first.alert.id);
});

test('buys arriving out of order are handled by event time', () => {
  const d = det();
  d.addBuy(buy('C', 'M', 2 * MIN));
  d.addBuy(buy('A', 'M', 0));
  const out = d.addBuy(buy('B', 'M', 1 * MIN));
  assert.ok(out);
  assert.strictEqual(out.alert.walletCount, 3);
  assert.deepStrictEqual(out.alert.buys.map(b => b.wallet), ['A', 'B', 'C']);
});

test('the alert carries time, amount and signature for each wallet', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0, 2.5)); d.addBuy(buy('B', 'M', MIN, null));
  const out = d.addBuy(buy('C', 'M', 2 * MIN, 0.4));
  const b = out.alert.buys;
  assert.strictEqual(b[0].solAmount, 2.5);
  assert.strictEqual(b[1].solAmount, null, 'a missing amount stays missing, it does not become 0');
  assert.ok(b[2].signature && b[2].ts === T0 + 2 * MIN);
});

test('prune drops old data and frees memory', () => {
  const d = det();
  d.addBuy(buy('A', 'M', 0)); d.addBuy(buy('B', 'M', MIN));
  d.prune(T0 + 60 * MIN);
  assert.strictEqual(d.buysByMint.size, 0);
  assert.strictEqual(d.seen.size, 0);
});
