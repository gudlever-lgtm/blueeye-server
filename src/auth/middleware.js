'use strict';

const { verifyToken } = require('./jwt');

// Optional synchronous revocation check, injected by the server at startup
// (createRevocationRegistry.isRevoked). Left null in tests and any context that
// doesn't wire it, so the default behaviour is unchanged.
let isRevoked = null;
function setRevocationCheck(fn) {
  isRevoked = typeof fn === 'function' ? fn : null;
}

// requireAuth — rejects the request with 401 unless it carries a valid
// `Authorization: Bearer <jwt>` header. On success it attaches the decoded
// identity to req.user.
//
// A trusted upstream authenticator (the API-token middleware) may already have
// populated req.user and set req.authVerified; in that case we accept it as-is.
// req.authVerified is set only by server code, never from client input, so this
// cannot be spoofed by a request header.
function requireAuth(req, res, next) {
  if (req.authVerified && req.user) return next();

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = verifyToken(token);
    // Reject tokens issued before the user's revocation cutoff (password/role
    // change, delete, explicit revoke). Synchronous, in-memory — no DB hit.
    if (isRevoked && isRevoked(Number(decoded.sub), decoded.iat)) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    req.user = {
      id: Number(decoded.sub),
      email: decoded.email,
      role: decoded.role,
      // True while the user still holds a one-time password and must change it
      // before using the rest of the system (see the gate in src/routes/index.js).
      mustChangePassword: decoded.mustChangePassword === true,
    };
    req.authVerified = true;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  return next();
}

// requireRole(...roles) — must run after requireAuth. Allows the request only
// when the authenticated user's role is one of the listed roles, otherwise 403.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', requiredRoles: roles });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole, setRevocationCheck };
