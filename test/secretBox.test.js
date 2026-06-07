'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSecretBox, deriveKey } = require('../src/lib/secretBox');

test('encrypt/decrypt round-trips a string', () => {
  const box = createSecretBox({ key: 'a-very-secret-key' });
  const token = box.encrypt('hunter2');
  assert.notEqual(token, 'hunter2');
  assert.match(token, /^v1\.gcm\./);
  assert.equal(box.decrypt(token), 'hunter2');
});

test('encryptJson/decryptJson round-trips an object', () => {
  const box = createSecretBox({ key: 'k' });
  const token = box.encryptJson({ username: 'svc', password: 'p@ss' });
  assert.ok(!token.includes('svc'));
  assert.ok(!token.includes('p@ss'));
  assert.deepEqual(box.decryptJson(token), { username: 'svc', password: 'p@ss' });
});

test('each encryption uses a fresh IV (ciphertexts differ)', () => {
  const box = createSecretBox({ key: 'k' });
  assert.notEqual(box.encrypt('same'), box.encrypt('same'));
});

test('empty/nullish values encrypt to "" and decrypt back to ""', () => {
  const box = createSecretBox({ key: 'k' });
  assert.equal(box.encrypt(''), '');
  assert.equal(box.encrypt(null), '');
  assert.equal(box.encrypt(undefined), '');
  assert.equal(box.decrypt(''), '');
  assert.deepEqual(box.decryptJson(''), {});
});

test('a wrong key cannot decrypt (auth tag fails closed)', () => {
  const a = createSecretBox({ key: 'key-a' });
  const b = createSecretBox({ key: 'key-b' });
  const token = a.encrypt('secret');
  assert.throws(() => b.decrypt(token));
});

test('a tampered ciphertext throws rather than returning wrong plaintext', () => {
  const box = createSecretBox({ key: 'k' });
  const token = box.encrypt('secret');
  const parts = token.split('.');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[4], 'base64url');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64url');
  assert.throws(() => box.decrypt(parts.join('.')));
});

test('a malformed token is rejected', () => {
  const box = createSecretBox({ key: 'k' });
  assert.throws(() => box.decrypt('not-a-token'));
  assert.throws(() => box.decrypt('v2.gcm.a.b.c'));
});

test('isEncrypted distinguishes tokens from plaintext', () => {
  const box = createSecretBox({ key: 'k' });
  assert.equal(box.isEncrypted(box.encrypt('x')), true);
  assert.equal(box.isEncrypted('plaintext'), false);
  assert.equal(box.isEncrypted(''), false);
});

test('deriveKey requires a non-empty key', () => {
  assert.throws(() => deriveKey(''));
  assert.throws(() => createSecretBox({ key: '' }));
});
