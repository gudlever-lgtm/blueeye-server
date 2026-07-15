'use strict';

// Generates the cryptographically-secure one-time password that an admin issues
// when creating a local user (src/routes/users.js POST /users/local). It is sent
// to the user by email exactly once, hashed with bcrypt before storage, and must
// be changed on first login.
//
// Requirements:
//   - unpredictable: every character is drawn from crypto.randomBytes via a
//     rejection-sampled index (no modulo bias), never Math.random.
//   - long: at least TEMP_PASSWORD_LENGTH (default 20) characters — well above
//     the 16-char minimum in the spec and the 12-char baseline policy.
//   - policy-satisfying: guaranteed to contain a lower-case letter, an upper-case
//     letter, a digit and a symbol, so it also passes checkPasswordPolicy (a temp
//     password that couldn't itself be entered would be a footgun).
const crypto = require('crypto');

// Ambiguous glyphs (0/O, 1/l/I) are deliberately excluded so a user typing the
// password from an email misreads it less often. Symbols are limited to a safe,
// widely-supported set that survives copy/paste and shell/URL contexts.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '!@#$%*-_=+';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

const TEMP_PASSWORD_LENGTH = 20;

// Unbiased random integer in [0, max) using rejection sampling over whole bytes.
function randomInt(max) {
  if (max <= 0) return 0;
  const limit = Math.floor(256 / max) * max; // largest multiple of max <= 256
  let byte;
  do {
    byte = crypto.randomBytes(1)[0];
  } while (byte >= limit);
  return byte % max;
}

function pick(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

// Fisher–Yates shuffle driven by the same unbiased RNG, so the guaranteed
// class characters aren't always in a fixed position.
function shuffle(chars) {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

// Returns a fresh one-time password string of `length` characters (min 16).
function generateTempPassword(length = TEMP_PASSWORD_LENGTH) {
  const len = Math.max(16, Number.isInteger(length) ? length : TEMP_PASSWORD_LENGTH);
  // Seed one of each required class so the result always meets the policy.
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < len) chars.push(pick(ALL));
  return shuffle(chars).join('');
}

module.exports = { generateTempPassword, TEMP_PASSWORD_LENGTH };
