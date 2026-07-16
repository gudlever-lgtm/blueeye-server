'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIncidentTimeline, PRE_INCIDENT_SOURCES } = require('../src/timeline/incidentTimeline');

const T = new Date('2026-07-01T12:00:00Z').getTime();
const at = (offsetMs) => new Date(T + offsetMs);

const finding = (over = {}) => ({
  id: 'f1', hostId: '1', metric: 'probe.loss', severity: 'CRIT',
  explanation: 'loss spike', evidence: [{}], createdAt: at(0), ...over,
});

test('merges all sources newest-first and tags each event with its target', () => {
  const { events } = buildIncidentTimeline({
    memberFindings: [finding({ id: 'f1', hostId: '1', createdAt: at(0) })],
    agentSources: [{
      agentId: '1',
      agentEvents: [{ id: 10, action: 'agent.offline', ts: at(-60000) }],
      playbookRuns: [{ id: 20, playbookName: 'Restart', status: 'success', ranAt: at(30000) }],
      incidents: [],
      configChanges: [{ id: 30, capturedAt: at(-120000), capturedVia: 'change_detected' }],
    }],
    statusChanges: [{ id: 40, action: 'cluster_acknowledge', detail: 'open→acknowledged', createdAt: at(120000) }],
    firstFindingAt: at(0),
    lookbackMs: 30 * 60 * 1000,
  });

  // newest-first: status(+2m) > playbook(+30s) > finding(0) > agent(-1m) > config(-2m)
  assert.deepEqual(events.map((e) => e.source), ['status', 'playbook', 'finding', 'agent', 'config']);
  const findingEv = events.find((e) => e.source === 'finding');
  assert.equal(findingEv.target, '1');
  assert.equal(findingEv.severity, 'CRIT');
  const statusEv = events.find((e) => e.source === 'status');
  assert.equal(statusEv.target, null); // cluster-level, not agent-scoped
});

test('what-changed contains only sources c–e in [onset - lookback, onset)', () => {
  const { whatChanged } = buildIncidentTimeline({
    memberFindings: [finding({ createdAt: at(0) })],
    agentSources: [{
      agentId: '1',
      configChanges: [{ id: 30, capturedAt: at(-10 * 60 * 1000), capturedVia: 'change_detected' }],
      playbookRuns: [{ id: 20, playbookName: 'p', status: 'success', ranAt: at(-5 * 60 * 1000) }],
      agentEvents: [{ id: 10, action: 'agent.offline', ts: at(-2 * 60 * 1000) }],
      incidents: [],
    }],
    statusChanges: [],
    firstFindingAt: at(0),
    lookbackMs: 30 * 60 * 1000,
  });
  assert.deepEqual(whatChanged.map((e) => e.source).sort(), ['agent', 'config', 'playbook']);
  for (const e of whatChanged) {
    assert.ok(PRE_INCIDENT_SOURCES.has(e.source));
    assert.ok(new Date(e.timestamp).getTime() < T);
  }
});

test('lookback boundary: a change exactly at onset is excluded; one just inside is included', () => {
  const { whatChanged } = buildIncidentTimeline({
    memberFindings: [finding({ createdAt: at(0) })],
    agentSources: [{
      agentId: '1',
      configChanges: [
        { id: 1, capturedAt: at(0), capturedVia: 'manual' },               // exactly at onset → excluded
        { id: 2, capturedAt: at(-1), capturedVia: 'manual' },              // 1ms before → included
        { id: 3, capturedAt: at(-31 * 60 * 1000), capturedVia: 'manual' }, // before the window → excluded
      ],
    }],
    firstFindingAt: at(0),
    lookbackMs: 30 * 60 * 1000,
  });
  assert.deepEqual(whatChanged.map((e) => e.ref_id).sort(), [2]);
});

test('a finding is never surfaced as a change, even when before onset', () => {
  const { whatChanged } = buildIncidentTimeline({
    memberFindings: [
      finding({ id: 'f0', createdAt: at(-3 * 60 * 1000) }),
      finding({ id: 'f1', createdAt: at(0) }),
    ],
    agentSources: [],
    firstFindingAt: at(-3 * 60 * 1000),
    lookbackMs: 30 * 60 * 1000,
  });
  assert.equal(whatChanged.length, 0); // findings are source (a), never "what changed"
});

test('events with an unparseable timestamp are dropped, not emitted null', () => {
  const { events } = buildIncidentTimeline({
    memberFindings: [finding({ id: 'bad', createdAt: null })],
    agentSources: [{ agentId: '1', configChanges: [{ id: 5, capturedAt: at(-1000), capturedVia: 'manual' }] }],
    firstFindingAt: at(0),
  });
  assert.ok(events.every((e) => e.timestamp != null));
  assert.equal(events.length, 1);
});
