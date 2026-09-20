'use strict';

// Monitors, given the wrong shapes on purpose.
//
// The repo's rule is 400/401/403/404 and never 500, and the way that rule breaks
// is always the same: something that was assumed to be an object arrives as a
// string, or as an array, or as a number, and a property access throws two
// layers down. A monitor takes a nested `config` whose fields are typed by a
// catalogue, so it has more of those seams than anything else in the module.
//
// So this file sends every wrong shape at every route, sweeps both GETs with
// hostile query parameters, and then makes each repository method throw to prove
// the 500 path is a clean error rather than a crash.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/monitors';

const MAIL = {
  name: 'Customer mail',
  type: 'mail',
  config: {
    smtp_host: 'smtp.example.com',
    from_address: 'assurance@example.com',
    to_address: 'mailprobe@example.com',
    smtp_password: 'hunter2-correct-horse',
  },
};

function fixture(overrides = {}) {
  const serviceTests = makeServiceTests(overrides);
  return { serviceTests, app: makeApp({ serviceTests }) };
}

const op = (app, method, path) => request(app)[method](BASE + path).set('Authorization', authHeader('operator'));
const post = (app, body) => op(app, 'post', '').send(body);

async function create(app) {
  const res = await post(app, MAIL);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// Everything that is not a plain object, which is what every body and every
// `config` is assumed to be.
const NOT_OBJECTS = ['"a string"', '42', 'true', 'null', '[]', '["a","b"]', '"{}"'];

// Values that are not strings, sent where a string field is expected.
const NOT_STRINGS = [{}, [], 42, true, { toString: 'not callable' }, ['a'], { nested: { deep: 1 } }];

// ------------------------------------------------------------ bodies
test('a body that is not an object is 400 on every write route, never 500', async () => {
  const { app } = fixture();
  const created = await create(app);
  const routes = [['post', ''], ['patch', `/${created.id}`]];
  for (const [method, path] of routes) {
    for (const raw of NOT_OBJECTS) {
      // eslint-disable-next-line no-await-in-loop
      const res = await op(app, method, path).set('Content-Type', 'application/json').send(raw);
      assert.ok(res.status === 400, `${method} ${path} with ${raw} → ${res.status}`);
      assert.ok(res.status !== 500);
    }
  }
});

test('a config that is not an object is 400 — a string config must not reach a field lookup', async () => {
  const { app } = fixture();
  for (const config of ['a string', 42, true, [], ['smtp_host'], null]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, { name: 'x', type: 'mail', config });
    assert.equal(res.status, 400, JSON.stringify(config));
    assert.equal(res.body.error, 'Validation failed');
  }
});

test('an object where a string belongs is 400 on the field, not a stringified "[object Object]" in the database', async () => {
  const { app } = fixture();
  for (const value of NOT_STRINGS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, { name: 'x', type: 'mail', config: { ...MAIL.config, smtp_host: value } });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.ok(res.body.details['config.smtp_host'], 'the failing field is named');
  }
  // The same for the top-level string fields.
  for (const value of NOT_STRINGS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, { name: value, type: 'mail', config: MAIL.config });
    assert.equal(res.status, 400, JSON.stringify(value));
  }
});

test('a string where a structured value belongs is 400 — a list is a list', async () => {
  const { app } = fixture();
  for (const lists of ['zen.spamhaus.org', 'zen.spamhaus.org,bl.spamcop.net', {}, 42]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, { name: 'x', type: 'rbl', config: { ip: '1.2.3.4', lists } });
    assert.equal(res.status, 400, JSON.stringify(lists));
    assert.match(res.body.details['config.lists'], /list/);
  }
  const good = await post(app, { name: 'rbl ok', type: 'rbl', config: { ip: '1.2.3.4', lists: ['zen.spamhaus.org'] } });
  assert.equal(good.status, 201);
});

test('a boolean field takes a boolean, not the string "true" a form would send', async () => {
  const { app } = fixture();
  const res = await post(app, {
    name: 'x',
    type: 'mail',
    config: { ...MAIL.config, roundtrip: 'true', imap_host: 'imap.example.com', imap_username: 'probe' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.details['config.roundtrip'], /true or false/);
});

test('a numeric field accepts the digits a form posts, and refuses anything that is not a whole number', async () => {
  const { app } = fixture();
  // Deliberately lenient: an HTML form posts "587", and refusing it would be
  // refusing the only shape a browser can send.
  const ok = await post(app, { name: 'form post', type: 'mail', config: { ...MAIL.config, smtp_port: '587' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.config.smtp_port, 587, 'and it is stored as a number');

  for (const port of ['5 8 7', '587abc', '58.7', {}, [], true, '1e3']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, { name: `p ${JSON.stringify(port)}`, type: 'mail', config: { ...MAIL.config, smtp_port: port } });
    assert.equal(res.status, 400, JSON.stringify(port));
  }
});

test('a secret that is not a string cannot reach the encryption layer', async () => {
  const { app, serviceTests } = fixture();
  const res = await post(app, { name: 'x', type: 'mail', config: { ...MAIL.config, smtp_password: { evil: true } } });
  // Objects stringify to "[object Object]" in a text field, which would store a
  // useless secret — it is refused as a shape, not silently coerced.
  assert.equal(res.status, 400);
  assert.equal(serviceTests.tables.monitors.rows.length, 0, 'nothing was stored');
});

test('prototype-shaped keys are ignored, not written and not a crash', async () => {
  const { app, serviceTests } = fixture();
  const res = await request(app).post(BASE).set('Authorization', authHeader('operator'))
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({
      name: 'proto',
      type: 'mail',
      config: { ...MAIL.config, __proto__: { polluted: true }, constructor: 'nope', toString: 'nope' },
    }));
  assert.equal(res.status, 201);
  const stored = serviceTests.tables.monitors.rows[0];
  assert.equal(stored.config.constructor === 'nope', false, 'an unknown config key was stored');
  assert.equal(stored.config.polluted, undefined);
  assert.equal({}.polluted, undefined, 'Object.prototype was touched');
  // Only catalogue fields survive — the config is a declared shape, not a bag.
  for (const key of Object.keys(stored.config)) {
    assert.ok(!['constructor', 'toString', '__proto__', 'polluted'].includes(key), key);
  }
});

test('an oversized body is refused by the body limit, as a 4xx', async () => {
  const { app } = fixture();
  const res = await post(app, {
    name: 'big',
    type: 'mail',
    config: { ...MAIL.config, subject_prefix: 'x'.repeat(3 * 1024 * 1024) },
  });
  assert.ok(res.status >= 400 && res.status < 500, `→ ${res.status}`);
});

// ------------------------------------------------------------ GET sweeps
test('every GET answers 200 or 400 for hostile query parameters — never 500', async () => {
  const { app } = fixture();
  const created = await create(app);
  const queries = [
    '', '?', '?type=', '?type=mail', '?type=telepathy', '?type[]=mail', '?type=mail&type=dns_record',
    '?application_id=', '?application_id=0', '?application_id=-1', '?application_id=abc',
    '?application_id=99999999999999999999', '?application_id[]=1', '?application_id=1&application_id=2',
    '?enabled=', '?enabled=true', '?enabled=false', '?enabled=1', '?enabled=maybe', '?enabled[]=true',
    "?type=' OR 1=1--", '?limit=0', '?limit=-5', '?limit=abc', '?limit=99999', '?limit[]=10',
    '?hours=0', '?hours=abc', '?hours=99999', '?unknown=param', `?name=${encodeURIComponent('\0null byte')}`,
  ];
  const paths = ['', '/types', `/${created.id}`, `/${created.id}/results`];
  for (const path of paths) {
    for (const query of queries) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(BASE + path + query).set('Authorization', authHeader('viewer'));
      assert.ok(res.status === 200 || res.status === 400, `GET ${path}${query} → ${res.status}`);
      if (res.status === 400) assert.ok(res.body.error, 'a 400 says what was wrong');
    }
  }
});

test('a GET list answers an array and a GET one answers the monitor with its history', async () => {
  const { app } = fixture();
  const created = await create(app);

  const list = await request(app).get(BASE).set('Authorization', authHeader('viewer'));
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body[0].id, created.id);
  assert.equal(list.body[0].secrets, undefined);

  const one = await request(app).get(`${BASE}/${created.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(one.status, 200);
  assert.ok(Array.isArray(one.body.recent), 'the detail carries its recent checks');
  assert.equal(one.body.summary.checks, 0);
  assert.equal(one.body.summary.availability, null, 'never run is unmeasured, not 0%');
  assert.deepEqual(one.body.has_secrets, { smtp_password: true, imap_password: false });

  const results = await request(app).get(`${BASE}/${created.id}/results`).set('Authorization', authHeader('viewer'));
  assert.equal(results.status, 200);
  assert.equal(results.body.monitor_id, created.id);
  assert.ok(Array.isArray(results.body.results));

  const types = await request(app).get(`${BASE}/types`).set('Authorization', authHeader('viewer'));
  assert.equal(types.status, 200);
  assert.ok(Array.isArray(types.body.types));
  // The catalogue is JSON on the wire: nothing in it may be a function or
  // undefined, both of which vanish silently through JSON.stringify.
  assert.ok(!JSON.stringify(types.body).includes('undefined'));
});

// ------------------------------------------------------------ 500 sweep
test('every route turns a repository failure into a clean 500, on every method', async () => {
  const boom = () => { throw new Error('simulated database failure'); };
  const routes = [
    { method: 'get', path: '', break: (r) => { r.monitors.list = async () => boom(); } },
    // A DIFFERENT name: the fixture already created one, and a duplicate would
    // answer 400 before the broken repository was ever reached.
    { method: 'post', path: '', body: { ...MAIL, name: 'Second mail' }, break: (r) => { r.monitors.create = async () => boom(); } },
    { method: 'get', path: '/:id', break: (r) => { r.monitors.findById = async () => boom(); } },
    { method: 'patch', path: '/:id', body: { name: 'new' }, break: (r) => { r.monitors.update = async () => boom(); } },
    { method: 'delete', path: '/:id', break: (r) => { r.monitors.remove = async () => boom(); } },
    { method: 'post', path: '/:id/check', break: (r) => { r.monitors.findByIdWithSecrets = async () => boom(); } },
    { method: 'get', path: '/:id/results', break: (r) => { r.monitorResults.list = async () => boom(); } },
    { method: 'get', path: '/:id', break: (r) => { r.monitorResults.summary = async () => boom(); } },
    // The result store failing must not be reported as a healthy check.
    { method: 'post', path: '/:id/check', break: (r) => { r.monitorResults.record = async () => boom(); } },
  ];

  for (const route of routes) {
    // A fresh fixture per route: the monitor has to exist before the repository
    // is broken, or the route answers 404 and proves nothing.
    // eslint-disable-next-line no-await-in-loop
    const { app, serviceTests } = fixture();
    // eslint-disable-next-line no-await-in-loop
    const created = await create(app);
    route.break(serviceTests.repositories);
    const path = route.path.replace(':id', String(created.id));
    // eslint-disable-next-line no-await-in-loop
    const res = await op(app, route.method, path).send(route.body || undefined);
    assert.equal(res.status, 500, `${route.method} ${path}`);
    assert.ok(res.body.error, 'the 500 carries the repo error shape');
    assert.ok(!JSON.stringify(res.body).includes('at Object.'), 'a stack trace must not reach the client');
  }
});

test('a check that cannot run leaves the monitor readable and answers 500 rather than half-writing', async () => {
  const { app, serviceTests } = fixture();
  const created = await create(app);
  serviceTests.monitorRunner.run = async () => { throw new Error('the runner exploded'); };

  const res = await op(app, 'post', `/${created.id}/check`);
  assert.equal(res.status, 500);
  const after = await request(app).get(`${BASE}/${created.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(after.status, 200, 'the monitor is still readable');
  assert.equal(after.body.last_status, null, 'and it was not stamped with an outcome that never happened');
  // The lock is released: a failed check must not block the next one.
  serviceTests.monitorRunner.run = async () => ({ status: 'ok', summary: 'fine', duration_ms: 3 });
  assert.equal((await op(app, 'post', `/${created.id}/check`)).status, 200);
});
