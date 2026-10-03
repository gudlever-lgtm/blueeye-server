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

// ---- city-level destinations (migration 145) -------------------------------
// flow_rollup has no city column, so a window spanning the raw-retention
// horizon shows the recent half on its city and the older half on the country.
test('aggregateExternalDestinations keeps city and country rows apart', async () => {
  const pool = {
    async query(sql) {
      if (/FROM flow_records/.test(sql) && /GROUP BY country, asn, city/.test(sql)) {
        return [[
          { country: 'CA', asn: 852, asnName: 'TELUS', city: 'Montreal', cityLat: 45.5, cityLng: -73.57, bytes: 70, flowCount: 7 },
          { country: 'CA', asn: 13335, asnName: 'CLOUDFLARENET', city: null, cityLat: null, cityLng: null, bytes: 5, flowCount: 1 },
        ]];
      }
      if (/FROM flow_rollup/.test(sql) && /GROUP BY country, asn/.test(sql)) {
        return [[{ country: 'CA', asn: 852, asnName: 'TELUS', bytes: 30, flowCount: 3 }]];
      }
      return [[]];
    },
  };
  const repo = createFlowsRepository({ pool });
  const out = await repo.aggregateExternalDestinations(win);

  const city = out.find((d) => d.city === 'Montreal');
  assert.equal(city.bytes, 70);
  assert.equal(city.cityLat, 45.5);
  assert.equal(city.cityLng, -73.57);

  // The rollup half of the SAME country+ASN cannot be split by city, so it is
  // its own country-level row rather than being folded into Montreal.
  const rolled = out.find((d) => d.asn === 852 && d.city === null);
  assert.equal(rolled.bytes, 30);
  assert.equal(rolled.cityLat, null);

  const cdn = out.find((d) => d.asn === 13335);
  assert.equal(cdn.city, null);
  assert.equal(cdn.bytes, 5);
});

test('a city selection reads raw only — the rollup has no city to filter on', async () => {
  const asked = [];
  const pool = {
    async query(sql, params) {
      asked.push({ sql, params });
      if (/SELECT 1 /.test(sql)) return [[{ x: 1 }]];
      return [[]];
    },
  };
  const repo = createFlowsRepository({ pool });
  await repo.destinationExists({ country: 'CA', asn: 852, city: 'Montreal', ...win });
  const tables = asked.map((a) => a.sql);
  assert.ok(tables.some((s) => /FROM flow_records/.test(s) && /city = \?/.test(s)));
  assert.ok(!tables.some((s) => /FROM flow_rollup/.test(s)), 'the rollup must not be asked for a city');
  assert.ok(asked[0].params.includes('Montreal'));
});
