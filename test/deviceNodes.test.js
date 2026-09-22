'use strict';

// A polled switch on the topology: how it is identified, and what state it is
// in. The nodes and edges are the graph's job (test/topologyGraphSwitches
// below covers that); this is the part the graph cannot answer, because it is
// about a poll and not an adjacency.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deviceState, normaliseMac, nameKey } = require('../src/topology/deviceNodes');
const N = require('../src/topology/nodeId');

const DEV = (over = {}) => ({
  id: 1, host: '10.14.0.11', displayName: 'sw-core-1', locationId: 3,
  enabled: true, lastOkAt: '2026-09-21T10:00:00.000Z', lastError: null, ...over,
});

// ================================================================== identity
test('an agent is a number and a switch is d:<id>, and neither is the other', () => {
  // Migration 104's argument, in the id: a polled switch has no token, no
  // heartbeat and no version, so it cannot share the agent id space. Agent 5
  // and device 5 both exist.
  assert.equal(N.deviceNode(5), 'd:5');
  assert.equal(N.agentNode('12'), 12);
  assert.equal(N.isDevice('d:5'), true);
  assert.equal(N.isDevice(5), false);
  assert.equal(N.deviceIdOf('d:5'), 5);
  assert.equal(N.deviceIdOf(5), null);
  assert.equal(N.agentIdOf('d:5'), null, 'a device is never read as an agent id');
  assert.equal(N.agentIdOf(12), 12);
});

test('an id from a URL or from JSON still matches itself', () => {
  // The bug this prevents: a Map keyed on raw ids holds 5 and '5' as two
  // entries, and an id arriving as a string is a node that silently stops
  // matching itself.
  assert.equal(N.key(5), N.key('5'));
  assert.equal(N.parse('12'), 12);
  assert.equal(N.parse('d:5'), 'd:5');
  assert.equal(N.parse(' d:5 '), 'd:5');
  for (const junk of [null, undefined, '', 'x', '0', '-3', 'd:0', 'd:x']) {
    assert.equal(N.parse(junk), null, String(junk));
  }
});

test('agents sort before switches, both numerically', () => {
  // `a - b` over mixed ids is NaN, which makes a sort do nothing and do it
  // silently. This is what the API's order rests on.
  assert.deepEqual([9, 'd:2', 3, 'd:10'].sort(N.compare), [3, 9, 'd:2', 'd:10']);
});

// ====================================================================== MACs
test('a MAC is the same MAC however the device spells it', () => {
  const want = '001b44113ab7';
  for (const form of ['00:1b:44:11:3a:b7', '001b.4411.3ab7', '00-1B-44-11-3A-B7', '0x001B44113AB7']) {
    assert.equal(normaliseMac(form), want, form);
  }
  for (const junk of [null, undefined, '', 'sw-core-1', '00:1b:44', {}]) {
    assert.equal(normaliseMac(junk), null, String(junk));
  }
});

test('a name matches exactly or not at all', () => {
  assert.equal(nameKey('  SW-Core-1 '), 'sw-core-1');
  assert.equal(nameKey('   '), null);
});

// ==================================================================== states
test('never polled is UNKNOWN, not ok', () => {
  // The answer a two-state model gets wrong: no error and no success is not
  // "fine". Green is the one colour nobody looks at twice, and the switch
  // nobody has ever reached is exactly the one worth looking at.
  assert.equal(deviceState(DEV({ lastOkAt: null, lastError: null })), 'unknown');
  assert.equal(deviceState(DEV({ lastError: 'timeout' })), 'down');
  assert.equal(deviceState(DEV()), 'ok');
});

test('a disabled switch has no state at all', () => {
  // Somebody turned it off. It is not failing, and a red dot nobody can fix is
  // worse than no dot.
  assert.equal(deviceState(DEV({ enabled: false })), null);
  assert.equal(deviceState(null), null);
});
