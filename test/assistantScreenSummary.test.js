'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "What is going on?" across whatever the Analysis screen is showing.
//
// The point of this one is WHAT GOES INTO THE PROMPT. A fleet can be sitting on
// six figures of findings, so the context is the AGGREGATE the server already
// computes — counts per host and per metric — never the rows. These pin that,
// because a context that quietly grew to include raw findings would be both a
// cost and a privacy problem, and neither shows up as a failing assertion
// anywhere else.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createAssistant } = require('../src/analysis/assistant');
const { makeApp, makeAssistant, authHeader } = require('../test-support/fakes');

const cfg = { assistantEnabled: true, assistantApiKey: 'k', assistantModel: 'm' };

// Captures what was actually sent to the provider.
function spyFetch(answer) {
  const sent = [];
  const impl = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  };
  impl.sent = sent;
  // The context is JSON nested inside a JSON string, so assert on the OBJECT.
  // Matching the serialised form means matching its escaping, which is a test
  // that breaks on formatting rather than on meaning.
  impl.context = (i = 0) => JSON.parse(sent[i].messages.find((m) => m.role === 'user').content);
  return impl;
}

const SUMMARY = {
  total: 184668,
  acked: 36,
  unacked: 184632,
  bySeverity: { CRIT: 30003, WARN: 154665, INFO: 0 },
  byMetric: [{ metric: 'probe.latency', count: 180000 }, { metric: 'if.12.in.errPps', count: 4668 }],
  byHost: [
    {
      hostId: 7, count: 180000, crit: 30000, warn: 150000, info: 0, acked: 0,
      lastAt: '2026-09-20T12:00:00.000Z',
      topMetrics: [{ metric: 'probe.latency', count: 180000, crit: 30000 }],
    },
    {
      hostId: 8, count: 4668, crit: 3, warn: 4665, info: 0, acked: 36,
      lastAt: '2026-09-20T11:00:00.000Z',
      topMetrics: [{ metric: 'if.12.in.errPps', count: 4668, crit: 3 }],
    },
  ],
};

const deps = (fetchImpl, over = {}) => ({
  config: cfg,
  findingStore: { summary: async () => SUMMARY, list: async () => [] },
  agentsRepo: { findAll: async () => [{ id: 7, display_name: 'oslo-edge-01' }, { id: 8, hostname: 'cph-core-02' }] },
  fetchImpl,
  ...over,
});

test('the prompt carries the AGGREGATE, never the findings themselves', async () => {
  const fetchImpl = spyFetch('Oslo is the problem.');
  const a = createAssistant(deps(fetchImpl));
  const res = await a.summarizeFindings({});

  assert.match(res.answer, /Oslo/);
  assert.equal(res.total, 184668);

  const prompt = JSON.stringify(fetchImpl.sent[0]);
  assert.match(prompt, /oslo-edge-01/, 'the host NAME, not its id');
  assert.match(prompt, /probe\.latency/);
  assert.match(prompt, /184668/);
  // The giveaway that rows leaked in would be per-finding fields.
  assert.ok(!/explanation|evidence|deviation|observed/.test(prompt),
    'raw finding fields reached the prompt');
});

test('the filters travel, so the answer describes the page being looked at', async () => {
  // "3 criticals" means something different when the screen is filtered to one
  // host. A summary that ignored the filter would describe a different page.
  const fetchImpl = spyFetch('ok');
  const a = createAssistant(deps(fetchImpl));
  await a.summarizeFindings({ hostId: '7', severity: 'CRIT' });

  const ctx = fetchImpl.context();
  assert.equal(ctx.scope.severity, 'CRIT');
  assert.equal(ctx.scope.host, 'oslo-edge-01', 'the filtered host is named in the scope');
});

test('nothing to describe means no provider call at all', async () => {
  // The honest answer costs nothing and takes no time.
  const fetchImpl = spyFetch('should not be called');
  const a = createAssistant(deps(fetchImpl, {
    findingStore: { summary: async () => ({ total: 0, unacked: 0, bySeverity: {}, byMetric: [], byHost: [] }), list: async () => [] },
  }));
  const res = await a.summarizeFindings({});

  assert.equal(fetchImpl.sent.length, 0, 'it paid for a call to say "nothing"');
  assert.match(res.answer, /no findings/i);
  assert.equal(res.total, 0);
});

test('a host with no agent row still gets named, by its id', async () => {
  const fetchImpl = spyFetch('ok');
  const a = createAssistant(deps(fetchImpl, { agentsRepo: { findAll: async () => [] } }));
  await a.summarizeFindings({});
  assert.equal(fetchImpl.context().places[0].host, '7', 'the id is the fallback name');
});

test('it is off unless it is on', async () => {
  const a = createAssistant(deps(spyFetch('x'), { config: { assistantEnabled: false } }));
  await assert.rejects(() => a.summarizeFindings({}), (e) => e.name === 'FeatureDisabled');
});

// ---------------------------------------------------------------- the route
const post = (app, qs = '', role = 'viewer') => request(app)
  .post(`/api/assistant/findings-summary${qs}`).set('Authorization', authHeader(role)).send({});

test('POST /api/assistant/findings-summary answers, and a viewer may ask', async () => {
  const assistant = makeAssistant({ summarizeFindings: async (f) => ({ answer: 'fine', model: 'm', total: 2, filters: f }) });
  const app = makeApp({ assistant });
  const res = await post(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.answer, 'fine');
});

test('the route forwards the screen filters and refuses a bad severity', async () => {
  let got = null;
  const assistant = makeAssistant({ summarizeFindings: async (f) => { got = f; return { answer: 'x', total: 1 }; } });
  const app = makeApp({ assistant });

  await post(app, '?hostId=7&severity=crit&metric=probe.latency');
  assert.deepEqual(got, { hostId: '7', metric: 'probe.latency', severity: 'CRIT' }, 'severity is normalised');

  assert.equal((await post(app, '?severity=NOPE')).status, 400);
});

test('a disabled assistant is a 403, not a 500', async () => {
  // The ordinary state on a deployment that never turned it on — it has to read
  // as a setting, not a fault.
  const app = makeApp({ assistant: makeAssistant() });
  assert.equal((await post(app)).status, 403);
});

test('asking requires a session', async () => {
  const app = makeApp({ assistant: makeAssistant({ summarizeFindings: async () => ({ answer: 'x' }) }) });
  assert.equal((await request(app).post('/api/assistant/findings-summary').send({})).status, 401);
});
