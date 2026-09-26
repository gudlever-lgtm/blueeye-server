'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  linksWithBothMtus, detectLinkMtuMismatch, buildLinkMtuFinding, MTU_TOLERANCE,
} = require('../src/devices/linkMtuMismatch');
const { createLinkMtuService } = require('../src/devices/linkMtuService');

// Two switches, cabled core Gi0/1 <-> access Gi0/24, as LLDP reports it: each
// switch names its OWN port and identifies the far end by chassis MAC.
const CORE = { id: 1, displayName: 'core-1', host: '10.0.0.1', agentId: 7, enabled: true };
const ACCESS = { id: 2, displayName: 'access-3', host: '10.0.0.2', agentId: 7, enabled: true };

const MACS = [
  { deviceId: 1, physAddress: 'aa:bb:cc:00:00:01' },
  { deviceId: 2, physAddress: 'aa:bb:cc:00:00:02' },
];

const NEIGHBOURS = [
  {
    deviceId: 1, localIfName: 'Gi0/1', protocol: 'lldp',
    remoteChassisId: 'aa:bb:cc:00:00:02', remotePortId: 'Gi0/24', remoteSysName: 'access-3',
  },
  {
    deviceId: 2, localIfName: 'Gi0/24', protocol: 'lldp',
    remoteChassisId: 'aa:bb:cc:00:00:01', remotePortId: 'Gi0/1', remoteSysName: 'core-1',
  },
];

const iface = (id, deviceId, ifName, mtu, extra = {}) => ({
  id, deviceId, ifName, mtu, ifAlias: null, physAddress: null, ...extra,
});

const facts = (interfaces) => ({
  devices: [CORE, ACCESS], neighbours: NEIGHBOURS, deviceMacs: MACS, interfaces,
});

test('a link with two different MTUs is one finding, not two', () => {
  // Both switches report the same cable, once from each end. Raising it twice
  // would put the same fault on two screens with two ids and refract them
  // separately — which is how one misconfigured port becomes a week of noise.
  const links = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 9216),
    iface(22, 2, 'Gi0/24', 1500),
  ]));
  assert.equal(links.length, 1);
  const verdict = detectLinkMtuMismatch(links[0]);
  assert.ok(verdict, 'the mismatch was not detected');
  assert.equal(verdict.gap, 9216 - 1500);
  // The SMALLER end is what the link can carry, so it is what the finding
  // observes and the port it is attributed to.
  assert.equal(links[0].low.mtu, 1500);
  assert.equal(links[0].low.ifName, 'Gi0/24');
  assert.equal(links[0].high.mtu, 9216);
});

test('a matching link is not a finding', () => {
  const links = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 1500),
    iface(22, 2, 'Gi0/24', 1500),
  ]));
  assert.equal(links.length, 1);
  assert.equal(detectLinkMtuMismatch(links[0]), null);
});

test('a header-sized difference is a units disagreement, not a misconfiguration', () => {
  // Vendors disagree about whether ifMtu counts the ethernet header, the FCS
  // and the 802.1Q tag. Two ends of a correctly configured link routinely read
  // a few bytes apart, and calling that a fault would fire on every mixed-
  // vendor link in the estate.
  const links = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 1500 + MTU_TOLERANCE),
    iface(22, 2, 'Gi0/24', 1500),
  ]));
  assert.equal(detectLinkMtuMismatch(links[0]), null);
  const wider = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 1500 + MTU_TOLERANCE + 1),
    iface(22, 2, 'Gi0/24', 1500),
  ]));
  assert.ok(detectLinkMtuMismatch(wider[0]), 'one byte past the tolerance is a real difference');
});

test('an end whose MTU nobody knows is NO evidence, not half a fault', () => {
  // Null means the device does not implement ifMtu or did not answer. Reading
  // it as 1500 would invent this fault on every silent platform.
  const links = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 9216),
    iface(22, 2, 'Gi0/24', null),
  ]));
  assert.equal(links.length, 0);
});

test('a neighbour that is not a polled switch has no second MTU to compare', () => {
  // An access point, a phone or a host running lldpd. The far end is not in
  // snmp_devices, so there is no row and nothing to compare — and an
  // unmanaged far end must never be assumed to be 1500.
  const links = linksWithBothMtus({
    devices: [CORE],
    neighbours: [{
      deviceId: 1, localIfName: 'Gi0/5', protocol: 'lldp',
      remoteChassisId: '00:11:22:33:44:55', remotePortId: 'eth0', remoteSysName: 'ap-lobby',
    }],
    deviceMacs: [MACS[0]],
    interfaces: [iface(11, 1, 'Gi0/5', 1500)],
  });
  assert.equal(links.length, 0);
});

test('two ports on ONE switch are never compared with each other', () => {
  // A loopback, a tunnel and a management port legitimately carry different
  // MTUs from a data port. Only LINKED ports are compared.
  const links = linksWithBothMtus({
    devices: [CORE], neighbours: [], deviceMacs: [MACS[0]],
    interfaces: [iface(11, 1, 'Gi0/1', 9216), iface(12, 1, 'Loopback0', 1514)],
  });
  assert.equal(links.length, 0);
});

test('the finding names both ports, both numbers and what to change', () => {
  const links = linksWithBothMtus(facts([
    iface(11, 1, 'Gi0/1', 9216),
    iface(22, 2, 'Gi0/24', 1500),
  ]));
  const f = buildLinkMtuFinding(links[0], detectLinkMtuMismatch(links[0]), {
    hostId: '7', interfaceId: 22, at: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(f.severity, 'WARN');
  assert.equal(f.observed, 1500, 'the link carries what its smaller end carries');
  assert.equal(f.baseline, 9216);
  assert.equal(f.deviation, 7716);
  assert.equal(f.deviceId, 2, 'attributed to the end that decides the limit');
  assert.equal(f.interfaceId, 22);
  for (const must of ['Gi0/1', 'Gi0/24', 'core-1', 'access-3', '9216', '1500']) {
    assert.ok(f.explanation.includes(must), `the explanation never mentions ${must}`);
  }
  assert.ok(/ping answers/.test(f.explanation), 'it does not say why every other test passes');
  assert.equal(f.evidence[0].labels.gapBytes, 7716);
});

// ---------------------------------------------------------------- the service

function repos(interfaces) {
  return {
    snmpDevicesRepo: { list: async () => [CORE, ACCESS] },
    snmpNeighborsRepo: { listAll: async () => NEIGHBOURS },
    deviceInterfacesRepo: {
      listAll: async () => interfaces,
      listMacs: async () => MACS,
    },
  };
}

test('the service raises the finding once and then refracts it', async () => {
  const emitted = [];
  const svc = createLinkMtuService({
    ...repos([iface(11, 1, 'Gi0/1', 9216), iface(22, 2, 'Gi0/24', 1500)]),
    findingSink: { emit: async (f) => { emitted.push(f); return f; } },
    minIntervalMs: 0,
  });
  assert.equal(await svc.check({ agentId: '7' }), 1);
  // A mismatch is a configuration: it cannot change on its own, so raising it
  // on every topology cycle would be sixty copies a day of one fault.
  assert.equal(await svc.check({ agentId: '7' }), 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].hostId, '7');
});

test('the fleet-wide read is throttled however many cycles land', async () => {
  let reads = 0;
  const base = repos([iface(11, 1, 'Gi0/1', 1500), iface(22, 2, 'Gi0/24', 1500)]);
  const svc = createLinkMtuService({
    ...base,
    snmpNeighborsRepo: { listAll: async () => { reads += 1; return NEIGHBOURS; } },
    findingSink: { emit: async (f) => f },
    minIntervalMs: 60000,
  });
  await svc.check({});
  await svc.check({});
  await svc.check({});
  assert.equal(reads, 1, 'the check re-read the whole estate on every cycle');
  await svc.check({ force: true });
  assert.equal(reads, 2, 'force must still be able to ask now');
});

test('with no finding sink the check is a no-op rather than a crash', async () => {
  const svc = createLinkMtuService(repos([iface(11, 1, 'Gi0/1', 9216), iface(22, 2, 'Gi0/24', 1500)]));
  assert.equal(await svc.check({}), 0);
});

test('a read that throws costs the check, never the poll that called it', async () => {
  const warned = [];
  const svc = createLinkMtuService({
    ...repos([]),
    snmpNeighborsRepo: { listAll: async () => { throw new Error('gone'); } },
    findingSink: { emit: async (f) => f },
    minIntervalMs: 0,
    logger: { info() {}, warn: (m) => warned.push(m), error() {}, debug() {} },
  });
  assert.equal(await svc.check({}), 0);
  assert.ok(warned.some((m) => /gone/.test(m)));
});
