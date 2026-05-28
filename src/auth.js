import config from './config.js';

// Role hierarchy: higher rank implies all privileges of lower ranks.
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

// Resolve the caller's role from an API key supplied via either
// `Authorization: Bearer <key>` or `X-API-Key: <key>`.
// Returns the role string, or null when no/unknown key is present.
export function resolveRole(req) {
  const header = req.get('authorization');
  let key;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    key = header.slice(7).trim();
  } else {
    key = req.get('x-api-key');
  }
  if (!key) return null;
  return config.apiKeys[key] ?? null;
}

// Express middleware factory enforcing a minimum role.
// `requireRole('viewer')` admits viewer/operator/admin, `'operator'` admits
// operator/admin, `'admin'` admits admin only. Responds 401 when the caller is
// unauthenticated and 403 when authenticated but under-privileged.
export function requireRole(minRole) {
  const required = ROLE_RANK[minRole];
  if (!required) {
    throw new Error(`requireRole: unknown role "${minRole}"`);
  }
  return (req, res, next) => {
    const role = resolveRole(req);
    if (!role) {
      return res.status(401).json({ error: 'authentication required' });
    }
    if (ROLE_RANK[role] < required) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    req.role = role;
    next();
  };
}
