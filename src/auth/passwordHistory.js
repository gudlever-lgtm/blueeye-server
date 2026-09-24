'use strict';

const { verifyPassword } = require('./password');

// Password history (migration 041, control 1): a LOCAL password may not be one
// of the user's last N passwords (the current one counts), N = security.passwordHistory
// (default 5, 0 = off). Every path that sets a local password goes through
// here — self-service change, the forced first-login change and an admin's
// reset in Users — and so does recording the new hash afterwards.
//
// What is deliberately NOT here: one-time passwords (random, server-generated,
// replaced at first login) and the unusable random hash an LDAP/OIDC/SAML user
// is provisioned with. Neither is a password a person chose, so neither is
// compared against nor remembered.
//
// The comparison is bcrypt against each stored hash — the history holds hashes
// only, so there is no faster way and no plaintext anywhere.

// The 400 body a refused reuse answers with. `messageKey` is the dashboard's
// translation key (public/i18n.js) so the UI can say it in the user's language;
// `field` names the input the error belongs to.
function passwordReusedBody(depth, field = 'newPassword') {
  const message = `That password is one of your last ${depth} passwords. Choose a different one.`;
  return {
    error: 'password_reused',
    message,
    messageKey: 'auth.pw.reused',
    messageParams: { n: depth },
    details: { [field]: message },
  };
}

function createPasswordHistory({ passwordHistoryRepo = null, securityPolicy = null, verify = verifyPassword, logger = null } = {}) {
  async function depth() {
    if (!securityPolicy || typeof securityPolicy.get !== 'function') return 0;
    const policy = await securityPolicy.get();
    return Number.isInteger(policy.passwordHistory) ? policy.passwordHistory : 0;
  }

  // { ok: true } when `plain` may be used, or { ok: false, depth } when it
  // matches the current hash or one of the last `depth` remembered ones. The
  // current hash is checked explicitly because an account from before this
  // control has no history yet; once it does, the newest row IS the current
  // password, so the window is the last N including the one in use.
  async function checkReuse(userId, plain, { currentHash = null } = {}) {
    const n = await depth();
    if (n <= 0) return { ok: true, depth: 0 };
    const hashes = [];
    if (currentHash) hashes.push(currentHash);
    if (passwordHistoryRepo && userId !== null && userId !== undefined) {
      hashes.push(...await passwordHistoryRepo.recentHashes(userId, n));
    }
    for (const h of [...new Set(hashes)]) {
      if (await verify(plain, h)) return { ok: false, depth: n };
    }
    return { ok: true, depth: n };
  }

  // Remembers a newly-set hash and trims the user's history to the policy
  // depth (0 = keep nothing, so switching the control off also forgets). Best
  // effort: the password has already been changed when this runs, and failing
  // the request now would tell the user it was not.
  async function remember(userId, passwordHash) {
    if (!passwordHistoryRepo || userId === null || userId === undefined) return;
    try {
      const n = await depth();
      if (n > 0) await passwordHistoryRepo.record(userId, passwordHash);
      await passwordHistoryRepo.prune(userId, n);
    } catch (err) {
      if (logger && logger.warn) logger.warn(`password history: could not record for user ${userId} (${err.message})`);
    }
  }

  return { checkReuse, remember, depth };
}

module.exports = { createPasswordHistory, passwordReusedBody };
