'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');

const { makeApp, makeArtifactStore, makeEnrollmentCodesRepo } = require('../test-support/fakes');
const { createArtifactStore } = require('../src/enroll/artifactStore');

// A real artifact store over a temp dir with one published binary.
function realStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-pub-'));
  const bytes = Buffer.from('linux-agent-bytes');
  fs.writeFileSync(path.join(dir, 'blueeye-agent-linux-amd64'), bytes);
  return { store: createArtifactStore({ dir, logger: { info() {}, warn() {} } }), sha: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

const activeCode = () => makeEnrollmentCodesRepo({ findByCode: async (code) => ({ id: 1, status: code === 'GOOD' ? 'active' : 'expired', expires_at: '2099-01-01T00:00:00Z', uses_remaining: 1, max_uses: 1 }) });

// ---- GET /enroll/config ----------------------------------------------------
test('GET /enroll/config returns the derived server URL (no fingerprint by default)', async () => {
  const res = await request(makeApp()).get('/enroll/config');
  assert.equal(res.status, 200);
  assert.match(res.body.serverUrl, /^http:\/\//);
  assert.equal(res.body.certFingerprint, null);
});

test('GET /enroll/config prefers a configured public URL + fingerprint', async () => {
  const app = makeApp({ enrollConfig: { publicUrl: 'https://blueeye.acme.dk/', certFingerprint: 'AB:CD' } });
  const res = await request(app).get('/enroll/config');
  assert.equal(res.body.serverUrl, 'https://blueeye.acme.dk'); // trailing slash stripped
  assert.equal(res.body.certFingerprint, 'AB:CD');
});

// ---- GET /enroll/agent/:platform -------------------------------------------
test('GET /enroll/agent/:platform serves the binary with a SHA-256 header (200)', async () => {
  const { store, sha, bytes } = realStore();
  const res = await request(makeApp({ artifactStore: store })).get('/enroll/agent/linux-amd64').buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-content-sha256'], sha);
  assert.match(res.headers['content-disposition'], /blueeye-agent-linux-amd64/);
  assert.equal(Buffer.compare(res.body, bytes), 0);
});

test('GET /enroll/agent/:platform 404s for an unknown platform', async () => {
  const { store } = realStore();
  const res = await request(makeApp({ artifactStore: store })).get('/enroll/agent/solaris-sparc');
  assert.equal(res.status, 404);
  assert.equal(res.body.platform, 'solaris-sparc');
});

test('GET /enroll/agent/:platform 500s when the store throws', async () => {
  const store = makeArtifactStore({ get: () => { throw new Error('disk gone'); } });
  const res = await request(makeApp({ artifactStore: store })).get('/enroll/agent/linux-amd64');
  assert.equal(res.status, 500);
});

// ---- GET /enroll/:code/install.sh ------------------------------------------
test('GET /enroll/:code/install.sh returns a script for an active code (200)', async () => {
  const { store, sha } = realStore();
  const app = makeApp({ artifactStore: store, enrollmentCodesRepo: activeCode(), enrollConfig: { publicUrl: 'https://blueeye.acme.dk', certFingerprint: '' } });
  const res = await request(app).get('/enroll/GOOD/install.sh');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/x-shellscript/);
  assert.match(res.text, /ENROLL_CODE="GOOD"/);
  assert.match(res.text, /SERVER_URL="https:\/\/blueeye\.acme\.dk"/);
  assert.ok(res.text.includes(sha), 'embeds the real binary checksum');
});

test('GET /enroll/:code/install.sh 404s for an unknown/expired code', async () => {
  const { store } = realStore();
  const app = makeApp({ artifactStore: store, enrollmentCodesRepo: activeCode() });
  const res = await request(app).get('/enroll/EXPIRED/install.sh');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /text\/plain/);

  const unknown = makeApp({ artifactStore: store, enrollmentCodesRepo: makeEnrollmentCodesRepo({ findByCode: async () => null }) });
  assert.equal((await request(unknown).get('/enroll/NOPE/install.sh')).status, 404);
});

test('GET /enroll/:code/install.sh 500s when the lookup throws', async () => {
  const { store } = realStore();
  const repo = makeEnrollmentCodesRepo({ findByCode: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ artifactStore: store, enrollmentCodesRepo: repo })).get('/enroll/GOOD/install.sh');
  assert.equal(res.status, 500);
});
