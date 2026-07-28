'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const pkg = require('../../package.json');
const { isNewer } = require('../lib/version');

// Server storage info (disk free/used + database size). Read-only, viewer+.
function createSystemRouter({
  systemInfo, agentSourceStore, agentBinaryStore, releaseStore, releaseKeyService = null, publishRelease = null,
  // Newest published versions, learned from the signed license proof (see
  // licenseManager.getAvailableReleases). null/absent = nothing known, which is
  // what a server talking to an older licens server sees.
  licenseManager = null,
  // Runs the host's update script when an admin asks. Disabled unless
  // SERVER_UPDATE_COMMAND is configured (see services/serverUpdateService.js).
  serverUpdateService = null,
  auditLogger = null,
} = {}) {
  const router = express.Router();

  // The latest SIGNED release the server can push for a one-click Update. When
  // this is null the update command goes out UNSIGNED (source bundle only), which
  // an agent that pinned a release key refuses ("signature downgrade") — so the
  // UI needs to know whether a signed release exists, and whether the server can
  // mint one, to explain why one-click updates fail and offer a fix.
  const latestRelease = () =>
    (releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null);
  const canSignReleases = () =>
    !!(releaseKeyService && typeof releaseKeyService.canSign === 'function' && releaseKeyService.canSign());
  const keyConfigured = () =>
    !!(releaseKeyService && typeof releaseKeyService.isConfigured === 'function' && releaseKeyService.isConfigured());
  // Whether a signed release can actually be PERSISTED. A signing key is not
  // enough — the release store also needs a writable directory (AGENT_RELEASE_DIR).
  // Without it publishing throws, so the UI must flag the config gap up front
  // instead of offering a button that 500s.
  const releaseStoreReady = () =>
    !(releaseStore && typeof releaseStore.hasStorage === 'function') || releaseStore.hasStorage();

  // The startup-packaged agent SOURCE bundle version. This is what the one-line
  // installer and the Windows/enrollment path actually download
  // (GET /enroll/agent-source.tgz), so it's the newest version a non-systemd
  // agent (Docker/Windows/unmanaged) can reach by re-running its installer.
  const sourceAgentVersion = () =>
    (agentSourceStore && typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null);

  // The agent version the server currently offers: a signed, uploaded release
  // takes precedence over the startup-packaged source bundle, so "is this agent
  // out of date?" tracks what a systemd one-click Update would actually push.
  const offeredAgentVersion = () => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
    if (rel && rel.version) return rel.version;
    return sourceAgentVersion();
  };

  // What the vendor has published, as carried by the signed license proof. The
  // licence check is an outbound call this server already makes, so "is there a
  // newer version?" costs no new connection from the customer's network — and
  // because the versions ride inside the signed payload, nothing on the path can
  // fabricate an update. Absent/unknown is normal (older licens server, or one
  // that tracks no releases): the UI then shows nothing rather than guessing.
  const upstream = () => {
    const releases =
      licenseManager && typeof licenseManager.getAvailableReleases === 'function'
        ? licenseManager.getAvailableReleases()
        : null;
    if (!releases) return { known: false, server: null, agent: null, checkedAt: null, serverUpdateAvailable: false, agentUpdateAvailable: false };
    const serverVersion = releases.server ? releases.server.version : null;
    const agentVersion = releases.agent ? releases.agent.version : null;
    return {
      known: true,
      server: releases.server,
      agent: releases.agent,
      checkedAt: releases.checkedAt,
      // "Behind" is judged against what this host actually runs / serves. The
      // agent comparison uses the SOURCE bundle: that is what this server can
      // offer once its own files are updated, and it is what a `git pull` on the
      // host moves. A signed release can never be newer than the source it was
      // signed from.
      serverUpdateAvailable: isNewer(serverVersion, pkg.version || ''),
      agentUpdateAvailable: isNewer(agentVersion, sourceAgentVersion() || ''),
    };
  };

  // Versions, for the Settings "Updates" panel: this server's version and the
  // agent versions it serves (so the UI can flag out-of-date agents). `agent` is
  // what a systemd one-click Update pushes (signed release, else source); when a
  // signed release is newer than the packaged source these diverge, and
  // `agentSource` is what installer-based agents can actually reach — the UI
  // compares those two against the right target. viewer+.
  router.get(
    '/version',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const rel = latestRelease();
      res.json({
        server: pkg.version || null,
        releaseDate: pkg.releaseDate || null,
        agent: offeredAgentVersion(),
        agentSource: sourceAgentVersion(),
        // Signing status, so the UI can explain a stuck one-click update: a
        // one-click Update is only accepted by key-pinning agents when a SIGNED
        // release exists. `agentReleaseVersion` is that release (null = none, so
        // the update would go out unsigned and be refused); `canSignReleases`
        // says whether the server can publish one now; `agentKeyConfigured` says
        // whether any signing key exists at all.
        agentReleaseVersion: rel && rel.version ? rel.version : null,
        canSignReleases: canSignReleases(),
        agentKeyConfigured: keyConfigured(),
        // False when the server can sign but has no AGENT_RELEASE_DIR to store the
        // result — publishing would fail, so the UI shows the config fix instead.
        releaseStoreReady: releaseStoreReady(),
        binaryBuild: agentBinaryStore ? agentBinaryStore.status() : null,
        // Newest versions the vendor has published (from the signed licence
        // proof) + whether this host is behind.
        upstream: upstream(),
        // Whether an admin can run the host's update script from here, and how
        // the last run went. `configured:false` = the panel shows the manual
        // command instead of a button.
        update: serverUpdateService ? serverUpdateService.status() : { configured: false, command: null, running: false, lastRun: null },
      });
    })
  );

  // The update-run status on its own, so the dashboard can poll it while a
  // deploy is in flight without re-reading every version. Includes the tail of
  // the update log — admin only, since a deploy log exposes host paths.
  router.get(
    '/server-update',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!serverUpdateService) {
        return res.json({ configured: false, command: null, running: false, lastRun: null, log: '' });
      }
      res.json({ ...serverUpdateService.status(), log: serverUpdateService.tail(300) });
    })
  );

  // Run the host's configured update script ("update ready to deploy → deploy").
  // admin only, audit-logged, and only ever able to start the ONE command the
  // installer configured — nothing from this request reaches the command line.
  //
  // The script normally restarts this server, so a successful call returns 202
  // and the dashboard follows the run via GET /system/server-update (and, once
  // the server comes back, its new version).
  router.post(
    '/server-update',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!serverUpdateService || !serverUpdateService.isConfigured()) {
        return res.status(503).json({
          error: 'No update command is configured on this server. Set SERVER_UPDATE_COMMAND to the deploy script on the host (e.g. /opt/blueeye/blueeye-server/scripts/deploy.sh) and restart, or run that script on the host by hand.',
          configured: false,
        });
      }
      const up = upstream();
      const target = up.server ? up.server.version : null;
      const result = serverUpdateService.start({
        requestedBy: (req.user && (req.user.email || req.user.id)) || null,
        targetVersion: target,
      });
      if (!result.started) {
        if (result.reason === 'already_running') {
          return res.status(409).json({ error: 'An update is already running on this server.', ...serverUpdateService.status() });
        }
        if (result.reason === 'log_unwritable') {
          return res.status(500).json({ error: `The update log could not be written (${result.detail}). Check SERVER_UPDATE_LOG and its directory permissions.` });
        }
        return res.status(500).json({ error: `The update script could not be started: ${result.detail || result.reason}` });
      }
      if (auditLogger) {
        await auditLogger.record(req, {
          category: 'system',
          action: 'server_update_start',
          detail: `target=${target || 'unknown'}`,
        });
      }
      res.status(202).json({ ...serverUpdateService.status(), targetVersion: target });
    })
  );

  // Sign the CURRENT source bundle into a signed release and publish it, so
  // one-click Updates start working for agents that pin a release key. admin
  // only. Fails with a clear reason when the server has no key that can sign.
  router.post(
    '/agent-release/publish',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (typeof publishRelease !== 'function') {
        return res.status(503).json({ error: 'Release publishing is not available on this server' });
      }
      if (!canSignReleases()) {
        return res.status(409).json({
          error: keyConfigured()
            ? 'The agent signing key is verify-only (it has no private key on this server), so it cannot publish a signed release. Generate a managed signing key under Settings → Agent key.'
            : 'No agent signing key is configured, so a signed release cannot be published. Generate one under Settings → Agent key first.',
          canSign: false,
          keyConfigured: keyConfigured(),
        });
      }
      if (!releaseStoreReady()) {
        return res.status(503).json({
          error: 'The server has no release storage directory configured (AGENT_RELEASE_DIR), so a signed release cannot be saved. Set AGENT_RELEASE_DIR to a writable path on the server host and restart, then publish again.',
          releaseStoreReady: false,
        });
      }
      let meta;
      try {
        meta = await publishRelease();
      } catch (err) {
        // Surface the real reason (e.g. a disk/permission error writing the
        // release) instead of a bare 500 the operator can't act on.
        return res.status(500).json({ error: `Could not publish a signed release: ${err.message}` });
      }
      if (!meta || !meta.version) {
        return res.status(500).json({ error: 'Could not publish a signed release: no agent source bundle was available to sign.' });
      }
      res.json({ version: meta.version, sha256: meta.sha256 || null, signed: true });
    })
  );

  // Re-package the agent source bundle from disk (AGENT_SOURCE_DIR) without
  // restarting the server, so a freshly-pulled agent version is served right
  // away and out-of-date agents get flagged/updated. admin only.
  router.post(
    '/agent-source/reload',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!agentSourceStore || typeof agentSourceStore.reload !== 'function') {
        return res.status(503).json({ error: 'Agent source not configured on this server' });
      }
      await agentSourceStore.reload();
      // Kick off a binary rebuild for the new source version (non-blocking).
      if (agentBinaryStore && typeof agentBinaryStore.reload === 'function') {
        agentBinaryStore.reload();
      }
      // Re-sign the freshly-reloaded source into a signed release too, so a
      // one-click Update tracks the new version instead of pushing an unsigned
      // (and therefore refused) bundle. Best-effort + no-op without a signing
      // key — reloading source must still succeed.
      let released = null;
      if (typeof publishRelease === 'function' && canSignReleases()) {
        try { const meta = await publishRelease(); released = meta && meta.version ? meta.version : null; } catch { /* keep reload successful */ }
      }
      res.json({
        version: typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null,
        available: typeof agentSourceStore.available === 'function' ? agentSourceStore.available() : false,
        releaseVersion: released,
      });
    })
  );

  router.get(
    '/storage',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!systemInfo) {
        return res.status(503).json({ error: 'System info not available' });
      }
      res.json(await systemInfo.getStorage());
    })
  );

  return router;
}

module.exports = { createSystemRouter };
