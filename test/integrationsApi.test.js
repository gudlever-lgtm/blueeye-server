'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIntegrationsRepo, makeIntegrationsDispatcher, authHeader, throwingAsync } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

const SN = { type: 'servicenow', name: 'SN', baseUrl: 'https://acme.service-now.com', authType: 'basic', credentials: { username: 'svc', password: 'pw' }, config: { table: 'incident' } };

function create(app, body, who = admin) {
  return request(app).post('/api/integrations').set('Authorization', who()).send(body);
}

// ---- AuthN / AuthZ --------------------------------------------------------

test('GET /api/integrations without a token -> 401', async () => {
  const res = await request(makeApp()).get('/api/integrations');
  assert.equal(res.status, 401);
});

test('GET /api/integrations as viewer -> 403; as operator -> 403 (admin only)', async () => {
  assert.equal((await request(makeApp()).get('/api/integrations').set('Authorization', viewer())).status, 403);
  assert.equal((await request(makeApp()).get('/api/integrations').set('Authorization', operator())).status, 403);
});

// ---- Create + redaction ---------------------------------------------------

test('POST creates an integration; credentials are encrypted at rest and never returned', async () => {
  const repo = makeIntegrationsRepo();
  const app = makeApp({ integrationsRepo: repo });
  const res = await create(app, SN);
  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'servicenow');
  // Response carries no credentials of any kind.
  assert.equal(res.body.credentials_encrypted, undefined);
  assert.equal(res.body.credentials, undefined);
  assert.ok(!JSON.stringify(res.body).includes('pw'));
  // ...but the repo stored an encrypted secret-box token (encryption at rest).
  assert.ok(repo.rows[0].credentials_encrypted.startsWith('v1.gcm.'));
  assert.ok(!repo.rows[0].credentials_encrypted.includes('pw'));
});

test('GET list and GET :id never include credentials', async () => {
  const app = makeApp();
  await create(app, SN);
  const list = await request(app).get('/api/integrations').set('Authorization', admin());
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).toLowerCase().includes('credential'));
  const one = await request(app).get('/api/integrations/1').set('Authorization', admin());
  assert.equal(one.status, 200);
  assert.equal(one.body.credentials_encrypted, undefined);
});

// ---- Validation -----------------------------------------------------------

test('POST with missing required fields -> 400', async () => {
  const res = await create(makeApp(), { type: 'servicenow' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.name);
  assert.ok(res.body.details.baseUrl);
});

test('POST with an unknown type -> 400', async () => {
  const res = await create(makeApp(), { ...SN, type: 'frobnicate' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.type, /unknown/);
});

test('POST with an unsupported authType for the type -> 400', async () => {
  const res = await create(makeApp(), { ...SN, authType: 'token' }); // servicenow = basic|oauth2
  assert.equal(res.status, 400);
  assert.ok(res.body.details.authType);
});

test('POST with an invalid connector config -> 400', async () => {
  const res = await create(makeApp(), { ...SN, config: { table: 'bad table' } });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.table);
});

test('POST with an unknown event in config.events -> 400', async () => {
  const res = await create(makeApp(), { ...SN, config: { events: ['nope'] } });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.config);
});

test('POST with a duplicate name -> 409', async () => {
  const app = makeApp();
  await create(app, SN);
  const res = await create(app, { ...SN, name: 'SN' });
  assert.equal(res.status, 409);
});

test('POST a nautobot integration with token auth + allowDelete', async () => {
  const repo = makeIntegrationsRepo();
  const app = makeApp({ integrationsRepo: repo });
  const res = await create(app, { type: 'nautobot', name: 'NB', baseUrl: 'https://nb.acme.dk', authType: 'token', credentials: { token: 't' }, config: { allowDelete: true } });
  assert.equal(res.status, 201);
  assert.equal(res.body.config_json.allowDelete, true);
});

// ---- Update / delete ------------------------------------------------------

test('PUT updates fields; 404 for an unknown id; bad id -> 400', async () => {
  const app = makeApp();
  await create(app, SN);
  const ok = await request(app).put('/api/integrations/1').set('Authorization', admin()).send({ enabled: false, name: 'SN2' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, false);
  assert.equal(ok.body.name, 'SN2');
  assert.equal((await request(app).put('/api/integrations/999').set('Authorization', admin()).send({ enabled: false })).status, 404);
  assert.equal((await request(app).put('/api/integrations/abc').set('Authorization', admin()).send({ enabled: false })).status, 400);
});

test('PUT re-validates config against the (immutable) connector type', async () => {
  const app = makeApp();
  await create(app, SN);
  const res = await request(app).put('/api/integrations/1').set('Authorization', admin()).send({ config: { table: 'bad table' } });
  assert.equal(res.status, 400);
});

test('PUT clearCredentials wipes the stored secret', async () => {
  const repo = makeIntegrationsRepo();
  const app = makeApp({ integrationsRepo: repo });
  await create(app, SN);
  assert.ok(repo.rows[0].credentials_encrypted);
  const res = await request(app).put('/api/integrations/1').set('Authorization', admin()).send({ clearCredentials: true });
  assert.equal(res.status, 200);
  assert.equal(repo.rows[0].credentials_encrypted, null);
});

test('DELETE removes; 404 for an unknown id', async () => {
  const app = makeApp();
  await create(app, SN);
  assert.equal((await request(app).delete('/api/integrations/1').set('Authorization', admin())).status, 204);
  assert.equal((await request(app).delete('/api/integrations/1').set('Authorization', admin())).status, 404);
});

// ---- Test-fire ------------------------------------------------------------

test('POST :id/test returns the actual HTTP status from the target', async () => {
  const dispatcher = makeIntegrationsDispatcher({ testFire: async () => ({ ok: false, status: 502, detail: 'bad gateway' }) });
  const app = makeApp({ integrationsDispatcher: dispatcher });
  await create(app, SN);
  const res = await request(app).post('/api/integrations/1/test').set('Authorization', admin()).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.result.status, 502);
  assert.equal(res.body.result.ok, false);
});

test('POST :id/test -> 404 when the integration does not exist', async () => {
  const dispatcher = makeIntegrationsDispatcher({ testFire: async () => null });
  const res = await request(makeApp({ integrationsDispatcher: dispatcher })).post('/api/integrations/999/test').set('Authorization', admin()).send({});
  assert.equal(res.status, 404);
});

// ---- Meta + audit ---------------------------------------------------------

test('GET /api/integrations/meta lists the connector catalogue', async () => {
  const res = await request(makeApp()).get('/api/integrations/meta').set('Authorization', admin());
  assert.equal(res.status, 200);
  const types = res.body.types.map((t) => t.type);
  assert.ok(types.includes('servicenow'));
  assert.ok(types.includes('nautobot'));
  assert.ok(res.body.events.includes('incident'));
});

test('GET :id/audit -> 404 unknown, 200 list when known', async () => {
  const app = makeApp();
  await create(app, SN);
  assert.equal((await request(app).get('/api/integrations/999/audit').set('Authorization', admin())).status, 404);
  const res = await request(app).get('/api/integrations/1/audit').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

// ---- 500 ------------------------------------------------------------------

test('a repository failure surfaces as 500 via the error handler', async () => {
  const repo = makeIntegrationsRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ integrationsRepo: repo })).get('/api/integrations').set('Authorization', admin());
  assert.equal(res.status, 500);
});
