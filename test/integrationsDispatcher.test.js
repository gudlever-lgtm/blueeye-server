'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIntegrationsDispatcher, isRetryable } = require('../src/integrations/dispatcher');
const { makeIntegrationAuditRepo, makeSecretBox } = require('../test-support/fakes');

// A registry with controllable connectors keyed by integration type.
function registryOf(byType) {
  return {
    get: (t) => byType[t] || null,
    types: () => Object.keys(byType),
    eventsFor: (integration, connector) => {
      const cfg = integration.config_json;
      const override = cfg && Array.isArray(cfg.events) ? cfg.events : null;
      return override && override.length ? override : (connector.defaultEvents || []);
    },
  };
}

const ALL_EVENTS = ['incident', 'anomaly', 'agent.enroll', 'agent.delete'];

function repoEnabled(list) {
  return {
    findEnabledWithSecret: async () => list,
    findByIdWithSecret: async (id) => list.find((i) => i.id === id) || null,
  };
}

function integration(secretBox, over = {}) {
  return {
    id: over.id || 1,
    name: over.name || 'sn',
    type: over.type || 'svc',
    base_url: 'https://x',
    auth_type: over.auth_type || 'basic',
    credentials_encrypted: secretBox.encryptJson(over.credentials || { username: 'u', password: 'p' }),
    config_json: over.config_json || {},
  };
}

const critFinding = { hostId: 'a1', metric: 'cpu', kind: 'spike', severity: 'CRIT', explanation: 'x' };
const warnFinding = { hostId: 'a1', metric: 'mem', kind: 'spike', severity: 'WARN', explanation: 'x' };

test('emit fans out to subscribed integrations, decrypts creds, and audits one row per fire', async () => {
  const box = makeSecretBox();
  const auditRepo = makeIntegrationAuditRepo();
  let seenCreds = null;
  const conn = { type: 'svc', defaultEvents: ALL_EVENTS, send: async (shaped) => { seenCreds = shaped.credentials; return { ok: true, status: 201, detail: 'created' }; } };
  const d = createIntegrationsDispatcher({
    integrationsRepo: repoEnabled([integration(box, { credentials: { username: 'svc', password: 's3cret' } })]),
    auditRepo, secretBox: box, registry: registryOf({ svc: conn }),
  });

  const out = await d.emitFinding(critFinding);
  assert.equal(out.dispatched, 1);
  assert.deepEqual(seenCreds, { username: 'svc', password: 's3cret' }); // decrypted at fire time
  assert.equal(auditRepo.rows.length, 1);
  assert.equal(auditRepo.rows[0].ok, true);
  assert.equal(auditRepo.rows[0].statusCode, 201);
  assert.equal(auditRepo.rows[0].event, 'incident'); // CRIT -> incident
  assert.equal(auditRepo.rows[0].correlationId, 'be-finding-a1-cpu-spike');
});

test('event subscription: a connector only receives events it subscribes to', async () => {
  const box = makeSecretBox();
  let calls = 0;
  const conn = { type: 'svc', defaultEvents: ['incident'], send: async () => { calls += 1; return { ok: true, status: 200 }; } };
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box)]), auditRepo: makeIntegrationAuditRepo(), secretBox: box, registry: registryOf({ svc: conn }) });

  await d.emitFinding(critFinding); // -> incident (subscribed)
  await d.emitFinding(warnFinding); // -> anomaly (NOT subscribed)
  assert.equal(calls, 1);
});

test('config.events overrides the connector default subscription', async () => {
  const box = makeSecretBox();
  let calls = 0;
  const conn = { type: 'svc', defaultEvents: ['incident'], send: async () => { calls += 1; return { ok: true, status: 200 }; } };
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box, { config_json: { events: ['anomaly'] } })]), auditRepo: makeIntegrationAuditRepo(), secretBox: box, registry: registryOf({ svc: conn }) });
  await d.emitFinding(critFinding); // incident — not in override
  await d.emitFinding(warnFinding); // anomaly — in override
  assert.equal(calls, 1);
});

test('debounce: a repeat fire within the cooldown is skipped, then allowed after it', async () => {
  const box = makeSecretBox();
  let calls = 0;
  let clock = 1000;
  const conn = { type: 'svc', defaultEvents: ALL_EVENTS, send: async () => { calls += 1; return { ok: true, status: 200 }; } };
  const d = createIntegrationsDispatcher({
    integrationsRepo: repoEnabled([integration(box)]), auditRepo: makeIntegrationAuditRepo(), secretBox: box,
    registry: registryOf({ svc: conn }), cooldownMs: 1000, now: () => clock,
  });
  await d.emitFinding(critFinding); // fires
  await d.emitFinding(critFinding); // debounced (same correlationId, within cooldown)
  assert.equal(calls, 1);
  clock += 2000;
  await d.emitFinding(critFinding); // cooldown elapsed -> fires again
  assert.equal(calls, 2);
});

test('retry: transient 5xx is retried with exponential backoff, then succeeds', async () => {
  const box = makeSecretBox();
  const sleeps = [];
  let n = 0;
  const conn = {
    type: 'svc', defaultEvents: ALL_EVENTS,
    send: async () => { n += 1; return n < 3 ? { ok: false, status: 503, detail: 'down' } : { ok: true, status: 200, detail: 'ok' }; },
  };
  const auditRepo = makeIntegrationAuditRepo();
  const d = createIntegrationsDispatcher({
    integrationsRepo: repoEnabled([integration(box)]), auditRepo, secretBox: box, registry: registryOf({ svc: conn }),
    sleep: async (ms) => { sleeps.push(ms); }, maxAttempts: 3, backoffBaseMs: 500,
  });
  const out = await d.emitFinding(critFinding);
  assert.equal(out.results[0].ok, true);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [500, 1000]); // base, 2*base
  assert.equal(auditRepo.rows[0].attempts, 3);
  assert.equal(auditRepo.rows[0].ok, true);
});

test('retry: a 4xx is NOT retried (client error)', async () => {
  const box = makeSecretBox();
  let n = 0;
  const conn = { type: 'svc', defaultEvents: ALL_EVENTS, send: async () => { n += 1; return { ok: false, status: 400, detail: 'bad' }; } };
  const auditRepo = makeIntegrationAuditRepo();
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box)]), auditRepo, secretBox: box, registry: registryOf({ svc: conn }), maxAttempts: 3 });
  await d.emitFinding(critFinding);
  assert.equal(n, 1);
  assert.equal(auditRepo.rows[0].attempts, 1);
  assert.equal(auditRepo.rows[0].ok, false);
  assert.equal(auditRepo.rows[0].statusCode, 400);
});

test('retry: a connector that throws is treated as a network failure and retried', async () => {
  const box = makeSecretBox();
  let n = 0;
  const conn = { type: 'svc', defaultEvents: ALL_EVENTS, send: async () => { n += 1; throw new Error('boom'); } };
  const auditRepo = makeIntegrationAuditRepo();
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box)]), auditRepo, secretBox: box, registry: registryOf({ svc: conn }), sleep: async () => {}, maxAttempts: 2 });
  await d.emitFinding(critFinding);
  assert.equal(n, 2);
  assert.equal(auditRepo.rows[0].ok, false);
  assert.match(auditRepo.rows[0].detail, /threw/);
});

test('emitAgentEvent fires enroll/delete and audits with the actor null', async () => {
  const box = makeSecretBox();
  const seen = [];
  const conn = { type: 'ipam', defaultEvents: ['agent.enroll', 'agent.delete'], send: async (shaped, event) => { seen.push(event.type); return { ok: true, status: 200 }; } };
  const auditRepo = makeIntegrationAuditRepo();
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box, { type: 'ipam', auth_type: 'token', credentials: { token: 't' } })]), auditRepo, secretBox: box, registry: registryOf({ ipam: conn }) });
  await d.emitAgentEvent('enroll', { id: 5, hostname: 'h5' });
  await d.emitAgentEvent('delete', { id: 5, hostname: 'h5' });
  assert.deepEqual(seen, ['agent.enroll', 'agent.delete']);
  assert.equal(auditRepo.rows.length, 2);
  assert.equal(auditRepo.rows[0].actorUserId, null);
});

test('testFire runs the connector test, records the actor, and returns the status', async () => {
  const box = makeSecretBox();
  const conn = { type: 'svc', defaultEvents: ALL_EVENTS, send: async () => ({ ok: true }), test: async () => ({ ok: true, status: 200, detail: 'reached' }) };
  const auditRepo = makeIntegrationAuditRepo();
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([integration(box)]), auditRepo, secretBox: box, registry: registryOf({ svc: conn }) });
  const res = await d.testFire(1, { id: 9, email: 'admin@x', role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(auditRepo.rows[0].event, 'test');
  assert.equal(auditRepo.rows[0].actorUserId, 9);
});

test('testFire returns null for an unknown integration', async () => {
  const box = makeSecretBox();
  const d = createIntegrationsDispatcher({ integrationsRepo: repoEnabled([]), auditRepo: makeIntegrationAuditRepo(), secretBox: box, registry: registryOf({}) });
  assert.equal(await d.testFire(999), null);
});

test('isRetryable: network (0) and 5xx yes; 4xx no', () => {
  assert.equal(isRetryable(0), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(200), false);
});
