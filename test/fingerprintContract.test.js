'use strict';

// src/lib/fingerprint.js is a CROSS-REPO contract.
//
// This repo signs a key's fingerprint into the licence proof. blueeye-agent
// computes the fingerprint of the key its server offers and compares the two.
// If the two implementations disagree by a single byte, no agent accepts any
// key — and the symptom is a fleet that simply stops updating, with every
// signature otherwise valid.
//
// So the file is pinned by digest here, in blueeye-server and in blueeye-agent
// (test/gate/_contracts.js). Changing it means changing all three.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { publicKeyFingerprint, isFingerprint } = require('../src/lib/fingerprint');

const FINGERPRINT_DIGEST = '22351ca4ca228ed751f8c80c9202c14665885e551e56a003336a09b6a0b5e661';
const FILE = path.join(__dirname, '..', 'src', 'lib', 'fingerprint.js');

// The digest is over the CODE, not the comments: each repo explains the file in
// its own terms, and only a change to what it computes may break the pin. Same
// function as blueeye-agent's test/gate/_contracts.js digestOf.
function digestOf(source) {
  const stripped = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, '');
  return crypto.createHash('sha256').update(stripped, 'utf8').digest('hex');
}

test('the fingerprint implementation still matches the pinned cross-repo digest', () => {
  const actual = digestOf(fs.readFileSync(FILE, 'utf8'));
  assert.equal(
    actual, FINGERPRINT_DIGEST,
    'src/lib/fingerprint.js changed.\n'
    + 'It is duplicated byte-for-byte in blueeye-licens (src/lib/fingerprint.js) and\n'
    + 'blueeye-agent (src/release/fingerprint.js). Apply the same change there, then\n'
    + `update the pinned digest in all three repos to:\n  ${actual}`
  );
});

test('the same key fingerprints identically however it was written down', () => {
  const pem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fp = publicKeyFingerprint(pem);
  assert.ok(isFingerprint(fp));
  for (const shape of [pem.replace(/\n/g, '\r\n'), pem.trimEnd(), `${pem}\n\n`, Buffer.from(pem).toString('base64')]) {
    assert.equal(publicKeyFingerprint(shape), fp);
  }
});
