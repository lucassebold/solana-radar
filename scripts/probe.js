// Sondagem somente leitura: nao imprime chaves.
const fs = require('fs');
const env = {};
fs.readFileSync(__dirname + '/../.env', 'utf8').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).trim(); });
const https = require('https');
function get(url, headers) {
  return new Promise((res, rej) => https.get(url, { headers }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej));
}
(async () => {
  const mk = { Authorization: 'Bearer ' + env.MADEONSOL_API_KEY };
  for (const p of ['/kol/leaderboard?period=30d&limit=3', '/kol/leaderboard?limit=3']) {
    const r = await get('https://madeonsol.com/api/v1' + p, mk);
    console.log('MADEONSOL', p, r.status, 'ratelimit:', r.headers['x-ratelimit-remaining'] || r.headers['x-ratelimit-remaining-day'] || '-');
    console.log(r.body.slice(0, 1500));
    if (r.status === 200) break;
  }
})();
