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
