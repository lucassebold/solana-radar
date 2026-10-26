'use strict';
const { parseBuys } = require('../src/buyParser');

const real = require('./fixtures/real_buy.json');
const notBuy = require('./fixtures/not_buy.json');

function monitored(w) { return a => a === w; }

test('compra real da Pump.fun/PumpSwap (transacao capturada) e detectada pela variacao de saldo', () => {
  const buys = parseBuys(real.tx, monitored(real.wallet), 0.01);
  assert.strictEqual(buys.length, 1);
  assert.strictEqual(buys[0].wallet, real.wallet);
  assert.strictEqual(buys[0].mint, real.mint);
  assert.ok(Math.abs(buys[0].solAmount - 10.0015) < 0.01, 'gastou ~10 SOL');
  assert.strictEqual(buys[0].signature, real.tx.signature);
  assert.strictEqual(buys[0].ts, real.tx.timestamp * 1000);
});

test('detecta a compra mesmo quando a Helius rotula o tipo errado (TRANSFER)', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.type = 'TRANSFER'; tx.source = 'SYSTEM_PROGRAM';
  assert.strictEqual(parseBuys(tx, monitored(real.wallet), 0.01).length, 1);
});

test('recebimento de token sem gastar SOL (airdrop/transferencia capturada) nao e compra', () => {
  assert.deepStrictEqual(parseBuys(notBuy.tx, monitored(notBuy.wallet), 0.01), []);
});

test('venda (token sai, SOL entra) nao e compra', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.accountData.forEach(a => {
    if (a.account === real.wallet) a.nativeBalanceChange = Math.abs(a.nativeBalanceChange);
    (a.tokenBalanceChanges || []).forEach(c => {
      if (c.userAccount === real.wallet) c.rawTokenAmount.tokenAmount = String(-Math.abs(Number(c.rawTokenAmount.tokenAmount)));
    });
  });
  assert.deepStrictEqual(parseBuys(tx, monitored(real.wallet), 0.01), []);
});

test('transacao que falhou nao conta', () => {
  const tx = JSON.parse(JSON.stringify(real.tx));
  tx.transactionError = { InstructionError: [0, 'Custom'] };
  assert.deepStrictEqual(parseBuys(tx, monitored(real.wallet), 0.01), []);
});

test('carteira que nao esta no ranking e ignorada', () => {
  assert.deepStrictEqual(parseBuys(real.tx, monitored('OUTRA'), 0.01), []);
});

test('entrada invalida nao quebra', () => {
  assert.deepStrictEqual(parseBuys(null, monitored('x'), 0.01), []);
  assert.deepStrictEqual(parseBuys({}, monitored('x'), 0.01), []);
  assert.deepStrictEqual(parseBuys({ signature: 's', accountData: 'lixo' }, monitored('x'), 0.01), []);
});

test('compra paga com WSOL (Jupiter) e detectada', () => {
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

test('trocar SOL por stablecoin nao e compra de token', () => {
  const W = 'WALLET1', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tx = { signature: 's2', timestamp: 1000, accountData: [
    { account: W, nativeBalanceChange: -1000000000, tokenBalanceChanges: [
      { userAccount: W, mint: USDC, rawTokenAmount: { tokenAmount: '150000000', decimals: 6 } } ] }
  ] };
  assert.deepStrictEqual(parseBuys(tx, a => a === W, 0.01), []);
});

test('varios tokens na mesma transacao: valor em SOL fica ausente (nao e dividido no chute)', () => {
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
