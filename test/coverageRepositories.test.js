'use strict';

// The small read methods the coverage report added to existing repositories,
// against a scripted pool: the statement and its parameters are the contract.
// scripts/verify-repositories-against-mysql.js is where SQL validity is checked.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlowsRepository } = require('../src/repositories/flowsRepository');
const { createArpEntriesRepository } = require('../src/repositories/arpEntriesRepository');
const { createFdbEntriesRepository } = require('../src/repositories/fdbEntriesRepository');

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

const SINCE = new Date('2026-09-22T12:00:00Z');

// ============================================================ flows
test('lastFlowAtByAgent is one grouped MAX per agent, answered from the (agent_id, ts) index', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /SELECT agent_id, MAX\(ts\) AS last_ts FROM flow_records GROUP BY agent_id/);
    // No window in the WHERE: the loose index scan is one probe per agent,
    // and the caller decides what "recent" means.
    assert.doesNotMatch(sql, /WHERE/);
    assert.deepEqual(params, []);
    return [[{ agent_id: '3', last_ts: new Date('2026-09-23T10:00:00Z') }, { agent_id: 4, last_ts: null }]];
  });
  const rows = await createFlowsRepository({ pool }).lastFlowAtByAgent();
  assert.deepEqual(rows, [
    { agentId: 3, lastFlowAt: '2026-09-23T10:00:00.000Z' },
    { agentId: 4, lastFlowAt: null },
  ]);
  assert.equal(pool.calls.length, 1);
});

// ============================================================ arp
test('subnetSummary aggregates IPv4 per /24 in SQL, windowed and capped', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /SUBSTRING_INDEX\(ip, '\.', 3\) AS prefix/);
    assert.match(sql, /COUNT\(DISTINCT ip\) AS ips, COUNT\(DISTINCT agent_id\) AS agents/);
    assert.match(sql, /ip NOT LIKE '%:%'/, 'IPv6 is kept out');
    assert.match(sql, /last_seen >= \?/);
    assert.match(sql, /GROUP BY prefix\s+ORDER BY ips DESC, prefix ASC\s+LIMIT \?/);
    assert.deepEqual(params, [SINCE, 100]);
    return [[{ prefix: '10.0.1', ips: '12', agents: '2', last_seen: new Date('2026-09-23T09:00:00Z') }]];
  });
  const rows = await createArpEntriesRepository({ pool }).subnetSummary({ since: SINCE, limit: 100 });
  assert.deepEqual(rows, [{ prefix: '10.0.1', ips: 12, agents: 2, lastSeen: '2026-09-23T09:00:00.000Z' }]);
});

test('subnetSummary falls back to its default cap on a bad limit', async () => {
  const pool = fakePool((sql, params) => [[]]);
  const repo = createArpEntriesRepository({ pool });
  for (const bad of [0, -1, 'x', 5001, 1.5]) {
    await repo.subnetSummary({ since: SINCE, limit: bad });
    assert.equal(pool.calls[pool.calls.length - 1].params[1], 500, String(bad));
  }
});

test('macsForIps is one IN () read, bounded on both sides; no IPs is no query', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /SELECT DISTINCT ip, mac FROM arp_entries WHERE ip IN \(\?\) LIMIT \?/);
    assert.deepEqual(params, [['10.0.0.5', '10.0.0.6'], 5000]);
    return [[{ ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff' }]];
  });
  const repo = createArpEntriesRepository({ pool });
  assert.deepEqual(await repo.macsForIps(['10.0.0.5', null, 7, '', '10.0.0.6']), [{ ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff' }]);
  assert.deepEqual(await repo.macsForIps([]), []);
  assert.deepEqual(await repo.macsForIps(null), []);
  assert.equal(pool.calls.length, 1);

  const big = fakePool((sql, params) => { assert.equal(params[0].length, 1000); return [[]]; });
  await createArpEntriesRepository({ pool: big }).macsForIps(Array.from({ length: 1500 }, (_, i) => `10.1.${i >> 8}.${i & 255}`));
});

// ============================================================ fdb
test('listUpPortMacs joins the port on its NAME, keeps only learned MACs on up ports, windowed and capped', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /FROM fdb_entries f\s+JOIN device_interfaces i ON i\.device_id = f\.device_id AND i\.if_name = f\.if_name/);
    assert.match(sql, /i\.oper_status = 'up'/);
    assert.match(sql, /f\.status = 'learned'/);
    assert.match(sql, /f\.last_seen >= \?/);
    assert.match(sql, /LIMIT \?$/m);
    assert.deepEqual(params, [SINCE, 20000]);
    return [[{ device_id: '5', if_name: 'Gi0/3', mac: 'aa:bb:cc:dd:ee:01', port_mac_count: '1' }]];
  });
  const rows = await createFdbEntriesRepository({ pool }).listUpPortMacs({ since: SINCE });
  assert.deepEqual(rows, [{ deviceId: 5, ifName: 'Gi0/3', mac: 'aa:bb:cc:dd:ee:01', portMacCount: 1 }]);
});

test('listUpPortMacs falls back to its default cap on a bad limit', async () => {
  const pool = fakePool(() => [[]]);
  await createFdbEntriesRepository({ pool }).listUpPortMacs({ since: SINCE, limit: 10 ** 9 });
  assert.equal(pool.calls[0].params[1], 20000);
});
