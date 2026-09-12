'use strict';

// The AI layer over HTTP.
//
// The theme of these specs: having no AI provider is the NORMAL state of this
// product, not a failure. Every route here answers 200 either way, because a
// 4xx would make every screen treat the default deployment as broken.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/analysis';

function provider({ answer = 'The search endpoint is returning 500 while its neighbours answer.',
  enabled = true, configured = true, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    status: () => ({ enabled, configured, provider: 'test-provider', model: 'test-model' }),
    analyse: async (task, context) => {
      calls.push({ task, context });
      if (fail) throw fail;
      return { answer, model: 'test-model' };
    },
  };
}

function fixture(ai) {
  const st = makeServiceTests({ ai: ai || null });
  return { st, app: makeApp({ serviceTests: st }) };
}

const openIncident = (st, over = {}) => st.repositories.incidents.open({
  application_id: 1, test_id: 1, subject_type: 'test', subject_key: 'test:1',
  subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
  summary: 'HTTP 500 from the customer search', likely_cause: 'the application',
  correlated_layer: 'api', confidence: 68, explanation: 'x',
  evidence: ['GET https://portal.kunde.dk/api/search returned 500'],
  ...over,
});

const get = (app, path, role = 'admin') => request(app).get(`${BASE}${path}`).set('Authorization', authHeader(role));
const post = (app, path, role = 'admin') => request(app).post(`${BASE}${path}`).set('Authorization', authHeader(role)).send({});

// ---------------------------------------------------- no provider is normal
test('a deployment with no provider answers 200 and says the rules are available', async () => {
  const { app } = fixture(null);
  const res = await get(app, '/ai/status');
  assert.equal(res.status, 200, 'having no AI is not an error');
  assert.equal(res.body.rules, 'available');
  assert.equal(res.body.ai, 'unavailable');
  assert.ok(res.body.reason);
});

test('asking with no provider is 200 with a reason, not a 4xx', async () => {
  const { st, app } = fixture(null);
  const incident = await openIncident(st);
  const res = await post(app, `/incidents/${incident.id}/ai`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.analysis, null);
  assert.ok(res.body.reason);
});

test('a provider that is off, or has no key, is reported as such and never contacted', async () => {
  for (const options of [{ enabled: false }, { configured: false }]) {
    const p = provider(options);
    const { st, app } = fixture(p);
    // eslint-disable-next-line no-await-in-loop
    const incident = await openIncident(st);
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, `/incidents/${incident.id}/ai`);
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.deepEqual(p.calls, [], 'an unavailable provider was contacted anyway');
  }
});

// ------------------------------------------------------------ asking for one
test('an answer comes back labelled as a suggestion, with its evidence', async () => {
  const { st, app } = fixture(provider());
  const incident = await openIncident(st);
  const res = await post(app, `/incidents/${incident.id}/ai`);

  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.match(res.body.analysis.answer, /500/);
  assert.equal(res.body.analysis.is_suggestion, true);
  assert.equal(res.body.analysis.source, 'ai', 'so it can never be read as the rule-based conclusion');
  assert.ok(res.body.analysis.context, 'an answer whose evidence is not kept cannot be checked');
});

test('the provider is given the RULE-BASED analysis, not a second view of the data', async () => {
  // The model explains what the operator was shown. Given different inputs it
  // would form its own opinion, and two conclusions on one screen with no way to
  // tell which is which is worse than one.
  const p = provider();
  const { st, app } = fixture(p);
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/ai`);

  const context = p.calls[0].context;
  assert.equal(p.calls[0].task, 'explain_incident');
  assert.ok('correlation' in context, 'the correlation was not passed');
  assert.ok('root_cause' in context, 'the ranking was not passed');
  assert.ok('recurrence' in context);
  assert.ok(Array.isArray(context.timeline));
});

test('what leaves the process is the allowlisted context and nothing else', async () => {
  // The security control, checked where it actually matters: at the boundary.
  const p = provider();
  const { st, app } = fixture(p);
  const incident = await openIncident(st, {
    subject_key: 'certificate:portal.kunde.dk:443',
    evidence: ['Authorization: Bearer sk-live-9f3b2a1c8e', 'GET https://portal.kunde.dk/api/search?token=abc123 returned 500'],
  });
  await post(app, `/incidents/${incident.id}/ai`);

  const sent = JSON.stringify(p.calls[0].context);
  assert.ok(!sent.includes('sk-live-9f3b2a1c8e'), 'a bearer token reached the provider');
  assert.ok(!sent.includes('abc123'), 'a query-string token reached the provider');
  assert.ok(!sent.includes('portal.kunde.dk'), 'the customer’s host reached the provider');
  assert.ok(!sent.includes('certificate:portal.kunde.dk:443'));
});

test('a provider that fails is reported with its own reason, and nothing is stored', async () => {
  const { st, app } = fixture(provider({ fail: new Error('401 invalid api key') }));
  const incident = await openIncident(st);
  const res = await post(app, `/incidents/${incident.id}/ai`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.match(res.body.reason, /401 invalid api key/);
  assert.deepEqual(await st.repositories.aiAnalyses.forIncident(incident.id), []);
});

// ---------------------------------------------------------------- reading
test('an answer is kept and read back, so the same question is not bought twice', async () => {
  const p = provider();
  const { st, app } = fixture(p);
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/ai`);

  const res = await get(app, `/incidents/${incident.id}/ai`);
  assert.equal(res.status, 200);
  assert.equal(res.body.analyses.length, 1);
  assert.equal(res.body.analyses[0].is_suggestion, true);
  assert.ok(res.body.analyses[0].context, 'the evidence was not kept with it');
  assert.equal(p.calls.length, 1, 'reading an answer asked for another one');
});

test('an incident with no analysis reads as an empty list, not an error', async () => {
  const { st, app } = fixture(provider());
  const incident = await openIncident(st);
  const res = await get(app, `/incidents/${incident.id}/ai`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.analyses, []);
  assert.equal(res.body.status.ai, 'available', 'and it says one could be asked for');
});

test('an unknown or malformed incident is 404 / 400 on both routes', async () => {
  const { app } = fixture(provider());
  for (const path of ['/incidents/999999/ai', '/incidents/nope/ai']) {
    const expected = path.includes('nope') ? 400 : 404;
    assert.equal((await get(app, path)).status, expected, `GET ${path}`);
    assert.equal((await post(app, path)).status, expected, `POST ${path}`);
  }
});

// ------------------------------------------------------------------- RBAC
test('anyone may READ an answer; asking for one is an operator’s decision', async () => {
  // The answer is just text. Asking costs money and sends a customer's data to a
  // third party, which is not a viewer's call to make.
  const { st, app } = fixture(provider());
  const incident = await openIncident(st);

  assert.equal((await get(app, '/ai/status', 'viewer')).status, 200);
  assert.equal((await get(app, `/incidents/${incident.id}/ai`, 'viewer')).status, 200);
  assert.equal((await post(app, `/incidents/${incident.id}/ai`, 'viewer')).status, 403);
  assert.equal((await post(app, `/incidents/${incident.id}/ai`, 'operator')).status, 200);
});

test('an anonymous caller gets 401, not a provider call', async () => {
  const p = provider();
  const { st, app } = fixture(p);
  const incident = await openIncident(st);
  assert.equal((await request(app).post(`${BASE}/incidents/${incident.id}/ai`).send({})).status, 401);
  assert.deepEqual(p.calls, []);
});

test('asking is audited — who sent a customer’s data outward is answerable later', async () => {
  const st = makeServiceTests({ ai: provider() });
  const app = makeApp({ serviceTests: st });
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/ai`);
  const entries = st.auditEntries.filter((e) => e.action === 'service_ai_analysis');
  assert.equal(entries.length, 1, 'an outward data transfer was not audited');
});
