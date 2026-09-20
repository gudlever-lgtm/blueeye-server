'use strict';

// GATE · CROSS-REPO CONTRACT — blueeye-server's half.
//
// Turns the "MUST stay identical / keep in sync" comments on the duplicated
// definitions into something that actually fails a build. See _contracts.js for
// what is pinned and why the pins have two layers.
//
// The sibling repos each run their own copy of this file against the SAME pins,
// so a change has to be made in all three before any of them go green — which
// is the handshake the comments were asking for and never got.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  CANONICALIZE_DIGEST, CANONICALIZE_VECTORS, PROTOCOL_VERSION,
  EVIDENCE_ITEMS, EVIDENCE_COMMAND_SET_VERSION, digestOf,
} = require('./_contracts');

const { canonicalize } = require('../../src/lib/canonicalize');
const { verifyProof } = require('../../src/license/verify');
const protocol = require('../../src/protocol');
const allowlist = require('../../src/evidence/commandAllowlist');

const CANONICALIZE_PATH = path.join(__dirname, '..', '..', 'src', 'lib', 'canonicalize.js');

test('canonicalize produces the exact bytes the licence signature is made over', () => {
  for (const { input, expected } of CANONICALIZE_VECTORS) {
    assert.equal(
      canonicalize(input), expected,
      `canonicalize drifted. Every licence proof is signed over these bytes — if this server\n` +
      `produces different ones, NO proof verifies on ANY install. Input: ${JSON.stringify(input)}`
    );
  }
});

test('canonicalize is byte-stable across calls and independent of key insertion order', () => {
  // The signer and the verifier build their object literals independently, so
  // insertion order must not reach the output.
  const a = canonicalize({ one: 1, two: { alpha: 'a', beta: 'b' } });
  const b = canonicalize({ two: { beta: 'b', alpha: 'a' }, one: 1 });
  assert.equal(a, b);
  assert.equal(canonicalize(a === b ? { x: 1 } : { x: 2 }), '{"x":1}');
});

test('the canonicalize implementation still matches the pinned cross-repo digest', () => {
  const actual = digestOf(fs.readFileSync(CANONICALIZE_PATH, 'utf8'));
  assert.equal(
    actual, CANONICALIZE_DIGEST,
    'src/lib/canonicalize.js changed.\n' +
    'It is duplicated byte-for-byte in blueeye-licens (src/lib/canonicalize.js) and\n' +
    'blueeye-agent (src/release/canonicalize.js). Apply the SAME change there, then\n' +
    `update CANONICALIZE_DIGEST in all three copies of test/gate/_contracts.js to:\n  ${actual}`
  );
});

test('PROTOCOL_VERSION matches the pin the agent is held to', () => {
  assert.equal(
    protocol.PROTOCOL_VERSION, PROTOCOL_VERSION,
    'src/protocol.js changed. blueeye-agent/src/protocol.js must change with it, and\n' +
    'PROTOCOL_VERSION in all three copies of test/gate/_contracts.js must be updated.'
  );
});

test('the evidence allowlist matches the pin the agent enforces its own copy against', () => {
  assert.deepEqual(
    [...allowlist.DEFAULT_ITEMS].sort(), EVIDENCE_ITEMS,
    'src/evidence/commandAllowlist.js changed. The agent keeps its OWN copy\n' +
    '(blueeye-agent/src/evidenceCollector.js READ_ONLY_ITEMS) as defense in depth —\n' +
    'an item added here but not there is silently refused by every agent; an item\n' +
    'removed here but not there is still collectable. Change both, then the pins.'
  );
  assert.equal(allowlist.COMMAND_SET_VERSION, EVIDENCE_COMMAND_SET_VERSION);
});

test('every allowlisted evidence item is read-only, and nothing else is allowed', () => {
  for (const name of allowlist.DEFAULT_ITEMS) {
    assert.equal(allowlist.ALLOWLIST[name].readOnly, true, `${name} is not marked read-only`);
    assert.equal(allowlist.isAllowed(name), true);
  }
  for (const name of ['reboot', 'iface.set', 'snmp.write', '../etc/passwd', '']) {
    assert.equal(allowlist.isAllowed(name), false, `${name} must never be allowed`);
  }
});

// The verifier's semantics are as much a contract as the bytes: blueeye-licens'
// verifyPayload and this verifyProof must agree on what counts as verified, and
// on the fact that NOTHING throws — a proof that makes the verifier throw would
// otherwise become a 500 instead of an unlicensed install.
test('verifyProof accepts a genuine signature over the canonical bytes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = { valid: true, plan_key: 'professional', max_agents: 25 };
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');
  assert.equal(verifyProof(payload, signature, publicKey), true);
});

test('verifyProof rejects a tampered payload, a foreign key and a malformed signature — and never throws', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: foreignKey } = crypto.generateKeyPairSync('ed25519');
  const payload = { valid: true, max_agents: 25 };
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');

  // The one that matters commercially: raising the agent cap after signing.
  assert.equal(verifyProof({ ...payload, max_agents: 9999 }, signature, publicKey), false);
  assert.equal(verifyProof(payload, signature, foreignKey), false);

  for (const bad of [null, undefined, '', 'not-base64!!', 'AAAA', 123, {}]) {
    assert.equal(verifyProof(payload, bad, publicKey), false, `signature ${JSON.stringify(bad)} must be rejected`);
  }
  for (const bad of [null, undefined, 0, '']) {
    assert.equal(verifyProof(bad, signature, publicKey), false, 'a missing payload is not verified');
    assert.equal(verifyProof(payload, signature, bad), false, 'a missing key is not verified');
  }
});
