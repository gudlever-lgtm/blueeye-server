'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeFlowsRepo, authHeader } = require('../test-support/fakes');
const { createFlowsRepository } = require('../src/repositories/flowsRepository');

const withAgent = (overrides = {}) => makeApp({ agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: `h${id}` }) }), ...overrides });

// ---- route -----------------------------------------------------------------

test('GET /api/flows/explore without a token is 401', async () => {
  const res = await request(makeApp()).get('/api/flows/explore?agentId=1');
  assert.equal(res.status, 401);
});

test('GET /api/flows/explore requires agentId (400) and a real agent (404)', async () => {
  assert.equal((await request(withAgent()).get('/api/flows/explore').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(makeApp()).get('/api/flows/explore?agentId=9').set('Authorization', authHeader('viewer'))).status, 404);
});

test('GET /api/flows/explore rejects a bad port (400)', async () => {
  const res = await request(withAgent()).get('/api/flows/explore?agentId=9&port=notaport').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/flows/explore returns talkers + scans and echoes the filter (200)', async () => {
  let captured;
  const flowsRepo = makeFlowsRepo({
    exploreFlows: async (f) => {
      captured = f;
      return {
        topTalkers: [{ srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', asnName: 'GOOGLE', country: 'US', internal: false, bytes: 1000, packets: 10, flowCount: 3 }],
        byPort: [{ port: 443, proto: 'tcp', bytes: 900, flowCount: 2 }],
        byProto: [{ proto: 'tcp', bytes: 1000, flowCount: 3 }],
        series: [{ at: '2026-06-02T11:00:00.000Z', bytes: 1000, flowCount: 3 }],
        scans: [{ srcIp: '10.0.0.9', distinctPorts: 120, distinctHosts: 2, bytes: 50, flowCount: 120, kind: 'port-scan' }],
        totals: { bytes: 1000, packets: 10, flowCount: 3, records: 5 },
      };
    },
  });
  const res = await request(withAgent({ flowsRepo })).get('/api/flows/explore?agentId=9&proto=tcp&peer=10.0.0.5&port=443&direction=out&internal=external').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.topTalkers[0].dstIp, '8.8.8.8');
  assert.equal(res.body.scans[0].kind, 'port-scan');
  assert.equal(res.body.filter.peer, '10.0.0.5');
  assert.equal(res.body.filter.port, 443);
  // sanitised filters are threaded to the repo
  assert.equal(captured.proto, 'tcp');
  assert.equal(captured.peer, '10.0.0.5');
  assert.equal(captured.direction, 'out');
  assert.equal(captured.internal, false);
});

test('GET /api/flows/explore drops an injection-looking peer (not threaded to the repo)', async () => {
  let captured;
  const flowsRepo = makeFlowsRepo({ exploreFlows: async (f) => { captured = f; return { topTalkers: [], byPort: [], byProto: [], series: [], scans: [], totals: { bytes: 0, packets: 0, flowCount: 0, records: 0 } }; } });
  const res = await request(withAgent({ flowsRepo })).get("/api/flows/explore?agentId=9&peer=' OR 1=1--").set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(captured.peer, null); // rejected by the sanitiser
});

// ---- repository (SQL shape, parameter binding, scan detection) -------------

function recordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) { queries.push({ sql, params }); return [[]]; },
  };
}

test('exploreFlows binds filters, groups talkers, and detects scans via HAVING', async () => {
  const pool = recordingPool();
  const repo = createFlowsRepository({ pool });
  await repo.exploreFlows({
    agentId: 9, from: new Date('2026-06-02T00:00:00Z'), to: new Date('2026-06-02T06:00:00Z'),
    proto: 'tcp', peer: '10.0.0.5', internal: true, bucketSec: 300,
  });
  const sqls = pool.queries.map((x) => x.sql);
  assert.ok(sqls.some((s) => /GROUP BY src_ip, dst_ip, ext_ip[\s\S]*ORDER BY bytes DESC LIMIT/.test(s)), 'top-talkers query');
  assert.ok(sqls.some((s) => /COUNT\(DISTINCT dst_port\)[\s\S]*HAVING ports >= \? OR hosts >= \?/.test(s)), 'scan query');
  // PRIVACY/INJECTION: the peer is a bound parameter, never interpolated into SQL.
  for (const x of pool.queries) assert.ok(!String(x.sql).includes('10.0.0.5'), 'peer must not be in SQL text');
  assert.ok(pool.queries.some((x) => (x.params || []).includes('10.0.0.5')), 'peer must be a bound param');
  // internal=true ⇒ the main filter constrains internal = 1.
  assert.ok(sqls.some((s) => /internal = 1/.test(s)));
});

test('exploreFlows scan window omits the per-conversation port/peer filters', async () => {
  const pool = recordingPool();
  const repo = createFlowsRepository({ pool });
  await repo.exploreFlows({ agentId: 9, from: new Date('2026-06-02T00:00:00Z'), to: new Date('2026-06-02T06:00:00Z'), peer: '10.0.0.5', port: 443 });
  const scan = pool.queries.find((x) => /COUNT\(DISTINCT dst_port\)/.test(x.sql));
  assert.ok(scan, 'scan query present');
  // scan detection must look at ALL of the agent's sources, not just the filtered conversation
  assert.ok(!/src_ip = \?/.test(scan.sql) && !/src_port = \?/.test(scan.sql));
});
