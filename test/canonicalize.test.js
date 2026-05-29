'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalize } = require('../src/lib/canonicalize');

// This MUST match blueeye-licens' canonical output byte-for-byte (same vector as
// that repo's canonicalize test) — otherwise signatures would never verify.
test('matches the license server canonical form byte-for-byte', () => {
  const payload = {
    valid: true,
    serverId: 's1',
    limits: { max_agents: 5 },
    features: { reporting: true, alpha: false },
    expiry: null,
    issued_at: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(
    canonicalize(payload),
    '{"expiry":null,"features":{"alpha":false,"reporting":true},"issued_at":"2026-01-01T00:00:00.000Z","limits":{"max_agents":5},"serverId":"s1","valid":true}'
  );
});

test('sorts keys recursively, no whitespace, arrays preserved', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalize({ arr: [3, { z: 1, a: 2 }] }), '{"arr":[3,{"a":2,"z":1}]}');
});
