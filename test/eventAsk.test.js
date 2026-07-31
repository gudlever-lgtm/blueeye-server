'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createAssistant, EVENT_INSUFFICIENT_ANSWER } = require('../src/analysis/assistant');
const { createAskCache } = require('../src/eventCases/askCache');
const {
  makeApp, makeEventCasesRepo, makeFindingStore, makeConfigSnapshotsRepo, makeAssistant, makeFeatureGate, authHeader,
} = require('../test-support/fakes');

// ---- assistant.askEvent (offline via injected fetch) --------------------

function fakeFetch(answer) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) });
}

test('askEvent sends a never-invent system prompt and returns the answer', async () => {
  let sent = null;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ACL change 15m before' } }] }) }; };
  const assistant = createAssistant({ config: { assistantEnabled: true, assistantApiKey: 'k' }, findingStore: makeFindingStore(), fetchImpl });
  const { answer } = await assistant.askEvent('what happened?', { event: { id: 1 }, dataAvailability: { hasAnyData: true } });
  assert.equal(answer, 'ACL change 15m before');
  assert.match(sent.messages[0].content, /NEVER invent/i);
  assert.match(sent.messages[0].content, new RegExp(EVENT_INSUFFICIENT_ANSWER.slice(0, 20)));
});

test('askEvent throws FeatureDisabled when the assistant is off', async () => {
  const assistant = createAssistant({ config: { assistantEnabled: false }, findingStore: makeFindingStore(), fetchImpl: fakeFetch('x') });
  await assert.rejects(() => assistant.askEvent('q', {}), /disabled/i);
});

// ---- askCache --------------------------------------------------------------

test('askCache returns a hit within ttl and misses after it / for other questions', () => {
  let t = 1000;
  const cache = createAskCache({ ttlMs: 100, now: () => t });
  cache.set(5, 'why?', { answer: 'a' });
  assert.deepEqual(cache.get(5, 'why?'), { answer: 'a' });
  assert.equal(cache.get(5, 'other?'), null);
  assert.equal(cache.get(6, 'why?'), null);
  t = 1201; // past ttl
  assert.equal(cache.get(5, 'why?'), null);
});

// ---- POST /api/events/:id/ask -------------------------------------------

async function seedEventWithData() {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 't', status: 'investigating', severity: 'CRIT', primary_finding_id: 'a1', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:10:00Z') });
  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'a1', hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'cpu spike', evidence: [{}], createdAt: new Date('2026-06-01T08:01:00Z') });
  await findingStore.setEventCase('a1', id);
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\n', capturedAt: new Date('2026-06-01T07:00:00Z') });
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\nsnmp-server community s3cr3t RO\n', capturedAt: new Date('2026-06-01T07:50:00Z') });
  return { eventCasesRepo, findingStore, configSnapshotsRepo, id };
}

function askAssistant() {
  const calls = [];
  const assistant = makeAssistant({ askEvent: async (q, ctx) => { calls.push({ q, ctx }); return { answer: 'Likely the config change.', model: 'mistral-small-latest' }; } });
  return { assistant, calls };
}

test('ask returns an AI answer for an operator and records an audit entry → 200', async () => {
  const { eventCasesRepo, findingStore, configSnapshotsRepo, id } = await seedEventWithData();
  const { assistant, calls } = askAssistant();
  const audits = [];
  const auditLogger = { enabled: true, record: async (_req, e) => audits.push(e) };
  const app = makeApp({ eventCasesRepo, findingStore, configSnapshotsRepo, assistant, auditLogger });
  const res = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'why did cpu spike?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.answer, 'Likely the config change.');
  assert.equal(res.body.aiGenerated, true);
  assert.equal(res.body.cached, false);
  assert.equal(calls.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'event_ask');
});

test('MASKING: the context sent to Mistral contains no raw secrets/config', async () => {
  const { eventCasesRepo, findingStore, configSnapshotsRepo, id } = await seedEventWithData();
  const { assistant, calls } = askAssistant();
  const app = makeApp({ eventCasesRepo, findingStore, configSnapshotsRepo, assistant });
  await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'q' });
  const blob = JSON.stringify(calls[0].ctx);
  assert.doesNotMatch(blob, /s3cr3t/);
  assert.doesNotMatch(blob, /config_text/);
});

test('no-data event returns the exact fallback WITHOUT calling Mistral → 200', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const { assistant, calls } = askAssistant();
  const app = makeApp({ eventCasesRepo, assistant });
  const res = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'what happened?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.answer, EVENT_INSUFFICIENT_ANSWER);
  assert.equal(res.body.dataAvailable, false);
  assert.equal(calls.length, 0); // Mistral never called
});

test('repeated identical questions are served from cache (Mistral hit once)', async () => {
  const { eventCasesRepo, findingStore, configSnapshotsRepo, id } = await seedEventWithData();
  const { assistant, calls } = askAssistant();
  const app = makeApp({ eventCasesRepo, findingStore, configSnapshotsRepo, assistant });
  const q = { question: 'same question' };
  const first = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send(q);
  const second = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send(q);
  assert.equal(first.body.cached, false);
  assert.equal(second.body.cached, true);
  assert.equal(calls.length, 1);
});

test('ask is 400 for an empty question', async () => {
  const { eventCasesRepo, id } = await seedEventWithData();
  const app = makeApp({ eventCasesRepo, assistant: askAssistant().assistant });
  const res = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: '  ' });
  assert.equal(res.status, 400);
});

test('ask is 403 for a viewer (operator/admin only)', async () => {
  const { eventCasesRepo, id } = await seedEventWithData();
  const app = makeApp({ eventCasesRepo, assistant: askAssistant().assistant });
  const res = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('viewer')).send({ question: 'q' });
  assert.equal(res.status, 403);
});

test('ask is 403 when the assistant is disabled at runtime', async () => {
  const { eventCasesRepo, id } = await seedEventWithData();
  const assistant = makeAssistant({ isEnabled: () => false });
  const res = await request(makeApp({ eventCasesRepo, assistant })).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'q' });
  assert.equal(res.status, 403);
});

test('ask is 403 when the license does not include the assistant', async () => {
  const { eventCasesRepo, id } = await seedEventWithData();
  const featureGate = makeFeatureGate({ isFeatureEnabled: () => false });
  const res = await request(makeApp({ eventCasesRepo, assistant: askAssistant().assistant, featureGate })).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'q' });
  assert.equal(res.status, 403);
});

test('ask is 404 for an unknown event', async () => {
  const res = await request(makeApp({ assistant: askAssistant().assistant })).post('/api/events/9999/ask').set('Authorization', authHeader('operator')).send({ question: 'q' });
  assert.equal(res.status, 404);
});

test('ask surfaces a provider/upstream error as 500', async () => {
  const { eventCasesRepo, findingStore, configSnapshotsRepo, id } = await seedEventWithData();
  const assistant = makeAssistant({ askEvent: async () => { const e = new Error('provider down'); e.name = 'AssistantUpstreamError'; throw e; } });
  const app = makeApp({ eventCasesRepo, findingStore, configSnapshotsRepo, assistant });
  const res = await request(app).post(`/api/events/${id}/ask`).set('Authorization', authHeader('operator')).send({ question: 'q' });
  assert.equal(res.status, 500);
});
