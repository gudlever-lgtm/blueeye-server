'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { makeApp, makeNis2ReportsRepo, authHeader } = require('../test-support/fakes');
const { canonicalize } = require('../src/lib/canonicalize');
const { verifyProof } = require('../src/license/verify');

// A releaseKeyService backed by a REAL Ed25519 key, so the route's signature
// genuinely verifies against the returned public key.
function realSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicPem,
    service: {
      canSign: () => true,
      getPublicKey: () => publicPem,
      status: () => ({ fingerprint: 'a'.repeat(64), canSign: true }),
      sign: (manifest) => crypto.sign(null, Buffer.from(canonicalize(manifest), 'utf8'), privateKey).toString('base64'),
    },
  };
}

async function seedReport(nis2ReportsRepo) {
  return nis2ReportsRepo.create({
    reportType: 'executive', title: 'NIS2 Executive Report',
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
    status: 'approved', summary: 'All good', snapshot: { readinessScore: 88, risks: 3 },
    generatedByEmail: 'admin@blueeye.local',
  });
}

test('signed evidence manifest verifies and binds the report content hash', async () => {
  const nis2ReportsRepo = makeNis2ReportsRepo();
  const report = await seedReport(nis2ReportsRepo);
  const { publicPem, service } = realSigner();
  const app = makeApp({ nis2ReportsRepo, releaseKeyService: service });

  const res = await request(app)
    .get(`/api/nis2/reports/${report.id}/evidence`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  const { manifest, signature, publicKey } = res.body;
  assert.equal(publicKey, publicPem);
  assert.equal(manifest.reportId, report.id);
  assert.equal(manifest.algorithm, 'ed25519');
  assert.ok(manifest.signedAt, 'manifest carries a server timestamp');

  // The content hash binds the exact report bytes.
  const expectedSha = crypto.createHash('sha256').update(canonicalize(report), 'utf8').digest('hex');
  assert.equal(manifest.sha256, expectedSha);

  // The signature verifies over the canonical manifest with the returned key.
  assert.equal(verifyProof(manifest, signature, publicKey), true);
  // Tampering with the manifest breaks verification.
  assert.equal(verifyProof({ ...manifest, sha256: 'deadbeef' }, signature, publicKey), false);
});

test('evidence returns 404 for a missing report', async () => {
  const { service } = realSigner();
  const res = await request(makeApp({ releaseKeyService: service }))
    .get('/api/nis2/reports/999/evidence')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('evidence returns 503 when the server has no signing key', async () => {
  const nis2ReportsRepo = makeNis2ReportsRepo();
  const report = await seedReport(nis2ReportsRepo);
  const noKey = { canSign: () => false, getPublicKey: () => '', status: () => ({ fingerprint: null }), sign: () => { throw new Error('no key'); } };
  const res = await request(makeApp({ nis2ReportsRepo, releaseKeyService: noKey }))
    .get(`/api/nis2/reports/${report.id}/evidence`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'NO_SIGNING_KEY');
});

test('evidence requires auth (401)', async () => {
  const res = await request(makeApp()).get('/api/nis2/reports/1/evidence');
  assert.equal(res.status, 401);
});
