// Lightweight role-based access control.
//
// The caller's role is supplied via the `X-Role` request header. Roles are
// hierarchical: a higher role satisfies any requirement met by a lower one.
//
//   viewer   — read-only access
//   operator — viewer + create/update
//   admin    — operator + delete
//
// Enforcement is deny-by-default: a missing or unrecognised role yields 401,
// and a known-but-insufficient role yields 403.

export const ROLE_LEVELS = { viewer: 1, operator: 2, admin: 3 };

export function roleLevel(role) {
  return ROLE_LEVELS[String(role ?? '').trim().toLowerCase()] ?? 0;
}

export function requireRole(minRole) {
  const required = ROLE_LEVELS[minRole];
  if (!required) {
    throw new Error(`requireRole: unknown role "${minRole}"`);
  }
  return (req, res, next) => {
    const level = roleLevel(req.get('x-role'));
    if (level === 0) {
      return res.status(401).json({ error: 'missing or invalid role' });
    }
    if (level < required) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    next();
  };
}
