'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeLocationsRepo,
  makeResultsRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const viewer = () => authHeader('viewer');

// Two agents reporting + one with no data yet.
const rows = [
  {
    agent_id: 1, hostname: 'a1', display_name: 'Router A', status: 'online', result_id: 10,
    created_at: 'x', payload: { traffic: { totals: { rxBytes: 100, txBytes: 200, rxBytesPerSec: 10, txBytesPerSec: 20 } } },
  },
  {
    agent_id: 2, hostname: 'a2', display_name: null, status: 'online', result_id: 11,
    created_at: 'y', payload: { traffic: { totals: { rxBytes: 50, txBytes: 70, rxBytesPerSec: 5, txBytesPerSec: 7 } } },
  },
  { agent_id: 3, hostname: 'a3', display_name: null, status: 'offline', result_id: null, created_at: null, payload: null },
];

test('GET /locations/:id/traffic correlates traffic across the location (viewer)', async () => {
  const app = makeApp({
    locationsRepo: makeLocationsRepo({ findById: async () => ({ id: 2, name: 'Aarhus' }) }),
    resultsRepo: makeResultsRepo({ latestByLocation: async () => rows }),
  });

  const res = await request(app).get('/locations/2/traffic').set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.locationName, 'Aarhus');
  assert.equal(res.body.agentCount, 3);
  assert.equal(res.body.reportingCount, 2); // a3 has no data
  // Summed totals across the reporting agents.
  assert.equal(res.body.totals.rxBytes, 150);
  assert.equal(res.body.totals.txBytes, 270);
  assert.equal(res.body.totals.rxBytesPerSec, 15);
  assert.equal(res.body.totals.txBytesPerSec, 27);
  // The non-reporting agent is present with null rates.
  const a3 = res.body.agents.find((a) => a.agentId === 3);
  assert.equal(a3.rxBytesPerSec, null);
});

test('GET /locations/:id/traffic returns 404 when the location does not exist', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) });
  const res = await request(app).get('/locations/999/traffic').set('Authorization', viewer());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Location not found');
});

test('GET /locations/:id/traffic returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).get('/locations/abc/traffic').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /locations/:id/traffic without a token returns 401', async () => {
  const res = await request(makeApp()).get('/locations/2/traffic');
  assert.equal(res.status, 401);
});

test('GET /locations/:id/traffic returns 500 when the repo throws', async () => {
  const app = makeApp({
    locationsRepo: makeLocationsRepo({ findById: async () => ({ id: 2, name: 'Aarhus' }) }),
    resultsRepo: makeResultsRepo({ latestByLocation: throwingAsync() }),
  });
  const res = await request(app).get('/locations/2/traffic').set('Authorization', viewer());
  assert.equal(res.status, 500);
});

test('GET /locations (list) still works alongside the traffic route', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findAll: async () => [{ id: 1, name: 'X' }] }) });
  const res = await request(app).get('/locations').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 1, name: 'X' }]);
});
