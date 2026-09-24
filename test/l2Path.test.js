'use strict';

// src/topology/l2Path.js — the pure half of the L2 path: the switch graph, the
// access-port choice and the hop list, over a small realistic network
// (test-support/l2TopologyFixture.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSwitchGraph, pickAccessPort, shortestPath, computeSegment, portKey, remotePortName,
} = require('../src/topology/l2Path');
const F = require('../test-support/l2TopologyFixture');

const graph = () => buildSwitchGraph({ devices: F.clone(F.devices), neighbours: F.clone(F.neighbours), deviceMacs: F.clone(F.deviceMacs) });
const rowsFor = (mac, fdb = F.fdb) => F.clone(fdb.filter((r) => r.mac === mac));
const endpoint = (label, mac, g, fdb) => {
  const rows = rowsFor(mac, fdb);
  const pick = pickAccessPort(rows, g);
  return { label, rows, location: pick.port };
};

// ============================================================ the graph
test('the switch graph resolves neighbours by port MAC and by exact name, CDP rows included', () => {
  const g = graph();
  assert.equal(g.devices.size, 4);
  assert.equal(g.links, 2, 'core-a and core-b; sw-b and sw-c are NOT linked');
  // sw-core <-> sw-a: LLDP from one end (by MAC), CDP from the other (by name).
  const coreA = g.adj.get(1).get(2);
  assert.equal(coreA.localPort, 'Gi0/1');
  assert.equal(coreA.remotePort, 'Gi0/48', "the far end's OWN report of its port wins");
  assert.deepEqual(coreA.protocols.sort(), ['cdp', 'lldp']);
  // sw-core <-> sw-b is reported only by the core; the far port is its claim.
  assert.equal(g.adj.get(3).get(1).localPort, 'Gi0/48');
  for (const [d, p] of [[1, 'Gi0/1'], [1, 'Gi0/2'], [2, 'Gi0/48'], [3, 'Gi0/48']]) {
    assert.ok(g.uplinks.has(portKey(d, p)), `${d} ${p} is an uplink`);
  }
  assert.ok(!g.uplinks.has(portKey(3, 'Gi0/10')), 'a port to an UNMANAGED neighbour is not an uplink');
  assert.deepEqual(g.foreign.get(portKey(3, 'Gi0/10')).map((n) => n.sysName), ['desk-switch']);
});

test('a name two switches share resolves to neither, and a disabled switch is left out', () => {
  const devices = [...F.clone(F.devices), { id: 5, host: '10.0.0.5', displayName: 'sw-core', enabled: true }];
  const g = buildSwitchGraph({ devices, neighbours: F.clone(F.neighbours), deviceMacs: F.clone(F.deviceMacs) });
  assert.ok(!g.adj.get(2) || !g.adj.get(2).has(5), 'never guessed onto the second sw-core');
  // sw-core <-> sw-a still stands on the MAC the core reported.
  assert.ok(g.adj.get(1).has(2));

  const off = buildSwitchGraph({
    devices: F.clone(F.devices).map((d) => (d.id === 3 ? { ...d, enabled: false } : d)),
    neighbours: F.clone(F.neighbours), deviceMacs: F.clone(F.deviceMacs),
  });
  assert.ok(!off.devices.has(3));
  assert.equal(off.links, 1);
});

test('remotePortName prefers a faceplate name over a MAC or a bare number', () => {
  assert.equal(remotePortName({ remotePortId: 'Gi0/48' }), 'Gi0/48');
  assert.equal(remotePortName({ remotePortId: '00:11:22:33:44:55', remotePortDesc: 'eth0' }), 'eth0');
  assert.equal(remotePortName({ remotePortId: '17', remotePortDesc: 'Port 17' }), 'Port 17');
  assert.equal(remotePortName({ remotePortId: '17' }), '17');
});

// ============================================================ the access port
test('the access port is the non-uplink port with the fewest MACs', () => {
  const g = graph();
  const pick = pickAccessPort(rowsFor(F.MAC.pcA), g);
  assert.equal(pick.port.deviceId, 2);
  assert.equal(pick.port.ifName, 'Gi0/5');
  assert.equal(pick.port.vlan, 10);
  assert.equal(pick.port.sharedPort, false);
});

test('a MAC behind an unmanaged switch lands on the managed port it hangs off — with the MAC count as evidence', () => {
  const g = graph();
  // Drop pc-c's own access row: the only non-uplink port left is sw-b Gi0/10.
  const rows = rowsFor(F.MAC.pcC).filter((r) => !(r.deviceId === 4));
  const pick = pickAccessPort(rows, g);
  assert.equal(pick.port.ifName, 'Gi0/10');
  assert.equal(pick.port.sharedPort, true, '12 MACs on the port');
  assert.deepEqual(pick.port.neighbours.map((n) => n.sysName), ['desk-switch']);
});

test('a MAC seen only on uplinks has no access port, and says so', () => {
  const g = graph();
  const rows = rowsFor(F.MAC.pcB).filter((r) => r.ifName !== 'Gi0/7');
  const pick = pickAccessPort(rows, g);
  assert.equal(pick.port, null);
  assert.equal(pick.uplinkOnly, true);
});

test("a switch's own MAC makes the endpoint that switch", () => {
  const pick = pickAccessPort(rowsFor(F.MAC.router), graph());
  assert.equal(pick.self, 1);
  assert.equal(pick.port, null);
});

test('ties on MAC count go to the freshest sighting', () => {
  const g = graph();
  const rows = [
    { deviceId: 2, mac: 'aa:aa:aa:aa:aa:aa', vlan: 5, ifName: 'Gi0/9', portMacCount: 1, lastSeen: F.T(30) },
    { deviceId: 3, mac: 'aa:aa:aa:aa:aa:aa', vlan: 5, ifName: 'Gi0/9', portMacCount: 1, lastSeen: F.T(1) },
  ];
  assert.equal(pickAccessPort(rows, g).port.deviceId, 3);
});

// ============================================================ the path
test('BFS finds the shortest switch path', () => {
  const g = graph();
  assert.deepEqual(shortestPath(g, 2, 3), [2, 1, 3]);
  assert.deepEqual(shortestPath(g, 2, 2), [2]);
  assert.equal(shortestPath(g, 2, 4), null, 'no managed link reaches sw-c');
  assert.equal(shortestPath(g, 2, 99), null);
});

test('pc-a -> pc-b: three hops with the right ingress/egress ports and VLAN sightings', () => {
  const g = graph();
  const a = endpoint('pc-a', F.MAC.pcA, g);
  const b = endpoint('pc-b', F.MAC.pcB, g);
  const seg = computeSegment(g, a, b);
  assert.equal(seg.complete, true);
  assert.deepEqual(seg.uncertainties, []);
  assert.deepEqual(seg.hops.map((h) => [h.name, h.ingress.ifName, h.egress.ifName]), [
    ['sw-a', 'Gi0/5', 'Gi0/48'],
    ['sw-core', 'Gi0/1', 'Gi0/2'],
    ['sw-b', 'Gi0/48', 'Gi0/7'],
  ]);
  assert.equal(seg.hops[0].ingress.role, 'access');
  assert.equal(seg.hops[1].ingress.role, 'uplink');
  assert.equal(seg.hops[2].egress.role, 'access');
  assert.deepEqual(seg.hops[1].linkProtocols.sort(), ['cdp', 'lldp']);
  // Both MACs are sighted on the core, each on the port toward its own side.
  const core = seg.hops[1].sightings;
  assert.deepEqual(core.map((s) => [s.endpoint, s.ifName, s.vlan]).sort(), [['from', 'Gi0/1', 10], ['to', 'Gi0/2', 10]]);
});

test('a forwarding entry on a third port is flagged, not ignored', () => {
  const g = graph();
  const fdb = F.clone(F.fdb).map((r) => (r.deviceId === 1 && r.mac === F.MAC.pcB ? { ...r, ifName: 'Gi0/9' } : r));
  const seg = computeSegment(g, endpoint('pc-a', F.MAC.pcA, g, fdb), endpoint('pc-b', F.MAC.pcB, g, fdb));
  assert.equal(seg.complete, true);
  const u = seg.uncertainties.find((x) => x.code === 'fdbDisagrees');
  assert.ok(u, 'fdbDisagrees raised');
  assert.equal(u.evidence.expected, 'Gi0/2');
  assert.equal(u.evidence.seenOn, 'Gi0/9');
});

test('pc-a -> pc-c: two known halves and a NAMED gap where LLDP is missing', () => {
  const g = graph();
  const seg = computeSegment(g, endpoint('pc-a', F.MAC.pcA, g), endpoint('pc-c', F.MAC.pcC, g));
  assert.equal(seg.complete, false);
  const shape = seg.hops.map((h) => (h.type === 'gap' ? `gap(${h.from.name} ${h.from.ifName} -> ${h.to.name} ${h.to.ifName})` : h.name));
  assert.deepEqual(shape, ['sw-a', 'sw-core', 'sw-b', 'gap(sw-b Gi0/10 -> sw-c Gi0/47)', 'sw-c']);
  const gap = seg.hops[3];
  assert.equal(gap.reason, 'missingLink');
  assert.deepEqual(gap.neighbours.map((n) => n.sysName), ['desk-switch']);
  assert.equal(seg.hops[2].egress.role, 'gap');
  assert.equal(seg.hops[4].ingress.role, 'gap');
  assert.equal(seg.hops[4].egress.ifName, 'Gi0/3');
  const u = seg.uncertainties.find((x) => x.code === 'missingLink');
  assert.ok(u);
  assert.match(u.message, /unmanaged switch or missing LLDP between them/);
  assert.match(u.message, /desk-switch/);
  assert.equal(u.evidence.fromPort, 'Gi0/10');
  assert.equal(u.evidence.toPort, 'Gi0/47');
});

test('no border on either side: the gap is still named, as "not connected by any link the switches report"', () => {
  const g = graph();
  // Nothing on sw-c's side has pc-a's MAC, and nothing on pc-a's side has pc-c's.
  const fdb = F.clone(F.fdb).filter((r) => !(r.deviceId === 4 && r.mac === F.MAC.pcA) && !(r.mac === F.MAC.pcC && r.deviceId !== 4));
  const seg = computeSegment(g, endpoint('pc-a', F.MAC.pcA, g, fdb), endpoint('pc-c', F.MAC.pcC, g, fdb));
  assert.equal(seg.complete, false);
  assert.ok(seg.uncertainties.some((u) => u.code === 'noAdjacency'));
  const gap = seg.hops.find((h) => h.type === 'gap');
  assert.equal(gap.from.name, 'sw-a');
  assert.equal(gap.to.name, 'sw-c');
});

test('both ends on one switch is one hop; an unlocated end is no path at all', () => {
  const g = graph();
  const fdb = [...F.clone(F.fdb), { deviceId: 2, mac: 'aa:00:00:00:00:99', vlan: 10, ifName: 'Gi0/6', portMacCount: 1, lastSeen: F.T(1) }];
  const seg = computeSegment(g, endpoint('pc-a', F.MAC.pcA, g, fdb), endpoint('pc-x', 'aa:00:00:00:00:99', g, fdb));
  assert.deepEqual(seg.hops.map((h) => [h.name, h.ingress.ifName, h.egress.ifName]), [['sw-a', 'Gi0/5', 'Gi0/6']]);
  const none = computeSegment(g, endpoint('pc-a', F.MAC.pcA, g), { label: 'x', rows: [], location: null });
  assert.deepEqual(none.hops, []);
  assert.equal(none.complete, false);
});
