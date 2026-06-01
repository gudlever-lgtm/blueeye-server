'use strict';

// Loads configuration from environment variables (and a local .env file in
// development). Keeping all env access in one place makes the rest of the
// codebase easy to test and reason about.
require('dotenv').config();
const path = require('path');
const { resolvePublicKey } = require('./license/publicKey');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'blueeye',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'blueeye',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },
  auth: {
    // NOTE: the default secret is for development only. server.js refuses to
    // start in production unless JWT_SECRET is set to something else.
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    jwtIssuer: process.env.JWT_ISSUER || 'blueeye-server',
    bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
  },
  // Initial admin, seeded by the migration runner if no admin exists yet.
  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@blueeye.local',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
  enrollment: {
    // Default lifetime of a new enrollment code, in minutes.
    defaultTtlMinutes: toInt(process.env.ENROLLMENT_CODE_TTL_MINUTES, 60),
  },
  ws: {
    // Agent live channel.
    path: process.env.WS_AGENT_PATH || '/ws/agent',
    heartbeatIntervalMs: toInt(process.env.WS_HEARTBEAT_MS, 30000),
  },
  // Client-side licensing against blueeye-licens. Set at installation (not CRUD).
  license: {
    key: process.env.LICENSE_KEY || '',
    serverId: process.env.LICENSE_SERVER_ID || '',
    serverUrl: process.env.LICENSE_SERVER_URL || '',
    publicKey: resolvePublicKey(),
    cachePath: process.env.LICENSE_CACHE_PATH || path.join(process.cwd(), '.license-cache.json'),
    graceDays: toInt(process.env.LICENSE_GRACE_DAYS, 14),
    intervalHours: toInt(process.env.LICENSE_VALIDATE_INTERVAL_HOURS, 6),
  },
  // Storage monitoring: the path to statfs for disk usage. Default the server's
  // data dir; point it at the drive holding the DB/Docker volume if different.
  storage: {
    diskPath: process.env.STORAGE_DISK_PATH || (process.env.LICENSE_CACHE_PATH ? path.dirname(process.env.LICENSE_CACHE_PATH) : process.cwd()),
  },
};

// The default JWT secret must never be used outside development.
const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';
config.auth.usingDefaultSecret = config.auth.jwtSecret === DEFAULT_JWT_SECRET;

module.exports = { config };
