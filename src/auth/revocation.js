'use strict';

// Eventually-consistent JWT revocation, designed so the hot requireAuth path
// stays synchronous and does NO per-request DB work. The registry periodically
// loads the (small) set of users with a non-NULL tokens_valid_after into memory;
// requireAuth then rejects any token whose `iat` predates that instant.
//
// Trade-off: a revocation takes effect within `intervalMs` (default 10s), not
// instantly. That window is acceptable for deprovisioning/password-change and
// avoids a DB read on every authenticated request. State is durable across
// restarts because it is reloaded from the users table.
function createRevocationRegistry({ usersRepo, intervalMs = 10000, logger = console } = {}) {
  const validAfter = new Map(); // userId -> epoch ms before which tokens are invalid
  let timer = null;

  async function load() {
    if (typeof usersRepo.findRevocations !== 'function') return;
    try {
      const rows = await usersRepo.findRevocations();
      const next = new Map();
      for (const r of rows) {
        const t = r && r.tokens_valid_after ? new Date(r.tokens_valid_after).getTime() : NaN;
        if (Number.isFinite(t)) next.set(Number(r.id), t);
      }
      validAfter.clear();
      for (const [k, v] of next) validAfter.set(k, v);
    } catch (err) {
      // Fail open on a transient DB error: keep the last-known map rather than
      // locking everyone out (matches the no-revocation behaviour before this).
      if (logger && logger.error) logger.error('Revocation reload failed:', err.message);
    }
  }

  // Synchronous check used by requireAuth. `iatSeconds` is the JWT `iat` claim.
  function isRevoked(userId, iatSeconds) {
    const cut = validAfter.get(Number(userId));
    if (!cut) return false;
    if (typeof iatSeconds !== 'number') return true; // no iat but user has a cutoff → reject
    // iat is whole seconds; allow the same second to avoid edge rejections.
    return iatSeconds * 1000 < cut - 1000;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { load(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { load, isRevoked, start, stop };
}

module.exports = { createRevocationRegistry };
