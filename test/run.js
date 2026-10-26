'use strict';
// Minimal dependency-free test runner (Node 12). Usage: npm test
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
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n        ' + (e && e.message)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
  process.exit(failed ? 1 : 0);
})();
