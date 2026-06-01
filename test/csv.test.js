'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toCsv, cell } = require('../src/lib/csv');

test('cell stringifies, joins arrays, ISO-formats dates, and quotes when needed', () => {
  assert.equal(cell('plain'), 'plain');
  assert.equal(cell(42), '42');
  assert.equal(cell(null), '');
  assert.equal(cell(['a', 'b']), 'a;b');
  assert.equal(cell(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell('he said "hi"'), '"he said ""hi"""');
  assert.equal(cell('line1\nline2'), '"line1\nline2"');
});

test('toCsv emits a header and one line per row, in column order', () => {
  const out = toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2, b: 'y,z' }]);
  assert.equal(out, 'a,b\n1,x\n2,"y,z"\n');
});

test('toCsv emits just the header for no rows', () => {
  assert.equal(toCsv(['a', 'b'], []), 'a,b\n');
});
