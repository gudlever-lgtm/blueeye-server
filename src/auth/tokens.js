'use strict';

const crypto = require('crypto');

// Opaque secrets for agents are plain high-entropy random strings (NOT JWTs).
// Because they are high-entropy we can store a fast SHA-256 hash and look the
// token up directly — unlike low-entropy passwords, which need bcrypt.

// A random, URL-safe enrollment code (~192 bits of entropy).
function generateEnrollmentCode() {
  return crypto.randomBytes(24).toString('base64url');
}

// A random, URL-safe opaque agent token (~256 bits of entropy).
function generateAgentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Deterministic hash used to store/look up a token. Returns 64 hex chars.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateEnrollmentCode, generateAgentToken, hashToken };
