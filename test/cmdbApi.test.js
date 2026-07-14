'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeCmdbConfigRepo, makeAgentCmdbLinksRepo, makeAgentsRepo, makeLocationsRepo,
  makeCmdbConnectorRegistry, makeSecretBox, authHeader,
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

// ---- Custom ("bring your own") CMDB ----------------------------------------

const CUSTOM_CFG = {
  type: 'custom', base_url: 'https://cmdb.example.com', auth_type: 'token', credentials: { token: 't' }, enabled: true,
  config: { searchPath: '/api/assets', queryParam: 'q', resultsPath: 'result', idField: 'id', nameField: 'name', locationField: 'loc' },
};

test('GET /api/settings/cmdb/meta lists servicenow, nautobot and custom', async () => {
  const res = await request(makeApp()).get('/api/settings/cmdb/meta').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.types.map((t) => t.type).sort(), ['custom', 'nautobot', 'servicenow']);
  const custom = res.body.types.find((t) => t.type === 'custom');
  assert.equal(custom.custom, true);
  assert.ok(custom.authTypes.includes('token'));
  // Named presets are exposed and every one points at a real connector type.
  const presets = res.body.presets || [];
  const ids = presets.map((p) => p.id);
  assert.ok(ids.includes('netbox'));
  assert.ok(ids.includes('glpi'));
  const known = new Set(res.body.types.map((t) => t.type));
  for (const p of presets) assert.ok(known.has(p.type), `preset ${p.id} -> unknown type ${p.type}`);
  const netbox = presets.find((p) => p.id === 'netbox');
  assert.equal(netbox.type, 'custom');
  assert.equal(netbox.config.searchPath, '/api/dcim/devices/');
});

test('PUT a custom CMDB stores config_json; GET returns it (no credentials)', async () => {
  const repo = makeCmdbConfigRepo();
  const app = makeApp({ cmdbConfigRepo: repo });
  const put = await request(app).put('/api/settings/cmdb').set('Authorization', admin()).send(CUSTOM_CFG);
  assert.equal(put.status, 200);
  assert.equal(put.body.type, 'custom');
  assert.equal(put.body.config_json.searchPath, '/api/assets');
  assert.equal(put.body.credentials, undefined);
  const stored = await repo.getWithSecret();
  assert.equal(stored.config_json.searchPath, '/api/assets');
  assert.ok(stored.credentials_encrypted.startsWith('v1.gcm.'));
});

test('PUT a custom CMDB without config.searchPath -> 400', async () => {
  const { config, ...rest } = CUSTOM_CFG;
  const res = await request(makeApp()).put('/api/settings/cmdb').set('Authorization', admin()).send({ ...rest, config: { queryParam: 'q' } });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.config);
});

test('search via a custom CMDB uses the configured connector + mappings', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = makeCmdbConfigRepo({ row: {
    id: 1, type: 'custom', base_url: 'https://cmdb.example.com', auth_type: 'token',
    config_json: { searchPath: '/api/assets', resultsPath: 'result', idField: 'id', nameField: 'name', locationField: 'loc' },
    credentials_encrypted: box.encryptJson({ token: 't' }), enabled: true, verified_at: null, updated_by: 1,
  } });
  const cmdbConnectorRegistry = makeCmdbConnectorRegistry({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: [{ id: 'z9', name: 'host9', loc: 'Aarhus' }] }) }) });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry, secretBox: box });
  const res = await request(app).get('/api/cmdb/assets/search?q=host').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.assets, [{ id: 'z9', name: 'host9', type: null, location: 'Aarhus' }]);
});

// ---- Phase 2: POST /test ---------------------------------------------------

test('POST /test with no config -> 400', async () => {
  const res = await request(makeApp()).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 400);
});

test('POST /test success -> 200 and stamps verified_at', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeCmdbConnectorRegistry({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: [] }) }) });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry: connectorRegistry, secretBox: box });
  const res = await request(app).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.verified_at);
  assert.ok((await cmdbConfigRepo.get()).verified_at);
});

test('POST /test with bad credentials -> 401', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeCmdbConnectorRegistry({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry: connectorRegistry, secretBox: box });
  const res = await request(app).post('/api/settings/cmdb/test').set('Authorization', admin());
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  // A failed test must NOT stamp verified_at.
  assert.equal((await cmdbConfigRepo.get()).verified_at, null);
});

test('POST /test with an unreachable base_url -> 500', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeCmdbConnectorRegistry({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry: connectorRegistry, secretBox: box });
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
  const connectorRegistry = makeCmdbConnectorRegistry({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: [
      { sys_id: 'abc123', name: 'web01', sys_class_name: 'cmdb_ci_server', location: 'Copenhagen DC' },
    ] }) }),
  });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry: connectorRegistry, secretBox: box });
  const res = await request(app).get('/api/cmdb/assets/search?q=web').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.assets, [{ id: 'abc123', name: 'web01', type: 'cmdb_ci_server', location: 'Copenhagen DC' }]);
});

test('GET search when the connector call fails -> 500', async () => {
  const box = makeSecretBox();
  const cmdbConfigRepo = seededConfig(box);
  const connectorRegistry = makeCmdbConnectorRegistry({ fetchImpl: async () => { throw new Error('down'); } });
  const app = makeApp({ cmdbConfigRepo, cmdbConnectorRegistry: connectorRegistry, secretBox: box });
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

test('PUT link captures the CMDB asset location as an informational label', async () => {
  const agentCmdbLinksRepo = makeAgentCmdbLinksRepo();
  const app = makeApp({ agentsRepo: agentExists(), agentCmdbLinksRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Copenhagen DC' });
  assert.equal(res.status, 200);
  assert.equal(res.body.cmdb_asset_location, 'Copenhagen DC');
  assert.equal(agentCmdbLinksRepo.rows[0].cmdb_asset_location, 'Copenhagen DC');
});

test('PUT link without a location -> 200 and stores null (location is optional)', async () => {
  const agentCmdbLinksRepo = makeAgentCmdbLinksRepo();
  const app = makeApp({ agentsRepo: agentExists(), agentCmdbLinksRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator()).send(LINK);
  assert.equal(res.status, 200);
  assert.equal(res.body.cmdb_asset_location, null);
});

test('PUT link with a location syncs agent location_id to the matching BlueEye site', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id, location_id: locationId }; },
  });
  const createCalls = [];
  const locationsRepo = makeLocationsRepo({
    findByName: async (name) => (name.toLowerCase() === 'copenhagen dc' ? { id: 7, name: 'Copenhagen DC' } : null),
    create: async (input) => { createCalls.push(input); return { id: 99, ...input }; },
  });
  const app = makeApp({ agentsRepo, locationsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Copenhagen DC' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.synced_location, { id: 7, name: 'Copenhagen DC' });
  assert.deepEqual(setCalls, [{ id: 5, locationId: 7 }]);
  assert.equal(createCalls.length, 0); // matched an existing site — no new one created
});

test('PUT link with a location creates a new BlueEye site when none matches', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id, location_id: locationId }; },
  });
  const locationsRepo = makeLocationsRepo({
    findByName: async () => null,
    create: async (input) => ({ id: 42, ...input }),
  });
  const app = makeApp({ agentsRepo, locationsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Aarhus DC' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.synced_location, { id: 42, name: 'Aarhus DC' });
  assert.deepEqual(setCalls, [{ id: 5, locationId: 42 }]);
});

test('PUT link SUGGESTS (does not overwrite) when the agent already has a differing manual site', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01', location_id: 3, location_name: 'Manual Site' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id }; },
  });
  const locationsRepo = makeLocationsRepo({
    findByName: async () => ({ id: 7, name: 'Copenhagen DC' }),
    create: async () => { throw new Error('should not create on a mere suggestion'); },
  });
  const app = makeApp({ agentsRepo, locationsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Copenhagen DC' });
  assert.equal(res.status, 200);
  assert.equal(res.body.synced_location, null);
  assert.deepEqual(res.body.location_suggestion, { current: { id: 3, name: 'Manual Site' }, proposed: { id: 7, name: 'Copenhagen DC' } });
  assert.equal(setCalls.length, 0); // the manual site was NOT overwritten
});

test('PUT link with overwrite_location applies the overwrite', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01', location_id: 3, location_name: 'Manual Site' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id }; },
  });
  const locationsRepo = makeLocationsRepo({ findByName: async () => ({ id: 7, name: 'Copenhagen DC' }) });
  const app = makeApp({ agentsRepo, locationsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Copenhagen DC', overwrite_location: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.synced_location, { id: 7, name: 'Copenhagen DC' });
  assert.equal(res.body.location_suggestion, null);
  assert.deepEqual(setCalls, [{ id: 5, locationId: 7 }]);
});

test('PUT link is a no-op sync when the agent already sits on the matching site', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01', location_id: 7, location_name: 'Copenhagen DC' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id }; },
  });
  const locationsRepo = makeLocationsRepo({ findByName: async () => ({ id: 7, name: 'Copenhagen DC' }) });
  const app = makeApp({ agentsRepo, locationsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 'Copenhagen DC' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.synced_location, { id: 7, name: 'Copenhagen DC' });
  assert.equal(res.body.location_suggestion, null);
  assert.equal(setCalls.length, 0); // already correct — nothing written
});

test('PUT link without a location does not sync location_id', async () => {
  const setCalls = [];
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => ({ id, hostname: 'web01' }),
    setLocation: async (id, locationId) => { setCalls.push({ id, locationId }); return { id }; },
  });
  const app = makeApp({ agentsRepo });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator()).send(LINK);
  assert.equal(res.status, 200);
  assert.equal(res.body.synced_location, null);
  assert.equal(setCalls.length, 0);
});

test('PUT link with a non-string location -> 400', async () => {
  const app = makeApp({ agentsRepo: agentExists() });
  const res = await request(app).put('/api/agents/5/cmdb-link').set('Authorization', operator())
    .send({ ...LINK, cmdb_asset_location: 42 });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.cmdb_asset_location);
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
