'use strict';

const crypto = require('crypto');
const { ROLES } = require('./roles');
const { hashPassword } = require('./password');

// Shared just-in-time provisioning for EXTERNAL-auth identities (LDAP/AD, OIDC,
// SAML). Finds — or creates — the local user backing an external identity so the
// SAME JWT is issued (sub = local user id) and the rest of the system (/me, audit
// FKs, the users list) sees no difference between a local and a federated login.
//
// The external directory/IdP is the source of truth for the role: an existing
// (non-protected) user's role is realigned to the freshly-asserted one, while a
// protected super-admin is NEVER demoted (so a misconfigured group map can't lock
// the owner out of admin). The local password is left as an unusable random hash
// — federated users authenticate through their IdP, not local login.
function createUserProvisioner({ usersRepo }) {
  if (!usersRepo) throw new Error('createUserProvisioner requires usersRepo');

  async function provision({ email, role }) {
    const existing = await usersRepo.findByEmail(email);
    if (existing) {
      if (existing.protected) return { id: existing.id, email: existing.email, role: ROLES.ADMIN };
      if (existing.role !== role) {
        try { await usersRepo.update(existing.id, { role }); } catch { /* best-effort */ }
      }
      return { id: existing.id, email: existing.email, role };
    }
    // Unusable random password — the IdP is this user's auth path, not local login.
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
    try {
      return await usersRepo.create({ email, passwordHash, role });
    } catch {
      // Lost a create race (unique email) — re-read the now-existing row.
      const again = await usersRepo.findByEmail(email);
      if (again) return { id: again.id, email: again.email, role: again.protected ? ROLES.ADMIN : role };
      throw new Error('could not provision external user');
    }
  }

  return { provision };
}

module.exports = { createUserProvisioner };
