'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// GET /system/self — the one screen about the monitoring system rather than
// about the network it monitors.
//
// The rule it exists for: THREE states, never two. A two-state version has to
// put "could not read" somewhere, and wherever it puts it is a lie — filed as
// healthy, a dead probe reads as a working system; filed as failing, a feature
// nobody switched on pages somebody at 3am.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildSelfHealth, worst } = require('../src/system/selfHealth');
const { makeApp, authHeader, makeAgentsRepo } = require('../test-support/fakes');

// ---- the rules, directly ---------------------------------------------------

test('unknown is never rounded down to ok', () => {
  // "Eight ok, three unknown" is not a healthy system. It is a system we can
  // only partly see, and the overall state has to say so — otherwise the
  // screen is green while three of its eleven signals were never read.
  assert.equal(worst(['ok', 'ok', 'unknown']), 'unknown');
  assert.equal(worst(['ok', 'ok', 'ok']), 'ok');
  // …and a real fault outranks a blind spot: one dead probe must not downgrade
  // a known failure into "we're not sure".
  assert.equal(worst(['unknown', 'failing', 'ok']), 'failing');
  assert.equal(worst([]), 'ok');
});

test('a probe that throws is unknown, not failing, and says why', async () => {
  const out = await buildSelfHealth({
    probes: { database: async () => { throw new Error('connection refused'); } },
  });
  const db = out.signals.find((s) => s.id === 'database');
  assert.equal(db.state, 'unknown');
  assert.equal(db.reason, 'probe_failed');
  assert.match(db.detail, /connection refused/);
  // A probe that fails is a thing we could not measure. Calling it a failure
  // would make an unreachable optional subsystem look like an outage.
  assert.equal(out.state, 'unknown');
});

test('a signal with no probe says it is not wired, and an optional one says it is off', async () => {
  const out = await buildSelfHealth({ probes: {} });
  const db = out.signals.find((s) => s.id === 'database');
  const tsdb = out.signals.find((s) => s.id === 'telemetry');
  assert.equal(db.state, 'unknown');
  assert.equal(db.reason, 'not_wired');
  assert.equal(tsdb.reason, 'not_enabled', 'a feature nobody switched on is not a fault');
  // Every signal is reported, always: a screen that drops the ones it cannot
  // read is a screen that gets shorter as things get worse.
  assert.equal(out.signals.length, 11);
});

test('every probe runs even when the first one fails', async () => {
  const ran = [];
  const out = await buildSelfHealth({
    probes: {
      database: async () => { ran.push('database'); throw new Error('down'); },
      license: async () => { ran.push('license'); return { state: 'ok' }; },
      storage: async () => { ran.push('storage'); return { state: 'failing' }; },
    },
  });
  assert.deepEqual(ran.sort(), ['database', 'license', 'storage']);
  assert.equal(out.state, 'failing');
  assert.deepEqual(out.counts, { ok: 1, failing: 1, unknown: 9 });
});

test('a probe that answers nonsense is unknown rather than trusted', async () => {
  const out = await buildSelfHealth({ probes: { database: async () => ({ state: 'fine' }) } });
  const db = out.signals.find((s) => s.id === 'database');
  assert.equal(db.state, 'unknown');
  assert.equal(db.reason, 'bad_probe');
});

// ---- the endpoint ----------------------------------------------------------

const AGENTS = [
  { id: 1, hostname: 'a1', status: 'online' },
  { id: 2, hostname: 'a2', status: 'offline' },
];

test('GET /system/self is viewer+, and never 500s because something is down', async () => {
  const app = makeApp({
    db: { ping: async () => { throw new Error('db is gone'); } },
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }),
  });
  const res = await request(app).get('/system/self').set('Authorization', authHeader('viewer'));
  // The one thing this route must never do is fail when something is unhealthy.
  assert.equal(res.status, 200);
  assert.ok(['failing', 'unknown'].includes(res.body.state), res.body.state);
  const db = res.body.signals.find((s) => s.id === 'database');
  assert.equal(db.state, 'unknown');
  assert.match(db.detail, /db is gone/);
});

test('an anonymous caller gets 401', async () => {
  const res = await request(makeApp({})).get('/system/self');
  assert.equal(res.status, 401);
});

test('agents that are not reporting are a failure, and none at all is unknown', async () => {
  const some = await request(makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }) }))
    .get('/system/self').set('Authorization', authHeader('admin'));
  const agents = some.body.signals.find((s) => s.id === 'agents');
  assert.equal(agents.state, 'failing');
  assert.match(agents.detail, /1 of 2 agents are not reporting/);
  assert.match(agents.detail, /unknown rather than healthy/);

  // A monitoring system with nothing reporting is not healthy — it is blind.
  const none = await request(makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => [] }) }))
    .get('/system/self').set('Authorization', authHeader('admin'));
  const empty = none.body.signals.find((s) => s.id === 'agents');
  assert.equal(empty.state, 'unknown');
  assert.equal(empty.reason, 'no_agents');
});

test('a key that is stored but cannot sign is a failure, not a warning', async () => {
  // Every privileged command is then REFUSED (fail closed), which from the
  // other end looks like "nothing happens when I press Update".
  const { makeReleaseKeyService } = require('../test-support/fakes');
  const app = makeApp({
    releaseKeyService: makeReleaseKeyService({ signBlockedReason: () => 'undecryptable' }),
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }),
  });
  const res = await request(app).get('/system/self').set('Authorization', authHeader('admin'));
  const signing = res.body.signals.find((s) => s.id === 'signing');
  assert.equal(signing.state, 'failing');
  assert.equal(signing.reason, 'release_undecryptable');
});

test('a server signing commands with its release key reports that, and it is OK', async () => {
  // The normal state, and the screen must not call it a gap.
  const res = await request(makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => [AGENTS[0]] }) }))
    .get('/system/self').set('Authorization', authHeader('admin'));
  const signing = res.body.signals.find((s) => s.id === 'signing');
  assert.equal(signing.state, 'ok');
  assert.equal(signing.reason, 'signing_shared');
  assert.match(signing.detail, /signed with the release key/);
});

test('a missing disk reading is unknown, never 0% full', async () => {
  // Number(null) is 0, and 0% full is the healthiest possible disk — on the one
  // screen whose job is to refuse exactly that.
  const app = makeApp({
    systemInfo: { getStorage: async () => ({ disk: { usedPercent: null }, database: {}, tsdb: null }) },
    agentsRepo: makeAgentsRepo({ findAll: async () => [AGENTS[0]] }),
  });
  const res = await request(app).get('/system/self').set('Authorization', authHeader('admin'));
  const storage = res.body.signals.find((s) => s.id === 'storage');
  assert.equal(storage.state, 'unknown');
  assert.equal(storage.reason, 'unreadable');
});

test('a full disk is a failure, and the viewer form carries no paths', async () => {
  const app = makeApp({
    systemInfo: { getStorage: async () => ({ disk: { usedPercent: 97, path: '/var/lib/blueeye' }, database: { name: 'blueeye' }, tsdb: null }) },
    agentsRepo: makeAgentsRepo({ findAll: async () => [AGENTS[0]] }),
  });
  const admin = await request(app).get('/system/self').set('Authorization', authHeader('admin'));
  const adminStorage = admin.body.signals.find((s) => s.id === 'storage');
  assert.equal(adminStorage.state, 'failing');
  assert.match(adminStorage.detail, /97% full/);
  assert.equal(adminStorage.storage.disk.path, '/var/lib/blueeye');

  const viewer = await request(app).get('/system/self').set('Authorization', authHeader('viewer'));
  const viewerStorage = viewer.body.signals.find((s) => s.id === 'storage');
  assert.equal(viewerStorage.state, 'failing', 'a viewer sees the state');
  assert.equal(viewerStorage.storage.disk.path, null, 'but not where the disk is');
  assert.equal(viewerStorage.storage.database.name, null);
});

// --- background jobs: a failed TICK, not just a failed start ----------------

const jobsApp = (jobs) => makeApp({
  agentsRepo: makeAgentsRepo({ findAll: async () => [AGENTS[0]] }),
  backgroundJobs: () => jobs,
});
const jobSignal = async (jobs) => {
  const res = await request(jobsApp(jobs)).get('/system/self').set('Authorization', authHeader('admin'));
  return res.body.signals.find((s) => s.id === 'backgroundJobs');
};

test('a job that did not start outranks one whose tick failed', async () => {
  // They need different answers. A job that never started is not running at
  // all; a job whose tick failed is running and failing. The first is worse.
  const sig = await jobSignal([
    { name: 'reports', startedAt: null, startError: 'cron expression is nonsense', lastError: null, errors: 0 },
    { name: 'retention', startedAt: 'x', startError: null, lastError: 'table is locked', lastErrorAt: 'y', errors: 3 },
  ]);
  assert.equal(sig.state, 'failing');
  assert.equal(sig.reason, 'start_failed');
  assert.match(sig.detail, /not happening at all/);
  assert.match(sig.detail, /reports/);
});

test('a failed tick is a failure, with the job named and the message kept', async () => {
  const sig = await jobSignal([
    { name: 'retention', startedAt: 'x', startError: null, lastError: 'table is locked', lastErrorAt: 'y', errors: 3 },
    { name: 'verification', startedAt: 'x', startError: null, lastError: null, errors: 0 },
  ]);
  assert.equal(sig.state, 'failing');
  assert.equal(sig.reason, 'tick_failed');
  assert.match(sig.detail, /1 of 2/);
  assert.equal(sig.jobs[0].name, 'retention');
  assert.equal(sig.jobs[0].count, 3);
  assert.match(sig.jobs[0].error, /table is locked/);
});

test('no errors is reported as no errors, never as "running"', async () => {
  // Success is silent in these jobs, so a job ticking quietly looks exactly
  // like one whose timer died. The wording has to stay inside what is known —
  // this screen refuses to claim more than it measured.
  const sig = await jobSignal([
    { name: 'retention', startedAt: 'x', startError: null, lastError: null, errors: 0 },
  ]);
  assert.equal(sig.state, 'ok');
  assert.equal(sig.reason, 'no_errors');
  // It must not CLAIM they are running — only that nothing reported a failure.
  assert.doesNotMatch(sig.detail, /(are|all|still) running/i);
  assert.match(sig.detail, /none has reported a failed run/);
  assert.match(sig.detail, /no errors, not "running"/, 'the limit of what is known has to be on the screen, not only in the code');
});

test('nothing started yet is unknown, not ok', async () => {
  const sig = await jobSignal([]);
  assert.equal(sig.state, 'unknown');
  assert.equal(sig.reason, 'not_started');
});
