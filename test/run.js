'use strict';
// Runner minimo sem dependencias (Node 12). Uso: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
global.test = (name, fn) => tests.push({ name, fn });
global.assert = assert;

fs.readdirSync(__dirname).filter(f => /\.test\.js$/.test(f)).sort().forEach(f => require(path.join(__dirname, f)));

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FALHA ' + t.name + '\n        ' + (e && e.message)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' testes passaram');
  process.exit(failed ? 1 : 0);
})();
