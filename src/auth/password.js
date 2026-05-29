'use strict';

// Password hashing. We use bcrypt (via the pure-JS `bcryptjs`) so the server
// has no native build step and stays portable across on-prem hosts. The two
// functions below are the only place the algorithm is referenced, so swapping
// in argon2 later would not touch any caller.
const bcrypt = require('bcryptjs');
const { config } = require('../config');

// Hashes a plaintext password. Returns a self-describing hash string that
// already embeds the salt and cost factor.
async function hashPassword(plain, rounds = config.auth.bcryptRounds) {
  return bcrypt.hash(plain, rounds);
}

// Verifies a plaintext password against a stored hash. Never throws on a
// missing/invalid hash — it simply returns false.
async function verifyPassword(plain, hash) {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
