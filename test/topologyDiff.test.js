'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { diffSnapshots, isInverse } = require('../src/topology/topologyDiff');

const nb = (localPort, remoteChassisId, remotePort = 'gi1', linkState = null) => ({ localPort, remoteChassisId, remotePort, linkState });

test('no changes on identical snapshots', () => {
  const snap = [nb('eth0', 'sw-a'), nb('eth1', 'sw-b', 'gi2', 'up')];
  assert.deepEqual(diffSnapshots(snap, snap), []);
  assert.deepEqual(diffSnapshots(snap, [...snap]), []);
});

test('neighbour_added', () => {
  const changes = diffSnapshots([nb('eth0', 'sw-a')], [nb('eth0', 'sw-a'), nb('eth1', 'sw-b')]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'neighbour_added');
  assert.equal(changes[0].remoteChassisId, 'sw-b');
  assert.equal(changes[0].localPort, 'eth1');
  assert.equal(changes[0].severity, 'INFO');
});

test('neighbour_removed', () => {
  const changes = diffSnapshots([nb('eth0', 'sw-a'), nb('eth1', 'sw-b')], [nb('eth0', 'sw-a')]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'neighbour_removed');
  assert.equal(changes[0].remoteChassisId, 'sw-b');
  assert.equal(changes[0].severity, 'WARN');
});

test('link_state_changed (up -> down is WARN)', () => {
  const changes = diffSnapshots([nb('eth0', 'sw-a', 'gi1', 'up')], [nb('eth0', 'sw-a', 'gi1', 'down')]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'link_state_changed');
  assert.equal(changes[0].linkStateFrom, 'up');
  assert.equal(changes[0].linkStateTo, 'down');
  assert.equal(changes[0].severity, 'WARN');
});

test('link_state_changed (down -> up is INFO)', () => {
  const changes = diffSnapshots([nb('eth0', 'sw-a', 'gi1', 'down')], [nb('eth0', 'sw-a', 'gi1', 'up')]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'link_state_changed');
  assert.equal(changes[0].severity, 'INFO');
});

test('port_moved: same chassis on a different local port (not add+remove)', () => {
  const changes = diffSnapshots([nb('eth1', 'sw-a', 'gi5')], [nb('eth2', 'sw-a', 'gi5')]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'port_moved');
  assert.equal(changes[0].remoteChassisId, 'sw-a');
  assert.equal(changes[0].fromLocalPort, 'eth1');
  assert.equal(changes[0].localPort, 'eth2');
});

test('a different chassis appearing while another leaves is add + remove, not a move', () => {
  const changes = diffSnapshots([nb('eth1', 'sw-a')], [nb('eth2', 'sw-b')]);
  const types = changes.map((c) => c.changeType).sort();
  assert.deepEqual(types, ['neighbour_added', 'neighbour_removed']);
});

test('mixed snapshot yields all applicable change types', () => {
  const prev = [nb('eth0', 'sw-a', 'gi1', 'up'), nb('eth1', 'sw-b'), nb('eth3', 'sw-c')];
  const next = [nb('eth0', 'sw-a', 'gi1', 'down'), nb('eth1', 'sw-b'), nb('eth4', 'sw-c'), nb('eth9', 'sw-d')];
  const changes = diffSnapshots(prev, next);
  const byType = changes.reduce((m, c) => { (m[c.changeType] ||= []).push(c); return m; }, {});
  assert.equal(byType.link_state_changed.length, 1); // sw-a up->down
  assert.equal(byType.port_moved.length, 1);         // sw-c eth3->eth4
  assert.equal(byType.neighbour_added.length, 1);    // sw-d
  assert.ok(!byType.neighbour_removed);              // sw-c move consumed the removal
});

test('isInverse detects reverts on the same edge only', () => {
  const added = diffSnapshots([], [nb('eth1', 'sw-a')])[0];
  const removed = diffSnapshots([nb('eth1', 'sw-a')], [])[0];
  assert.equal(isInverse(added, removed), true);
  assert.equal(isInverse(removed, added), true);
  // different edge → not an inverse
  const removedOther = diffSnapshots([nb('eth2', 'sw-z')], [])[0];
  assert.equal(isInverse(added, removedOther), false);

  const up2down = diffSnapshots([nb('eth0', 'sw-a', 'gi1', 'up')], [nb('eth0', 'sw-a', 'gi1', 'down')])[0];
  const down2up = diffSnapshots([nb('eth0', 'sw-a', 'gi1', 'down')], [nb('eth0', 'sw-a', 'gi1', 'up')])[0];
  assert.equal(isInverse(up2down, down2up), true);
});
