'use strict';

// Unit tests for the pure Delta/Changes view logic (public/deltaView.js): the
// change-type filter + URL round-trip, and the AND-composition with the shared
// global severity/site filter. No DOM.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const DV = require('../public/deltaView');

const EVENTS = [
  { type: 'topology.neighbour_added', severity: 'INFO', agentId: 1, ref_id: 1 },
  { type: 'topology.link_state_changed', severity: 'WARN', agentId: 1, ref_id: 2 },
  { type: 'topology.flapping', severity: 'CRIT', agentId: 2, ref_id: 3 },
  { type: 'topology.port_moved', severity: 'WARN', agentId: 3, ref_id: 4 },
];

test('changeTypeOf strips the topology. prefix', () => {
  assert.equal(DV.changeTypeOf({ type: 'topology.flapping' }), 'flapping');
  assert.equal(DV.changeTypeOf({ type: 'port_moved' }), 'port_moved');
});

test('filterChanges: change-type filter (empty = all)', () => {
  assert.equal(DV.filterChanges(EVENTS, { types: [] }).length, 4);
  const only = DV.filterChanges(EVENTS, { types: ['flapping', 'port_moved'] });
  assert.deepEqual(only.map((e) => e.ref_id).sort(), [3, 4]);
});

test('filterChanges: composes with the global severity filter', () => {
  const warn = DV.filterChanges(EVENTS, { types: [], severityTokens: ['WARN'] });
  assert.deepEqual(warn.map((e) => e.ref_id).sort(), [2, 4]);
  const crit = DV.filterChanges(EVENTS, { types: [], severityTokens: ['CRIT'] });
  assert.deepEqual(crit.map((e) => e.ref_id), [3]);
});

test('filterChanges: composes with the global site filter (agent-id set)', () => {
  const site = new Set([1]); // only agent 1 is in the selected site
  const inSite = DV.filterChanges(EVENTS, { types: [], siteAgentIds: site });
  assert.deepEqual(inSite.map((e) => e.ref_id).sort(), [1, 2]);
  // AND with severity: agent 1 + WARN ⇒ just the link-state change.
  const both = DV.filterChanges(EVENTS, { types: [], severityTokens: ['WARN'], siteAgentIds: site });
  assert.deepEqual(both.map((e) => e.ref_id), [2]);
});

test('countByType tallies each change type', () => {
  const c = DV.countByType(EVENTS);
  assert.equal(c.neighbour_added, 1);
  assert.equal(c.link_state_changed, 1);
  assert.equal(c.flapping, 1);
  assert.equal(c.port_moved, 1);
  assert.equal(c.neighbour_removed, 0);
});

// ---- URL round-trip --------------------------------------------------------

test('parseChangeTypes / changeTypesPatch round-trip', () => {
  assert.deepEqual(DV.parseChangeTypes(''), []);
  assert.deepEqual(DV.parseChangeTypes('?changeTypes=flapping,port_moved'), ['flapping', 'port_moved']);
  // junk dropped
  assert.deepEqual(DV.parseChangeTypes('?changeTypes=bogus,flapping'), ['flapping']);
  // a subset serialises; all (or none) selected ⇒ dropped
  assert.deepEqual(DV.changeTypesPatch(['flapping']), { changeTypes: 'flapping' });
  assert.deepEqual(DV.changeTypesPatch([]), { changeTypes: null });
  assert.deepEqual(DV.changeTypesPatch(DV.CHANGE_TYPES.map((t) => t.key)), { changeTypes: null });
});
