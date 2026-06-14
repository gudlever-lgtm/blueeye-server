'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalize } = require('../../lib/canonicalize');
const { verifyProof } = require('../verify');
const { PROTOCOL_VERSION } = require('../../protocol');

// Golden cross-repo vector: the IDENTICAL fixture is committed to blueeye-licens
// (test/proof-vector.json). blueeye-licens asserts its signer reproduces the
// signature over these exact bytes; this side asserts the verifier accepts them.
// A failure here means the signed-bytes contract (canonicalize) has drifted
// between the repos — fix the code, do not regenerate the fixture on one side.
const vector = require('./proof-vector.json');

test('canonicalize reproduces the shared golden vector byte-for-byte', () => {
  assert.equal(canonicalize(vector.payload), vector.canonical);
});

test('verifyProof accepts the shared golden vector', () => {
  assert.equal(verifyProof(vector.payload, vector.signatureBase64, vector.publicKeyPem), true);
});

test('verifyProof rejects the golden vector once tampered', () => {
  const tampered = { ...vector.payload, zulu: 'changed' };
  assert.equal(verifyProof(tampered, vector.signatureBase64, vector.publicKeyPem), false);
});

test('server PROTOCOL_VERSION matches the shared contract vector (agent lockstep)', () => {
  assert.equal(PROTOCOL_VERSION, vector.protocolVersion);
});
