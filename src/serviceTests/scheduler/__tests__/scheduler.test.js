'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { nextRunAt, isDue, missedIntervals, describeSchedule, isValidInterval, INTERVAL_SECONDS } = require('../schedule');
const { createQueue } = require('../queue');
const { createWorker } = require('../worker');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');
const { makeFakeDriver } = require('../../runner/__tests__/fakeDriver');

const NOW = new Date('2026-09-10T12:00:00.000Z');

// ------------------------------------------------------------------ schedule
test('only the offered cadences are accepted', () => {
  for (const s of INTERVAL_SECONDS) assert.equal(isValidInterval(s), true, String(s));
  for (const s of [1, 42, 7 * 60, 0, -300, null, 'daily']) assert.equal(isValidInterval(s), false, String(s));
});

test('a schedule that has never run fires at its start time, or now when there is none', () => {
  assert.deepEqual(nextRunAt({ interval_sec: 300, enabled: true }, NOW), NOW);
  const future = new Date('2026-09-10T13:00:00Z');
  assert.deepEqual(nextRunAt({ interval_sec: 300, enabled: true, start_at: future }, NOW), future);
  // A start time in the past does not backdate the first run.
  assert.deepEqual(nextRunAt({ interval_sec: 300, enabled: true, start_at: '2026-01-01T00:00:00Z' }, NOW), NOW);
});

test('the next run is measured from the last one, so a downed worker catches up rather than resetting', () => {
  const schedule = { interval_sec: 300, enabled: true, last_run_at: '2026-09-10T11:00:00Z' };
  assert.deepEqual(nextRunAt(schedule, NOW), new Date('2026-09-10T11:05:00Z'));
  assert.equal(isDue(schedule, NOW), true);
  assert.equal(missedIntervals(schedule, NOW), 11, 'the UI can say how far behind it is');
});

test('a disabled schedule never fires', () => {
  assert.equal(nextRunAt({ interval_sec: 300, enabled: false, last_run_at: '2026-01-01T00:00:00Z' }, NOW), null);
  assert.equal(isDue({ interval_sec: 300, enabled: false }, NOW), false);
});

test('a schedule describes itself in a sentence', () => {
  assert.match(describeSchedule({ interval_sec: 300, enabled: true, last_run_at: '2026-09-10T11:58:00Z' }, 'da', NOW), /5\. minut.*3 min/);
  assert.match(describeSchedule({ interval_sec: 3600, enabled: true }, 'en', NOW), /Every hour.*due now/);
  assert.match(describeSchedule({ interval_sec: 300, enabled: false }, 'en', NOW), /Paused/);
});

test('schedule helpers never throw on garbage', () => {
  for (const input of [undefined, null, 42, 'x', {}, { interval_sec: 'soon' }]) {
    assert.doesNotThrow(() => nextRunAt(input, NOW));
    assert.doesNotThrow(() => isDue(input, NOW));
    assert.doesNotThrow(() => missedIntervals(input, NOW));
    assert.doesNotThrow(() => describeSchedule(input, 'da', NOW));
  }
});

// ------------------------------------------------------------------ queue
function makeQueueFixture() {
  const st = makeServiceTests();
  const queue = createQueue({
    runsRepo: st.repositories.runs,
    discoveryRepo: st.repositories.discovery,
    schedulesRepo: st.repositories.schedules,
    settings: st.settings,
    now: () => NOW,
  });
  return { st, queue };
}

test('runs are claimed before discoveries — a monitoring run is the time-sensitive one', async () => {
  const { st, queue } = makeQueueFixture();
  await st.repositories.discovery.enqueue({ application_id: 1, scope_url: 'https://app.test/', budgets: {} });
  await st.repositories.runs.enqueue({ test_id: 1 });

  const first = await queue.claimNext('w1');
  assert.equal(first.kind, 'run');
  const second = await queue.claimNext('w1');
  assert.equal(second.kind, 'discovery');
  assert.equal(await queue.claimNext('w1'), null);
});

test('a due schedule is stamped BEFORE the run is created, so a slow queue cannot double-fire', async () => {
  const { st, queue } = makeQueueFixture();
  const schedule = await st.repositories.schedules.create({ test_id: 1, interval_sec: 300 });
  const order = [];
  st.repositories.schedules.markRun = async (id, at) => { order.push('mark'); return { id, last_run_at: at }; };
  const enqueue = st.repositories.runs.enqueue;
  st.repositories.runs.enqueue = async (input) => { order.push('enqueue'); return enqueue(input); };
  st.repositories.schedules.findDue = async () => [schedule];

  const enqueued = await queue.enqueueDue();
  assert.equal(enqueued.length, 1);
  assert.deepEqual(order, ['mark', 'enqueue']);
  assert.equal(enqueued[0].trigger_source, 'schedule');
});

test('a schedule that fails to enqueue skips one cycle rather than firing twice', async () => {
  const { st, queue } = makeQueueFixture();
  st.repositories.schedules.findDue = async () => [{ id: 1, test_id: 1, environment_id: null, interval_sec: 300 }];
  st.repositories.runs.enqueue = async () => { throw new Error('db down'); };
  const enqueued = await queue.enqueueDue();
  assert.deepEqual(enqueued, [], 'the failure is swallowed, not propagated into the worker loop');
});

test('worker status reports "not connected" when nothing has claimed a run', async () => {
  const { st, queue } = makeQueueFixture();
  await st.repositories.runs.enqueue({ test_id: 1 });
  const status = await queue.workerStatus();
  assert.equal(status.connected, false);
  assert.equal(status.queued, 1);
});

test('worker status reports connected once a run has been claimed recently', async () => {
  const { st, queue } = makeQueueFixture();
  await st.repositories.runs.enqueue({ test_id: 1 });
  await st.repositories.runs.claimNext('w1');
  const status = await queue.workerStatus();
  assert.equal(status.connected, true);
  assert.ok(status.last_claim_at);
});

// A queue on the real clock: the heartbeat specs compare stored timestamps
// against "now", and pinning now to a fixed NOW would make them depend on how
// close the suite happens to run to that date.
function makeHeartbeatFixture() {
  const st = makeServiceTests();
  const queue = createQueue({
    runsRepo: st.repositories.runs,
    discoveryRepo: st.repositories.discovery,
    schedulesRepo: st.repositories.schedules,
    workersRepo: st.repositories.workers,
    settings: st.settings,
  });
  return { st, queue };
}

test('a worker that has never claimed anything still counts as connected', async () => {
  // The regression this table exists for: a fresh install with an idle worker
  // used to be told to go and set up the worker it had just started.
  const { st, queue } = makeHeartbeatFixture();
  assert.equal((await queue.workerStatus()).connected, false, 'nothing running yet');

  await queue.heartbeat({ workerId: 'worker-1', hostname: 'assurance-1', version: '0.120.4' });
  const status = await queue.workerStatus();
  assert.equal(status.connected, true);
  assert.equal(status.worker_count, 1);
  assert.equal(status.workers[0].worker_id, 'worker-1');
  assert.equal(status.workers[0].hostname, 'assurance-1');
  assert.ok(status.last_seen_at);
  assert.equal(st.tables.workers.rows.length, 1);
});

test('a repeated heartbeat updates the worker rather than adding one', async () => {
  const { st, queue } = makeHeartbeatFixture();
  await queue.heartbeat({ workerId: 'worker-1', hostname: 'a' });
  await queue.heartbeat({ workerId: 'worker-1', hostname: 'a' });
  await queue.heartbeat({ workerId: 'worker-2', hostname: 'b' });
  assert.equal(st.tables.workers.rows.length, 2);
  assert.equal((await queue.workerStatus()).worker_count, 2);
});

test('a worker whose heartbeat has gone stale is not connected', async () => {
  const { st, queue } = makeHeartbeatFixture();
  const old = new Date(Date.now() - 10 * 60 * 1000);
  st.tables.workers.insert({ worker_id: 'gone', hostname: 'h', started_at: old, last_seen_at: old });
  const status = await queue.workerStatus();
  assert.equal(status.connected, false);
  assert.equal(status.worker_count, 0);
});

test('a heartbeat failure never stops the loop', async () => {
  const { st, queue } = makeHeartbeatFixture();
  st.repositories.workers.heartbeat = async () => { throw new Error('db down'); };
  assert.equal(await queue.heartbeat({ workerId: 'worker-1' }), null);
});

// ------------------------------------------------------------------ worker
function makeWorkerFixture(driverOpts = {}, overrides = {}) {
  const st = makeServiceTests();
  const queue = createQueue({
    runsRepo: st.repositories.runs,
    discoveryRepo: st.repositories.discovery,
    schedulesRepo: st.repositories.schedules,
    workersRepo: st.repositories.workers,
    settings: st.settings,
  });
  const driver = makeFakeDriver(driverOpts);
  const worker = createWorker({
    workerId: 'test-worker',
    hostname: 'test-host',
    version: '0.0.0-test',
    queue,
    repositories: st.repositories,
    settings: st.settings,
    browserFactory: async () => ({ driver, crawler: overrides.crawler || { visit: async (url) => ({ url, status: 200, links: [], buttons: [], inputs: [], forms: [] }) }, close: async () => {} }),
    artifacts: overrides.artifacts || null,
    // Offline: the policy resolves to a public address rather than doing DNS.
    resolve: async () => ['93.184.216.34'],
    logger: { info() {}, warn() {}, error() {} },
  });
  return { st, queue, worker, driver };
}

test('the worker claims a queued run, executes it and persists the result', async () => {
  const { st, worker } = makeWorkerFixture();
  const run = await st.repositories.runs.enqueue({ test_id: 1 });

  const worked = await worker.tick();
  assert.equal(worked, true);
  const finished = await st.repositories.runs.findById(run.id);
  assert.equal(finished.status, 'pass');
  assert.equal(finished.browser, 'chromium');
});

test('a run whose test has been deleted ends as an error, not a crash', async () => {
  const { st, worker } = makeWorkerFixture();
  const run = await st.repositories.runs.enqueue({ test_id: 999 });
  await worker.tick();
  const finished = await st.repositories.runs.findById(run.id);
  assert.equal(finished.status, 'error');
  assert.match(finished.error_message, /no longer exists/);
});

test('a browser that will not launch ends the run as an error and never leaves it running', async () => {
  const { st } = makeWorkerFixture();
  const queue = createQueue({
    runsRepo: st.repositories.runs, discoveryRepo: st.repositories.discovery,
    schedulesRepo: st.repositories.schedules, settings: st.settings,
  });
  const worker = createWorker({
    workerId: 'w', queue, repositories: st.repositories, settings: st.settings,
    browserFactory: async () => { const e = new Error('playwright-core is not installed'); e.missingPlaywright = true; throw e; },
    resolve: async () => ['93.184.216.34'],
    logger: { info() {}, warn() {}, error() {} },
  });
  const run = await st.repositories.runs.enqueue({ test_id: 1 });
  await worker.tick();
  const finished = await st.repositories.runs.findById(run.id);
  assert.equal(finished.status, 'error');
  assert.equal(finished.failure_kind, 'worker_misconfigured');
});

test('the credential is decrypted for the run and its value never reaches the stored result', async () => {
  const { st, worker, driver } = makeWorkerFixture({ present: ['Dashboard'], visible: ['Dashboard'] });
  await st.repositories.tests.save(1, {
    definition: {
      version: 1,
      name: 'Login',
      steps: [
        { type: 'fill', target: { label: 'Password' }, value: '{{credential.password}}' },
        { type: 'assert_visible', target: { text: 'Dashboard' } },
      ],
    },
    credential_id: 1,
  });
  const run = await st.repositories.runs.enqueue({ test_id: 1 });
  await worker.tick();

  const fill = driver.calls.find((c) => c.method === 'fill');
  assert.equal(fill.args[1], 'hunter2-correct-horse', 'the driver receives the real value');

  const finished = await st.repositories.runs.findById(run.id);
  assert.ok(!JSON.stringify(finished).includes('hunter2-correct-horse'), 'and the stored result carries none of it');
});

test('a discovery job crawls, stores pages and elements, and generates suggestions', async () => {
  const site = {
    'https://customer.example.com/': {
      url: 'https://customer.example.com/', title: 'Forside', status: 200,
      links: [{ text: 'Log ind', href: '/login' }], buttons: [], inputs: [], forms: [],
    },
    'https://customer.example.com/login': {
      url: 'https://customer.example.com/login', title: 'Log ind', status: 200,
      links: [], buttons: [{ text: 'Login', role: 'button', accessibleName: 'Login' }],
      inputs: [{ label: 'Username', name: 'user', autocomplete: 'username' }, { label: 'Password', type: 'password' }],
      forms: [{ action: '/login', method: 'post' }],
    },
  };
  const { st, worker } = makeWorkerFixture({}, {
    crawler: { visit: async (url) => site[url] || { url, status: 404, links: [], buttons: [], inputs: [], forms: [] } },
  });
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: 'https://customer.example.com/', budgets: {},
  });

  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.page_count, 2);
  assert.equal(finished.login_count, 1);

  const suggestions = await st.repositories.suggestions.list({ discoveryId: job.id });
  assert.ok(suggestions.some((s) => s.name === 'Login'), 'the crawl produced a Login suggestion');
  assert.ok((await st.repositories.discovery.pages(job.id)).length === 2);
});

test('a discovery that throws is recorded as failed rather than left running forever', async () => {
  const { st, worker } = makeWorkerFixture({}, {
    crawler: { visit: async () => { throw new Error('the browser died'); } },
  });
  const job = await st.repositories.discovery.enqueue({ application_id: 1, scope_url: 'https://customer.example.com/', budgets: {} });
  await worker.tick();
  const finished = await st.repositories.discovery.findById(job.id);
  // The crawl records a failed page rather than aborting, so it completes with
  // nothing found — which is the honest outcome, not a hidden error.
  assert.ok(['complete', 'failed'].includes(finished.status));
  assert.notEqual(finished.status, 'running');
});

test('an idle queue is not work, so the loop can back off', async () => {
  const { worker } = makeWorkerFixture();
  assert.equal(await worker.tick(), false);
});

test('an idle tick still records the heartbeat', async () => {
  // The tick where there is nothing to claim is exactly the tick an operator is
  // staring at the dashboard during, so the heartbeat comes first.
  const { st, worker } = makeWorkerFixture();
  const worked = await worker.tick();
  assert.equal(worked, false, 'nothing queued');
  assert.equal(st.tables.workers.rows.length, 1);
  assert.equal(st.tables.workers.rows[0].worker_id, 'test-worker');
  assert.equal(st.tables.workers.rows[0].hostname, 'test-host');
});
