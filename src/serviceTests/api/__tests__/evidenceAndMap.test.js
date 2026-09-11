'use strict';

// HTTP specs for performance baselines (§9), evidence (§10) and the service
// map (§11).
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 on every route, never 500.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const RUNS = '/api/service-tests/runs';
const MAP = '/api/service-tests/map';
const DEF = { version: 1, steps: [{ type: 'open', url: '/login' }] };

function fixture() {
  const serviceTests = makeServiceTests({
    tests: [
      { application_id: 1, name: 'Login', definition: DEF, version: 1, enabled: 1 },
      { application_id: 1, name: 'Availability', definition: DEF, version: 1, enabled: 1 },
    ],
  });
  return { serviceTests, app: makeApp({ serviceTests }) };
}

const addRun = (st, over = {}) => st.tables.runs.insert({
  test_id: 1, status: 'pass', duration_ms: 870, started_at: new Date(), ended_at: new Date(),
  steps: [], api_calls: [], console_errors: [], network_errors: [], ...over,
});

// ------------------------------------------------------------------ 401 / 403
test('evidence and the map are licence-gated and readable by viewers', async () => {
  const { serviceTests, app } = fixture();
  const run = addRun(serviceTests);

  assert.equal((await request(app).get(`${RUNS}/${run.id}/evidence`)).status, 401);
  assert.equal((await request(app).get(`${MAP}?application_id=1`)).status, 401);

  // Reading what happened is not a privileged act — it is the point.
  assert.equal((await request(app).get(`${RUNS}/${run.id}/evidence`).set('Authorization', authHeader('viewer'))).status, 200);
  assert.equal((await request(app).get(`${MAP}?application_id=1`).set('Authorization', authHeader('viewer'))).status, 200);

  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });
  assert.equal((await request(unlicensed).get(`${MAP}?application_id=1`).set('Authorization', authHeader('admin'))).status, 403);
});

// ------------------------------------------------------------------ 400 / 404
test('a missing or malformed id is 400/404, never 500', async () => {
  const { app } = fixture();
  const h = authHeader('viewer');
  assert.equal((await request(app).get(`${RUNS}/999999/evidence`).set('Authorization', h)).status, 404);
  assert.equal((await request(app).get(`${MAP}`).set('Authorization', h)).status, 400);
  assert.equal((await request(app).get(`${MAP}?application_id=abc`).set('Authorization', h)).status, 400);
  assert.equal((await request(app).get(`${MAP}?application_id=999999`).set('Authorization', h)).status, 404);

  for (const id of ['abc', '1;DROP', '-1', '1e309', '%00']) {
    assert.ok((await request(app).get(`${RUNS}/${id}/evidence`).set('Authorization', h)).status < 500, `id=${id}`);
    assert.ok((await request(app).get(`${MAP}?application_id=${id}`).set('Authorization', h)).status < 500, `app=${id}`);
  }
});

// ------------------------------------------------------------- §9 baselines
test('a run says what its duration means against the test\'s own history', async () => {
  const { serviceTests, app } = fixture();
  for (const d of [820, 910, 870, 880, 840, 900, 860]) addRun(serviceTests, { duration_ms: d });
  const slow = addRun(serviceTests, { duration_ms: 4700 });

  const res = await request(app).get(`${RUNS}/${slow.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.performance.verdict, 'slow');
  assert.equal(res.body.performance.baseline.samples, 7);
  assert.match(res.body.performance.reason, /4\.7 s/);
});

test('the run being judged is not part of the history it is judged against', async () => {
  const { serviceTests, app } = fixture();
  for (const d of [800, 800, 800, 800, 800]) addRun(serviceTests, { duration_ms: d });
  const slow = addRun(serviceTests, { duration_ms: 5000 });

  const res = await request(app).get(`${RUNS}/${slow.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.performance.baseline.samples, 5, 'six passing runs, five of them history');
  assert.equal(res.body.performance.baseline.median, 800, 'the slow run must not drag its own baseline up');
  assert.equal(res.body.performance.verdict, 'slow');
});

test('a failing run never enters a baseline', async () => {
  const { serviceTests, app } = fixture();
  // A failure's duration is the duration of a failure — a timeout burns the
  // whole budget, a crash finishes instantly — and either would make "normal" a
  // description of how the test breaks.
  for (let i = 0; i < 6; i += 1) addRun(serviceTests, { duration_ms: 30000, status: 'fail' });
  for (const d of [800, 810, 790, 805, 795]) addRun(serviceTests, { duration_ms: d });
  const current = addRun(serviceTests, { duration_ms: 820 });

  const res = await request(app).get(`${RUNS}/${current.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.performance.baseline.samples, 5);
  assert.ok(res.body.performance.baseline.median < 1000);
  assert.equal(res.body.performance.verdict, 'normal');
});

test('too little history is reported as unknown, not as normal', async () => {
  const { serviceTests, app } = fixture();
  addRun(serviceTests, { duration_ms: 800 });
  const current = addRun(serviceTests, { duration_ms: 9000 });
  const res = await request(app).get(`${RUNS}/${current.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.performance.verdict, 'unknown');
  assert.match(res.body.performance.reason, /not enough/);
});

// -------------------------------------------------------------- §10 evidence
test('evidence gathers the observations of one run', async () => {
  const { serviceTests, app } = fixture();
  const run = addRun(serviceTests, {
    status: 'fail',
    duration_ms: 4700,
    failure_kind: 'http_5xx',
    error_message: 'The server rejected the request.',
    screenshot_path: 'runs/1.webp',
    console_errors: ['TypeError: x'],
    api_calls: [
      { method: 'GET', url: 'https://api.kunde.dk/customers', status: 500, duration_ms: 2100, resource_type: 'fetch' },
      { method: 'GET', url: 'https://cdn.kunde.dk/logo.png', status: 200, duration_ms: 9, resource_type: 'image' },
    ],
    steps: [
      { position: 0, step_type: 'open', label: 'Open /login', status: 'pass', duration_ms: 600, detail: { url: 'https://kunde.dk/login' } },
      { position: 1, step_type: 'click', label: 'Click "Log ind"', status: 'fail', duration_ms: 3000, detail: { url: 'https://kunde.dk/login', target: { role: 'button', name: 'Log ind' } } },
    ],
  });

  const res = await request(app).get(`${RUNS}/${run.id}/evidence`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.run.id, run.id);
  assert.equal(res.body.page.url, 'https://kunde.dk/login');
  assert.equal(res.body.page.failure_kind, 'http_5xx');
  assert.equal(res.body.api.total, 1, 'the image is not evidence');
  assert.equal(res.body.api.failed, 1);
  assert.match(res.body.failures.step.target_label, /Log ind/);
  assert.equal(res.body.screenshot.available, true);
  // Performance rides along as metadata on the result.
  assert.ok(res.body.timings.baseline);
  assert.equal(res.body.timings.total_label, '4.7 s');
});

test('evidence carries no secrets, because it reads only already-masked columns', async () => {
  const { serviceTests, app } = fixture();
  const run = addRun(serviceTests, {
    status: 'fail',
    api_calls: [{ method: 'POST', url: 'https://api.kunde.dk/login?token=REDACTED', status: 200, resource_type: 'xhr' }],
    steps: [{ position: 0, step_type: 'fill', label: 'Fill Kodeord', status: 'pass', duration_ms: 20, target: { label: 'Kodeord' } }],
  });
  const res = await request(app).get(`${RUNS}/${run.id}/evidence`).set('Authorization', authHeader('viewer'));
  const text = JSON.stringify(res.body).toLowerCase();
  for (const key of ['"password"', '"token"', '"cookie"', '"authorization"', '"secret"']) {
    assert.ok(!text.includes(key), `evidence carries a ${key} field`);
  }
  assert.ok(res.body.api.calls[0].url.includes('REDACTED'), 'the mask survives rather than the value');
});

// ------------------------------------------------------------------- §11 map
test('the map is built from observations and says so', async () => {
  const { serviceTests, app } = fixture();
  const journey = serviceTests.tables.journeys.insert({
    application_id: 1, name: 'Customer login', criticality: 'high', enabled: 1,
  });
  serviceTests.tables.journeySteps.insert({ journey_id: journey.id, test_id: 1, position: 0, required: 1, label: null });
  addRun(serviceTests, {
    steps: [{ position: 0, detail: { url: 'https://kunde.dk/login' } }],
    api_calls: [
      { method: 'POST', url: 'https://api.kunde.dk/auth/login', status: 200 },
      { method: 'GET', url: 'https://api.kunde.dk/customers/4711', status: 500 },
    ],
  });

  const res = await request(app).get(`${MAP}?application_id=1`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.application.name, 'Customer Portal');
  assert.equal(res.body.counts.journeys, 1);
  assert.equal(res.body.counts.endpoints, 2);
  assert.equal(res.body.counts.failing_endpoints, 1);
  // The second test has no runs and no journey — it is still monitoring that
  // exists, so hiding it would make the map lie by omission.
  assert.ok(res.body.counts.tests >= 1);
  assert.match(res.body.observed_from.note, /Nothing here is inferred/);
});

test('an application with nothing observed yields an empty map, not an error', async () => {
  const { app } = fixture();
  const res = await request(app).get(`${MAP}?application_id=1`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.journeys, 0);
  assert.equal(res.body.counts.endpoints, 0);
  assert.equal(res.body.counts.pages, 0);
});

test('the map is read-only: there is no way to add to it by hand', async () => {
  // The moment it can be edited it is a CMDB, which is what the spec says it
  // must not become.
  const { app } = fixture();
  for (const method of ['post', 'put', 'patch', 'delete']) {
    const res = await request(app)[method](MAP).set('Authorization', authHeader('admin')).send({});
    assert.ok(res.status === 404 || res.status === 405, `${method} ${MAP} → ${res.status}`);
  }
});

// ------------------------------------------------------------------ 500
test('a repository failure is a 500 with no detail, not a leak', async () => {
  const { serviceTests } = fixture();
  serviceTests.repositories.runs.baselineSamples = async () => {
    throw new Error('SELECT service_test_runs failed: ECONNREFUSED 10.0.0.5:3306');
  };
  const run = addRun(serviceTests);
  const app = makeApp({ serviceTests });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(app).get(`${RUNS}/${run.id}/evidence`).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assert.ok(!res.text.includes('10.0.0.5'));
  } finally {
    process.env.NODE_ENV = prev;
  }
});
