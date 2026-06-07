'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { computeNicInventory } = require('../src/health/nicInventory');
const { makeApp, makeAgentsRepo, authHeader } = require('../test-support/fakes');

// Builds an agent record carrying a NIC inventory under capabilities.nic.
function agent(id, nic, over = {}) {
  return { id, hostname: `host-${id}`, display_name: null, location_name: null, capabilities: { sources: ['proc'], nic }, ...over };
}

const WIFI = (fw) => ({ iface: 'wlan0', driver: 'iwlwifi', pciId: '8086:2723', firmwareVersion: fw });

// ---- computeNicInventory --------------------------------------------------

test('computeNicInventory groups identical models and counts NICs', () => {
  const inv = computeNicInventory([agent(1, [WIFI('A')]), agent(2, [WIFI('A')])]);
  assert.equal(inv.agents, 2);
  assert.equal(inv.totalNics, 2);
  assert.equal(inv.drivers.length, 1);
  assert.equal(inv.drivers[0].hasDrift, false);
  assert.equal(inv.drift.length, 0);
});

test('computeNicInventory flags the firmware outlier (the "3 of 50" case)', () => {
  const agents = [];
  for (let i = 1; i <= 47; i++) agents.push(agent(i, [WIFI('83.A')]));
  for (let i = 48; i <= 50; i++) agents.push(agent(i, [WIFI('99.B')]));
  const inv = computeNicInventory(agents);
  assert.equal(inv.drift.length, 1);
  const model = inv.drift[0];
  assert.equal(model.hasDrift, true);
  assert.equal(model.majorityFirmware, '83.A');
  // Most-common firmware first, not flagged; the minority is the outlier.
  assert.equal(model.firmwares[0].firmwareVersion, '83.A');
  assert.equal(model.firmwares[0].count, 47);
  assert.equal(model.firmwares[0].isOutlier, false);
  assert.equal(model.firmwares[1].firmwareVersion, '99.B');
  assert.equal(model.firmwares[1].count, 3);
  assert.equal(model.firmwares[1].isOutlier, true);
  // The outlier carries the actual units to inspect.
  assert.deepEqual(model.firmwares[1].agents.map((a) => a.id), [48, 49, 50]);
});

test('computeNicInventory never compares different models against each other', () => {
  const eth = { iface: 'eth0', driver: 'e1000e', pciId: '8086:15bc', firmwareVersion: '0.13' };
  const inv = computeNicInventory([agent(1, [WIFI('A'), eth]), agent(2, [WIFI('A'), eth])]);
  assert.equal(inv.drivers.length, 2); // iwlwifi + e1000e, separate groups
  assert.equal(inv.drift.length, 0);
});

test('computeNicInventory lists each agent with its NIC specs (byAgent)', () => {
  const eth = { iface: 'eth0', driver: 'e1000e', pciId: '8086:15bc', firmwareVersion: '0.13', busInfo: '0000:00:1f.6' };
  const inv = computeNicInventory([
    agent(2, [WIFI('A')], { display_name: 'Zeta', location_name: 'Bergen' }),
    agent(1, [WIFI('A'), eth], { display_name: 'Alpha' }),
  ]);
  // Sorted by name: Alpha before Zeta.
  assert.deepEqual(inv.byAgent.map((a) => a.name), ['Alpha', 'Zeta']);
  const alpha = inv.byAgent[0];
  assert.equal(alpha.id, 1);
  assert.equal(alpha.nics.length, 2);
  const eth0 = alpha.nics.find((n) => n.iface === 'eth0');
  assert.equal(eth0.firmwareVersion, '0.13');
  assert.equal(eth0.busInfo, '0000:00:1f.6');
  assert.equal(inv.byAgent[1].location, 'Bergen');
});

test('computeNicInventory ignores agents without NIC data', () => {
  const inv = computeNicInventory([agent(1, [WIFI('A')]), { id: 2, hostname: 'h2', capabilities: { sources: ['proc'] } }, { id: 3, hostname: 'h3', capabilities: null }]);
  assert.equal(inv.agents, 1);
  assert.equal(inv.totalNics, 1);
  assert.deepEqual(inv.byAgent.map((a) => a.id), [1]);
});

test('computeNicInventory uses display_name and location for outlier agents', () => {
  const inv = computeNicInventory([
    agent(1, [WIFI('A')]),
    agent(2, [WIFI('A')]),
    agent(3, [WIFI('B')], { display_name: 'Reception AP', location_name: 'Oslo' }),
  ]);
  const outlier = inv.drift[0].firmwares.find((f) => f.isOutlier);
  assert.equal(outlier.agents[0].name, 'Reception AP');
  assert.equal(outlier.agents[0].location, 'Oslo');
});

// ---- route: GET /api/fleet/nics -------------------------------------------

test('GET /api/fleet/nics returns the inventory with drift (200)', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [agent(1, [WIFI('A')]), agent(2, [WIFI('A')]), agent(3, [WIFI('B')])] });
  const res = await request(makeApp({ agentsRepo })).get('/api/fleet/nics').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agents, 3);
  assert.equal(res.body.drift.length, 1);
  assert.equal(res.body.drift[0].majorityFirmware, 'A');
});

test('GET /api/fleet/nics requires authentication (401)', async () => {
  const res = await request(makeApp()).get('/api/fleet/nics');
  assert.equal(res.status, 401);
});
