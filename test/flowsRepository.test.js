'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlowsRepository, toRow } = require('../src/repositories/flowsRepository');

function makeFakePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^INSERT INTO flow_records/i.test(sql)) {
        const rows = params[0];
        return [{ affectedRows: rows.length }];
      }
      if (/^SELECT/i.test(sql)) {
        return [[]]; // empty result set
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('toRow maps an enriched record to positional columns', () => {
  const row = toRow({
    agentId: 9, ts: new Date('2026-01-01T00:00:00Z'), srcIp: '10.0.0.1', dstIp: '8.8.8.8',
    extIp: '8.8.8.8', direction: 'out', proto: 'tcp', srcPort: 5, dstPort: 443,
    bytes: 100, packets: 3, flows: 1, internal: false, country: 'US', asn: 15169, asnName: 'GOOGLE',
  });
  assert.equal(row[0], 9);          // agent_id
  assert.equal(row[4], '8.8.8.8');  // ext_ip
  assert.equal(row[12], 0);         // internal -> 0
  assert.equal(row[13], 'US');      // country
  assert.equal(row[14], 15169);     // asn
});

test('toRow flags internal and defaults a missing ts', () => {
  const row = toRow({ agentId: 1, srcIp: '10.0.0.1', dstIp: '10.0.0.2', internal: true });
  assert.equal(row[12], 1);
  assert.ok(row[1] instanceof Date); // ts defaulted to now
});

test('insertMany bulk-inserts and returns the row count', async () => {
  const pool = makeFakePool();
  const repo = createFlowsRepository({ pool });
  const n = await repo.insertMany([
    { agentId: 9, dstIp: '8.8.8.8', country: 'US', bytes: 10 },
    { agentId: 9, dstIp: '1.1.1.1', country: 'AU', bytes: 20 },
  ]);
  assert.equal(n, 2);
  assert.match(pool.queries[0].sql, /INSERT INTO flow_records/);
  assert.equal(pool.queries[0].params[0].length, 2);
});

test('insertMany on an empty/invalid list is a no-op', async () => {
  const pool = makeFakePool();
  const repo = createFlowsRepository({ pool });
  assert.equal(await repo.insertMany([]), 0);
  assert.equal(await repo.insertMany(null), 0);
  assert.equal(pool.queries.length, 0);
});

test('PRIVACY: aggregateExternalDestinations filters internal + null country in SQL', async () => {
  const pool = makeFakePool();
  const repo = createFlowsRepository({ pool });
  const win = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-02T00:00:00Z') };
  const out = await repo.aggregateExternalDestinations(win);
  assert.deepEqual(out, []); // empty fake result
  assert.ok(pool.queries.length >= 1);
  for (const q of pool.queries) {
    assert.match(q.sql, /internal = 0/);
    assert.match(q.sql, /country IS NOT NULL/);
  }
});

test('selection read methods issue queries without throwing', async () => {
  const pool = makeFakePool();
  const repo = createFlowsRepository({ pool });
  const win = { country: 'DE', since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-02T00:00:00Z') };
  assert.equal(await repo.destinationExists(win), false);
  assert.deepEqual(await repo.agentIdsForDestination(win), []);
  const detail = await repo.selectFlows(win);
  assert.deepEqual(detail.byAsn, []);
  assert.equal(detail.totals.bytes, 0);
});
