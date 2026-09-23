'use strict';

// Trin 5: layer-2 forwarding loop detection.
//
// There was no detector before this — `diagnose/playbooks/l2_loop.json` is a
// symptom playbook, text and a test plan, with no SNMP behind it. The audit's
// finding was that the premise did not hold.
//
// A loop is not an outlier in one metric, and these tests are mostly about
// REFUSING to call one. A MAC moves when somebody unplugs a laptop; broadcast
// rises when a backup starts; STP changes when a port comes up. Each is
// ordinary alone, and a detector that fires on any of them is a detector
// somebody switches off in a week.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectLoop, pairsFromMoves, MIN_MOVES_PER_MAC, MIN_FLAPPING_MACS, BROADCAST_STORM_MIN_PPS,
} = require('../src/analysis/l2Loop');

// Six MACs bouncing between bridge ports 12 and 24 — the textbook signature.
const flapping = (n = 6, { from = 12, to = 24, moves = 9 } = {}) => Array.from({ length: n }, (_, i) => ({
  mac: `00:1b:44:11:3a:${String(i).padStart(2, '0')}`,
  vlan: 20,
  bridgePort: i % 2 === 0 ? to : from,
  prevBridgePort: i % 2 === 0 ? from : to,
  ifName: i % 2 === 0 ? 'Gi1/0/24' : 'Gi1/0/12',
  movesInWindow: moves,
}));

const surging = (n = 4) => Array.from({ length: n }, (_, i) => ({
  interfaceId: i + 1, ifName: `Gi1/0/${i + 1}`, inBcastPps: 900, baselineBcastPps: 3,
}));

// ============================================================ it fires
test('MACs bouncing between two ports is a loop, and the verdict names the two ports', async () => {
  const out = detectLoop({ moving: flapping(), broadcast: surging(), topoChanges: 4, deviceName: 'sw-core-1' });
  assert.ok(out);
  assert.equal(out.severity, 'CRIT');
  assert.equal(out.flappingMacs, 6);

  const [top] = out.pairs;
  assert.equal(top.portA, 12);
  assert.equal(top.portB, 24);
  assert.equal(top.macs, 6);

  // The sentence has to send somebody somewhere. A technician at 02:00 needs
  // the two cables, not the arithmetic.
  assert.match(out.explanation, /Gi1\/0\/12/);
  assert.match(out.explanation, /Gi1\/0\/24/);
  assert.match(out.explanation, /one of those two links/i);
  assert.match(out.explanation, /VLAN 20/);
});

test('the explanation says WHY a MAC on two ports means what it means', async () => {
  // The fact that makes the whole thing legible: a switch relearns an address
  // on whichever port delivered last.
  const out = detectLoop({ moving: flapping(), broadcast: surging() });
  assert.match(out.explanation, /arriving by two paths/i);
});

test('flapping alone is a case, and a weaker one', () => {
  // No broadcast surge, no STP churn. Still worth raising — but not a
  // critical, because the corroboration is missing.
  const out = detectLoop({ moving: flapping(4), broadcast: [], topoChanges: 0 });
  assert.ok(out);
  assert.equal(out.severity, 'WARN');
  assert.equal(out.surgingPorts, 0);
});

test('every corroborating fact raises the severity', () => {
  const weak = detectLoop({ moving: flapping(4), broadcast: [], topoChanges: 0 });
  const strong = detectLoop({ moving: flapping(4), broadcast: surging(), topoChanges: 4 });
  assert.ok(strong.score > weak.score);
  assert.equal(strong.severity, 'CRIT');
});

// ======================================================= it refuses to fire
test('ONE moving MAC is not a loop — it is a laptop', () => {
  assert.equal(detectLoop({ moving: flapping(1), broadcast: surging(), topoChanges: 4 }), null);
});

test('a MAC that moved twice is not flapping', () => {
  // Somebody unplugged it and plugged it in elsewhere. A loop produces dozens.
  const barely = flapping(8, { moves: MIN_MOVES_PER_MAC - 1 });
  assert.equal(detectLoop({ moving: barely, broadcast: surging(), topoChanges: 4 }), null);
});

test('broadcast alone is NOT a loop while it is one reading, however loud', () => {
  // A backup starting, a discovery sweep, a misconfigured application. Firing
  // on this is how a detector gets switched off in a week. (Updated
  // deliberately: this used to hold for ANY broadcast without MAC flapping. A
  // storm that is SUSTAINED is now a lower-confidence case — see below — but a
  // surge the service has not seen hold is still nothing.)
  assert.equal(detectLoop({ moving: [], broadcast: surging(20), topoChanges: 0 }), null);
});

test('a SUSTAINED, loud storm with no MAC moving is a suspected loop behind the port — at WARN', () => {
  // The loop is downstream of one port (an unmanaged switch patched to
  // itself), so every circulating frame arrives the same way and no MAC ever
  // flaps here. The storm itself is the only evidence this switch has.
  const storm = [{
    interfaceId: 7, ifName: 'Gi1/0/7', inBcastPps: 2500, baselineBcastPps: 2, sustained: true,
  }];
  const out = detectLoop({ moving: [], broadcast: storm, topoChanges: 0, deviceName: 'sw-acc-3' });
  assert.ok(out);
  assert.equal(out.basis, 'broadcast');
  assert.equal(out.severity, 'WARN');
  assert.deepEqual(out.stormPorts, [{ interfaceId: 7, ifName: 'Gi1/0/7' }]);
  assert.match(out.explanation, /Gi1\/0\/7/);
  assert.match(out.explanation, /sw-acc-3/);
  assert.match(out.explanation, /BEHIND that port/);

  // STP churn corroborates, but never promotes it to CRIT.
  const churn = detectLoop({ moving: [], broadcast: storm, topoChanges: 6 });
  assert.equal(churn.severity, 'WARN');
  assert.ok(churn.score > out.score);
});

test('a sustained storm under the absolute floor is a chatty port, not a storm', () => {
  const chatty = [{ interfaceId: 7, ifName: 'Gi1/0/7', inBcastPps: BROADCAST_STORM_MIN_PPS - 1, baselineBcastPps: 1, sustained: true }];
  assert.equal(detectLoop({ moving: [], broadcast: chatty }), null);
});

test('port-pair moves count the WINDOW, never the all-time counter', () => {
  const pairs = pairsFromMoves([
    { mac: 'a', bridgePort: 12, prevBridgePort: 24, movesInWindow: 3, moveCount: 400 },
    { mac: 'b', bridgePort: 24, prevBridgePort: 12, movesInWindow: 2, moveCount: 900 },
  ]);
  assert.equal(pairs[0].moves, 5);
});

test('spanning-tree churn alone is NOT a loop', () => {
  // A port coming up reconverges the tree. That is STP working.
  assert.equal(detectLoop({ moving: [], broadcast: [], topoChanges: 12 }), null);
});

test('two flapping MACs are under the floor', () => {
  assert.equal(detectLoop({ moving: flapping(MIN_FLAPPING_MACS - 1) }), null);
});

test('no input at all answers null rather than throwing', () => {
  assert.equal(detectLoop(), null);
  assert.equal(detectLoop({ moving: null, broadcast: null, topoChanges: null }), null);
});

// ==================================================== the broadcast baseline
test('a surge is measured against the PORT\'S OWN history, not an absolute', () => {
  // An access port doing 5 broadcasts a second is odd. An uplink doing 5 is
  // idle. An absolute threshold gets one of those two wrong every time.
  const busyUplinkAtRest = [
    { interfaceId: 1, ifName: 'Gi1/0/1', inBcastPps: 40, baselineBcastPps: 35 },
    { interfaceId: 2, ifName: 'Gi1/0/2', inBcastPps: 45, baselineBcastPps: 38 },
    { interfaceId: 3, ifName: 'Gi1/0/3', inBcastPps: 50, baselineBcastPps: 44 },
  ];
  const out = detectLoop({ moving: flapping(4), broadcast: busyUplinkAtRest });
  assert.equal(out.surgingPorts, 0, 'a busy port at its usual level is not surging');

  const quietPortGoneMad = [
    { interfaceId: 1, ifName: 'Gi1/0/1', inBcastPps: 40, baselineBcastPps: 0.5 },
    { interfaceId: 2, ifName: 'Gi1/0/2', inBcastPps: 45, baselineBcastPps: 0.5 },
    { interfaceId: 3, ifName: 'Gi1/0/3', inBcastPps: 50, baselineBcastPps: 0.5 },
  ];
  assert.equal(detectLoop({ moving: flapping(4), broadcast: quietPortGoneMad }).surgingPorts, 3);
});

test('a port with NO baseline needs an absolute floor, or everything is an infinite surge', () => {
  const noHistory = [
    { interfaceId: 1, inBcastPps: 3, baselineBcastPps: 0 },
    { interfaceId: 2, inBcastPps: 3, baselineBcastPps: 0 },
    { interfaceId: 3, inBcastPps: 3, baselineBcastPps: 0 },
  ];
  assert.equal(detectLoop({ moving: flapping(4), broadcast: noHistory }).surgingPorts, 0);

  const noHistoryButLoud = noHistory.map((b) => ({ ...b, inBcastPps: 800 }));
  assert.equal(detectLoop({ moving: flapping(4), broadcast: noHistoryButLoud }).surgingPorts, 3);
});

test('an unreadable broadcast rate is not evidence either way', () => {
  const unreadable = [
    { interfaceId: 1, inBcastPps: null, baselineBcastPps: 1 },
    { interfaceId: 2, inBcastPps: 900, baselineBcastPps: null },
  ];
  assert.equal(detectLoop({ moving: flapping(4), broadcast: unreadable }).surgingPorts, 0);
});

// ================================================================ the pairs
test('the pairs are ordered by how many MACs are on each, best first', () => {
  const mixed = [
    ...flapping(6, { from: 12, to: 24 }),
    ...flapping(3, { from: 5, to: 6 }),
  ];
  const pairs = pairsFromMoves(mixed);
  assert.equal(pairs[0].macs, 6);
  assert.equal(pairs[0].portA, 12);
  assert.equal(pairs[1].macs, 3);
});

test('a port pair is order-independent — 12→24 and 24→12 are one pair', () => {
  const pairs = pairsFromMoves([
    { mac: 'a', bridgePort: 24, prevBridgePort: 12, movesInWindow: 5 },
    { mac: 'b', bridgePort: 12, prevBridgePort: 24, movesInWindow: 5 },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].macs, 2);
});

test('a MAC with no previous port contributes no pair', () => {
  // It has moved, but we do not know from where, so it cannot name two cables.
  const pairs = pairsFromMoves([{ mac: 'a', bridgePort: 12, prevBridgePort: null, movesInWindow: 9 }]);
  assert.deepEqual(pairs, []);
});

// =============================================================== the evidence
test('the evidence is capped, so a storm does not write a thousand MACs into a column', () => {
  const out = detectLoop({ moving: flapping(200), broadcast: surging(50) });
  assert.equal(out.flappingMacs, 200, 'the COUNT is honest');
  assert.equal(out.evidence.macs.length, 20);
  assert.equal(out.evidence.broadcast.length, 10);
  assert.ok(out.pairs.length <= 5);
});

test('the evidence carries enough to check the verdict by hand', () => {
  const out = detectLoop({ moving: flapping(4), broadcast: surging() });
  const [m] = out.evidence.macs;
  assert.ok(m.mac);
  assert.equal(m.from, 12);
  assert.equal(m.to, 24);
  assert.equal(m.moves, 9);
  assert.equal(out.evidence.broadcast[0].pps, 900);
  assert.equal(out.evidence.broadcast[0].baselinePps, 3);
});
