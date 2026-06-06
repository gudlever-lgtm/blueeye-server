'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeReleaseStore, makeAgentsRepo, makeAgentCommander, makeSourceStore, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const admin = () => authHeader('admin');

// A release store pre-loaded with one signed release.
function storeWith(version = '0.4.0') {
  const store = makeReleaseStore();
  store.add({
    version,
    buffer: Buffer.from(`tarball-${version}`),
    sha256: `sha256-${version}`,
    size: `tarball-${version}`.length,
    signature: `sig-${version}`,
    manifest: { version, sha256: `sha256-${version}`, size: `tarball-${version}`.length },
    uploadedBy: 1,
  });
  return store;
}

// ---- GET /enroll/agent-release(.tgz) ---------------------------------------

test('GET /enroll/agent-release.tgz serves the latest signed release with verification headers', async () => {
  const res = await request(makeApp({ releaseStore: storeWith('0.4.0') })).get('/enroll/agent-release.tgz');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-release-version'], '0.4.0');
  assert.equal(res.headers['x-content-sha256'], 'sha256-0.4.0');
  assert.equal(res.headers['x-release-signature'], 'sig-0.4.0');
  assert.ok(res.headers['x-release-manifest']); // base64 manifest present
  assert.equal(Buffer.from(res.body).toString(), 'tarball-0.4.0');
});

test('GET /enroll/agent-release returns the metadata JSON', async () => {
  const res = await request(makeApp({ releaseStore: storeWith('0.4.0') })).get('/enroll/agent-release');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '0.4.0');
  assert.equal(res.body.signature, 'sig-0.4.0');
  assert.equal(res.body.manifest.version, '0.4.0');
});

test('GET /enroll/agent-release(.tgz) returns 404 when no release is published', async () => {
  const app = makeApp({ releaseStore: makeReleaseStore() });
  assert.equal((await request(app).get('/enroll/agent-release.tgz')).status, 404);
  assert.equal((await request(app).get('/enroll/agent-release')).status, 404);
});

// ---- GET /system/version prefers the signed release ------------------------

test('GET /system/version reports the signed release version when one is published', async () => {
  const res = await request(makeApp({ releaseStore: storeWith('0.4.0'), agentSourceStore: makeSourceStore({ sourceVersion: () => '0.1.0' }) }))
    .get('/system/version').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.agent, '0.4.0'); // release wins over the source bundle's 0.1.0
});

test('GET /system/version falls back to the source bundle when no release is published', async () => {
  const res = await request(makeApp({ releaseStore: makeReleaseStore(), agentSourceStore: makeSourceStore({ sourceVersion: () => '0.1.0' }) }))
    .get('/system/version').set('Authorization', viewer());
  assert.equal(res.body.agent, '0.1.0');
});

// ---- POST /agents/:id/update pushes the signed release ---------------------

test('POST /agents/:id/update pushes the signed release (version + sha256 + signature)', async () => {
  let asked;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5' }) });
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => { asked = command; return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  const res = await request(makeApp({ agentsRepo, agentCommander, releaseStore: storeWith('0.4.0') }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.targetVersion, '0.4.0');
  assert.equal(res.body.signed, true);
  assert.equal(asked.name, 'update');
  assert.equal(asked.version, '0.4.0');
  assert.equal(asked.sha256, 'sha256-0.4.0');
  assert.equal(asked.signature, 'sig-0.4.0');
});

test('POST /agents/:id/update still falls back to the unsigned source bundle when no release exists', async () => {
  let asked;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5 }) });
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => { asked = command; return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  const res = await request(makeApp({ agentsRepo, agentCommander, releaseStore: makeReleaseStore(), agentSourceStore: makeSourceStore({ sha256: 'd'.repeat(64), sourceVersion: () => '0.1.0' }) }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.signed, false);
  assert.equal(res.body.targetVersion, '0.1.0');
  assert.equal(asked.sha256, 'd'.repeat(64));
  assert.equal(asked.signature, undefined);
});
