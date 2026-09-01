'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { generateEnrollmentCode } = require('../auth/tokens');
const { parseId } = require('../validation/locationValidation');
const { resolveServerUrl } = require('./enroll');
const { winRunSteps } = require('../enroll/installScriptWin');

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
//
// GET /api/enroll/update-command?platform=windows-amd64 is the sibling for an
// EXISTING agent: an update-in-place one-liner with no enrollment code in it.
function createEnrollCommandRouter({ enrollmentCodesRepo, artifactStore, sourceStore, enrollConfig = {}, releaseKeyService = null, defaultTtlMinutes = 120 }) {
  const router = express.Router();
  const certFingerprint = enrollConfig.certFingerprint || '';

  router.get(
    '/command',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // Gate: a new agent can't be onboarded until the agent signing key exists — it
      // is the trust anchor for secure agent management (signed self-updates). The
      // admin generates it under Settings → Agent signing key first.
      if (releaseKeyService && !releaseKeyService.isConfigured()) {
        return res.status(409).json({
          error: 'No agent signing key is set. Generate it under Settings → Agent signing key before adding agents.',
          code: 'NO_RELEASE_KEY',
        });
      }

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
        // The code is decrypted from `code_enc`. It comes back null when the row
        // predates migration 076 and its cleartext has already been stripped, or
        // when no secret box is configured — tell the operator to mint a new one
        // rather than rendering a command with an empty code in it.
        if (!row.code) {
          return res.status(409).json({ error: 'This enrollment code can no longer be displayed; generate a new one' });
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
        let ttl = defaultTtlMinutes;
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
      // Windows PowerShell cannot run `curl -sSL … | sh` (curl is an alias for
      // Invoke-WebRequest with different flags, and there is no `sh`), so Windows
      // hosts get a PowerShell command of their own. Linux and macOS both have real
      // curl + sh, so they share the sh installer.
      const isWindows = /^windows(-|$)/.test(platform);
      // The Windows command downloads install.ps1 to a file and runs the file — it
      // is deliberately not `irm … | iex` (see winRunSteps: that shape is what IPS
      // and endpoint AV flag as a PowerShell stager, on the wire and on the host).
      // It carries a TLS-1.2 + (when known) cert-pinning prelude so the download
      // works against an on-prem HTTPS server with a self-signed cert, which
      // PowerShell 5.1 would otherwise reject.
      const winSteps = isWindows
        ? winRunSteps({ serverUrl, path: `/enroll/${code}/install.ps1`, fileName: 'blueeye-install.ps1', certFingerprint })
        : null;
      const oneLiner = winSteps
        ? winSteps.oneLiner
        : `curl -sSL ${serverUrl}/enroll/${code}/install.sh | sh`;
      // The installer downloads + verifies the agent SOURCE bundle, then builds +
      // runs it (Docker/Node) — no pre-built binary. The manual block lets a
      // cautious operator inspect the bundle + its checksum before running.
      const checksum = sourceStore ? sourceStore.sha256 : null;

      res.json({
        oneLiner,
        // The same command split in two, so the dashboard can show "download" and
        // "run" as separate steps (and an operator can inspect the script in
        // between). Windows only — Linux/macOS already have the manual block below.
        steps: winSteps ? { download: winSteps.download, run: winSteps.run, scriptUrl: winSteps.url, scriptFile: winSteps.file } : null,
        os: isWindows ? 'windows' : (/^darwin(-|$)/.test(platform) ? 'macos' : 'linux'),
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

  // The UPDATE command for an agent the server cannot upgrade with one click.
  // Windows agents run under a Scheduled Task (managed 'unmanaged'), so the pushed
  // `update` command is declined on the host — the operator upgrades from the host
  // instead. This returns the one-liner to do that: it updates the agent IN PLACE
  // and carries NO enrollment code, so it can only ever upgrade the agent already
  // on that machine — never install a second one.
  //
  // GET /api/enroll/update-command?platform=windows-amd64
  //   -> { os, oneLiner, version, manual: { downloadUrl, checksum, command } }
  // 400 for a non-Windows platform: systemd agents update with one click from the
  // dashboard and Docker agents are rebuilt by their host, so neither has (or
  // needs) an update-in-place one-liner.
  router.get(
    '/update-command',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const platform = req.query.platform ? String(req.query.platform) : 'windows-amd64';
      if (!PLATFORM_RE.test(platform)) {
        return res.status(400).json({ error: 'platform must look like windows-amd64' });
      }
      if (!/^windows(-|$)/.test(platform)) {
        return res.status(400).json({
          error: 'An update command is only available for Windows agents. systemd agents update with one click from the dashboard; Docker agents are updated by rebuilding on their host.',
          code: 'UPDATE_COMMAND_UNSUPPORTED',
        });
      }
      const checksum = sourceStore ? sourceStore.sha256 : null;
      if (!checksum) {
        return res.status(409).json({ error: 'No agent source is published on this server, so there is nothing to update to.' });
      }
      const serverUrl = resolveServerUrl(req, enrollConfig);
      // Same download-to-a-file shape (and the same TLS-1.2 + cert-pinning prelude)
      // as the install command, so the update is not blocked by the IPS/AV rules
      // that catch a piped-into-iex download.
      const steps = winRunSteps({ serverUrl, path: '/enroll/update.ps1', fileName: 'blueeye-update.ps1', certFingerprint });
      const oneLiner = steps.oneLiner;
      res.json({
        oneLiner,
        steps: { download: steps.download, run: steps.run, scriptUrl: steps.url, scriptFile: steps.file },
        os: 'windows',
        platform,
        version: sourceStore && typeof sourceStore.sourceVersion === 'function' ? sourceStore.sourceVersion() : null,
        certFingerprint: certFingerprint || null,
        manual: {
          downloadUrl: `${serverUrl}/enroll/agent-source.tgz`,
          checksum,
          command: oneLiner,
        },
      });
    })
  );

  return router;
}

module.exports = { createEnrollCommandRouter };
