'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeResultsRepo, makeFlowsRepo, authHeader, throwingAsync } = require('../test-support/fakes');

const FROM = '2026-06-01T00:00:00.000Z';
const TO = '2026-06-01T01:00:00.000Z';
const BUCKET_MS = 60 * 1000;
const firstBucket = Math.floor(Date.parse(FROM) / BUCKET_MS);

function appWithAgent(overrides = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1', display_name: 'Agent 1' }) }),
    ...overrides,
  });
}

const url = (q = `agentId=1&from=${FROM}&to=${TO}`) => `/api/flows/categories?${q}`;

test('GET /api/flows/categories requires authentication (401)', async () => {
  const res = await request(appWithAgent()).get(url());
  assert.equal(res.status, 401);
});

test('GET /api/flows/categories without agentId is a 400', async () => {
  const res = await request(appWithAgent()).get(`/api/flows/categories?from=${FROM}&to=${TO}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/categories with a non-numeric agentId is a 400', async () => {
  const res = await request(appWithAgent()).get(url('agentId=abc')).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/categories with an invalid date is a 400', async () => {
  const res = await request(appWithAgent()).get(url('agentId=1&from=not-a-date')).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/categories for a missing agent is a 404', async () => {
  // Default agentsRepo.findById returns null.
  const res = await request(makeApp()).get(url()).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/flows/categories classifies byPort into port categories', async () => {
  const resultsRepo = makeResultsRepo({
    findByAgentId: async () => [{
      created_at: new Date(Date.parse(FROM) + 5 * BUCKET_MS),
      payload: { traffic: { byPort: [
        { port: 53, bytes: 1000 },
        { port: 443, bytes: 2000 },
        { port: 49152, bytes: 9999 }, // ephemeral -> no category
      ] } },
    }],
  });
  const res = await request(appWithAgent({ resultsRepo })).get(url()).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 1);
  assert.equal(res.body.bucketMs, BUCKET_MS);
  const ids = res.body.categories.map((c) => c.id);
  assert.ok(ids.includes('dns'));
  assert.ok(ids.includes('web'));
  const dns = res.body.categories.find((c) => c.id === 'dns');
  assert.equal(dns.total, 1000);
  assert.equal(dns.kind, 'port');
  assert.equal(dns.points[5], 1000); // bucket index 5 matches created_at
  const web = res.body.categories.find((c) => c.id === 'web');
  assert.equal(web.total, 2000);
  // web (2000) sorts before dns (1000).
  assert.equal(res.body.categories[0].id, 'web');
  // The ephemeral port produced no category.
  assert.ok(!ids.includes('49152'));
});

test('GET /api/flows/categories classifies flow ASNs into organisation categories', async () => {
  const flowsRepo = makeFlowsRepo({
    asnSeries: async () => [
      { bucket: firstBucket + 5, asn: 32934, bytes: 5000 }, // Facebook/Meta
      { bucket: firstBucket + 5, asn: 64500, bytes: 7777 }, // unknown -> ignored
    ],
  });
  const res = await request(appWithAgent({ flowsRepo })).get(url()).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const fb = res.body.categories.find((c) => c.id === 'facebook');
  assert.ok(fb, 'facebook category present');
  assert.equal(fb.total, 5000);
  assert.equal(fb.kind, 'asn');
  assert.equal(fb.points[5], 5000);
});

test('GET /api/flows/categories tolerates a failing flow repo (still returns port data)', async () => {
  const resultsRepo = makeResultsRepo({
    findByAgentId: async () => [{
      created_at: new Date(Date.parse(FROM) + BUCKET_MS),
      payload: { traffic: { byPort: [{ port: 53, bytes: 500 }] } },
    }],
  });
  const flowsRepo = makeFlowsRepo({ asnSeries: throwingAsync('flow query failed') });
  const res = await request(appWithAgent({ resultsRepo, flowsRepo })).get(url()).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(res.body.categories.some((c) => c.id === 'dns'));
});

test('GET /api/flows/categories surfaces a results-repo failure as 500', async () => {
  const resultsRepo = makeResultsRepo({ findByAgentId: throwingAsync('db down') });
  const res = await request(appWithAgent({ resultsRepo })).get(url()).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET /api/flows/categories/defs lists the catalogue', async () => {
  const res = await request(appWithAgent()).get('/api/flows/categories/defs').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.categories));
  assert.ok(res.body.categories.some((c) => c.id === 'dns' && c.kind === 'port'));
  assert.ok(res.body.categories.some((c) => c.id === 'facebook' && c.kind === 'asn'));
});
