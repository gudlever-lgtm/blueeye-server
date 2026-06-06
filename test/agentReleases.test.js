'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { makeApp, makeReleaseStore, authHeader } = require('../test-support/fakes');
const { canonicalize } = require('../src/lib/canonicalize');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');

// A real Ed25519 release key pair (the same primitive the licens side uses).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const releasePublicKey = publicKey.export({ type: 'spki', format: 'pem' });

// Builds a tarball + a signed manifest for it, exactly as scripts/sign-release.js
// will (manifest signed over its canonical bytes, base64 signature).
function signedRelease({ version = '0.3.0', bytes = 'fake-gzip-agent-bytes' } = {}) {
  const tarball = Buffer.from(bytes);
  const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');
  const manifest = { version, sha256, size: tarball.length, created_at: '2026-06-06T00:00:00.000Z' };
  const signature = crypto.sign(null, Buffer.from(canonicalize(manifest)), privateKey).toString('base64');
  return { tarball, manifest, signature, version };
}

// POSTs a release: tarball as the raw octet-stream body, metadata in headers.
function upload(app, { version, manifest, signature, tarball }, auth = admin()) {
  const req = request(app).post('/agents/releases').set('Authorization', auth)
    .set('Content-Type', 'application/octet-stream');
  if (version !== undefined) req.set('X-Release-Version', version);
  if (signature !== undefined) req.set('X-Release-Signature', signature);
  if (manifest !== undefined) req.set('X-Release-Manifest', Buffer.from(JSON.stringify(manifest)).toString('base64'));
  return req.send(tarball === undefined ? Buffer.from('x') : tarball);
}

test('POST /agents/releases stores a release whose signature + sha256 verify (admin)', async () => {
  const releaseStore = makeReleaseStore();
  const rel = signedRelease({ version: '0.3.0' });
  const res = await upload(makeApp({ releaseStore, releasePublicKey }), rel);

  assert.equal(res.status, 201);
  assert.equal(res.body.version, '0.3.0');
  assert.equal(res.body.sha256, rel.manifest.sha256);
  assert.equal(res.body.size, rel.tarball.length);
  assert.equal(releaseStore.added.length, 1);
  assert.equal(releaseStore.added[0].version, '0.3.0');
  // The verified tarball bytes are what got stored.
  assert.ok(Buffer.isBuffer(releaseStore.added[0].buffer));
  assert.equal(releaseStore.added[0].buffer.toString(), 'fake-gzip-agent-bytes');
});

test('POST /agents/releases rejects a bad signature with 422 (and stores nothing)', async () => {
  const releaseStore = makeReleaseStore();
  const rel = signedRelease();
  rel.signature = Buffer.from('not-a-real-signature').toString('base64');
  const res = await upload(makeApp({ releaseStore, releasePublicKey }), rel);
  assert.equal(res.status, 422);
  assert.equal(releaseStore.added.length, 0);
});

test('POST /agents/releases rejects a tarball that does not match the signed sha256 (422)', async () => {
  const releaseStore = makeReleaseStore();
  const rel = signedRelease();
  rel.tarball = Buffer.from('tampered-bytes'); // signature/manifest still bind the original sha
  const res = await upload(makeApp({ releaseStore, releasePublicKey }), rel);
  assert.equal(res.status, 422);
  assert.equal(releaseStore.added.length, 0);
});

test('POST /agents/releases returns 400 when the manifest header is missing', async () => {
  const rel = signedRelease();
  const res = await upload(makeApp({ releasePublicKey }), { version: rel.version, signature: rel.signature, tarball: rel.tarball });
  assert.equal(res.status, 400);
});

test('POST /agents/releases returns 400 on an empty body', async () => {
  const rel = signedRelease();
  const res = await upload(makeApp({ releasePublicKey }), { ...rel, tarball: Buffer.alloc(0) });
  assert.equal(res.status, 400);
});

test('POST /agents/releases returns 503 when no release public key is configured', async () => {
  const res = await upload(makeApp(), signedRelease()); // default releasePublicKey is ''
  assert.equal(res.status, 503);
});

test('POST /agents/releases is forbidden for an operator (403)', async () => {
  const res = await upload(makeApp({ releasePublicKey }), signedRelease(), operator());
  assert.equal(res.status, 403);
});

test('POST /agents/releases without a token returns 401', async () => {
  const rel = signedRelease();
  const res = await request(makeApp({ releasePublicKey })).post('/agents/releases')
    .set('Content-Type', 'application/octet-stream')
    .set('X-Release-Version', rel.version)
    .set('X-Release-Signature', rel.signature)
    .set('X-Release-Manifest', Buffer.from(JSON.stringify(rel.manifest)).toString('base64'))
    .send(rel.tarball);
  assert.equal(res.status, 401);
});
