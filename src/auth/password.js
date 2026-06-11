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

// Baseline password policy — ALWAYS ENFORCED, never behind a licence feature
// key. A new or changed password must be at least PASSWORD_MIN_LENGTH chars,
// no more than 72 (bcrypt only considers the first 72 bytes), and draw on at
// least PASSWORD_MIN_CLASSES of the four character classes (lower / upper /
// digit / symbol) so a long-but-trivial string ("aaaaaaaaaaaa") is rejected.
// Routes surface a violation as HTTP 422 (distinct from a 400 type/shape error).
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 72;
const PASSWORD_MIN_CLASSES = 3;

function characterClasses(plain) {
  return {
    lower: /[a-z]/.test(plain),
    upper: /[A-Z]/.test(plain),
    digit: /[0-9]/.test(plain),
    symbol: /[^A-Za-z0-9]/.test(plain),
  };
}

// Returns { ok: true } or { ok: false, errors: [..] }. Pure + synchronous so it
// is trivially unit-testable and callable from any route or validator.
function checkPasswordPolicy(plain) {
  const errors = [];
  if (typeof plain !== 'string') {
    return { ok: false, errors: ['password must be a string'] };
  }
  if (plain.length < PASSWORD_MIN_LENGTH) {
    errors.push(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    errors.push(`password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const classes = characterClasses(plain);
  const used = Object.values(classes).filter(Boolean).length;
  if (used < PASSWORD_MIN_CLASSES) {
    errors.push(
      `password must include at least ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, digit, symbol`
    );
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_CLASSES,
};
