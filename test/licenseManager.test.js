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
// Signs a fresh proof per request, echoing the request's nonce into the signed
// payload — exactly what blueeye-licens does. The manager rejects anything else.
function licensFetch(over = {}) {
  return async (_url, opts) => {
    const sent = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => proof({ nonce: sent.nonce, ...over }) };
  };
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
  const noExpiry = manager({ fetchImpl: licensFetch() });
  await noExpiry.validateOnce();
  assert.equal(noExpiry.getStatus().validUntil, null);

  const withExpiry = manager({ fetchImpl: licensFetch({ expiry: '2027-01-01T00:00:00.000Z' }) });
  await withExpiry.validateOnce();
  assert.equal(withExpiry.getStatus().validUntil, '2027-01-01T00:00:00.000Z');
});

test('valid validation -> status valid, licensed, cached', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: licensFetch(), cache });

  await m.validateOnce();

  assert.equal(m.getStatus().status, 'valid');
  assert.equal(m.isLicensed(), true);
  assert.equal(m.getMaxAgents(), 5);
  const cached = cache.read();
  assert.ok(cached && cached.payload.valid === true && typeof cached.verifiedAt === 'number');
});

test('a proof echoing the request nonce is accepted', async () => {
  const m = manager({ fetchImpl: licensFetch() });
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

test('a proof without a nonce is rejected (replay of a pre-nonce capture)', async () => {
  // A validly-signed proof that simply omits the nonce field — what a captured
  // pre-nonce response (or a long-obsolete signer) would look like.
  const m = manager({ fetchImpl: okFetch(proof()) });
  await m.validateOnce();
  assert.notEqual(m.getStatus().status, 'valid');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.getStatus().reason, 'nonce_mismatch');
});

test('a fresh proof carrying a recent proof_issued_at is accepted', async () => {
  const m = manager({ fetchImpl: licensFetch({ proof_issued_at: new Date(NOW).toISOString() }) });
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'valid');
});

test('a proof with a stale proof_issued_at is rejected (time-bounded replay)', async () => {
  // Echoes the request nonce (so the nonce check passes) but was signed two days
  // ago — the freshness bound still rejects it, even if a verifier skipped nonces.
  const m = manager({ fetchImpl: licensFetch({ proof_issued_at: new Date(NOW - 2 * DAY).toISOString() }) });
  await m.validateOnce();
  assert.notEqual(m.getStatus().status, 'valid');
  assert.equal(m.getStatus().reason, 'proof_too_old');
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
  const m = manager({ fetchImpl: licensFetch({ limits: { max_agents: 2 } }) });

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
  const m = manager({ fetchImpl: licensFetch({ valid: false, reason: 'status_revoked' }), cache });

  await m.validateOnce();

  assert.equal(m.getStatus().status, 'invalid');
  assert.equal(m.isLicensed(), false);
  assert.equal(cache.read(), null);
});

test('a signed valid:false/expired proof -> expired (distinct from invalid)', async () => {
  const cache = createMemoryCache();
  const m = manager({ fetchImpl: licensFetch({ valid: false, reason: 'expired' }), cache });

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
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => proof({ nonce: sentBody.nonce }) };
  };
  const m = manager({ fetchImpl, getAgentCount: () => 7 });

  await m.validateOnce();

  assert.equal(sentBody.licenseKey, 'lk');
  assert.equal(sentBody.serverId, 'srv-1');
  assert.equal(sentBody.agentCount, 7);
});

test('a trusted negative is durable: cache cleared, no grace resurrection, survives restart', async () => {
  const cache = createMemoryCache();
  let impl = licensFetch();
  const m = manager({ fetchImpl: (...args) => impl(...args), cache });

  // 1) A fresh valid proof — licensed and cached.
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'valid');
  assert.ok(cache.read());

  // 2) The licens server revokes: a signature-verified valid:false proof.
  impl = licensFetch({ valid: false, reason: 'status_revoked' });
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'invalid');
  assert.equal(cache.read(), null); // the denial cleared the on-disk cache

  // 3) The licens server then becomes unreachable: the old valid proof must NOT
  //    resurrect the licence into grace.
  impl = offlineFetch();
  await m.validateOnce();
  assert.equal(m.getStatus().status, 'unlicensed');
  assert.equal(m.isLicensed(), false);
  assert.equal(m.canAcceptNewConnection(0), false);

  // 4) A restart (fresh manager over the same cache) stays unlicensed too.
  const m2 = manager({ fetchImpl: offlineFetch(), cache });
  m2.loadCache();
  await m2.validateOnce();
  assert.equal(m2.isLicensed(), false);
});

test('grace never outlives the licence\'s own expiry', async () => {
  // Last verified NOW, licence expires a day later, server offline ever since:
  // at NOW+2d we are well inside the 14-day grace window but past expiry.
  const { payload, signature } = proof({ expiry: new Date(NOW + DAY).toISOString() });
  const cache = createMemoryCache({ payload, signature, verifiedAt: NOW });
  const m = manager({ fetchImpl: offlineFetch(), cache, now: () => NOW + 2 * DAY });

  m.loadCache();
  await m.validateOnce();

  assert.equal(m.isLicensed(), false);
  assert.equal(m.getStatus().status, 'expired');
  assert.equal(m.canAcceptNewConnection(0), false);
});
