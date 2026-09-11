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
