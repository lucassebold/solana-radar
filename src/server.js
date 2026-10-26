'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { RadarApp } = require('./app');
const { scrub } = require('./http');

const secrets = [cfg.heliusKey, cfg.madeonsolKey, cfg.webhookSecret];
const log = msg => console.log(new Date().toISOString().slice(11, 19) + ' ' + scrub(msg, secrets));

const missing = [];
if (!cfg.heliusKey && cfg.publicUrl) missing.push('HELIUS_API_KEY');
if (!cfg.madeonsolKey) missing.push('MADEONSOL_API_KEY');
if (cfg.publicUrl && cfg.webhookSecret.length < 16) missing.push('WEBHOOK_SECRET (min. 16 caracteres)');
if (missing.length) { console.error('Configure no .env: ' + missing.join(', ')); process.exit(1); }

const app = new RadarApp(cfg, log);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 5 * 1024 * 1024;
const sseClients = new Set();

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function handleWebhook(req, res) {
  // A Helius envia o `authHeader` configurado no webhook no cabecalho Authorization.
  if (!cfg.webhookSecret || !safeEqual(req.headers.authorization || '', cfg.webhookSecret)) {
    res.writeHead(401); return res.end();
  }
  const chunks = []; let size = 0; let aborted = false;
  req.on('data', d => {
    size += d.length;
    if (size > MAX_BODY) { aborted = true; res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400); return res.end(); }
    try { app.handleWebhook(body); } catch (e) { log('erro ao processar webhook: ' + e.message); }
    res.writeHead(200); res.end('ok'); // sempre 200 rapido: erro 5xx faria a Helius reenviar (e cobrar de novo)
  });
}

function serveStatic(req, res) {
  const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/webhook/helius') return handleWebhook(req, res);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url === '/api/state') return sendJson(res, 200, app.snapshot());
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify(app.snapshot()) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  serveStatic(req, res);
});

app.onChange(snap => {
  const msg = 'data: ' + JSON.stringify(snap) + '\n\n';
  sseClients.forEach(c => c.write(msg));
});
setInterval(() => sseClients.forEach(c => c.write(': ping\n\n')), 25000).unref();

server.listen(cfg.port, () => {
  log('SOLANA RADAR em http://localhost:' + cfg.port + (cfg.publicUrl ? ' (webhook: ' + cfg.publicUrl + '/webhook/helius)' : ' (modo local: sem webhook)'));
  app.start();
});
