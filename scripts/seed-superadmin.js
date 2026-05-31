'use strict';

// Creates (or updates) the protected super-admin user. Run once after migrating:
//   node scripts/seed-superadmin.js
//
// Defaults to admin@blueeye.local / gr34tb4lls (override with env):
//   SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
//
// The user is marked `protected` so it is always an admin and can't be demoted
// or deleted via the API/dashboard — only its password can be changed. Re-running
// resets the password to SUPERADMIN_PASSWORD and re-asserts admin+protected.
const mysql = require('mysql2/promise');
const { config } = require('../src/config');
const { hashPassword } = require('../src/auth/password');

async function run() {
  const email = (process.env.SUPERADMIN_EMAIL || 'admin@blueeye.local').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || 'gr34tb4lls';
  const passwordHash = await hashPassword(password);

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    await conn.query(
      `INSERT INTO users (email, password_hash, role, protected)
       VALUES (?, ?, 'admin', 1)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', protected = 1`,
      [email, passwordHash]
    );
    console.info(`Super-admin ready: ${email} (protected — cannot be demoted/deleted, password change only).`);
  } finally {
    await conn.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Super-admin seed failed: ${err.message}`);
    process.exit(1);
  });
