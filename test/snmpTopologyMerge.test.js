'use strict';

// The switches, on the map the Troubleshooting screen draws.
//
// The graph was built from agents and their LLDP only, so a site with twelve
// switches drew two agents and a dotted line. What has to hold now:
//
//   * a switch is drawn whether or not it reports a neighbour — one that
//     answers SNMP and reports no LLDP is still part of the network;
//   * an adjacency is resolved by MAC first and by an EXACT name second, and
//     never by anything looser: a link that is drawn is a claim about the
//     network, and an invented one on an outage screen is worse than a missing
//     one because somebody acts on it;
//   * a device an admin disabled is not a fault, so it is not on the map.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeSnmpTopology, normaliseMac, nameKey, deviceState,
} = require('../src/topology/snmpTopologyMerge');

const VIEW = (over = {}) => ({
  nodes: [{ id: 9, label: 'be-aarhus-01', state: 'ok' }],
  links: [],
  counts: { ok: 1, down: 0, unreachable_downstream: 0 },
  layers: { l2: 0, l3: 0 },
  ...over,
});
const DEV = (over = {}) => ({
  id: 1, host: '10.14.0.11', displayName: 'sw-core-1', locationId: 3,
  enabled: true, lastOkAt: '2026-09-21T10:00:00.000Z', lastError: null, ...over,
});

// ================================================================== the MACs
test('a MAC is the same MAC however the device spells it', () => {
  // Devices render them every way there is, and two spellings of one address
  // must resolve to one node.
  const want = '001b44113ab7';
  for (const form of ['00:1b:44:11:3a:b7', '001b.4411.3ab7', '00-1B-44-11-3A-B7', '0x001B44113AB7', '001b44113ab7']) {
    assert.equal(normaliseMac(form), want, form);
  }
  // Anything that is not twelve hex characters is not a MAC, and guessing at
  // one would resolve a link to a node chosen by accident.
  for (const junk of [null, undefined, '', 'sw-core-1', '00:1b:44', 12345, {}]) {
    assert.equal(normaliseMac(junk), null, String(junk));
  }
});

test('a name matches exactly or not at all', () => {
  assert.equal(nameKey('  SW-Core-1 '), 'sw-core-1');
  assert.equal(nameKey('   '), null);
  assert.equal(nameKey(null), null);
});

// ================================================================ the states
test('a disabled device is not a fault and is not on the map', () => {
  // An admin turned it off. Colouring it red puts a fault on the screen that
  // nobody can fix.
  assert.equal(deviceState(DEV({ enabled: false })), null);
  const merged = mergeSnmpTopology({ view: VIEW(), devices: [DEV({ enabled: false })] });
  assert.deepEqual(merged.nodes.map((n) => n.id), [9]);
});

test('never polled is UNKNOWN, not down', () => {
  // Nothing has been established about it yet — the poller may not have
  // reached its first cycle. "Down" would be a claim we cannot support.
  assert.equal(deviceState(DEV({ lastOkAt: null, lastError: null })), 'unknown');
  assert.equal(deviceState(DEV({ lastError: 'timeout' })), 'down');
  assert.equal(deviceState(DEV()), 'ok');
});

// ================================================================= the nodes
test('a switch with no neighbours is still drawn', () => {
  // It answers SNMP and it is part of the network. Leaving it out would hide
  // exactly the devices most likely to be misconfigured.
  const merged = mergeSnmpTopology({ view: VIEW(), devices: [DEV()], neighbours: [] });
  assert.deepEqual(merged.nodes.map((n) => n.id), [9, 'd:1']);
  const dev = merged.nodes.find((n) => n.id === 'd:1');
  assert.equal(dev.label, 'sw-core-1');
  assert.equal(dev.kind, 'device');
  assert.equal(dev.locationId, 3);
  assert.equal(merged.links.length, 0);
});

test('a device id never collides with an agent id', () => {
  // Migration 104's whole argument: a polled switch is not an agent. One
  // shared numeric space collides the day agent 9 and device 9 both exist,
  // which is today.
  const merged = mergeSnmpTopology({ view: VIEW(), devices: [DEV({ id: 9 })] });
  assert.deepEqual(merged.nodes.map((n) => n.id), [9, 'd:9']);
});

// ================================================================= the links
test('switch to switch resolves by MAC', () => {
  const merged = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1, displayName: 'sw-core-1' }), DEV({ id: 2, displayName: 'sw-access-1' })],
    deviceMacs: [{ deviceId: 2, physAddress: '00:1b:44:11:3a:b7' }],
    neighbours: [{ deviceId: 1, localIfName: 'Gi0/1', remoteChassisId: '001b.4411.3ab7', remotePortId: 'Gi0/24' }],
  });
  assert.equal(merged.links.length, 1);
  const [link] = merged.links;
  assert.equal(link.source, 'd:1');
  assert.equal(link.target, 'd:2');
  assert.equal(link.layer, 'l2');
  // Which port, so the map can say where to put a technician's hands.
  assert.equal(link.localIfName, 'Gi0/1');
  assert.equal(link.remotePortId, 'Gi0/24');
});

test('switch to AGENT resolves too, so the two clouds are one map', () => {
  const merged = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1 })],
    agentChassis: [{ chassisId: '00:1b:44:11:3a:b7', agentId: 9 }],
    neighbours: [{ deviceId: 1, remoteChassisId: '001b44113ab7' }],
  });
  assert.equal(merged.links.length, 1);
  assert.equal(merged.links[0].target, 9);
});

test('both ends reporting the same adjacency is ONE link', () => {
  const merged = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1 }), DEV({ id: 2 })],
    deviceMacs: [
      { deviceId: 1, physAddress: 'aa:aa:aa:aa:aa:aa' },
      { deviceId: 2, physAddress: 'bb:bb:bb:bb:bb:bb' },
    ],
    neighbours: [
      { deviceId: 1, remoteChassisId: 'bb:bb:bb:bb:bb:bb' },
      { deviceId: 2, remoteChassisId: 'aa:aa:aa:aa:aa:aa' },
    ],
  });
  assert.equal(merged.links.length, 1);
});

test('an unmonitored neighbour draws nothing', () => {
  // A switch sees printers, phones and the neighbour's neighbour. Drawing a
  // node for everything it can see turns the map into the thing it exists to
  // cut through.
  const merged = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1 })],
    neighbours: [{ deviceId: 1, remoteChassisId: 'cc:cc:cc:cc:cc:cc', remoteSysName: 'some-printer' }],
  });
  assert.deepEqual(merged.nodes.map((n) => n.id), [9, 'd:1']);
  assert.equal(merged.links.length, 0);
});

test('a name resolves only when it is exact AND unambiguous', () => {
  // "sw-lager-1" must not match "sw-lager-10", and a name two devices share
  // resolves to neither — otherwise the link goes to whichever row was read
  // first, which is a link chosen by row order.
  const near = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1, displayName: 'sw-lager-1' }), DEV({ id: 2, displayName: 'sw-lager-10' })],
    neighbours: [{ deviceId: 1, remoteChassisId: 'locally-assigned', remoteSysName: 'sw-lager-1' }],
  });
  // Resolves to ITSELF, which is not a link.
  assert.equal(near.links.length, 0);

  const exact = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1, displayName: 'sw-lager-1' }), DEV({ id: 2, displayName: 'sw-lager-10' })],
    neighbours: [{ deviceId: 1, remoteSysName: 'SW-Lager-10' }],
  });
  assert.deepEqual(exact.links.map((l) => l.target), ['d:2'], 'case-insensitive, whole string');

  const ambiguous = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1, displayName: 'core' }), DEV({ id: 2, displayName: 'core' }), DEV({ id: 3 })],
    neighbours: [{ deviceId: 3, remoteSysName: 'core' }],
  });
  assert.equal(ambiguous.links.length, 0, 'a shared name resolves to neither');
});

// ================================================================ the counts
test('a failing switch is counted and colours its link', () => {
  const merged = mergeSnmpTopology({
    view: VIEW(),
    devices: [DEV({ id: 1 }), DEV({ id: 2, lastError: 'timeout' })],
    deviceMacs: [{ deviceId: 2, physAddress: 'bb:bb:bb:bb:bb:bb' }],
    neighbours: [{ deviceId: 1, remoteChassisId: 'bb:bb:bb:bb:bb:bb' }],
  });
  assert.equal(merged.counts.down, 1);
  assert.equal(merged.counts.ok, 2, 'the agent and the healthy switch');
  assert.equal(merged.links[0].state, 'down', 'the link takes the worse end');
  assert.equal(merged.layers.l2, 1);
});

test('nothing to merge leaves the view as it was, counts and all', () => {
  // A fleet with no switches must not get a different SHAPE just because this
  // ran — the caller's own tests pin those counts.
  const view = VIEW();
  const before = JSON.parse(JSON.stringify(view));
  const merged = mergeSnmpTopology({ view, devices: [], neighbours: [] });
  assert.deepEqual(merged, before);
  assert.deepEqual(view, before, 'and what it was handed is never mutated');
});

test('merging never mutates the view it was given', () => {
  const view = VIEW();
  const before = JSON.parse(JSON.stringify(view));
  const merged = mergeSnmpTopology({ view, devices: [DEV()] });
  assert.deepEqual(view, before);
  assert.equal(merged.nodes.length, 2);
});

test('unknown is counted only when something IS unknown', () => {
  // A state no agent can be in. A legend entry that always says 0 is a legend
  // entry nobody reads.
  const known = mergeSnmpTopology({ view: VIEW(), devices: [DEV()] });
  assert.equal(known.counts.unknown, undefined);
  assert.deepEqual(Object.keys(known.counts).sort(), ['down', 'ok', 'unreachable_downstream']);

  const unknown = mergeSnmpTopology({ view: VIEW(), devices: [DEV({ lastOkAt: null })] });
  assert.equal(unknown.counts.unknown, 1);
});

test('garbage in is an unchanged view, not a throw', () => {
  // This runs inside a read that paints an outage screen. A malformed row must
  // cost that row, never the page.
  for (const bad of [undefined, null, {}, { devices: 'no' }, { neighbours: [null, 7] }]) {
    assert.doesNotThrow(() => mergeSnmpTopology(bad), JSON.stringify(bad));
  }
});
