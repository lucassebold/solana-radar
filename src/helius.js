'use strict';
const { request, parseJson, scrub } = require('./http');

const BASE = 'https://api-mainnet.helius-rpc.com/v0/webhooks';

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}

// Garante UM webhook "enhanced" nosso apontando para webhookUrl, com exatamente `wallets`.
// - So mexe no webhook cuja URL e a nossa (nunca em outros da conta).
// - So edita se a lista mudou (cada criacao/edicao custa 100 creditos).
// Retorna {action: 'created'|'updated'|'unchanged', id}.
async function ensureWebhook(apiKey, webhookUrl, secret, wallets) {
  const url = BASE + '?api-key=' + apiKey;
  const fail = (what, res) => new Error('Helius ' + what + ' falhou (' + res.status + '): ' + scrub(res.body.slice(0, 200), [apiKey, secret]));

  const list = await request('GET', url);
  if (list.status !== 200) throw fail('listar webhooks', list);
  const existing = (parseJson(list.body) || []).find(w => w.webhookURL === webhookUrl);

  const body = {
    webhookURL: webhookUrl,
    transactionTypes: ['ANY'], // o tipo da Helius e pouco confiavel na Pump.fun; classificamos nos mesmos
    accountAddresses: wallets,
    webhookType: 'enhanced',
    authHeader: secret
  };

  if (!existing) {
    const r = await request('POST', url, { json: body });
    if (r.status !== 200 && r.status !== 201) throw fail('criar webhook', r);
    return { action: 'created', id: (parseJson(r.body) || {}).webhookID };
  }
  if (sameSet(existing.accountAddresses || [], wallets) && (existing.authHeader === undefined || existing.authHeader === secret)) {
    return { action: 'unchanged', id: existing.webhookID };
  }
  const r = await request('PUT', BASE + '/' + existing.webhookID + '?api-key=' + apiKey, { json: body });
  if (r.status !== 200) throw fail('atualizar webhook', r);
  return { action: 'updated', id: existing.webhookID };
}

module.exports = { ensureWebhook, sameSet };
