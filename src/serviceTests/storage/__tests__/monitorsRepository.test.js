'use strict';

// The storage contract for monitors and their results.
//
// The property this file exists to pin down is the same one the credentials
// spec pins down, because it is the same risk: an SMTP password goes in and no
// read path can bring it back out. The rest is the statement contract — which
// SQL, which parameters — which is what the scripted pool can honestly prove.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createMonitorsRepository } = require('../monitorsRepository');
const { createMonitorResultsRepository } = require('../monitorResultsRepository');
const { createSecretBox } = require('../../../lib/secretBox');

const secretBox = createSecretBox({ key: 'test-key-for-service-monitors' });
const PASSWORD = 'hunter2-correct-horse';

function row(over = {}) {
  return {
    id: 1,
    tenant_id: null,
    application_id: 3,
    environment_id: null,
    name: 'Customer mail',
    type: 'mail',
    target: 'smtp.example.com',
    description: null,
    config: JSON.stringify({ smtp_host: 'smtp.example.com', to_address: 'probe@example.com' }),
    secrets_encrypted: secretBox.encrypt(JSON.stringify({ smtp_password: PASSWORD })),
    interval_sec: 900,
    warn_ms: null,
    crit_ms: null,
    enabled: 1,
    last_run_at: null,
    last_status: null,
    last_summary: null,
    last_duration_ms: null,
    consecutive_failures: 0,
    created_by: 9,
    created_at: new Date('2026-09-01T10:00:00Z'),
    updated_at: new Date('2026-09-01T10:00:00Z'),
    ...over,
  };
}

const selectOne = [/^SELECT .* FROM service_monitors WHERE id = \?/i, () => [[row()]]];

test('no read path returns a secret — only that one is stored', async () => {
  const pool = makeFakePool([
    selectOne,
    [/^SELECT .* FROM service_monitors\s+ORDER BY/i, () => [[row(), row({ id: 2, name: 'Directory' })]]],
  ]);
  const repo = createMonitorsRepository({ db: { pool }, secretBox });

  const one = await repo.findById(1);
  const many = await repo.list();
  for (const shaped of [one, ...many]) {
    assert.deepEqual(shaped.has_secrets, { smtp_password: true, imap_password: false });
    assert.equal(shaped.secrets, undefined);
    assert.equal(shaped.secrets_encrypted, undefined, 'not even the ciphertext leaves the repository');
    assert.ok(!JSON.stringify(shaped).includes(PASSWORD));
  }
  // The config is handed back parsed, and carries no secret field.
  assert.equal(one.config.smtp_host, 'smtp.example.com');
  assert.equal(one.config.smtp_password, undefined);
});

test('findByIdWithSecrets() is the only path that decrypts, and a bad blob yields nothing rather than garbage', async () => {
  const pool = makeFakePool([selectOne]);
  const repo = createMonitorsRepository({ db: { pool }, secretBox });
  const withSecrets = await repo.findByIdWithSecrets(1);
  assert.equal(withSecrets.secrets.smtp_password, PASSWORD);

  const tampered = makeFakePool([[/^SELECT .* FROM service_monitors WHERE id = \?/i, () => [[row({ secrets_encrypted: 'v1.gcm.not-really' })]]]]);
  const broken = createMonitorsRepository({ db: { pool: tampered }, secretBox });
  const shaped = await broken.findByIdWithSecrets(1);
  assert.deepEqual(shaped.secrets, {}, 'a rotated key gives no secret, never a wrong one');
  assert.deepEqual(shaped.has_secrets, { smtp_password: false, imap_password: false });
});

test('create stores the config as JSON and the secrets as one encrypted blob', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_monitors/i, () => ok({ insertId: 1 })],
    selectOne,
  ]);
  const repo = createMonitorsRepository({ db: { pool }, secretBox });
  await repo.create({
    application_id: 3,
    name: 'Customer mail',
    type: 'mail',
    target: 'smtp.example.com',
    config: { smtp_host: 'smtp.example.com' },
    secrets: { smtp_password: PASSWORD },
    interval_sec: 900,
    created_by: 9,
  });

  const insert = pool.matching(/^INSERT INTO service_monitors/i)[0];
  assert.equal(insert.params[2], 'Customer mail');
  assert.equal(insert.params[6], JSON.stringify({ smtp_host: 'smtp.example.com' }));
  const blob = insert.params[7];
  assert.ok(!String(blob).includes(PASSWORD), 'the password is written encrypted');
  assert.equal(JSON.parse(secretBox.decrypt(blob)).smtp_password, PASSWORD);
});

test('an update merges secrets: absent leaves, a value replaces, an empty string clears', async () => {
  const pool = makeFakePool([
    [/^SELECT type, config, secrets_encrypted FROM service_monitors/i, () => [[row()]]],
    [/^UPDATE service_monitors SET/i, () => ok()],
    selectOne,
  ]);
  const repo = createMonitorsRepository({ db: { pool }, secretBox });

  await repo.update(1, { name: 'Renamed' });
  assert.equal(pool.matching(/^UPDATE service_monitors SET name = \?/i).length, 1);
  assert.ok(!pool.calls.some((c) => /secrets_encrypted = \?/.test(c.sql)), 'a rename does not touch the secret');

  await repo.update(1, { secrets: { imap_password: 'second' } });
  // `.at(-1)`: the recorded calls are in order, and the newest is the one just made.
  const merged = JSON.parse(secretBox.decrypt(pool.matching(/secrets_encrypted = \?/i).at(-1).params.at(-2)));
  assert.deepEqual(merged, { smtp_password: PASSWORD, imap_password: 'second' }, 'the untouched secret survived');

  // Clearing the last secret stores NULL rather than an encrypted empty object:
  // "this monitor has no credentials" is a state, not a blob to decrypt.
  await repo.update(1, { secrets: { smtp_password: '' } });
  assert.equal(pool.matching(/secrets_encrypted = \?/i).at(-1).params.at(-2), null);
});

test('the due list asks the database for the arithmetic, not the process', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_monitors\s+WHERE enabled = 1/i, () => [[row()]]]]);
  const repo = createMonitorsRepository({ db: { pool }, now: () => new Date('2026-09-15T12:00:00Z') });
  await repo.dueForCheck({ limit: 50 });
  const sql = pool.matching(/WHERE enabled = 1/i)[0].sql;
  assert.match(sql, /last_run_at IS NULL OR last_run_at <= DATE_SUB\(\?, INTERVAL interval_sec SECOND\)/);
  assert.match(sql, /LIMIT 50/);
});

test('recordRun stamps the outcome and moves the streak in one statement', async () => {
  const pool = makeFakePool([[/^UPDATE service_monitors/i, () => ok()], selectOne]);
  const repo = createMonitorsRepository({ db: { pool }, secretBox });

  await repo.recordRun(1, { status: 'failed', summary: 'lost', durationMs: 300, failed: true });
  assert.match(pool.matching(/^UPDATE service_monitors/i).at(-1).sql, /consecutive_failures = consecutive_failures \+ 1/);

  await repo.recordRun(1, { status: 'ok', summary: 'fine', durationMs: 20, failed: false });
  assert.match(pool.matching(/^UPDATE service_monitors/i).at(-1).sql, /consecutive_failures = 0/);
});

// ------------------------------------------------------------------ results
test('a result row keeps the phase timings and the measurement with its unit', async () => {
  const stored = {
    id: 5, monitor_id: 1, status: 'ok', kind: null, duration_ms: 4100, value: 4100, unit: 'ms',
    summary: 'Delivered', error_message: null,
    timings: JSON.stringify({ connect: 24, delivery: 4100 }), detail: JSON.stringify({ queue_id: '4bXk2Z' }),
    trigger_source: 'manual', requested_by: 9, checked_at: new Date(),
  };
  const pool = makeFakePool([
    [/^INSERT INTO service_monitor_results/i, () => ok({ insertId: 5 })],
    [/^SELECT .* FROM service_monitor_results WHERE id = \?/i, () => [[stored]]],
  ]);
  const repo = createMonitorResultsRepository({ db: { pool } });
  const row0 = await repo.record(1, {
    status: 'ok', kind: null, duration_ms: 4100, value: 4100, unit: 'ms',
    summary: 'Delivered', timings: { connect: 24, delivery: 4100 }, detail: { queue_id: '4bXk2Z' },
  }, { triggerSource: 'manual', requestedBy: 9 });

  assert.deepEqual(row0.timings, { connect: 24, delivery: 4100 });
  assert.equal(row0.detail.queue_id, '4bXk2Z');
  assert.equal(row0.value, 4100);
  assert.equal(row0.unit, 'ms');
});

test('a measurement nobody took reads back as null, never as zero', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_monitor_results/i, () => ok({ insertId: 6 })],
    [/^SELECT .* FROM service_monitor_results WHERE id = \?/i, () => [[{
      id: 6, monitor_id: 1, status: 'unreachable', kind: 'monitor_unreachable', duration_ms: null,
      value: null, unit: null, summary: 'nothing answered', error_message: 'ECONNREFUSED',
      timings: null, detail: null, trigger_source: 'schedule', requested_by: null, checked_at: new Date(),
    }]]],
  ]);
  const repo = createMonitorResultsRepository({ db: { pool } });
  const shaped = await repo.record(1, { status: 'unreachable', kind: 'monitor_unreachable', summary: 'nothing answered', error_message: 'ECONNREFUSED' });
  assert.equal(shaped.value, null);
  assert.equal(shaped.duration_ms, null);
});

test('the summary answers availability over a window, and null when nothing was measured', async () => {
  const pool = makeFakePool([[/^SELECT COUNT\(\*\) AS checks/i, () => [[{
    checks: 10, ok_count: 8, slow_count: 1, bad_count: 1, avg_value: 4200, max_value: 9000, since: new Date(),
  }]]]]);
  const repo = createMonitorResultsRepository({ db: { pool } });
  const summary = await repo.summary(1, { hours: 24 });
  assert.equal(summary.checks, 10);
  assert.equal(summary.availability, 0.9, 'slow still counts as available — it worked');
  assert.equal(summary.avg_value, 4200);

  const empty = makeFakePool([[/^SELECT COUNT\(\*\) AS checks/i, () => [[{ checks: 0, ok_count: null, slow_count: null, bad_count: null, avg_value: null, max_value: null, since: null }]]]]);
  const none = await createMonitorResultsRepository({ db: { pool: empty } }).summary(1, {});
  assert.equal(none.availability, null, 'a monitor that never ran is unmeasured, not 0% available');
});
