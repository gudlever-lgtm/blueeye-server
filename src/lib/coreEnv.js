'use strict';

// The two pieces of configuration that a process needs whether or not it is the
// API server: how to reach the database, and the key that secrets are encrypted
// with. `src/config.js` builds them here rather than inline, so the Service
// Assurance worker can read the SAME values without requiring the server's whole
// config module — which pulls in licensing, the trust anchor and the machine
// fingerprint, none of which exist in the worker image (docs/service-assurance.md
// §7: the worker ships with the module's files, not the server's).
//
// Duplicating the parsing in the worker would have been shorter and would drift
// the first time a default changed. One definition, two readers.

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// MySQL connection settings, shaped for src/db.js `createDb`.
function dbConfig(env = process.env) {
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: toInt(env.DB_PORT, 3306),
    user: env.DB_USER || 'blueeye',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'blueeye',
    connectionLimit: toInt(env.DB_CONNECTION_LIMIT, 10),
  };
}

// Symmetric key for secrets at rest (src/lib/secretBox.js). Falls back to
// JWT_SECRET so existing deployments need no new variable — and the API and the
// worker MUST resolve it identically, or the worker cannot decrypt the logins
// the API stored.
function securityConfig(env = process.env) {
  return {
    secretKey: env.SECRET_ENCRYPTION_KEY || env.JWT_SECRET || 'dev-insecure-secret-change-me',
  };
}

module.exports = { dbConfig, securityConfig, toInt };
