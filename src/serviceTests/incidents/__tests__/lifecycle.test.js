'use strict';

// The incident lifecycle and its timeline (V3 Phase 1).
//
// The assertions that matter most are about honesty under uncertainty: an
// unknown impact is reported as unknown, an unknown timestamp is admitted rather
// than replaced with "now", and the number of affected users is never invented
// because BlueEyes watches journeys, not people.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS, ACTIVE, EVENT, IMPACT,
  canTransition, referenceFor, assessImpact, event, eventsFromRun, orderTimeline, durationOf,
} = require('../lifecycle');

// ----------------------------------------------------------------- states
test('the active set is what "not resolved" means, and it is more than open', () => {
  // Five V2 queries tested `status = 'open'`, which was the same thing while
  // open was the only active state. An incident somebody picked up must not
  // vanish from the dashboard it most needs to be on.
  assert.deepEqual(ACTIVE, ['open', 'investigating', 'identified']);
  assert.ok(!ACTIVE.includes(STATUS.RESOLVED));
  assert.ok(!ACTIVE.includes(STATUS.CLOSED));
});

test('an incident can go back from identified to investigating', () => {
  // Being wrong about a cause is ordinary. A lifecycle that cannot express "we
  // thought we knew, we were wrong" pushes people into closing and reopening,
  // which destroys the timeline.
  assert.equal(canTransition(STATUS.IDENTIFIED, STATUS.INVESTIGATING).ok, true);
});

test('a resolved incident can reopen — a fix that did not hold is the same incident', () => {
  // Forcing a new incident would hide the recurrence, which is the thing
  // recurrence detection exists to surface.
  assert.equal(canTransition(STATUS.RESOLVED, STATUS.OPEN).ok, true);
});

test('closed is the end, and says why', () => {
  const res = canTransition(STATUS.CLOSED, STATUS.OPEN);
  assert.equal(res.ok, false);
  assert.match(res.reason, /that is a new incident/);
});

test('a refused transition always explains itself', () => {
  // "Invalid transition" is a message nobody can act on.
  for (const [from, to] of [[STATUS.OPEN, STATUS.CLOSED], [STATUS.OPEN, STATUS.OPEN], ['nonsense', STATUS.OPEN]]) {
    const res = canTransition(from, to);
    assert.equal(res.ok, false, `${from} → ${to}`);
    assert.ok(res.reason && res.reason.length > 10, `${from} → ${to} gave no usable reason`);
  }
});

// -------------------------------------------------------------- reference
test('the reference is derived from the id, so two workers cannot collide', () => {
  // A per-year counter is exactly what produces two incidents with the same
  // number the first time two workers open one at the same moment.
  assert.equal(referenceFor({ id: 124, opened_at: '2026-09-12T14:03:00Z' }), 'INC-2026-00124');
  assert.equal(referenceFor({ id: 7, opened_at: '2025-01-01T00:00:00Z' }), 'INC-2025-00007');
  assert.equal(referenceFor(null), null);
  assert.equal(referenceFor({}), null);
});

// ----------------------------------------------------------------- impact
test('impact follows the worst affected journey, not the severity', () => {
  // Severity is how bad the technical fault is; impact is what it costs. A CRIT
  // on a page nobody uses is not a high-impact incident, and conflating the two
  // is how alert fatigue starts.
  const critical = assessImpact({
    journeys: [{ name: 'Customer Search', criticality: 'critical' }, { name: 'Newsletter', criticality: 'low' }],
    severity: 'WARN',
  });
  assert.equal(critical.impact, IMPACT.CRITICAL);
  assert.match(critical.reason, /Customer Search/);

  const minor = assessImpact({
    journeys: [{ name: 'Newsletter', criticality: 'low' }],
    severity: 'CRIT',
  });
  assert.equal(minor.impact, IMPACT.LOW, 'a CRIT on a low-criticality journey is still low impact');
});

test('an unknown impact is reported as unknown, never as low', () => {
  // "No journey information" and "low impact" are different facts, and the spec
  // says an unknown one is never invented.
  const res = assessImpact({ journeys: [] });
  assert.equal(res.impact, null);
  assert.match(res.reason, /cannot be judged/);
});

test('the number of affected users is always "unknown"', () => {
  // BlueEyes watches journeys, not people. It has no way to know how many users
  // a broken journey cost, and a made-up number would be the least trustworthy
  // thing on the page.
  for (const input of [{ journeys: [{ name: 'Search', criticality: 'critical' }] }, { journeys: [] }]) {
    assert.equal(assessImpact(input).affected_users, 'unknown');
  }
});

// --------------------------------------------------------------- timeline
test('a failing run contributes events with the time THEY happened', () => {
  const at = new Date('2026-09-12T14:03:00Z');
  const events = eventsFromRun({
    run: { id: 5, test_name: 'Customer Search', error_message: 'No results appeared', failure_kind: 'api', ended_at: at },
    isNew: true,
  });
  assert.equal(events[0].kind, EVENT.OPENED);
  assert.equal(events[1].kind, EVENT.FAILURE);
  // Not "now". A timeline stamped with insert time is a timeline of the
  // database, not of the outage.
  for (const e of events) assert.equal(e.occurred_at.toISOString(), at.toISOString());
});

test('repetition is its own event — it is what turns a blip into an outage', () => {
  const events = eventsFromRun({
    run: { id: 6, test_name: 'Customer Search', ended_at: new Date() },
    isNew: false, occurrences: 23,
  });
  const repeated = events.find((e) => e.kind === EVENT.REPEATED);
  assert.ok(repeated, 'a timeline showing only the first failure hides what matters');
  assert.match(repeated.summary, /23 times/);
});

test('a correlation lands on the timeline with its confidence and its holes', () => {
  const events = eventsFromRun({
    run: { id: 7, test_name: 'Customer Search', ended_at: new Date() },
    correlation: {
      conclusion: 'Likely an application or API problem', confidence: 85,
      layer: 'api', ruled_out: ['network', 'server'], not_checked: ['infrastructure'],
    },
  });
  const correlated = events.find((e) => e.kind === EVENT.CORRELATED);
  assert.match(correlated.summary, /85% confident/);
  assert.equal(correlated.source, 'correlation');
  // What was NOT checked travels with it, so the timeline carries the same
  // caveat the correlation screen does.
  assert.deepEqual(correlated.detail.not_checked, ['infrastructure']);
});

test('events are ordered by when they happened, with the id breaking ties', () => {
  const ordered = orderTimeline([
    { id: 3, summary: 'third', occurred_at: new Date('2026-09-12T14:05:00Z') },
    { id: 1, summary: 'first', occurred_at: new Date('2026-09-12T14:03:00Z') },
    { id: 2, summary: 'second', occurred_at: new Date('2026-09-12T14:03:00Z') },
  ]);
  assert.deepEqual(ordered.map((e) => e.summary), ['first', 'second', 'third']);
});

test('an event with no time is kept and shown last, never dropped or guessed', () => {
  // A gap that is visible can be investigated. One that is hidden cannot, and a
  // guessed timestamp is worse than an admitted one.
  const ordered = orderTimeline([
    { id: 2, summary: 'untimed', occurred_at: null },
    { id: 1, summary: 'timed', occurred_at: new Date('2026-09-12T14:03:00Z') },
  ]);
  assert.deepEqual(ordered.map((e) => e.summary), ['timed', 'untimed']);
});

test('an event never invents a timestamp it was not given', () => {
  assert.equal(event(EVENT.NOTE, 'a note').occurred_at, null);
});

// --------------------------------------------------------------- duration
test('an open incident keeps counting; a resolved one stops', () => {
  const opened = new Date('2026-09-12T14:03:00Z');
  const now = new Date('2026-09-12T14:21:00Z');

  const live = durationOf({ opened_at: opened, status: STATUS.OPEN }, now);
  assert.equal(live.minutes, 18);
  assert.equal(live.ongoing, true);

  // Measured to when it resolved, and it must not keep growing afterwards.
  const done = durationOf({
    opened_at: opened, status: STATUS.RESOLVED, resolved_at: new Date('2026-09-12T14:12:00Z'),
  }, now);
  assert.equal(done.minutes, 9);
  assert.equal(done.ongoing, false);
});

test('an incident being investigated is still counting', () => {
  const live = durationOf({
    opened_at: new Date('2026-09-12T14:03:00Z'), status: STATUS.INVESTIGATING,
  }, new Date('2026-09-12T14:33:00Z'));
  assert.equal(live.ongoing, true, 'picking an incident up does not stop the clock');
});

// ------------------------------------------------------------ never throws
test('junk in, nothing invented out', () => {
  for (const junk of [null, undefined, 'nope', 42, [], {}]) {
    assert.doesNotThrow(() => assessImpact(junk), `assessImpact ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => eventsFromRun(junk), `eventsFromRun ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => orderTimeline(junk), `orderTimeline ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => durationOf(junk), `durationOf ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => referenceFor(junk), `referenceFor ${JSON.stringify(junk)}`);
  }
  assert.deepEqual(eventsFromRun(null), []);
  assert.deepEqual(orderTimeline(null), []);
  assert.equal(durationOf(null), null);
});
