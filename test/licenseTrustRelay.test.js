'use strict';

// This server presents its agent-release key for VENDOR authorisation, and
// keeps the signed answer so it can relay it to its agents.
//
// The private half never goes anywhere: what is presented is the public key,
// and what comes back is a document this server cannot forge and does not even
// verify on the agents' behalf — it carries the bytes, the agents decide.

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createLicenseManager } = require('../src/license/licenseManager');
const { createMemoryCache } = require('../src/license/licenseCache');
const { canonicalize } = require('../src/lib/canonicalize');
const { publicKeyFingerprint } = require('../src/lib/fingerprint');

const VENDOR = crypto.generateKeyPairSync('ed25519');
const SERVER_KEY = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const VENDOR_PUB = VENDOR.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedProof({ nonce, fingerprint = publicKeyFingerprint(SERVER_KEY), commandFingerprint = null, sequence = 2 }) {
  const payload = {
    valid: true,
    expiry: null,
    limits: { max_agents: 10 },
    plan: null,
    features: null,
    serverId: 'srv-1',
    issued_at: '2026-01-01T00:00:00.000Z',
    nonce,
    releases: null,
    proof_issued_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
    trust: {
      license: { id: '7', customer_id: '42' },
      server: {
        id: 'srv-1',
        release_key: { algorithm: 'Ed25519', fingerprint },
        ...(commandFingerprint ? { command_key: { algorithm: 'Ed25519', fingerprint: commandFingerprint } } : {}),
      },
      sequence,
    },
  };
  return { payload, signature: crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), VENDOR.privateKey).toString('base64') };
}

function managerWith({
  releaseKey = SERVER_KEY, commandKey = '', onBody = () => {},
  keyStatus = 'authorized', keyStatuses = undefined, proof = null,
} = {}) {
  return createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache: createMemoryCache(),
    getReleasePublicKey: () => releaseKey,
    getCommandPublicKey: () => commandKey,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      onBody(body);
      const signed = proof ? proof({ nonce: body.nonce }) : signedProof({ nonce: body.nonce });
      return {
        status: 200,
        json: async () => ({ ...signed, keyStatus, ...(keyStatuses ? { keyStatuses } : {}) }),
      };
    },
  });
}

test('the server presents its release PUBLIC key, and never anything private', async () => {
  let sent = null;
  const mgr = managerWith({ onBody: (b) => { sent = b; } });
  await mgr.validateOnce();

  assert.equal(sent.releaseKey, SERVER_KEY);
  const asText = JSON.stringify(sent);
  assert.doesNotMatch(asText, /PRIVATE KEY/, 'a private key must never reach the licence server');
});

test('a server with no key yet sends the same request an older server sends', async () => {
  let sent = null;
  const mgr = managerWith({ releaseKey: '', onBody: (b) => { sent = b; } });
  await mgr.validateOnce();
  assert.equal('releaseKey' in sent, false);
});

test('the signed authorisation is kept, exactly as received, for the agents', async () => {
  const mgr = managerWith();
  await mgr.validateOnce();

  const proof = mgr.getTrustProof();
  assert.ok(proof, 'nothing to relay means no agent can be re-keyed');
  assert.equal(proof.payload.trust.server.release_key.fingerprint, publicKeyFingerprint(SERVER_KEY));
  // Verifiable against the vendor key — which is the only thing that makes it
  // worth relaying.
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalize(proof.payload), 'utf8'), VENDOR_PUB, Buffer.from(proof.signature, 'base64')),
    true
  );
  assert.equal(mgr.getReleaseKeyStatus(), 'authorized');
});

test('a proof with no authorisation in it is not offered as one', async () => {
  const mgr = createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache: createMemoryCache(),
    getReleasePublicKey: () => SERVER_KEY,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const proof = signedProof({ nonce: body.nonce });
      delete proof.payload.trust;
      // Re-sign without the trust block: a licence that has authorised no key.
      const signature = crypto.sign(null, Buffer.from(canonicalize(proof.payload), 'utf8'), VENDOR.privateKey).toString('base64');
      return { status: 200, json: async () => ({ payload: proof.payload, signature }) };
    },
  });
  await mgr.validateOnce();
  assert.equal(mgr.getTrustProof(), null, 'an empty authorisation must not be relayed as one');
});

test('a restart keeps the authorisation: it is read back from the cache', async () => {
  const cache = createMemoryCache();
  const first = createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache,
    getReleasePublicKey: () => SERVER_KEY,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      return { status: 200, json: async () => signedProof({ nonce: body.nonce }) };
    },
  });
  await first.validateOnce();

  // A fresh process, same cache file, licence server unreachable.
  const second = createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache,
    getReleasePublicKey: () => SERVER_KEY,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  second.loadCache();
  const proof = second.getTrustProof();
  assert.ok(proof, 'a server that has not re-validated since a restart must still be able to re-key');
  assert.equal(proof.payload.trust.sequence, 2);
});

test('a broken key resolver never breaks licence validation', async () => {
  const mgr = createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache: createMemoryCache(),
    getReleasePublicKey: () => { throw new Error('key service exploded'); },
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal('releaseKey' in body, false);
      return { status: 200, json: async () => signedProof({ nonce: body.nonce }) };
    },
  });
  const status = await mgr.validateOnce();
  assert.equal(status.status, 'valid');
});

// ---- the SECOND key: commands ----------------------------------------------

const COMMAND_KEY = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

test('a server with a command key presents both, each in its own field', async () => {
  let body = null;
  const mgr = managerWith({ commandKey: COMMAND_KEY, onBody: (b) => { body = b; } });
  await mgr.validateOnce();
  assert.equal(body.releaseKey, SERVER_KEY);
  assert.equal(body.commandKey, COMMAND_KEY);
  // Public halves only, in both fields.
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE KEY/);
});

test('a server without one omits the field, so the request is the one it always sent', async () => {
  let body = null;
  const mgr = managerWith({ onBody: (b) => { body = b; } });
  await mgr.validateOnce();
  assert.equal('commandKey' in body, false,
    'an empty key field is a field somebody eventually treats as meaningful');
});

test('the per-purpose key status is reported, and falls back for an older signer', async () => {
  const withBoth = managerWith({
    commandKey: COMMAND_KEY,
    keyStatus: 'authorized',
    keyStatuses: { release: 'authorized', command: 'pending' },
  });
  await withBoth.validateOnce();
  assert.deepEqual(withBoth.getKeyStatuses(), { release: 'authorized', command: 'pending' });
  // The single field stays what it was: it is what this server has always read.
  assert.equal(withBoth.getReleaseKeyStatus(), 'authorized');

  // An older signer sends keyStatus only. The release purpose takes it, and the
  // command purpose reads null — which is "nothing to say", not "rejected".
  const older = managerWith({ commandKey: COMMAND_KEY, keyStatus: 'pending' });
  await older.validateOnce();
  assert.deepEqual(older.getKeyStatuses(), { release: 'pending', command: null });
});

test('the relayed proof carries whichever keys the vendor authorised', async () => {
  const mgr = managerWith({
    commandKey: COMMAND_KEY,
    proof: ({ nonce }) => signedProof({ nonce, commandFingerprint: publicKeyFingerprint(COMMAND_KEY) }),
  });
  await mgr.validateOnce();
  const relayed = mgr.getTrustProof();
  assert.ok(relayed, 'the authorisation was not kept');
  assert.equal(relayed.payload.trust.server.release_key.fingerprint, publicKeyFingerprint(SERVER_KEY));
  assert.equal(relayed.payload.trust.server.command_key.fingerprint, publicKeyFingerprint(COMMAND_KEY));
  // Byte-for-byte as received: this server is a courier, and an edit here would
  // break the vendor signature the agents check.
  assert.equal(
    crypto.verify(null, Buffer.from(canonicalize(relayed.payload), 'utf8'), VENDOR_PUB, Buffer.from(relayed.signature, 'base64')),
    true
  );
});

test('a broken command-key resolver never breaks licence validation', async () => {
  const mgr = createLicenseManager({
    config: { key: 'LIC', serverId: 'srv-1', serverUrl: 'https://licens.test', graceDays: 14 },
    publicKey: VENDOR_PUB,
    cache: createMemoryCache(),
    getReleasePublicKey: () => SERVER_KEY,
    getCommandPublicKey: () => { throw new Error('key store is on fire'); },
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      return { status: 200, json: async () => ({ ...signedProof({ nonce: body.nonce }), keyStatus: 'authorized' }) };
    },
  });
  const status = await mgr.validateOnce();
  // A server that cannot read its own second key is still a licensed server.
  assert.equal(status.status, 'valid');
});
