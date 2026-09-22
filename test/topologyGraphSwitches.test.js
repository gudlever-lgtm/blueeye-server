'use strict';

// The polled switches ON the topology graph, and blast radius walking them.
//
// `snmp_devices` and `snmp_neighbors` (migrations 104 and 106) were never read
// by `buildTopologyGraph`, so a site with twelve switches produced a graph of
// two agents — and blast radius, which is built on that graph, could not
// answer "what does this switch cut off" because the switch was not in it.
// Migration 106 left the merge as its own decision. What has to hold now:
//
//   * a switch is a node whether or not it reports a neighbour;
//   * an adjacency is RESOLVED — by MAC, or by an exact unambiguous name —
//     and never guessed. Blast radius turns an edge into "these hosts lose
//     connectivity", so an invented edge is a wrong answer somebody acts on;
//   * a failing switch isolates what is behind it, exactly like an agent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTopologyGraph } = require('../src/topology/graph');
const { computeBlastRadius } = require('../src/topology/blastRadius');

const DEV = (over = {}) => ({ id: 1, host: '10.0.0.1', displayName: 'sw-core', enabled: true, ...over });
const AGENT = (over = {}) => ({ id: 9, hostname: 'be-aarhus-01', ...over });

// ===================================================================== nodes
test('a switch with no neighbours is still a node', () => {
  // It answers SNMP and it is part of the network. Leaving it out hides
  // exactly the devices most likely to be misconfigured.
  const g = buildTopologyGraph({ agents: [AGENT()], devices: [DEV()] });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['d:1']);
  assert.equal(g.nodes[0].kind, 'device');
  assert.equal(g.nodes[0].label, 'sw-core');
});

test('a disabled switch is not on the graph', () => {
  const g = buildTopologyGraph({ devices: [DEV({ enabled: false })] });
  assert.deepEqual(g.nodes, []);
});

test('agent 5 and device 5 are two different nodes', () => {
  const g = buildTopologyGraph({
    agents: [AGENT({ id: 5 })],
    devices: [DEV({ id: 5 })],
    l2: [{ localAgentId: 5, localChassisId: 'aa:aa:aa:aa:aa:aa' }],
    deviceNeighbours: [{ deviceId: 5, remoteChassisId: 'aa:aa:aa:aa:aa:aa' }],
  });
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes(5), 'the agent');
  assert.ok(ids.includes('d:5'), 'the switch');
});

// ===================================================================== edges
test('switch to switch is resolved by MAC', () => {
  const g = buildTopologyGraph({
    devices: [DEV({ id: 1 }), DEV({ id: 2, displayName: 'sw-access' })],
    deviceMacs: [{ deviceId: 2, physAddress: '00:1b:44:11:3a:b7' }],
    deviceNeighbours: [{ deviceId: 1, localIfName: 'Gi0/1', remoteChassisId: '001b.4411.3ab7', remotePortId: 'Gi0/24' }],
  });
  const l2 = g.edges.filter((e) => e.type === 'l2_link');
  assert.equal(l2.length, 1);
  assert.equal(l2[0].source, 'd:1');
  assert.equal(l2[0].target, 'd:2');
  // Which port, so a map can say where to put a technician's hands.
  assert.equal(l2[0].localIfName, 'Gi0/1');
  assert.equal(l2[0].remotePortId, 'Gi0/24');
});

test('switch to AGENT joins the two clouds into one map', () => {
  const g = buildTopologyGraph({
    agents: [AGENT({ id: 9 })],
    devices: [DEV({ id: 1 })],
    l2: [{ localAgentId: 9, localChassisId: '00:1b:44:11:3a:b7' }],
    deviceNeighbours: [{ deviceId: 1, remoteChassisId: '001b44113ab7' }],
  });
  const l2 = g.edges.filter((e) => e.type === 'l2_link');
  assert.equal(l2.length, 1);
  assert.deepEqual([l2[0].source, l2[0].target], ['d:1', 9]);
});

test('an unmonitored neighbour is not an edge and not a node', () => {
  // A switch sees printers, phones and the neighbour's neighbour. Drawing
  // everything it can see turns the map into the thing it exists to cut
  // through.
  const g = buildTopologyGraph({
    devices: [DEV({ id: 1 })],
    deviceNeighbours: [{ deviceId: 1, remoteChassisId: 'cc:cc:cc:cc:cc:cc', remoteSysName: 'some-printer' }],
  });
  assert.deepEqual(g.nodes.map((n) => n.id), ['d:1']);
  assert.equal(g.edges.length, 0);
});

test('a name resolves only when exact AND unambiguous', () => {
  // "sw-lager-1" must not match "sw-lager-10", and a name two switches share
  // resolves to neither — otherwise the edge goes to whichever row was read
  // first, which is an adjacency chosen by row order.
  const exact = buildTopologyGraph({
    devices: [DEV({ id: 1, displayName: 'sw-lager-1' }), DEV({ id: 2, displayName: 'sw-lager-10' })],
    deviceNeighbours: [{ deviceId: 1, remoteSysName: 'SW-Lager-10' }],
  });
  assert.deepEqual(exact.edges.map((e) => e.target), ['d:2']);

  const ambiguous = buildTopologyGraph({
    devices: [DEV({ id: 1, displayName: 'core' }), DEV({ id: 2, displayName: 'core' }), DEV({ id: 3 })],
    deviceNeighbours: [{ deviceId: 3, remoteSysName: 'core' }],
  });
  assert.equal(ambiguous.edges.length, 0);
});

test('both ends reporting the same adjacency is ONE edge', () => {
  const g = buildTopologyGraph({
    devices: [DEV({ id: 1 }), DEV({ id: 2 })],
    deviceMacs: [
      { deviceId: 1, physAddress: 'aa:aa:aa:aa:aa:aa' },
      { deviceId: 2, physAddress: 'bb:bb:bb:bb:bb:bb' },
    ],
    deviceNeighbours: [
      { deviceId: 1, remoteChassisId: 'bb:bb:bb:bb:bb:bb' },
      { deviceId: 2, remoteChassisId: 'aa:aa:aa:aa:aa:aa' },
    ],
  });
  assert.equal(g.edges.filter((e) => e.type === 'l2_link').length, 1);
});

// ============================================================= blast radius
function chain() {
  // agent 9 — sw-core (d:1) — sw-access (d:2) — agent 7 behind it
  return buildTopologyGraph({
    agents: [AGENT({ id: 9 }), AGENT({ id: 7, hostname: 'be-lager-01' })],
    devices: [DEV({ id: 1, displayName: 'sw-core' }), DEV({ id: 2, displayName: 'sw-access' })],
    l2: [
      { localAgentId: 9, localChassisId: '99:99:99:99:99:99' },
      { localAgentId: 7, localChassisId: '77:77:77:77:77:77' },
    ],
    deviceMacs: [
      { deviceId: 1, physAddress: '11:11:11:11:11:11' },
      { deviceId: 2, physAddress: '22:22:22:22:22:22' },
    ],
    deviceNeighbours: [
      { deviceId: 1, remoteChassisId: '99:99:99:99:99:99' },
      { deviceId: 1, remoteChassisId: '22:22:22:22:22:22' },
      { deviceId: 2, remoteChassisId: '77:77:77:77:77:77' },
    ],
  });
}

test('a failing SWITCH isolates what is behind it', () => {
  // The question the whole L2 tier exists for, and the one that used to return
  // nothing: `Number('d:1')` is NaN, so the walk started from a node that was
  // not in the graph and said so by returning an empty answer.
  const radius = computeBlastRadius(chain(), 'd:1');
  assert.equal(radius.failingNode, 'd:1');
  const hit = radius.directly_isolated.map((h) => h.hostId);
  assert.ok(hit.includes(9), 'the agent on one side');
  assert.ok(hit.includes('d:2'), 'the switch on the other');
  assert.ok(hit.includes(7), 'and what is behind that switch');
});

test('the path back to the failing switch is spelled in real ids', () => {
  const radius = computeBlastRadius(chain(), 'd:1');
  const far = radius.directly_isolated.find((h) => h.hostId === 7);
  assert.deepEqual(far.path, ['d:1', 'd:2', 7]);
});

test('a failing AGENT still works exactly as before', () => {
  // The change must not move the answer for the case that already worked.
  const radius = computeBlastRadius(chain(), 9);
  assert.equal(radius.failingNode, 9);
  assert.ok(radius.directly_isolated.map((h) => h.hostId).includes('d:1'));
});

test('a device id arriving as a URL string resolves to the same node', () => {
  const fromUrl = computeBlastRadius(chain(), 'd:1');
  const direct = computeBlastRadius(chain(), 'd:1');
  assert.deepEqual(fromUrl.totals, direct.totals);
  // And an id that is not one at all does not walk a graph full of NaN.
  const nonsense = computeBlastRadius(chain(), 'not-a-node');
  assert.deepEqual(nonsense.directly_isolated, []);
});
