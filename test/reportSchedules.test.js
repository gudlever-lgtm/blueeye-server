'use strict';

// Scheduled reports — /api/report-schedules and the job behind it.
//
// The HTTP half (who may create one, what is refused, what "send now" answers)
// and the scheduler half (when it is due, what it builds, what it records when
// the mail fails) are both here, because the feature is the two together: a
// schedule nobody sends is a row, and a send nobody scheduled is an export.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeReportSchedulesRepo,
  makeLocationsRepo,
  authHeader,
} = require('../test-support/fakes');
const { createReportScheduler } = require('../src/services/reportScheduler');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');
const admin = () => authHeader('admin');

const monthly = { period: 'monthly', every: 1, at: '06:00', dayOfMonth: 1 };
const body = {
  name: 'Monthly SLA',
  report: 'availability',
  format: 'csv',
  window_days: 30,
  recipients: ['service@customer.dk'],
  schedule_spec: monthly,
};

const quiet = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- HTTP
test('GET /api/report-schedules lists the schedules (viewer+), 401 without a token', async () => {
  const repo = makeReportSchedulesRepo({ findAll: async () => [{ id: 1, name: 'Monthly SLA', recipients: ['a@b.dk'] }] });
  const app = makeApp({ reportSchedulesRepo: repo });
  const res = await request(app).get('/api/report-schedules').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body[0].name, 'Monthly SLA');
  assert.equal((await request(app).get('/api/report-schedules')).status, 401);
});

test('POST creates a schedule (admin) — and an operator may not', async () => {
  let created;
  const repo = makeReportSchedulesRepo({ create: async (r) => { created = r; return { id: 9, ...r }; } });
  const app = makeApp({ reportSchedulesRepo: repo });
  const res = await request(app).post('/api/report-schedules').set('Authorization', admin()).send(body);
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 9);
  assert.deepEqual(created.schedule_spec, monthly);
  assert.deepEqual(created.recipients, ['service@customer.dk']);
  assert.equal(created.window_days, 30, 'the window is relative and stored as days');
  assert.equal(created.created_by, 1);
  // Sending data out of the building on a timer is an administrator's decision.
  assert.equal((await request(app).post('/api/report-schedules').set('Authorization', operator()).send(body)).status, 403);
});

test('POST validates the body → 400 with field-level details', async () => {
  const app = makeApp();
  const bad = [
    [{}, ['name', 'report', 'recipients', 'schedule_spec']],
    [{ ...body, report: 'everything' }, ['report']],
    [{ ...body, format: 'pdf' }, ['format']],
    [{ ...body, window_days: 0 }, ['window_days']],
    [{ ...body, window_days: 4000 }, ['window_days']],
    [{ ...body, recipients: [] }, ['recipients']],
    [{ ...body, recipients: ['not-an-address'] }, ['recipients']],
    // A recipient that carries a newline would carry a header with it.
    [{ ...body, recipients: ['a@b.dk\nBcc: someone@else.dk'] }, ['recipients']],
    [{ ...body, schedule_spec: { period: 'fortnightly' } }, ['schedule_spec']],
    [{ ...body, schedule_spec: { period: 'hourly', every: 999 } }, ['schedule_spec']],
    [{ ...body, params: { severity: 'apocalyptic' }, report: 'probe_outages' }, ['params']],
    [{ ...body, params: { location_id: 'abc' } }, ['params']],
  ];
  for (const [payload, fields] of bad) {
    const res = await request(app).post('/api/report-schedules').set('Authorization', admin()).send(payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    for (const f of fields) assert.ok(res.body.details[f], `${JSON.stringify(payload)}: no detail for ${f}`);
  }
});

test('a location filter that names no location is refused when the schedule is created, not when it is sent', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) });
  const res = await request(app).post('/api/report-schedules').set('Authorization', admin())
    .send({ ...body, params: { location_id: 4242 } });
  assert.equal(res.status, 400);
  assert.match(res.body.details.params, /does not name a location/);
});

test('PUT and DELETE are admin-only and 404 an unknown id', async () => {
  const app = makeApp({ reportSchedulesRepo: makeReportSchedulesRepo() });
  assert.equal((await request(app).put('/api/report-schedules/999999').set('Authorization', admin()).send(body)).status, 404);
  assert.equal((await request(app).delete('/api/report-schedules/999999').set('Authorization', admin())).status, 404);
  assert.equal((await request(app).put('/api/report-schedules/1').set('Authorization', operator()).send(body)).status, 403);
  assert.equal((await request(app).delete('/api/report-schedules/1').set('Authorization', operator())).status, 403);
});

test('send-now runs the schedule and records the outcome; no mail transport is 409, not 500', async () => {
  const sent = [];
  const schedule = { id: 3, ...body, params: {}, enabled: true, last_run_at: null };
  const status = [];
  const repo = makeReportSchedulesRepo({
    findById: async (id) => (Number(id) === 3 ? schedule : null),
    setLastRun: async (id, s) => { status.push(s); },
  });
  const scheduler = createReportScheduler({
    repo,
    mailer: { send: async (m) => { sent.push(m); return { ok: true, detail: 'sent to 1 recipient(s)' }; } },
    probeResultsRepo: { availability: async () => [{ agentName: 'a1', locationName: 'HQ', uptimePct: 99.9, up: 999, down: 1, total: 1000 }] },
    probeOutagesRepo: { list: async () => [] },
    logger: quiet,
  });
  const app = makeApp({ reportSchedulesRepo: repo, reportScheduler: scheduler });

  const res = await request(app).post('/api/report-schedules/3/send-now').set('Authorization', operator());
  assert.equal(res.status, 202);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['service@customer.dk']);
  assert.match(sent[0].subject, /Availability/);
  assert.equal(sent[0].filename, 'blueeye-availability.csv');
  assert.match(String(sent[0].body), /uptime_pct/, 'the attachment is not the report');
  assert.match(String(sent[0].body), /99\.9/);
  assert.ok(status[0].startsWith('ok —'), status[0]);

  // A mail server nobody configured is an answer, not a server error.
  const failing = createReportScheduler({
    repo,
    mailer: { send: async () => ({ ok: false, detail: 'no mail transport configured' }) },
    probeResultsRepo: { availability: async () => [] },
    probeOutagesRepo: { list: async () => [] },
    logger: quiet,
  });
  const app2 = makeApp({ reportSchedulesRepo: repo, reportScheduler: failing });
  const res2 = await request(app2).post('/api/report-schedules/3/send-now').set('Authorization', operator());
  assert.equal(res2.status, 409);
  assert.match(res2.body.detail, /no mail transport/);
  assert.ok(status[1].startsWith('failed —'), status[1]);

  assert.equal((await request(app).post('/api/report-schedules/3/send-now').set('Authorization', viewer())).status, 403);
  assert.equal((await request(app).post('/api/report-schedules/999999/send-now').set('Authorization', operator())).status, 404);
});

test('no route answers 500 to junk', async () => {
  const app = makeApp();
  for (const payload of [{}, [], 'str', null, 123, { recipients: 'a@b.dk' }, { schedule_spec: 'daily' }]) {
    for (const [method, p] of [['post', '/api/report-schedules'], ['put', '/api/report-schedules/1']]) {
      const res = await request(app)[method](p).set('Authorization', admin())
        .set('Content-Type', 'application/json').send(JSON.stringify(payload));
      assert.ok(res.status < 500, `${method} ${p} ${JSON.stringify(payload)} → ${res.status}`);
    }
  }
});

// ---------------------------------------------------------------- the job
function schedulerWith({ schedules, mailer, rows = [] }) {
  const status = new Map();
  const repo = makeReportSchedulesRepo({
    findEnabled: async () => schedules,
    setLastRun: async (id, s) => { status.set(id, s); },
  });
  return {
    status,
    scheduler: createReportScheduler({
      repo,
      mailer,
      probeResultsRepo: { availability: async () => rows },
      probeOutagesRepo: { list: async () => rows },
      logger: quiet,
      now: () => schedulerWith.clock,
    }),
  };
}

test('the job sends when the calendar slot passes, and not before', async () => {
  process.env.TZ = 'Europe/Copenhagen';
  const sent = [];
  const day = (h, m = 0) => new Date(2026, 2, 10, h, m, 0, 0).getTime();
  schedulerWith.clock = day(5);
  const schedule = { id: 1, name: 'Daily SLA', report: 'availability', format: 'csv', window_days: 1, params: {}, recipients: ['a@b.dk'], schedule_spec: { period: 'daily', every: 1, at: '06:00' }, last_run_at: null };
  const { scheduler, status } = schedulerWith({
    schedules: [schedule],
    mailer: { send: async (m) => { sent.push(m); return { ok: true, detail: 'sent to 1 recipient(s)' }; } },
  });

  await scheduler.tick();                       // seeds last-run = 05:00
  assert.equal(sent.length, 0);
  schedulerWith.clock = day(5, 59);
  await scheduler.tick();
  assert.equal(sent.length, 0, 'sent a minute early');
  schedulerWith.clock = day(6);
  await scheduler.tick();
  assert.equal(sent.length, 1, 'not sent at 06:00');
  schedulerWith.clock = day(18);
  await scheduler.tick();
  assert.equal(sent.length, 1, 'once a day means once');
  assert.match(status.get(1), /^ok —/);
});

test('the window is relative: each send asks for the last N days, not a stored fortnight', async () => {
  const asked = [];
  const scheduler = createReportScheduler({
    repo: makeReportSchedulesRepo(),
    mailer: { send: async () => ({ ok: true, detail: 'sent' }) },
    probeResultsRepo: { availability: async (q) => { asked.push(q); return []; } },
    probeOutagesRepo: { list: async () => [] },
    logger: quiet,
  });
  const at = Date.UTC(2026, 5, 1, 6, 0, 0);
  await scheduler.runOne({ name: 'w', report: 'availability', format: 'csv', window_days: 7, params: {}, recipients: ['a@b.dk'] }, at);
  const later = at + 30 * 24 * 60 * 60 * 1000;
  await scheduler.runOne({ name: 'w', report: 'availability', format: 'csv', window_days: 7, params: {}, recipients: ['a@b.dk'] }, later);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].to.getTime(), at);
  assert.equal(asked[1].to.getTime(), later, 'the second send asked for the same period as the first');
  assert.equal(asked[1].to - asked[1].from, 7 * 24 * 60 * 60 * 1000);
});

test('a failed send is recorded on the schedule and never stops the next one', async () => {
  schedulerWith.clock = Date.now();
  const s1 = { id: 1, name: 'broken', report: 'availability', format: 'csv', window_days: 1, params: {}, recipients: ['a@b.dk'], schedule_spec: { period: 'hourly', every: 1 }, last_run_at: new Date(schedulerWith.clock - 7200_000) };
  const s2 = { ...s1, id: 2, name: 'fine' };
  const seen = [];
  const { scheduler, status } = schedulerWith({
    schedules: [s1, s2],
    mailer: { send: async (m) => { seen.push(m.subject); return m.to[0] === 'a@b.dk' && seen.length === 1 ? { ok: false, detail: 'mail failed: connect ECONNREFUSED' } : { ok: true, detail: 'sent' }; } },
  });
  await scheduler.tick();
  assert.equal(seen.length, 2, 'the second schedule was skipped after the first failed');
  assert.match(status.get(1), /^failed — mail failed/);
  assert.match(status.get(2), /^ok —/);
});

test('a schedule whose recurrence no longer parses is never due', async () => {
  schedulerWith.clock = Date.now();
  const sent = [];
  const { scheduler } = schedulerWith({
    schedules: [{ id: 1, name: 'broken', report: 'availability', format: 'csv', window_days: 1, params: {}, recipients: ['a@b.dk'], schedule_spec: { period: 'never' }, last_run_at: null }],
    mailer: { send: async (m) => { sent.push(m); return { ok: true, detail: 'sent' }; } },
  });
  await scheduler.tick();
  schedulerWith.clock += 365 * 24 * 60 * 60 * 1000;
  await scheduler.tick();
  assert.equal(sent.length, 0);
});

test('the HTML format sends the printable report, and an unknown report is refused rather than mailed', async () => {
  const sent = [];
  const scheduler = createReportScheduler({
    repo: makeReportSchedulesRepo(),
    mailer: { send: async (m) => { sent.push(m); return { ok: true, detail: 'sent' }; } },
    probeResultsRepo: { availability: async () => [{ agentName: 'a1', locationName: 'HQ', uptimePct: 100, up: 10, down: 0, total: 10 }] },
    probeOutagesRepo: { list: async () => [] },
    logger: quiet,
  });
  await scheduler.runOne({ name: 'h', report: 'availability', format: 'html', window_days: 7, params: {}, recipients: ['a@b.dk'] });
  assert.equal(sent[0].filename, 'blueeye-availability.html');
  assert.match(String(sent[0].body), /<table|<html/i);

  const bad = await scheduler.runOne({ name: 'x', report: 'nope', format: 'csv', window_days: 7, params: {}, recipients: ['a@b.dk'] });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /unknown report/);
  assert.equal(sent.length, 1, 'an unknown report was mailed anyway');
});
