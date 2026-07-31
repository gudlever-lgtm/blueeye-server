'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEventCaseService } = require('../src/eventCases/eventCaseService');
const { EVENT_ACTIVITY_WINDOW_MS } = require('../src/eventCases/activityWindow');
const { makeEventCasesRepo, makeFindingStore, makeAgentsRepo } = require('../test-support/fakes');

// Exercises the auto-create/grouping policy against the in-memory fakes (same
// surface as the real repo + finding store). The window is
// EVENT_ACTIVITY_WINDOW_MS — the same span after which autoResolveJob calls the
// condition finished.
const T0 = new Date('2026-06-01T08:00:00Z');
const at = (secs) => new Date(T0.getTime() + secs * 1000);
const WINDOW_S = EVENT_ACTIVITY_WINDOW_MS / 1000;

function finding(over = {}) {
  return { id: 'f1', hostId: 'core-sw', metric: 'cpu', severity: 'WARN', createdAt: T0, ...over };
}

function svcWith() {
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const svc = createEventCaseService({ eventCasesRepo, findingStore });
  return { svc, eventCasesRepo, findingStore };
}

test('two anomalies on the same device WITHIN the window group into ONE event', async () => {
  const { svc, eventCasesRepo } = svcWith();
  const r1 = await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(30) })); // +30s < 60s

  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.eventCaseId, r2.eventCaseId);
  assert.equal(eventCasesRepo.rows.length, 1);
});

test('two anomalies on the same device OUTSIDE the window make TWO events', async () => {
  const { svc, eventCasesRepo } = svcWith();
  const r1 = await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(WINDOW_S + 60) }));

  assert.equal(r1.created, true);
  assert.equal(r2.created, true);
  assert.notEqual(r1.eventCaseId, r2.eventCaseId);
  assert.equal(eventCasesRepo.rows.length, 2);
});

// The regression this window exists for. Probes report on a cadence of MINUTES,
// so with the old 60 s window every recurring breach opened a fresh event while
// the previous one was still open — the Events tab became a wall of duplicates
// for one device. Anything inside the window is the same condition, still going.
test('a probe breaching every few minutes stays ONE event, not one per breach', async () => {
  const { svc, eventCasesRepo } = svcWith();
  const first = await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  // 2 min, then 6 min, then 4 min later — the gaps in the reported screenshot.
  const later = [120, 480, 720];
  for (let i = 0; i < later.length; i += 1) {
    const r = await svc.assignFinding(finding({ id: `f${i}`, createdAt: at(later[i]) }));
    assert.equal(r.created, false, `breach at +${later[i]}s opened a second event`);
    assert.equal(r.eventCaseId, first.eventCaseId);
  }
  assert.equal(eventCasesRepo.rows.length, 1);
});

// Recurrence keeps the event alive: each breach advances last_event_at, so a
// condition firing steadily never ages out mid-run even though the total span
// far exceeds one window.
test('recurrence extends the event — a long run of breaches is still ONE event', async () => {
  const { svc, eventCasesRepo } = svcWith();
  const step = WINDOW_S - 60; // just inside the window, repeatedly
  for (let i = 0; i <= 6; i += 1) {
    await svc.assignFinding(finding({ id: `f${i}`, createdAt: at(i * step) }));
  }
  assert.equal(eventCasesRepo.rows.length, 1);
  assert.ok(6 * step > WINDOW_S * 2, 'the run must span more than one window to be meaningful');
});

test('a finding exactly at the window boundary still groups (<=)', async () => {
  const { svc, eventCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(WINDOW_S) }));
  assert.equal(r2.created, false);
  assert.equal(eventCasesRepo.rows.length, 1);
});

test('anomalies on DIFFERENT devices never group together', async () => {
  const { svc, eventCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', hostId: 'sw-1', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', hostId: 'sw-2', createdAt: at(10) }));
  assert.equal(eventCasesRepo.rows.length, 2);
});

test('the sliding window extends as new anomalies keep arriving', async () => {
  const { svc, eventCasesRepo } = svcWith();
  // Each finding is within 60s of the PREVIOUS one, so the event keeps growing
  // even though the last is 135s after the first.
  await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', createdAt: at(45) }));
  await svc.assignFinding(finding({ id: 'c', createdAt: at(90) }));
  const r = await svc.assignFinding(finding({ id: 'd', createdAt: at(135) }));
  assert.equal(r.created, false);
  assert.equal(eventCasesRepo.rows.length, 1);
  assert.equal(new Date(eventCasesRepo.rows[0].last_event_at).getTime(), at(135).getTime());
});

test('grouping escalates severity (WARN -> CRIT) but never downgrades', async () => {
  const { svc, eventCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', severity: 'WARN', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', severity: 'CRIT', createdAt: at(20) }));
  assert.equal(eventCasesRepo.rows[0].severity, 'CRIT');
  await svc.assignFinding(finding({ id: 'c', severity: 'INFO', createdAt: at(40) }));
  assert.equal(eventCasesRepo.rows[0].severity, 'CRIT'); // not downgraded
});

test('a new event is opened as system/open with the finding as primary + a title, and the finding is linked', async () => {
  const { svc, eventCasesRepo, findingStore } = svcWith();
  const f = finding({ id: 'a', metric: 'interface_errors', severity: 'CRIT', createdAt: at(0) });
  await findingStore.save(f); // so the link is observable on the store
  const r = await svc.assignFinding(f);

  const row = eventCasesRepo.rows[0];
  assert.equal(row.status, 'open');
  assert.equal(row.created_by, 'system');
  assert.equal(row.primary_finding_id, 'a');
  assert.equal(row.severity, 'CRIT');
  assert.match(row.title, /interface_errors/);
  assert.match(row.title, /core-sw/);
  assert.equal(new Date(row.first_event_at).getTime(), at(0).getTime());
  assert.equal(findingStore.rows.find((x) => x.id === 'a').eventCaseId, r.eventCaseId);
});

// --- The auto-generated title names WHERE the event is -------------------
// "WARN probe.latency on 1" cannot be acted on: it names neither the machine nor
// the site. With an agents repo wired, the title carries both.
function svcWithAgent(agent) {
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const agentsRepo = makeAgentsRepo({ findById: async (id) => (Number(id) === 14 ? agent : null) });
  return { svc: createEventCaseService({ eventCasesRepo, findingStore, agentsRepo }), eventCasesRepo };
}

test('the title names the agent and its location instead of the bare agent id', async () => {
  const { svc, eventCasesRepo } = svcWithAgent({ display_name: 'core-sw', hostname: 'sw01', location_name: 'Copenhagen HQ' });
  await svc.assignFinding(finding({ id: 'a', hostId: '14', metric: 'probe.latency', createdAt: at(0) }));
  assert.equal(eventCasesRepo.rows[0].title, 'WARN probe.latency on core-sw (Copenhagen HQ)');
});

test('an agent with no location set still gets a named title', async () => {
  const { svc, eventCasesRepo } = svcWithAgent({ hostname: 'sw01', location_name: null });
  await svc.assignFinding(finding({ id: 'a', hostId: '14', metric: 'probe.latency', createdAt: at(0) }));
  assert.equal(eventCasesRepo.rows[0].title, 'WARN probe.latency on sw01');
});

test('an unknown host falls back to the id — and a failing lookup never blocks the event', async () => {
  const { svc, eventCasesRepo } = svcWithAgent({ hostname: 'sw01' });
  await svc.assignFinding(finding({ id: 'a', hostId: '99', metric: 'cpu', createdAt: at(0) }));
  assert.equal(eventCasesRepo.rows[0].title, 'WARN cpu on device 99');

  const eventCasesRepo2 = makeEventCasesRepo();
  const svc2 = createEventCaseService({
    eventCasesRepo: eventCasesRepo2,
    findingStore: makeFindingStore(),
    agentsRepo: makeAgentsRepo({ findById: async () => { throw new Error('db down'); } }),
  });
  const r = await svc2.assignFinding(finding({ id: 'a', hostId: '14', createdAt: at(0) }));
  assert.equal(r.created, true);
  assert.equal(eventCasesRepo2.rows[0].title, 'WARN cpu on device 14');
});

test('assignFinding is a no-op (returns null) for a finding with no id or no host', async () => {
  const { svc, eventCasesRepo } = svcWith();
  assert.equal(await svc.assignFinding({ hostId: 'x', createdAt: at(0) }), null);
  assert.equal(await svc.assignFinding({ id: 'x', createdAt: at(0) }), null);
  assert.equal(eventCasesRepo.rows.length, 0);
});

test('a repository failure is swallowed (never breaks ingestion)', async () => {
  const eventCasesRepo = makeEventCasesRepo({ findOpenByHost: async () => { throw new Error('db down'); } });
  const findingStore = makeFindingStore();
  const svc = createEventCaseService({ eventCasesRepo, findingStore });
  assert.equal(await svc.assignFinding(finding({ id: 'a' })), null);
});

// The two windows are one judgement — "is this condition still going?" — and
// when they disagreed there was a dead zone: for the 14 minutes between the old
// 60 s grouping window and the 15 min auto-resolve window, an event was still
// OPEN but a new anomaly refused to join it and opened a SECOND open event on
// the same device. Nothing but this assertion keeps them from drifting apart
// again.
test('grouping and auto-resolve read the SAME window (no dead zone)', () => {
  const { createEventAutoResolveJob } = require('../src/eventCases/autoResolveJob');
  let listedOlderThan = null;
  const job = createEventAutoResolveJob({
    eventCasesRepo: {
      listStaleInvestigating: async (olderThan) => { listedOlderThan = olderThan; return []; },
    },
    now: () => T0.getTime(),
  });
  return job.runOnce().then(() => {
    const inactivityMs = T0.getTime() - listedOlderThan.getTime();
    assert.equal(inactivityMs, EVENT_ACTIVITY_WINDOW_MS,
      'auto-resolve must wait exactly as long as grouping will still absorb a new anomaly');
  });
});
