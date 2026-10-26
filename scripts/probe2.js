const fs = require('fs'), https = require('https');
const env = {};
fs.readFileSync(__dirname + '/../.env', 'utf8').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).trim(); });
const get = (url, headers) => new Promise((res, rej) => https.get(url, { headers }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
(async () => {
  const r = await get('https://madeonsol.com/api/v1/kol/leaderboard?period=30d&limit=50', { Authorization: 'Bearer ' + env.MADEONSOL_API_KEY });
  const lb = JSON.parse(r.body).leaderboard;
  console.log('carteiras:', lb.length, 'campos:', Object.keys(lb[0]).length);
  const ev = lb.map(w => w.buy_count + w.sell_count);
  const tot = ev.reduce((a, b) => a + b, 0);
  console.log('eventos (compras+vendas) 30d no top50:', tot, '=> ~', Math.round(tot / 30), '/dia');
  console.log('top5 por volume de eventos:', lb.map(w => [w.name, w.buy_count + w.sell_count]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x.join(':')).join(' | '));
  console.log('completos:', lb.filter(w => w.completeness === 'complete').length);
  fs.writeFileSync(__dirname + '/../.lb_sample.json', JSON.stringify(lb.map(w => ({ n: w.name, w: w.wallet, ev: w.buy_count + w.sell_count }))));
  // Helius: carteira com poucos eventos, so 3 transacoes
  const pick = lb.slice().sort((a, b) => (a.buy_count + a.sell_count) - (b.buy_count + b.sell_count))[10];
  console.log('carteira de teste:', pick.name, pick.wallet.slice(0, 6) + '...', 'eventos:', pick.buy_count + pick.sell_count);
  const h = await get(`https://api-mainnet.helius-rpc.com/v0/addresses/${pick.wallet}/transactions?api-key=${env.HELIUS_API_KEY}&limit=3`, {});
  console.log('HELIUS status', h.status);
  if (h.status !== 200) return console.log(h.body.slice(0, 300).replace(env.HELIUS_API_KEY, '***'));
  const txs = JSON.parse(h.body);
  txs.forEach(t => console.log(t.type, t.source, t.timestamp, 'tokenTransfers:', t.tokenTransfers && t.tokenTransfers.length, 'swapEvent:', !!(t.events && t.events.swap), t.signature.slice(0, 10)));
  fs.writeFileSync(__dirname + '/../.helius_sample.json', JSON.stringify(txs[0], null, 1));
})();
