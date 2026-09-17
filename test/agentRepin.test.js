'use strict';

// "I click Update, the agent says it refuses, and nothing I can do from here
// changes that."
//
// An agent verifies self-updates against the release key it pinned when it was
// installed, and refuses anything else — including an unsigned push. That is the
// right default and it is also a trap: once the server's signing key is gone or
// replaced, every one-click update on a pinned agent fails, and re-running the
// installer is not an answer (it needs an enrollment code and would onboard a
// SECOND agent for the same host).
//
// So the server says WHY the push went out unsigned, and hands out the one-liner
// that re-anchors an installed agent to the key it serves now.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, authHeader, makeAgentsRepo, makeAuditRepo, makeAuditEventsRepo,
  makeSourceStore, makeReleaseStore, makeReleaseKeyService,
} = require('../test-support/fakes');

const AGENT = {
  id: 7, hostname: 'probe-07', display_name: 'probe-07', status: 'online',
  platform: 'linux', arch: 'x64',
  capabilities: { agentVersion: '0.24.0', managed: 'systemd' }, meta: {}, monitor_config: {},
};

function appWith({ keyService, auditEventsRepo } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [AGENT],
      findById: async (id) => (Number(id) === AGENT.id ? AGENT : null),
    }),
    auditRepo: makeAuditRepo(),
    auditEventsRepo,
    agentCommander: {
      sendCommand: () => 1,
      sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }),
    },
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
    releaseStore: makeReleaseStore(),
    releaseKeyService: keyService,
  });
}

test('an unsigned push names the reason it could not be signed', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = appWith({ keyService: makeReleaseKeyService({ verifyOnly: true }), auditEventsRepo });
  const res = await request(app).post(`/agents/${AGENT.id}/update`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 202);
  assert.equal(res.body.signed, false);
  // 'no-key' and 'verify-only' look identical from the dashboard and need
  // different fixes — generating a key vs. replacing one that cannot sign.
  assert.equal(res.body.signedReason, 'verify-only');
});

test('an unsigned push is recorded in the system log, not only in a toast', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = appWith({ keyService: makeReleaseKeyService({ configured: false }), auditEventsRepo });
  await request(app).post(`/agents/${AGENT.id}/update`).set('Authorization', authHeader('admin'));
  const row = (auditEventsRepo.rows || []).find((r) => r.action === 'agent.update-unsigned');
  assert.ok(row, 'the unsigned push left no trace in the system log');
  assert.equal(row.actorType, 'system');
  assert.equal(row.detail.reason, 'no-key');
  assert.equal(String(row.targetId), String(AGENT.id));
});

test('a signed push carries no reason (there is nothing to explain)', async () => {
  const app = appWith({ keyService: makeReleaseKeyService(), auditEventsRepo: makeAuditEventsRepo() });
  const res = await request(app).post(`/agents/${AGENT.id}/update`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 202);
  assert.equal(res.body.signed, true);
  assert.equal(res.body.signedReason, null);
});

test('GET /enroll/repin.sh serves a script that re-pins the installed agent', async () => {
  const app = appWith({ keyService: makeReleaseKeyService() });
  const res = await request(app).get('/enroll/repin.sh');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /shellscript/);
  assert.match(res.text, /10-release-key\.conf/);
  assert.match(res.text, /systemctl restart/);
  // It must never enroll: an enrollment code here would mean a second agent for
  // the same host, which is exactly what the operator is trying to avoid.
  assert.doesNotMatch(res.text, /ENROLL_CODE|install\.sh/);
});

test('GET /enroll/repin.sh is 404 while the server has no key to pin', async () => {
  const app = appWith({ keyService: makeReleaseKeyService({ configured: false }) });
  const res = await request(app).get('/enroll/repin.sh');
  assert.equal(res.status, 404);
  assert.match(res.text, /Settings -> Agent key/);
});

test('GET /api/enroll/repin-command returns the one-liner and the key it pins', async () => {
  const app = appWith({ keyService: makeReleaseKeyService() });
  const res = await request(app).get('/api/enroll/repin-command').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.match(res.body.oneLiner, /curl -fsSL .*\/enroll\/repin\.sh \| sudo sh/);
  assert.equal(res.body.fingerprint, 'f'.repeat(64));
  assert.equal(res.body.canSign, true);
});

test('GET /api/enroll/repin-command is 409 when there is no key, 401 anonymous, 403 for a viewer', async () => {
  const app = appWith({ keyService: makeReleaseKeyService({ configured: false }) });
  const none = await request(app).get('/api/enroll/repin-command').set('Authorization', authHeader('admin'));
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NO_RELEASE_KEY');

  const withKey = appWith({ keyService: makeReleaseKeyService() });
  assert.equal((await request(withKey).get('/api/enroll/repin-command')).status, 401);
  assert.equal((await request(withKey).get('/api/enroll/repin-command').set('Authorization', authHeader('viewer'))).status, 403);
});

test('POST /agents/:id/rekey sends the server\'s current key over the agent channel', async () => {
  const sent = [];
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [AGENT],
      findById: async (id) => (Number(id) === AGENT.id ? AGENT : null),
    }),
    auditRepo: makeAuditRepo(),
    agentCommander: {
      sendCommand: () => 1,
      sendCommandAndWait: async (id, command) => { sent.push({ id, command }); return { delivered: 1, acked: true, reply: { accepted: true } }; },
    },
    releaseKeyService: makeReleaseKeyService(),
  });
  const res = await request(app).post(`/agents/${AGENT.id}/rekey`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  assert.match(res.body.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command.name, 'rekey');
  assert.match(sent[0].command.publicKey, /BEGIN PUBLIC KEY/);
  // Signed with the key being replaced when this server still can: a strict
  // agent accepts nothing else.
  assert.ok(sent[0].command.commandSignature, 'a signable server must sign a rekey');
  assert.equal(sent[0].command.agentId, AGENT.id);
});

test('rekey is 503 with no key to pin, 409 when the agent is offline, 403 for an operator', async () => {
  const noKey = appWith({ keyService: makeReleaseKeyService({ configured: false }), auditEventsRepo: makeAuditEventsRepo() });
  const blocked = await request(noKey).post(`/agents/${AGENT.id}/rekey`).set('Authorization', authHeader('admin'));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, 'NO_RELEASE_KEY');

  const offline = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [AGENT], findById: async () => AGENT }),
    auditRepo: makeAuditRepo(),
    agentCommander: { sendCommand: () => 0, sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) },
    releaseKeyService: makeReleaseKeyService(),
  });
  const gone = await request(offline).post(`/agents/${AGENT.id}/rekey`).set('Authorization', authHeader('admin'));
  assert.equal(gone.status, 409);
  assert.equal(gone.body.connected, false);

  const app = appWith({ keyService: makeReleaseKeyService() });
  assert.equal((await request(app).post(`/agents/${AGENT.id}/rekey`)).status, 401);
  assert.equal((await request(app).post(`/agents/${AGENT.id}/rekey`).set('Authorization', authHeader('operator'))).status, 403);
  assert.equal((await request(app).post('/agents/9999/rekey').set('Authorization', authHeader('admin'))).status, 404);
  assert.equal((await request(app).post('/agents/abc/rekey').set('Authorization', authHeader('admin'))).status, 400);
});

test('a verify-only server still says re-pinning alone will not fix it', async () => {
  const app = appWith({ keyService: makeReleaseKeyService({ verifyOnly: true }) });
  const res = await request(app).get('/api/enroll/repin-command').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.canSign, false);
});
