'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeFlowsRepo, authHeader } = require('../test-support/fakes');

const withAgent = (overrides = {}) => makeApp({
  agentsRepo: makeAgentsRepo({ findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'h9' } : null) }),
  ...overrides,
});

const VALID_QS = 'agentId=9&from=2026-06-01T00:00:00Z&to=2026-06-01T06:00:00Z';

// ---- auth / validation -------------------------------------------------------

test('GET /api/flows/bidirectional without a token is 401', async () => {
  const res = await request(makeApp()).get(`/api/flows/bidirectional?${VALID_QS}`);
  assert.equal(res.status, 401);
});

test('GET /api/flows/bidirectional requires agentId — 400 without it', async () => {
  const res = await request(withAgent())
    .get('/api/flows/bidirectional?from=2026-06-01T00:00:00Z&to=2026-06-01T06:00:00Z')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'error field present');
});

test('GET /api/flows/bidirectional with non-integer agentId is 400', async () => {
  const res = await request(withAgent())
    .get('/api/flows/bidirectional?agentId=not-a-number')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/bidirectional with unknown agentId is 404', async () => {
  const res = await request(withAgent())
    .get('/api/flows/bidirectional?agentId=999&from=2026-06-01T00:00:00Z&to=2026-06-01T06:00:00Z')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
});

test('GET /api/flows/bidirectional with invalid from date is 400', async () => {
  const res = await request(withAgent())
    .get('/api/flows/bidirectional?agentId=9&from=not-a-date&to=2026-06-01T06:00:00Z')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/bidirectional with inverted range (from > to) is 400', async () => {
  const res = await request(withAgent())
    .get('/api/flows/bidirectional?agentId=9&from=2026-06-01T06:00:00Z&to=2026-06-01T00:00:00Z')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/bidirectional with malformed host IP is 400', async () => {
  const res = await request(withAgent())
    .get(`/api/flows/bidirectional?${VALID_QS}&host=not-an-ip`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /host/i);
});

// ---- success: data -----------------------------------------------------------

test('GET /api/flows/bidirectional 200 with data — calls exploreFlows twice (in + out)', async () => {
  const calls = [];
  const flowsRepo = makeFlowsRepo({
    exploreFlows: async (opts) => {
      calls.push(opts.direction);
      if (opts.direction === 'in') {
        return {
          topTalkers: [{ srcIp: '1.2.3.4', dstIp: '10.0.0.1', extIp: '1.2.3.4', bytes: 2000, packets: 20, flowCount: 5, internal: false, asnName: 'ACME', country: 'DE' }],
          byPort: [{ port: 80, proto: 'tcp', bytes: 2000, flowCount: 5 }],
          byProto: [{ proto: 'tcp', bytes: 2000, flowCount: 5 }],
          series: [{ at: '2026-06-01T01:00:00.000Z', bytes: 2000, flowCount: 5 }],
          scans: [],
          totals: { bytes: 2000, packets: 20, flowCount: 5, records: 8 },
        };
      }
      return {
        topTalkers: [{ srcIp: '10.0.0.1', dstIp: '1.2.3.4', extIp: '1.2.3.4', bytes: 500, packets: 5, flowCount: 2, internal: false, asnName: 'ACME', country: 'DE' }],
        byPort: [],
        byProto: [{ proto: 'tcp', bytes: 500, flowCount: 2 }],
        series: [{ at: '2026-06-01T01:00:00.000Z', bytes: 500, flowCount: 2 }],
        scans: [],
        totals: { bytes: 500, packets: 5, flowCount: 2, records: 3 },
      };
    },
  });

  const res = await request(withAgent({ flowsRepo }))
    .get(`/api/flows/bidirectional?${VALID_QS}`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.ok(calls.includes('in'), 'called with direction=in');
  assert.ok(calls.includes('out'), 'called with direction=out');
  assert.equal(res.body.agentId, 9);
  assert.equal(res.body.host, null);
  assert.equal(res.body.ingress.totals.bytes, 2000);
  assert.equal(res.body.egress.totals.bytes, 500);
  assert.equal(res.body.asymmetry.inBytes, 2000);
  assert.equal(res.body.asymmetry.outBytes, 500);
  assert.equal(res.body.asymmetry.totalBytes, 2500);
  assert.ok(typeof res.body.asymmetry.ratio === 'number', 'ratio is numeric');
  assert.ok(res.body.asymmetry.asymmetric === true, 'flagged asymmetric (2000 vs 500 = 80 % in)');
});

test('GET /api/flows/bidirectional passes host filter to both direction calls', async () => {
  const calls = [];
  const flowsRepo = makeFlowsRepo({
    exploreFlows: async (opts) => { calls.push({ dir: opts.direction, peer: opts.peer }); return { topTalkers: [], byPort: [], byProto: [], series: [], scans: [], totals: { bytes: 0, packets: 0, flowCount: 0, records: 0 } }; },
  });

  const res = await request(withAgent({ flowsRepo }))
    .get(`/api/flows/bidirectional?${VALID_QS}&host=10.0.0.5`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.host, '10.0.0.5');
  assert.ok(calls.every((c) => c.peer === '10.0.0.5'), 'both calls get the host as peer');
});

// ---- success: empty window ---------------------------------------------------

test('GET /api/flows/bidirectional with no data returns 200 with empty payload', async () => {
  const res = await request(withAgent())
    .get(`/api/flows/bidirectional?${VALID_QS}`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.ingress.topTalkers, []);
  assert.deepEqual(res.body.egress.topTalkers, []);
  assert.equal(res.body.asymmetry.totalBytes, 0);
  assert.equal(res.body.asymmetry.ratio, null, 'ratio is null when no traffic');
  assert.equal(res.body.asymmetry.asymmetric, false);
});

// ---- viewer is enough; no role elevation needed ------------------------------

test('GET /api/flows/bidirectional is accessible to viewer role', async () => {
  const res = await request(withAgent())
    .get(`/api/flows/bidirectional?${VALID_QS}`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
});
