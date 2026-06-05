'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { generateEnrollmentCode } = require('../auth/tokens');
const { parseId } = require('../validation/locationValidation');
const { resolveServerUrl } = require('./enroll');
const { config } = require('../config');

// Default platform offered when the caller doesn't specify one and we can't
// infer it from the published artifacts.
const FALLBACK_PLATFORM = 'linux-amd64';
const PLATFORM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const MAX_USES = 1000;
const MAX_TTL_MINUTES = 30 * 24 * 60;

function isExpired(row) {
  return row && row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
}

// Authenticated (operator/admin) helper that turns an enrollment code into a
// ready-to-run install command — shown in the UI. Builds three variants the
// user can choose between: a one-liner, and a manual download + checksum +
// command. serverUrl and checksum always come from the server, never the client.
//
// GET /api/enroll/command?platform=&codeId=&maxUses=&ttlMinutes=&locationId=
//   - codeId given  -> reuse that (active) code.
//   - codeId absent -> mint a new code via the existing code flow (bulk-capable
//     via maxUses + ttlMinutes).
function createEnrollCommandRouter({ enrollmentCodesRepo, artifactStore, sourceStore, enrollConfig = {} }) {
  const router = express.Router();
  const certFingerprint = enrollConfig.certFingerprint || '';

  router.get(
    '/command',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // Platform: validate the slug; fall back to a published one (or the
      // conventional default) so the UI always has something to show.
      let platform = req.query.platform ? String(req.query.platform) : '';
      if (platform && !PLATFORM_RE.test(platform)) {
        return res.status(400).json({ error: 'platform must look like linux-amd64' });
      }
      const available = artifactStore ? artifactStore.list().map((a) => a.platform) : [];
      if (!platform) platform = available[0] || FALLBACK_PLATFORM;

      let code;
      let expiresAt;
      let maxUses = 1;
      let usesRemaining = 1;

      if (req.query.codeId !== undefined) {
        const id = parseId(req.query.codeId);
        if (id === null) return res.status(400).json({ error: 'codeId must be a positive integer' });
        const row = await enrollmentCodesRepo.findById(id);
        if (!row) return res.status(404).json({ error: 'Enrollment code not found' });
        if (row.status === 'expired' || isExpired(row)) return res.status(410).json({ error: 'Enrollment code has expired' });
        if (row.status === 'used' || (row.uses_remaining != null && row.uses_remaining <= 0)) {
          return res.status(410).json({ error: 'Enrollment code is exhausted' });
        }
        code = row.code;
        expiresAt = row.expires_at;
        maxUses = row.max_uses ?? 1;
        usesRemaining = row.uses_remaining ?? maxUses;
      } else {
        // Mint a new code (optionally a bulk code: N uses within a TTL window).
        let uses = 1;
        if (req.query.maxUses !== undefined) {
          const n = Number(req.query.maxUses);
          if (!Number.isInteger(n) || n < 1 || n > MAX_USES) {
            return res.status(400).json({ error: `maxUses must be an integer between 1 and ${MAX_USES}` });
          }
          uses = n;
        }
        let ttl = config.enrollment.defaultTtlMinutes;
        if (req.query.ttlMinutes !== undefined) {
          const t = Number(req.query.ttlMinutes);
          if (!Number.isInteger(t) || t < 1 || t > MAX_TTL_MINUTES) {
            return res.status(400).json({ error: `ttlMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}` });
          }
          ttl = t;
        }
        let locationId = null;
        if (req.query.locationId !== undefined && req.query.locationId !== '') {
          locationId = parseId(req.query.locationId);
          if (locationId === null) return res.status(400).json({ error: 'locationId must be a positive integer' });
        }
        const created = await enrollmentCodesRepo.create({
          code: generateEnrollmentCode(),
          location_id: locationId,
          created_by: req.user.id,
          expiresInMinutes: ttl,
          maxUses: uses,
        });
        code = created.code;
        expiresAt = created.expires_at;
        maxUses = created.max_uses ?? uses;
        usesRemaining = created.uses_remaining ?? uses;
      }

      const serverUrl = resolveServerUrl(req, enrollConfig);
      const oneLiner = `curl -sSL ${serverUrl}/enroll/${code}/install.sh | sh`;
      // The installer downloads + verifies the agent SOURCE bundle, then builds +
      // runs it (Docker/Node) — no pre-built binary. The manual block lets a
      // cautious operator inspect the bundle + its checksum before running.
      const checksum = sourceStore ? sourceStore.sha256 : null;

      res.json({
        oneLiner,
        manual: {
          downloadUrl: `${serverUrl}/enroll/agent-source.tgz`,
          checksum,
          command: oneLiner,
        },
        code,
        platform,
        platforms: available,
        certFingerprint: certFingerprint || null,
        maxUses,
        usesRemaining,
        expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
      });
    })
  );

  return router;
}

module.exports = { createEnrollCommandRouter };
