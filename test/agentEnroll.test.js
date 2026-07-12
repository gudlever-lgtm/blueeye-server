'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeEnrollmentStore, makeAuditEventsRepo, makeSettingsService, throwingAsync } = require('../test-support/fakes');
const { hashToken } = require('../src/auth/tokens');

const validBody = { code: 'a-code', hostname: 'node-01', platform: 'linux', arch: 'x64' };

// POST /agents/enroll is intentionally unauthenticated — no token is set here.
test('POST /agents/enroll returns 201 with { agentId, token } on a valid code', async () => {
  let received;
  const enrollmentStore = makeEnrollmentStore({
    claimAndEnroll: async (input) => {
      received = input;
      return { status: 'ok', agentId: 42 };
    },
  });

  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  assert.equal(res.body.agentId, 42);
  assert.ok(typeof res.body.token === 'string' && res.body.token.length > 0);
  // Only the hash of the returned token is handed to the store.
  assert.equal(received.tokenHash, hashToken(res.body.token));
  assert.equal(received.code, 'a-code');
  assert.equal(received.hostname, 'node-01');
});

test('POST /agents/enroll stamps the fleet-wide default traffic source onto the new agent', async () => {
  let received;
  const enrollmentStore = makeEnrollmentStore({
    claimAndEnroll: async (input) => { received = input; return { status: 'ok', agentId: 5 }; },
  });
  // Settings → Agents default: sFlow with the local hsflowd exporter.
  const settingsService = makeSettingsService({ initial: { agents: { defaultTrafficSource: 'sflow', defaultSflowHsflowd: true } } });

  const res = await request(makeApp({ enrollmentStore, settingsService })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  assert.deepEqual(received.monitorConfig, { source: 'sflow', sflow: { hsflowd: true } });
});

test('POST /agents/enroll passes a null monitor config when the default is proc', async () => {
  let received;
  const enrollmentStore = makeEnrollmentStore({
    claimAndEnroll: async (input) => { received = input; return { status: 'ok', agentId: 6 }; },
  });
  // Default (empty store) is proc → the agent is left unstamped.
  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  assert.equal(received.monitorConfig, null);
});

test('a failing settings read does not break enrollment (falls back to unstamped)', async () => {
  let received;
  const enrollmentStore = makeEnrollmentStore({
    claimAndEnroll: async (input) => { received = input; return { status: 'ok', agentId: 8 }; },
  });
  const settingsService = { getDefaultMonitorConfig: async () => { throw new Error('settings down'); } };

  const res = await request(makeApp({ enrollmentStore, settingsService })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  assert.equal(received.monitorConfig, null);
});

test('POST /agents/enroll records an agent.enrolled audit event', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'ok', agentId: 42 }) });
  const auditEventsRepo = makeAuditEventsRepo();

  const res = await request(makeApp({ enrollmentStore, auditEventsRepo })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  const row = auditEventsRepo.rows.find((r) => r.action === 'agent.enrolled');
  assert.ok(row, 'expected an agent.enrolled audit row');
  assert.equal(row.actorType, 'agent');
  assert.equal(row.actorId, 42);
  assert.equal(row.actorLabel, 'node-01');
  assert.equal(row.targetId, '42'); // stringified by the repo
  assert.deepEqual(row.detail, { platform: 'linux', arch: 'x64' });
});

test('a failing audit write does not break enrollment', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'ok', agentId: 7 }) });
  const auditEventsRepo = { record: async () => { throw new Error('audit down'); } };

  const res = await request(makeApp({ enrollmentStore, auditEventsRepo })).post('/agents/enroll').send(validBody);

  assert.equal(res.status, 201);
  assert.equal(res.body.agentId, 7);
});

test('POST /agents/enroll returns 401 for an invalid code', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'invalid' }) });
  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid enrollment code');
});

test('POST /agents/enroll returns 410 for an already-used code', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'used' }) });
  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'Enrollment code already used');
});

test('POST /agents/enroll returns 410 for an expired code', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'expired' }) });
  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'Enrollment code has expired');
});

test('POST /agents/enroll returns 400 when required fields are missing', async () => {
  const res = await request(makeApp())
    .post('/agents/enroll')
    .send({ code: 'a-code', platform: 'linux' }); // no hostname / arch
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /agents/enroll returns 400 when the code is missing', async () => {
  const res = await request(makeApp())
    .post('/agents/enroll')
    .send({ hostname: 'node-01', platform: 'linux', arch: 'x64' });
  assert.equal(res.status, 400);
});

test('POST /agents/enroll returns 500 when the store throws', async () => {
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: throwingAsync() });
  const res = await request(makeApp({ enrollmentStore })).post('/agents/enroll').send(validBody);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});
