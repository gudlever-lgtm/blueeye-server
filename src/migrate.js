'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { config } = require('./config');
const { hashPassword } = require('./auth/password');
const { ROLES } = require('./auth/roles');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// One advisory lock for the whole run. The container's command is
// `migrate && server`, so two replicas starting together used to run the
// pending migrations at the same time: both read the same empty applied-set,
// both ran file N, and the loser died on "table already exists" — or, worse,
// got half way. MySQL's own named lock costs nothing and needs no table.
const LOCK_NAME = 'blueeye_schema_migrations';
const LOCK_TIMEOUT_S = 60;

// How a migration row can look:
//   applied — finished; the file's checksum is recorded
//   running — started and never reported back (the process was killed, the DDL
//             died half way). NOT retried automatically: see assertNoUnfinished
//   failed  — reported an error. Same treatment
const STATES = ['applied', 'running', 'failed'];

function checksumOf(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function columnNames(conn, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return new Set(rows.map((row) => row.name));
}

// Tracks which migration files have already been applied, with what content,
// and whether they finished.
//
// The bookkeeping table cannot be migrated BY a migration — the runner needs
// the new columns before it can read the chain at all — so the widening happens
// here, guarded by information_schema and therefore safe to re-run.
async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum CHAR(64) NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'applied',
      error TEXT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const columns = await columnNames(conn, 'schema_migrations');
  const additions = [
    ['checksum', 'ADD COLUMN checksum CHAR(64) NULL'],
    ['state', "ADD COLUMN state VARCHAR(16) NOT NULL DEFAULT 'applied'"],
    ['error', 'ADD COLUMN error TEXT NULL'],
  ].filter(([name]) => !columns.has(name)).map(([, ddl]) => ddl);
  if (additions.length > 0) {
    await conn.query(`ALTER TABLE schema_migrations ${additions.join(', ')}`);
  }
}

// filename -> { state, checksum }
async function appliedMigrations(conn) {
  const [rows] = await conn.query('SELECT filename, state, checksum FROM schema_migrations');
  return new Map(rows.map((row) => [row.filename, {
    state: STATES.includes(row.state) ? row.state : 'applied',
    checksum: row.checksum || null,
  }]));
}

// A migration that started and never reported back. Retrying it blindly is the
// behaviour that turns one bad deploy into a boot loop: MySQL commits DDL
// implicitly, so a file that created two of its three tables is PARTLY applied,
// and running it again dies on the first table it already made — for ever,
// because the container's command is `migrate && server`.
//
// So stop, name the file, and say what the two ways out are. Deciding which is
// a human's job: only someone who has looked at the schema knows whether the
// file finished.
function assertNoUnfinished(records) {
  const stuck = [...records].filter(([, r]) => r.state !== 'applied');
  if (stuck.length === 0) return;
  const lines = stuck.map(([file, r]) => `  ${file} (${r.state})${r.error ? `: ${r.error}` : ''}`);
  throw new Error(
    `Refusing to migrate: ${stuck.length} migration(s) started and never finished:\n${lines.join('\n')}\n\n`
    + 'MySQL commits DDL as it goes, so one of these may be PARTLY applied — retrying it would fail on\n'
    + 'whatever it already created, on every boot. Look at the schema, then pick one:\n'
    + `  node src/migrate.js --mark-applied ${stuck[0][0]}   # it did finish; record it and move on\n`
    + `  node src/migrate.js --retry ${stuck[0][0]}           # it did not; you have undone its partial work\n`
    + 'See docs/deploy-recovery.md.'
  );
}

// A migration file that changed after it was applied. Every database that ran
// the old bytes now differs from every database that will run the new ones, and
// nothing would ever say so. Files applied before checksums existed have no
// recorded hash; those are backfilled rather than failed, because there is no
// way to know retroactively what they contained.
async function assertNoDrift(conn, records) {
  const drifted = [];
  for (const [file, record] of records) {
    if (record.state !== 'applied') continue;
    const full = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(full)) continue; // a file deleted from the repo is not drift we can judge
    const actual = checksumOf(fs.readFileSync(full, 'utf8'));
    if (!record.checksum) {
      await conn.query('UPDATE schema_migrations SET checksum = ? WHERE filename = ?', [actual, file]);
      continue;
    }
    if (record.checksum !== actual) drifted.push(`  ${file} (recorded ${record.checksum.slice(0, 12)}…, on disk ${actual.slice(0, 12)}…)`);
  }
  if (drifted.length > 0) {
    throw new Error(
      `Refusing to migrate: ${drifted.length} already-applied migration(s) have been edited:\n${drifted.join('\n')}\n\n`
      + 'This database ran the old bytes; a fresh one would run the new ones, and the two would silently differ.\n'
      + 'Add a NEW numbered migration with the change instead. If the edit is provably cosmetic (a comment),\n'
      + 'record the new content: node src/migrate.js --accept-checksum <file>'
    );
  }
}

// Serialises the run against other replicas. Returns whatever fn() returns.
async function withMigrationLock(conn, fn) {
  const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_TIMEOUT_S]);
  if (Number(rows[0] && rows[0].got) !== 1) {
    throw new Error(
      `Another migration run has held the '${LOCK_NAME}' lock for more than ${LOCK_TIMEOUT_S}s. `
      + 'Nothing was applied. If no other deploy is running, a previous one was killed mid-migration — '
      + 'see docs/deploy-recovery.md.'
    );
  }
  try {
    return await fn();
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch { /* the connection is closing anyway */ }
  }
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort(); // lexicographic ordering — hence the zero-padded prefixes.
}

// Applies every migration in migrations/ that has not run yet, in order.
async function run() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true, // allow several statements per migration file
  });

  try {
    await withMigrationLock(conn, async () => {
      await ensureMigrationsTable(conn);
      const records = await appliedMigrations(conn);
      assertNoUnfinished(records);
      await assertNoDrift(conn, records);
      const pending = migrationFiles().filter((file) => !records.has(file));

      if (pending.length === 0) {
        console.info('No pending migrations.');
      } else {
        for (const file of pending) {
          const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
          console.info(`Applying migration: ${file}`);
          // The marker is written and COMMITTED before the SQL runs, which is
          // the whole point: a process killed mid-DDL leaves 'running' behind,
          // and the next boot stops and says so instead of replaying a file
          // that is already half in the schema.
          //
          // There is no transaction around this any more. There never really
          // was: MySQL commits DDL implicitly, so the old rollback() undid
          // nothing a migration file typically does — its only real effect was
          // to erase the one piece of evidence that the file had run at all.
          await conn.query(
            "INSERT INTO schema_migrations (filename, checksum, state) VALUES (?, ?, 'running')",
            [file, checksumOf(sql)]
          );
          try {
            await conn.query(sql);
          } catch (err) {
            await conn.query(
              "UPDATE schema_migrations SET state = 'failed', error = ? WHERE filename = ?",
              [String(err.message).slice(0, 2000), file]
            );
            throw new Error(
              `Migration ${file} failed: ${err.message}\n`
              + 'Whatever it managed to apply is still applied. It is recorded as failed, so the next\n'
              + 'boot will stop here rather than retry it — see docs/deploy-recovery.md.'
            );
          }
          await conn.query(
            "UPDATE schema_migrations SET state = 'applied', applied_at = NOW() WHERE filename = ?",
            [file]
          );
        }
        console.info(`Applied ${pending.length} migration(s).`);
      }

      await seedAdminIfNeeded(conn);
    });
  } finally {
    await conn.end();
  }
}

// The three operator commands for a migration that did not finish. Each one
// only ever touches the bookkeeping row — none of them runs or undoes SQL,
// because only the operator can know what the schema actually looks like.
async function resolve(action, file) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    await ensureMigrationsTable(conn);
    const full = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`No such migration file: ${file}`);
    const checksum = checksumOf(fs.readFileSync(full, 'utf8'));
    if (action === 'mark-applied' || action === 'accept-checksum') {
      const [res] = await conn.query(
        "UPDATE schema_migrations SET state = 'applied', checksum = ?, error = NULL WHERE filename = ?",
        [checksum, file]
      );
      if (res.affectedRows === 0) throw new Error(`${file} has no row in schema_migrations — nothing to resolve.`);
      console.info(`${file}: recorded as applied (checksum ${checksum.slice(0, 12)}…).`);
    } else if (action === 'retry') {
      const [res] = await conn.query('DELETE FROM schema_migrations WHERE filename = ?', [file]);
      if (res.affectedRows === 0) throw new Error(`${file} has no row in schema_migrations — nothing to resolve.`);
      console.info(`${file}: row removed; the next migrate run will apply it from the top.`);
      console.info('Make sure you have undone whatever it partly applied, or it will fail again.');
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    await conn.end();
  }
}

// Creates an initial admin user when none exists yet. Credentials come from
// the environment (SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD); if no password is
// configured, a strong one is generated and printed exactly once.
async function seedAdminIfNeeded(conn) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS count FROM users WHERE role = ?',
    [ROLES.ADMIN]
  );
  if (Number(rows[0].count) > 0) {
    return; // an admin already exists — nothing to do
  }

  const email = config.seedAdmin.email.trim().toLowerCase();
  let password = config.seedAdmin.password;
  const generated = !password;
  if (generated) {
    password = crypto.randomBytes(12).toString('base64url');
  }

  const passwordHash = await hashPassword(password);
  // password_changed_at stamped like every other write of password_hash (the
  // password max-age clock starts here, not at a created_at fallback).
  await conn.query(
    'INSERT INTO users (email, password_hash, password_changed_at, role) VALUES (?, ?, NOW(), ?)',
    [email, passwordHash, ROLES.ADMIN]
  );

  console.info(`Seeded initial admin user: ${email}`);
  if (generated) {
    console.info(`Generated admin password (shown once, store it now): ${password}`);
  }
}

if (require.main === module) {
  const [flag, file] = process.argv.slice(2);
  const action = /^--(mark-applied|retry|accept-checksum)$/.exec(flag || '');
  const task = action
    ? resolve(action[1], file || '')
    : run();
  task
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { run, resolve, checksumOf };
