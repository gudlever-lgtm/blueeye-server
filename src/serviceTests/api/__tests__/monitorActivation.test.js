'use strict';

// The activation gate, and the availability series.
//
// The gate exists because of one specific way this feature could annoy people:
// a new monitor used to be due the moment it was saved, so a mistyped mail
// server failed every interval and opened an incident — an operator finding out
// about their own typo as an outage. A monitor now watches nothing until it has
// worked once.
//
// The half that is easy to get wrong is the override. Without it the gate is a
// trap: a service that is down when you create the monitor could never be
// watched, which is precisely when you want it watched.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/monitors';

const TCP = {
  name: 'Mail port',
  type: 'tcp_port',
  interval_sec: 300,
  config: { host: 'mail.example.com', port: 25 },
};

const fixture = (over = {}) => {
  const serviceTests = makeServiceTests(over);
  return { serviceTests, app: makeApp({ serviceTests }) };
};
const op = (app, method, path) => request(app)[method](BASE + path).set('Authorization', authHeader('operator'));

async function create(app, body = TCP) {
  const res = await op(app, 'post', '').send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// ------------------------------------------------------------------ the gate
test('a new monitor is pending, and the sweep leaves it alone', async () => {
  const { app, serviceTests } = fixture();
  const created = await create(app);
  assert.equal(created.pending, true);
  assert.equal(created.activated_at, null);

  const swept = await serviceTests.reactor.sweepMonitors();
  assert.equal(swept.checked, 0, 'a pending monitor was swept');
  assert.equal(serviceTests.tables.monitorResults.rows.length, 0);
});

test('the first working check opens the gate, and the monitor is swept from then on', async () => {
  const { app, serviceTests } = fixture();
  const created = await create(app);

  const checked = await op(app, 'post', `/${created.id}/check`);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.result.status, 'ok');
  assert.equal(checked.body.monitor.pending, false, 'a working check did not activate it');
  assert.ok(checked.body.monitor.activated_at, 'nothing recorded when it started being watched');

  // Due again by its interval, and now the sweep takes it.
  serviceTests.tables.monitors.rows[0].last_run_at = new Date(Date.now() - 3600000);
  const swept = await serviceTests.reactor.sweepMonitors();
  assert.equal(swept.checked, 1);
});

test('a check that is merely SLOW still counts as working — the exchange completed', async () => {
  const { app, serviceTests } = fixture({
    monitor_results: { 'Mail port': { status: 'slow', kind: 'monitor_slow', summary: 'over the limit', value: 9000, unit: 'ms', duration_ms: 9000 } },
  });
  const created = await create(app);
  const checked = await op(app, 'post', `/${created.id}/check`);
  assert.equal(checked.body.result.status, 'slow');
  assert.equal(checked.body.monitor.pending, false);
  assert.equal(serviceTests.tables.incidents.rows.length, 0, 'the first slow check opened an incident');
});

test('while pending, a failing check records the result and opens NOTHING', async () => {
  const { app, serviceTests } = fixture({
    monitor_results: { 'Mail port': { status: 'unreachable', kind: 'monitor_unreachable', summary: 'connect ECONNREFUSED', duration_ms: 20 } },
  });
  const created = await create(app);

  // Three failing checks in a row — past any failure streak.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await op(app, 'post', `/${created.id}/check`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'pending', 'a pending monitor reported a state it should not have');
    assert.equal(res.body.incident, null);
  }
  assert.equal(serviceTests.tables.incidents.rows.length, 0, 'setting a monitor up opened an incident');
  assert.equal(serviceTests.notifications.length, 0, 'setting a monitor up woke somebody');
  // The results ARE stored: they are how an operator sees why it will not start.
  assert.equal(serviceTests.tables.monitorResults.rows.length, 3);
  assert.equal(serviceTests.tables.monitors.rows[0].last_status, 'unreachable');
  assert.equal((await serviceTests.repositories.monitors.findById(created.id)).pending, true);
});

test('the override activates a monitor whose service is down, which is when you most want it', async () => {
  const { app, serviceTests } = fixture({
    monitor_results: { 'Mail port': { status: 'unreachable', kind: 'monitor_unreachable', summary: 'connect ECONNREFUSED', duration_ms: 20 } },
  });
  const created = await create(app);

  const activated = await op(app, 'post', `/${created.id}/activate`);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.pending, false);

  // Now it behaves like any other monitor: the streak opens an incident.
  await op(app, 'post', `/${created.id}/check`);
  const second = await op(app, 'post', `/${created.id}/check`);
  assert.equal(second.body.state, 'opened');
  assert.equal(serviceTests.tables.incidents.rows.length, 1);
});

test('activation is idempotent and keeps the date it FIRST started watching', async () => {
  const { app } = fixture();
  const created = await create(app);
  const first = await op(app, 'post', `/${created.id}/activate`);
  const again = await op(app, 'post', `/${created.id}/activate`);
  assert.equal(again.status, 200);
  assert.equal(String(again.body.activated_at), String(first.body.activated_at), '"watching since" moved');
});

test('activate answers 400/403/404 like every other write', async () => {
  const { app } = fixture();
  const created = await create(app);
  assert.equal((await request(app).post(`${BASE}/${created.id}/activate`)).status, 401);
  assert.equal((await request(app).post(`${BASE}/${created.id}/activate`).set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await op(app, 'post', '/abc/activate')).status, 400);
  assert.equal((await op(app, 'post', '/999/activate')).status, 404);

  const serviceTests = makeServiceTests();
  serviceTests.repositories.monitors.activate = async () => { throw new Error('simulated database failure'); };
  const broken = makeApp({ serviceTests });
  const made = await create(broken);
  const res = await request(broken).post(`${BASE}/${made.id}/activate`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

// ------------------------------------------------------------------ series
test('the series answers availability per bucket, with the empty ones kept', async () => {
  const { app, serviceTests } = fixture();
  const created = await create(app);
  const now = Date.now();
  const add = (status, value, minutesAgo) => serviceTests.tables.monitorResults.insert({
    monitor_id: created.id,
    status,
    kind: null,
    duration_ms: value,
    value,
    unit: 'ms',
    summary: status,
    timings: null,
    detail: null,
    trigger_source: 'schedule',
    checked_at: new Date(now - minutesAgo * 60000),
  });
  add('ok', 100, 10);
  add('ok', 120, 20);
  add('failed', null, 30);
  add('slow', 9000, 40);

  const res = await request(app).get(`${BASE}/${created.id}/series?period=day&tz_offset=0`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.monitor_id, created.id);
  assert.equal(res.body.bucket, 'hour');
  assert.equal(res.body.buckets.length, 24, 'a day is drawn in 24 hours, empty ones included');
  assert.equal(res.body.unit, 'ms', 'the axis has no label');

  const measured = res.body.buckets.filter((b) => b.checks > 0);
  assert.ok(measured.length >= 1);
  const totals = measured.reduce((acc, b) => acc + b.checks, 0);
  assert.equal(totals, 4);
  // ok + slow are available; failed is not. Three of four checks worked.
  assert.equal(Math.round(res.body.total.availability * 100), 75);
  assert.equal(res.body.total.checks, 4);

  // An empty bucket reports null availability, never 0% — "nothing ran" and
  // "everything failed" are different facts.
  const empty = res.body.buckets.find((b) => b.checks === 0);
  assert.equal(empty.availability, null);
  assert.equal(empty.avg_value, null);
});

test('a monitor with no history answers an empty chart rather than a 404', async () => {
  const { app } = fixture();
  const created = await create(app);
  const res = await request(app).get(`${BASE}/${created.id}/series?period=week&tz_offset=-120`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.buckets.length, 7);
  assert.equal(res.body.total.checks, 0);
  assert.equal(res.body.total.availability, null, 'a monitor that never ran is unmeasured, not 0% available');
});

test('the series validates its query and its id, and never 500s on junk', async () => {
  const { app } = fixture();
  const created = await create(app);
  const get = (q) => request(app).get(`${BASE}/${created.id}/series${q}`).set('Authorization', authHeader('viewer'));

  for (const q of ['?period=fortnight', '?period=day&at=not-a-date', '?tz_offset=abc', '?tz_offset=99999', '?period[]=day']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(q);
    assert.ok(res.status === 400 || res.status === 200, `${q} → ${res.status}`);
    assert.notEqual(res.status, 500, q);
  }
  assert.equal((await request(app).get(`${BASE}/abc/series`).set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get(`${BASE}/999/series`).set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get(`${BASE}/${created.id}/series`)).status, 401);

  const serviceTests = makeServiceTests();
  serviceTests.repositories.monitorResults.series = async () => { throw new Error('simulated database failure'); };
  const broken = makeApp({ serviceTests });
  const made = await create(broken);
  const res = await request(broken).get(`${BASE}/${made.id}/series`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});
