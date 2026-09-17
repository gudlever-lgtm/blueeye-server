'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// A signed release that was never re-signed after the agent source moved ahead.
//
// The server preferred the signed release outright, on the assumption that "a
// signed release can never be newer than the source it was signed from". On a
// host that pulled the agent to v0.27.0 while the release store still held a
// signed v0.24.0, that assumption inverted: every one-click Update went on
// pushing v0.24.0, and the dashboard reported the whole fleet up to date —
// which is exactly how a fleet sits two versions behind with no warning.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeSourceStore, makeReleaseStore, makeAgentCommander, makeAgentsRepo, makeReleaseKeyService, authHeader } = require('../test-support/fakes');

const agentsRepo = () => makeAgentsRepo({ findById: async () => ({ id: 1, hostname: 'node-1' }) });

// A release store holding ONE signed release, at the version given.
function storeHolding(version) {
  const meta = { version, sha256: 'a'.repeat(64), size: 10, signature: 'sig', manifest: {} };
  return makeReleaseStore({ latest: () => meta, list: () => [meta], get: (v) => (v === version ? meta : null) });
}

test('GET /system/version offers the SOURCE when the signed release is older', async () => {
  const app = makeApp({
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
    releaseStore: storeHolding('0.24.0'),
  });
  const res = await request(app).get('/system/version').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agent, '0.27.0', 'a stale signature must not pin the offered version backwards');
  assert.equal(res.body.agentSource, '0.27.0');
});

test('GET /system/version still prefers a signed release that is genuinely newer', async () => {
  const app = makeApp({
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.24.0' }),
    releaseStore: storeHolding('0.27.0'),
  });
  const res = await request(app).get('/system/version').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agent, '0.27.0');
  assert.equal(res.body.agentSource, '0.24.0');
});

test('POST /agents/:id/update re-signs the newer source instead of pushing the stale release', async () => {
  const sent = [];
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, cmd) => { sent.push(cmd); return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  // A store that already holds the stale signed 0.24.0 and honours add(), so the
  // on-demand re-sign is observable rather than stubbed.
  const held = [{ version: '0.24.0', sha256: 'a'.repeat(64), size: 10, signature: 'sig', manifest: {} }];
  const releaseStore = makeReleaseStore({
    add: (r) => { const meta = { ...r }; held.push(meta); return meta; },
    list: () => held.slice(),
    latest: () => held[held.length - 1],
    get: (v) => held.find((r) => r.version === v) || null,
  });
  const app = makeApp({
    agentsRepo: agentsRepo(),
    agentCommander,
    releaseStore,
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
  });
  const res = await request(app).post('/agents/1/update').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 202);
  assert.ok(held.some((r) => r.version === '0.27.0'),
    'the server must re-sign when the source has moved past the newest release');
  assert.equal(res.body.targetVersion, '0.27.0');
  assert.equal(res.body.signed, true, 'the re-signed bundle should go out SIGNED');
  const cmd = sent.find((c) => c.name === 'update');
  assert.ok(cmd, 'no update command was sent');
  assert.equal(cmd.version, '0.27.0', 'the fleet was pushed the stale version');
});

test('with no signing key, the update falls back to the newer UNSIGNED source rather than the stale release', async () => {
  const sent = [];
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, cmd) => { sent.push(cmd); return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  const app = makeApp({
    agentsRepo: agentsRepo(),
    agentCommander,
    releaseStore: storeHolding('0.24.0'),
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
    releaseKeyService: makeReleaseKeyService({ configured: false }),
  });
  const res = await request(app).post('/agents/1/update').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 202);
  assert.equal(res.body.signed, false, 'an unsigned push must be reported as unsigned');
  assert.equal(res.body.targetVersion, '0.27.0');
  assert.equal(sent.find((c) => c.name === 'update').version, '0.27.0');
});

test('POST /system/agent-source/reload says WHY it could not re-sign', async () => {
  const app = makeApp({
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
    releaseStore: makeReleaseStore({ hasStorage: () => false }),
  });
  const res = await request(app).post('/system/agent-source/reload').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '0.27.0');
  assert.match(res.body.releaseNote || '', /AGENT_RELEASE_DIR|writable/i,
    'a reload that could not re-sign must not answer a plain OK');
  assert.equal(res.body.releaseVersion, null);
});
