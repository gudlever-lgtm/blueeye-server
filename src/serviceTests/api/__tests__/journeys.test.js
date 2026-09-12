'use strict';

// HTTP specs for User Journeys (V2 §2, P1 #1).
//
// The thing under test is not CRUD — it is the VERDICT. A journey exists to turn
// a set of green ticks into "can a caseworker do their job", so most of these
// assert what the rollup says and why, not what was stored.
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 on every route, never 500.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/journeys';

const DEF = { version: 1, steps: [{ type: 'open', url: '/login' }] };

// Two applications, four tests, so "belongs to a different application" is a
// real case rather than an unreachable branch.
function fixture(overrides = {}) {
  const serviceTests = makeServiceTests({
    applications: [
      { name: 'Customer Portal', base_url: 'https://customer.example.com', enabled: 1 },
      { name: 'Partner Portal', base_url: 'https://partner.example.com', enabled: 1 },
    ],
    environments: [
      { application_id: 1, name: 'Production', base_url: 'https://customer.example.com', type: 'production', enabled: 1 },
      { application_id: 2, name: 'Partner prod', base_url: 'https://partner.example.com', type: 'production', enabled: 1 },
    ],
    tests: [
      { application_id: 1, name: 'Login', definition: DEF, version: 1, enabled: 1 },
      { application_id: 1, name: 'Search Customer', definition: DEF, version: 1, enabled: 1 },
      { application_id: 1, name: 'Logout', definition: DEF, version: 1, enabled: 1 },
      { application_id: 2, name: 'Partner login', definition: DEF, version: 1, enabled: 1 },
    ],
    ...overrides,
  });
  return { serviceTests, app: makeApp({ serviceTests }) };
}

const post = (app, body, role = 'operator') => request(app).post(BASE).set('Authorization', authHeader(role)).send(body);
const newJourney = (app, over = {}) => post(app, { application_id: 1, name: 'Customer Login', ...over });

// Gives test `testId` a run with `status`, so a verdict has something to read.
function addRun(serviceTests, testId, status, over = {}) {
  return serviceTests.tables.runs.insert({
    test_id: testId, status, duration_ms: 1000, started_at: new Date(), ended_at: new Date(), ...over,
  });
}

// ------------------------------------------------------------------ 401 / 403
test('journeys are licence-gated, anonymous-401 and viewer-read-only', async () => {
  const { app } = fixture();
  assert.equal((await request(app).get(BASE)).status, 401, 'anonymous read');
  assert.equal((await request(app).post(BASE).send({})).status, 401, 'anonymous write');

  assert.equal((await request(app).get(BASE).set('Authorization', authHeader('viewer'))).status, 200);
  assert.equal((await post(app, { application_id: 1, name: 'x' }, 'viewer')).status, 403);

  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });
  const gated = await request(unlicensed).get(BASE).set('Authorization', authHeader('admin'));
  assert.equal(gated.status, 403);
  assert.equal(gated.body.error, 'feature_not_available');
});

// ------------------------------------------------------------------ 400
test('creating a journey validates what a journey IS (400, never 500)', async () => {
  const { app } = fixture();
  for (const body of [{}, { name: 'x' }, { application_id: 1 }, { application_id: 1, name: '  ' },
    { application_id: 1, name: 'x', criticality: 'urgent' },
    { application_id: 1, name: 'x', expected_duration_ms: 0 },
    { application_id: 1, name: 'x', expected_duration_ms: 99999999 },
    { application_id: 1, name: 'x', enabled: 'yes' }]) {
    const res = await post(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'Validation failed');
  }
  assert.match((await post(app, { application_id: 9999, name: 'x' })).body.details.application_id, /does not exist/);
  // An environment belonging to someone else's application would make the
  // journey a statement about the wrong service.
  assert.match((await post(app, { application_id: 1, name: 'x', environment_id: 2 })).body.details.environment_id,
    /different application/);

  for (const body of ['[]', '"str"', 'null', '123']) {
    const res = await request(app).post(BASE).set('Authorization', authHeader('operator'))
      .set('Content-Type', 'application/json').send(body);
    assert.ok(res.status < 500, `${body} → ${res.status}`);
  }
});

// ------------------------------------------------------------------ 404
test('an unknown or malformed journey id is 404/400 on every route, never 500', async () => {
  const { app } = fixture();
  const h = authHeader('operator');
  for (const [method, path] of [['get', '/999999'], ['put', '/999999'], ['delete', '/999999'], ['put', '/999999/steps']]) {
    assert.equal((await request(app)[method](`${BASE}${path}`).set('Authorization', h).send({ steps: [] })).status, 404,
      `${method} ${path}`);
  }
  for (const id of ['abc', '1;DROP', '-1', '1e309', '%00']) {
    for (const [method, suffix] of [['get', ''], ['put', ''], ['delete', ''], ['put', '/steps']]) {
      const res = await request(app)[method](`${BASE}/${id}${suffix}`).set('Authorization', h).send({ steps: [] });
      assert.ok(res.status < 500, `${method} id=${id} → ${res.status}`);
    }
  }
});

// ------------------------------------------------------------------ steps
test('a journey orders tests it does not own, and refuses ones that are not its own', async () => {
  const { app } = fixture();
  const journey = (await newJourney(app)).body;
  const put = (steps) => request(app).put(`${BASE}/${journey.id}/steps`)
    .set('Authorization', authHeader('operator')).send({ steps });

  const ok = await put([{ test_id: 1 }, { test_id: 2 }, { test_id: 3, required: false, label: 'Logout' }]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.step_count, 3);
  assert.deepEqual(ok.body.health.steps.map((s) => s.label), ['Login', 'Search Customer', 'Logout']);
  assert.deepEqual(ok.body.health.steps.map((s) => s.required), [true, true, false]);

  // Test 4 belongs to the other application: a journey is about ONE service.
  assert.match((await put([{ test_id: 4 }])).body.details['steps.0'], /different application/);
  assert.match((await put([{ test_id: 9999 }])).body.details['steps.0'], /does not exist/);
  // The same test twice would report one result under two names.
  assert.match((await put([{ test_id: 1 }, { test_id: 1 }])).body.details['steps.1'], /already a step/);
  assert.equal((await put('nope')).status, 400);

  // Whole-list: sending fewer is a removal, and the order is exactly as sent.
  const fewer = await put([{ test_id: 2 }, { test_id: 1 }]);
  assert.deepEqual(fewer.body.health.steps.map((s) => s.test_id), [2, 1]);

  // Emptying is allowed — a journey described but not yet implemented is real.
  assert.equal((await put([])).body.health.status, 'unknown');
});

// ------------------------------------------------------------------ the verdict
test('the verdict distinguishes "the user cannot get through" from "part of it is gone"', async () => {
  const { serviceTests, app } = fixture();
  const journey = (await newJourney(app, { criticality: 'critical' })).body;
  await request(app).put(`${BASE}/${journey.id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1 }, { test_id: 2 }, { test_id: 3, required: false, label: 'Logout' }] });

  const get = async () => (await request(app).get(`${BASE}/${journey.id}`).set('Authorization', authHeader('viewer'))).body;

  // Nothing has run: unknown, and unknown is NOT a failure.
  assert.equal((await get()).health.status, 'unknown');

  addRun(serviceTests, 1, 'pass');
  addRun(serviceTests, 2, 'pass');
  addRun(serviceTests, 3, 'pass');
  assert.equal((await get()).health.status, 'healthy');

  // The optional step breaks: the journey can still be completed.
  addRun(serviceTests, 3, 'fail');
  let health = (await get()).health;
  assert.equal(health.status, 'degraded');
  assert.match(health.reason, /Logout.*still be completed/);

  // A required step breaks: the user cannot get through.
  addRun(serviceTests, 1, 'fail');
  health = (await get()).health;
  assert.equal(health.status, 'failed');
  assert.match(health.reason, /Login.*cannot get through/);
  assert.equal(health.broken_step.test_id, 1);

  // And a newer passing run puts it back — the verdict reads the LATEST run,
  // not the worst one ever seen.
  addRun(serviceTests, 1, 'pass');
  addRun(serviceTests, 3, 'pass');
  assert.equal((await get()).health.status, 'healthy');
});

test('a warning degrades but never fails, and a queued run is not a verdict', async () => {
  const { serviceTests, app } = fixture();
  const journey = (await newJourney(app)).body;
  await request(app).put(`${BASE}/${journey.id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1 }, { test_id: 2 }] });
  const get = async () => (await request(app).get(`${BASE}/${journey.id}`).set('Authorization', authHeader('viewer'))).body;

  addRun(serviceTests, 1, 'pass');
  addRun(serviceTests, 2, 'warning');
  assert.equal((await get()).health.status, 'degraded');

  // Queued means "we do not know YET" — neither healthy nor broken.
  addRun(serviceTests, 2, 'queued', { duration_ms: null, ended_at: null });
  const health = (await get()).health;
  assert.equal(health.counts.pending, 1);
  assert.notEqual(health.status, 'failed');
});

test('a duration verdict exists only when the operator stated an expectation', async () => {
  const { serviceTests, app } = fixture();
  const bare = (await newJourney(app)).body;
  const expecting = (await newJourney(app, { name: 'With expectation', expected_duration_ms: 1200 })).body;
  const steps = { steps: [{ test_id: 1 }, { test_id: 2 }] };
  for (const j of [bare, expecting]) {
    await request(app).put(`${BASE}/${j.id}/steps`).set('Authorization', authHeader('operator')).send(steps);
  }
  addRun(serviceTests, 1, 'pass', { duration_ms: 2000 });
  addRun(serviceTests, 2, 'pass', { duration_ms: 2700 });

  const read = async (id) => (await request(app).get(`${BASE}/${id}`).set('Authorization', authHeader('viewer'))).body;
  assert.equal((await read(bare.id)).duration, null, 'no expectation must produce no verdict, not a made-up one');

  const verdict = (await read(expecting.id)).duration;
  assert.equal(verdict.duration_ms, 4700);
  assert.equal(verdict.expected_ms, 1200);
  assert.equal(verdict.slow, true);
});

test('a step with no measured duration makes the journey duration unknown, never faster', async () => {
  const { serviceTests, app } = fixture();
  const journey = (await newJourney(app, { expected_duration_ms: 5000 })).body;
  await request(app).put(`${BASE}/${journey.id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1 }, { test_id: 2 }] });

  addRun(serviceTests, 1, 'pass', { duration_ms: 3000 });
  addRun(serviceTests, 2, 'pass', { duration_ms: null });

  const body = (await request(app).get(`${BASE}/${journey.id}`).set('Authorization', authHeader('viewer'))).body;
  // 3000 would say "well under the 5000 expected" — a speed-up invented out of
  // a missing measurement, which is the one direction this must never err in.
  assert.equal(body.health.duration_ms, null);
  assert.equal(body.duration, null);
});

// ------------------------------------------------------------------ the list
test('the list rolls up to an application verdict, worst journey first', async () => {
  const { serviceTests, app } = fixture();
  const healthy = (await newJourney(app, { name: 'Healthy one', criticality: 'low' })).body;
  const broken = (await newJourney(app, { name: 'Broken one', criticality: 'critical' })).body;
  const put = (id, steps) => request(app).put(`${BASE}/${id}/steps`).set('Authorization', authHeader('operator')).send({ steps });
  await put(healthy.id, [{ test_id: 2 }]);
  await put(broken.id, [{ test_id: 1 }]);
  addRun(serviceTests, 2, 'pass');
  addRun(serviceTests, 1, 'fail');

  const res = await request(app).get(BASE).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  // Criticality orders the list: what matters most is read first.
  assert.deepEqual(res.body.journeys.map((j) => j.name), ['Broken one', 'Healthy one']);
  assert.deepEqual(res.body.journeys.map((j) => j.health.status), ['failed', 'healthy']);
  // The worst journey decides the application's verdict; the counts say how
  // widespread it is.
  assert.equal(res.body.summary.status, 'failed');
  assert.equal(res.body.summary.failed, 1);
  assert.equal(res.body.summary.healthy, 1);
  assert.equal(res.body.summary.total, 2);

  assert.equal((await request(app).get(`${BASE}?application_id=2`).set('Authorization', authHeader('viewer'))).body.journeys.length, 0);
  assert.equal((await request(app).get(`${BASE}?application_id=abc`).set('Authorization', authHeader('viewer'))).status, 400);
});

// ------------------------------------------------------------------ lifecycle
test('deleting a journey never deletes the monitoring under it', async () => {
  const { serviceTests, app } = fixture();
  const journey = (await newJourney(app)).body;
  await request(app).put(`${BASE}/${journey.id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1 }, { test_id: 2 }] });

  assert.equal((await request(app).delete(`${BASE}/${journey.id}`).set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(app).delete(`${BASE}/${journey.id}`).set('Authorization', authHeader('operator'))).status, 204);

  // A journey is a way of READING tests, not their owner. Deleting the
  // description of a service must not delete the monitoring of it.
  assert.equal(serviceTests.tables.tests.find(1).name, 'Login');
  assert.equal(serviceTests.tables.tests.find(2).name, 'Search Customer');
  assert.equal((await request(app).get(`${BASE}/${journey.id}`).set('Authorization', authHeader('operator'))).status, 404);
});

test('a journey can be renamed and re-rated without touching its steps', async () => {
  const { app } = fixture();
  const journey = (await newJourney(app)).body;
  await request(app).put(`${BASE}/${journey.id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1 }] });

  const saved = await request(app).put(`${BASE}/${journey.id}`).set('Authorization', authHeader('operator'))
    .send({ name: 'Caseworker lookup', criticality: 'critical', expected_duration_ms: 4000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, 'Caseworker lookup');
  assert.equal(saved.body.criticality, 'critical');
  assert.equal(saved.body.step_count, 1, 'a rename must not empty the journey');

  assert.equal((await request(app).put(`${BASE}/${journey.id}`).set('Authorization', authHeader('operator'))
    .send({ criticality: 'urgent' })).status, 400);
});

// ------------------------------------------------------------------ 500
test('a repository failure is a 500 with no detail, not a leak', async () => {
  const { serviceTests } = fixture();
  serviceTests.repositories.journeys.list = async () => {
    throw new Error('SELECT service_test_journeys failed: ECONNREFUSED 10.0.0.5:3306');
  };
  const app = makeApp({ serviceTests });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(app).get(BASE).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assert.ok(!res.text.includes('10.0.0.5'));
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('a test says which journeys depend on it', async () => {
  const { app } = fixture();
  const login = (await newJourney(app, { name: 'Customer login' })).body;
  const lookup = (await newJourney(app, { name: 'Customer lookup' })).body;
  const put = (id, steps) => request(app).put(`${BASE}/${id}/steps`)
    .set('Authorization', authHeader('operator')).send({ steps });
  // Test 1 is step one of BOTH journeys — the normal case, and the reason
  // membership is its own table rather than a column on the test.
  await put(login.id, [{ test_id: 1 }]);
  await put(lookup.id, [{ test_id: 1 }, { test_id: 2 }]);

  const detail = await request(app).get('/api/service-tests/tests/1').set('Authorization', authHeader('viewer'));
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.journeys.map((j) => j.name).sort(), ['Customer login', 'Customer lookup']);

  // A test in no journey says so with an empty list, not a missing field.
  const orphan = await request(app).get('/api/service-tests/tests/3').set('Authorization', authHeader('viewer'));
  assert.deepEqual(orphan.body.journeys, []);
});

// ------------------------------------------------ Discovery → journey (V2 §3)
const SUGGEST = '/api/service-tests/suggestions';

// A discovery that found a login, pages behind it, a logout — and the journey
// suggestion those add up to.
function withSuggestions() {
  const { serviceTests, app } = fixture();
  const t = serviceTests.tables;
  t.discoveries.insert({ application_id: 1, status: 'complete' });
  const step = [{ type: 'open', url: '/login' }];
  const ids = {};
  for (const [name, steps] of [['Login', step], ['Authenticated navigation', step], ['Logout', step]]) {
    ids[name] = t.suggestions.insert({
      discovery_id: 1, application_id: 1, kind: 'test', name, description: `${name} check`,
      confidence: 'medium', reason: 'found it', proposed_steps: steps,
      status: 'proposed', created_test_id: null, created_journey_id: null,
    }).id;
  }
  ids.journey = t.suggestions.insert({
    discovery_id: 1, application_id: 1, kind: 'journey', name: 'Sign in and use the application',
    description: 'An ordinary session.', confidence: 'medium', reason: 'found a login flow',
    proposed_steps: [], status: 'proposed', created_test_id: null, created_journey_id: null,
    proposed_journey: {
      criticality: 'high',
      expected_duration_ms: null,
      steps: [
        { suggestion_name: 'Login', required: true },
        { suggestion_name: 'Authenticated navigation', required: true },
        { suggestion_name: 'Logout', required: false },
      ],
    },
  }).id;
  return { serviceTests, app, ids };
}

test('accepting a journey suggestion creates the tests AND the journey that orders them', async () => {
  const { serviceTests, app, ids } = withSuggestions();
  const before = serviceTests.tables.tests.rows.length;

  const res = await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 201);

  // The whole chain the spec asks for: suggestion → tests → journey.
  assert.equal(res.body.tests.length, 3);
  assert.equal(serviceTests.tables.tests.rows.length, before + 3);
  assert.equal(res.body.journey.name, 'Sign in and use the application');
  assert.equal(res.body.journey.criticality, 'high');
  assert.equal(res.body.suggestion.status, 'accepted');
  assert.equal(res.body.suggestion.created_journey_id, res.body.journey.id);

  // In order, with Logout optional — the shape the heuristic proposed.
  const journey = await request(app).get(`${BASE}/${res.body.journey.id}`).set('Authorization', authHeader('viewer'));
  assert.deepEqual(journey.body.health.steps.map((s) => s.label),
    ['Login', 'Authenticated navigation', 'Logout']);
  assert.deepEqual(journey.body.health.steps.map((s) => s.required), [true, true, false]);

  // Each member's own suggestion is marked accepted too, so it is not offered
  // again beside the journey that already used it.
  for (const name of ['Login', 'Authenticated navigation', 'Logout']) {
    assert.equal(serviceTests.tables.suggestions.find(ids[name]).status, 'accepted');
  }
});

test('a member already accepted is reused, never duplicated', async () => {
  const { serviceTests, app, ids } = withSuggestions();

  // The operator accepted "Login" on its own first — the normal way this goes.
  const solo = await request(app).post(`${SUGGEST}/${ids.Login}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(solo.status, 201);
  const loginTestId = solo.body.test.id;
  const after = serviceTests.tables.tests.rows.length;

  const res = await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 201);

  // Two new tests, not three: a second copy of the same check under a different
  // id is monitoring nobody asked for and history split across two rows.
  assert.equal(serviceTests.tables.tests.rows.length, after + 2);
  assert.ok(res.body.tests.some((t) => t.id === loginTestId), 'the existing Login test must be reused');
  const journey = await request(app).get(`${BASE}/${res.body.journey.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(journey.body.health.steps[0].test_id, loginTestId);
});

test('the operator overrides the proposed criticality in the same request', async () => {
  const { app, ids } = withSuggestions();
  // Criticality is the customer's judgement — the heuristic only proposes.
  const res = await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({ name: 'Caseworker session', criticality: 'critical' });
  assert.equal(res.status, 201);
  assert.equal(res.body.journey.name, 'Caseworker session');
  assert.equal(res.body.journey.criticality, 'critical');
});

test('a journey suggestion is refused rather than half-built', async () => {
  const { serviceTests, app, ids } = withSuggestions();
  // A member suggestion that is gone: refuse before anything is created, rather
  // than leaving the operator a journey missing its middle.
  serviceTests.tables.suggestions.remove(ids['Authenticated navigation']);
  const before = serviceTests.tables.tests.rows.length;

  const res = await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.details.steps, /no longer available/);
  assert.equal(serviceTests.tables.tests.rows.length, before, 'nothing may be created on a refusal');
  assert.equal(serviceTests.tables.suggestions.find(ids.journey).status, 'proposed');
});

test('accepting twice is a 409, and viewers cannot accept at all', async () => {
  const { app, ids } = withSuggestions();
  assert.equal((await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('viewer')).send({})).status, 403);

  assert.equal((await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({})).status, 201);
  const again = await request(app).post(`${SUGGEST}/${ids.journey}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(again.status, 409);
  assert.equal(again.body.status, 'accepted');
});

test('suggestions list journeys first and can be filtered by kind', async () => {
  const { app } = withSuggestions();
  const all = await request(app).get(SUGGEST).set('Authorization', authHeader('viewer'));
  assert.equal(all.status, 200);
  // What the service IS reads before the individual checks that prove it.
  assert.equal(all.body[0].kind, 'journey');

  const onlyJourneys = await request(app).get(`${SUGGEST}?kind=journey`).set('Authorization', authHeader('viewer'));
  assert.equal(onlyJourneys.body.length, 1);
  const onlyTests = await request(app).get(`${SUGGEST}?kind=test`).set('Authorization', authHeader('viewer'));
  assert.equal(onlyTests.body.length, 3);
  assert.equal((await request(app).get(`${SUGGEST}?kind=nonsense`).set('Authorization', authHeader('viewer'))).status, 400);
});

test('a journey suggestion with no steps is refused, not turned into an empty journey', async () => {
  const { serviceTests, app } = withSuggestions();
  const empty = serviceTests.tables.suggestions.insert({
    discovery_id: 1, application_id: 1, kind: 'journey', name: 'Nothing', confidence: 'low',
    proposed_steps: [], proposed_journey: { criticality: 'normal', steps: [] }, status: 'proposed',
  }).id;
  const res = await request(app).post(`${SUGGEST}/${empty}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.details._, /no steps/);
});

test('the bulk "create selected tests" button refuses a journey rather than mangling it', async () => {
  const { serviceTests, app, ids } = withSuggestions();
  const before = serviceTests.tables.tests.rows.length;

  const res = await request(app).post(`${SUGGEST}/accept-many`)
    .set('Authorization', authHeader('operator'))
    .send({ ids: [ids.Login, ids.journey] });

  // The test in the batch is created; the journey is reported back, not silently
  // turned into an empty test from its (deliberately empty) proposed_steps.
  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.failed.length, 1);
  assert.match(res.body.failed[0].error, /on its own/);
  assert.equal(serviceTests.tables.tests.rows.length, before + 1);
  assert.equal(serviceTests.tables.suggestions.find(ids.journey).status, 'proposed');
});

test('accepting a journey never reaches into another application\'s suggestions', async () => {
  const { serviceTests, app } = fixture();
  const t = serviceTests.tables;
  // A journey suggestion with NO discovery — `discoveryId: null` applies no
  // discovery filter, so the member lookup would otherwise match by name across
  // the whole table, and "Login" is the commonest suggestion there is.
  t.suggestions.insert({
    discovery_id: 99, application_id: 2, kind: 'test', name: 'Login',
    description: 'Partner Portal login', confidence: 'high', proposed_steps: [{ type: 'open', url: '/partner' }],
    status: 'proposed', created_test_id: null, created_journey_id: null,
  });
  const orphan = t.suggestions.insert({
    discovery_id: null, application_id: 1, kind: 'journey', name: 'Sign in',
    confidence: 'medium', proposed_steps: [], status: 'proposed',
    proposed_journey: { criticality: 'high', steps: [{ suggestion_name: 'Login', required: true }] },
  }).id;

  const res = await request(app).post(`${SUGGEST}/${orphan}/accept`)
    .set('Authorization', authHeader('operator')).send({});

  // Refused: application 1 has no "Login" test suggestion of its own. The only
  // one in the table belongs to application 2, and borrowing it would create a
  // test in the wrong application and hang it off this journey.
  assert.equal(res.status, 400);
  assert.match(res.body.details.steps, /no longer available/);
  assert.equal(serviceTests.tables.tests.rows.filter((x) => x.application_id === 2).length, 1,
    'no test may be created in the other application');
});

// ------------------------------------------------------------------ run
test('running a journey queues one run per step, in order', async () => {
  const { serviceTests, app } = fixture();
  const id = (await newJourney(app)).body.id;
  await request(app).put(`${BASE}/${id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }, { test_id: 2, required: false }, { test_id: 3, required: true }] });

  const res = await request(app).post(`${BASE}/${id}/run`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 202);
  // A journey owns no steps of its own, so running one is running its members.
  // There is no third kind of run to invent and no new worker protocol.
  assert.deepEqual(res.body.runs.map((r) => r.test_id), [1, 2, 3]);
  assert.deepEqual(res.body.runs.map((r) => r.status), ['queued', 'queued', 'queued']);
  assert.equal(serviceTests.tables.runs.rows.length, 3);
  // Named, so "it is running" is a list of things you can open rather than
  // three opaque ids.
  assert.deepEqual(res.body.runs.map((r) => r.test_name), ['Login', 'Search Customer', 'Logout']);
  assert.ok('worker' in res.body, 'a queued run with no worker must read as configuration, not a hang');
});

test('a journey run uses the journey\'s own environment unless told otherwise', async () => {
  const { serviceTests, app } = fixture();
  const id = (await newJourney(app, { environment_id: 1 })).body.id;
  await request(app).put(`${BASE}/${id}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }] });

  await request(app).post(`${BASE}/${id}/run`).set('Authorization', authHeader('operator')).send({});
  assert.equal(serviceTests.tables.runs.rows[0].environment_id, 1, 'the journey\'s environment was ignored');
});

test('running a journey answers 400/403/404 and never 500', async () => {
  const { app } = fixture();
  const empty = (await newJourney(app, { name: 'Nothing in it' })).body.id;

  // A journey with no steps has nothing to run, and says so rather than
  // answering 202 with an empty list.
  const none = await request(app).post(`${BASE}/${empty}/run`).set('Authorization', authHeader('operator')).send({});
  assert.equal(none.status, 400);
  assert.match(none.body.details._, /nothing to run/);

  await request(app).put(`${BASE}/${empty}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }] });

  for (const bad of ['abc', '-1', '0', '1.5']) {
    const res = await request(app).post(`${BASE}/${bad}/run`).set('Authorization', authHeader('operator')).send({});
    assert.ok([400, 404].includes(res.status), `${bad} → ${res.status}`);
  }
  assert.equal((await request(app).post(`${BASE}/99999/run`).set('Authorization', authHeader('operator')).send({})).status, 404);

  // Another application's environment would make the run a statement about the
  // wrong service.
  const wrongEnv = await request(app).post(`${BASE}/${empty}/run`)
    .set('Authorization', authHeader('operator')).send({ environment_id: 2 });
  assert.equal(wrongEnv.status, 400);
  assert.match(wrongEnv.body.details.environment_id, /does not belong to this application/);

  assert.equal((await request(app).post(`${BASE}/${empty}/run`).set('Authorization', authHeader('viewer')).send({})).status, 403);
  assert.equal((await request(app).post(`${BASE}/${empty}/run`).send({})).status, 401);
});

// ------------------------------------------------------------------ edit
test('a journey can be renamed and re-graded after it exists', async () => {
  const { app } = fixture();
  const id = (await newJourney(app, { criticality: 'normal' })).body.id;
  const res = await request(app).put(`${BASE}/${id}`).set('Authorization', authHeader('operator'))
    .send({ name: 'Caseworker sign-in', description: 'They cannot work without it', criticality: 'critical', expected_duration_ms: 8000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Caseworker sign-in');
  assert.equal(res.body.criticality, 'critical');
  assert.equal(res.body.expected_duration_ms, 8000);

  // Cleared means "no expectation stated" — a different fact from an
  // expectation of zero, so no duration verdict is produced at all.
  const cleared = await request(app).put(`${BASE}/${id}`).set('Authorization', authHeader('operator'))
    .send({ expected_duration_ms: null });
  assert.equal(cleared.body.expected_duration_ms, null);
  assert.equal(cleared.body.duration, null);
});

// ------------------------------------------------ accepting over a duplicate
// Seeds an application-1 journey suggestion whose members are "Login" and
// "Authenticated navigation", plus the test suggestions it names.
function seedJourneySuggestion(serviceTests, names = ['Login', 'Authenticated navigation']) {
  const t = serviceTests.tables;
  for (const name of names) {
    t.suggestions.insert({
      discovery_id: 1, application_id: 1, kind: 'test', name,
      confidence: 'high', proposed_steps: [{ type: 'open', url: '/login' }],
      status: 'proposed', created_test_id: null, created_journey_id: null,
    });
  }
  return t.suggestions.insert({
    discovery_id: 1, application_id: 1, kind: 'journey', name: 'Sign in and use the application',
    confidence: 'medium', proposed_steps: [], status: 'proposed',
    proposed_journey: { criticality: 'high', steps: names.map((n) => ({ suggestion_name: n, required: true })) },
  }).id;
}

test('accepting a suggestion that duplicates an existing journey refuses once and says what it found', async () => {
  const { serviceTests, app } = fixture();
  // The operator already built this by hand — which is exactly what has
  // happened the first time anyone runs discovery on a service they monitor.
  const mine = (await newJourney(app, { name: 'Fellis run for About Fellis' })).body.id;
  await request(app).put(`${BASE}/${mine}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }] }); // test 1 is named "Login"

  const sid = seedJourneySuggestion(serviceTests);
  const res = await request(app).post(`${SUGGEST}/${sid}/accept`)
    .set('Authorization', authHeader('operator')).send({});

  assert.equal(res.status, 409);
  const [overlap] = res.body.overlaps;
  assert.equal(overlap.journey_id, mine);
  assert.deepEqual(overlap.already_covers, ['Login']);
  assert.deepEqual(overlap.would_add, ['Authenticated navigation']);
  // Refused means refused: nothing was built while the question is open.
  assert.equal(serviceTests.tables.journeys.rows.length, 1, 'a journey was created despite the refusal');
});

test('merging adds only the missing steps, and keeps the operator\'s ordering', async () => {
  const { serviceTests, app } = fixture();
  const mine = (await newJourney(app, { name: 'Mine' })).body.id;
  await request(app).put(`${BASE}/${mine}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 3, required: true }, { test_id: 1, required: true }] }); // Logout, then Login

  const sid = seedJourneySuggestion(serviceTests);
  const res = await request(app).post(`${SUGGEST}/${sid}/accept`)
    .set('Authorization', authHeader('operator')).send({ merge_into_journey_id: mine });

  assert.equal(res.status, 200);
  assert.equal(res.body.merged, true);
  assert.equal(res.body.added_steps, 1);
  assert.equal(serviceTests.tables.journeys.rows.length, 1, 'merging must not also create a journey');

  const after = (await request(app).get(`${BASE}/${mine}`).set('Authorization', authHeader('viewer'))).body;
  // The operator's order is preserved and the new step appended. Re-sorting
  // their journey to match a heuristic's idea would be a much ruder act.
  assert.deepEqual(after.health.steps.map((s) => s.label), ['Logout', 'Login', 'Authenticated navigation']);

  // The suggestion is now handled, and points at the journey it was folded into.
  const suggestion = serviceTests.tables.suggestions.find(sid);
  assert.equal(suggestion.status, 'accepted');
  assert.equal(suggestion.created_journey_id, mine);
});

test('confirming creates the second journey deliberately', async () => {
  const { serviceTests, app } = fixture();
  const mine = (await newJourney(app, { name: 'Mine' })).body.id;
  await request(app).put(`${BASE}/${mine}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }] });

  const sid = seedJourneySuggestion(serviceTests);
  const res = await request(app).post(`${SUGGEST}/${sid}/accept`)
    .set('Authorization', authHeader('operator')).send({ confirm: true });

  assert.equal(res.status, 201);
  assert.equal(serviceTests.tables.journeys.rows.length, 2);
  assert.notEqual(res.body.journey.id, mine);
});

test('with no overlapping journey the accept is unchanged — no confirmation asked for', async () => {
  const { serviceTests, app } = fixture();
  const sid = seedJourneySuggestion(serviceTests);
  const res = await request(app).post(`${SUGGEST}/${sid}/accept`)
    .set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 201, 'a first journey must not have to be confirmed');
  assert.equal(res.body.tests.length, 2);
});

test('merging validates its target: 400 for junk, 404 for absent, 400 across applications', async () => {
  const { serviceTests, app } = fixture();
  const mine = (await newJourney(app, { name: 'Mine' })).body.id;
  await request(app).put(`${BASE}/${mine}/steps`).set('Authorization', authHeader('operator'))
    .send({ steps: [{ test_id: 1, required: true }] });
  const other = (await post(app, { application_id: 2, name: 'Partner journey' })).body.id;

  const send = (body) => request(app).post(`${SUGGEST}/${seedJourneySuggestion(serviceTests)}/accept`)
    .set('Authorization', authHeader('operator')).send(body);

  for (const bad of ['abc', -1, 0, 1.5]) {
    const res = await send({ merge_into_journey_id: bad });
    assert.equal(res.status, 400, `${bad} → ${res.status}`);
  }
  assert.equal((await send({ merge_into_journey_id: 99999 })).status, 404);
  // A journey is about ONE service; merging across applications would make its
  // verdict a statement about something else.
  const cross = await send({ merge_into_journey_id: other });
  assert.equal(cross.status, 400);
  assert.match(cross.body.details.merge_into_journey_id, /different application/);
});
