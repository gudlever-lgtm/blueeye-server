'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseXml } = require('../src/auth/samlXml');

// A deeply-nested document must be rejected during parsing rather than building a
// tree the recursive walkers (iterElements/canonicalize/textOf) later blow the
// stack on — a cheap DoS on the unauthenticated ACS endpoint.
test('parseXml rejects pathologically deep nesting instead of overflowing', () => {
  const depth = 5000;
  const xml = '<a>'.repeat(depth) + '</a>'.repeat(depth);
  assert.throws(() => parseXml(xml), /nesting too deep/i);
});

test('parseXml still accepts normally-nested documents', () => {
  const root = parseXml('<Response><Assertion><Subject><NameID>u@x</NameID></Subject></Assertion></Response>');
  assert.ok(root);
  assert.equal(root.local, 'Response');
});
