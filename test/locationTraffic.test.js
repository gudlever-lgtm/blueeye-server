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

// ------------------------------- GET /locations/:id/traffic/history (range) ---
const historyRows = [
  { agent_id: 1, hostname: 'a1', display_name: null, created_at: '2026-05-31T10:00:00.000Z',
    payload: { traffic: { totals: { rxBytesPerSec: 10, txBytesPerSec: 20 } } } },
  { agent_id: 2, hostname: 'a2', display_name: null, created_at: '2026-05-31T10:00:00.000Z',
    payload: { traffic: { totals: { rxBytesPerSec: 5, txBytesPerSec: 7 } } } },
  { agent_id: 1, hostname: 'a1', display_name: null, created_at: '2026-05-31T10:01:00.000Z',
    payload: { traffic: { totals: { rxBytesPerSec: 30, txBytesPerSec: 40 } } } },
];

test('GET /locations/:id/traffic/history returns a summed series over the range', async () => {
  let receivedRange;
  const app = makeApp({
    locationsRepo: makeLocationsRepo({ findById: async () => ({ id: 2, name: 'Aarhus' }) }),
    resultsRepo: makeResultsRepo({
      rangeByLocation: async (id, range) => { receivedRange = range; return historyRows; },
    }),
  });
  const res = await request(app)
    .get('/locations/2/traffic/history?from=2026-05-31T10:00:00Z&to=2026-05-31T11:00:00Z')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  // Two distinct timestamps -> two buckets; the first sums both agents.
  assert.equal(res.body.series.length, 2);
  assert.equal(res.body.series[0].rxBytesPerSec, 15); // 10 + 5
  assert.equal(res.body.series[0].txBytesPerSec, 27); // 20 + 7
  assert.equal(res.body.series[1].rxBytesPerSec, 30);
  // The parsed range was passed to the repo.
  assert.ok(receivedRange.from instanceof Date && receivedRange.to instanceof Date);
});

test('GET /locations/:id/traffic/history returns 400 for an invalid date', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => ({ id: 2, name: 'A' }) }) });
  const res = await request(app)
    .get('/locations/2/traffic/history?from=not-a-date')
    .set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /locations/:id/traffic/history returns 400 when from is after to', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => ({ id: 2, name: 'A' }) }) });
  const res = await request(app)
    .get('/locations/2/traffic/history?from=2026-05-31T11:00:00Z&to=2026-05-31T10:00:00Z')
    .set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /locations/:id/traffic/history returns 404 when the location is missing', async () => {
  const app = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) });
  const res = await request(app).get('/locations/9/traffic/history').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('GET /locations/:id/traffic/history without a token returns 401', async () => {
  const res = await request(makeApp()).get('/locations/2/traffic/history');
  assert.equal(res.status, 401);
});
