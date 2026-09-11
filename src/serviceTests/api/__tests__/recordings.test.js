'use strict';

// HTTP specs for Recording (V2 §1). Two surfaces with opposite postures, so the
// spec is written around the seam between them:
//
//   /api/service-tests/recordings   session + licence + RBAC, like everything else
//   /api/service-capture/*          no session at all — the capture token IS the
//                                   authority, and these tests are what keeps
//                                   that from quietly becoming "no authority"
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 on every route, and never
// a 500.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/recordings';
const CAPTURE = '/api/service-capture';

// One module instance per test that needs to inspect the table afterwards.
function fixture() {
  const serviceTests = makeServiceTests();
  return { serviceTests, app: makeApp({ serviceTests }) };
}

async function startRecording(app, role = 'operator', body = { application_id: 1, name: 'Customer Login' }) {
  return request(app).post(BASE).set('Authorization', authHeader(role)).send(body);
}

// ------------------------------------------------------------------ 401 / 403
test('the operator surface is licence-gated, anonymous-401 and viewer-403', async () => {
  const { app } = fixture();
  assert.equal((await request(app).get(BASE)).status, 401, 'anonymous read');
  assert.equal((await request(app).post(BASE).send({ application_id: 1, name: 'x' })).status, 401, 'anonymous write');

  assert.equal((await request(app).get(BASE).set('Authorization', authHeader('viewer'))).status, 200, 'viewers may read');
  assert.equal((await startRecording(app, 'viewer')).status, 403, 'viewers may not record');

  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });
  const gated = await request(unlicensed).get(BASE).set('Authorization', authHeader('admin'));
  assert.equal(gated.status, 403);
  assert.equal(gated.body.error, 'feature_not_available');
});

// ------------------------------------------------------------------ 400
test('starting a recording validates the application and the name (400, never 500)', async () => {
  const { app } = fixture();
  for (const body of [{}, { application_id: 1 }, { name: 'x' }, { application_id: 'abc', name: 'x' }, { application_id: 1, name: '   ' }]) {
    const res = await startRecording(app, 'operator', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'Validation failed');
  }
  const missingApp = await startRecording(app, 'operator', { application_id: 9999, name: 'x' });
  assert.equal(missingApp.status, 400);
  assert.match(missingApp.body.details.application_id, /does not exist/);

  // A session that never ends is the thing the expiry exists to prevent.
  const tooLong = await startRecording(app, 'operator', { application_id: 1, name: 'x', ttl_minutes: 10000 });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.details.ttl_minutes, /1 and 240/);

  for (const body of ['[]', '"str"', 'null', '123']) {
    const res = await request(app).post(BASE).set('Authorization', authHeader('operator'))
      .set('Content-Type', 'application/json').send(body);
    assert.ok(res.status < 500, `body ${body} → ${res.status}`);
  }
});

// ------------------------------------------------------------------ 404
test('an unknown or malformed recording id is 404/400 on every route, never 500', async () => {
  const { app } = fixture();
  const header = authHeader('operator');
  for (const [method, path] of [['get', '/999999'], ['delete', '/999999'], ['post', '/999999/stop'], ['post', '/999999/accept']]) {
    const res = await request(app)[method](`${BASE}${path}`).set('Authorization', header).send({});
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  for (const id of ['abc', '1;DROP', '-1', '1e309', '%00']) {
    for (const [method, suffix] of [['get', ''], ['delete', ''], ['post', '/stop'], ['post', '/accept']]) {
      const res = await request(app)[method](`${BASE}/${id}${suffix}`).set('Authorization', header).send({});
      assert.ok(res.status < 500, `${method} id=${id} → ${res.status}`);
    }
  }
});

// ------------------------------------------------------------------ the token
test('the capture token is returned exactly once and is never readable afterwards', async () => {
  const { serviceTests, app } = fixture();
  const started = await startRecording(app);
  assert.equal(started.status, 201);
  const token = started.body.token;
  assert.ok(token && token.length > 20, 'a token was minted');
  assert.match(started.body.bookmarklet, /^javascript:/);
  assert.ok(started.body.capture_url.endsWith(CAPTURE));

  // Not in the table: only its hash is.
  const stored = serviceTests.tables.recordings.rows[0];
  assert.equal(stored.token_hash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(token), 'the plaintext token reached the database');

  // Not in any later read, either.
  const reread = await request(app).get(`${BASE}/${started.body.id}`).set('Authorization', authHeader('operator'));
  assert.equal(reread.status, 200);
  assert.equal(reread.body.token, undefined);
  assert.ok(!JSON.stringify(reread.body).includes(token), 'a read handed the token back');

  const listed = await request(app).get(BASE).set('Authorization', authHeader('viewer'));
  assert.ok(!JSON.stringify(listed.body).includes(token), 'the list handed the token back');
});

test('the bookmarklet never embeds a host the caller supplied', async () => {
  const { app } = fixture();
  const forged = await request(app).post(BASE)
    .set('Authorization', authHeader('operator'))
    .set('Host', 'evil.example.com"></script><script>alert(1)</script>')
    .send({ application_id: 1, name: 'x' });
  // Supertest may refuse the header outright; when it does not, the guard must.
  if (forged.status === 201) {
    assert.ok(!/alert\(1\)/.test(decodeURIComponent(forged.body.bookmarklet)), 'a forged Host reached the bookmarklet');
  }
});

// ------------------------------------------------------------------ ingest
test('capture ingest: no token, wrong token, expired and stopped recordings are all 401', async () => {
  const { serviceTests, app } = fixture();
  const started = await startRecording(app);
  const token = started.body.token;

  for (const body of [{}, { events: [] }, { token: '' }, { token: 'not-a-real-token' }, { token: 'x'.repeat(200) }]) {
    const res = await request(app).post(`${CAPTURE}/events`).send(body);
    assert.equal(res.status, 401, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'Unauthorized' }, 'the 401 must not say which part was wrong');
  }
  // A user JWT is not a capture token, and never becomes one.
  const withJwt = await request(app).post(`${CAPTURE}/events`).set('Authorization', authHeader('admin')).send({ events: [] });
  assert.equal(withJwt.status, 401);

  // A good token works…
  assert.equal((await request(app).post(`${CAPTURE}/events`).send({ token, events: [] })).status, 200);

  // …until the recording is stopped from the dashboard.
  await request(app).post(`${BASE}/${started.body.id}/stop`).set('Authorization', authHeader('operator')).send({});
  assert.equal((await request(app).post(`${CAPTURE}/events`).send({ token, events: [] })).status, 401);

  // And an expired one is dead even while it still says `recording`.
  const second = await startRecording(app, 'operator', { application_id: 1, name: 'Second' });
  serviceTests.tables.recordings.update(second.body.id, { expires_at: new Date(Date.now() - 1000) });
  assert.equal((await request(app).post(`${CAPTURE}/events`).send({ token: second.body.token, events: [] })).status, 401);
});

test('capture ingest never 500s on a malformed body, and drops what it does not understand', async () => {
  const { serviceTests, app } = fixture();
  const { token, id } = (await startRecording(app)).body;

  for (const body of ['[]', '"str"', 'null', '123', '{"token":1}']) {
    const res = await request(app).post(`${CAPTURE}/events`).set('Content-Type', 'application/json').send(body);
    assert.ok(res.status < 500, `${body} → ${res.status}`);
  }
  const bad = await request(app).post(`${CAPTURE}/events`).send({ token, events: 'not-a-list' });
  assert.equal(bad.status, 400);

  await request(app).post(`${CAPTURE}/events`).send({
    token,
    events: [
      null, 42, 'nope',
      { kind: 'teleport', target: { id: 'x' } },          // unknown kind
      { kind: 'click' },                                   // nothing to point at
      { kind: 'click', target: { id: 'save', onclick: 'alert(1)' } }, // unknown key
    ],
  });
  const row = serviceTests.tables.recordings.find(id);
  assert.equal(row.event_count, 1, 'only the one usable event survived');
  assert.deepEqual(row.events[0].target, { id: 'save' }, 'an unrecognised key was stored');
});

test('a password value never reaches the database, even when the recorder sends one', async () => {
  const { serviceTests, app } = fixture();
  const { token, id } = (await startRecording(app)).body;

  // The recorder is written to send `value: null` here. This is what happens
  // when something else does the sending — the rule lives on the server.
  await request(app).post(`${CAPTURE}/events`).send({
    token,
    events: [
      { kind: 'input', inputType: 'password', target: { label: 'Kodeord', id: 'pw' }, value: 'hunter2-correct-horse' },
      { kind: 'input', inputType: 'text', target: { label: 'Adgangskode', id: 'pw2' }, value: 'also-a-secret' },
      { kind: 'input', inputType: 'text', target: { label: 'Kundenummer', id: 'cust' }, value: '4711' },
    ],
  });
  const stored = JSON.stringify(serviceTests.tables.recordings.find(id));
  assert.ok(!stored.includes('hunter2-correct-horse'), 'a password field value was stored');
  assert.ok(!stored.includes('also-a-secret'), 'a password-named field value was stored');
  assert.ok(stored.includes('4711'), 'an ordinary field should still be recorded');

  // And what the operator sees is the credential reference, not a literal.
  const preview = await request(app).get(`${BASE}/${id}`).set('Authorization', authHeader('operator'));
  const fills = preview.body.definition.steps.filter((s) => s.type === 'fill');
  assert.ok(fills.some((s) => s.value === '{{credential.password}}'));
  assert.ok(!JSON.stringify(preview.body).includes('hunter2-correct-horse'));
});

test('CORS is opened for the origin but never for credentials', async () => {
  const { app } = fixture();
  const res = await request(app).post(`${CAPTURE}/events`).set('Origin', 'https://kunde.example.com').send({});
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-credentials'], undefined,
    'allowing credentials would let a browser attach cookies to the capture path');
  const preflight = await request(app).options(`${CAPTURE}/events`).set('Origin', 'https://kunde.example.com');
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
});

// ------------------------------------------------------------------ accept
test('a recording becomes an ordinary test, through the ordinary validator', async () => {
  const { serviceTests, app } = fixture();
  const { token, id } = (await startRecording(app)).body;

  await request(app).post(`${CAPTURE}/events`).send({
    token,
    events: [
      { kind: 'navigate', at: 1, url: 'https://customer.example.com/login' },
      { kind: 'input', at: 2, inputType: 'text', target: { label: 'Brugernavn', id: 'u' }, value: 'svc-test' },
      { kind: 'input', at: 3, inputType: 'password', target: { label: 'Kodeord', id: 'p' }, value: null },
      { kind: 'click', at: 4, target: { role: 'button', name: 'Log ind' }, tagName: 'BUTTON' },
    ],
  });

  // The journey signs in, so a login must be attached — see the credential spec
  // below for what happens when one is not.
  const accepted = await request(app).post(`${BASE}/${id}/accept`)
    .set('Authorization', authHeader('operator')).send({ name: 'Customer Login (recorded)', credential_id: 1 });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.name, 'Customer Login (recorded)');

  const steps = accepted.body.definition.steps;
  assert.deepEqual(steps.map((s) => s.type), ['open', 'fill', 'fill', 'click']);
  assert.equal(steps[0].url, '/login', 'the recorded URL must be a path, not pinned to one environment');
  assert.equal(steps[1].value, '{{credential.username}}');
  assert.equal(steps[2].value, '{{credential.password}}');

  // The recording is spent, and the raw capture is gone with it.
  const row = serviceTests.tables.recordings.find(id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.created_test_id, accepted.body.id);
  assert.deepEqual(row.events, [], 'the raw observations outlived the recording');

  // Accepting twice is a 400, not a second test.
  const again = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(again.status, 400);
});

test('an empty recording cannot be saved as a test', async () => {
  const { app } = fixture();
  const { id } = (await startRecording(app)).body;
  const res = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.details.steps, /captured no steps/);
});

test('accepting is an operator action, and deleting removes the recording', async () => {
  const { serviceTests, app } = fixture();
  const { id } = (await startRecording(app)).body;
  assert.equal((await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('viewer')).send({})).status, 403);
  assert.equal((await request(app).delete(`${BASE}/${id}`).set('Authorization', authHeader('viewer'))).status, 403);

  assert.equal((await request(app).delete(`${BASE}/${id}`).set('Authorization', authHeader('operator'))).status, 204);
  assert.equal(serviceTests.tables.recordings.find(id), null);
  assert.equal((await request(app).get(`${BASE}/${id}`).set('Authorization', authHeader('operator'))).status, 404);
});

// ------------------------------------------------------------------ 500
test('a repository failure is a 500 with no detail, not a leak', async () => {
  const serviceTests = makeServiceTests();
  serviceTests.repositories.recordings.list = async () => { throw new Error('SELECT service_test_recordings failed: ECONNREFUSED 10.0.0.5:3306'); };
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

test('a recorded login journey cannot be saved without a login attached', async () => {
  const { app } = fixture();
  const { token, id } = (await startRecording(app)).body;
  await request(app).post(`${CAPTURE}/events`).send({
    token,
    events: [
      { kind: 'navigate', at: 1, url: 'https://customer.example.com/login' },
      { kind: 'input', at: 2, inputType: 'password', target: { label: 'Kodeord', id: 'p' }, value: null },
    ],
  });

  // Saving it bare would produce a test that runs and types the literal
  // "{{credential.password}}" into the password box.
  const bare = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(bare.status, 400);
  assert.match(bare.body.details.credential_id, /signs in/);

  // A login from a different application is refused too.
  const wrong = await request(app).post(`${BASE}/${id}/accept`)
    .set('Authorization', authHeader('operator')).send({ credential_id: 9999 });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.details.credential_id, /does not exist/);

  const saved = await request(app).post(`${BASE}/${id}/accept`)
    .set('Authorization', authHeader('operator')).send({ credential_id: 1 });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.credential_id, 1);
});

test('an operator can see which logins to attach without being an administrator', async () => {
  const { app } = fixture();
  // The flat /credentials list is admin-only; the review screen reads the
  // application instead, which is open to viewers and carries the same logins.
  assert.equal((await request(app).get('/api/service-tests/credentials').set('Authorization', authHeader('operator'))).status, 403);
  const viaApp = await request(app).get('/api/service-tests/applications/1').set('Authorization', authHeader('operator'));
  assert.equal(viaApp.status, 200);
  assert.ok(viaApp.body.credentials.length);
  assert.equal(viaApp.body.credentials[0].has_secret, true);
  assert.ok(!JSON.stringify(viaApp.body.credentials).includes('hunter2-correct-horse'), 'the secret itself must never be listed');
});

test('the capture ingest can be rate limited, and the limiter runs before the token is read', async () => {
  const { createRecordingsCaptureRouter } = require('../recordings');
  const express = require('express');
  const seen = [];
  const limited = express();
  limited.use(express.json());
  limited.use('/api/service-capture', createRecordingsCaptureRouter({
    repositories: { recordings: { async findByToken() { throw new Error('the limiter must answer first'); } } },
    rateLimit: (req, res) => { seen.push(req.path); res.status(429).json({ error: 'Too many requests' }); },
  }));

  const res = await request(limited).post('/api/service-capture/events').send({ token: 'anything' });
  assert.equal(res.status, 429);
  assert.deepEqual(seen, ['/events'], 'the limiter must run before the repository is touched');

  // A preflight is answered before the limiter: a browser that cannot preflight
  // cannot retry, and rate-limiting OPTIONS buys nothing.
  const preflight = await request(limited).options('/api/service-capture/events');
  assert.equal(preflight.status, 204);
});
