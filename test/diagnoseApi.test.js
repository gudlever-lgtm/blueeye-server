'use strict';

// The HTTP surface: roles, the error codes the brief names (400/403/404/500),
// the AI fallback, and prompt injection.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeDiagnoseSessionsRepo, authHeader, throwingAsync } = require('../test-support/fakes');

const F1 = 'Mail kan forbinde, men når der sendes data, mistes pakker eller forbindelsen afbrydes';

const AGENTS = [
  { id: 1, hostname: 'a1', status: 'online' },
  { id: 2, hostname: 'a2', status: 'online' },
];
const agents = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});

// An agent hub that accepts every command, and remembers what it was sent.
function commander() {
  const sent = [];
  return { sent, sendCommand: (agentId, command) => { sent.push({ agentId, command }); return 1; } };
}

const post = (app, path, role, body) => request(app).post(path).set('Authorization', authHeader(role)).send(body);
const get = (app, path, role) => request(app).get(path).set('Authorization', authHeader(role));

// --- the catalogue ----------------------------------------------------------

test('GET /api/playbooks lists the catalogue, in the requested language', async () => {
  const app = makeApp();
  const en = await get(app, '/api/playbooks', 'viewer');
  assert.equal(en.status, 200);
  assert.ok(en.body.playbooks.length >= 9);
  const mtu = en.body.playbooks.find((p) => p.id === 'mtu_blackhole');
  assert.ok(mtu.testTypes.includes('path_mtu'));
  const da = await get(app, '/api/playbooks?locale=da', 'viewer');
  assert.notEqual(da.body.playbooks.find((p) => p.id === 'mtu_blackhole').explanation,
    en.body.playbooks.find((p) => p.id === 'mtu_blackhole').explanation);
});

test('GET /api/playbooks/:id returns one playbook whole, and 404s an invented one', async () => {
  const app = makeApp();
  const ok = await get(app, '/api/playbooks/mtu_blackhole', 'viewer');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.playbook.rules.length >= 3);
  assert.ok(ok.body.playbook.fixes.length >= 1);
  const missing = await get(app, '/api/playbooks/does_not_exist', 'viewer');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not found/i);
});

// --- creating a plan --------------------------------------------------------

test('POST /api/diagnose turns a description into a plan a viewer can read', async () => {
  const app = makeApp({ agentsRepo: agents() });
  const res = await post(app, '/api/diagnose', 'viewer', { description: F1, locale: 'da', agentId: 1, target: 'mail.example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.body.causes[0].id, 'mtu_blackhole');
  assert.equal(res.body.matchedBy, 'keywords');
  assert.equal(res.body.usedAi, false);
  // The plan is the whole answer: what to run, where to look, what it means.
  const cause = res.body.causes[0];
  assert.ok(cause.tests.length > 0);
  assert.ok(cause.views.every((v) => v.view && v.look_for));
  assert.ok(cause.fixes.length > 0);
  assert.ok(cause.explanation.length > 20);
  // The tests come with their parameters already filled in.
  const ping = res.body.tests.find((t) => t.probeType === 'ping');
  assert.deepEqual(ping.params.sizes, [64, 1472]);
  assert.equal(ping.params.df, true);
  assert.equal(ping.target, 'mail.example.com');
});

test('a plan deduplicates a test two causes both want', async () => {
  const app = makeApp({ agentsRepo: agents() });
  const res = await post(app, '/api/diagnose', 'viewer', { description: 'Vi mister pakker mellem A og B og ved ikke hvor', agentId: 1, target: '10.0.0.9' });
  const keys = res.body.tests.map((t) => `${t.direction}|${t.probeType}|${JSON.stringify(t.params)}`);
  assert.equal(new Set(keys).size, keys.length, 'the same measurement must not be run twice');
  const shared = res.body.tests.find((t) => t.askedBy.length > 1);
  if (shared) assert.ok(shared.askedBy.length >= 2, 'a shared test still records which causes wanted it');
});

test('a description that matches nothing says so instead of guessing', async () => {
  const app = makeApp();
  const res = await post(app, '/api/diagnose', 'viewer', { description: 'Hej, hvordan går det i dag?' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.causes, []);
  assert.equal(res.body.session, null);
  assert.match(res.body.message, /Nothing in the playbook catalogue matches/);
});

// --- 400 --------------------------------------------------------------------

test('400: an empty description, one over 1000 characters, and a hostile target', async () => {
  const app = makeApp();
  for (const body of [{}, { description: '' }, { description: '   ' }, { description: 'x'.repeat(1001) }]) {
    const res = await post(app, '/api/diagnose', 'viewer', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.errors.description);
  }
  const bad = await post(app, '/api/diagnose', 'viewer', { description: 'loss', target: '-rf' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.target);
  const exact = await post(app, '/api/diagnose', 'viewer', { description: 'mtu '.repeat(250).slice(0, 1000) });
  assert.notEqual(exact.status, 400, 'exactly 1000 characters is allowed');
});

test('400: evaluating before any test has run', async () => {
  const app = makeApp({ agentsRepo: agents() });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1, agentId: 1, target: 'h.example.com' });
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/evaluate`, 'operator', {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No tests have been run/);
});

// --- 403 --------------------------------------------------------------------

test('403: a viewer may read a plan but may not run it or evaluate it', async () => {
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander() });
  const created = await post(app, '/api/diagnose', 'viewer', { description: F1, agentId: 1, target: 'h.example.com' });
  assert.equal(created.status, 201);
  const id = created.body.sessionId;
  assert.equal((await get(app, `/api/diagnose/${id}`, 'viewer')).status, 200);
  assert.equal((await post(app, `/api/diagnose/${id}/run`, 'viewer', {})).status, 403);
  assert.equal((await post(app, `/api/diagnose/${id}/evaluate`, 'viewer', {})).status, 403);
  // And an operator may.
  assert.equal((await post(app, `/api/diagnose/${id}/run`, 'operator', {})).status, 202);
});

test('401: none of it answers without a token', async () => {
  const app = makeApp();
  for (const [method, path] of [['get', '/api/playbooks'], ['get', '/api/diagnose'], ['post', '/api/diagnose'], ['post', '/api/diagnose/1/run']]) {
    const res = await request(app)[method](path).send({});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

// --- 404 --------------------------------------------------------------------

test('404: an unknown session, an unknown playbook and an agent that does not exist', async () => {
  const app = makeApp({ agentsRepo: agents() });
  assert.equal((await get(app, '/api/diagnose/9999', 'viewer')).status, 404);
  assert.equal((await post(app, '/api/diagnose/9999/run', 'operator', {})).status, 404);
  assert.equal((await post(app, '/api/diagnose/9999/evaluate', 'operator', {})).status, 404);
  assert.equal((await get(app, '/api/playbooks/nope', 'viewer')).status, 404);
  const noAgent = await post(app, '/api/diagnose', 'viewer', { description: F1, agentId: 4242 });
  assert.equal(noAgent.status, 404);
  assert.match(noAgent.body.error, /Agent not found/);
  const noPeer = await post(app, '/api/diagnose', 'viewer', { description: F1, agentId: 1, peerAgentId: 4242 });
  assert.equal(noPeer.status, 404);
  assert.match(noPeer.body.error, /Peer agent not found/);
});

// --- 500 --------------------------------------------------------------------

test('500: a database failure answers JSON with no stack trace', async () => {
  const app = makeApp({
    agentsRepo: agents(),
    diagnoseSessionsRepo: makeDiagnoseSessionsRepo({ create: throwingAsync('db down') }),
  });
  const res = await post(app, '/api/diagnose', 'viewer', { description: F1, agentId: 1, target: 'h.example.com' });
  assert.equal(res.status, 500);
  assert.equal(res.headers['content-type'].split(';')[0], 'application/json');
  assert.equal(res.body.error, 'Internal Server Error');
  // No stack trace, in any environment. (`detail` carries the message off
  // production on purpose — that is the shared error handler's documented
  // behaviour, and it is a message, not a trace.)
  const body = JSON.stringify(res.body);
  assert.ok(!/\bat \w+ \(/.test(body), body);
  assert.ok(!/\.js:\d+/.test(body), body);
  assert.ok(!body.includes('node_modules'), body);
});

test('500: a failure inside the evaluator is a JSON error, not a crash', async () => {
  const repo = makeDiagnoseSessionsRepo();
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander(), diagnoseSessionsRepo: repo });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1, agentId: 1, target: 'h.example.com' });
  await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  repo.findResultFor = throwingAsync('result lookup exploded');
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/evaluate`, 'operator', {});
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  const body = JSON.stringify(res.body);
  assert.ok(!/\bat \w+ \(/.test(body), body);
  assert.ok(!/\.js:\d+/.test(body), body);
});

// --- running ----------------------------------------------------------------

test('running dispatches each test to its agent as an ordinary run-probe command', async () => {
  const hub = commander();
  const app = makeApp({ agentsRepo: agents(), agentCommander: hub });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1, agentId: 1, target: 'mail.example.com' });
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  assert.equal(res.status, 202);
  assert.ok(res.body.dispatched > 0);
  assert.ok(hub.sent.every((s) => s.command.name === 'run-probe'));
  const ping = hub.sent.find((s) => s.command.probe.type === 'ping');
  assert.deepEqual(ping.command.probe.sizes, [64, 1472]);
  assert.equal(ping.command.probe.df, true);
  const pmtu = hub.sent.find((s) => s.command.probe.type === 'path_mtu');
  assert.equal(pmtu.command.probe.perHop, true);
  assert.equal(pmtu.command.probe.host, 'mail.example.com');
});

test('an agent that is not connected is a recorded failure, never a stuck test', async () => {
  const app = makeApp({ agentsRepo: agents(), agentCommander: { sendCommand: () => 0 } });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1, agentId: 1, target: 'mail.example.com' });
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  assert.equal(res.status, 202);
  assert.equal(res.body.dispatched, 0);
  assert.ok(res.body.tests.every((t) => t.status === 'failed'));
  assert.ok(res.body.tests.every((t) => /not connected/.test(t.detail)));
  const after = await get(app, `/api/diagnose/${created.body.sessionId}`, 'viewer');
  assert.ok(after.body.session.tests.every((t) => t.status === 'failed' && t.detail));
});

test('409: a plan with no target has nothing to run', async () => {
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander() });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1 });
  assert.equal(created.status, 201);
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /needs a target and an agent/);
});

// --- evaluating end to end ---------------------------------------------------

test('a full run confirms the cause and hands back the fix with the numbers in it', async () => {
  const now = new Date();
  const probeRows = [
    {
      id: 11, agent_id: 1, type: 'ping', target: 'mail.example.com', ts: new Date(now.getTime() + 1000),
      ok: 1, loss_pct: 0, rtt_ms: 5,
      sizes: JSON.stringify([
        { bytes: 64, lossPct: 0, rttMs: 5, measured: true },
        { bytes: 1472, lossPct: 100, measured: true },
      ]),
    },
    {
      id: 12, agent_id: 1, type: 'path_mtu', target: 'mail.example.com', ts: new Date(now.getTime() + 2000), ok: 1,
      mtu: JSON.stringify({ pathMtu: 1400, blackholeDetected: true, recommendedMss: 1360, mtuDropAtHop: 3 }),
    },
  ];
  const repo = makeDiagnoseSessionsRepo({ probeRows });
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander(), diagnoseSessionsRepo: repo });

  const created = await post(app, '/api/diagnose', 'operator', { description: F1, locale: 'da', agentId: 1, target: 'mail.example.com' });
  await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/evaluate`, 'operator', {});

  assert.equal(res.status, 200);
  const mtu = res.body.causes.find((c) => c.playbookId === 'mtu_blackhole');
  assert.equal(mtu.verdict, 'confirmed');
  assert.ok(mtu.decidedBy.includes('loss_size_dependent'));
  assert.ok(mtu.decidedBy.includes('pmtu_blackhole'));
  // The fix arrives with the measurement in it, in the session's language.
  const mss = mtu.fixes.find((f) => f.text.includes('1360'));
  assert.ok(mss && mss.complete, JSON.stringify(mtu.fixes));
  assert.match(mss.text, /MSS clamping/);
  assert.ok(mtu.fixes.some((f) => f.text.includes('hop 3')));
  // And the evidence is linked, not just asserted.
  const detail = await get(app, `/api/diagnose/${created.body.sessionId}`, 'viewer');
  assert.ok(detail.body.session.tests.some((t) => t.probeResultId === 11));
  assert.equal(detail.body.session.status, 'evaluated');
});

test('a result from before the tests were dispatched is not counted as their answer', async () => {
  // probe_results carries no run id, so the correlation is a time window. A
  // measurement taken yesterday must not become this investigation's evidence.
  const repo = makeDiagnoseSessionsRepo({
    probeRows: [{
      id: 99, agent_id: 1, type: 'ping', target: 'mail.example.com',
      ts: new Date(Date.now() - 86400000), ok: 1, loss_pct: 0,
      sizes: JSON.stringify([{ bytes: 64, lossPct: 0, measured: true }, { bytes: 1472, lossPct: 100, measured: true }]),
    }],
  });
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander(), diagnoseSessionsRepo: repo });
  const created = await post(app, '/api/diagnose', 'operator', { description: F1, agentId: 1, target: 'mail.example.com' });
  await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/evaluate`, 'operator', {});
  assert.equal(res.body.resultsSeen, 0);
  assert.equal(res.body.causes.find((c) => c.playbookId === 'mtu_blackhole').verdict, 'inconclusive');
  assert.equal(res.body.causes.find((c) => c.playbookId === 'mtu_blackhole').reason, 'missing_data');
});
