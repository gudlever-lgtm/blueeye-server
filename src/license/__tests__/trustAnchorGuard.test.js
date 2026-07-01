'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isKeyOverrideAllowed, OVERRIDE_ACK_TOKEN } = require('../trustAnchorGuard');
const { resolvePublicKey, publicKeySource, EMBEDDED_PUBLIC_KEY } = require('../publicKey');

const REAL_PEM = '-----BEGIN PUBLIC KEY-----\nnot-a-real-key-just-pem-shaped\n-----END PUBLIC KEY-----';

test('isKeyOverrideAllowed: allowed outside production regardless of ack', () => {
  assert.equal(isKeyOverrideAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(isKeyOverrideAllowed({ NODE_ENV: 'test' }), true);
  assert.equal(isKeyOverrideAllowed({}), true);
});

test('isKeyOverrideAllowed: blocked in production without the ack', () => {
  assert.equal(isKeyOverrideAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(isKeyOverrideAllowed({ NODE_ENV: 'production', TRUST_ANCHOR_OVERRIDE_ACK: 'yes' }), false);
});

test('isKeyOverrideAllowed: allowed in production with the exact ack token', () => {
  assert.equal(
    isKeyOverrideAllowed({ NODE_ENV: 'production', TRUST_ANCHOR_OVERRIDE_ACK: OVERRIDE_ACK_TOKEN }),
    true
  );
  // case-insensitive / trims whitespace
  assert.equal(
    isKeyOverrideAllowed({ NODE_ENV: 'production', TRUST_ANCHOR_OVERRIDE_ACK: `  ${OVERRIDE_ACK_TOKEN.toUpperCase()}  ` }),
    true
  );
});

test('resolvePublicKey: env override honoured outside production', () => {
  assert.equal(resolvePublicKey({ NODE_ENV: 'development', LICENSE_PUBLIC_KEY: REAL_PEM }), REAL_PEM);
});

test('resolvePublicKey: env override ignored in production without the ack — falls back to embedded', () => {
  assert.equal(resolvePublicKey({ NODE_ENV: 'production', LICENSE_PUBLIC_KEY: REAL_PEM }), EMBEDDED_PUBLIC_KEY);
});

test('resolvePublicKey: env override honoured in production with the ack', () => {
  assert.equal(
    resolvePublicKey({ NODE_ENV: 'production', LICENSE_PUBLIC_KEY: REAL_PEM, TRUST_ANCHOR_OVERRIDE_ACK: OVERRIDE_ACK_TOKEN }),
    REAL_PEM
  );
});

test('resolvePublicKey: no env var set -> embedded, in any environment', () => {
  assert.equal(resolvePublicKey({ NODE_ENV: 'production' }), EMBEDDED_PUBLIC_KEY);
  assert.equal(resolvePublicKey({ NODE_ENV: 'development' }), EMBEDDED_PUBLIC_KEY);
});

test('publicKeySource reports embedded / env / blocked correctly', () => {
  assert.equal(publicKeySource({ NODE_ENV: 'production' }), 'embedded');
  assert.equal(publicKeySource({ NODE_ENV: 'production', LICENSE_PUBLIC_KEY: REAL_PEM }), 'blocked');
  assert.equal(
    publicKeySource({ NODE_ENV: 'production', LICENSE_PUBLIC_KEY: REAL_PEM, TRUST_ANCHOR_OVERRIDE_ACK: OVERRIDE_ACK_TOKEN }),
    'env'
  );
  assert.equal(publicKeySource({ NODE_ENV: 'development', LICENSE_PUBLIC_KEY: REAL_PEM }), 'env');
});
