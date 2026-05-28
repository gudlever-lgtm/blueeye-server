import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  randomUUID,
  generateKeyPairSync,
  createPublicKey,
  sign as cryptoSign,
} from 'node:crypto';

import { canonicalize, verifyResponse } from '../src/license/verify.js';
import { createLicenseManager } from '../src/license/manager.js';
import { LICENSE_PUBLIC_KEY_PEM } from '../src/license/publicKey.js';

// Throwaway signing key standing in for blueeye-licenseserver's private key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const DAY = 24 * 60 * 60 * 1000;
const SERVER_ID = 'srv-test';

function sign(payload, key = privateKey) {
  return cryptoSign(null, Buffer.from(canonicalize(payload), 'utf8'), key).toString('base64');
}

function response(payload, key = privateKey) {
  return { payload, signature: sign(payload, key), algorithm: 'ed25519' };
}

function payloadFor(overrides = {}) {
  return {
    valid: true,
    reason: null,
    licenseKey: 'KEY',
    serverId: SERVER_ID,
    agentCount: 0,
    expiry: '2099-01-01T00:00:00.000Z',
    limits: { max_agents: 10 },
    features: ['http', 'ping'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeManager(overrides = {}) {
  return createLicenseManager({
    enabled: true,
    licenseKey: 'KEY',
    serverId: SERVER_ID,
    serverUrl: 'http://license.invalid',
    publicKeyPem: PUBLIC_PEM,
    pollIntervalMs: 6 * 60 * 60 * 1000,
    graceMs: 14 * DAY,
    cachePath: join(tmpdir(), `blueeye-lic-${randomUUID()}.json`),
    ...overrides,
  });
}

function okFetch(resp) {
  return async () => ({ ok: true, status: 200, json: async () => resp });
}

function offlineFetch() {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

test('valid validation: verified, cached, and honored', async () => {
  const mgr = makeManager({ fetchImpl: okFetch(response(payloadFor({ limits: { max_agents: 25 } }))) });
  const result = await mgr.refresh();
  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.ok(existsSync(mgr.settings.cachePath), 'cache written to disk');

  const state = mgr.evaluate();
  assert.equal(state.honor, true);
  assert.equal(state.maxAgents, 25);
  assert.equal(mgr.canAcceptAgent(0).allowed, true);
});

test('invalid signature: rejected and not cached', () => {
  const mgr = makeManager();
  const resp = response(payloadFor());
  resp.signature = Buffer.from('garbage-signature').toString('base64');

  const result = mgr.recordValidation(resp);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid signature');
  assert.equal(mgr.loadCached(), null, 'nothing cached');
  assert.equal(mgr.evaluate().honor, false);
});

test('wrong serverId: rejected even with a valid signature', () => {
  const mgr = makeManager();
  // Correctly signed, but addressed to a different server.
  const result = mgr.recordValidation(response(payloadFor({ serverId: 'someone-else' })));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'serverId mismatch');
  assert.equal(mgr.loadCached(), null);
});

test('offline with valid cache: honored within grace period', async () => {
  const mgr = makeManager({ fetchImpl: offlineFetch() });
  const now = Date.now();
  // Seed a verified validation from 5 days ago.
  mgr.recordValidation(response(payloadFor({ limits: { max_agents: 8 } })), now - 5 * DAY);

  const refreshed = await mgr.refresh(now);
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.offline, true, 'refresh reports offline');

  const state = mgr.evaluate(now);
  assert.equal(state.honor, true, 'still honored within 14d grace');
  assert.equal(state.status, 'grace');
  assert.equal(state.maxAgents, 8);
  assert.equal(mgr.canAcceptAgent(3, now).allowed, true);
});

test('offline after grace expired: hard fail', () => {
  const mgr = makeManager();
  const now = Date.now();
  // Seed a verified validation from 15 days ago (> 14d grace).
  mgr.recordValidation(response(payloadFor()), now - 15 * DAY);

  const state = mgr.evaluate(now);
  assert.equal(state.honor, false);
  assert.equal(state.status, 'grace_expired');
  assert.equal(state.maxAgents, 0);
  assert.equal(mgr.canAcceptAgent(0, now).allowed, false);
});

test('agent over limit: rejected at the cap, accepted under it', () => {
  const mgr = makeManager();
  const now = Date.now();
  mgr.recordValidation(response(payloadFor({ limits: { max_agents: 2 } })), now);

  assert.equal(mgr.canAcceptAgent(1, now).allowed, true, '2nd agent allowed');
  const denied = mgr.canAcceptAgent(2, now);
  assert.equal(denied.allowed, false, '3rd agent rejected');
  assert.match(denied.reason, /max_agents=2/);
});

test('enforcement disabled when no license configured', () => {
  const mgr = makeManager({ enabled: false });
  assert.equal(mgr.evaluate().honor, true);
  assert.equal(mgr.canAcceptAgent(9999).allowed, true);
});

test('verifyResponse: accepts a good signature, rejects the wrong key', () => {
  const resp = response(payloadFor());
  assert.equal(verifyResponse(resp, PUBLIC_PEM).ok, true);

  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyResponse(resp, otherKey).ok, false);
});

test('embedded public key is a valid Ed25519 key', () => {
  const key = createPublicKey(LICENSE_PUBLIC_KEY_PEM);
  assert.equal(key.asymmetricKeyType, 'ed25519');
});
