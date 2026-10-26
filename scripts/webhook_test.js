// Teste temporario de latencia do webhook Helius. Cria 1 webhook, coleta ~8 min, apaga. Nao imprime chaves.
const fs = require('fs'), https = require('https');
const env = {};
fs.readFileSync(__dirname + '/../.env', 'utf8').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).trim(); });
const KEY = env.HELIUS_API_KEY;
const req = (method, url, headers, body) => new Promise((res, rej) => { const r = https.request(url, { method, headers }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', rej); if (body) r.write(body); r.end(); });
const H = u => `https://api-mainnet.helius-rpc.com/v0/webhooks${u || ''}?api-key=${KEY}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let webhookId = null;
async function cleanup() {
  if (!webhookId) return;
  const d = await req('DELETE', H('/' + webhookId), {});
  console.log('webhook apagado, status', d.status);
  webhookId = null;
}
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });
(async () => {
  // nao mexer em webhooks que ja existam
  const ex = await req('GET', H(), {});
  console.log('webhooks ja existentes na conta:', ex.status, ex.status === 200 ? JSON.parse(ex.body).length : ex.body.slice(0, 100));
  // carteiras mais ativas do feed
  const f = await req('GET', 'https://madeonsol.com/api/v1/kol/feed?limit=100&action=buy', { Authorization: 'Bearer ' + env.MADEONSOL_API_KEY });
  const cnt = {}; JSON.parse(f.body).trades.forEach(t => cnt[t.wallet_address] = (cnt[t.wallet_address] || 0) + 1);
  const wallets = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  console.log('carteiras monitoradas:', wallets.map(w => w.slice(0, 6) + '...').join(', '));
  const tok = JSON.parse((await req('POST', 'https://webhook.site/token', { 'Content-Type': 'application/json' }, JSON.stringify({ default_status: 200, default_content: 'ok' }))).body);
  const url = 'https://webhook.site/' + tok.uuid;
  const c = await req('POST', H(), { 'Content-Type': 'application/json' }, JSON.stringify({ webhookURL: url, transactionTypes: ['ANY'], accountAddresses: wallets, webhookType: 'enhanced' }));
  console.log('criar webhook status', c.status);
  let cj = null; try { cj = JSON.parse(c.body); } catch {}
  if (cj && cj.webhookID) webhookId = cj.webhookID;
  if (c.status !== 200 && c.status !== 201) { console.log(c.body.replace(KEY, '***').slice(0, 300)); await cleanup(); return; }
  const end = Date.now() + 8 * 60 * 1000;
  const seen = new Map();
  try {
    while (Date.now() < end) {
      await sleep(30000);
      const r = JSON.parse((await req('GET', `https://webhook.site/token/${tok.uuid}/requests?sorting=newest&per_page=100`, {})).body);
      for (const q of r.data || []) {
        let arr; try { arr = JSON.parse(q.content); } catch { continue; }
        const recv = new Date(q.created_at.replace(' ', 'T') + 'Z').getTime() / 1000;
        for (const t of arr) if (!seen.has(t.signature)) seen.set(t.signature, { recv, ts: t.timestamp, type: t.type, source: t.source });
      }
      console.log(new Date().toISOString().slice(11, 19), 'eventos recebidos:', seen.size);
    }
  } finally { await cleanup(); }
  const lat = [...seen.values()].map(x => x.recv - x.ts).sort((a, b) => a - b);
  if (!lat.length) return console.log('nenhum evento recebido');
  console.log('latencia (s) tx->aviso: min', lat[0].toFixed(1), 'mediana', lat[Math.floor(lat.length / 2)].toFixed(1), 'p90', lat[Math.floor(lat.length * .9)].toFixed(1), 'max', lat[lat.length - 1].toFixed(1));
  const bt = {}; [...seen.values()].forEach(x => { const k = x.type + '/' + x.source; bt[k] = (bt[k] || 0) + 1; }); console.log(bt);
})().catch(async e => { console.log('erro', String(e.message).replace(KEY, '***')); await cleanup(); });
