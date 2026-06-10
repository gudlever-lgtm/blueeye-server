'use strict';

const crypto = require('crypto');

// API tokens for programmatic access (license feature `api_access`). The token
// is shown to the operator exactly once at creation; only its SHA-256 hash is
// stored, so a database read can never recover a usable token.
//
//   const { token, hash, prefix } = generateApiToken();
//   // hand `token` to the user once; persist `hash` + `prefix`.
//   hashApiToken(token) === hash // for lookup on each request
const PREFIX = 'blueeye_';

// A presented credential looks like an API token (vs. a JWT, which has dots).
function looksLikeApiToken(value) {
  return typeof value === 'string' && value.startsWith(PREFIX) && !value.includes('.');
}

function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// Mints a new token: 32 bytes of CSPRNG randomness, base64url-encoded, prefixed.
// Returns the plaintext token (return to user once), its hash (store) and a
// short display prefix (store, safe to show in lists).
function generateApiToken() {
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${PREFIX}${secret}`;
  return {
    token,
    hash: hashApiToken(token),
    prefix: token.slice(0, PREFIX.length + 6), // e.g. "blueeye_AbC123"
  };
}

module.exports = { generateApiToken, hashApiToken, looksLikeApiToken, API_TOKEN_PREFIX: PREFIX };
