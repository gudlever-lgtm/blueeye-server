'use strict';

// Unit tests for the pure changes read-model (src/changes/changeFeed.js): the
// per-source mappers, window filtering, ordering, grouping and the cap. No DB,
// no HTTP, no clock.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSeverity,
  makeEvent,
  compareEvents,
  withinWindow,
  buildChangeFeed,
  fromAgentEvents,
  fromFindings,
  fromProbeIncidents,
  fromIncidentCases,
  fromTopologyChanges,
  fromPlaybookRuns,
  fromConfigSnapshots,
  agentHealthRows,
} = require('../src/changes/changeFeed');

const FROM = '2026-07-28T06:00:00.000Z';
const TO = '2026-07-28T14:00:00.000Z';
const nameFor = (id) => `agent-${id}`;

// ---------------------------------------------------------- severity spelling
test('normalizeSeverity folds the sources differing spellings together', () => {
  // Probe incidents say warning/critical; findings say WARN/CRIT.
  assert.equal(normalizeSeverity('critical'), 'CRIT');
  assert.equal(normalizeSeverity('CRIT'), 'CRIT');
  assert.equal(normalizeSeverity('warning'), 'WARN');
  assert.equal(normalizeSeverity('WARN'), 'WARN');
  assert.equal(normalizeSeverity('INFO'), 'INFO');
  // Anything unrecognised must not silently become CRIT and turn the page red.
  assert.equal(normalizeSeverity('weird'), 'INFO');
  assert.equal(normalizeSeverity(null), 'INFO');
});

// ------------------------------------------------------------------- mappers
test('fromAgentEvents reports the direction of the transition', () => {
  const events = fromAgentEvents([
    { id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: FROM },
    { id: 2, action: 'agent.online', actorId: 7, lastSeenAt: TO },
    { id: 3, action: 'agent.enrolled', actorId: 9, lastSeenAt: TO },
  ], { nameFor });

  assert.match(events[0].summary, /agent-7 went offline/);
  assert.equal(events[0].severity, 'WARN', 'a disconnect is actionable');
  assert.match(events[1].summary, /agent-7 went online/);
  assert.equal(events[1].severity, 'INFO', 'a reconnect is the good news that follows');
  assert.match(events[2].summary, /agent-9 enrolled/);
  assert.ok(events.every((e) => e.kind === 'agent_state'));
});

test('fromProbeIncidents emits BOTH the open and the resolve when each falls in the window', () => {
  // "The link came back" matters to a handover exactly as much as "it went down".
  const events = fromProbeIncidents([{
    id: 5, agentId: 7, metric: 'reachability', severity: 'critical',
    affectedTarget: '8.8.8.8',
    startedAt: '2026-07-28T07:00:00.000Z',
    resolvedAt: '2026-07-28T07:30:00.000Z',
  }], { from: FROM, to: TO, nameFor });

  assert.equal(events.length, 2);
  assert.match(events[0].type, /opened$/);
  assert.equal(events[0].severity, 'CRIT');
  assert.match(events[1].type, /resolved$/);
  assert.equal(events[1].severity, 'INFO', 'a recovery must not stay red');
  assert.match(events[1].summary, /recovered/);
});

test('fromProbeIncidents omits a transition that fell outside the window', () => {
  // An incident that opened before the window and is still open contributes
  // nothing: nothing about it CHANGED while the user was away.
  const events = fromProbeIncidents([{
    id: 5, agentId: 7, metric: 'latency', severity: 'warning', affectedTarget: 'x',
    startedAt: '2026-07-01T00:00:00.000Z',
    resolvedAt: null,
  }], { from: FROM, to: TO, nameFor });
  assert.deepEqual(events, []);
});

test('fromProbeIncidents emits only the resolve when the open predates the window', () => {
  const events = fromProbeIncidents([{
    id: 5, agentId: 7, metric: 'latency', severity: 'warning', affectedTarget: 'x',
    startedAt: '2026-07-01T00:00:00.000Z',
    resolvedAt: '2026-07-28T08:00:00.000Z',
  }], { from: FROM, to: TO, nameFor });
  assert.equal(events.length, 1);
  assert.match(events[0].type, /resolved$/);
});

test('fromFindings, fromIncidentCases, fromTopologyChanges and fromConfigSnapshots produce the shared event shape', () => {
  const sets = [
    fromFindings([{ id: 'f1', hostId: '7', metric: 'iface.errors', severity: 'WARN', createdAt: TO }], { nameFor }),
    fromIncidentCases([{ id: 3, hostId: '7', title: 'Loss on agent-7', status: 'open', severity: 'CRIT', firstEventAt: TO }]),
    fromTopologyChanges([{ id: 4, agentId: 7, type: 'topology.neighbour_removed', severity: 'WARN', summary: 'link gone', timestamp: TO }]),
    fromConfigSnapshots([{ id: 6, deviceId: 7, capturedAt: TO, capturedVia: 'agent_poll' }], { nameFor }),
  ];
  for (const events of sets) {
    assert.equal(events.length, 1);
    const e = events[0];
    for (const key of ['timestamp', 'source', 'type', 'severity', 'summary', 'kind']) {
      assert.ok(e[key] != null, `missing ${key} in ${JSON.stringify(e)}`);
    }
    assert.ok('ref_id' in e && 'agentId' in e && 'currentState' in e);
  }
});

test('fromPlaybookRuns raises a failed run above a successful one', () => {
  const events = fromPlaybookRuns([
    { id: 1, outcome: 'succeeded', playbookName: 'Restart bgpd', ranAt: TO },
    { id: 2, outcome: 'failed', playbookName: 'Clear ARP', ranAt: TO },
  ]);
  assert.equal(events[0].severity, 'INFO');
  assert.equal(events[1].severity, 'WARN', 'a failed playbook is something someone must pick up');
});

test('mappers survive empty and missing input', () => {
  for (const fn of [fromAgentEvents, fromFindings, fromIncidentCases, fromTopologyChanges, fromPlaybookRuns, fromConfigSnapshots]) {
    assert.deepEqual(fn(null), []);
    assert.deepEqual(fn([]), []);
  }
  assert.deepEqual(fromProbeIncidents(null, { from: FROM, to: TO }), []);
});

// ------------------------------------------------------------- current state
test('agentHealthRows flags a stale heartbeat as CURRENT STATE, not a transition', () => {
  // Heartbeat is not transition-logged, so we know the condition but not when it
  // began. Saying so is honest; inferring a start time would be inventing
  // history, which is what this page must never do.
  const now = new Date('2026-07-28T14:00:00.000Z');
  const rows = agentHealthRows([
    { id: 7, hostname: 'sw-core', last_seen: '2026-07-28T10:00:00.000Z', capabilities: {} },
    { id: 8, hostname: 'sw-edge', last_seen: '2026-07-28T13:59:00.000Z', capabilities: {} },
  ], { now });

  assert.equal(rows.length, 1, 'only the silent agent');
  assert.equal(rows[0].type, 'agent.heartbeat_stale');
  assert.equal(rows[0].currentState, true);
  assert.equal(rows[0].timestamp, now.toISOString(), 'stamped now, not with a guessed start');
  assert.equal(rows[0].severity, 'WARN');
});

test('agentHealthRows flags version skew against the served agent build', () => {
  const rows = agentHealthRows([
    { id: 7, hostname: 'a', last_seen: '2026-07-28T13:59:59.000Z', capabilities: { agentVersion: '0.19.0' } },
    { id: 8, hostname: 'b', last_seen: '2026-07-28T13:59:59.000Z', capabilities: { agentVersion: '0.21.0' } },
  ], { now: new Date('2026-07-28T14:00:00.000Z'), serverAgentVersion: '0.21.0' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'agent.version_skew');
  assert.equal(rows[0].currentState, true);
  assert.match(rows[0].summary, /0\.19\.0/);
});

test('agentHealthRows reports no skew when the server version is unknown', () => {
  // Without a reference there is nothing to compare against, and guessing would
  // flag the whole fleet.
  const rows = agentHealthRows([
    { id: 7, hostname: 'a', last_seen: '2026-07-28T13:59:59.000Z', capabilities: { agentVersion: '0.19.0' } },
  ], { now: new Date('2026-07-28T14:00:00.000Z'), serverAgentVersion: null });
  assert.deepEqual(rows, []);
});

// ------------------------------------------------------------------- window
const ev = (over) => makeEvent({
  timestamp: TO, source: 's', type: 't', severity: 'INFO', summary: 'x', kind: 'finding', ...over,
});

test('withinWindow drops events outside [from, to]', () => {
  const kept = withinWindow([
    ev({ timestamp: '2026-07-28T05:00:00.000Z', summary: 'before' }),
    ev({ timestamp: '2026-07-28T09:00:00.000Z', summary: 'inside' }),
    ev({ timestamp: '2026-07-28T15:00:00.000Z', summary: 'after' }),
  ], { from: FROM, to: TO });
  assert.deepEqual(kept.map((e) => e.summary), ['inside']);
});

test('withinWindow keeps currentState rows regardless of the window', () => {
  // They are stamped `now` and describe the present; a window ending earlier
  // must not silently discard them.
  const kept = withinWindow([
    ev({ timestamp: '2026-08-01T00:00:00.000Z', currentState: true, summary: 'now' }),
  ], { from: FROM, to: TO });
  assert.equal(kept.length, 1);
});

test('withinWindow drops an event with an unparseable timestamp', () => {
  assert.deepEqual(withinWindow([ev({ timestamp: 'nonsense' })], { from: FROM, to: TO }), []);
});

// ----------------------------------------------------------------- ordering
test('compareEvents orders newest-first, with severity breaking a tie', () => {
  const sorted = [
    ev({ timestamp: '2026-07-28T08:00:00.000Z', summary: 'older' }),
    ev({ timestamp: '2026-07-28T10:00:00.000Z', severity: 'INFO', summary: 'tie-info' }),
    ev({ timestamp: '2026-07-28T10:00:00.000Z', severity: 'CRIT', summary: 'tie-crit' }),
  ].sort(compareEvents);
  // Same second: the CRIT must not hide under the INFO.
  assert.deepEqual(sorted.map((e) => e.summary), ['tie-crit', 'tie-info', 'older']);
});

// ------------------------------------------------------------------- assembly
test('buildChangeFeed groups by severity in a fixed order and reports the reference window', () => {
  const feed = buildChangeFeed([
    ev({ severity: 'INFO', summary: 'i' }),
    ev({ severity: 'CRIT', summary: 'c' }),
    ev({ severity: 'WARN', summary: 'w' }),
  ], { from: FROM, to: TO });

  assert.deepEqual(feed.groups.map((g) => g.severity), ['CRIT', 'WARN', 'INFO']);
  assert.equal(feed.since, FROM);
  assert.equal(feed.until, TO);
  assert.equal(feed.total, 3);
});

test('buildChangeFeed omits an empty severity group rather than showing a heading with nothing under it', () => {
  const feed = buildChangeFeed([ev({ severity: 'WARN' })], { from: FROM, to: TO });
  assert.deepEqual(feed.groups.map((g) => g.severity), ['WARN']);
});

test('an empty window still reports the reference times', () => {
  // "Nothing changed since 06:00" is the answer; the timestamp is the half that
  // makes it meaningful. A blank page is not an answer.
  const feed = buildChangeFeed([], { from: FROM, to: TO });
  assert.deepEqual(feed.events, []);
  assert.deepEqual(feed.groups, []);
  assert.equal(feed.total, 0);
  assert.equal(feed.since, FROM);
  assert.equal(feed.until, TO);
  assert.equal(feed.truncated, false);
});

test('the cap keeps the newest/most severe and reports what it dropped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ev({
    timestamp: new Date(Date.parse(FROM) + i * 60000).toISOString(),
    summary: `e${i}`,
  }));
  const feed = buildChangeFeed(many, { from: FROM, to: TO, limit: 3 });

  assert.equal(feed.returned, 3);
  assert.equal(feed.total, 10);
  assert.equal(feed.truncated, true);
  // Newest-first, so the cap drops the oldest — never a silent middle slice.
  assert.deepEqual(feed.events.map((e) => e.summary), ['e9', 'e8', 'e7']);
});

test('offset pages through without losing the total', () => {
  const many = Array.from({ length: 10 }, (_, i) => ev({
    timestamp: new Date(Date.parse(FROM) + i * 60000).toISOString(),
    summary: `e${i}`,
  }));
  const page2 = buildChangeFeed(many, { from: FROM, to: TO, limit: 3, offset: 3 });
  assert.deepEqual(page2.events.map((e) => e.summary), ['e6', 'e5', 'e4']);
  assert.equal(page2.total, 10);
  assert.equal(page2.offset, 3);
});
