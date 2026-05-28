'use strict';

// Loads configuration from environment variables (and a local .env file in
// development). Keeping all env access in one place makes the rest of the
// codebase easy to test and reason about.
require('dotenv').config();

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
};

module.exports = { config };
