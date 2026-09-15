'use strict';

// HTTP specs for Service Assurance monitors — the checks that are not a browser.
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 / 409 on every route,
// never 500.
//
// Three things here are security assertions rather than CRUD ones, and they are
// the reason this file is long:
//
//   * a secret goes IN and never comes back out, on any path;
//   * a monitor can never be pointed at loopback, link-local or the cloud
//     metadata address, whatever an operator types;
//   * a mail monitor can only send to a domain the operator allowlisted, and a
//     database monitor can only run a SELECT.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/monitors';

const MAIL = {
  name: 'Customer mail',
  type: 'mail',
  interval_sec: 900,
  config: {
    smtp_host: 'smtp.example.com',
    smtp_port: 587,
    smtp_security: 'starttls',
    smtp_username: 'probe',
    smtp_password: 'hunter2-correct-horse',
    from_address: 'assurance@example.com',
    to_address: 'mailprobe@example.com',
  },
};

function fixture(overrides = {}) {
  const serviceTests = makeServiceTests(overrides);
  return { serviceTests, app: makeApp({ serviceTests }) };
}

const post = (app, body, role = 'operator') => request(app).post(BASE).set('Authorization', authHeader(role)).send(body);
const get = (app, path = '', role = 'viewer') => request(app).get(BASE + path).set('Authorization', authHeader(role));

async function create(app, body = MAIL) {
  const res = await post(app, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// ------------------------------------------------------------------ 401 / 403
test('monitors are licence-gated, anonymous-401 and viewer-read-only', async () => {
  const { app } = fixture();
  assert.equal((await request(app).get(BASE)).status, 401, 'anonymous read');
  assert.equal((await request(app).post(BASE).send({})).status, 401, 'anonymous write');

  assert.equal((await get(app)).status, 200, 'viewer may read');
  assert.equal((await get(app, '/types')).status, 200, 'viewer may read the catalogue');
  assert.equal((await post(app, MAIL, 'viewer')).status, 403, 'viewer may not create');

  const created = await create(app);
  assert.equal((await request(app).delete(`${BASE}/${created.id}`).set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(app).post(`${BASE}/${created.id}/check`).set('Authorization', authHeader('viewer'))).status, 403);

  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });
  const gated = await request(unlicensed).get(BASE).set('Authorization', authHeader('admin'));
  assert.equal(gated.status, 403);
  assert.equal(gated.body.error, 'feature_not_available');
});

// ---------------------------------------------------------------- catalogue
test('the type catalogue describes every check, its fields and its secrets', async () => {
  const { app } = fixture();
  const res = await get(app, '/types');
  const types = res.body.types.map((t) => t.type);
  for (const expected of ['mail', 'dns_record', 'rbl', 'ldap_bind', 'ntp_offset', 'tls_port', 'tcp_port', 'db_connect']) {
    assert.ok(types.includes(expected), `${expected} missing from the catalogue`);
  }
  const mail = res.body.types.find((t) => t.type === 'mail');
  assert.ok(mail.secrets.includes('smtp_password'));
  assert.equal(mail.target, 'smtp_host');
  const field = mail.fields.find((f) => f.field === 'smtp_port');
  assert.equal(field.type, 'int');
  assert.equal(field.default, 587);
});

// ---------------------------------------------------------------------- 400
test('creating a monitor validates the type, the name and every config field (400, never 500)', async () => {
  const { app } = fixture();
  const bad = [
    {},
    { name: 'x' },
    { name: 'x', type: 'telepathy', config: {} },
    { name: '', type: 'mail', config: MAIL.config },
    // Missing the address the check is about.
    { name: 'x', type: 'mail', config: { from_address: 'a@b.dk', to_address: 'c@d.dk' } },
    // Not an email address.
    { name: 'x', type: 'mail', config: { ...MAIL.config, to_address: 'not-an-address' } },
    // Out of the field's bounds.
    { name: 'x', type: 'mail', config: { ...MAIL.config, smtp_port: 99999 } },
    { name: 'x', type: 'mail', config: { ...MAIL.config, smtp_security: 'magic' } },
    // Round-trip with nowhere to look.
    { name: 'x', type: 'mail', config: { ...MAIL.config, roundtrip: true } },
    // Intervals below the floor: a mail probe every five seconds is a mail bomb.
    { name: 'x', type: 'mail', interval_sec: 5, config: MAIL.config },
    { name: 'x', type: 'mail', interval_sec: 999999, config: MAIL.config },
    // Thresholds that contradict each other.
    { name: 'x', type: 'mail', warn_ms: 5000, crit_ms: 1000, config: MAIL.config },
    { name: 'x', type: 'dns_record', config: { domain: 'example.com', preset: 'dkim' } },
    { name: 'x', type: 'dns_record', config: { domain: 'example.com', preset: 'custom' } },
    { name: 'x', type: 'rbl', config: { ip: 'mail.example.com' } },
    { name: 'x', type: 'ldap_bind', config: { url: 'https://dc.example.com', bind_dn: 'cn=svc' } },
    { name: 'x', type: 'db_connect', config: { engine: 'mysql', host: 'db.example.com', query: 'DELETE FROM users' } },
    { name: 'x', type: 'db_connect', config: { engine: 'mysql', host: 'db.example.com', query: 'SELECT 1; DROP TABLE users' } },
    { name: 'x', type: 'tcp_port', config: { host: 'mail.example.com' } },
  ];
  for (const body of bad) {
    const res = await post(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'Validation failed');
  }
  for (const raw of ['[]', '"str"', 'null', '123']) {
    const res = await request(app).post(BASE).set('Authorization', authHeader('operator'))
      .set('Content-Type', 'application/json').send(raw);
    assert.ok(res.status === 400, `${raw} → ${res.status}`);
  }
});

test('a monitor can never be pointed at loopback, link-local or cloud metadata', async () => {
  const { app } = fixture();
  const blocked = [
    { name: 'a', type: 'tcp_port', config: { host: '127.0.0.1', port: 25 } },
    { name: 'b', type: 'tcp_port', config: { host: 'localhost', port: 25 } },
    { name: 'c', type: 'mail', config: { ...MAIL.config, smtp_host: '169.254.169.254' } },
    { name: 'd', type: 'ldap_bind', config: { url: 'ldaps://127.0.0.1:636', bind_dn: 'cn=svc' } },
    { name: 'e', type: 'db_connect', config: { engine: 'postgres', host: '127.0.0.1' } },
  ];
  for (const body of blocked) {
    const res = await post(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(res.body.details), /never be monitored/);
  }
  // A private LAN address is NOT blocked — that is where the directory, the
  // relay and the database actually live.
  assert.equal((await post(app, { name: 'lan', type: 'tcp_port', config: { host: '10.0.0.5', port: 389 } })).status, 201);
});

test('a mail monitor may only send to an allowlisted domain when one is configured', async () => {
  const { app, serviceTests } = fixture();
  await serviceTests.settings.set('monitors', { mailRecipientDomains: 'example.com, kunde.dk' });

  const refused = await post(app, { ...MAIL, name: 'elsewhere', config: { ...MAIL.config, to_address: 'someone@gmail.com' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.details['config.to_address'], /example\.com/);

  assert.equal((await post(app, MAIL)).status, 201, 'the allowlisted domain is accepted');
});

test('credentials are never sent over an unencrypted connection', async () => {
  const { app } = fixture();
  const res = await post(app, {
    ...MAIL,
    config: { ...MAIL.config, smtp_security: 'none' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.details['config.smtp_security'], /unencrypted/);
});

// --------------------------------------------------------------- secrets
test('a secret goes in and never comes back out', async () => {
  const { app, serviceTests } = fixture();
  const created = await create(app);

  assert.equal(created.has_secrets.smtp_password, true);
  const serialised = JSON.stringify(created);
  assert.ok(!serialised.includes('hunter2'), 'the password came back from POST');
  assert.ok(!serialised.includes('smtp_password') || !created.config.smtp_password, 'the password is in the config');

  const one = await get(app, `/${created.id}`);
  assert.ok(!JSON.stringify(one.body).includes('hunter2'), 'the password came back from GET');

  const listed = await get(app);
  assert.ok(!JSON.stringify(listed.body).includes('hunter2'), 'the password came back from the list');

  // Stored, though — the check needs it.
  const withSecret = await serviceTests.repositories.monitors.findByIdWithSecrets(created.id);
  assert.equal(withSecret.secrets.smtp_password, 'hunter2-correct-horse');

  // A rename leaves the secret alone; an empty string clears it.
  await request(app).patch(`${BASE}/${created.id}`).set('Authorization', authHeader('operator'))
    .send({ name: 'Renamed' }).expect(200);
  assert.equal((await serviceTests.repositories.monitors.findByIdWithSecrets(created.id)).secrets.smtp_password, 'hunter2-correct-horse');

  await request(app).patch(`${BASE}/${created.id}`).set('Authorization', authHeader('operator'))
    .send({ config: { ...MAIL.config, smtp_password: '' } }).expect(200);
  assert.equal((await serviceTests.repositories.monitors.findByIdWithSecrets(created.id)).secrets.smtp_password, undefined);
});

// ------------------------------------------------------------------- 404
test('every :id route answers 400 for a bad id and 404 for a missing one', async () => {
  const { app } = fixture();
  for (const [method, path] of [['get', '/abc'], ['patch', '/abc'], ['delete', '/abc'], ['post', '/abc/check'], ['get', '/abc/results']]) {
    const res = await request(app)[method](BASE + path).set('Authorization', authHeader('operator')).send({});
    assert.equal(res.status, 400, `${method} ${path}`);
  }
  for (const [method, path] of [['get', '/999'], ['patch', '/999'], ['delete', '/999'], ['post', '/999/check'], ['get', '/999/results']]) {
    const res = await request(app)[method](BASE + path).set('Authorization', authHeader('operator')).send({});
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error, 'Monitor not found');
  }
});

test('list filters are validated rather than silently ignored', async () => {
  const { app } = fixture();
  assert.equal((await get(app, '?type=telepathy')).status, 400);
  assert.equal((await get(app, '?application_id=abc')).status, 400);
  assert.equal((await get(app, '?enabled=maybe')).status, 400);
  assert.equal((await get(app, '?enabled=true')).status, 200);
});

// ------------------------------------------------------------------- CRUD
test('create, read, update and delete a monitor', async () => {
  const { app } = fixture();
  const created = await create(app);
  assert.equal(created.type, 'mail');
  assert.equal(created.target, 'smtp.example.com', 'the target is denormalised out of the config');
  assert.equal(created.enabled, true);

  assert.equal((await post(app, MAIL)).status, 400, 'a duplicate name is refused');

  const patched = await request(app).patch(`${BASE}/${created.id}`).set('Authorization', authHeader('operator'))
    .send({ interval_sec: 3600, enabled: false, warn_ms: 30000 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.interval_sec, 3600);
  assert.equal(patched.body.enabled, false);
  assert.equal(patched.body.warn_ms, 30000);

  // The check type is identity, not a field.
  const retyped = await request(app).patch(`${BASE}/${created.id}`).set('Authorization', authHeader('operator'))
    .send({ type: 'tcp_port' });
  assert.equal(retyped.status, 400);
  assert.match(retyped.body.details.type, /cannot be changed/);

  assert.equal((await request(app).delete(`${BASE}/${created.id}`).set('Authorization', authHeader('operator'))).status, 204);
  assert.equal((await get(app, `/${created.id}`)).status, 404);
});

// -------------------------------------------------------------- check now
test('a manual check runs the monitor, stores the result and reports it', async () => {
  const { app } = fixture({
    monitor_results: {
      'Customer mail': {
        status: 'ok',
        summary: 'Delivered to mailprobe@example.com in 4.1 s.',
        value: 4100,
        unit: 'ms',
        duration_ms: 4100,
        timings: { connect: 24, tls: 61, auth: 38, data: 142, delivery: 4100 },
      },
    },
  });
  const created = await create(app);

  const res = await request(app).post(`${BASE}/${created.id}/check`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.result.status, 'ok');
  assert.equal(res.body.result.value, 4100);
  assert.equal(res.body.result.trigger_source, 'manual');
  assert.equal(res.body.monitor.last_status, 'ok');
  assert.equal(res.body.incident, null, 'a healthy check opens nothing');

  const results = await get(app, `/${created.id}/results`);
  assert.equal(results.status, 200);
  assert.equal(results.body.results.length, 1);
  assert.equal(results.body.summary.checks, 1);
  assert.equal(results.body.summary.availability, 1);
});

test('a failing check opens an incident once the streak is met, and recovery resolves it', async () => {
  const { app, serviceTests } = fixture({
    monitor_results: {
      'Customer mail': {
        status: 'failed',
        kind: 'mail_undelivered',
        summary: 'smtp.example.com accepted the message but it never reached mailprobe@example.com.',
        duration_ms: 300000,
      },
    },
  });
  const created = await create(app);
  // A new monitor is PENDING until it has worked once, and a pending monitor
  // opens nothing. This spec is about what happens AFTER that gate, so it uses
  // the operator's override — which is also the path somebody takes when the
  // service is already down at the moment they start watching it.
  const activated = await request(app).post(`${BASE}/${created.id}/activate`).set('Authorization', authHeader('operator'));
  assert.equal(activated.status, 200);
  assert.equal(activated.body.pending, false);

  const check = () => request(app).post(`${BASE}/${created.id}/check`).set('Authorization', authHeader('operator'));

  const first = await check();
  assert.equal(first.status, 200);
  assert.equal(first.body.state, 'healthy', 'one bad check is not an outage');

  const second = await check();
  assert.equal(second.body.state, 'opened');
  assert.equal(second.body.incident.severity, 'CRIT', 'silently lost mail pages');
  assert.equal(second.body.incident.subject_type, 'monitor');
  assert.equal(second.body.incident.kind, 'mail_undelivered');
  assert.match(second.body.incident.explanation, /never appears in a sending log/);
  assert.ok(serviceTests.notifications.length >= 1, 'the incident was sent');

  // Recovery: the next check is healthy and the incident resolves.
  serviceTests.monitorRunner.run = async () => ({
    status: 'ok', kind: null, summary: 'Delivered.', value: 900, unit: 'ms', duration_ms: 900, timings: null, detail: null, error_message: null,
  });
  const third = await check();
  assert.equal(third.body.state, 'resolved');
  assert.equal(third.body.monitor.consecutive_failures, 0);
});

test('two manual checks of one monitor do not race — the second answers 409', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app } = fixture({
    monitorRunner: {
      async run() {
        await gate;
        return { status: 'ok', kind: null, summary: 'ok', value: 1, unit: 'ms', duration_ms: 1, timings: null, detail: null, error_message: null };
      },
    },
  });
  const created = await create(app);
  // .end() rather than await: a supertest request does not leave until it is
  // started, and a second request cannot collide with one that never went.
  const first = new Promise((resolve, reject) => {
    request(app).post(`${BASE}/${created.id}/check`).set('Authorization', authHeader('operator'))
      .end((err, res) => (err ? reject(err) : resolve(res)));
  });
  // Let the first request reach the handler before the second arrives.
  await new Promise((r) => { setTimeout(r, 50); });
  const second = await request(app).post(`${BASE}/${created.id}/check`).set('Authorization', authHeader('operator'));
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
});

// -------------------------------------------------------------------- 500
test('a repository failure is a 500 with the repo error shape, not a crash', async () => {
  const serviceTests = makeServiceTests();
  serviceTests.repositories.monitors.list = async () => { throw new Error('simulated database failure'); };
  const app = makeApp({ serviceTests });
  const res = await get(app);
  assert.equal(res.status, 500);
  assert.ok(res.body.error, 'the 500 body carries an error');
});
