'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { config } = require('./config');
const { hashPassword } = require('./auth/password');
const { ROLES } = require('./auth/roles');

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
    } else {
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
    }

    await seedAdminIfNeeded(conn);
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
  await conn.query(
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
    [email, passwordHash, ROLES.ADMIN]
  );

  console.info(`Seeded initial admin user: ${email}`);
  if (generated) {
    console.info(`Generated admin password (shown once, store it now): ${password}`);
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
