'use strict';

// Event patterns — one named match, used by every policy that needs it.
//
// The feature's failure mode is a grouping that silently widens: a pattern with
// nothing pinned down, or a rule whose pattern was deleted and that falls back
// to its own blank columns, governs EVERY event from its source — and the first
// thing anyone notices is an estate that went quiet. So the specs below pin
// that shut from both ends, and then pin the thing the feature exists for: one
// condition across many agents is ONE alert.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, authHeader, makeSeverityRulesRepo, makeEventPatternsRepo, makeFindingStore,
} = require('../test-support/fakes');
const {
  patternFor, routeFor, channelsOf, validatePattern, validateRoute, MAX_COOLDOWN_MS,
} = require('../src/events/patterns');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');

const BASE = '/api/event-patterns';

const pattern = (over = {}) => ({
  id: 1, name: 'Warehouse links', source: 'finding', enabled: true,
  match_metric: null, match_kind: null, match_host_id: null, match_application_id: null,
  reason: 'wifi, not an SLA', ...over,
});
const route = (over = {}) => ({
  id: 1, pattern_id: 1, channels: 'matrix', min_severity: null, cooldown_ms: null,
  enabled: true, reason: 'the NOC room', ...over,
});
const event = (over = {}) => ({
  source: 'finding', severity: 'CRIT', metric: 'packet_loss', kind: 'ANOMALY', host_id: 'a1', ...over,
});

// ------------------------------------------------------------------- matching
test('a pattern matches on the same fields a severity rule does, blank meaning any', () => {
  const ps = [pattern({ match_metric: 'packet_loss' })];
  assert.equal(patternFor(ps, event()).id, 1);
  assert.equal(patternFor(ps, event({ metric: 'rtt' })), null);
  assert.equal(patternFor(ps, event({ source: 'service_assurance' })), null);
});

test('the most specific pattern wins, and an equal tie goes to the newest', () => {
  const broad = pattern({ id: 1, name: 'Loss', match_metric: 'packet_loss' });
  const narrow = pattern({ id: 2, name: 'Loss on gw', match_metric: 'packet_loss', match_host_id: 'a1' });
  assert.equal(patternFor([broad, narrow], event()).id, 2);
  assert.equal(patternFor([broad, narrow], event({ host_id: 'other' })).id, 1);

  const older = pattern({ id: 7, name: 'A', match_kind: 'ANOMALY' });
  const newer = pattern({ id: 9, name: 'B', match_kind: 'ANOMALY' });
  assert.equal(patternFor([older, newer], event()).id, 9, 'two equal patterns is a person changing their mind');
});

test('a disabled pattern matches nothing', () => {
  assert.equal(patternFor([pattern({ enabled: false, match_metric: 'packet_loss' })], event()), null);
});

// --------------------------------------------------------------------- routing
test('routeFor pairs the matched pattern with its route', () => {
  const r = routeFor([pattern({ match_metric: 'packet_loss' })], [route()], event());
  assert.equal(r.pattern.id, 1);
  assert.equal(r.routed, true);
  assert.deepEqual(channelsOf(r.route), ['matrix']);
});

test('a pattern with no route, or a disabled route, routes nothing — and is not an error', () => {
  const ps = [pattern({ match_metric: 'packet_loss' })];
  assert.equal(routeFor(ps, [], event()), null);
  assert.equal(routeFor(ps, [route({ enabled: false })], event()), null);
});

test("an event below the route's minimum is NOT alerted, rather than falling back", () => {
  const ps = [pattern({ match_metric: 'packet_loss' })];
  const rs = [route({ min_severity: 'CRIT' })];
  assert.equal(routeFor(ps, rs, event({ severity: 'WARN' })).routed, false,
    "falling back to the channel minimums would make the route's threshold decorative");
  assert.equal(routeFor(ps, rs, event({ severity: 'CRIT' })).routed, true);
});

// ------------------------------------------------------------------ validation
test('a pattern needs a name, a source, something to match on and a reason', () => {
  assert.ok(validatePattern({}).errors);
  assert.ok(validatePattern(null).errors);
  assert.ok(validatePattern({ name: 'X', source: 'finding', reason: 'r' }).errors._,
    'a pattern with nothing pinned down would cover every event from its source');
  assert.ok(validatePattern({ name: 'X', source: 'finding', match_kind: 'ANOMALY' }).errors.reason);
  assert.ok(validatePattern({ name: 'x'.repeat(81), source: 'finding', match_kind: 'A', reason: 'r' }).errors.name);
  const ok = validatePattern({ name: ' Warehouse ', source: 'finding', match_metric: ' packet_loss ', reason: ' why ' });
  assert.equal(ok.value.name, 'Warehouse');
  assert.equal(ok.value.match_metric, 'packet_loss');
  assert.equal(ok.value.match_kind, null, 'blank means any, spelled null');
});

test("a pattern cannot carry the other source's match fields", () => {
  const r = validatePattern({ name: 'X', source: 'service_assurance', match_host_id: 'a1', match_kind: 'TIMEOUT', reason: 'r' });
  assert.ok(r.errors.match_host_id, 'a silently dropped field matches far more than the person believed');
});

test('a route must name at least one known channel — a route with none would be a mute button', () => {
  assert.ok(validateRoute({ channels: [], reason: 'r' }).errors.channels);
  assert.ok(validateRoute({ reason: 'r' }).errors.channels);
  assert.ok(validateRoute({ channels: ['slack'], reason: 'r' }).errors.channels);
  assert.equal(validateRoute({ channels: ['matrix', 'MATRIX', 'email'], reason: 'r' }).value.channels, 'matrix,email');
});

test('a route bounds its own severity floor and cooldown, and blank means "the default"', () => {
  assert.ok(validateRoute({ channels: ['email'], min_severity: 'LOUD', reason: 'r' }).errors.min_severity);
  assert.ok(validateRoute({ channels: ['email'], cooldown_ms: -1, reason: 'r' }).errors.cooldown_ms);
  assert.ok(validateRoute({ channels: ['email'], cooldown_ms: MAX_COOLDOWN_MS + 1, reason: 'r' }).errors.cooldown_ms);
  assert.equal(validateRoute({ channels: ['email'], cooldown_ms: '600000', reason: 'r' }).value.cooldown_ms, 600000,
    'a form posts strings, so a numeric string is a number');
  assert.ok(validateRoute({ channels: ['email'], cooldown_ms: 'soon', reason: 'r' }).errors.cooldown_ms);
  const v = validateRoute({ channels: ['email'], reason: 'r' }).value;
  assert.equal(v.min_severity, null);
  assert.equal(v.cooldown_ms, null);
});

test('neither validator throws on garbage', () => {
  for (const bad of [undefined, null, 'str', 42, true, [], () => {}]) {
    assert.doesNotThrow(() => validatePattern(bad));
    assert.doesNotThrow(() => validateRoute(bad));
  }
});

// ------------------------------------------------------------------ dispatcher
function dispatcherWith(routing, { cooldownMs = 60000 } = {}) {
  const sent = { email: [], matrix: [] };
  const mk = (name) => ({ async send(subject) { sent[name].push(subject); return { ok: true }; } });
  const config = {
    enabled: true, enabledSetting: true, cooldownMs,
    channels: {
      email: { enabled: true, minSeverity: 'INFO' },
      matrix: { enabled: true, minSeverity: 'INFO' },
    },
  };
  let clock = 0;
  const dispatcher = createDispatcher({
    config, channels: { email: mk('email'), matrix: mk('matrix') }, routing, now: () => clock,
  });
  return { dispatcher, sent, tick: (ms) => { clock += ms; } };
}

const finding = (over = {}) => ({
  id: 1, hostId: 'a1', metric: 'packet_loss', kind: 'ANOMALY', severity: 'CRIT', ...over,
});

test('a routed finding goes only to the channels its pattern names', async () => {
  const routing = { routeFor: async () => ({ pattern: pattern(), route: route({ channels: 'matrix' }), routed: true }) };
  const { dispatcher, sent } = dispatcherWith(routing);
  const res = await dispatcher.dispatch(finding());
  assert.equal(res.dispatched, true);
  assert.equal(sent.matrix.length, 1);
  assert.equal(sent.email.length, 0, 'e-mail is enabled, but the route did not name it');
});

test("the route's minimum replaces the channel's own", async () => {
  const routing = { routeFor: async () => ({ pattern: pattern(), route: route({ channels: 'matrix', min_severity: 'CRIT' }), routed: true }) };
  const { dispatcher, sent } = dispatcherWith(routing);
  const warn = await dispatcher.dispatch(finding({ severity: 'WARN' }));
  assert.equal(warn.dispatched, false);
  assert.equal(sent.matrix.length, 0, 'the channel would have taken an INFO; the route would not');
});

test('ONE alert for one condition across many agents — the cooldown is keyed on the pattern', async () => {
  let routed = 0;
  const routing = {
    routeFor: async () => { routed += 1; return { pattern: pattern(), route: route({ channels: 'matrix' }), routed: true }; },
    recordRouted: async () => {},
  };
  const { dispatcher, sent } = dispatcherWith(routing, { cooldownMs: 60000 });
  for (const host of ['a1', 'a2', 'a3', 'a4']) {
    await dispatcher.dispatch(finding({ hostId: host }));
  }
  assert.equal(sent.matrix.length, 1, 'four agents, one condition, one alert — the whole point of the feature');
  assert.equal(routed, 4);
});

test('without the pattern, the same four agents are four alerts (the behaviour patterns replace)', async () => {
  const { dispatcher, sent } = dispatcherWith(null, { cooldownMs: 60000 });
  for (const host of ['a1', 'a2', 'a3', 'a4']) {
    await dispatcher.dispatch(finding({ hostId: host }));
  }
  assert.equal(sent.matrix.length, 4);
  assert.equal(sent.email.length, 4);
});

test('a CRIT escalation is never swallowed by the WARN cooldown it follows', async () => {
  const routing = { routeFor: async () => ({ pattern: pattern(), route: route({ channels: 'matrix' }), routed: true }) };
  const { dispatcher, sent } = dispatcherWith(routing, { cooldownMs: 60000 });
  await dispatcher.dispatch(finding({ severity: 'WARN' }));
  await dispatcher.dispatch(finding({ severity: 'CRIT' }));
  assert.equal(sent.matrix.length, 2);
});

test("the route's own cooldown replaces the global one", async () => {
  const routing = { routeFor: async () => ({ pattern: pattern(), route: route({ channels: 'matrix', cooldown_ms: 0 }), routed: true }) };
  const { dispatcher, sent } = dispatcherWith(routing, { cooldownMs: 3600000 });
  await dispatcher.dispatch(finding());
  await dispatcher.dispatch(finding());
  assert.equal(sent.matrix.length, 2, 'cooldown_ms 0 means every sample, and 0 is not "unset"');
});

test('a routing resolver that throws costs the routing, never the alert', async () => {
  const routing = { routeFor: async () => { throw new Error('db gone'); } };
  const { dispatcher, sent } = dispatcherWith(routing);
  const res = await dispatcher.dispatch(finding());
  assert.equal(res.dispatched, true);
  assert.equal(sent.email.length, 1);
  assert.equal(sent.matrix.length, 1);
});

// -------------------------------------------------------------------- the API
function appWith(seed = []) {
  const severityRulesRepo = makeSeverityRulesRepo();
  const eventPatternsRepo = makeEventPatternsRepo(seed, { severityRulesRepo });
  const findingStore = makeFindingStore();
  const app = makeApp({ severityRulesRepo, eventPatternsRepo, findingStore });
  return { app, severityRulesRepo, eventPatternsRepo, findingStore };
}
const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

test('GET /api/event-patterns needs a session and lists patterns with their route', async () => {
  const { app } = appWith();
  assert.equal((await request(app).get(BASE)).status, 401);
  assert.equal((await request(app).get(BASE).set('Authorization', viewer())).status, 200);

  const created = await request(app).post(BASE).set('Authorization', admin())
    .send({ name: 'Warehouse links', source: 'finding', match_metric: 'packet_loss', reason: 'wifi, not an SLA' });
  assert.equal(created.status, 201);

  await request(app).put(`${BASE}/${created.body.id}/route`).set('Authorization', admin())
    .send({ channels: ['matrix'], min_severity: 'WARN', reason: 'the NOC room' });

  const list = await request(app).get(BASE).set('Authorization', viewer());
  assert.equal(list.body.length, 1);
  assert.deepEqual(list.body[0].route.channel_list, ['matrix']);
  assert.equal(list.body[0].rule_count, 0);
});

test('writes are admin-only — a pattern decides what wakes people at 3am, and now where', async () => {
  const { app } = appWith([pattern()]);
  const body = { name: 'X', source: 'finding', match_kind: 'ANOMALY', reason: 'r' };
  assert.equal((await request(app).post(BASE).set('Authorization', viewer()).send(body)).status, 403);
  assert.equal((await request(app).put(`${BASE}/1`).set('Authorization', viewer()).send(body)).status, 403);
  assert.equal((await request(app).delete(`${BASE}/1`).set('Authorization', viewer())).status, 403);
  assert.equal((await request(app).put(`${BASE}/1/route`).set('Authorization', viewer()).send({ channels: ['email'], reason: 'r' })).status, 403);
  assert.equal((await request(app).post(`${BASE}/preview`).set('Authorization', viewer()).send(body)).status, 403);
  assert.equal((await request(app).get(`${BASE}/1/matches`).set('Authorization', viewer())).status, 403);
});

test('a bad body is 400 with the validation contract, a bad id is 400, a missing one is 404', async () => {
  const { app } = appWith();
  for (const bad of [{}, { name: 'X' }, { name: 'X', source: 'nope', reason: 'r' }]) {
    const res = await request(app).post(BASE).set('Authorization', admin()).send(bad);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(res.body.details);
  }
  for (const path of [`${BASE}/abc`, `${BASE}/0`, `${BASE}/-1`, `${BASE}/1.5`]) {
    assert.equal((await request(app).get(path).set('Authorization', admin())).status, 400, path);
  }
  assert.equal((await request(app).get(`${BASE}/999`).set('Authorization', admin())).status, 404);
  assert.equal((await request(app).delete(`${BASE}/999`).set('Authorization', admin())).status, 404);
  assert.equal((await request(app).put(`${BASE}/999/route`).set('Authorization', admin()).send({ channels: ['email'], reason: 'r' })).status, 404);
  assert.equal((await request(app).delete(`${BASE}/999/route`).set('Authorization', admin())).status, 404);
});

test('a pattern with no route cannot have one deleted', async () => {
  const { app } = appWith([pattern()]);
  const res = await request(app).delete(`${BASE}/1/route`).set('Authorization', admin());
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no alert route/);
});

test('two patterns cannot share a name — the answer names the conflict', async () => {
  const { app } = appWith();
  const body = { name: 'Warehouse links', source: 'finding', match_metric: 'packet_loss', reason: 'r' };
  assert.equal((await request(app).post(BASE).set('Authorization', admin()).send(body)).status, 201);
  const dup = await request(app).post(BASE).set('Authorization', admin()).send(body);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.details.name, 'already taken');
});

test('an edit cannot widen a pattern by removing its last match field', async () => {
  const { app } = appWith();
  const created = await request(app).post(BASE).set('Authorization', admin())
    .send({ name: 'Loss', source: 'finding', match_metric: 'packet_loss', reason: 'r' });
  const res = await request(app).put(`${BASE}/${created.body.id}`).set('Authorization', admin())
    .send({ match_metric: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details._);
});

test('a severity rule may follow a pattern instead of carrying its own match', async () => {
  const { app, severityRulesRepo } = appWith([pattern({ match_metric: 'packet_loss' })]);
  const res = await request(app).post('/api/severity-rules').set('Authorization', admin())
    .send({ source: 'finding', pattern_id: 1, severity: 'WARN', reason: 'the warehouse grouping' });
  assert.equal(res.status, 201);
  assert.equal(res.body.pattern_id, 1);
  assert.equal(res.body.match_metric, null, 'the pattern is the match; a second copy is a rule nobody can read');
  assert.equal(severityRulesRepo.rows.length, 1);
});

test('a rule cannot follow a pattern that does not exist, or one for the other source', async () => {
  const { app } = appWith([pattern({ source: 'service_assurance', match_kind: 'TIMEOUT' })]);
  const missing = await request(app).post('/api/severity-rules').set('Authorization', admin())
    .send({ source: 'finding', pattern_id: 42, severity: 'WARN', reason: 'r' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.details.pattern_id, /does not exist/);

  const crossed = await request(app).post('/api/severity-rules').set('Authorization', admin())
    .send({ source: 'finding', pattern_id: 1, severity: 'WARN', reason: 'r' });
  assert.equal(crossed.status, 400);
  assert.match(crossed.body.details.pattern_id, /service_assurance/);
});

test('deleting a pattern takes its rules and its route with it, and says how many', async () => {
  const { app, severityRulesRepo } = appWith([pattern({ match_metric: 'packet_loss' })]);
  await request(app).post('/api/severity-rules').set('Authorization', admin())
    .send({ source: 'finding', pattern_id: 1, severity: 'WARN', reason: 'r' });
  await request(app).put(`${BASE}/1/route`).set('Authorization', admin())
    .send({ channels: ['email'], reason: 'r' });

  const res = await request(app).delete(`${BASE}/1`).set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true, severity_rules_deleted: 1, route_deleted: true });
  assert.equal(severityRulesRepo.rows.length, 0,
    'a pattern-backed rule left behind would have no match of its own, and would govern everything');
});

test('the match count says how many open events a draft covers, and stores nothing', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push(
    { id: 1, hostId: 'a1', metric: 'packet_loss', kind: 'ANOMALY', severity: 'CRIT', acked: false },
    { id: 2, hostId: 'a2', metric: 'packet_loss', kind: 'ANOMALY', severity: 'WARN', acked: false },
    { id: 3, hostId: 'a3', metric: 'rtt', kind: 'ANOMALY', severity: 'CRIT', acked: false },
    { id: 4, hostId: 'a4', metric: 'packet_loss', kind: 'ANOMALY', severity: 'CRIT', acked: true }
  );
  const severityRulesRepo = makeSeverityRulesRepo();
  const app = makeApp({
    findingStore, severityRulesRepo,
    eventPatternsRepo: makeEventPatternsRepo([pattern({ match_metric: 'packet_loss' })], { severityRulesRepo }),
  });

  const draft = await request(app).post(`${BASE}/preview`).set('Authorization', admin())
    .send({ name: 'Loss', source: 'finding', match_metric: 'packet_loss', reason: 'r' });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.matched, 2, 'both severities count, and an acknowledged finding is history');

  const saved = await request(app).get(`${BASE}/1/matches`).set('Authorization', admin());
  assert.equal(saved.body.matched, 2);
  assert.equal(findingStore.rows.length, 4, 'a count is a read');
});

test('the cache the dispatcher reads leaves out a disabled pattern and its route', async () => {
  const severityRulesRepo = makeSeverityRulesRepo();
  const repo = makeEventPatternsRepo([pattern({ match_metric: 'packet_loss' })], { severityRulesRepo });
  await repo.saveRoute(1, { channels: 'email', reason: 'r' });
  assert.equal((await repo.active()).routes.length, 1);
  await repo.save(1, { enabled: false });
  const active = await repo.active();
  assert.equal(active.patterns.length, 0);
  assert.equal(active.routes.length, 0, 'switching a pattern off switches its routing off with it');
});
