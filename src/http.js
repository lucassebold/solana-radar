'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Minimal HTTP client (Node 12 has no fetch). Always resolves with {status, headers, body}.
function request(method, urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request(u, { method, headers, timeout: opts.timeout || 15000 }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// Masks secrets in error/log messages.
function scrub(text, secrets) {
  let out = String(text);
  (secrets || []).forEach(s => { if (s) out = out.split(s).join('***'); });
  return out;
}

module.exports = { request, parseJson, scrub };
