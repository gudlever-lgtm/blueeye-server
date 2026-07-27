'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTopologyView,
  stateFromAgentStatus,
  worseState,
  NODE_STATE,
} = require('../src/troubleshooting/overview');

const node = (id, label) => ({ id, label: label || `agent ${id}` });
const l2 = (a, b) => ({ type: 'l2_link', directed: false, source: a, target: b });
const dep = (a, b, dstPort = 443) => ({ type: 'service_dep', directed: true, source: a, target: b, dstPort });
const agent = (id, status, over = {}) => ({ id, status, hostname: `h${id}`, ...over });
const radius = (isolated = []) => ({
  directly_isolated: isolated.map((hostId) => ({ hostId, path: [] })),
  dependency_affected: [],
});
const stateOf = (view, id) => view.nodes.find((n) => n.id === id).state;

test('agent status maps to a node state', () => {
  assert.equal(stateFromAgentStatus('online'), NODE_STATE.OK);
  assert.equal(stateFromAgentStatus('offline'), NODE_STATE.DOWN);
  assert.equal(stateFromAgentStatus('OFFLINE'), NODE_STATE.DOWN);
  // Unknown status never invents a fault.
  assert.equal(stateFromAgentStatus('degraded'), NODE_STATE.OK);
  assert.equal(stateFromAgentStatus(null), NODE_STATE.OK);
});

test('worseState ranks down above unreachable above ok', () => {
  assert.equal(worseState(NODE_STATE.OK, NODE_STATE.DOWN), NODE_STATE.DOWN);
  assert.equal(worseState(NODE_STATE.DOWN, NODE_STATE.UNREACHABLE_DOWNSTREAM), NODE_STATE.DOWN);
  assert.equal(worseState(NODE_STATE.OK, NODE_STATE.UNREACHABLE_DOWNSTREAM), NODE_STATE.UNREACHABLE_DOWNSTREAM);
  assert.equal(worseState(NODE_STATE.OK, NODE_STATE.OK), NODE_STATE.OK);
});

test('an offline agent is down; its L2-isolated hosts go unreachable_downstream', () => {
  // 1 (down) - 2 - 3 ; both 2 and 3 are cut off behind 1.
  const view = buildTopologyView({
    graph: { nodes: [node(1), node(2), node(3)], edges: [l2(1, 2), l2(2, 3)] },
    agents: [agent(1, 'offline'), agent(2, 'online'), agent(3, 'online')],
    blastByNode: new Map([[1, radius([2, 3])]]),
  });
  assert.equal(stateOf(view, 1), NODE_STATE.DOWN);
  assert.equal(stateOf(view, 2), NODE_STATE.UNREACHABLE_DOWNSTREAM);
  assert.equal(stateOf(view, 3), NODE_STATE.UNREACHABLE_DOWNSTREAM);
  assert.deepEqual(view.counts, { ok: 0, down: 1, unreachable_downstream: 2 });
});

test('a node that is itself down is never downgraded to unreachable', () => {
  const view = buildTopologyView({
    graph: { nodes: [node(1), node(2)], edges: [l2(1, 2)] },
    agents: [agent(1, 'offline'), agent(2, 'offline')],
    blastByNode: new Map([[1, radius([2])], [2, radius([1])]]),
  });
  assert.equal(stateOf(view, 1), NODE_STATE.DOWN);
  assert.equal(stateOf(view, 2), NODE_STATE.DOWN);
});

test('service dependents are NOT greyed out — degraded service is not lost reachability', () => {
  const view = buildTopologyView({
    graph: { nodes: [node(1), node(2)], edges: [dep(2, 1)] },
    agents: [agent(1, 'offline'), agent(2, 'online')],
    blastByNode: new Map([[1, { directly_isolated: [], dependency_affected: [{ hostId: 2, path: [] }] }]]),
  });
  assert.equal(stateOf(view, 2), NODE_STATE.OK);
});

test('links are tagged l2 / l3 and take the worse endpoint state', () => {
  const view = buildTopologyView({
    graph: { nodes: [node(1), node(2), node(3)], edges: [l2(1, 2), dep(3, 2, 5432)] },
    agents: [agent(1, 'offline'), agent(2, 'online'), agent(3, 'online')],
    blastByNode: new Map(),
  });
  const link = view.links.find((l) => l.layer === 'l2');
  assert.equal(link.state, NODE_STATE.DOWN); // endpoint 1 is down
  assert.equal(link.directed, false);

  const service = view.links.find((l) => l.layer === 'l3');
  assert.equal(service.state, NODE_STATE.OK);
  assert.equal(service.directed, true);
  assert.equal(service.dstPort, 5432);

  assert.deepEqual(view.layers, { l2: 1, l3: 1 });
});

test('an unknown agent keeps its graph label and does not fault', () => {
  const view = buildTopologyView({
    graph: { nodes: [node(9, 'sw-core-1')], edges: [] },
    agents: [],
  });
  assert.equal(view.nodes[0].label, 'sw-core-1');
  assert.equal(view.nodes[0].state, NODE_STATE.OK);
  assert.equal(view.nodes[0].status, null);
});

test('empty / missing topology yields an empty view, never a throw', () => {
  for (const input of [undefined, {}, { graph: null }, { graph: { nodes: null, edges: 'x' } }]) {
    const view = buildTopologyView(input);
    assert.deepEqual(view.nodes, []);
    assert.deepEqual(view.links, []);
    assert.deepEqual(view.counts, { ok: 0, down: 0, unreachable_downstream: 0 });
  }
});

test('edges referencing unknown-shaped endpoints are dropped, not rendered as NaN', () => {
  const view = buildTopologyView({
    graph: { nodes: [node(1)], edges: [{ type: 'l2_link', source: null, target: 1 }, l2(1, 2)] },
    agents: [agent(1, 'online')],
  });
  assert.equal(view.links.length, 1);
  assert.equal(view.links[0].target, 2);
});
