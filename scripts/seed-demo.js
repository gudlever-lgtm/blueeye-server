'use strict';

// DEV/DEMO ONLY — seeds a reusable enrollment code so an agent can self-enroll
// in the docker-compose demo. Gated by SEED_DEMO=1. Do NOT enable in production.
const mysql = require('mysql2/promise');
const { config } = require('../src/config');

async function run() {
  if (process.env.SEED_DEMO !== '1') {
    console.info('SEED_DEMO != 1 — skipping demo enrollment-code seed.');
    return;
  }
  const code = process.env.SEED_DEMO_ENROLLMENT_CODE || 'DEMO-ENROLL-CODE';

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    const [admins] = await conn.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    if (admins.length === 0) {
      console.warn('No admin user found yet — skipping demo enrollment code.');
      return;
    }
    // Upsert so the demo code is always fresh and unused after a (re)start.
    await conn.query(
      `INSERT INTO enrollment_codes (code, location_id, created_by, expires_at)
       VALUES (?, NULL, ?, DATE_ADD(NOW(), INTERVAL 3650 DAY))
       ON DUPLICATE KEY UPDATE used_at = NULL, expires_at = DATE_ADD(NOW(), INTERVAL 3650 DAY)`,
      [code, admins[0].id]
    );
    console.info(`Demo enrollment code ready: ${code}`);
  } finally {
    await conn.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Demo seed failed: ${err.message}`);
    process.exit(1);
  });
