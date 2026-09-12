'use strict';

// HTTP specs for the Service Assurance API. Every endpoint is exercised for the
// contract the repo requires — 400 / 401 / 403 / 404 and never a 500 — plus the
// rules that only exist at this layer: the licence gate, RBAC, and the SSRF
// allowlist decisions that guard what the browser may reach.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests';
const app = () => makeApp();

const get = (path, role) => request(app()).get(`${BASE}${path}`).set('Authorization', authHeader(role));

// ------------------------------------------------------------------ licence
test('the whole module is licence-gated, and an anonymous request is 401 rather than a licence leak', async () => {
  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });

  const anon = await request(unlicensed).get(`${BASE}/applications`);
  assert.equal(anon.status, 401, 'an anonymous caller must not learn whether the feature is licensed');

  const signedIn = await request(unlicensed).get(`${BASE}/applications`).set('Authorization', authHeader('admin'));
  assert.equal(signedIn.status, 403);
  assert.equal(signedIn.body.error, 'feature_not_available');
  assert.equal(signedIn.body.feature, 'service_tests');
});

test('a deployment without the module answers 404, not 500', async () => {
  const without = makeApp({ serviceTests: null });
  assert.equal((await request(without).get(`${BASE}/applications`).set('Authorization', authHeader('admin'))).status, 404);
});

// ------------------------------------------------------------------ RBAC
test('reads are open to viewers; application, credential and allowlist writes are admin-only', async () => {
  for (const path of ['/applications', '/tests', '/runs', '/schedules', '/settings', '/discovery']) {
    assert.equal((await get(path, 'viewer')).status, 200, `GET ${path}`);
  }
  const writes = [
    ['post', '/applications', { name: 'X', base_url: 'https://x.example.com' }],
    ['post', '/environments', { application_id: 1, name: 'E', base_url: 'https://x.example.com' }],
    ['post', '/credentials', { application_id: 1, label: 'L', secret: 'long-enough' }],
    ['post', '/applications/1/allowed-hosts', { value: 'portal.kunde.dk' }],
  ];
  for (const [method, path, body] of writes) {
    for (const role of ['viewer', 'operator']) {
      const res = await request(app())[method](`${BASE}${path}`).set('Authorization', authHeader(role)).send(body);
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
    }
    const ok = await request(app())[method](`${BASE}${path}`).set('Authorization', authHeader('admin')).send(body);
    assert.equal(ok.status, 201, `admin ${method} ${path} → ${ok.status} ${JSON.stringify(ok.body)}`);
  }
});

test('building and running a test is operator work, not admin-only', async () => {
  const definition = { version: 1, name: 'T', steps: [{ type: 'open', url: '/' }] };
  const created = await request(app()).post(`${BASE}/tests`).set('Authorization', authHeader('operator'))
    .send({ application_id: 1, name: 'T', definition });
  assert.equal(created.status, 201);

  const run = await request(app()).post(`${BASE}/tests/1/run`).set('Authorization', authHeader('operator')).send({});
  assert.equal(run.status, 202);
  assert.ok(run.body.run_id);
  assert.equal(run.body.status, 'queued', 'a run is queued for the worker, never executed in the request');
});

test('credentials are admin-only even to READ — the list reveals which systems have stored logins', async () => {
  for (const role of ['viewer', 'operator']) {
    assert.equal((await get('/credentials', role)).status, 403, role);
  }
  assert.equal((await get('/credentials', 'admin')).status, 200);
});

// ------------------------------------------------------------------ secrets
test('no response anywhere exposes a stored password', async () => {
  const created = await request(app()).post(`${BASE}/credentials`).set('Authorization', authHeader('admin'))
    .send({ application_id: 1, label: 'Portal', username: 'svc', secret: 'hunter2-correct-horse' });
  assert.equal(created.status, 201);
  assert.equal(created.body.has_secret, true);

  const responses = [
    created,
    await get('/credentials', 'admin'),
    await get('/credentials/1', 'admin'),
    await get('/applications/1', 'admin'),
  ];
  for (const res of responses) {
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('hunter2-correct-horse'), 'a password reached an API response');
    assert.ok(!body.includes('secret_encrypted'), 'even the ciphertext must not leave the repository');
  }
});

// ------------------------------------------------------------------ 400/404
test('every :id route answers 400 for a malformed id and 404 for an absent one — never 500', async () => {
  const paths = [
    '/applications/:id', '/environments/:id', '/credentials/:id', '/tests/:id',
    '/runs/:id', '/discovery/:id', '/schedules/:id', '/tests/:id/versions',
    '/tests/:id/history', '/applications/:id/allowed-hosts', '/runs/:id/screenshot',
  ];
  for (const template of paths) {
    for (const bad of ['abc', '-1', '1.5', '0', '%20']) {
      const res = await get(template.replace(':id', bad), 'admin');
      assert.ok([400, 404].includes(res.status), `${template} with "${bad}" → ${res.status}`);
    }
    const missing = await get(template.replace(':id', '99999'), 'admin');
    assert.equal(missing.status, 404, `${template} with an absent id → ${missing.status}`);
  }
});

test('create endpoints answer 400 with the documented contract', async () => {
  const cases = [
    ['/applications', {}],
    ['/environments', {}],
    ['/credentials', {}],
    ['/tests', {}],
    ['/schedules', {}],
    ['/discovery', {}],
  ];
  for (const [path, body] of cases) {
    const res = await request(app()).post(`${BASE}${path}`).set('Authorization', authHeader('admin')).send(body);
    assert.equal(res.status, 400, `POST ${path}`);
    assert.equal(res.body.error, 'Validation failed', `POST ${path}`);
    assert.ok(res.body.details && Object.keys(res.body.details).length, `POST ${path} has no details`);
  }
});

test('a hostile query string is a 4xx, never a 500', async () => {
  const hostile = ['?application_id=abc', '?application_id=1;DROP TABLE', '?status=nope', '?test_id=-1', '?limit=abc'];
  for (const q of hostile) {
    for (const path of ['/applications', '/tests', '/runs', '/schedules', '/discovery', '/suggestions']) {
      const res = await get(`${path}${q}`, 'admin');
      assert.ok(res.status < 500, `GET ${path}${q} → ${res.status}`);
    }
  }
});

// ------------------------------------------------------------------ SSRF
test('an application cannot be pointed at an address the browser must never reach', async () => {
  for (const base_url of ['http://127.0.0.1:3000', 'http://localhost/', 'http://169.254.169.254/', 'file:///etc/passwd']) {
    const res = await request(app()).post(`${BASE}/applications`).set('Authorization', authHeader('admin'))
      .send({ name: 'Evil', base_url });
    assert.equal(res.status, 400, base_url);
    assert.ok(res.body.details.base_url, base_url);
  }
});

test('the allowlist refuses loopback and metadata, caps a range, and accepts a private LAN', async () => {
  const post = (value) => request(app()).post(`${BASE}/applications/1/allowed-hosts`)
    .set('Authorization', authHeader('admin')).send({ value });

  for (const blocked of ['127.0.0.1', '127.0.0.0/8', 'localhost', '169.254.169.254', '0.0.0.0/8']) {
    const res = await post(blocked);
    assert.equal(res.status, 400, blocked);
    assert.match(res.body.details.value, /never be allowlisted|permanently blocked/, blocked);
  }
  const tooWide = await post('10.0.0.0/8');
  assert.equal(tooWide.status, 400);
  assert.match(tooWide.body.details.value, /16,777,216 addresses/);

  // RFC1918 is allowlistable — on-prem applications live there.
  const ok = await post('10.20.0.0/16');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.entry_type, 'cidr');
});

test('the allowlist address cap counts the whole application, not each entry alone', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  const post = (value) => request(scoped).post(`${BASE}/applications/1/allowed-hosts`)
    .set('Authorization', authHeader('admin')).send({ value });

  assert.equal((await post('10.20.0.0/16')).status, 201);
  const second = await post('10.30.0.0/16');
  assert.equal(second.status, 400, 'a second /16 exceeds the 65 536 cap for one application');
  assert.match(second.body.details.value, /131,072 addresses/);
});

test('import validates every row before writing anything, and dry-run writes nothing', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  const imp = (text, query = '') => request(scoped).post(`${BASE}/applications/1/allowed-hosts/import${query}`)
    .set('Authorization', authHeader('admin')).send({ text });

  const bad = await imp('portal.kunde.dk\n127.0.0.1\n10.0.0.0/8');
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details['line 2'], 'the offending line is named');
  assert.ok(bad.body.details['line 3']);
  assert.equal(st.tables.allowedHosts.rows.length, 0, 'one bad row must not leave a half-applied allowlist');

  const dry = await imp('portal.kunde.dk\n10.20.0.0/24', '?dry_run=1');
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.added, 2);
  assert.equal(st.tables.allowedHosts.rows.length, 0, 'a dry run writes nothing');

  const real = await imp('portal.kunde.dk\n10.20.0.0/24');
  assert.equal(real.status, 200);
  assert.equal(st.tables.allowedHosts.rows.length, 2);
});

test('the allowlist exports as CSV with the formula-injection guard intact', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await request(scoped).post(`${BASE}/applications/1/allowed-hosts`).set('Authorization', authHeader('admin'))
    .send({ value: 'portal.kunde.dk', note: '=cmd|calc' });

  const res = await request(scoped).get(`${BASE}/applications/1/allowed-hosts/export.csv`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /^type,value,note/);
  assert.ok(res.text.includes("'=cmd|calc"), 'a note starting with = must not execute when the CSV is opened');
});

// ------------------------------------------------------------------ tests API
test('a test that signs in cannot be saved without a usable credential', async () => {
  const definition = {
    version: 1,
    name: 'Login',
    steps: [{ type: 'fill', target: { label: 'Password' }, value: '{{credential.password}}' }],
  };
  const noCred = await request(app()).post(`${BASE}/tests`).set('Authorization', authHeader('operator'))
    .send({ application_id: 1, name: 'Login', definition });
  assert.equal(noCred.status, 400);
  assert.ok(noCred.body.details.credential_id);

  const withCred = await request(app()).post(`${BASE}/tests`).set('Authorization', authHeader('operator'))
    .send({ application_id: 1, name: 'Login', definition, credential_id: 1 });
  assert.equal(withCred.status, 201, JSON.stringify(withCred.body));
});

test('a credential from another application is refused', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await request(scoped).post(`${BASE}/applications`).set('Authorization', authHeader('admin'))
    .send({ name: 'Other', base_url: 'https://other.example.com' });

  const res = await request(scoped).post(`${BASE}/tests`).set('Authorization', authHeader('operator')).send({
    application_id: 2,
    name: 'Login',
    definition: { version: 1, name: 'Login', steps: [{ type: 'login' }] },
    credential_id: 1,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.details.credential_id, /different application/);
});

test('saving a test bumps its version', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  const res = await request(scoped).put(`${BASE}/tests/1`).set('Authorization', authHeader('operator'))
    .send({ definition: { version: 1, name: 'Customer Login', steps: [{ type: 'open', url: '/login' }, { type: 'refresh' }] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 2);
});

// The dashboard's Edit dialog. Until it existed the designer only ever PUT
// { definition }, so a test's name, description, login and enabled flag were
// set once at creation and unreachable forever after — which is how a test ends
// up called "Untitled" with nobody able to say what it is for.
test('a test can be renamed, re-described, re-credentialled and turned off', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  const res = await request(scoped).put(`${BASE}/tests/1`).set('Authorization', authHeader('operator'))
    .send({ name: 'Customer login', description: 'Checkout breaks without it', credential_id: null, enabled: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Customer login');
  assert.equal(res.body.description, 'Checkout breaks without it');
  assert.equal(res.body.credential_id, null);
  assert.equal(res.body.enabled, false);
  // The steps are the designer's business and must survive an edit that never
  // mentioned them.
  assert.ok(res.body.definition && res.body.definition.steps.length);
});

test('editing and deleting a test answer 400/404 and never 500', async () => {
  const scoped = makeApp({ serviceTests: makeServiceTests() });
  const h = authHeader('operator');
  for (const bad of ['abc', '-1', '0', '1.5']) {
    const put = await request(scoped).put(`${BASE}/tests/${bad}`).set('Authorization', h).send({ name: 'x' });
    assert.ok([400, 404].includes(put.status), `PUT ${bad} → ${put.status}`);
    const del = await request(scoped).delete(`${BASE}/tests/${bad}`).set('Authorization', h);
    assert.ok([400, 404].includes(del.status), `DELETE ${bad} → ${del.status}`);
  }
  assert.equal((await request(scoped).put(`${BASE}/tests/99999`).set('Authorization', h).send({ name: 'x' })).status, 404);
  assert.equal((await request(scoped).delete(`${BASE}/tests/99999`).set('Authorization', h)).status, 404);

  // An empty name is refused rather than stored: a test with no name is one
  // nobody can find again.
  const blank = await request(scoped).put(`${BASE}/tests/1`).set('Authorization', h).send({ name: '   ' });
  assert.equal(blank.status, 400);
  assert.ok(blank.body.details.name);

  assert.equal((await request(scoped).delete(`${BASE}/tests/1`).set('Authorization', h)).status, 204);
  assert.equal((await request(scoped).get(`${BASE}/tests/1`).set('Authorization', h)).status, 404);
});

test('deleting a test is operator-only', async () => {
  const scoped = makeApp({ serviceTests: makeServiceTests() });
  assert.equal((await request(scoped).delete(`${BASE}/tests/1`).set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(scoped).delete(`${BASE}/tests/1`)).status, 401);
});

test('the step catalogue is served rather than duplicated in the browser', async () => {
  const res = await get('/tests/step-types', 'viewer');
  assert.equal(res.status, 200);
  const types = res.body.categories.flatMap((c) => c.steps.map((s) => s.type));
  for (const required of ['open', 'click', 'fill', 'assert_visible', 'wait', 'condition', 'login', 'api_request']) {
    assert.ok(types.includes(required), `the catalogue is missing ${required}`);
  }
});

test('running a test against another application\'s environment is refused', async () => {
  const res = await request(app()).post(`${BASE}/tests/1/run`).set('Authorization', authHeader('operator'))
    .send({ environment_id: 9999 });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.environment_id);
});

// ------------------------------------------------------------------ discovery
test('a discovery is queued, and its budgets can only be tightened, never widened', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  const res = await request(scoped).post(`${BASE}/discovery`).set('Authorization', authHeader('operator'))
    .send({ application_id: 1, budgets: { maxPages: 999999, maxDepth: 2 } });

  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'queued');
  assert.equal(res.body.budgets.maxPages, 100, 'an operator cannot exceed the configured page budget');
  assert.equal(res.body.budgets.maxDepth, 2, 'but may tighten it');
});

test('discovery is refused for a viewer', async () => {
  const res = await request(app()).post(`${BASE}/discovery`).set('Authorization', authHeader('viewer')).send({ application_id: 1 });
  assert.equal(res.status, 403);
});

test('accepting a suggestion creates a test through the same validator a hand-built one uses', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await st.repositories.suggestions.createMany(1, 1, [{
    name: 'Login',
    confidence: 'high',
    reason: 'Detected a password field.',
    proposed_steps: [{ type: 'open', url: '/login' }, { type: 'assert_http_status', status: 200 }],
  }]);

  const accepted = await request(scoped).post(`${BASE}/suggestions/1/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.test.name, 'Login');
  assert.equal(accepted.body.suggestion.status, 'accepted');

  const again = await request(scoped).post(`${BASE}/suggestions/1/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(again.status, 409, 'a suggestion must not be accepted into two tests');
});

test('a suggestion whose proposed steps are invalid is refused rather than creating a broken test', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await st.repositories.suggestions.createMany(1, 1, [{ name: 'Bad', proposed_steps: [{ type: 'open', url: 'file:///etc/passwd' }] }]);

  const res = await request(scoped).post(`${BASE}/suggestions/1/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 400);
  assert.equal(st.tables.tests.rows.length, 1, 'no test was created');
});

// ------------------------------------------------------------------ schedules
test('a schedule only accepts the offered cadences', async () => {
  for (const interval of [42, 1, 0, -300, 'often']) {
    const res = await request(app()).post(`${BASE}/schedules`).set('Authorization', authHeader('operator'))
      .send({ test_id: 1, interval_sec: interval });
    assert.equal(res.status, 400, String(interval));
  }
  const ok = await request(app()).post(`${BASE}/schedules`).set('Authorization', authHeader('operator'))
    .send({ test_id: 1, interval_sec: 300, timezone: 'Europe/Copenhagen' });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.next_run_at, 'the response says when it fires next');
  assert.match(ok.body.description, /5\./);
});

test('an unrecognised timezone is refused', async () => {
  const res = await request(app()).post(`${BASE}/schedules`).set('Authorization', authHeader('operator'))
    .send({ test_id: 1, interval_sec: 300, timezone: 'Mars/Olympus' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.timezone);
});

// ------------------------------------------------------------------ settings
test('settings are stored in the database and bounded — a limit cannot be set outside its range', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });

  const bad = await request(scoped).put(`${BASE}/settings/allowlist`).set('Authorization', authHeader('admin'))
    .send({ minCidrPrefix: 4 });
  assert.equal(bad.status, 400);

  const ok = await request(scoped).put(`${BASE}/settings/discovery`).set('Authorization', authHeader('admin'))
    .send({ maxPages: 25 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.maxPages, 25);
  assert.equal((await request(scoped).get(`${BASE}/settings/discovery`).set('Authorization', authHeader('viewer'))).body.maxPages, 25);
});

test('settings writes are admin-only and an unknown section is 404', async () => {
  for (const role of ['viewer', 'operator']) {
    const res = await request(app()).put(`${BASE}/settings/discovery`).set('Authorization', authHeader(role)).send({ maxPages: 10 });
    assert.equal(res.status, 403, role);
  }
  assert.equal((await get('/settings/nosuchsection', 'admin')).status, 404);
  const res = await request(app()).put(`${BASE}/settings/nosuchsection`).set('Authorization', authHeader('admin')).send({ x: 1 });
  assert.equal(res.status, 404);
});

test('a settings reset returns the section to its shipped defaults', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await request(scoped).put(`${BASE}/settings/runner`).set('Authorization', authHeader('admin')).send({ concurrency: 9 });
  const reset = await request(scoped).post(`${BASE}/settings/runner/reset`).set('Authorization', authHeader('admin')).send({});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.concurrency, 2);
});

// ------------------------------------------------------------------ runs
test('a run with no screenshot answers 404 rather than an empty image', async () => {
  const st = makeServiceTests();
  const scoped = makeApp({ serviceTests: st });
  await request(scoped).post(`${BASE}/tests/1/run`).set('Authorization', authHeader('operator')).send({});
  assert.equal((await request(scoped).get(`${BASE}/runs/1/screenshot`).set('Authorization', authHeader('viewer'))).status, 404);
});

test('worker status tells the UI whether anything is processing the queue', async () => {
  const res = await get('/runs/worker-status', 'viewer');
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false, 'nothing is running, so no worker is connected');
  assert.deepEqual(res.body.workers, []);
  assert.equal(res.body.worker_count, 0);
});

test('a worker that has only sent a heartbeat is reported as connected', async () => {
  // Without this, the dashboard tells an operator to install the worker that is
  // already running — it just has not been given anything to claim yet.
  const st = makeServiceTests();
  await st.queue.heartbeat({ workerId: 'assurance-1-12', hostname: 'assurance-1', version: '0.120.4' });
  const res = await request(makeApp({ serviceTests: st })).get(`${BASE}/runs/worker-status`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.worker_count, 1);
  assert.equal(res.body.workers[0].hostname, 'assurance-1');
});

// ------------------------------------------------------------------- stats
test('the history chart reads runs as buckets, empty ones included', async () => {
  const st = makeServiceTests();
  // Two runs on the 11th, one on the 13th, in a week with seven days.
  st.tables.runs.insert({ test_id: 1, status: 'pass', duration_ms: 1000, started_at: '2026-09-11T08:00:00Z', created_at: '2026-09-11T08:00:00Z' });
  st.tables.runs.insert({ test_id: 1, status: 'fail', duration_ms: 3000, started_at: '2026-09-11T09:00:00Z', created_at: '2026-09-11T09:00:00Z' });
  st.tables.runs.insert({ test_id: 1, status: 'pass', duration_ms: 2000, started_at: '2026-09-13T09:00:00Z', created_at: '2026-09-13T09:00:00Z' });

  const res = await request(makeApp({ serviceTests: st }))
    .get(`${BASE}/stats?period=week&at=2026-09-11&tz_offset=0`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.period, 'week');
  assert.equal(res.body.bucket, 'day');
  assert.equal(res.body.at, '2026-09-07');
  assert.equal(res.body.buckets.length, 7, 'a week is seven bars, however few of them have runs');

  const eleventh = res.body.buckets.find((b) => b.key === '2026-09-11 00:00');
  assert.equal(eleventh.total, 2);
  assert.equal(eleventh.pass, 1);
  assert.equal(eleventh.fail, 1);
  assert.equal(eleventh.avg_duration_ms, 2000);

  // A day with no runs is a gap the operator needs to see, not a missing bar.
  const twelfth = res.body.buckets.find((b) => b.key === '2026-09-12 00:00');
  assert.equal(twelfth.total, 0);
  assert.equal(twelfth.avg_duration_ms, null);

  assert.equal(res.body.totals.total, 3);
  assert.equal(res.body.totals.pass, 2);
  assert.equal(Math.round(res.body.totals.success_rate * 100), 67);
  assert.equal(res.body.prev_at, '2026-08-31');
  assert.equal(res.body.next_at, '2026-09-14');
});

test('an empty period reports no runs rather than a perfect score', async () => {
  const res = await get('/stats?period=year&at=1999-01-01&tz_offset=0', 'viewer');
  assert.equal(res.status, 200);
  assert.equal(res.body.buckets.length, 12);
  assert.equal(res.body.totals.total, 0);
  assert.equal(res.body.totals.success_rate, null, '0 of 0 is not 100%');
  assert.equal(res.body.totals.avg_duration_ms, null);
});

test('stats narrows to one test, and to one application', async () => {
  const st = makeServiceTests();
  st.tables.tests.insert({ application_id: 1, name: 'Second', definition: { version: 1, name: 'Second', steps: [] }, version: 1, enabled: 1 });
  st.tables.runs.insert({ test_id: 1, status: 'pass', duration_ms: 10, started_at: '2026-09-11T08:00:00Z', created_at: '2026-09-11T08:00:00Z' });
  st.tables.runs.insert({ test_id: 2, status: 'fail', duration_ms: 20, started_at: '2026-09-11T08:00:00Z', created_at: '2026-09-11T08:00:00Z' });
  const app = makeApp({ serviceTests: st });

  const one = await request(app).get(`${BASE}/stats?period=day&at=2026-09-11&tz_offset=0&test_id=1`).set('Authorization', authHeader('viewer'));
  assert.equal(one.body.totals.total, 1);
  assert.equal(one.body.test_id, 1);

  const both = await request(app).get(`${BASE}/stats?period=day&at=2026-09-11&tz_offset=0&application_id=1`).set('Authorization', authHeader('viewer'));
  assert.equal(both.body.totals.total, 2, 'both tests belong to application 1');
});

test('stats answers 400 for a bad query and 404 for a test that does not exist', async () => {
  const bad = [
    '?period=decade', '?at=11-09-2026', '?at=garbage', '?tz_offset=9999', '?tz_offset=abc',
    '?test_id=abc', '?test_id=-1', '?application_id=0',
  ];
  for (const q of bad) {
    const res = await get(`/stats${q}`, 'viewer');
    assert.equal(res.status, 400, `GET /stats${q} → ${res.status}`);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(res.body.details && Object.keys(res.body.details).length, `GET /stats${q} gave no reason`);
  }
  assert.equal((await get('/stats?test_id=99999', 'viewer')).status, 404);
  assert.equal((await get('/stats?application_id=99999', 'viewer')).status, 404);
});

test('stats defaults to this week and is readable by a viewer, not by an anonymous caller', async () => {
  const res = await get('/stats', 'viewer');
  assert.equal(res.status, 200);
  assert.equal(res.body.period, 'week');
  assert.equal(res.body.buckets.length, 7);
  assert.equal((await request(app()).get(`${BASE}/stats`)).status, 401);
});

test('an oversized body is refused before it reaches a handler', async () => {
  const res = await request(app()).post(`${BASE}/applications`).set('Authorization', authHeader('admin'))
    .send({ name: 'X', base_url: 'https://x.example.com', description: 'y'.repeat(2 * 1024 * 1024) });
  assert.ok(res.status >= 400 && res.status < 500, `→ ${res.status}`);
});

// ------------------------------------------------------------- assurance
test('assurance reads are viewer+, and every filter refuses a value it does not know', async () => {
  for (const path of ['/assurance/incidents', '/assurance/certificates', '/assurance/summary']) {
    assert.equal((await get(path, 'viewer')).status, 200, `GET ${path}`);
  }
  const bad = [
    '/assurance/incidents?status=exploded',
    '/assurance/incidents?severity=URGENT',
    '/assurance/incidents?subject_type=router',
    '/assurance/incidents?application_id=abc',
    '/assurance/incidents?limit=-1',
    '/assurance/certificates?status=probably',
    '/assurance/certificates?application_id=1;drop',
  ];
  for (const path of bad) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await get(path, 'viewer')).status, 400, `GET ${path}`);
  }
  // An empty filter is "no filter", not a bad one — that is what a cleared
  // dropdown sends.
  assert.equal((await get('/assurance/incidents?status=&application_id=', 'viewer')).status, 200);
});

test('an incident that does not exist is 404, and a malformed id is 400', async () => {
  assert.equal((await get('/assurance/incidents/999', 'viewer')).status, 404);
  assert.equal((await get('/assurance/incidents/not-a-number', 'viewer')).status, 400);
  for (const role of ['viewer', 'operator', 'admin']) {
    const res = await request(app()).post(`${BASE}/assurance/incidents/999/resolve`)
      .set('Authorization', authHeader(role)).send({});
    assert.equal(res.status, role === 'viewer' ? 403 : 404, `${role} resolve`);
  }
});

test('anonymous callers get 401 from every assurance path', async () => {
  for (const path of ['/assurance/incidents', '/assurance/certificates', '/assurance/summary', '/assurance/incidents/1']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await request(app()).get(`${BASE}${path}`)).status, 401, path);
  }
  assert.equal((await request(app()).post(`${BASE}/assurance/certificates/check`).send({})).status, 401);
});

test('the reactor surfaces an expired certificate through the API, and an operator can resolve it', async () => {
  const st = makeServiceTests({
    certificates_seen: {
      'customer.example.com': { status: 'expired', days_remaining: -4, valid_to: new Date(Date.now() - 4 * 86400000), issuer: 'O=Test CA' },
    },
  });
  const scoped = makeApp({ serviceTests: st });
  const auth = (role) => authHeader(role);

  const check = await request(scoped).post(`${BASE}/assurance/certificates/check`).set('Authorization', auth('operator')).send({});
  assert.equal(check.status, 200);
  assert.equal(check.body.checked, 1);

  const certs = await request(scoped).get(`${BASE}/assurance/certificates`).set('Authorization', auth('viewer'));
  assert.equal(certs.status, 200);
  assert.equal(certs.body[0].status, 'expired');

  const incidents = await request(scoped).get(`${BASE}/assurance/incidents?status=open`).set('Authorization', auth('viewer'));
  assert.equal(incidents.body.length, 1);
  assert.equal(incidents.body[0].kind, 'certificate_expired');
  assert.equal(incidents.body[0].severity, 'CRIT');
  assert.match(incidents.body[0].summary, /expired 4 days ago/);

  const summary = await request(scoped).get(`${BASE}/assurance/summary`).set('Authorization', auth('viewer'));
  assert.equal(summary.body.open.CRIT, 1);
  assert.equal(summary.body.certificates.broken, 1);

  const id = incidents.body[0].id;
  assert.equal((await request(scoped).post(`${BASE}/assurance/incidents/${id}/resolve`).set('Authorization', auth('viewer')).send({})).status, 403);
  const resolved = await request(scoped).post(`${BASE}/assurance/incidents/${id}/resolve`).set('Authorization', auth('operator'))
    .send({ resolution: 'Renewed this morning' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, 'resolved');
  assert.equal(resolved.body.resolution, 'Renewed this morning');
  // Resolving twice is a 400, not a silent success or a 500.
  assert.equal((await request(scoped).post(`${BASE}/assurance/incidents/${id}/resolve`).set('Authorization', auth('operator')).send({})).status, 400);
});

test('a forced check for an unknown application is 404, and a malformed id is 400', async () => {
  const scoped = makeApp({ serviceTests: makeServiceTests() });
  const post = (body) => request(scoped).post(`${BASE}/assurance/certificates/check`).set('Authorization', authHeader('operator')).send(body);
  assert.equal((await post({ application_id: 999 })).status, 404);
  assert.equal((await post({ application_id: 'x' })).status, 400);
  assert.equal((await post({ application_id: 1 })).status, 200);
  assert.equal((await post({})).status, 200);
});

test('a deployment with no reactor answers 503 rather than 500', async () => {
  const scoped = makeApp({ serviceTests: makeServiceTests({ reactor: null }) });
  const res = await request(scoped).post(`${BASE}/assurance/certificates/check`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 503);
});

test('a certificate check that throws is a 502, never an unhandled 500', async () => {
  const scoped = makeApp({
    serviceTests: makeServiceTests({
      certificateChecker: { check: () => Promise.reject(new Error('the network is on fire')) },
    }),
  });
  // The sweep swallows a per-target failure, so this still succeeds — the point
  // is that a thrown checker never reaches the error handler as a 500.
  const res = await request(scoped).post(`${BASE}/assurance/certificates/check`).set('Authorization', authHeader('operator')).send({});
  assert.ok([200, 502].includes(res.status), `→ ${res.status}`);
});

// --------------------------------------- top applications by critical count
// The Health page's ranking: "which services gave us the most trouble this
// period", over a chosen window, optionally narrowed to chosen applications.

async function withRankedIncidents() {
  const st = makeServiceTests({
    applications: [
      { name: 'Customer Portal', base_url: 'https://portal.example.com', enabled: 1 },
      { name: 'Billing', base_url: 'https://billing.example.com', enabled: 1 },
      { name: 'Quiet App', base_url: 'https://quiet.example.com', enabled: 1 },
    ],
  });
  const open = (applicationId, severity, at) => st.repositories.incidents.open({
    application_id: applicationId,
    subject_type: 'test',
    subject_key: `test:${applicationId}:${Math.random()}`,
    subject_label: 'x',
    kind: 'http_503',
    severity,
    summary: 'down',
    at,
  });
  const now = new Date();
  for (let i = 0; i < 3; i += 1) await open(1, 'CRIT', now);
  await open(2, 'CRIT', now);
  await open(2, 'WARN', now);       // a WARN must not rank as a critical
  await open(3, 'WARN', now);       // and an app with only WARNs must not appear
  return st;
}

const topUrl = (qs = '') => `/assurance/top-applications${qs}`;

test('the ranking is by critical count, descending, and WARNs do not count', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const res = await request(scoped).get(`${BASE}${topUrl('?period=month')}`).set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.period, 'month');
  assert.deepEqual(res.body.applications.map((a) => [a.application_name, a.incidents]),
    [['Customer Portal', 3], ['Billing', 1]]);
  assert.equal(res.body.total, 4);
  assert.ok(!res.body.applications.some((a) => a.application_name === 'Quiet App'),
    'an application with only warnings is not in a criticals ranking');
});

test('the default period is a month — the question the Health page asks', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const res = await request(scoped).get(`${BASE}${topUrl()}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.period, 'month');
  assert.ok(res.body.from && res.body.to && res.body.prev_at, 'the window and its neighbours come from the server');
});

test('the selection narrows the ranking, and an EMPTY selection means none', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const one = await request(scoped).get(`${BASE}${topUrl('?application_ids=2')}`).set('Authorization', authHeader('viewer'));
  assert.deepEqual(one.body.applications.map((a) => a.application_name), ['Billing']);

  // "Show me none of them" is a legitimate thing for a multi-select to say, and
  // answering it with everything would be a lie.
  const none = await request(scoped).get(`${BASE}${topUrl('?application_ids=')}`).set('Authorization', authHeader('viewer'));
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.applications, []);
});

test('every query parameter is validated rather than coerced', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const bad = [
    '?period=fortnight', '?at=last-tuesday', '?at=2026-13-45', '?tz_offset=9999',
    '?severity=URGENT', '?limit=0', '?limit=abc', '?limit=999',
    '?application_ids=1,abc', '?application_ids=-1',
  ];
  for (const qs of bad) {
    const res = await request(scoped).get(`${BASE}${topUrl(qs)}`).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 400, `${qs} → ${res.status}`);
  }
});

test('the ranking is viewer-readable and never anonymous', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  assert.equal((await request(scoped).get(`${BASE}${topUrl()}`)).status, 401);
  for (const role of ['viewer', 'operator', 'admin']) {
    const res = await request(scoped).get(`${BASE}${topUrl()}`).set('Authorization', authHeader(role));
    assert.equal(res.status, 200, role);
  }
});

test('a period with no criticals is an empty ranking, not an error', async () => {
  // Good news has to be representable: an empty list is the answer, and the UI
  // says so in words rather than drawing an empty chart area.
  const scoped = makeApp({ serviceTests: makeServiceTests() });
  const res = await request(scoped).get(`${BASE}${topUrl('?period=year')}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applications, []);
  assert.equal(res.body.total, 0);
});

test('the ranking also comes back as a line per application, with zero buckets filled in', async () => {
  // A line that skips its empty buckets lies about when the trouble was: "it
  // was quiet all week and then Thursday happened" only exists if Monday to
  // Wednesday are in the answer as zeroes.
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const res = await request(scoped).get(`${BASE}${topUrl('?period=month')}`).set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.ok(res.body.buckets.length > 20, 'a month of day buckets');
  assert.ok(res.body.series.length >= 2);

  const [worst] = res.body.series;
  assert.equal(worst.application_name, 'Customer Portal',
    'series are ordered by the ranking, so palette slot 1 is the worst offender');
  assert.equal(worst.total, 3);
  assert.equal(worst.points.length, res.body.buckets.length, 'one point per bucket, zeroes included');
  assert.equal(worst.points.reduce((a, b) => a + b, 0), 3);
  assert.ok(worst.points.some((p) => p === 0), 'the quiet days are in the answer');
});

test('choosing applications decides which lines are drawn', async () => {
  const scoped = makeApp({ serviceTests: await withRankedIncidents() });
  const res = await request(scoped).get(`${BASE}${topUrl('?application_ids=2')}`).set('Authorization', authHeader('viewer'));
  assert.deepEqual(res.body.series.map((s) => s.application_name), ['Billing']);

  // An empty selection draws nothing — same rule as the ranking.
  const none = await request(scoped).get(`${BASE}${topUrl('?application_ids=')}`).set('Authorization', authHeader('viewer'));
  assert.deepEqual(none.body.series, []);
});

test('a period with nothing in it has buckets but no series', async () => {
  const scoped = makeApp({ serviceTests: makeServiceTests() });
  const res = await request(scoped).get(`${BASE}${topUrl('?period=week')}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.buckets.length, 7);
  assert.deepEqual(res.body.series, []);
});
