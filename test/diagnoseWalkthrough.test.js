'use strict';

// The guided walk-through: one diagnosis session read back as an ORDERED list
// of steps.
//
// The thing under test is the ordering and the honesty. A plan hands a
// technician four causes and nine tests at once; a walk-through has to say what
// to do FIRST, what that answer meant, and what is left — and it must never
// confirm anything of its own, because the verdict belongs to the evaluation.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildWalkthrough, STEP, STATUS, OUTCOME } = require('../src/diagnose/walkthrough');
const { makeApp, makeAgentsRepo, makeDiagnoseSessionsRepo, authHeader } = require('../test-support/fakes');

const F1 = 'Mail kan forbinde, men når der sendes data, mistes pakker eller forbindelsen afbrydes';
const AGENTS = [{ id: 1, hostname: 'a1', status: 'online' }];
const agents = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});
const get = (app, path, role = 'viewer') => request(app).get(path).set('Authorization', authHeader(role));
const post = (app, path, role, body) => request(app).post(path).set('Authorization', authHeader(role)).send(body);

// A plan shaped like buildPlan's output, with the tests deliberately listed in
// the WRONG order for a diagnosis — application first, reachability last.
const plan = (over = {}) => ({
  target: '10.0.0.5',
  agentId: 1,
  causes: [{
    id: 'mtu_blackhole',
    title: 'MTU / PMTUD blackhole',
    views: [{ view: 'probes', params: {}, look_for: 'The path_mtu result.' }],
    fixes: [],
    tests: [0, 1, 2],
  }],
  tests: [
    { index: 0, probeType: 'http', direction: 'forward', target: '10.0.0.5', params: {}, why: 'does the app answer', askedBy: ['mtu_blackhole'] },
    { index: 1, probeType: 'path_mtu', direction: 'forward', target: '10.0.0.5', params: { per_hop: true }, why: 'how big a packet the path carries', askedBy: ['mtu_blackhole'] },
    { index: 2, probeType: 'ping', direction: 'forward', target: '10.0.0.5', params: { sizes: [64, 1472] }, why: 'two sizes, same target', askedBy: ['mtu_blackhole'] },
  ],
  skipped: [],
  ...over,
});

const testRow = (id, probeType, over = {}) => ({
  id, probeType, direction: 'forward', target: '10.0.0.5',
  status: 'pending', dispatchedAt: null, probeResultId: null, detail: null, ...over,
});

// ------------------------------------------------------------------ ordering

test('the measurements are ordered cheapest and most decisive first', () => {
  // The plan lists http, path_mtu, ping. A diagnosis runs them the other way
  // round: an application test failing says nothing until something has
  // answered at all, while a ping failing makes the rest a wasted afternoon.
  const w = buildWalkthrough({ session: { plan: plan() }, tests: [] });
  const measures = w.steps.filter((s) => s.kind === STEP.MEASURE);
  assert.deepEqual(measures.map((s) => s.probeType), ['ping', 'path_mtu', 'http']);
  assert.equal(measures[0].n, 1, 'the first step is the first thing to do');
});

test('the forward direction goes before the reverse one at the same rank', () => {
  // "A cannot reach B" is worth knowing before "B cannot reach A".
  const w = buildWalkthrough({
    session: {
      plan: plan({
        tests: [
          { index: 0, probeType: 'ping', direction: 'reverse', target: '10.0.0.1', params: {}, why: 'back', askedBy: [] },
          { index: 1, probeType: 'ping', direction: 'forward', target: '10.0.0.5', params: {}, why: 'out', askedBy: [] },
        ],
      }),
    },
    tests: [],
  });
  const measures = w.steps.filter((s) => s.kind === STEP.MEASURE);
  assert.deepEqual(measures.map((s) => s.direction), ['forward', 'reverse']);
});

test('a probe type the order does not know lands at the end, not at random', () => {
  const w = buildWalkthrough({
    session: {
      plan: plan({
        tests: [
          { index: 0, probeType: 'something_new', direction: 'forward', target: 'x', params: {}, why: null, askedBy: [] },
          { index: 1, probeType: 'ping', direction: 'forward', target: 'x', params: {}, why: null, askedBy: [] },
        ],
      }),
    },
    tests: [],
  });
  const measures = w.steps.filter((s) => s.kind === STEP.MEASURE);
  assert.deepEqual(measures.map((s) => s.probeType), ['ping', 'something_new']);
});

// -------------------------------------------------------------------- status

test('the position is the first unfinished step, and it is marked current', () => {
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(10, 'ping', { status: 'dispatched', dispatchedAt: '2026-01-01T00:00:00Z', probeResultId: 99 })],
  });
  const first = w.steps[0];
  assert.equal(first.probeType, 'ping');
  assert.equal(first.status, STATUS.DONE);
  assert.equal(w.position, 2);
  assert.equal(w.steps[1].status, STATUS.CURRENT);
  assert.equal(w.done, 1);
});

test('a dispatched test with no result yet is WAITING, not done', () => {
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(10, 'ping', { status: 'dispatched', dispatchedAt: '2026-01-01T00:00:00Z' })],
  });
  assert.equal(w.steps[0].status, STATUS.WAITING);
  assert.equal(w.steps[0].outcome, OUTCOME.WAITING);
  assert.equal(w.stalled, false, 'a test still in flight is not a stall');
});

test('a failed test stalls the walk-through and carries the reason', () => {
  // The one thing worse than no step is a step that silently did nothing.
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(10, 'ping', { status: 'failed', detail: 'agent is not connected' })],
  });
  assert.equal(w.steps[0].status, STATUS.FAILED);
  assert.equal(w.steps[0].outcome, OUTCOME.FAILED);
  assert.equal(w.steps[0].detail, 'agent is not connected');
  assert.equal(w.stalled, true);
});

test('a test the plan could not schedule is a blocked step with its reason', () => {
  const w = buildWalkthrough({
    session: {
      plan: plan({
        tests: [],
        skipped: [{ playbookId: 'mtu_blackhole', direction: 'reverse', probeType: 'ping', agentId: 2, reason: 'No origin agent was chosen.' }],
      }),
    },
    tests: [],
  });
  const blocked = w.steps.find((s) => s.kind === STEP.BLOCKED);
  assert.ok(blocked);
  assert.equal(blocked.why, 'No origin agent was chosen.');
  assert.equal(w.stalled, true, 'a step nobody can run is a stall, not a wait');
});

// ------------------------------------------------------- what a step FOUND

const evaluation = (over = {}) => ({
  missingFacts: [],
  causes: [{
    playbookId: 'mtu_blackhole',
    title: 'MTU / PMTUD blackhole',
    verdict: 'confirmed',
    reason: null,
    decidedBy: ['pmtu_blackhole'],
    evidence: [
      {
        ruleId: 'loss_size_dependent', effect: 'confirm',
        when: 'ping.size_64.loss_pct == 0 && ping.size_1472.loss_pct >= 50',
        because: 'Small packets pass and large ones do not.', result: true, missing: [],
      },
      {
        ruleId: 'pmtu_blackhole', effect: 'confirm',
        when: 'path_mtu.blackhole_detected == true',
        because: 'Oversized packets vanish and no router explains it.', result: true, missing: [],
      },
      {
        ruleId: 'all_sizes_ok', effect: 'rule_out',
        when: 'ping.size_1472.loss_pct == 0 && path_mtu.path_mtu >= 1500',
        because: 'A full packet reaches the target.', result: false, missing: [],
      },
    ],
    fixes: [
      { text: 'Allow ICMP type 3 code 4 at hop 5.', complete: true },
      { text: 'Clamp TCP MSS to (not measured yet).', complete: false },
    ],
    missingFacts: [],
  }],
  ...over,
});

test('a finished step says which rules IT decided, with the playbook sentence', () => {
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [
      testRow(10, 'ping', { probeResultId: 1, dispatchedAt: 'x' }),
      testRow(11, 'path_mtu', { probeResultId: 2, dispatchedAt: 'x' }),
    ],
    evaluation: evaluation(),
  });
  const [ping, pathMtu] = w.steps;
  // The ping step decided the two rules that READ ping, and neither of the
  // path_mtu-only ones.
  assert.deepEqual(ping.decided.map((d) => d.ruleId).sort(), ['all_sizes_ok', 'loss_size_dependent']);
  assert.equal(ping.outcome, OUTCOME.SIGNAL, 'a rule fired on it');
  assert.ok(ping.decided.find((d) => d.ruleId === 'loss_size_dependent').because.length > 0);
  // `all_sizes_ok` reads both ping and path_mtu, so it belongs to both steps —
  // each one genuinely made it more decidable.
  assert.deepEqual(pathMtu.decided.map((d) => d.ruleId).sort(), ['all_sizes_ok', 'pmtu_blackhole']);
});

test('a step whose rules all came back false is CLEAR — something is eliminated', () => {
  const ev = evaluation();
  ev.causes[0].evidence = ev.causes[0].evidence.map((e) => ({ ...e, result: e.ruleId === 'all_sizes_ok' ? false : null }));
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(10, 'ping', { probeResultId: 1, dispatchedAt: 'x' })],
    evaluation: ev,
  });
  assert.equal(w.steps[0].outcome, OUTCOME.CLEAR);
  assert.deepEqual(w.steps[0].decided.map((d) => d.ruleId), ['all_sizes_ok'], 'an undecided rule is the NEXT step\'s, not this one\'s');
});

test('a measurement no rule in this plan reads is UNREAD, not a clean bill', () => {
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(12, 'http', { probeResultId: 3, dispatchedAt: 'x' })],
    evaluation: evaluation(),
  });
  const http = w.steps.find((s) => s.probeType === 'http');
  assert.equal(http.outcome, OUTCOME.UNREAD);
  assert.deepEqual(http.decided, []);
});

test('reverse rules never attach to the forward step, nor tcp to tcptraceroute', () => {
  // The root token is matched on a boundary and a dot. Getting this wrong puts
  // the far end's evidence on the near end's step, which is a lie about which
  // direction was measured.
  const ev = evaluation();
  ev.causes[0].evidence = [
    { ruleId: 'back', effect: 'confirm', when: 'reverse.ping.loss_pct > 50', because: 'b', result: true, missing: [] },
    { ruleId: 'trace', effect: 'confirm', when: 'tcptraceroute.hops >= 8', because: 't', result: true, missing: [] },
  ];
  const w = buildWalkthrough({
    session: {
      plan: plan({
        tests: [
          { index: 0, probeType: 'ping', direction: 'forward', target: '10.0.0.5', params: {}, why: null, askedBy: [] },
          { index: 1, probeType: 'tcp', direction: 'forward', target: '10.0.0.5', params: {}, why: null, askedBy: [] },
        ],
      }),
    },
    tests: [
      testRow(10, 'ping', { probeResultId: 1, dispatchedAt: 'x' }),
      testRow(11, 'tcp', { probeResultId: 2, dispatchedAt: 'x' }),
    ],
    evaluation: ev,
  });
  for (const s of w.steps.filter((x) => x.kind === STEP.MEASURE)) {
    assert.deepEqual(s.decided, [], `${s.probeType} picked up a rule that is not about it`);
  }
});

// --------------------------------------------------- verdict, views and fixes

test('the verdict step is the evaluation\'s, never a second opinion', () => {
  const w = buildWalkthrough({
    session: { plan: plan() },
    tests: [testRow(10, 'ping', { probeResultId: 1, dispatchedAt: 'x' })],
    evaluation: evaluation(),
  });
  const decide = w.steps.find((s) => s.kind === STEP.DECIDE);
  assert.equal(decide.status, STATUS.DONE);
  assert.deepEqual(decide.verdict.confirmed.map((c) => c.playbookId), ['mtu_blackhole']);
  assert.deepEqual(decide.verdict.open, []);
  assert.deepEqual(w.verdict, { confirmed: 1, open: 0, total: 1 });
});

test('with nothing evaluated the verdict step is still there, unanswered', () => {
  const w = buildWalkthrough({ session: { plan: plan() }, tests: [] });
  const decide = w.steps.find((s) => s.kind === STEP.DECIDE);
  assert.equal(decide.status, STATUS.PENDING);
  assert.equal(decide.verdict, null);
  assert.equal(w.verdict, null);
});

test('fixes are offered only for a CONFIRMED cause', () => {
  // A fix for a cause nothing confirmed is an invitation to change a setting on
  // a network that did not have that problem — and the change gets blamed for
  // the next unrelated fault.
  const ev = evaluation();
  ev.causes[0].verdict = 'inconclusive';
  ev.causes[0].reason = 'missing_data';
  const w = buildWalkthrough({ session: { plan: plan() }, tests: [], evaluation: ev });
  assert.equal(w.steps.filter((s) => s.kind === STEP.FIX).length, 0);

  const confirmed = buildWalkthrough({ session: { plan: plan() }, tests: [], evaluation: evaluation() });
  const fixes = confirmed.steps.filter((s) => s.kind === STEP.FIX);
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].fix.complete, true);
  assert.equal(fixes[1].fix.complete, false, 'a fix with a number still missing is kept, and says so');
});

test('a ruled-out cause\'s screens are not worth reading', () => {
  const ev = evaluation();
  ev.causes[0].verdict = 'ruled_out';
  const w = buildWalkthrough({ session: { plan: plan() }, tests: [], evaluation: ev });
  assert.equal(w.steps.filter((s) => s.kind === STEP.LOOK).length, 0);
});

test('the same screen asked for by two causes is read once', () => {
  const p = plan();
  p.causes = [
    { id: 'a', views: [{ view: 'probes', params: {}, look_for: 'x' }], fixes: [], tests: [] },
    { id: 'b', views: [{ view: 'probes', params: {}, look_for: 'y' }], fixes: [], tests: [] },
  ];
  const w = buildWalkthrough({ session: { plan: p }, tests: [] });
  assert.equal(w.steps.filter((s) => s.kind === STEP.LOOK).length, 1);
});

test('localized playbook text comes back in the session\'s language', () => {
  const p = plan();
  p.tests[2].why = { en: 'two sizes', da: 'to størrelser' };
  const da = buildWalkthrough({ session: { plan: p }, tests: [], locale: 'da' });
  assert.equal(da.steps[0].why, 'to størrelser');
  const en = buildWalkthrough({ session: { plan: p }, tests: [], locale: 'en' });
  assert.equal(en.steps[0].why, 'two sizes');
  // A locale the catalogue has no text for falls back rather than blanking.
  const de = buildWalkthrough({ session: { plan: p }, tests: [], locale: 'de' });
  assert.equal(de.steps[0].why, 'two sizes');
});

// ---------------------------------------------------------------- the route

test('GET /api/diagnose/:id/walkthrough is a viewer read of a real session', async () => {
  const app = makeApp({ agentsRepo: agents() });
  const created = await post(app, '/api/diagnose', 'viewer', {
    description: F1, locale: 'da', agentId: 1, target: 'mail.example.com',
  });
  assert.equal(created.status, 201);

  const res = await get(app, `/api/diagnose/${created.body.sessionId}/walkthrough`, 'viewer');
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionId, created.body.sessionId);
  assert.equal(res.body.target, 'mail.example.com');
  assert.ok(res.body.total >= 2, 'a plan with tests is more than a verdict');
  assert.equal(res.body.position, 1);
  assert.equal(res.body.steps[0].kind, 'measure');
  // Nothing has run, so nothing is decided — and the verdict step is honest
  // about it rather than reading as "all clear".
  assert.equal(res.body.verdict, null);
  assert.ok(res.body.steps.some((s) => s.kind === 'decide'));
});

test('the walkthrough 400s a bad id, 404s an unknown session and 503s with no storage', async () => {
  const app = makeApp({ agentsRepo: agents() });
  assert.equal((await get(app, '/api/diagnose/abc/walkthrough', 'viewer')).status, 400);
  assert.equal((await get(app, '/api/diagnose/0/walkthrough', 'viewer')).status, 400);
  assert.equal((await get(app, '/api/diagnose/424242/walkthrough', 'viewer')).status, 404);

  const none = makeApp({ agentsRepo: agents(), diagnoseSessionsRepo: null });
  assert.equal((await get(none, '/api/diagnose/1/walkthrough', 'viewer')).status, 503);
});

test('the walkthrough needs a session, and an anonymous caller gets 401', async () => {
  const app = makeApp({ agentsRepo: agents() });
  const res = await request(app).get('/api/diagnose/1/walkthrough');
  assert.equal(res.status, 401);
});

test('a repository that throws is a 500, not a half-built walk-through', async () => {
  const app = makeApp({
    agentsRepo: agents(),
    diagnoseSessionsRepo: makeDiagnoseSessionsRepo({
      findById: async () => { throw new Error('db gone'); },
    }),
  });
  const res = await get(app, '/api/diagnose/1/walkthrough', 'viewer');
  assert.equal(res.status, 500);
});
