'use strict';

// Runs the repositories against a REAL MySQL.
//
// The repository specs use a scripted pool: they assert the statement issued and
// the parameters bound, which is the right thing to assert — it is the contract,
// and it does not require a server. What it cannot catch is whether the SQL is
// VALID. A column renamed in a migration, a placeholder count that disagrees
// with the parameter list, an ENUM value the table does not have: every one of
// those passes a scripted pool and fails on the first real insert.
//
// That last one is not hypothetical. A placeholder/parameter mismatch in the
// discovery repository was caught by eye, and a foreign key whose signedness did
// not match took a server container down on deploy.
//
// So this executes each repository's real statements against a real database and
// reads the rows back. It is not a substitute for the specs — it asserts almost
// nothing about MEANING — it only answers "does this SQL run, and does what came
// back look like what went in".
//
//   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \
//     node scripts/verify-repositories-against-mysql.js
//
// It creates a scratch database, migrates it, exercises the repositories, and
// drops it again — on success or failure.

const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const env = process.env;
const HOST = env.DB_HOST || '127.0.0.1';
const PORT = Number(env.DB_PORT || 3306);
const USER = env.DB_USER || 'root';
const PASSWORD = env.DB_PASSWORD || '';
const DB = `be_repo_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const { createObservationsRepository } = require(path.join(ROOT, 'src/serviceTests/storage/observationsRepository'));
const { createIncidentsRepository } = require(path.join(ROOT, 'src/serviceTests/storage/incidentsRepository'));

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('observations: a batch writes and reads back', async (pool) => {
  const repo = createObservationsRepository({ db: { pool } });
  const earlier = new Date(Date.now() - 60000);
  const written = await repo.recordMany({ run_id: 1, test_id: 1, application_id: 1 }, [
    { layer: 'api', kind: 'api.call', subject: 'https://x.dk/api/a', outcome: 'bad', value: 812, unit: 'ms', summary: 'HTTP 500', detail: { status: 500 }, observed_at: earlier },
    { layer: 'network', kind: 'network.request_failed', subject: 'https://x.dk/b', outcome: 'bad', summary: 'did not complete' },
    { layer: 'page', kind: 'page.console_errors', outcome: 'ok', value: 0, unit: 'errors', summary: 'no script errors' },
    // The coercion paths: an ENUM the table does not have, and an unmeasured value.
    { layer: 'quantum', kind: 'x', outcome: 'maybe', value: '   ' },
  ]);
  assert.strictEqual(written, 4, 'four rows should have been written');

  const back = await repo.forRun(1);
  assert.strictEqual(back.length, 4);
  assert.strictEqual(back[0].summary, 'HTTP 500', 'ordered by when they were observed');
  assert.deepStrictEqual(back[0].detail, { status: 500 }, 'a JSON column must survive the round trip');
  assert.strictEqual(back[0].value, 812);
  const coerced = back.find((o) => o.kind === 'x');
  assert.strictEqual(coerced.layer, 'application', 'an unknown layer must land on a valid one');
  assert.strictEqual(coerced.outcome, 'unknown');
  assert.strictEqual(coerced.value, null, 'an unmeasured value must not read back as zero');

  const filtered = await repo.list({ applicationId: 1, layer: 'api', outcome: 'bad' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(await repo.purgeOlderThan(0.0000001) >= 0, true);
});

check('incidents: open, assess, move through the lifecycle, resolve', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  const opened = await repo.open({
    application_id: 1, test_id: 1, subject_type: 'test', subject_key: 'test:1',
    subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
    summary: 'HTTP 500 from /api/customer/search', likely_cause: 'the application',
    correlated_layer: 'api', confidence: 68,
    impact: 'high', impact_reason: 'a critical journey cannot complete',
    affected_journeys: [{ id: 2, name: 'Find customer' }],
    explanation: 'x', evidence: ['HTTP 500'],
  });
  assert.ok(opened.id, 'the incident was not created');
  assert.strictEqual(opened.confidence, 68);
  assert.strictEqual(opened.correlated_layer, 'api');
  assert.strictEqual(opened.impact, 'high');
  assert.deepStrictEqual(opened.affected_journeys, [{ id: 2, name: 'Find customer' }]);

  const found = await repo.findOpen('test:1');
  assert.strictEqual(found.id, opened.id, 'an open incident must be findable by its subject');

  const assessed = await repo.recordAssessment(opened.id, { confidence: 0, impactReason: 'revised' });
  assert.strictEqual(assessed.confidence, 0, 'zero confidence is a value, not an absence');

  let moved = await repo.transition(opened.id, 'investigating', { by: 1 });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  assert.ok(moved.incident.acknowledged_at, 'picking it up should acknowledge it');

  moved = await repo.transition(opened.id, 'open', { by: 1 });
  assert.strictEqual(moved.ok, true, 'investigating → open is allowed');

  moved = await repo.transition(opened.id, 'closed', {});
  assert.strictEqual(moved.ok, false, 'open → closed is not a legal move');

  moved = await repo.transition(opened.id, 'resolved', { by: 1, note: 'the next check was healthy' });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  assert.ok(moved.incident.resolved_at);
  assert.strictEqual(moved.incident.resolution, 'the next check was healthy');

  moved = await repo.transition(opened.id, 'closed', { by: 1 });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  moved = await repo.transition(opened.id, 'open', {});
  assert.strictEqual(moved.ok, false, 'a closed incident must stay closed');

  return opened.id;
});

check('incidents: the timeline writes in one statement and reads forwards', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  const opened = await repo.open({
    application_id: 1, subject_type: 'test', subject_key: 'test:2', subject_label: 'Sign in',
    kind: 'timeout', severity: 'WARN', summary: 'timed out', explanation: 'x', evidence: [],
  });
  const first = new Date(Date.now() - 120000);
  const second = new Date(Date.now() - 60000);
  const written = await repo.addEvents(opened.id, [
    { kind: 'opened', summary: 'Sign in started failing', source: 'run', occurred_at: first, detail: { run_id: 5 } },
    { kind: 'correlated', summary: 'Likely a server problem', source: 'correlation', occurred_at: second },
    { kind: 'x', summary: 'y', source: 'telepathy' },
  ]);
  assert.strictEqual(written, 3);

  const timeline = await repo.timeline(opened.id);
  assert.strictEqual(timeline.length, 3);
  assert.strictEqual(timeline[0].kind, 'opened', 'a timeline is read forwards');
  assert.deepStrictEqual(timeline[0].detail, { run_id: 5 });
  assert.strictEqual(timeline[2].source, 'run', 'an unknown source must land on a valid one');
});

check('incidents: the aggregate queries all run', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  // These are the queries a dashboard opens with, and a broken one is a page
  // that will not load during an outage.
  assert.ok(Array.isArray(await repo.list({ limit: 10 })));
  assert.ok(Array.isArray(await repo.listBetween({ from: new Date(0), to: new Date() })));
  const counts = await repo.openCounts();
  assert.ok(typeof counts.total === 'number');
  assert.ok(Array.isArray(await repo.countByApplication()) || typeof await repo.countByApplication() === 'object');
  assert.strictEqual(typeof await repo.purgeResolvedOlderThan(90), 'number');
});

async function main() {
  const admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD });
  let failures = 0;
  try {
    await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.info(`Migrating ${DB} …`);
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'migrate.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...env, DB_HOST: HOST, DB_PORT: String(PORT), DB_USER: USER, DB_PASSWORD: PASSWORD, DB_NAME: DB },
    });

    const pool = mysql.createPool({
      host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB, connectionLimit: 4,
    });
    // The seeded admin is the only row the repositories can lean on, so the
    // foreign keys they write against have something to point at.
    await pool.query("INSERT INTO service_test_applications (id, name, base_url, enabled, created_by) VALUES (1, 'Portal', 'https://portal.kunde.dk', 1, 1)");
    await pool.query("INSERT INTO service_test_tests (id, application_id, name, definition, version, enabled, created_by) VALUES (1, 1, 'Search', '{\"version\":1,\"steps\":[]}', 1, 1, 1)");
    await pool.query("INSERT INTO service_test_runs (id, test_id, status, trigger_source) VALUES (1, 1, 'fail', 'manual')");

    for (const { name, fn } of checks) {
      try {
        await fn(pool);
        console.info(`  ok   ${name}`);
      } catch (err) {
        failures += 1;
        console.error(`  FAIL ${name}\n       ${err && err.message}`);
      }
    }
    await pool.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await admin.end().catch(() => {});
  }

  if (failures) {
    console.error(`\n${failures} of ${checks.length} repository checks failed against a real MySQL.\n`);
    process.exit(1);
  }
  console.info(`\nAll ${checks.length} repository checks pass against a real MySQL.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nVerification could not run: ${err && err.message}\n`);
  console.error('It needs a MySQL it may create and drop databases on. For example:');
  console.error('  DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \\');
  console.error('    node scripts/verify-repositories-against-mysql.js\n');
  process.exit(2);
});
