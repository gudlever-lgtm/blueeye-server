'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { clientIp } = require('../services/complianceLogger');
const {
  validateSecurity, mergeSecurity, ipInList,
  PASSWORD_HISTORY_MAX, PASSWORD_MAX_AGE_MAX_DAYS, ALLOWLIST_MAX_PER_ROLE,
} = require('../auth/securityPolicy');

// /api/settings/security — the baseline security policy (migration 041):
// password history depth, the opt-in password max age and the role-based IP
// allowlist. Admin-only, never licence-gated (baseline security). Mounted in
// src/routes/index.js AHEAD of the general settings router.
//
// The address shown and checked is req.ip — the same one the request gate
// enforces against, so "your address" here is exactly what the gate will see.
function createAuthSecurityRouter({ settingsService, securityPolicy = null, auditLogger = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const limits = {
    passwordHistoryMax: PASSWORD_HISTORY_MAX,
    passwordMaxAgeMaxDays: PASSWORD_MAX_AGE_MAX_DAYS,
    allowlistMaxPerRole: ALLOWLIST_MAX_PER_ROLE,
  };

  router.get('/', asyncHandler(async (req, res) => {
    const policy = await settingsService.getSecurity();
    res.json({ ...policy, yourIp: clientIp(req), limits });
  }));

  // PUT — a partial patch. Refused (409, nothing saved) when the resulting
  // ADMIN allowlist would not contain the address this request comes from:
  // saving it would end the admin's own session on the next request and leave
  // nobody able to undo it from the dashboard.
  router.put('/', asyncHandler(async (req, res) => {
    const { errors, value } = validateSecurity(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const next = mergeSecurity(await settingsService.getSecurity(), value);
    const ip = clientIp(req);
    const adminList = next.ipAllowlist[ROLES.ADMIN];
    if (adminList.length && !ipInList(ip, adminList)) {
      if (auditLogger) {
        await auditLogger.record(req, {
          category: 'security', action: 'security_settings_update', outcome: 'denied',
          target: 'security', detail: 'refused: the admin allowlist would exclude the saving admin\'s own address',
        });
      }
      return res.status(409).json({
        error: 'allowlist_excludes_you',
        message: `Your current address (${ip || 'unknown'}) is not in the admin allowlist you are saving, so saving it would lock you out. Add your address or network to the admin list first.`,
        messageKey: 'set.sec.err.selfLockout',
        messageParams: { ip: ip || '?' },
        yourIp: ip,
      });
    }

    const saved = await settingsService.setSecurity(value);
    if (securityPolicy && typeof securityPolicy.set === 'function') securityPolicy.set(saved);
    if (auditLogger) {
      const counts = Object.entries(saved.ipAllowlist).map(([r, l]) => `${r}:${l.length}`).join(',');
      await auditLogger.record(req, {
        category: 'security', action: 'security_settings_update', outcome: 'success', target: 'security',
        detail: `history=${saved.passwordHistory}, maxAgeDays=${saved.passwordMaxAgeDays}, allowlist=${counts}`,
      });
    }
    res.json({ ...saved, yourIp: ip, limits });
  }));

  return router;
}

module.exports = { createAuthSecurityRouter };
