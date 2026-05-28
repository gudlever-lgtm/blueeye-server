import { verify } from './jwt.js';

// Verifies a Bearer JWT and attaches the decoded payload to req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    return res.status(401).json({ error: 'missing or malformed Authorization header' });
  }
  try {
    req.user = verify(match[1]);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

// Guards a route so only the listed roles may proceed. Must run after requireAuth.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
