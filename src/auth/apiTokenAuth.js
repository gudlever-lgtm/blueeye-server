'use strict';

const { hashApiToken, looksLikeApiToken } = require('../lib/apiToken');

// Middleware that authenticates a programmatic API token (license feature
// `api_access`) and, on success, populates req.user exactly like the JWT path —
// so downstream requireAuth/requireRole work unchanged. Mounted ONCE in front of
// the API routers; it is a no-op when no API credential is presented (the JWT
// path then handles the request).
//
// A token is accepted from either:
//   - `X-API-Key: blueeye_…`
//   - `Authorization: Bearer blueeye_…`  (a JWT carries dots, so the two never collide)
//
// An API principal has no user id; it acts with the token's fixed role. We set
// req.authVerified so requireAuth trusts this upstream authentication.
function createApiTokenMiddleware({ apiTokensRepo }) {
  return function apiTokenAuth(req, res, next) {
    if (!apiTokensRepo) return next();

    const headerKey = req.headers['x-api-key'];
    const auth = req.headers.authorization || '';
    const [scheme, bearer] = auth.split(' ');
    let presented = null;
    if (typeof headerKey === 'string' && headerKey) presented = headerKey.trim();
    else if (scheme === 'Bearer' && looksLikeApiToken(bearer)) presented = bearer.trim();

    // No API credential → leave it for the JWT-based requireAuth.
    if (!presented || !looksLikeApiToken(presented)) return next();

    Promise.resolve(apiTokensRepo.findActiveByHash(hashApiToken(presented)))
      .then((row) => {
        if (!row) return res.status(401).json({ error: 'Invalid or revoked API token' });
        req.user = {
          id: null,
          email: `apitoken:${row.name}`,
          role: row.role,
          apiTokenId: row.id,
        };
        req.authVerified = true;
        // Best-effort "last used" stamp; never blocks or fails the request.
        Promise.resolve(apiTokensRepo.touch(row.id)).catch(() => {});
        return next();
      })
      .catch(next);
  };
}

module.exports = { createApiTokenMiddleware };
