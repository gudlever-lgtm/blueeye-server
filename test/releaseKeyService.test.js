'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createReleaseKeyService } = require('../src/enroll/releaseKeyService');
const { verifyProof } = require('../src/license/verify');
const { makeSecretBox } = require('../test-support/fakes');

// In-memory single-row repo mirroring agentReleaseKeyRepository's contract.
function fakeRepo() {
  let row = null;
  return {
    async get() {
      return row ? { id: 1, public_pem: row.public_pem, fingerprint: row.fingerprint, created_by: row.created_by, created_at: row.created_at } : null;
    },
    async getWithSecret() { return row ? { id: 1, ...row } : null; },
    async create({ publicPem, privatePemEncrypted, fingerprint, createdBy = null }) {
      if (row) { const e = new Error('exists'); e.code = 'EXISTS'; throw e; }
      row = { public_pem: publicPem, private_pem_encrypted: privatePemEncrypted, fingerprint, created_by: createdBy, created_at: '2026-06-07T00:00:00.000Z' };
      return row;
    },
    async remove() { const had = row ? 1 : 0; row = null; return had; },
    _row: () => row,
  };
}

const svcWith = (repo, env = {}) =>
  createReleaseKeyService({ repo, secretBox: makeSecretBox(), env, logger: { warn() {}, info() {} } });

test('generate() creates a managed, signable key; status exposes no private material', async () => {
  const repo = fakeRepo();
  const svc = svcWith(repo);
  const status = await svc.generate({ userId: 7 });
  assert.equal(status.configured, true);
  assert.equal(status.source, 'managed');
  assert.equal(status.canSign, true);
  assert.match(status.fingerprint, /^[0-9a-f]{64}$/);
  // No private key material is ever exposed in the status object.
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false);
  assert.ok(!('privateKey' in status) && !('private_pem_encrypted' in status));
  // The stored private key is encrypted at rest (not a plaintext PEM).
  assert.ok(!String(repo._row().private_pem_encrypted).includes('PRIVATE KEY'));
  // The public key is available for agents to pin.
  assert.match(svc.getPublicKey(), /BEGIN PUBLIC KEY/);
});

test('sign() produces a signature the agent/upload verifier accepts (verifyProof)', async () => {
  const svc = svcWith(fakeRepo());
  await svc.generate();
  const manifest = { version: '0.3.0', sha256: 'a'.repeat(64), size: 1234, created_at: '2026-06-07T00:00:00.000Z' };
  const sig = svc.sign(manifest);
  assert.equal(verifyProof(manifest, sig, svc.getPublicKey()), true);
  // A tampered manifest must NOT verify.
  assert.equal(verifyProof({ ...manifest, size: 9999 }, sig, svc.getPublicKey()), false);
});

test('the key is write-once: a second generate() is refused', async () => {
  const svc = svcWith(fakeRepo());
  await svc.generate();
  await assert.rejects(() => svc.generate(), (e) => e.code === 'EXISTS');
});

test('remove() clears the key: not configured, cannot sign', async () => {
  const repo = fakeRepo();
  const svc = svcWith(repo);
  await svc.generate();
  const status = await svc.remove();
  assert.equal(status.configured, false);
  assert.equal(svc.getPublicKey(), '');
  assert.equal(repo._row(), null);
  assert.throws(() => svc.sign({ version: '1', sha256: 'x', size: 1, created_at: 'y' }), (e) => e.code === 'NO_KEY');
});

test('falls back to the env public key (verify-only) when no managed key is stored', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const svc = svcWith(fakeRepo(), { AGENT_RELEASE_PUBLIC_KEY: pem });
  await svc.load();
  const status = svc.status();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env');
  assert.equal(status.canSign, false); // public-only: can verify, cannot sign
  assert.match(svc.getPublicKey(), /BEGIN PUBLIC KEY/);
});

test('a stored key that cannot be decrypted reports WHY instead of looking configured', async () => {
  // The state behind "update sent UNSIGNED" on a server that shows "Created ✓":
  // the key row survives, but SECRET_ENCRYPTION_KEY / JWT_SECRET changed, so the
  // private half no longer decrypts. It used to be one warn line at startup.
  const repo = fakeRepo();
  await svcWith(repo).generate({ userId: 1 });

  const seen = [];
  const svc = createReleaseKeyService({
    repo,
    secretBox: { encrypt: (v) => v, decrypt: () => { throw new Error('unrecognized token format'); } },
    env: {},
    logger: { warn() {}, info() {} },
    onKeyError: (e) => seen.push(e),
  });
  await svc.load();

  const status = svc.status();
  assert.equal(status.configured, true, 'the public key is still usable for verification');
  assert.equal(status.canSign, false);
  assert.equal(status.signBlocked, 'undecryptable');
  assert.match(status.keyError, /cannot be decrypted/);
  assert.equal(seen.length, 1, 'the fault must reach the system log, not just a startup warn');
  assert.equal(seen[0].reason, 'undecryptable');
  assert.throws(() => svc.sign({ version: '1.0.0' }), /No release signing key/);
});

test('signBlockedReason separates "no key" from "public key only"', async () => {
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const none = svcWith(fakeRepo());
  await none.load();
  assert.equal(none.signBlockedReason(), 'no-key');
  assert.equal(none.status().signBlocked, 'no-key');

  const envOnly = svcWith(fakeRepo(), { AGENT_RELEASE_PUBLIC_KEY: pub });
  await envOnly.load();
  assert.equal(envOnly.isConfigured(), true, 'agents can still pin it, so enrollment is not blocked');
  assert.equal(envOnly.signBlockedReason(), 'verify-only');
  assert.equal(envOnly.status().signBlocked, 'verify-only');

  const signing = svcWith(fakeRepo());
  await signing.generate({});
  assert.equal(signing.signBlockedReason(), '');
});
