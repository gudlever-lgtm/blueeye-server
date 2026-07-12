'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeCmdbConfigRepo, makeAgentCmdbLinksRepo, makeAgentsRepo,
  makeConnectorRegistry, makeSecretBox, authHeader,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

const VALID = { type: 'servicenow', base_url: 'https://acme.service-now.com', auth_type: 'basic', credentials: { username: 'svc', password: 'pw' }, enabled: true };

// A stored, enabled config row (credentials encrypted with the given box).
function seededConfig(box, over = {}) {
  return makeCmdbConfigRepo({
    row: {
      id: 1, type: 'servicenow', base_url: 'https://acme.service-now.com', auth_type: 'basic',
      credentials_encrypted: box.encryptJson({ username: 'svc', password: 'pw' }),
      enabled: true, verified_at: null, updated_by: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      ...over,
    },
  });
}

// ---- Phase 2: settings API (admin) ----------------------------------------

test('GET /api/settings/cmdb without a token -> 401', async () => {
  assert.equal((await request(makeApp()).get('/api/settings/cmdb')).status, 401);
});

test('GET /api/settings/cmdb as non-admin -> 403', async () => {
  assert.equal((await request(makeApp()).get('/api/settings/cmdb').set('Authorization', viewer())).status, 403);
  assert.equal((await request(makeApp()).get('/api/settings/cmdb').set('Authorization', operator())).status, 403);
});

test('GET /api/settings/cmdb with no config set yet -> 200 empty object', async () => {
  const res = await request(makeApp()).get('/api/settings/cmdb').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {});
});

test('PUT valid payload -> 200; GET never returns credentials but flags credentialsSet', async () => {
  const repo = makeCmdbConfigRepo();
  const app = makeApp({ cmdbConfigRepo: repo });
  const put = await request(app).put('/api/settings/cmdb').set('Authorization', admin()).send(VALID);
  assert.equal(put.status, 200);
  assert.equal(put.body.type, 'servicenow');
  assert.equal(put.body.credentials, undefined);
  assert.equal(put.body.credentials_encrypted, undefined);
  assert.equal(put.body.credentialsSet, true);
  assert.ok(!JSON.stringify(put.body).includes('pw'));
  // Stored at rest as an encrypted secret-box token (never plaintext).
  const stored = await repo.getWithSecret();
  assert.ok(stored.credentials_encrypted.startsWith('v1.gcm.'));
  assert.ok(!stored.credentials_encrypted.includes('pw'));

  const get = await request(app).get('/api/settings/cmdb').set('Authorization', admin());
  assert.equal(get.status, 200);
  assert.equal(get.body.credentials, undefined);
  assert.equal(get.body.credentials_encrypted, undefined);
  assert.equal(get.body.credentialsSet, true);
  assert.ok(!JSON.stringify(get.body).toLowerCase().includes('"pw"'));
});

test('PUT as non-admin -> 403', async () => {
  assert.equal((await request(makeApp()).put('/api/settings/cmdb').set('Authorization', operator()).send(VALID)).status, 403);
  assert.equal((await request(makeApp()).put('/api/settings/cmdb').set('Authorization', viewer()).send(VALID)).status, 403);
});

test('PUT with an unknown type -> 400', async () => {
  const res = await request(makeApp()).put('/api/settings/cmdb').set('Authorization', admin()).send({ ...VALID, type: 'frobnicate' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.type);
});

test('PUT with an auth_type the type does not support -> 400', async () => {
  // servicenow supports basic|oauth2, not token.
  const res = await request(makeApp()).put('/api/settings/cmdb').set('Authorization', admin()).send({ ...VALID, auth_type: 'token' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.auth_type);
});

test('PUT with a private/internal base_url -> 400 (SSRF guard)', async () => {
  const res = await request(makeApp()).put('/api/settings/cmdb').set('Authorization', admin()).send({ ...VALID, base_url: 'http://127.0.0.1/api' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.base_url);
});

// ---- Phase 2: POST /test ---------------------------------------------------

test('POST /test with no config -> 400', async () => {
  const res = await request(makeApp()).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 400);
});

test('POST /test success -> 200 and stamps verified_at', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeConnectorRegistry({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: [] }) }) });
  const app = makeApp({ cmdbConfigRepo, connectorRegistry, secretBox: box });
  const res = await request(app).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.verified_at);
  assert.ok((await cmdbConfigRepo.get()).verified_at);
});

test('POST /test with bad credentials -> 401', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeConnectorRegistry({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const app = makeApp({ cmdbConfigRepo, connectorRegistry, secretBox: box });
  const res = await request(app).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  // A failed test must NOT stamp verified_at.
  assert.equal((await cmdbConfigRepo.get()).verified_at, null);
});

test('POST /test with an unreachable base_url -> 500', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeConnectorRegistry({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const app = makeApp({ cmdbConfigRepo, connectorRegistry, secretBox: box });
  const res = await request(app).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
});

// ---- Phase 3: asset search -------------------------------------------------

test('GET /api/cmdb/assets/search requires operator+ (viewer -> 403)', async () => {
  const res = await request(makeApp()).get('/api/cmdb/assets/search?q=web').set('Authorization', viewer());
  assert.equal(res.status, 403);
});

test('GET search with q too short -> 400', async () => {
  const res = await request(makeApp()).get('/api/cmdb/assets/search?q=a').set('Authorization', operator());
  assert.equal(res.status, 400);
});

test('GET search with q missing -> 400', async () => {
  const res = await request(makeApp()).get('/api/cmdb/assets/search').set('Authorization', operator());
  assert.equal(res.status, 400);
});

test('GET search with no CMDB configured -> 404', async () => {
  const res = await request(makeApp()).get('/api/cmdb/assets/search?q=web').set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('GET search when CMDB is configured but disabled -> 404', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box, { enabled: false });
  const app = makeApp({ cmdbConfigRepo, secretBox: box });
  const res = await request(app).get('/api/cmdb/assets/search?q=web').set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('GET search normalizes connector results to {id,name,type,location}', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeConnectorRegistry({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: [
      { sys_id: 'abc123', name: 'web01', sys_class_name: 'cmdb_ci_server', location: 'Copenhagen DC' },
    ] }) }),
  });
  const app = makeApp({ cmdbConfigRepo, connectorRegistry, secretBox: box });
  const res = await request(app).get('/api/cmdb/assets/search?q=web').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.assets, [{ id: 'abc123', name: 'web01', type: 'cmdb_ci_server', location: 'Copenhagen DC' }]);
});

test('GET search when the connector call fails -> 500', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeConnectorRegistry({ fetchImpl: async () => { throw new Error('down'); } });
  const app = makeApp({ cmdbConfigRepo, connectorRegistry, secretBox: box });
  const res = await request(app).get('/api/cmdb/assets/search?q=web').set('Authorization', operator());
  assert.equal(res.status, 500);
});

// ---- Phase 3: agent <-> asset link ----------------------------------------

const LINK = { cmdb_asset_id: 'abc123', cmdb_asset_name: 'web01' };
const agentExists = () => makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'web01' }) });

test('GET /api/agents/:id/cmdb-link with no link -> 404', async () => {
  const res = await request(makeApp()).get('/api/agents/5/cmdb-link').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('GET link returns the stored link (viewer+)', async () => {
  const agentCmdbLinksRepo = makeAgentCmdbLinksRepo({ rows: [{ agent_id: 5, cmdb_asset_id: 'abc123', cmdb_asset_name: 'web01', linked_by: 1, linked_at: '2026-01-01T00:00:00.000Z' }] });
  const res = await request(makeApp({ agentCmdbLinksRepo })).get('/api/agents/5/cmdb-link').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.cmdb_asset_id, 'abc123');
});

test('PUT link as viewer -> 403 (operator+ only)', async () => {
  const res = await request(makeApp({ agentsRepo: agentExists() })).put('/api/agents/5/cmdb-link').set('Authorization', viewer()).send(LINK);
  assert.equal(res.status, 403);
});

test('PUT link when the agent does not exist -> 404', async () => {
  const res = await request(makeApp()).put('/api/agents/999/cmdb-link').set('Authorization', operator()).send(LINK);
  assert.equal(res.status, 404);
});

test('PUT link with an invalid body -> 400', async () => {
  const res = await request(makeApp({ agentsRepo: agentExists() })).put('/api/agents/5/cmdb-link').set('Authorization', operator()).send({ cmdb_asset_id: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.cmdb_asset_id);
  assert.ok(res.body.details.cmdb_asset_name);
});

test('PUT link -> 200 and stores the link', async () => {
  const agentCmdbLinksRepo = makeAgentCmdbLinksRepo();
  const app = makeApp({ agentsRepo: agentExists(), agentCmdbLinksRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator()).send(LINK);
  assert.equal(res.status, 200);
  assert.equal(res.body.cmdb_asset_id, 'abc123');
  assert.equal(agentCmdbLinksRepo.rows.length, 1);
  assert.equal(agentCmdbLinksRepo.rows[0].agent_id, 5);
});

test('DELETE link with no existing link -> 404', async () => {
  const res = await request(makeApp()).delete('/api/agents/5/cmdb-link').set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('DELETE link -> 204 when a link existed', async () => {
  const agentCmdbLinksRepo = makeAgentCmdbLinksRepo({ rows: [{ agent_id: 5, cmdb_asset_id: 'abc123', cmdb_asset_name: 'web01', linked_by: 1, linked_at: '2026-01-01T00:00:00.000Z' }] });
  const res = await request(makeApp({ agentCmdbLinksRepo })).delete('/api/agents/5/cmdb-link').set('Authorization', operator());
  assert.equal(res.status, 204);
  assert.equal(agentCmdbLinksRepo.rows.length, 0);
});
