'use strict';

process.env.NODE_ENV = 'test';

// The migration runner's failure behaviour, which is the part that decides
// whether a bad deploy is a stopped deploy or a boot loop. The container's
// command is `migrate && server`, so every refusal here is a container that
// does not start — on purpose.
//
// src/migrate.js talks to mysql2 directly, so these tests exercise the three
// decisions through a scripted connection: what it refuses, in which order, and
// what it writes before running a file.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const MIGRATE = path.join(__dirname, '..', 'src', 'migrate.js');

// A fake mysql2/promise connection. `rows` answers the SELECTs by pattern; every
// query is recorded.
function fakeConn({ migrationRows = [], columns = ['id', 'filename', 'applied_at', 'checksum', 'state', 'error'], lock = 1, failOn = null } = {}) {
  const queries = [];
  const conn = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/GET_LOCK/.test(sql)) return [[{ got: lock }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{}]];
      if (/information_schema\.COLUMNS/.test(sql)) return [columns.map((name) => ({ name }))];
      if (/SELECT filename, state, checksum FROM schema_migrations/.test(sql)) return [migrationRows];
      if (/SELECT COUNT\(\*\) AS count FROM users/.test(sql)) return [[{ count: 1 }]];
      if (failOn && failOn.test(String(sql))) throw new Error('Duplicate column name "foo"');
      return [{ affectedRows: 1 }];
    },
    async end() {},
  };
  return conn;
}

// Loads src/migrate.js with mysql2/promise and ./config stubbed.
function loadMigrate(conn, { migrationsDir = null } = {}) {
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'mysql2/promise') return { createConnection: async () => conn };
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(MIGRATE)];
    const mod = require(MIGRATE);
    return mod;
  } finally {
    Module._load = realLoad;
    Module._resolveFilename = realResolve;
    delete require.cache[require.resolve(MIGRATE)];
  }
}

const realMigrations = () => fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const checksumOfFile = (file) => require('node:crypto').createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'), 'utf8').digest('hex');

test('a migration left mid-flight stops the next run instead of being retried', async () => {
  const files = realMigrations();
  const rows = files.map((filename) => ({ filename, state: 'applied', checksum: checksumOfFile(filename) }));
  rows[rows.length - 1].state = 'running';
  const conn = fakeConn({ migrationRows: rows });
  const { run } = loadMigrate(conn);

  await assert.rejects(run(), (err) => {
    assert.match(err.message, /started and never finished/);
    assert.match(err.message, new RegExp(files[files.length - 1].replace(/\./g, '\\.')));
    assert.match(err.message, /--mark-applied/);
    assert.match(err.message, /--retry/);
    return true;
  });
  // Nothing was applied, and nothing was quietly re-run.
  assert.equal(conn.queries.filter((q) => /^INSERT INTO schema_migrations/.test(q.sql)).length, 0);
});

test('a failed migration is recorded as failed, not left looking un-run', async () => {
  // Every real migration is applied except one pending file, which fails.
  const rows = realMigrations().map((filename) => ({ filename, state: 'applied', checksum: checksumOfFile(filename) }));
  // Make the LAST real file pending by dropping its row; its own SQL then fails,
  // while the bookkeeping writes still work — that is the case that matters.
  const pending = rows.pop().filename;
  const conn = fakeConn({ migrationRows: rows, failOn: /^(?!.*(schema_migrations|GET_LOCK|RELEASE_LOCK|information_schema|FROM users))/s });
  const { run } = loadMigrate(conn);

  await assert.rejects(run(), (err) => {
    assert.match(err.message, new RegExp(`Migration ${pending.replace(/\./g, '\\.')} failed`));
    assert.match(err.message, /still applied/, 'the operator has to be told the partial work stands');
    return true;
  });

  const marker = conn.queries.find((q) => /^INSERT INTO schema_migrations/.test(q.sql));
  assert.ok(marker, "the 'running' marker must be written BEFORE the SQL runs");
  assert.match(marker.sql, /'running'/);
  assert.equal(marker.params[0], pending);
  const failed = conn.queries.find((q) => /SET state = 'failed'/.test(q.sql));
  assert.ok(failed, 'the row must end up as failed, so the next boot stops');
});

test('an already-applied migration that was edited refuses to migrate', async () => {
  const rows = realMigrations().map((filename) => ({ filename, state: 'applied', checksum: checksumOfFile(filename) }));
  rows[0].checksum = 'a'.repeat(64);
  const conn = fakeConn({ migrationRows: rows });
  const { run } = loadMigrate(conn);

  await assert.rejects(run(), (err) => {
    assert.match(err.message, /have been edited/);
    assert.match(err.message, /Add a NEW numbered migration/);
    return true;
  });
});

test('a migration applied before checksums existed is backfilled, not refused', async () => {
  const rows = realMigrations().map((filename) => ({ filename, state: 'applied', checksum: null }));
  const conn = fakeConn({ migrationRows: rows });
  const { run } = loadMigrate(conn);

  await run();
  const backfills = conn.queries.filter((q) => /^UPDATE schema_migrations SET checksum = \?/.test(q.sql));
  assert.equal(backfills.length, rows.length);
  assert.equal(backfills[0].params[0], checksumOfFile(rows[0].filename));
});

test('a concurrent migration run is refused rather than racing', async () => {
  const conn = fakeConn({ migrationRows: [], lock: 0 });
  const { run } = loadMigrate(conn);
  await assert.rejects(run(), /held the 'blueeye_schema_migrations' lock/);
  // The lock is taken before anything else looks at the schema.
  assert.match(conn.queries[0].sql, /GET_LOCK/);
});

test('the lock is released even when the run fails', async () => {
  const rows = realMigrations().map((filename) => ({ filename, state: 'running', checksum: checksumOfFile(filename) }));
  const conn = fakeConn({ migrationRows: rows });
  const { run } = loadMigrate(conn);
  await assert.rejects(run());
  assert.ok(conn.queries.some((q) => /RELEASE_LOCK/.test(q.sql)), 'a failed run must not keep the lock');
});

test('--mark-applied and --retry only touch bookkeeping', async () => {
  const file = realMigrations()[0];

  const marked = fakeConn({ migrationRows: [] });
  await loadMigrate(marked).resolve('mark-applied', file);
  const update = marked.queries.find((q) => /UPDATE schema_migrations SET state = 'applied'/.test(q.sql));
  assert.ok(update);
  assert.deepEqual(update.params, [checksumOfFile(file), file]);
  // Every statement it ran is about the bookkeeping table and nothing else.
  for (const q of marked.queries) {
    assert.match(q.sql, /schema_migrations|information_schema/, `resolve() must not run SQL of its own: ${q.sql.slice(0, 60)}`);
  }

  const retried = fakeConn({ migrationRows: [] });
  await loadMigrate(retried).resolve('retry', file);
  assert.ok(retried.queries.some((q) => /^DELETE FROM schema_migrations/.test(q.sql)));

  await assert.rejects(loadMigrate(fakeConn({})).resolve('retry', 'nope-not-a-file.sql'), /No such migration file/);
});

test('an old install missing the new columns is widened in place', async () => {
  const conn = fakeConn({ migrationRows: [], columns: ['id', 'filename', 'applied_at'] });
  const { run } = loadMigrate(conn);
  await run();
  const alter = conn.queries.find((q) => /^ALTER TABLE schema_migrations/.test(q.sql));
  assert.ok(alter, 'the bookkeeping table must be widened for an existing install');
  for (const col of ['checksum', 'state', 'error']) assert.match(alter.sql, new RegExp(`ADD COLUMN ${col}`));
});
