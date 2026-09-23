'use strict';

// The SQL behind migrations 116-118, against a scripted pool: the statement and
// its parameters. (Whether MySQL accepts the SQL is what
// scripts/verify-repositories-against-mysql.js answers.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFdbEntriesRepository } = require('../src/repositories/fdbEntriesRepository');
const {
  createDeviceCounterSamplesRepository, ALL_COLUMNS,
} = require('../src/repositories/deviceCounterSamplesRepository');
const { createDeviceCounterSamplesTsdbRepository } = require('../src/repositories/deviceCounterSamplesTsdbRepository');
const { createInterfaceStatesRepository } = require('../src/repositories/interfaceStatesRepository');
const { createTopologyChangesRepository } = require('../src/repositories/topologyChangesRepository');
const { createSnmpDevicesRepository } = require('../src/repositories/snmpDevicesRepository');

function scriptedPool(answers = []) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next || [{ affectedRows: 1, insertId: 1 }];
      },
    },
  };
}

test('an FDB sweep records its MOVES in the same pass, keyed on the sweep second', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createFdbEntriesRepository({ pool });
  const at = new Date('2026-09-23T10:00:05.678Z');
  await repo.upsertMany(3, [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 12 }], { at });

  assert.equal(calls.length, 2);
  // last_move_at is a DATETIME: the sweep's own time, cut to the second, or
  // the rows could never be found again by comparing against it.
  const sweep = new Date('2026-09-23T10:00:05.000Z');
  assert.deepEqual(calls[0].params.slice(-1), [sweep]);
  assert.match(calls[1].sql, /^INSERT INTO fdb_mac_moves \(device_id, mac, vlan, from_port, to_port, moved_at\) SELECT/);
  assert.match(calls[1].sql, /last_move_at = \? AND move_count > 0/);
  assert.deepEqual(calls[1].params, [3, sweep]);
});

test('movingMacs counts moves INSIDE the window from the history, and says so', async () => {
  const { pool, calls } = scriptedPool([[[{
    id: 1, device_id: 3, mac: 'm', vlan: 20, bridge_port: 12, prev_bridge_port: 24, move_count: 400,
    last_move_at: new Date(), status: 'learned', port_mac_count: 1, moves_in_window: 5,
  }]]]);
  const repo = createFdbEntriesRepository({ pool });
  const since = new Date('2026-09-23T09:50:00Z');
  const [row] = await repo.movingMacs(3, { since, limit: 50 });
  assert.equal(row.movesInWindow, 5);
  assert.equal(row.moveCount, 400, 'the all-time figure is still there, under its own name');
  assert.match(calls[0].sql, /JOIN fdb_mac_moves m ON .* m\.moved_at >= \?/);
  assert.deepEqual(calls[0].params, [since, 3, 50]);
});

test('VLAN names are upserted, never replaced', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createFdbEntriesRepository({ pool });
  await repo.upsertVlans(3, [{ vlan: 20, name: 'Voice' }, { vlan: 'x', name: 'bad' }, { vlan: 30, name: '' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO device_vlans .* ON DUPLICATE KEY UPDATE name = VALUES\(name\)/);
  assert.equal(calls[0].params.length, 5, 'one row: the malformed two are dropped');
  assert.equal(await repo.upsertVlans(3, []), 0);
});

test('a counter sample carries duplex and the late-collision rate in the column order', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createDeviceCounterSamplesRepository({ pool });
  await repo.insertMany([{
    ts: new Date(), deviceId: 1, interfaceId: 2, duplex: 'half', lateCollPps: 1.5, fcsPps: 0.25,
  }]);
  const params = calls[0].params;
  assert.equal(params.length, ALL_COLUMNS.length);
  assert.equal(params[ALL_COLUMNS.indexOf('duplex')], 'half');
  assert.equal(params[ALL_COLUMNS.indexOf('late_coll_pps')], 1.5);
  assert.equal(params[ALL_COLUMNS.indexOf('fcs_pps')], 0.25);
});

test('the TSDB twin keeps storing on a node that has not been re-migrated yet', async () => {
  const seen = [];
  let first = true;
  const tsdb = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (first && /duplex/.test(sql)) {
        first = false;
        throw Object.assign(new Error('column "duplex" does not exist'), { code: '42703' });
      }
      return [{ '?column?': 1 }];
    },
  };
  const warnings = [];
  const repo = createDeviceCounterSamplesTsdbRepository(tsdb, { logger: { warn: (m) => warnings.push(m) } });
  const row = { ts: new Date(), deviceId: 1, interfaceId: 2, duplex: 'half', lateCollPps: 1 };
  assert.equal(await repo.insertMany([row]), 1);
  assert.equal(await repo.insertMany([row]), 1);
  assert.equal(seen.length, 3, 'one failed attempt, then the legacy shape from then on');
  assert.doesNotMatch(seen[2].sql, /duplex|late_coll_pps/);
  assert.equal(warnings.length, 1, 'said once, with the fix');

  // Any OTHER error is still an error.
  const broken = createDeviceCounterSamplesTsdbRepository({ async query() { throw new Error('connection refused'); } });
  await assert.rejects(() => broken.insertMany([row]), /connection refused/);
});

test('switch-port transitions carry the device, the port and the source; the agent flap lookup excludes them', async () => {
  const { pool, calls } = scriptedPool([[{ insertId: 7 }], [[]], [[]]]);
  const repo = createInterfaceStatesRepository({ pool });
  await repo.insertTransition(9, {
    iface: 'Gi1/0/24', deviceId: 1, interfaceId: 5, fromStatus: 'ok', toStatus: 'down',
    operStatus: 'down', source: 'trap', severity: 'CRIT', summary: 's', detectedAt: new Date(),
  });
  assert.match(calls[0].sql, /\(agent_id, device_id, interface_id, iface, from_status, to_status, oper_status, source, severity, summary, detected_at\)/);
  assert.deepEqual(calls[0].params.slice(0, 3), [9, 1, 5]);
  assert.equal(calls[0].params[7], 'trap');

  await repo.latestForIface({ agentId: 9, iface: 'eth0' });
  assert.match(calls[1].sql, /device_id IS NULL/, 'a polled switch port must never read as the agent\'s own NIC flapping');
  await repo.latestForDeviceIface({ deviceId: 1, iface: 'Gi1/0/24' });
  assert.match(calls[2].sql, /WHERE device_id = \? AND iface = \?/);
});

test('switch-seen neighbour changes carry the device; the agent LLDP flap lookup excludes them', async () => {
  const { pool, calls } = scriptedPool([[{ insertId: 3 }], [[]], [[]]]);
  const repo = createTopologyChangesRepository({ pool });
  await repo.insert({ agentId: 9, deviceId: 1, changeType: 'neighbour_added', summary: 's' });
  assert.deepEqual(calls[0].params.slice(0, 3), [9, 1, 'neighbour_added']);
  await repo.recentForAgent({ agentId: 9, since: new Date() });
  assert.match(calls[1].sql, /agent_id = \? AND device_id IS NULL/);
  await repo.recentForDevice({ deviceId: 1, since: new Date() });
  assert.match(calls[2].sql, /WHERE device_id = \? AND detected_at >= \?/);
});

test('sysDescr is kept with COALESCE, so an older agent never erases it', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createSnmpDevicesRepository({ pool });
  await repo.recordPoll(1, { ok: true, sysDescr: 'Cisco IOS', at: new Date() });
  assert.match(calls[0].sql, /sys_descr = COALESCE\(\?, sys_descr\)/);
  assert.equal(calls[0].params[3], 'Cisco IOS');
  await repo.recordPoll(1, { ok: true, at: new Date() });
  assert.equal(calls[1].params[3], null);
});
