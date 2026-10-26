'use strict';
const { parseBuys } = require('../src/buyParser');

// Real transactions captured from Helius (public on-chain data).
const real = require('./fixtures/real_buy.json');
const notBuy = require('./fixtures/not_buy.json');

function monitored(w) { return a => a === w; }

test('a real PumpSwap buy (captured transaction) is detected from balance changes', () => {
  const buys = parseBuys(real.tx, monitored(real.wallet), 0.01);
  assert.strictEqual(buys.length, 1);
  assert.strictEqual(buys[0].wallet, real.wallet);
  assert.strictEqual(buys[0].mint, real.mint);
  assert.ok(Math.abs(buys[0].solAmount - 10.0015) < 0.01, 'spent ~10 SOL');
  assert.strictEqual(buys[0].signature, real.tx.signature);
  assert.strictEqual(buys[0].ts, real.tx.timestamp * 1000);
});

test('detects the buy even when Helius mislabels the type (TRANSFER)', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.type = 'TRANSFER'; tx.source = 'SYSTEM_PROGRAM';
  assert.strictEqual(parseBuys(tx, monitored(real.wallet), 0.01).length, 1);
});

test('receiving a token without spending SOL (captured airdrop/transfer) is not a buy', () => {
  assert.deepStrictEqual(parseBuys(notBuy.tx, monitored(notBuy.wallet), 0.01), []);
});

test('a sell (token out, SOL in) is not a buy', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.accountData.forEach(a => {
    if (a.account === real.wallet) a.nativeBalanceChange = Math.abs(a.nativeBalanceChange);
    (a.tokenBalanceChanges || []).forEach(c => {
      if (c.userAccount === real.wallet) c.rawTokenAmount.tokenAmount = String(-Math.abs(Number(c.rawTokenAmount.tokenAmount)));
    });
  });
  assert.deepStrictEqual(parseBuys(tx, monitored(real.wallet), 0.01), []);
});

test('a failed transaction does not count', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.transactionError = { InstructionError: [0, 'Custom'] };
  assert.deepStrictEqual(parseBuys(tx, monitored(real.wallet), 0.01), []);
});

test('a wallet that is not in the ranking is ignored', () => {
  assert.deepStrictEqual(parseBuys(real.tx, monitored('OTHER'), 0.01), []);
});

test('invalid input does not throw', () => {
  assert.deepStrictEqual(parseBuys(null, monitored('x'), 0.01), []);
  assert.deepStrictEqual(parseBuys({}, monitored('x'), 0.01), []);
  assert.deepStrictEqual(parseBuys({ signature: 's', accountData: 'junk' }, monitored('x'), 0.01), []);
});

test('a buy paid with WSOL (Jupiter) is detected', () => {
  const W = 'WALLET1', M = 'MINT1', WSOL = 'So11111111111111111111111111111111111111112';
  const tx = { signature: 's1', timestamp: 1000, accountData: [
    { account: W, nativeBalanceChange: -5000, tokenBalanceChanges: [] },
    { account: 'ata1', nativeBalanceChange: 0, tokenBalanceChanges: [
      { userAccount: W, mint: WSOL, rawTokenAmount: { tokenAmount: '-2000000000', decimals: 9 } },
      { userAccount: W, mint: M, rawTokenAmount: { tokenAmount: '5000000', decimals: 6 } } ] }
  ] };
  const b = parseBuys(tx, a => a === W, 0.01);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].mint, M);
  assert.ok(Math.abs(b[0].solAmount - 2) < 1e-4);
});

test('swapping SOL for a stablecoin is not a token buy', () => {
  const W = 'WALLET1', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tx = { signature: 's2', timestamp: 1000, accountData: [
    { account: W, nativeBalanceChange: -1000000000, tokenBalanceChanges: [
      { userAccount: W, mint: USDC, rawTokenAmount: { tokenAmount: '150000000', decimals: 6 } } ] }
  ] };
  assert.deepStrictEqual(parseBuys(tx, a => a === W, 0.01), []);
});

test('several tokens in one transaction: the SOL amount stays missing (no guessing)', () => {
  const W = 'WALLET1';
  const tx = { signature: 's3', timestamp: 1000, accountData: [
    { account: W, nativeBalanceChange: -3000000000, tokenBalanceChanges: [
      { userAccount: W, mint: 'MA', rawTokenAmount: { tokenAmount: '10', decimals: 0 } },
      { userAccount: W, mint: 'MB', rawTokenAmount: { tokenAmount: '20', decimals: 0 } } ] }
  ] };
  const b = parseBuys(tx, a => a === W, 0.01);
  assert.strictEqual(b.length, 2);
  assert.ok(b.every(x => x.solAmount === null));
});
