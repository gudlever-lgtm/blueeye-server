'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');

const ALGORITHM = 'HS256';

// Issues a signed JWT for a user. The token carries the minimum needed to
// authorize subsequent requests: the user id (sub), email and role.
function issueToken(user) {
  const payload = {
    email: user.email,
    role: user.role,
  };
  // Flag a token minted for a user who still holds a one-time password. The
  // global gate (src/routes/index.js) blocks every route except the
  // change-password flow until the flag is gone. Only set when true so ordinary
  // tokens stay byte-for-byte identical to before.
  if (user.mustChangePassword) payload.mustChangePassword = true;
  // When the LOCAL password behind this session was set (epoch seconds). Only
  // the local-password sign-in paths pass it — SSO/LDAP sessions and API tokens
  // never carry it — and it is what lets the security gate enforce the (opt-in)
  // password max age on every request without a database read. A token without
  // it is never treated as expired.
  if (user.passwordSetAt) {
    const ms = user.passwordSetAt instanceof Date ? user.passwordSetAt.getTime() : new Date(user.passwordSetAt).getTime();
    if (Number.isFinite(ms)) payload.pwdAt = Math.floor(ms / 1000);
  }
  return jwt.sign(payload, config.auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: String(user.id),
    expiresIn: config.auth.jwtExpiresIn,
    issuer: config.auth.jwtIssuer,
  });
}

// Verifies and decodes a token. Throws if the token is missing, malformed,
// expired or signed with the wrong key/algorithm — the caller turns that into
// a 401. Pinning the algorithm guards against algorithm-confusion attacks.
function verifyToken(token) {
  return jwt.verify(token, config.auth.jwtSecret, {
    algorithms: [ALGORITHM],
    issuer: config.auth.jwtIssuer,
  });
}

module.exports = { issueToken, verifyToken };
