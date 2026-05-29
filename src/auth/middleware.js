'use strict';

const { verifyToken } = require('./jwt');

// requireAuth — rejects the request with 401 unless it carries a valid
// `Authorization: Bearer <jwt>` header. On success it attaches the decoded
// identity to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = {
      id: Number(decoded.sub),
      email: decoded.email,
      role: decoded.role,
    };
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

module.exports = { requireAuth, requireRole };
