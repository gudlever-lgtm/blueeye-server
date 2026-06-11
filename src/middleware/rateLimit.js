'use strict';

// A tiny dependency-free fixed-window rate limiter for brute-force-sensitive
// endpoints (login, enrollment, license validation). In-memory and per-process
// — adequate for the on-prem single-node deployment; front it with the reverse
// proxy's limiter for multi-node. Returns 429 with a Retry-After once a key
// exceeds `max` hits within `windowMs`.
//
// `keyFn(req)` selects the bucket (default: client IP). `now` is injectable for
// tests. Stale buckets are pruned lazily on access plus on a periodic sweep.
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10, keyFn, now = Date.now } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  const getKey = typeof keyFn === 'function' ? keyFn : (req) => req.ip || 'unknown';

  // Periodic sweep so the map can't grow unbounded under churn of distinct keys.
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) {
      if (v.resetAt <= t) hits.delete(k);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  function middleware(req, res, next) {
    const key = getKey(req);
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    return next();
  }

  middleware.stop = () => clearInterval(sweep);
  middleware.reset = () => hits.clear();
  return middleware;
}

// A passthrough used as the default when no limiter is injected (e.g. in tests).
function noopRateLimiter(req, res, next) {
  next();
}

module.exports = { createRateLimiter, noopRateLimiter };
