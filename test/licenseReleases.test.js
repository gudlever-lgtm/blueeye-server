'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createLicenseManager } = require('../src/license/licenseManager');
const { createMemoryCache } = require('../src/license/licenseCache');
const { canonicalize } = require('../src/lib/canonicalize');

const silentLogger = { info() {}, warn() {}, error() {} };
const NOW = 1_750_000_000_000;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const sign = (payload) => crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');

const RELEASES = {
  server: { version: '1.4.0', released_at: '2026-07-20' },
  agent: { version: '0.20.1', released_at: null },
  checked_at: '2026-07-28T09:00:00.000Z',
};

// Signs a fresh proof per request, echoing the nonce — exactly what
// blueeye-licens does; anything else is rejected by the manager.
function licensFetch(over = {}) {
  return async (_url, opts) => {
    const sent = JSON.parse(opts.body);
    const payload = {
      valid: true,
      expiry: null,
      limits: { max_agents: 5 },
      features: {},
      plan: 'professional',
      serverId: 'srv-1',
      issued_at: '2026-01-01T00:00:00.000Z',
      nonce: sent.nonce,
      releases: RELEASES,
      ...over,
    };
    return { status: 200, ok: true, json: async () => ({ payload, signature: sign(payload) }) };
  };
}

function manager({ fetchImpl, cache = createMemoryCache(), now = () => NOW } = {}) {
  return createLicenseManager({
    config: { key: 'lk', serverId: 'srv-1', serverUrl: 'http://licens', graceDays: 14, intervalHours: 6 },
    publicKey,
    cache,
    fetchImpl,
    now,
    logger: silentLogger,
  });
}

test('a verified proof exposes the published versions', async () => {
  const m = manager({ fetchImpl: licensFetch() });
  assert.equal(m.getAvailableReleases(), null); // nothing known before the first check

  await m.validateOnce();

  assert.deepEqual(m.getAvailableReleases(), {
    server: { version: '1.4.0', releasedAt: '2026-07-20' },
    agent: { version: '0.20.1', releasedAt: null },
    checkedAt: '2026-07-28T09:00:00.000Z',
  });
});

test('a proof without releases (older licens server) leaves it unknown', async () => {
  const m = manager({ fetchImpl: licensFetch({ releases: undefined }) });
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'valid'); // unchanged behaviour
  assert.equal(m.getAvailableReleases(), null);
});

test('an unsigned/tampered proof contributes no release info', async () => {
  // A proof whose signature does not cover the payload is rejected wholesale —
  // so a man-in-the-middle cannot inject a fake "update available" either.
  const tamperedFetch = async (_url, opts) => {
    const sent = JSON.parse(opts.body);
    const payload = {
      valid: true, expiry: null, limits: { max_agents: 5 }, features: {}, serverId: 'srv-1',
      issued_at: '2026-01-01T00:00:00.000Z', nonce: sent.nonce, releases: RELEASES,
    };
    const signature = sign(payload);
    payload.releases = { server: { version: '9.9.9', released_at: null }, agent: null, checked_at: null };
    return { status: 200, ok: true, json: async () => ({ payload, signature }) };
  };
  const m = manager({ fetchImpl: tamperedFetch });
  await m.validateOnce();
  assert.equal(m.getStatus().reason, 'invalid_signature');
  assert.equal(m.getAvailableReleases(), null);
});

test('a malformed version is dropped rather than shown as an update', async () => {
  const m = manager({
    fetchImpl: licensFetch({
      releases: { server: { version: 'latest', released_at: null }, agent: { version: '0.20.1', released_at: null }, checked_at: null },
    }),
  });
  await m.validateOnce();
  const releases = m.getAvailableReleases();
  assert.equal(releases.server, null);
  assert.equal(releases.agent.version, '0.20.1');
});

test('release info survives a restart via the cached proof', async () => {
  const cache = createMemoryCache();
  await manager({ fetchImpl: licensFetch(), cache }).validateOnce();

  // A fresh manager (restart) that cannot reach the licens server still knows.
  const restarted = manager({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    cache,
  });
  restarted.loadCache();
  assert.equal(restarted.getAvailableReleases().server.version, '1.4.0');
  await restarted.validateOnce();
  assert.equal(restarted.getStatus().status, 'grace');
  assert.equal(restarted.getAvailableReleases().server.version, '1.4.0');
});

test('a denied licence still learns about updates', async () => {
  // Knowing a newer version exists is not entitlement — an expired customer
  // must still see it (and their status must be unaffected by it).
  const m = manager({ fetchImpl: licensFetch({ valid: false, reason: 'expired' }) });
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'expired');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.getAvailableReleases().server.version, '1.4.0');
});

test('an unreachable licens server keeps the last known versions', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: licensFetch(), cache });
  await m.validateOnce();

  const offline = manager({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, cache });
  offline.loadCache();
  await offline.validateOnce();
  assert.equal(offline.getAvailableReleases().server.version, '1.4.0');
});
