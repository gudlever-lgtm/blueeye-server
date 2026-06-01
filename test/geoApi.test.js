'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFlowsRepo, makeAgentsRepo, makeFindingStore, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');

// A flows repo wired with realistic geo data. Knows country 'DE' and asn 3320.
function geoFlowsRepo(overrides = {}) {
  return makeFlowsRepo({
    aggregateExternalDestinations: async () => [
      { country: 'DE', asn: 3320, asnName: 'DTAG', bytes: 100000, flowCount: 42, deviation: 0.8 },
      { country: 'US', asn: 15169, asnName: 'GOOGLE', bytes: 5000, flowCount: 5, deviation: 0 },
    ],
    destinationExists: async ({ country, asn }) => country === 'DE' || asn === 3320,
    agentIdsForDestination: async () => [9],
    selectFlows: async () => ({
      byAsn: [{ asn: 3320, asnName: 'DTAG', bytes: 100000, flowCount: 42 }],
      byDirection: [{ direction: 'out', bytes: 90000, flowCount: 40 }, { direction: 'in', bytes: 10000, flowCount: 2 }],
      byProto: [{ proto: 'tcp', bytes: 100000, flowCount: 42 }],
      series: [{ at: '2026-01-01 00:00:00', bytes: 100000, flowCount: 42 }],
      totals: { bytes: 100000, flowCount: 42, records: 7 },
    }),
    ...overrides,
  });
}

const geoAgents = () => makeAgentsRepo({
  findForGeo: async () => [{ hostId: 9, siteName: 'HQ', lat: 55.6, lng: 12.5, status: 'online' }],
});

// ---- /api/geo/config -------------------------------------------------------
test('GET /api/geo/config returns the tile source', async () => {
  const res = await request(makeApp()).get('/api/geo/config').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(res.body.tileUrl.includes('{z}'));
});

test('geo endpoints require auth (401 without a token)', async () => {
  const res = await request(makeApp()).get('/api/geo/overview');
  assert.equal(res.status, 401);
});

// ---- /api/geo/overview -----------------------------------------------------
test('GET /api/geo/overview returns internalHosts + externalDestinations', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/overview').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.internalHosts));
  assert.ok(Array.isArray(res.body.externalDestinations));
  assert.equal(res.body.internalHosts[0].siteName, 'HQ');
  assert.equal(res.body.externalDestinations[0].country, 'DE');
});

test('externalDestinations carry no raw/RFC1918 addresses (aggregates only)', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/overview').set('Authorization', viewer());
  for (const d of res.body.externalDestinations) {
    for (const key of ['ip', 'srcIp', 'dstIp', 'extIp', 'addr']) {
      assert.ok(!(key in d), `destination must not expose ${key}`);
    }
    assert.ok(d.country && typeof d.country === 'string');
  }
});

test('GET /api/geo/overview rejects an invalid since (400) and bad hostId (400)', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  assert.equal((await request(app).get('/api/geo/overview?since=not-a-date').set('Authorization', viewer())).status, 400);
  assert.equal((await request(app).get('/api/geo/overview?hostId=abc').set('Authorization', viewer())).status, 400);
});

// ---- /api/geo/select/findings ---------------------------------------------
test('GET /api/geo/select/findings with an unknown asn returns 404', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/select/findings?asn=64500').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('GET /api/geo/select/findings for a known destination returns findings', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'f1', hostId: '9', metric: 'tx.bytesPerSec', explanation: 'x', evidence: [{}], createdAt: new Date() });
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents(), findingStore });
  const res = await request(app).get('/api/geo/select/findings?country=DE').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hosts, [9]);
  assert.equal(res.body.findings.length, 1);
});

test('GET /api/geo/select/findings without country or asn returns 400', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/select/findings').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

// ---- /api/geo/select/flows -------------------------------------------------
test('GET /api/geo/select/flows for a valid country returns aggregated data', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/select/flows?country=DE').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.byAsn) && res.body.byAsn.length >= 1);
  assert.ok(Array.isArray(res.body.byDirection));
  assert.ok(Array.isArray(res.body.series));
  assert.equal(res.body.totals.bytes, 100000);
});

test('GET /api/geo/select/flows with an unknown country returns 404', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/select/flows?country=ZZ').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

// ---- no unexpected 500 on valid input; explicit 500 path -------------------
test('no geo endpoint returns 500 on valid input', async () => {
  const app = makeApp({ flowsRepo: geoFlowsRepo(), agentsRepo: geoAgents() });
  const calls = [
    request(app).get('/api/geo/config').set('Authorization', viewer()),
    request(app).get('/api/geo/overview').set('Authorization', viewer()),
    request(app).get('/api/geo/select/findings?country=DE').set('Authorization', viewer()),
    request(app).get('/api/geo/select/flows?asn=3320').set('Authorization', viewer()),
  ];
  for (const res of await Promise.all(calls)) {
    assert.notEqual(res.status, 500);
  }
});

test('a repository failure surfaces as 500 via the error handler', async () => {
  const flowsRepo = geoFlowsRepo({ aggregateExternalDestinations: async () => { throw new Error('db down'); } });
  const app = makeApp({ flowsRepo, agentsRepo: geoAgents() });
  const res = await request(app).get('/api/geo/overview').set('Authorization', viewer());
  assert.equal(res.status, 500);
});
