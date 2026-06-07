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
