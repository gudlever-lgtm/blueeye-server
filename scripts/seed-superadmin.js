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
const { hashPassword } = require('../src/auth/password');

// The upsert, on an open connection (a test hands it a fake). The password is
// new on both paths, so password_changed_at (migration 041) is stamped on both:
// with a password max age on, a reset that left the old stamp in place would
// hand back a password already past its age — the break-glass admin locked
// out by the very reset meant to let it in. The same rule as every write of
// password_hash in usersRepository.
async function upsertSuperadmin(conn, { email, passwordHash }) {
  await conn.query(
    `INSERT INTO users (email, password_hash, password_changed_at, role, protected)
     VALUES (?, ?, NOW(), 'admin', 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), password_changed_at = NOW(),
       role = 'admin', protected = 1`,
    [email, passwordHash]
  );
}

async function run() {
  const mysql = require('mysql2/promise');
  const { config } = require('../src/config');
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
    await upsertSuperadmin(conn, { email, passwordHash });
    console.info(`Super-admin ready: ${email} (protected — cannot be demoted/deleted, password change only).`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Super-admin seed failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { upsertSuperadmin };
