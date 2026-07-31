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
  fromProbeEvents,
  fromEvents,
  rollUpFindings,
  collapseRecurring,
  correlateEvents,
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
  // Probe events say warning/critical; findings say WARN/CRIT.
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

test('fromProbeEvents emits BOTH the open and the resolve when each falls in the window', () => {
  // "The link came back" matters to a handover exactly as much as "it went down".
  const events = fromProbeEvents([{
    id: 5, agentId: 7, metric: 'reachability', severity: 'critical',
    affectedTarget: '8.8.8.8',
    startedAt: '2026-07-28T07:00:00.000Z',
    resolvedAt: '2026-07-28T07:30:00.000Z',
  }], { from: FROM, to: TO, nameFor });

  assert.equal(events.length, 2);
  // Source/kind is `probe`, not `event`: this is the active-probe outage
  // record, NOT the operator-facing event, and the two used to collide on one
  // label. See docs/events.md.
  assert.ok(events.every((e) => e.kind === 'probe' && e.source === 'probe'));
  assert.match(events[0].type, /degraded$/);
  assert.equal(events[0].severity, 'CRIT');
  assert.match(events[1].type, /recovered$/);
  assert.equal(events[1].severity, 'INFO', 'a recovery must not stay red');
  assert.match(events[1].summary, /recovered/);
});

test('fromProbeEvents omits a transition that fell outside the window', () => {
  // An event that opened before the window and is still open contributes
  // nothing: nothing about it CHANGED while the user was away.
  const events = fromProbeEvents([{
    id: 5, agentId: 7, metric: 'latency', severity: 'warning', affectedTarget: 'x',
    startedAt: '2026-07-01T00:00:00.000Z',
    resolvedAt: null,
  }], { from: FROM, to: TO, nameFor });
  assert.deepEqual(events, []);
});

test('fromProbeEvents emits only the resolve when the open predates the window', () => {
  const events = fromProbeEvents([{
    id: 5, agentId: 7, metric: 'latency', severity: 'warning', affectedTarget: 'x',
    startedAt: '2026-07-01T00:00:00.000Z',
    resolvedAt: '2026-07-28T08:00:00.000Z',
  }], { from: FROM, to: TO, nameFor });
  assert.equal(events.length, 1);
  assert.match(events[0].type, /recovered$/);
});

test('fromFindings, fromEvents, fromTopologyChanges and fromConfigSnapshots produce the shared event shape', () => {
  const sets = [
    fromFindings([{ id: 'f1', hostId: '7', metric: 'iface.errors', severity: 'WARN', createdAt: TO }], { nameFor }),
    fromEvents([{ id: 3, hostId: '7', title: 'Loss on agent-7', status: 'open', severity: 'CRIT', firstEventAt: TO, lastEventAt: TO }]),
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
  for (const fn of [fromAgentEvents, fromFindings, fromEvents, fromTopologyChanges, fromPlaybookRuns, fromConfigSnapshots]) {
    assert.deepEqual(fn(null), []);
    assert.deepEqual(fn([]), []);
  }
  assert.deepEqual(fromProbeEvents(null, { from: FROM, to: TO }), []);
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
  // Distinct `type` per row: this test is about the cap, and identical rows would
  // (correctly) be folded into one by the correlation step first.
  const many = Array.from({ length: 10 }, (_, i) => ev({
    timestamp: new Date(Date.parse(FROM) + i * 60000).toISOString(),
    type: `t${i}`,
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
    type: `t${i}`,
    summary: `e${i}`,
  }));
  const page2 = buildChangeFeed(many, { from: FROM, to: TO, limit: 3, offset: 3 });
  assert.deepEqual(page2.events.map((e) => e.summary), ['e6', 'e5', 'e4']);
  assert.equal(page2.total, 10);
  assert.equal(page2.offset, 3);
});

// ---------------------------------------------------------------- correlation
// The feed's whole point is answering "what happened", and a page listing every
// raw occurrence does not answer it. Two reductions run before ordering: an
// anomaly already represented by an event is folded INTO that event, and repeats
// of one condition become one row carrying a count.

const findingEv = (over) => makeEvent({
  timestamp: TO, source: 'finding', type: 'finding.probe.latency', severity: 'CRIT',
  summary: 'probe.latency on agent-7', kind: 'finding', agentId: 7, metric: 'probe.latency', ...over,
});
const eventEv = (over) => makeEvent({
  timestamp: TO, source: 'event', type: 'event.open', severity: 'CRIT',
  summary: 'CRIT probe.latency on core-sw', kind: 'event', agentId: 7, metric: 'probe.latency', ...over,
});

test('rollUpFindings folds an anomaly into the event that already represents it', () => {
  // This is the double-count that made the page read as twice as busy as reality:
  // the event exists PRECISELY to stand for these anomalies.
  const rows = rollUpFindings([
    eventEv({ refId: 3 }),
    findingEv({ refId: 'f1', caseId: 3 }),
    findingEv({ refId: 'f2', caseId: 3 }),
  ]);
  assert.equal(rows.length, 1, 'one event, not an event plus its own anomalies');
  assert.equal(rows[0].kind, 'event');
  assert.equal(rows[0].findingCount, 2, 'and it says how many it absorbed');
});

test('rollUpFindings keeps an anomaly whose event is NOT on this feed', () => {
  // Its event fell outside the window (or it has none yet). This row is the only
  // thing that would report it, so dropping it would lose the detection.
  const rows = rollUpFindings([findingEv({ refId: 'f1', caseId: 99 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'finding');
});

test('rollUpFindings also matches on the primary finding, not just the FK', () => {
  // The case is created FROM the finding, so findings.event_case_id can still
  // be unwritten on the very first anomaly. primary_finding_id catches that race.
  const rows = rollUpFindings([
    { ...eventEv({ refId: 3 }), primaryFindingId: 'f1' },
    findingEv({ refId: 'f1', caseId: null }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'event');
});

test('collapseRecurring folds repeats of one condition into a single counted row', () => {
  // Seven separate rows only IMPLY "this keeps coming back". One row saying
  // "7× since 07:15" states it.
  const times = ['07:15', '07:32', '07:44', '09:11', '10:15', '11:01', '11:16']
    .map((hm) => `2026-07-28T${hm}:00.000Z`);
  const rows = collapseRecurring(times.map((ts, i) => eventEv({ timestamp: ts, refId: 100 + i })));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 7);
  assert.equal(rows[0].timestamp, times[6], 'the row carries the LATEST activity');
  assert.equal(rows[0].firstAt, times[0], 'and the span it happened over');
  assert.equal(rows[0].refIds.length, 7, 'every folded record stays drillable');
  assert.equal(rows[0].ref_id, 106, 'the newest occurrence is what the row opens');
});

test('collapseRecurring never folds across device, condition, severity or direction', () => {
  const rows = collapseRecurring([
    eventEv({ agentId: 7 }),
    eventEv({ agentId: 8 }),                                    // other device
    eventEv({ metric: 'if.errors', type: 'event.open' }),        // other condition
    eventEv({ severity: 'WARN' }),                               // an escalation
    eventEv({ type: 'event.resolved' }),                         // opposite direction
  ]);
  assert.equal(rows.length, 5, 'five genuinely different statements, five rows');
  assert.ok(rows.every((r) => r.count === 1));
});

test('an agent going offline and coming back are never folded together', () => {
  const rows = collapseRecurring([
    makeEvent({ timestamp: FROM, source: 'agent', type: 'agent.offline', severity: 'WARN', summary: 'a went offline', kind: 'agent_state', agentId: 7 }),
    makeEvent({ timestamp: TO, source: 'agent', type: 'agent.online', severity: 'INFO', summary: 'a went online', kind: 'agent_state', agentId: 7 }),
  ]);
  assert.equal(rows.length, 2);
});

test('collapseRecurring leaves distinct artifacts alone', () => {
  // Three config pushes are three pushes. Folding them would hide two changes
  // behind one row — the opposite of what this page is for.
  const pushes = [1, 2, 3].map((id) => makeEvent({
    timestamp: TO, source: 'config', type: 'config.agent_poll', severity: 'INFO',
    summary: 'Configuration captured on device 7', kind: 'config', refId: id, agentId: 7,
  }));
  assert.equal(collapseRecurring(pushes).length, 3);
});

test('currentState rows are never folded', () => {
  const rows = collapseRecurring([
    makeEvent({ timestamp: TO, source: 'agent', type: 'agent.version_skew', severity: 'INFO', summary: 'a', kind: 'agent_health', agentId: 7, currentState: true }),
    makeEvent({ timestamp: TO, source: 'agent', type: 'agent.version_skew', severity: 'INFO', summary: 'b', kind: 'agent_health', agentId: 8, currentState: true }),
  ]);
  assert.equal(rows.length, 2);
});

test('buildChangeFeed correlates before capping, and reports what it folded', () => {
  // Correlating first is what stops one flapping condition from spending the whole
  // cap and pushing every other condition off the page.
  const noisy = Array.from({ length: 20 }, (_, i) => eventEv({
    timestamp: new Date(Date.parse(FROM) + i * 60000).toISOString(), refId: 200 + i,
  }));
  const other = makeEvent({
    timestamp: FROM, source: 'interface', type: 'interface.down', severity: 'WARN',
    summary: 'eth1 down on agent-9', kind: 'interface_state', agentId: 9, metric: 'interface',
  });
  const feed = buildChangeFeed([...noisy, other], { from: FROM, to: TO, limit: 5 });

  assert.equal(feed.total, 2, 'twenty-one occurrences describe two conditions');
  assert.equal(feed.rawTotal, 21);
  assert.equal(feed.correlated, 19, 'and the page can say so instead of just looking quiet');
  assert.equal(feed.truncated, false);
  assert.ok(feed.events.some((e) => e.kind === 'interface_state'), 'the quiet condition survived the noisy one');
});

test('buildChangeFeed with correlate:false returns the raw stream', () => {
  // An export or an audit wants every occurrence, not the summary.
  const many = Array.from({ length: 4 }, (_, i) => eventEv({ refId: 300 + i }));
  const feed = buildChangeFeed(many, { from: FROM, to: TO, correlate: false });
  assert.equal(feed.total, 4);
  assert.equal(feed.correlated, 0);
});

test('the feed never leaks its roll-up plumbing to the client', () => {
  const feed = buildChangeFeed([findingEv({ refId: 'f1', caseId: 3 })], { from: FROM, to: TO });
  assert.ok(!('caseId' in feed.events[0]), 'caseId is internal to the roll-up');
  assert.ok(!('primaryFindingId' in feed.events[0]));
});

test('fromEvents timestamps an event by its latest activity but keeps its start', () => {
  // A still-escalating event must sort by when it last did something; losing the
  // start would cost the reader the one thing that says "this has run for hours".
  const [e] = fromEvents([{
    id: 3, hostId: '7', title: 'CRIT probe.latency on core-sw', status: 'open', severity: 'CRIT',
    firstEventAt: '2026-07-28T07:15:00.000Z', lastEventAt: '2026-07-28T11:16:00.000Z',
    primaryMetric: 'probe.latency',
  }]);
  assert.equal(e.timestamp, '2026-07-28T11:16:00.000Z');
  assert.equal(e.firstAt, '2026-07-28T07:15:00.000Z');
  assert.equal(e.metric, 'probe.latency');
  assert.equal(e.family, 'latency', 'which is what the UI turns into "what this indicates"');
});

test('an event whose primary finding is gone still renders, just without an interpretation', () => {
  const [e] = fromEvents([{ id: 4, hostId: '7', title: 't', status: 'open', severity: 'WARN', firstEventAt: TO, lastEventAt: TO }]);
  assert.equal(e.metric, null);
  assert.equal(e.family, null, 'a family we cannot determine is null, never guessed');
});

test('correlateEvents rolls up before it collapses', () => {
  // Order matters: collapsing first would fold the anomalies into one anomaly row
  // that then survives beside its own event.
  const rows = correlateEvents([
    eventEv({ refId: 3, timestamp: '2026-07-28T07:00:00.000Z' }),
    eventEv({ refId: 4, timestamp: '2026-07-28T08:00:00.000Z' }),
    findingEv({ refId: 'f1', caseId: 3 }),
    findingEv({ refId: 'f2', caseId: 4 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2, 'two events for one recurring condition');
  assert.equal(rows[0].findingCount, 2, 'carrying both anomalies');
});
