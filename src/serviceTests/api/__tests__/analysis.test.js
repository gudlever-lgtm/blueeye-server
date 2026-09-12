'use strict';

// HTTP specs for the V3 intelligence layer.
//
// The whole layer shipped as pure modules with 130-odd tests and no way to reach
// any of it. These are about the other half: that the routes exist, that they
// assemble the right inputs, that they answer 400/403/404 rather than 500, and
// that the analysis they return is the one the pure module would have produced.
//
// The last of those is the one worth writing. A route that calls the right
// function with the wrong shape returns a cheerful, empty, wrong answer — which
// is exactly what happened here first: the health route handed assessService a
// list of observations where it wanted a layer summary, and it silently saw
// nothing at all.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');
const { HEALTH } = require('../../health/serviceHealth');

const BASE = '/api/service-tests/analysis';

function withData(build) {
  const st = makeServiceTests();
  const ready = build ? build(st) : Promise.resolve();
  return { st, app: makeApp({ serviceTests: st }), ready };
}

const get = (app, path, role = 'admin') =>
  request(app).get(`${BASE}${path}`).set('Authorization', authHeader(role));

// A failing run with a 500 from one endpoint and another answering fine — the
// shape that should come back as "one API endpoint", not "the application".
async function seedFailingRun(st) {
  const run = await st.repositories.runs.enqueue({ test_id: 1 });
  await st.repositories.runs.complete(run.id, {
    status: 'fail',
    duration_ms: 4200,
    failure_kind: 'http_500',
    error_message: 'GET /api/search returned 500',
    api_calls: [
      { url: 'https://customer.example.com/api/search', method: 'GET', status: 500, duration_ms: 812 },
      { url: 'https://customer.example.com/api/me', method: 'GET', status: 200, duration_ms: 90 },
    ],
    console_errors: [],
    network_errors: [],
    steps: [{ position: 0, label: 'Search', status: 'fail', message: 'HTTP 500', duration_ms: 4000 }],
  });
  return run;
}

// ---------------------------------------------------------------- one run
test('a run’s analysis names a layer, ranks causes, and shows the evidence', async () => {
  const { st, app, ready } = withData();
  await ready;
  const run = await seedFailingRun(st);

  const res = await get(app, `/runs/${run.id}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.observations.length, 'no observations came back');
  assert.ok(res.body.correlation, 'nothing was correlated');
  assert.equal(res.body.correlation.layer, 'api');
  assert.match(res.body.correlation_summary, /Likely an application or API problem/);

  // And the ranking underneath it. One endpoint failing while its neighbour
  // answers is narrower than the tier being down, and the route has to pass
  // enough through for the pure module to see that.
  assert.equal(res.body.root_cause.top.cause, 'api');
  assert.ok(res.body.root_cause.top.why.length, 'a ranking with no evidence is a number to argue with');
});

test('a passing run is not given a diagnosis it does not need', async () => {
  // Nothing is concluded from nothing. An analysis of a healthy run that
  // returned a cheerful "all fine" would be a finding nobody asked for.
  const { st, app, ready } = withData();
  await ready;
  const run = await st.repositories.runs.enqueue({ test_id: 1 });
  await st.repositories.runs.complete(run.id, { status: 'pass', duration_ms: 900, steps: [], api_calls: [] });

  const res = await get(app, `/runs/${run.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.correlation, null);
  assert.equal(res.body.root_cause, null);
});

test('a run from before observations were stored is still analysable', async () => {
  // Every run that exists today has no stored observations. A "Why did this
  // fail?" that answers "no data" on last week's outage is worse than not having
  // the button at all.
  const { st, app, ready } = withData();
  await ready;
  const run = await seedFailingRun(st);
  st.tables.observations.rows.length = 0;

  const res = await get(app, `/runs/${run.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.observations_from, 'derived', 'and it says which it is');
  assert.ok(res.body.observations.length);
  assert.ok(res.body.correlation);
});

test('an unknown or malformed run id is 404 / 400, never 500', async () => {
  const { app, ready } = withData();
  await ready;
  assert.equal((await get(app, '/runs/999999')).status, 404);
  assert.equal((await get(app, '/runs/not-a-number')).status, 400);
  assert.equal((await get(app, '/runs/-1')).status, 400);
});

// ----------------------------------------------------------- one incident
test('an incident that has happened before says so, with the occurrences', async () => {
  const { st, app, ready } = withData();
  await ready;
  const base = {
    application_id: 1, subject_type: 'test', subject_key: 'test:1',
    subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
    summary: 'HTTP 500', explanation: 'x', evidence: [],
  };
  for (let i = 0; i < 3; i += 1) {
    const at = new Date(Date.UTC(2026, 7, 3 + i * 7, 9, 0, 0));
    // eslint-disable-next-line no-await-in-loop
    const opened = await st.repositories.incidents.open({ ...base, at });
    // eslint-disable-next-line no-await-in-loop
    await st.repositories.incidents.resolve(opened.id, { at: new Date(at.getTime() + 3600000) });
  }
  const current = await st.repositories.incidents.open({ ...base, at: new Date(Date.UTC(2026, 7, 24, 9, 0, 0)) });

  const res = await get(app, `/incidents/${current.id}/recurrence`);
  assert.equal(res.status, 200);
  assert.ok(res.body.recurrence, 'four identical incidents is a recurrence');
  assert.equal(res.body.recurrence.occurrences, 4);
  assert.match(res.body.recurrence.summary, /Similar incidents detected/);
  assert.equal(res.body.recurrence.rhythm.kind, 'weekly');
});

test('a first-time incident returns null rather than an empty report', async () => {
  // Most incidents are not recurrences. An empty report dressed up as a finding
  // would make the ones that matter invisible.
  const { st, app, ready } = withData();
  await ready;
  const only = await st.repositories.incidents.open({
    application_id: 1, subject_type: 'test', subject_key: 'test:9', subject_label: 'x',
    kind: 'timeout', severity: 'WARN', summary: 'y', explanation: 'z', evidence: [],
  });
  const res = await get(app, `/incidents/${only.id}/recurrence`);
  assert.equal(res.status, 200);
  assert.equal(res.body.recurrence, null);
});

test('an unknown incident is 404', async () => {
  const { app, ready } = withData();
  await ready;
  assert.equal((await get(app, '/incidents/999999/recurrence')).status, 404);
  assert.equal((await get(app, '/incidents/nope/recurrence')).status, 400);
});

// -------------------------------------------------------- one application
test('dependencies read the same map the Service Map screen draws', async () => {
  const { st, app, ready } = withData();
  await ready;
  const res = await get(app, '/applications/1/dependencies');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.shared));
  assert.ok(Array.isArray(res.body.failing));
  assert.ok(res.body.counts, 'the denominators are the point — "5 of 6" and "5 of 40" differ');
  assert.equal(res.body.source, 'rules');
});

test('health comes back as a number with its parts, or as unknown with a reason', async () => {
  const { st, app, ready } = withData();
  await ready;
  await seedFailingRun(st);

  const res = await get(app, '/applications/1/health');
  assert.equal(res.status, 200);
  assert.ok(res.body.status, 'no status');
  assert.ok(res.body.reason, 'a status with no reason is what V3 exists to replace');
  assert.ok(res.body.parts, 'a score without its parts is the black box the spec forbids');
  for (const part of ['functional', 'availability', 'api', 'performance']) {
    assert.ok(res.body.parts[part], `the ${part} part is missing`);
    assert.ok(res.body.parts[part].reason, `the ${part} part says nothing about why`);
  }
  assert.ok(res.body.weights, 'the weights are published or the number is a black box');
  assert.ok(res.body.layers, 'the layer summary is what the score is built from');
  assert.ok(res.body.observed_from.window_hours, 'the window has to be on the response');
});

test('a failing critical journey makes the service FAILED, not unknown', async () => {
  // The shape bug this catches: assessService reads `j.health`, and a journey
  // handed over with `status` instead is not an error — it reads as UNKNOWN, so
  // the one thing the score exists to notice stops counting.
  const { st, app, ready } = withData();
  await ready;
  const journey = await st.repositories.journeys.create({
    application_id: 1, name: 'Find customer', criticality: 'critical',
  });
  await st.repositories.journeys.setSteps(journey.id, [{ test_id: 1, required: true, label: 'Search' }]);
  const run = await seedFailingRun(st);
  assert.ok(run.id);

  const res = await get(app, '/applications/1/health');
  assert.equal(res.status, 200);
  // The module's own constants, not literals: the journey verdict is lowercase
  // ('failed') and the service verdict is uppercase ('FAILED'), and hard-coding
  // either is a spec that breaks on a rename rather than on a regression.
  assert.equal(res.body.parts.functional.status, HEALTH.FAILED, res.body.parts.functional.reason);
  assert.equal(res.body.status, HEALTH.FAILED);
  assert.match(res.body.reason, /Find customer/);
});

test('open incidents are counted, not handed over as rows', async () => {
  // `Number([])` is 0 and `Number([x])` is NaN, so passing the array reads as
  // "no open incidents" either way — a silently wrong zero on the one number an
  // operator looks at first.
  const { st, app, ready } = withData();
  await ready;
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await st.repositories.incidents.open({
      application_id: 1, subject_type: 'test', subject_key: `test:${i}`, subject_label: 'x',
      kind: 'http_500', severity: 'CRIT', summary: 'y', explanation: 'z', evidence: [],
    });
  }
  const res = await get(app, '/applications/1/health');
  assert.equal(res.body.open_incidents, 2);
});

test('the health window is bounded however large a number is asked for', async () => {
  // An unbounded window reads the whole observation table, which is the largest
  // in the module — on a page somebody opens while something is already wrong.
  const { app, ready } = withData();
  await ready;
  const huge = await get(app, '/applications/1/health?hours=999999');
  assert.equal(huge.status, 200);
  assert.equal(huge.body.observed_from.window_hours, 24 * 30);

  const silly = await get(app, '/applications/1/health?hours=0');
  assert.equal(silly.body.observed_from.window_hours, 24, 'a nonsense window falls back rather than to zero');
});

test('an unknown application is 404 on every application route', async () => {
  const { app, ready } = withData();
  await ready;
  for (const path of ['/applications/999999/dependencies', '/applications/999999/health']) {
    assert.equal((await get(app, path)).status, 404, path);
  }
  for (const path of ['/applications/nope/dependencies', '/applications/nope/health']) {
    assert.equal((await get(app, path)).status, 400, path);
  }
});

// --------------------------------------------------------------- one test
test('anomalies come back with the thresholds that decided them', async () => {
  const { st, app, ready } = withData();
  await ready;
  const res = await get(app, '/tests/1/anomalies');
  assert.equal(res.status, 200);
  assert.ok(res.body.failure_rate, 'no failure-rate finding');
  assert.ok(res.body.failure_rate.thresholds, '"why did this not fire" must always have an answer');
  assert.ok(res.body.duration, 'no duration finding');
  assert.ok(Array.isArray(res.body.anomalies));
});

test('an unknown test is 404', async () => {
  const { app, ready } = withData();
  await ready;
  assert.equal((await get(app, '/tests/999999/anomalies')).status, 404);
  assert.equal((await get(app, '/tests/nope/anomalies')).status, 400);
});

// ------------------------------------------------------------------- RBAC
test('the whole layer is readable by a viewer and writable by nobody', async () => {
  const { st, app, ready } = withData();
  await ready;
  const run = await seedFailingRun(st);
  for (const path of [`/runs/${run.id}`, '/applications/1/dependencies', '/applications/1/health', '/tests/1/anomalies']) {
    assert.equal((await get(app, path, 'viewer')).status, 200, `GET ${path}`);
  }
  // An analysis that can be edited is an analysis nobody can trust, so there is
  // no route to edit one.
  for (const path of [`/runs/${run.id}`, '/applications/1/health']) {
    const res = await request(app).post(`${BASE}${path}`).set('Authorization', authHeader('admin')).send({});
    assert.equal(res.status, 404, `POST ${path} should not exist`);
  }
});

test('an anonymous caller gets 401, not an analysis', async () => {
  const { app, ready } = withData();
  await ready;
  assert.equal((await request(app).get(`${BASE}/applications/1/health`)).status, 401);
});
