import config from './config.js';

// Role hierarchy, ascending privilege. A role satisfies a requirement if its
// index is >= the required role's index (admin satisfies everything).
export const ROLES = ['viewer', 'operator', 'admin'];

function extractApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return null;
}

/**
 * Resolve the caller's role from their API key and attach it to `req.auth`.
 * Does not reject unauthenticated requests — that is `requireRole`'s job — so
 * read endpoints stay open and the role is available where it is enforced.
 */
export function authenticate(req, res, next) {
  const key = extractApiKey(req);
  if (key && config.apiKeys.has(key)) {
    req.auth = { key, role: config.apiKeys.get(key) };
  }
  next();
}

/**
 * Guard a route so only callers with at least `minRole` may proceed.
 * 401 when unauthenticated, 403 when the role is insufficient.
 */
export function requireRole(minRole) {
  const minIdx = ROLES.indexOf(minRole);
  if (minIdx < 0) throw new Error(`unknown role: ${minRole}`);
  return (req, res, next) => {
    const role = req.auth?.role;
    if (!role) {
      return res.status(401).json({ error: 'authentication required' });
    }
    const idx = ROLES.indexOf(role);
    if (idx < 0 || idx < minIdx) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    next();
  };
}
