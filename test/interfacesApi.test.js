'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeResultsRepo, authHeader, throwingAsync } = require('../test-support/fakes');
const { computeInterfaceHealth } = require('../src/routes/interfaces');
const { isVirtual } = require('../src/health/interfaceHealth');

const withAgent = (overrides = {}) => makeApp({ agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1' }) }), ...overrides });

// ---- pure health derivation ----------------------------------------------

test('computeInterfaceHealth flags down / errors / utilisation', () => {
  const out = computeInterfaceHealth({
    elapsedSec: 1,
    interfaces: [
      { iface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 100, speedMbps: 1000, operStatus: 'up', rxErrors: 0, txErrors: 0, rxDrop: 0, txDrop: 0 },
      { iface: 'eth1', rxBytesPerSec: 0, txBytesPerSec: 0, operStatus: 'down' },
      { iface: 'eth2', rxBytesPerSec: 0, txBytesPerSec: 0, speedMbps: 1000, operStatus: 'up', rxErrors: 3, txErrors: 0 },
      { iface: 'eth3', rxBytesPerSec: 95e6, txBytesPerSec: 0, speedMbps: 1000, operStatus: 'up' }, // ~76% util
    ],
  });
  assert.equal(out[0].status, 'ok');
  assert.equal(out[1].status, 'down');
  assert.equal(out[2].status, 'bad'); // errors
  assert.equal(out[2].errPerSec, 3);
  assert.equal(out[3].status, 'warn'); // 760 Mbps / 1000 = 76%
  assert.equal(out[0].utilPct, round1(100 * 8 / 1e9 * 100));
});
function round1(n) { return Math.round(n * 10) / 10; }

test('isVirtual recognises container/VM/VPN ports but not real NICs or appliance bridges', () => {
  for (const n of ['lo', 'docker0', 'veth9f2a1b', 'br-1a2b3c4d5e6f', 'virbr0', 'vnet3', 'tun0', 'wg0', 'tailscale0', 'zt5a8b9c0d1e']) {
    assert.equal(isVirtual(n), true, `expected ${n} virtual`);
  }
  for (const n of ['eth0', 'eno1', 'ens18', 'enp3s0', 'wlan0', 'bond0', 'br-lan', 'br0', 'eth0.100']) {
    assert.equal(isVirtual(n), false, `expected ${n} physical`);
  }
});

test('computeInterfaceHealth does not escalate a down virtual/idle interface', () => {
  const out = computeInterfaceHealth({
    elapsedSec: 1,
    interfaces: [
      { iface: 'docker0', operStatus: 'down', rxBytesPerSec: 0, txBytesPerSec: 0 },
      { iface: 'veth9f2a1b', operStatus: 'down' },
      { iface: 'lo', operStatus: 'unknown' },
      { iface: 'eth0', operStatus: 'down' }, // a real NIC down is still DOWN
    ],
  });
  const by = Object.fromEntries(out.map((i) => [i.iface, i]));
  assert.equal(by.docker0.status, 'ok');     // idle bridge ⇒ not a fault
  assert.equal(by.docker0.virtual, true);
  assert.equal(by.docker0.linkDown, true);   // still truthfully "down"
  assert.equal(by.veth9f2a1b.status, 'ok');
  assert.equal(by.eth0.status, 'down');       // physical link-down unchanged
  assert.equal(by.eth0.virtual, false);
});

test('computeInterfaceHealth still flags errors/util on a virtual interface that is up', () => {
  const [d] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'docker0', operStatus: 'up', rxErrors: 4 }] });
  assert.equal(d.virtual, true);
  assert.equal(d.status, 'bad'); // errors are real even on a virtual port
});

// ---- route ----------------------------------------------------------------

test('GET /api/interfaces returns derived health from the latest result (200)', async () => {
  const resultsRepo = makeResultsRepo({
    findByAgentId: async () => [{
      created_at: new Date('2026-06-02T00:00:00Z'),
      payload: { traffic: { source: 'snmp', elapsedSec: 1, interfaces: [{ iface: 'Gi0/0', rxBytesPerSec: 0, txBytesPerSec: 0, speedMbps: 1000, operStatus: 'up', rxErrors: 0, txErrors: 0, rxDrop: 2, txDrop: 0 }] } },
    }],
  });
  const res = await request(withAgent({ resultsRepo })).get('/api/interfaces?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'snmp');
  assert.equal(res.body.interfaces.length, 1);
  assert.equal(res.body.interfaces[0].iface, 'Gi0/0');
  assert.equal(res.body.interfaces[0].status, 'warn'); // drops present
  assert.equal(res.body.interfaces[0].dropPerSec, 2);
});

test('GET /api/interfaces is empty (not an error) when the agent has no results', async () => {
  const res = await request(withAgent()).get('/api/interfaces?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interfaces, []);
});

test('GET /api/interfaces requires agentId (400) and a real agent (404)', async () => {
  assert.equal((await request(withAgent()).get('/api/interfaces').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(makeApp()).get('/api/interfaces?agentId=9').set('Authorization', authHeader('viewer'))).status, 404);
});

test('GET /api/interfaces requires auth (401)', async () => {
  assert.equal((await request(withAgent()).get('/api/interfaces?agentId=9')).status, 401);
});

test('GET /api/interfaces surfaces a repo failure as 500', async () => {
  const resultsRepo = makeResultsRepo({ findByAgentId: throwingAsync('db down') });
  const res = await request(withAgent({ resultsRepo })).get('/api/interfaces?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});
