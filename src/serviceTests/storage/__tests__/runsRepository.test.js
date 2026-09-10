'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createRunsRepository } = require('../runsRepository');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const now = () => NOW;

function runRow(over = {}) {
  return {
    id: 5,
    tenant_id: null,
    test_id: 2,
    environment_id: 1,
    test_version: 3,
    status: 'queued',
    trigger_source: 'manual',
    started_at: null,
    ended_at: null,
    duration_ms: null,
    failed_step: null,
    error_message: null,
    failure_kind: null,
    screenshot_path: null,
    browser: null,
    console_errors: null,
    network_errors: null,
    claimed_by: null,
    claimed_at: null,
    requested_by: 9,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

const selectRun = (over = {}) => [/^SELECT .* FROM service_test_runs WHERE id = \?/i, () => [[runRow(over)]]];
const selectSteps = [/^SELECT .* FROM service_test_run_steps WHERE run_id = \?/i, () => [[]]];

test('enqueue() inserts a queued run and hands back the queued row', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_runs/i, () => ok({ insertId: 5 })],
    selectRun(), selectSteps,
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  const run = await repo.enqueue({ test_id: 2, environment_id: 1, test_version: 3, requested_by: 9 });

  assert.equal(run.status, 'queued');
  const insert = pool.matching(/^INSERT INTO service_test_runs/i)[0];
  assert.match(insert.sql, /'queued'/, 'a run starts life in the queue, never running');
});

test("enqueue() only accepts 'schedule' or 'manual' as the trigger", async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_runs/i, () => ok({ insertId: 5 })],
    selectRun(), selectSteps,
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  await repo.enqueue({ test_id: 2, trigger_source: 'something-else' });
  assert.equal(pool.matching(/^INSERT INTO service_test_runs/i)[0].params[3], 'manual');
});

// The load-bearing test for the whole queue design.
test('claimNext() claims with a conditional UPDATE, so two workers cannot both win', async () => {
  const pool = makeFakePool([
    [/^SELECT id FROM service_test_runs WHERE status = 'queued'/i, () => [[{ id: 5 }]]],
    [/^UPDATE service_test_runs SET status = 'running'/i, () => ok({ affectedRows: 1 })],
    selectRun({ status: 'running', claimed_by: 'worker-a' }), selectSteps,
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  const claimed = await repo.claimNext('worker-a');

  assert.equal(claimed.status, 'running');
  const update = pool.matching(/^UPDATE service_test_runs SET status = 'running'/i)[0];
  assert.match(update.sql, /WHERE id = \? AND status = 'queued'/, 'the claim MUST be conditional on the row still being queued');
  assert.equal(update.params[0], 'worker-a');
});

test('claimNext() returns null when another worker won the race', async () => {
  const pool = makeFakePool([
    [/^SELECT id FROM service_test_runs WHERE status = 'queued'/i, () => [[{ id: 5 }]]],
    // affectedRows 0 = the row was no longer queued by the time we updated it.
    [/^UPDATE service_test_runs SET status = 'running'/i, () => ok({ affectedRows: 0 })],
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  assert.equal(await repo.claimNext('worker-b'), null);
});

test('claimNext() returns null on an empty queue without issuing an UPDATE', async () => {
  const pool = makeFakePool([[/^SELECT id FROM service_test_runs WHERE status = 'queued'/i, () => [[]]]]);
  const repo = createRunsRepository({ db: { pool }, now });
  assert.equal(await repo.claimNext('worker-a'), null);
  assert.equal(pool.matching(/^UPDATE/i).length, 0);
});

test('claimNext() bounds the worker id so a long value cannot overflow the column', async () => {
  const pool = makeFakePool([
    [/^SELECT id FROM service_test_runs WHERE status = 'queued'/i, () => [[{ id: 5 }]]],
    [/^UPDATE service_test_runs SET status = 'running'/i, () => ok({ affectedRows: 1 })],
    selectRun({ status: 'running' }), selectSteps,
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  await repo.claimNext('w'.repeat(500));
  assert.equal(pool.matching(/^UPDATE service_test_runs SET status = 'running'/i)[0].params[0].length, 120);
});

test('complete() writes the outcome and the step rows in one transaction', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_runs SET status = \?/i, () => ok()],
    [/^DELETE FROM service_test_run_steps/i, () => ok()],
    [/^INSERT INTO service_test_run_steps/i, () => ok()],
    selectRun({ status: 'fail' }), selectSteps,
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  await repo.complete(5, {
    status: 'fail',
    duration_ms: 3800,
    failed_step: 4,
    error_message: 'Kunne ikke klikke på "Log ind".',
    failure_kind: 'http_503',
    steps: [
      { step_type: 'open', label: 'Åbn /login', status: 'pass', duration_ms: 900 },
      { step_type: 'click', label: 'Klik Log ind', status: 'fail', duration_ms: 30000, detail: { httpStatus: 503 } },
    ],
  });

  assert.equal(pool.tx.begun, 1);
  assert.equal(pool.tx.committed, 1);
  assert.equal(pool.tx.rolledBack, 0);
  assert.equal(pool.tx.released, 1, 'the connection is always returned to the pool');
  assert.equal(pool.matching(/^INSERT INTO service_test_run_steps/i).length, 2);
});

test('complete() rolls back and releases the connection when a step insert fails', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_runs SET status = \?/i, () => ok()],
    [/^DELETE FROM service_test_run_steps/i, () => ok()],
    [/^INSERT INTO service_test_run_steps/i, () => { throw new Error('deadlock'); }],
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  await assert.rejects(() => repo.complete(5, { status: 'pass', steps: [{ step_type: 'open', status: 'pass' }] }), /deadlock/);
  assert.equal(pool.tx.committed, 0);
  assert.equal(pool.tx.rolledBack, 1);
  assert.equal(pool.tx.released, 1);
});

test('reapStale() only touches runs whose claim has actually timed out', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_runs SET status = 'error'/i, () => ok({ affectedRows: 2 })]]);
  const repo = createRunsRepository({ db: { pool }, now });
  assert.equal(await repo.reapStale(600000), 2);

  const update = pool.matching(/^UPDATE service_test_runs SET status = 'error'/i)[0];
  assert.match(update.sql, /WHERE status = 'running'/, 'a queued run must never be reaped');
  assert.match(update.sql, /claimed_at < \?/);
  assert.deepEqual(update.params[1], new Date(NOW.getTime() - 600000));
});

test('list() clamps the limit rather than trusting it', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_runs/i, () => [[]]]]);
  const repo = createRunsRepository({ db: { pool }, now });
  await repo.list({ limit: 100000 });
  await repo.list({ limit: -5 });
  await repo.list({ limit: 'abc' });
  const limits = pool.matching(/^SELECT .* FROM service_test_runs/i).map((c) => c.params[c.params.length - 1]);
  assert.deepEqual(limits, [500, 1, 50]);
});

test('history() computes success rate, average duration and the last failure over finished runs only', async () => {
  const finished = [
    { id: 9, status: 'pass', duration_ms: 1000, failed_step: null, error_message: null },
    { id: 8, status: 'fail', duration_ms: 3000, failed_step: 4, error_message: 'HTTP 503' },
    { id: 7, status: 'pass', duration_ms: 2000, failed_step: null, error_message: null },
    { id: 6, status: 'pass', duration_ms: null, failed_step: null, error_message: null },
  ];
  const pool = makeFakePool([[/^SELECT id,status,duration_ms.* FROM service_test_runs/i, () => [finished]]]);
  const repo = createRunsRepository({ db: { pool }, now });
  const h = await repo.history(2);

  assert.equal(h.total, 4);
  assert.equal(h.success_rate, 0.75);
  assert.equal(h.avg_duration_ms, 2000, 'runs with no duration are excluded from the average, not counted as zero');
  assert.equal(h.last_failure.id, 8);
  assert.match(pool.calls[0].sql, /status NOT IN \('queued','running'\)/, 'an in-flight run is not history yet');
});

test('history() reports null rather than 0 when there is nothing to average', async () => {
  const pool = makeFakePool([[/^SELECT id,status,duration_ms.* FROM service_test_runs/i, () => [[]]]]);
  const h = await createRunsRepository({ db: { pool }, now }).history(2);
  assert.equal(h.success_rate, null);
  assert.equal(h.avg_duration_ms, null);
  assert.equal(h.last_failure, null);
});

test('screenshot retention finds old artefacts and clears the column in bulk', async () => {
  const pool = makeFakePool([
    [/^SELECT id, screenshot_path FROM service_test_runs/i, () => [[{ id: 1, screenshot_path: '/a.webp' }]]],
    [/^UPDATE service_test_runs SET screenshot_path = NULL/i, () => ok({ affectedRows: 1 })],
  ]);
  const repo = createRunsRepository({ db: { pool }, now });
  const old = await repo.screenshotsOlderThan(30);
  assert.deepEqual(old, [{ id: 1, screenshot_path: '/a.webp' }]);
  assert.deepEqual(pool.calls[0].params[0], new Date(NOW.getTime() - 30 * 86400000));
  assert.equal(await repo.clearScreenshots([1]), 1);
  assert.equal(await repo.clearScreenshots([]), 0, 'an empty list issues no statement');
});

test('a run says what it was a run OF — the list carries the test and application names', async () => {
  // The Runs screen lists every test in the install together. Without these
  // names a row says only "something failed at 21:39", so two applications
  // failing read as one application failing twice — which is exactly how a
  // passing run against one site got mistaken for a failure from another.
  const pool = makeFakePool([
    [/^SELECT .* FROM service_test_runs r LEFT JOIN/i, () => [[runRow({
      test_name: 'Customer Login', application_id: 2, application_name: 'Fellis',
      environment_name: 'Production', environment_url: 'https://fellis.eu',
    })]]],
  ]);
  const [run] = await createRunsRepository({ db: { pool }, now }).list({});
  assert.equal(run.test_name, 'Customer Login');
  assert.equal(run.application_name, 'Fellis');
  assert.equal(run.environment_name, 'Production');

  const [call] = pool.matching(/^SELECT .* FROM service_test_runs r/i);
  assert.match(call.sql, /LEFT JOIN service_test_tests/i, 'a deleted test must not drop its runs from the list');
  assert.match(call.sql, /LEFT JOIN service_test_applications/i);
});

test('the queue paths do not pay for the join the screen needs', async () => {
  // enqueue/claim/complete run on the worker's hot path and never render a name.
  const pool = makeFakePool([
    [/^INSERT INTO service_test_runs/i, () => [{ insertId: 9 }]],
    [/^SELECT .* FROM service_test_runs WHERE id = \?/i, () => [[runRow({})]]],
    selectSteps,
  ]);
  const run = await createRunsRepository({ db: { pool }, now }).enqueue({ test_id: 1 });
  assert.equal(run.id, runRow({}).id);
  assert.equal(run.test_name, null, 'an unjoined read reports the name as absent, not undefined');
  assert.equal(pool.matching(/LEFT JOIN/i).length, 0);
});

test('the list can be scoped to one application', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_runs r LEFT JOIN/i, () => [[]]]]);
  await createRunsRepository({ db: { pool }, now }).list({ applicationId: 3, status: 'fail' });
  const [call] = pool.matching(/^SELECT .* FROM service_test_runs r/i);
  assert.match(call.sql, /WHERE r\.status = \? AND t\.application_id = \?/);
  assert.deepEqual(call.params.slice(0, 2), ['fail', 3]);
});

test('JSON columns come back as arrays whether the driver parsed them or not', async () => {
  const pool = makeFakePool([
    [/^SELECT .* FROM service_test_runs r LEFT JOIN .* WHERE r\.id = \?/i, () => [[runRow({
      console_errors: '["TypeError: x is not a function"]',
      network_errors: [{ url: '/api/auth/login', status: 503 }],
    })]]],
    selectSteps,
  ]);
  const run = await createRunsRepository({ db: { pool }, now }).findById(5);
  assert.deepEqual(run.console_errors, ['TypeError: x is not a function']);
  assert.equal(run.network_errors[0].status, 503);
});

test('a corrupt JSON column degrades to an empty list instead of throwing on a read', async () => {
  const pool = makeFakePool([
    [/^SELECT .* FROM service_test_runs r LEFT JOIN .* WHERE r\.id = \?/i, () => [[runRow({ console_errors: '{not json' })]]],
    selectSteps,
  ]);
  const run = await createRunsRepository({ db: { pool }, now }).findById(5);
  assert.deepEqual(run.console_errors, []);
});
