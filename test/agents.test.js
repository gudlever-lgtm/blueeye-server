'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeLocationsRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

const sampleAgent = {
  id: 1,
  hostname: 'node-01',
  platform: 'linux',
  arch: 'x64',
  last_seen: null,
  status: 'offline',
  location_id: null,
  location_name: null,
  display_name: null,
  notes: null,
  meta: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

// ----------------------------------------------------------------- GET /agents
test('GET /agents returns 200 with the list (viewer)', async () => {
  const rows = [{ ...sampleAgent, location_id: 2, location_name: 'Aarhus – Hovedkontor' }];
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => rows }) });

  const res = await request(app).get('/agents').set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
  assert.equal(res.body[0].location_name, 'Aarhus – Hovedkontor');
});

test('GET /agents returns 500 when the repository throws', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: throwingAsync() }) });

  const res = await request(app).get('/agents').set('Authorization', viewer());

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

test('GET /agents without a token returns 401', async () => {
  const res = await request(makeApp()).get('/agents');

  assert.equal(res.status, 401);
});

// ------------------------------------------------------------- GET /agents/:id
test('GET /agents/:id returns 200 (viewer)', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => sampleAgent }) });

  const res = await request(app).get('/agents/1').set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.hostname, 'node-01');
});

test('GET /agents/:id returns 404 when not found', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) });

  const res = await request(app).get('/agents/999').set('Authorization', viewer());

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Agent not found');
});

test('GET /agents/:id returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).get('/agents/abc').set('Authorization', viewer());

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('GET /agents/:id returns 500 when the repository throws', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: throwingAsync() }) });

  const res = await request(app).get('/agents/1').set('Authorization', viewer());

  assert.equal(res.status, 500);
});

// ------------------------------------------------------------- PUT /agents/:id
test('PUT /agents/:id updates managed fields and returns 200 (operator)', async () => {
  const agentsRepo = makeAgentsRepo({
    findById: async () => sampleAgent,
    updateManaged: async (id, patch) => ({ ...sampleAgent, id, ...patch }),
  });

  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ display_name: 'Reception PC', notes: 'Foyer', meta: { tags: ['kiosk'] } });

  assert.equal(res.status, 200);
  assert.equal(res.body.display_name, 'Reception PC');
  assert.deepEqual(res.body.meta, { tags: ['kiosk'] });
});

test('PUT /agents/:id touches ONLY server-managed fields', async () => {
  let receivedPatch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => sampleAgent,
    updateManaged: async (id, patch) => {
      receivedPatch = patch;
      return { ...sampleAgent, ...patch };
    },
  });

  // Client tries to sneak in agent-reported fields — they must be ignored.
  await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({
      display_name: 'X',
      notes: 'note',
      hostname: 'hacked',
      status: 'online',
      arch: 'arm64',
      last_seen: '2030-01-01',
    });

  assert.deepEqual(
    Object.keys(receivedPatch).sort(),
    ['display_name', 'location_id', 'meta', 'monitor_config', 'notes']
  );
});

test('PUT /agents/:id returns 404 when the agent does not exist', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });

  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/999')
    .set('Authorization', operator())
    .send({ display_name: 'X' });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Agent not found');
});

test('PUT /agents/:id returns 400 for an invalid id', async () => {
  const res = await request(makeApp())
    .put('/agents/abc')
    .set('Authorization', operator())
    .send({ display_name: 'X' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('PUT /agents/:id returns 400 for invalid managed input', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => sampleAgent });

  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ meta: 'not-an-object', location_id: -3 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('PUT /agents/:id returns 400 when location_id does not exist', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => sampleAgent });
  // Default locationsRepo.findById returns null -> location does not exist.
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ location_id: 999 });

  assert.equal(res.status, 400);
  assert.equal(res.body.details.location_id, 'location_id does not reference an existing location');
});

test('PUT /agents/:id accepts a location_id that exists', async () => {
  const agentsRepo = makeAgentsRepo({
    findById: async () => sampleAgent,
    updateManaged: async (id, patch) => ({ ...sampleAgent, id, ...patch }),
  });
  const locationsRepo = makeLocationsRepo({
    findById: async () => ({ id: 2, name: 'Aarhus – Hovedkontor' }),
  });

  const res = await request(makeApp({ agentsRepo, locationsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ location_id: 2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.location_id, 2);
});

test('PUT /agents/:id returns 500 when the repository throws', async () => {
  const agentsRepo = makeAgentsRepo({
    findById: async () => sampleAgent,
    updateManaged: throwingAsync(),
  });

  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ display_name: 'X' });

  assert.equal(res.status, 500);
});

test('PUT /agents/:id is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp())
    .put('/agents/1')
    .set('Authorization', viewer())
    .send({ display_name: 'X' });

  assert.equal(res.status, 403);
});

// ---------------------------------------------------------- DELETE /agents/:id
test('DELETE /agents/:id returns 204 on success (admin)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => sampleAgent, remove: async () => true });

  const res = await request(makeApp({ agentsRepo }))
    .delete('/agents/1')
    .set('Authorization', admin());

  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('DELETE /agents/:id returns 404 when not found', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null, remove: async () => false });

  const res = await request(makeApp({ agentsRepo }))
    .delete('/agents/999')
    .set('Authorization', admin());

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Agent not found');
});

test('DELETE /agents/:id returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).delete('/agents/-1').set('Authorization', admin());

  assert.equal(res.status, 400);
});

test('DELETE /agents/:id returns 500 when the repository throws', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => sampleAgent, remove: throwingAsync() });

  const res = await request(makeApp({ agentsRepo }))
    .delete('/agents/1')
    .set('Authorization', admin());

  assert.equal(res.status, 500);
});

test('DELETE /agents/:id is forbidden for an operator (403)', async () => {
  const res = await request(makeApp())
    .delete('/agents/1')
    .set('Authorization', operator());

  assert.equal(res.status, 403);
});
