'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { config } = require('./config');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Tracks which migration files have already been applied.
async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedMigrations(conn) {
  const [rows] = await conn.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
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
    await ensureMigrationsTable(conn);
    const applied = await appliedMigrations(conn);
    const pending = migrationFiles().filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.info('No pending migrations.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.info(`Applying migration: ${file}`);
      await conn.beginTransaction();
      try {
        await conn.query(sql);
        await conn.query(
          'INSERT INTO schema_migrations (filename) VALUES (?)',
          [file]
        );
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.info(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { run };
