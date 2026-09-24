'use strict';

// fmtUnit / fmtNum in public/app.js: one formatter for every chart axis, hover
// readout and rate column. app.js is one strict script, so the functions are
// lifted out of its source and run in a sandbox rather than through a boot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function lift(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, `could not find ${startMarker}`);
  return src.slice(a, b + endMarker.length);
}
const code = [
  lift('function fmtBytes(n) {', '\n}\n'),
  lift('function fmtBits(bps) {', "function fmtNum(v) { return fmtUnit(v, ''); }"),
].join('\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${code}\nthis.fmtUnit = fmtUnit; this.fmtNum = fmtNum;`, ctx);
const { fmtUnit, fmtNum } = ctx;

test('latency stays a time, never a byte count', () => {
  assert.equal(fmtUnit(1500, 'ms'), '1.50 s');
  assert.equal(fmtUnit(12.34, 'ms'), '12.3 ms');
  // fmtNum used to turn anything >= 1024 into bytes: an RTT of 1500 read 1.5 KB.
  assert.doesNotMatch(fmtNum(1500), /B/);
});

test('link rates are bits, error rates per second, absent is a dash', () => {
  assert.equal(fmtUnit(125e6, 'B/s'), '1.00 Gbit/s');
  assert.equal(fmtUnit(1.5e6, 'bit/s'), '1.5 Mbit/s');
  assert.equal(fmtUnit(0.25, '/s'), '0.25 /s');
  assert.equal(fmtUnit(42.2, '%'), '42.2 %');
  assert.equal(fmtUnit(null, 'ms'), '–');
  assert.equal(fmtUnit(2.5e6), '2.5M');
  assert.equal(fmtUnit(512, 'B'), '512 B');
});
