const fs = require('fs'), https = require('https');
const env = {};
fs.readFileSync(__dirname + '/../.env', 'utf8').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).trim(); });
const req = (method, url, headers, body) => new Promise((res, rej) => { const r = https.request(url, { method, headers }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', rej); if (body) r.write(body); r.end(); });
(async () => {
  const f = await req('GET', 'https://madeonsol.com/api/v1/kol/feed?limit=100&action=buy', { Authorization: 'Bearer ' + env.MADEONSOL_API_KEY });
  const trades = JSON.parse(f.body).trades.slice(0, 6);
  const h = await req('POST', `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${env.HELIUS_API_KEY}`, { 'Content-Type': 'application/json' }, JSON.stringify({ transactions: trades.map(t => t.tx_signature) }));
  console.log('HELIUS', h.status);
  const txs = JSON.parse(h.body);
  trades.forEach((t, i) => {
    const x = txs.find(y => y.signature === t.tx_signature);
    if (!x) return console.log(i, 'nao retornou');
    const ad = (x.accountData || []).find(a => a.account === t.wallet_address);
    const tb = ad && (ad.tokenBalanceChanges || []);
    const tbAll = (x.accountData || []).flatMap(a => a.tokenBalanceChanges || []).filter(c => c.userAccount === t.wallet_address && c.mint === t.token_mint);
    console.log(i, 'type', x.type, 'source', x.source, 'swap?', !!(x.events && x.events.swap),
      '| MadeOnSol sol', t.sol_amount.toFixed(3), '| helius nativeBalanceChange wallet(SOL)', ad ? (ad.nativeBalanceChange / 1e9).toFixed(3) : 'n/a',
      '| tokenBalanceChange', tbAll.map(c => c.rawTokenAmount.tokenAmount / Math.pow(10, c.rawTokenAmount.decimals)).join(','), 'vs', Math.round(t.token_amount),
      '| latencia s', Math.round((Date.now() / 1000) - x.timestamp));
  });
  fs.writeFileSync(__dirname + '/../.helius_buy.json', JSON.stringify(txs[0], null, 1));
})();
