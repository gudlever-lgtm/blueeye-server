'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The flow / probe / speed-test TSDB mirrors (docs/storage-split-audit.md).
// Same rules as the results mirror (resultsTsdbMirror.test.js): MySQL is the
// source of truth, the TSDB write is best-effort and only happens when TSDB is
// enabled, and a TSDB failure never reaches the agent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeProbeResultsRepo, makeSpeedtestResultsRepo,
} = require('../test-support/fakes');
const {
  createFlowsTsdbRepository, COLUMNS: FLOW_COLUMNS, LEGACY_COLUMNS: FLOW_LEGACY,
} = require('../src/repositories/flowsTsdbRepository');
const {
  createProbeResultsTsdbRepository, INSERT_COLUMNS: PROBE_COLUMNS, LEGACY_COLUMNS: PROBE_LEGACY, COLUMN_SETS: PROBE_SETS,
} = require('../src/repositories/probeResultsTsdbRepository');
const { createSpeedtestResultsTsdbRepository } = require('../src/repositories/speedtestResultsTsdbRepository');
const { createFlowPipeline } = require('../src/geo/flowPipeline');

// Fake pg pool: records every query and answers from `onQuery` (or rowCount 0).
function makePool(onQuery) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return onQuery ? onQuery(text, params, calls.length) : { rows: [], rowCount: 0 };
    },
  };
}

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const silent = { info() {}, warn() {}, error() {} };

// ============================================================ flow_records
test('flows: one unnest() INSERT with one typed array per column, however many rows', async () => {
  const pool = makePool((_t, params) => ({ rowCount: params[0].length }));
  const repo = createFlowsTsdbRepository({ pool });
  const ts = new Date('2026-09-01T10:00:00Z');
  const rec = (i) => ({
    agentId: 7, ts, srcIp: '10.0.0.5', dstIp: `8.8.8.${i}`, extIp: `8.8.8.${i}`, direction: 'out', proto: 'tcp',
    srcPort: 51000 + i, dstPort: 443, bytes: 1000 * i, packets: i, flows: 1, internal: false,
    country: 'DE', asn: 3320, asnName: 'Deutsche Telekom',
  });

  const n = await repo.insertMany([rec(1), rec(2), rec(3)]);

  assert.equal(n, 3);
  assert.equal(pool.calls.length, 1, 'one statement for the whole batch');
  const { text, params } = pool.calls[0];
  assert.match(text, /^INSERT INTO flow_records \(agent_id, ts, src_ip, dst_ip, ext_ip, direction, proto, src_port, dst_port, bytes, packets, flows, internal, country, asn, asn_name, vlan, in_if, out_if\)/);
  assert.match(text, /SELECT \* FROM unnest\(\$1::int\[\], \$2::timestamptz\[\], .*\$16::text\[\], \$17::int\[\], \$18::bigint\[\], \$19::bigint\[\]\)/s);
  assert.equal(params.length, FLOW_COLUMNS.length, 'one parameter per column, never one per row');
  assert.deepEqual(params[0], [7, 7, 7]);
  assert.deepEqual(params[1], [ts, ts, ts]);
  assert.deepEqual(params[3], ['8.8.8.1', '8.8.8.2', '8.8.8.3']);
  assert.deepEqual(params[9], [1000, 2000, 3000]);
  assert.deepEqual(params[12], [false, false, false], 'internal is a BOOLEAN here, not 1/0');
  assert.deepEqual(params[13], ['DE', 'DE', 'DE']);
});

test('flows: a thousand-row report is still one statement (no 65 535-parameter ceiling)', async () => {
  const pool = makePool((_t, params) => ({ rowCount: params[0].length }));
  const repo = createFlowsTsdbRepository({ pool });
  const many = Array.from({ length: 5000 }, (_, i) => ({ agentId: 1, dstIp: `10.1.${i >> 8}.${i & 255}`, bytes: i, internal: true }));
  assert.equal(await repo.insertMany(many), 5000);
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].params.length, FLOW_COLUMNS.length);
});

test('flows: the VLAN and exporter in/out ifIndex are mirrored (migration 127), range-checked like MySQL', async () => {
  const pool = makePool(() => ({ rowCount: 3 }));
  const repo = createFlowsTsdbRepository({ pool });
  await repo.insertMany([
    { agentId: 1, dstIp: '10.0.0.1', vlan: 20, inIf: 3, outIf: 4294967295 },
    { agentId: 1, dstIp: '10.0.0.2' }, // NetFlow v5 / an older agent: none of them
    { agentId: 1, dstIp: '10.0.0.3', vlan: 4095, inIf: 0, outIf: 'x' }, // out of range → NULL, not a failed batch
  ]);
  const col = (name) => pool.calls[0].params[FLOW_COLUMNS.findIndex(([c]) => c === name)];
  assert.deepEqual(col('vlan'), [20, null, null]);
  assert.deepEqual(col('in_if'), [3, null, null]);
  assert.deepEqual(col('out_if'), [4294967295, null, null]);
});

test('flows: a node without vlan/in_if/out_if falls back to the original sixteen columns, once', async () => {
  const warnings = [];
  const pool = makePool((text, params) => {
    if (/in_if/.test(text)) { const e = new Error('column "vlan" of relation "flow_records" does not exist'); e.code = '42703'; throw e; }
    return { rowCount: params[0].length };
  });
  const repo = createFlowsTsdbRepository({ pool }, { logger: { warn: (m) => warnings.push(m) } });

  assert.equal(await repo.insertMany([{ agentId: 1, dstIp: '1.1.1.1', vlan: 20 }]), 1, 'the batch still lands');
  assert.equal(pool.calls.length, 2, 'tried the full shape, then the legacy one');
  assert.match(pool.calls[1].text, new RegExp(`\\(${FLOW_LEGACY.map(([c]) => c).join(', ')}\\)`));
  assert.equal(pool.calls[1].params.length, FLOW_LEGACY.length);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /re-run server\/db\/timescale\/001_init\.sql/);

  await repo.insertMany([{ agentId: 1, dstIp: '1.1.1.2' }]);
  assert.equal(pool.calls.length, 3, 'later inserts go straight to the legacy shape');
  assert.doesNotMatch(pool.calls[2].text, /in_if/);
});

test('flows: nulls and junk are normalised, never sent as values Postgres refuses', async () => {
  const pool = makePool(() => ({ rowCount: 1 }));
  const repo = createFlowsTsdbRepository({ pool });
  await repo.insertMany([{ agentId: '4', ts: '2026-09-01T10:00:00Z', srcPort: 'x', country: 'Denmark', internal: 1 }]);
  const p = pool.calls[0].params;
  assert.equal(p[0][0], 4);
  assert.ok(p[1][0] instanceof Date);
  assert.equal(p[7][0], null, 'a non-numeric port is null, not NaN');
  assert.equal(p[9][0], 0, 'missing bytes default to 0 (NOT NULL column)');
  assert.equal(p[12][0], true);
  assert.equal(p[13][0], null, 'CHAR(2): only a two-letter code is a country');
});

test('flows: an empty batch is a no-op; a TSDB error propagates (the caller swallows it)', async () => {
  const pool = makePool(async () => { throw new Error('relation "flow_records" does not exist'); });
  const repo = createFlowsTsdbRepository({ pool });
  assert.equal(await repo.insertMany([]), 0);
  assert.equal(await repo.insertMany(null), 0);
  assert.equal(pool.calls.length, 0);
  await assert.rejects(() => repo.insertMany([{ agentId: 1 }]), /does not exist/);
});

// ------------------------------------------------------- flow pipeline wiring
function pipeline({ mysql, tsdb, logger = silent }) {
  return createFlowPipeline({
    flowsRepo: mysql,
    enricher: { enrichMany: (raw) => raw },
    extract: () => [{ agentId: 3, dstIp: '1.1.1.1', bytes: 10 }],
    config: { geoEnabled: true },
    logger,
    flowsTsdbRepo: tsdb,
  });
}

test('flow pipeline: mirrors exactly what MySQL stored, into the TSDB', async () => {
  let stored = null;
  let mirrored = null;
  const pipe = pipeline({
    mysql: { insertMany: async (recs) => { stored = recs; return recs.length; } },
    tsdb: { insertMany: async (recs) => { mirrored = recs; return recs.length; } },
  });
  assert.equal(await pipe.processResults(3, [{}]), 1);
  assert.equal(mirrored, stored, 'the very batch MySQL accepted');
  assert.equal(mirrored[0].dstIp, '1.1.1.1');
});

test('flow pipeline: a failing TSDB mirror is logged and changes nothing', async () => {
  const warnings = [];
  const pipe = pipeline({
    mysql: { insertMany: async (recs) => recs.length },
    tsdb: { insertMany: async () => { throw new Error('TSDB down'); } },
    logger: { ...silent, warn: (m) => warnings.push(m) },
  });
  assert.equal(await pipe.processResults(3, [{}]), 1, 'the MySQL count stands');
  assert.ok(warnings.some((w) => /tsdb: flow_records mirror write failed \(TSDB down\)/.test(w)));
});

test('flow pipeline: nothing is mirrored when MySQL did not store it, or when TSDB is off', async () => {
  let mirrorCalls = 0;
  const tsdb = { insertMany: async () => { mirrorCalls += 1; return 1; } };
  const failing = pipeline({ mysql: { insertMany: async () => { throw new Error('mysql down'); } }, tsdb });
  assert.equal(await failing.processResults(3, [{}]), 0);
  assert.equal(mirrorCalls, 0, 'the TSDB must never hold a row the source of truth refused');

  const off = pipeline({ mysql: { insertMany: async (r) => r.length }, tsdb: null });
  assert.equal(await off.processResults(3, [{}]), 1);
});

// ============================================================ probe_results
test('probes: a multi-row INSERT of every column, normalised through the MySQL toRow()', async () => {
  const pool = makePool(() => ({ rowCount: 2 }));
  const repo = createProbeResultsTsdbRepository({ pool });
  const ts = new Date('2026-09-01T10:00:00Z');

  const n = await repo.createMany(9, [
    { type: 'ping', target: '1.1.1.1', ok: true, rttMs: 12.5, lossPct: 0, ts },
    { type: 'dns', target: 'example.org', ok: false, errorCode: 'ENOTFOUND', failure: 'nxdomain', resolver: '10.0.0.53', certExpiryDays: 12.6, ts },
  ]);

  assert.equal(n, 2);
  const { text, params } = pool.calls[0];
  assert.match(text, new RegExp(`^INSERT INTO probe_results \\(${PROBE_COLUMNS.join(', ')}\\) VALUES \\(\\$1,`));
  assert.match(text, new RegExp(`\\(\\$${PROBE_COLUMNS.length + 1}, `), 'the second row numbers on from the first');
  assert.equal(params.length, PROBE_COLUMNS.length * 2);
  const row = (i) => Object.fromEntries(PROBE_COLUMNS.map((c, j) => [c, params[i * PROBE_COLUMNS.length + j]]));
  assert.equal(row(0).agent_id, 9);
  assert.equal(row(0).ok, true, 'BOOLEAN here, not 1/0');
  assert.equal(row(0).rtt_ms, 12.5);
  assert.equal(row(1).ok, false);
  assert.equal(row(1).error_code, 'ENOTFOUND');
  assert.equal(row(1).failure, 'nxdomain');
  assert.equal(row(1).resolver, '10.0.0.53');
  assert.equal(row(1).cert_expiry_days, 13, 'an INTEGER column gets a whole number');
});

test('probes: a node without the added columns falls back to the original set, once', async () => {
  const warnings = [];
  const pool = makePool((text) => {
    if (/error_code/.test(text)) { const e = new Error('column "bytes" of relation "probe_results" does not exist'); e.code = '42703'; throw e; }
    return { rowCount: 1 };
  });
  const repo = createProbeResultsTsdbRepository({ pool }, { logger: { warn: (m) => warnings.push(m) } });

  assert.equal(await repo.createMany(9, [{ type: 'ping', target: 'a', ok: true }]), 1);
  // Updated deliberately: the column sets now step down one at a time (with
  // dhcp → without dhcp → the original), so reaching the original takes three.
  assert.equal(pool.calls.length, 3, 'tried the full shape, the pre-dhcp shape, then the legacy one');
  assert.match(pool.calls[2].text, new RegExp(`\\(${PROBE_LEGACY.join(', ')}\\)`));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /re-run server\/db\/timescale\/001_init\.sql/);

  await repo.createMany(9, [{ type: 'ping', target: 'b', ok: true }]);
  assert.equal(pool.calls.length, 4, 'later inserts go straight to the legacy shape');
  assert.doesNotMatch(pool.calls[3].text, /error_code/);
});

test('probes: the DHCP offers are mirrored (migration 132) as JSON', async () => {
  const pool = makePool(() => ({ rowCount: 1 }));
  const repo = createProbeResultsTsdbRepository({ pool });
  assert.ok(PROBE_COLUMNS.includes('dhcp'));
  const offers = { offers: [{ server: '10.0.0.1', yiaddr: '10.0.0.50' }], rogue: false };
  await repo.createMany(9, [{ type: 'dhcp', target: 'eth0', ok: true, dhcp: offers }]);
  const { params } = pool.calls[0];
  const dhcp = params[PROBE_COLUMNS.indexOf('dhcp')];
  assert.deepEqual(JSON.parse(dhcp), offers);
});

test('probes: a node re-migrated before dhcp keeps the other added columns', async () => {
  const pool = makePool((text) => {
    if (/dhcp/.test(text)) { const e = new Error('column "dhcp" of relation "probe_results" does not exist'); e.code = '42703'; throw e; }
    return { rowCount: 1 };
  });
  const repo = createProbeResultsTsdbRepository({ pool }, { logger: { warn() {} } });
  await repo.createMany(9, [{ type: 'dns', target: 'a', ok: false, failure: 'nxdomain', dhcp: { offers: [] } }]);
  assert.equal(pool.calls.length, 2);
  assert.deepEqual(PROBE_SETS[1], PROBE_COLUMNS.filter((c) => c !== 'dhcp'));
  const p = pool.calls[1].params;
  assert.equal(p[PROBE_SETS[1].indexOf('failure')], 'nxdomain', 'failure reason still mirrored');
});

test('probes: any other TSDB error propagates; an empty batch is a no-op', async () => {
  const pool = makePool(async () => { throw new Error('ECONNREFUSED'); });
  const repo = createProbeResultsTsdbRepository({ pool });
  assert.equal(await repo.createMany(9, []), 0);
  assert.equal(pool.calls.length, 0);
  await assert.rejects(() => repo.createMany(9, [{ type: 'ping', target: 'a' }]), /ECONNREFUSED/);
});

// ------------------------------------------------------- probe route wiring
const probeBody = { results: [{ type: 'ping', target: '1.1.1.1', ok: true, rttMs: 12.3 }] };

test('POST /agents/probe-results mirrors into the TSDB when enabled', async () => {
  let mirrored;
  const probeResultsTsdbRepo = { createMany: async (agentId, results) => { mirrored = { agentId, results }; return results.length; } };
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo: makeProbeResultsRepo(), probeResultsTsdbRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t').send(probeBody);
  assert.equal(res.status, 201);
  assert.equal(mirrored.agentId, 9);
  assert.equal(mirrored.results[0].target, '1.1.1.1');
});

test('POST /agents/probe-results still 201 when the TSDB mirror fails', async () => {
  const probeResultsTsdbRepo = { createMany: async () => { throw new Error('TSDB down'); } };
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsTsdbRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t').send(probeBody);
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted, 1);
});

test('POST /agents/probe-results: 400 never mirrors; a MySQL failure (500) never mirrors', async () => {
  let calls = 0;
  const probeResultsTsdbRepo = { createMany: async () => { calls += 1; return 0; } };
  const bad = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsTsdbRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t').send({ results: [{ type: 'bogus' }] });
  assert.equal(bad.status, 400);
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async () => { throw new Error('mysql down'); } });
  const broken = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo, probeResultsTsdbRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t').send(probeBody);
  assert.equal(broken.status, 500);
  assert.equal(calls, 0);
});

// ========================================================= speedtest_results
test('speedtest: one INSERT with the MySQL columns, BOOLEAN ok and whole-number byte counts', async () => {
  const pool = makePool(() => ({ rowCount: 1 }));
  const repo = createSpeedtestResultsTsdbRepository({ pool });
  const ts = new Date('2026-09-01T10:00:00Z');
  assert.equal(await repo.create(9, { ts, ok: true, downMbps: 120.5, upMbps: 40, downBytes: 1000.4, upBytes: 999, downMs: 66, upMs: 200, target: 'srv', detail: null }), 1);
  const { text, params } = pool.calls[0];
  assert.match(text, /^INSERT INTO speedtest_results \(agent_id, ts, ok, down_mbps, up_mbps, down_bytes, up_bytes, down_ms, up_ms, target, detail\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11\)$/);
  assert.deepEqual(params, [9, ts, true, 120.5, 40, 1000, 999, 66, 200, 'srv', null]);
});

test('POST /speedtest/results mirrors the same measurement (same ts) into the TSDB', async () => {
  const speedtestResultsRepo = makeSpeedtestResultsRepo();
  let mirrored;
  const speedtestResultsTsdbRepo = { create: async (agentId, r) => { mirrored = { agentId, r }; return 1; } };
  const res = await request(makeApp({ agentTokensRepo: agentToken(), speedtestResultsRepo, speedtestResultsTsdbRepo }))
    .post('/speedtest/results').set('Authorization', 'Bearer good')
    .send({ result: { ok: true, downMbps: 100, upMbps: 20 } });
  assert.equal(res.status, 201);
  assert.equal(mirrored.agentId, 9);
  assert.equal(mirrored.r.downMbps, 100);
  assert.ok(mirrored.r.ts instanceof Date, 'a result without ts is stamped once, for both stores');
  assert.equal(speedtestResultsRepo.rows[0].ts.getTime(), mirrored.r.ts.getTime());
});

test('POST /speedtest/results: 201 when the mirror fails, 400 never mirrors', async () => {
  let calls = 0;
  const failing = { create: async () => { calls += 1; throw new Error('TSDB down'); } };
  const app = makeApp({ agentTokensRepo: agentToken(), speedtestResultsTsdbRepo: failing });
  const ok = await request(app).post('/speedtest/results').set('Authorization', 'Bearer good').send({ result: { ok: true, downMbps: 1 } });
  assert.equal(ok.status, 201);
  assert.equal(calls, 1);
  const bad = await request(app).post('/speedtest/results').set('Authorization', 'Bearer good').send({ result: { downMbps: -1 } });
  assert.equal(bad.status, 400);
  assert.equal(calls, 1);
});
