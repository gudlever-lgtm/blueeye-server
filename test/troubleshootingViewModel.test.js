'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const TV = require('../public/troubleshootingView');

test('node state maps to a class and a label; unknown falls back to ok', () => {
  assert.equal(TV.stateClass('down'), 'ts-down');
  assert.equal(TV.stateClass('unreachable_downstream'), 'ts-unreachable_downstream');
  assert.equal(TV.stateClass('ok'), 'ts-ok');
  assert.equal(TV.stateClass('nonsense'), 'ts-ok');
  assert.equal(TV.stateClass(undefined), 'ts-ok');
  assert.equal(TV.stateLabel('unreachable_downstream'), 'Unreachable downstream');
});

// --- key figures ------------------------------------------------------------
test('the four cards appear in reading order', () => {
  const cards = TV.kpiCards({ activeFaults: 47, affectedDevices: 12, rootCauses: 3, anomalies: 5 });
  assert.deepEqual(cards.map((c) => c.key), ['activeFaults', 'affectedDevices', 'rootCauses', 'anomalies']);
  assert.deepEqual(cards.map((c) => c.value), [47, 12, 3, 5]);
});

test('the cards spell out the rollup rather than leaving the operator to divide', () => {
  const cards = TV.kpiCards({ activeFaults: 47, rootCauses: 3 });
  assert.equal(cards[0].hint, 'raw alarms across 3 root causes');
  assert.equal(cards[2].hint, 'collapsed from 47 alarms');
});

test('cards singularise and survive an empty summary', () => {
  const one = TV.kpiCards({ activeFaults: 1, rootCauses: 1 });
  assert.equal(one[0].hint, 'raw alarms across 1 root cause');
  assert.equal(one[2].hint, 'collapsed from 1 alarm');

  const none = TV.kpiCards();
  assert.deepEqual(none.map((c) => c.value), [0, 0, 0, 0]);
  assert.equal(none[0].hint, 'no correlated causes');
});

test('the affected-devices card breaks the number down', () => {
  const [, devices] = TV.kpiCards({ affectedDevices: 5, devicesDown: 1, devicesUnreachable: 2 });
  assert.equal(devices.hint, '1 down · 2 unreachable downstream');
});

// --- root causes ------------------------------------------------------------
test('blast radius reads as a concrete sentence, both tiers', () => {
  assert.equal(
    TV.blastRadiusText({ blastRadius: { directlyIsolated: [1, 2], dependencyAffected: [] } }),
    '→ 2 devices unreachable',
  );
  assert.equal(
    TV.blastRadiusText({ blastRadius: { directlyIsolated: [1], dependencyAffected: [3, 4] } }),
    '→ 1 device unreachable · 2 dependent services affected',
  );
  assert.equal(
    TV.blastRadiusText({ blastRadius: { directlyIsolated: [], dependencyAffected: [3] } }),
    '→ 1 dependent service affected',
  );
  // Nothing beyond the named devices — no misleading "→ 0" line.
  assert.equal(TV.blastRadiusText({ blastRadius: { directlyIsolated: [], dependencyAffected: [] } }), null);
  assert.equal(TV.blastRadiusText({}), null);
});

test('root cause model carries what the panel renders', () => {
  const m = TV.rootCauseModel({
    id: 7, severity: 'CRIT', cause: 'Uplink down', affectedDeviceIds: [2, 3],
    blastRadiusCount: 2, primaryDeviceId: 2, confidence: 'high', status: 'open',
    blastRadius: { directlyIsolated: [9], dependencyAffected: [10] },
  });
  assert.equal(m.severity, 'CRIT');
  assert.equal(m.affectedText, '2 devices affected');
  assert.equal(m.pathAnchorId, 2);
  assert.equal(m.blastText, '→ 1 device unreachable · 1 dependent service affected');
});

test('root cause model degrades gracefully on a sparse object', () => {
  const m = TV.rootCauseModel({});
  assert.equal(m.cause, 'Correlated anomalies.');
  assert.equal(m.severity, 'INFO');
  assert.equal(m.affectedText, '0 devices affected');
  assert.equal(m.pathAnchorId, null);
  assert.equal(m.blastText, null);
});

// --- "What changed?" --------------------------------------------------------
const ev = (ts, source, type) => ({ timestamp: ts, source, type, severity: 'INFO', summary: 's', ref_id: 1 });

test('a topology change is a change; an agent going offline is a symptom', () => {
  assert.equal(TV.isChangeEvent(ev('x', 'topology', 'topology.port_moved')), true);
  assert.equal(TV.isChangeEvent(ev('x', 'agent', 'agent.online')), true);
  assert.equal(TV.isChangeEvent(ev('x', 'agent', 'agent.enrolled')), true);
  assert.equal(TV.isChangeEvent(ev('x', 'agent', 'agent.offline')), false);
  assert.equal(TV.isChangeEvent(ev('x', 'finding', 'cpu')), false);
  assert.equal(TV.isChangeEvent(null), false);
});

test('changesBefore returns only changes inside the lookback window', () => {
  const since = '2026-07-27T12:00:00.000Z';
  const timeline = [
    ev('2026-07-27T12:05:00.000Z', 'topology', 'topology.a'), // after the fault
    ev('2026-07-27T11:55:00.000Z', 'topology', 'topology.b'), // in window
    ev('2026-07-27T11:50:00.000Z', 'agent', 'agent.offline'), // symptom
    ev('2026-07-27T11:40:00.000Z', 'agent', 'agent.online'), // in window
    ev('2026-07-27T10:00:00.000Z', 'topology', 'topology.c'), // too old
  ];
  const out = TV.changesBefore(timeline, since, 30 * 60 * 1000);
  assert.deepEqual(out.map((e) => e.type), ['topology.b', 'agent.online']);
});

test('an event exactly at the boundary is included', () => {
  const since = '2026-07-27T12:00:00.000Z';
  const timeline = [
    ev(since, 'topology', 'topology.at-fault'),
    ev('2026-07-27T11:30:00.000Z', 'topology', 'topology.at-edge'),
  ];
  assert.equal(TV.changesBefore(timeline, since, 30 * 60 * 1000).length, 2);
});

test('an absent since yields nothing, not the whole timeline', () => {
  const timeline = [ev('2026-07-27T11:00:00.000Z', 'topology', 'topology.a')];
  assert.deepEqual(TV.changesBefore(timeline, null), []);
  assert.deepEqual(TV.changesBefore(timeline, 'not-a-date'), []);
  assert.deepEqual(TV.changesBefore(null, '2026-07-27T12:00:00.000Z'), []);
});

// --- brush ------------------------------------------------------------------
test('timelineBounds spans the events; a single event still gets a width', () => {
  const b = TV.timelineBounds([
    ev('2026-07-27T10:00:00.000Z', 'agent', 'agent.online'),
    ev('2026-07-27T12:00:00.000Z', 'agent', 'agent.online'),
  ]);
  assert.equal(b.fromMs, Date.parse('2026-07-27T10:00:00.000Z'));
  assert.equal(b.toMs, Date.parse('2026-07-27T12:00:00.000Z'));

  const single = TV.timelineBounds([ev('2026-07-27T10:00:00.000Z', 'agent', 'agent.online')]);
  assert.ok(single.toMs > single.fromMs, 'a lone marker must still be selectable');
});

test('timelineBounds is null when there is nothing to draw', () => {
  assert.equal(TV.timelineBounds([]), null);
  assert.equal(TV.timelineBounds(null), null);
  assert.equal(TV.timelineBounds([{ timestamp: 'garbage' }]), null);
});

test('eventsInWindow filters inclusively and tolerates a reversed brush', () => {
  const timeline = [
    ev('2026-07-27T10:00:00.000Z', 'agent', 'a'),
    ev('2026-07-27T11:00:00.000Z', 'agent', 'b'),
    ev('2026-07-27T12:00:00.000Z', 'agent', 'c'),
  ];
  const lo = Date.parse('2026-07-27T11:00:00.000Z');
  const hi = Date.parse('2026-07-27T12:00:00.000Z');
  assert.deepEqual(TV.eventsInWindow(timeline, lo, hi).map((e) => e.type), ['b', 'c']);
  // Dragging the brush right-to-left must select the same range.
  assert.deepEqual(TV.eventsInWindow(timeline, hi, lo).map((e) => e.type), ['b', 'c']);
  // No window set = everything.
  assert.equal(TV.eventsInWindow(timeline).length, 3);
});

// --- layout -----------------------------------------------------------------
test('layout is deterministic — two refreshes draw the same graph', () => {
  const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const links = [{ source: 1, target: 2 }, { source: 2, target: 3 }];
  assert.deepEqual(TV.layoutNodes(nodes, links, 760, 460), TV.layoutNodes(nodes, links, 760, 460));
});

test('layout keeps every node on canvas', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
  const links = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id }));
  const pos = TV.layoutNodes(nodes, links, 760, 460);
  for (const id of Object.keys(pos)) {
    assert.ok(pos[id].x >= 30 && pos[id].x <= 730, `x on canvas for ${id}`);
    assert.ok(pos[id].y >= 30 && pos[id].y <= 430, `y on canvas for ${id}`);
  }
});

test('layout handles the degenerate cases', () => {
  assert.deepEqual(TV.layoutNodes([], [], 760, 460), {});
  assert.equal(Object.keys(TV.layoutNodes([{ id: 1 }], [], 760, 460)).length, 1);
  // Links pointing at nodes that are not in the graph must not throw.
  assert.equal(Object.keys(TV.layoutNodes([{ id: 1 }, { id: 2 }, { id: 3 }], [{ source: 1, target: 99 }], 760, 460)).length, 3);
});

test('pathNodeIds flattens both blast-radius path shapes without duplicates', () => {
  const ids = TV.pathNodeIds([
    { hostId: 3, path: [1, 2, 3] }, // L2 tier: plain ids
    { hostId: 4, path: [{ hostId: 3, viaPort: null }, { hostId: 4, viaPort: 5432 }] }, // dependency tier
  ]);
  assert.deepEqual(ids, [1, 2, 3, 4]);
  assert.deepEqual(TV.pathNodeIds(null), []);
  assert.deepEqual(TV.pathNodeIds([{ hostId: 1 }]), []);
});
