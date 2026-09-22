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

test('computeInterfaceHealth reads raw Windows Get-NetAdapter Status (agents < 0.37.3)', () => {
  const out = computeInterfaceHealth({
    elapsedSec: 1,
    interfaces: [
      { iface: 'Ethernet', operStatus: 'Up', speedMbps: 1000 },
      { iface: 'Wi-Fi', operStatus: 'Disconnected' },
      { iface: 'Ethernet 2', operStatus: 'Disabled' },
      { iface: 'Ethernet 3', operStatus: 'Not Present' },
      { iface: 'vEthernet (Default Switch)', operStatus: 'Disconnected' },
    ],
  });
  const by = Object.fromEntries(out.map((i) => [i.iface, i]));
  assert.equal(by.Ethernet.status, 'ok');
  assert.equal(by.Ethernet.operStatus, 'up');
  assert.equal(by.Ethernet.linkDown, false);
  assert.equal(by['Wi-Fi'].status, 'down');
  assert.equal(by['Wi-Fi'].operStatus, 'down');
  assert.equal(by['Ethernet 2'].status, 'down');
  assert.equal(by['Ethernet 3'].status, 'down');
  assert.equal(by['vEthernet (Default Switch)'].virtual, true); // Hyper-V switch port
  assert.equal(by['vEthernet (Default Switch)'].status, 'ok');
});

test('isVirtual treats Hyper-V vEthernet ports as virtual, plain Windows NICs as physical', () => {
  assert.equal(isVirtual('vEthernet (Default Switch)'), true);
  assert.equal(isVirtual('vEthernet (WSL)'), true);
  for (const n of ['Ethernet', 'Ethernet 2', 'Wi-Fi']) assert.equal(isVirtual(n), false, `expected ${n} physical`);
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

// --- late collisions (EtherLike-MIB, SNMP only) -----------------------------
// The counter that NAMES a duplex mismatch rather than merely being consistent
// with one. Its absence is the interesting case: zero late collisions is what
// rules the fault out, so a source that cannot count them must not be read as
// having counted none.

test('late collisions become a per-second rate, and absence stays absent', () => {
  const { computeInterfaceHealth } = require('../src/health/interfaceHealth');
  const [counted, none, cannot, proc] = computeInterfaceHealth({
    elapsedSec: 10,
    interfaces: [
      { iface: 'eth0', lateCollisions: 30 },
      { iface: 'eth1', lateCollisions: 0 },
      { iface: 'eth2', lateCollisions: null },
      { iface: 'eth3' },
    ],
  });
  assert.equal(counted.lateCollPerSec, 3);
  assert.equal(none.lateCollPerSec, 0, 'a device that counted none reports zero');
  assert.equal(cannot.lateCollPerSec, null, 'a device that cannot count them reports nothing');
  assert.equal(proc.lateCollPerSec, null, 'a /proc sample never has this counter');
});

test('a junk late-collision value is treated as absent, not as zero', () => {
  const { computeInterfaceHealth } = require('../src/health/interfaceHealth');
  // `[]` is the one that matters: Number([]) is 0, and 0 is precisely the value
  // that rules this fault out. A coercion that turns junk into the most
  // consequential answer available is worse than no reading at all.
  for (const bad of ['lots', '7', {}, [], NaN, Infinity, -1, undefined, true]) {
    const [i] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', lateCollisions: bad }] });
    assert.equal(i.lateCollPerSec, null, JSON.stringify(bad));
  }
});

test('late collisions do not change an interface status on their own', () => {
  // The status vocabulary (down/bad/warn/ok) feeds fleet health, and a duplex
  // mismatch is a diagnosis rather than a severity. Whatever this counter says,
  // the row's status is still decided by errors, discards and utilisation.
  const { computeInterfaceHealth } = require('../src/health/interfaceHealth');
  const [withLate] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', lateCollisions: 99, operStatus: 'up' }] });
  const [without] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up' }] });
  assert.equal(withLate.status, without.status);
  assert.equal(withLate.status, 'ok');
});
