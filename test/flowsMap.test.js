'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeFlowsRepo, authHeader } = require('../test-support/fakes');
const { createCentroids } = require('../src/geo/centroids');

// Two agents at two sites; one un-located agent to exercise the fallback key.
const HOSTS = [
  { hostId: 1, locationId: 10, siteName: 'HQ', lat: 50.1, lng: 8.6, status: 'online' },
  { hostId: 2, locationId: 20, siteName: 'Branch', lat: 59.3, lng: 18.0, status: 'online' },
  { hostId: 3, locationId: null, siteName: null, lat: null, lng: null, status: 'offline' },
];

const agentsRepo = (overrides = {}) => makeAgentsRepo({
  findById: async (id) => (Number(id) <= 3 ? { id, hostname: `h${id}` } : null),
  findForGeo: async (hostId) => (hostId ? HOSTS.filter((h) => h.hostId === Number(hostId)) : HOSTS),
  ...overrides,
});

const ROWS = [
  // agent 1 → US web (https out), heavy
  { agentId: 1, country: 'US', asn: 16509, asnName: 'AMAZON-02', direction: 'out', port: 443, bytes: 9000, flowCount: 9 },
  // agent 1 ← US web (inbound replies, small) — same (site,country,category) arc
  { agentId: 1, country: 'US', asn: 16509, asnName: 'AMAZON-02', direction: 'in', port: 443, bytes: 1000, flowCount: 2 },
  // agent 1 → DE dns
  { agentId: 1, country: 'DE', asn: null, asnName: null, direction: 'out', port: 53, bytes: 500, flowCount: 5 },
  // agent 2 → US unknown port ⇒ 'other'
  { agentId: 2, country: 'US', asn: null, asnName: null, direction: 'out', port: 4444, bytes: 300, flowCount: 1 },
];

function appWith(rows = ROWS, overrides = {}) {
  return makeApp({
    agentsRepo: agentsRepo(),
    flowsRepo: makeFlowsRepo({ mapFlows: async (f) => { appWith.captured = f; return rows; } }),
    centroids: createCentroids(),
    ...overrides,
  });
}

test('GET /api/flows/map without a token is 401', async () => {
  const res = await request(appWith()).get('/api/flows/map');
  assert.equal(res.status, 401);
});

test('GET /api/flows/map rejects a bad agentId/locationId (400)', async () => {
  assert.equal((await request(appWith()).get('/api/flows/map?agentId=abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(appWith()).get('/api/flows/map?locationId=-1').set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /api/flows/map with an unknown agent is 404', async () => {
  const res = await request(appWith()).get('/api/flows/map?agentId=99').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/flows/map aggregates arcs by site+country+category with direction split', async () => {
  const res = await request(appWith()).get('/api/flows/map').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);

  // Sites: two located locations + the un-located agent keyed by agent id.
  const keys = res.body.sites.map((s) => s.key).sort();
  assert.deepEqual(keys, ['a3', 'l10', 'l20']);
  const hq = res.body.sites.find((s) => s.key === 'l10');
  assert.equal(hq.name, 'HQ');
  assert.equal(hq.lat, 50.1);

  // Arcs: HQ→US amazon (ASN category wins over the 443 port match), in+out merged.
  const ama = res.body.arcs.find((a) => a.siteKey === 'l10' && a.country === 'US');
  assert.equal(ama.category, 'amazon');
  assert.equal(ama.inBytes, 1000);
  assert.equal(ama.outBytes, 9000);
  assert.equal(ama.bytes, 10000);
  assert.equal(ama.direction, 'out'); // 90 % outbound ⇒ one-directional
  assert.ok(ama.lat != null && ama.lng != null, 'US arc is placed at the country centroid');

  const dns = res.body.arcs.find((a) => a.country === 'DE');
  assert.equal(dns.category, 'dns');
  assert.equal(dns.direction, 'out');

  const other = res.body.arcs.find((a) => a.siteKey === 'l20');
  assert.equal(other.category, 'other');

  // Legend is sorted biggest-first and totals add up.
  assert.equal(res.body.categories[0].id, 'amazon');
  assert.equal(res.body.totals.bytes, 10800);
  assert.equal(res.body.totals.destinations, 2); // US + DE
});

test('GET /api/flows/map?locationId= scopes sites and threads the filter to the repo', async () => {
  const res = await request(appWith()).get('/api/flows/map?locationId=10').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sites.map((s) => s.key), ['l10']);
  assert.equal(appWith.captured.locationId, 10);
  // Rows from agents outside the scoped location are dropped, not mis-anchored.
  assert.ok(!res.body.arcs.some((a) => a.siteKey === 'l20' || a.siteKey === 'a3'));
});

test('GET /api/flows/map survives a repo without mapFlows (empty arcs)', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowsRepo: { }, centroids: createCentroids() });
  const res = await request(app).get('/api/flows/map').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.arcs, []);
  assert.equal(res.body.totals.bytes, 0);
});
