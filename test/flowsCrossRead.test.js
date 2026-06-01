'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlowsRepository } = require('../src/repositories/flowsRepository');

// A fake pool that serves raw rows from flow_records and aggregated rows from
// flow_rollup, so we can prove the repo reads coherently across both.
function makeFakePool() {
  return {
    async query(sql) {
      if (/FROM flow_records/.test(sql)) {
        if (/GROUP BY country, asn/.test(sql)) return [[{ country: 'US', asn: 15169, asnName: 'GOOGLE', bytes: 70, flowCount: 7 }]];
        if (/AS bucket/.test(sql)) return [[{ bucket: '2026-01-03 00:00:00', bytes: 30, flowCount: 3 }, { bucket: '2026-01-04 00:00:00', bytes: 40, flowCount: 4 }]];
        if (/GROUP BY asn/.test(sql)) return [[{ asn: 15169, asnName: 'GOOGLE', bytes: 70, flowCount: 7 }]];
        if (/GROUP BY direction/.test(sql)) return [[{ direction: 'out', bytes: 70, flowCount: 7 }]];
        if (/GROUP BY proto/.test(sql)) return [[{ proto: 'tcp', bytes: 70, flowCount: 7 }]];
        if (/DISTINCT agent_id/.test(sql)) return [[{ agent_id: 9 }]];
        if (/SELECT 1 /.test(sql)) return [[{ x: 1 }]];
        return [[{ bytes: 70, flowCount: 7 }]]; // totals
      }
      if (/FROM flow_rollup/.test(sql)) {
        if (/GROUP BY country, asn/.test(sql)) return [[{ country: 'US', asn: 15169, asnName: 'GOOGLE', bytes: 30, flowCount: 3 }]];
        if (/AS bucket/.test(sql)) return [[{ bucket: '2026-01-01 00:00:00', bytes: 10, flowCount: 1 }, { bucket: '2026-01-02 00:00:00', bytes: 20, flowCount: 2 }]];
        if (/GROUP BY asn/.test(sql)) return [[{ asn: 15169, asnName: 'GOOGLE', bytes: 30, flowCount: 3 }]];
        if (/GROUP BY direction/.test(sql)) return [[{ direction: 'out', bytes: 30, flowCount: 3 }]];
        if (/DISTINCT agent_id/.test(sql)) return [[{ agent_id: 9 }]];
        if (/SELECT 1 /.test(sql)) return [[]];
        return [[{ bytes: 30, flowCount: 3 }]]; // totals
      }
      return [[]];
    },
  };
}

const win = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-05T00:00:00Z') };

test('aggregateExternalDestinations sums raw + rollup for a destination', async () => {
  const repo = createFlowsRepository({ pool: makeFakePool() });
  const out = await repo.aggregateExternalDestinations(win);
  const us = out.find((d) => d.country === 'US');
  assert.ok(us);
  assert.equal(us.bytes, 100); // 70 raw + 30 rollup
  assert.equal(us.asn, 15169);
});

test('selectFlows returns one coherent ascending series across rollup + raw', async () => {
  const repo = createFlowsRepository({ pool: makeFakePool() });
  const detail = await repo.selectFlows({ country: 'US', since: win.since, until: win.until });
  const times = detail.series.map((p) => p.at);
  assert.deepEqual(times, ['2026-01-01 00:00:00', '2026-01-02 00:00:00', '2026-01-03 00:00:00', '2026-01-04 00:00:00']);
  assert.equal(detail.totals.bytes, 100); // 70 raw + 30 rollup
  assert.equal(detail.byAsn[0].bytes, 100); // merged by asn
});

test('destinationExists is true when only the rollup has the destination', async () => {
  // raw "SELECT 1" returns empty, rollup "SELECT 1" returns empty in this pool;
  // flip: make a pool where only rollup has it.
  const pool = {
    async query(sql) {
      if (/FROM flow_records/.test(sql) && /SELECT 1 /.test(sql)) return [[]];
      if (/FROM flow_rollup/.test(sql) && /SELECT 1 /.test(sql)) return [[{ x: 1 }]];
      return [[]];
    },
  };
  const repo = createFlowsRepository({ pool });
  assert.equal(await repo.destinationExists({ country: 'DE', ...win }), true);
});
