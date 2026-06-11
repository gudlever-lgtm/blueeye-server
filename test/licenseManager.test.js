'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createLicenseManager } = require('../src/license/licenseManager');
const { createMemoryCache } = require('../src/license/licenseCache');
const { canonicalize } = require('../src/lib/canonicalize');

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

// One key pair: the test signs proofs like blueeye-licens; the manager verifies.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function sign(payload) {
  return crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');
}

function proof(over = {}) {
  const payload = {
    valid: true,
    expiry: null,
    limits: { max_agents: 5 },
    features: { reporting: true },
    serverId: 'srv-1',
    issued_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  return { payload, signature: sign(payload) };
}

function okFetch(body) {
  return async () => ({ status: 200, ok: true, json: async () => body });
}
function statusFetch(status, body = {}) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
}
const offlineFetch = () => async () => {
  throw new Error('ECONNREFUSED');
};

function manager({ fetchImpl, cache = createMemoryCache(), now = () => NOW, getAgentCount } = {}) {
  return createLicenseManager({
    config: { key: 'lk', serverId: 'srv-1', serverUrl: 'http://licens', graceDays: 14, intervalHours: 6 },
    publicKey,
    cache,
    fetchImpl,
    now,
    logger: silentLogger,
    getAgentCount,
  });
}

test('status surfaces the proof expiry as validUntil (null when perpetual)', async () => {
  const noExpiry = manager({ fetchImpl: okFetch(proof()) });
  await noExpiry.validateOnce();
  assert.equal(noExpiry.getStatus().validUntil, null);

  const withExpiry = manager({ fetchImpl: okFetch(proof({ expiry: '2027-01-01T00:00:00.000Z' })) });
  await withExpiry.validateOnce();
  assert.equal(withExpiry.getStatus().validUntil, '2027-01-01T00:00:00.000Z');
});

test('valid validation -> status valid, licensed, cached', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: okFetch(proof()), cache });

  await m.validateOnce();

  assert.equal(m.getStatus().status, 'valid');
  assert.equal(m.isLicensed(), true);
  assert.equal(m.getMaxAgents(), 5);
  const cached = cache.read();
  assert.ok(cached && cached.payload.valid === true && typeof cached.verifiedAt === 'number');
});

// A signer that echoes the request's nonce into the signed proof (like the
// upgraded blueeye-licens), so we can exercise the anti-replay path.
function echoingNonceFetch() {
  return async (_url, opts) => {
    const sent = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => proof({ nonce: sent.nonce }) };
  };
}

test('a proof echoing the request nonce is accepted', async () => {
  const m = manager({ fetchImpl: echoingNonceFetch() });
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'valid');
});

test('a replayed proof with a stale nonce is rejected', async () => {
  // Always returns a proof carrying a FIXED nonce, never the one just sent.
  const stale = proof({ nonce: 'stale-captured-nonce' });
  const m = manager({ fetchImpl: okFetch(stale) });
  await m.validateOnce();
  assert.notEqual(m.getStatus().status, 'valid');
  assert.equal(m.getStatus().reason, 'nonce_mismatch');
});

test('invalid signature -> rejected, not licensed, not cached', async () => {
  const cache = createMemoryCache();
  const { payload } = proof();
  const m = manager({ fetchImpl: okFetch({ payload, signature: 'bm90LWEtc2lnbmF0dXJl' }), cache });

  await m.validateOnce();

  assert.notEqual(m.getStatus().status, 'valid');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.getStatus().reason, 'invalid_signature');
  assert.equal(cache.read(), null);
});

test('wrong serverId -> rejected even with a valid signature', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: okFetch(proof({ serverId: 'someone-else' })), cache });

  await m.validateOnce();

  assert.notEqual(m.getStatus().status, 'valid');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.getStatus().reason, 'server_mismatch');
  assert.equal(cache.read(), null);
});

test('offline with a valid cache within grace -> grace, still licensed', async () => {
  const { payload, signature } = proof();
  const cache = createMemoryCache({ payload, signature, verifiedAt: NOW });
  const m = manager({ fetchImpl: offlineFetch(), cache, now: () => NOW + 5 * DAY });

  m.loadCache();
  await m.validateOnce();

  assert.equal(m.getStatus().status, 'grace');
  assert.equal(m.isLicensed(), true);
  assert.equal(m.getMaxAgents(), 5);
});

test('offline after grace expired -> unlicensed (hard fail)', async () => {
  const { payload, signature } = proof();
  const cache = createMemoryCache({ payload, signature, verifiedAt: NOW });
  const m = manager({ fetchImpl: offlineFetch(), cache, now: () => NOW + 15 * DAY });

  m.loadCache();
  await m.validateOnce();

  assert.equal(m.getStatus().status, 'unlicensed');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.canAcceptNewConnection(0), false);
});

test('enforces max_agents on new connections', async () => {
  const m = manager({ fetchImpl: okFetch(proof({ limits: { max_agents: 2 } })) });

  await m.validateOnce();

  assert.equal(m.isLicensed(), true);
  assert.equal(m.canAcceptNewConnection(0), true);
  assert.equal(m.canAcceptNewConnection(1), true);
  assert.equal(m.canAcceptNewConnection(2), false); // at the limit -> reject new
  assert.equal(m.canAcceptNewConnection(3), false);
});

test('unlicensed (no cache, offline) -> no new connections allowed', async () => {
  const m = manager({ fetchImpl: offlineFetch(), cache: createMemoryCache() });

  await m.validateOnce();

  assert.equal(m.isLicensed(), false);
  assert.equal(m.canAcceptNewConnection(0), false);
});

test('a signed valid:false proof -> invalid, not licensed, not cached', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: okFetch(proof({ valid: false, reason: 'status_revoked' })), cache });

  await m.validateOnce();

  assert.equal(m.getStatus().status, 'invalid');
  assert.equal(m.isLicensed(), false);
  assert.equal(cache.read(), null);
});

test('a signed valid:false/expired proof -> expired (distinct from invalid)', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: okFetch(proof({ valid: false, reason: 'expired' })), cache });

  await m.validateOnce();

  const status = m.getStatus();
  assert.equal(status.status, 'expired'); // not the catch-all 'invalid'
  assert.equal(status.reason, 'expired'); // surfaced cleanly, no 'invalid:' prefix
  assert.equal(m.isLicensed(), false); // expired is still not licensed
  assert.equal(cache.read(), null); // not cached as valid
});

test('a non-200 response falls back to cache + grace (does not hard-reject)', async () => {
  const { payload, signature } = proof();
  const cache = createMemoryCache({ payload, signature, verifiedAt: NOW });
  const m = manager({ fetchImpl: statusFetch(404, { error: 'not found' }), cache, now: () => NOW + DAY });

  m.loadCache();
  await m.validateOnce();

  assert.equal(m.getStatus().status, 'grace');
  assert.equal(m.isLicensed(), true);
});

test('sends licenseKey, serverId and agentCount in the request', async () => {
  let sentBody;
  const { payload, signature } = proof();
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => ({ payload, signature }) };
  };
  const m = manager({ fetchImpl, getAgentCount: () => 7 });

  await m.validateOnce();

  assert.equal(sentBody.licenseKey, 'lk');
  assert.equal(sentBody.serverId, 'srv-1');
  assert.equal(sentBody.agentCount, 7);
});
