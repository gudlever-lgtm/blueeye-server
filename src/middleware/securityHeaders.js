'use strict';

// Always-on security response headers. This is BASELINE product security, not a
// licence-gated feature — it is mounted unconditionally in src/app.js and cannot
// be switched off via any feature key. Applied to every response (static
// dashboard + JSON API alike).
//
// The Content-Security-Policy is deliberately tuned to the existing
// dependency-free dashboard so it hardens without breaking it:
//   - script-src / style-src allow https://unpkg.com because public/index.html
//     loads Leaflet (map) from that CDN; 'self' covers /app.js + /styles.css.
//   - style-src keeps 'unsafe-inline' (the SPA builds DOM with inline styles).
//   - img-src / connect-src / font-src allow https: + data: + blob: so the
//     operator-configurable EU/self-hosted map tiles + geocoder keep working
//     (the tile origin is set at runtime in Settings → Map, so it can't be
//     pinned here without breaking custom tiles).
//   - the dangerous directives stay strict: object-src 'none',
//     frame-ancestors 'none', base-uri 'self', form-action 'self'.
function buildCsp() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "font-src 'self' data: https:",
    "connect-src 'self' https:",
  ].join('; ');
}

// `hstsMaxAge` of 0 disables the Strict-Transport-Security header (e.g. for a
// plain-HTTP lab); it defaults to one year with includeSubDomains. The header is
// harmless over HTTP — browsers only honour it on HTTPS — so it is set always.
function securityHeaders({ hstsMaxAge = 31536000 } = {}) {
  const csp = buildCsp();
  return function applySecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (hstsMaxAge > 0) {
      res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`);
    }
    next();
  };
}

module.exports = { securityHeaders, buildCsp };
