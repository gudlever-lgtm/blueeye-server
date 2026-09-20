'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');
const { parseId } = require('../../validation/locationValidation');
const { validateProbeSpec } = require('../../validation/probeValidation');
const { INSTALLABLE_TOOLS, isAllowedTool } = require('../../agentTools');
const { diagnoseConnection } = require('../../ws/connectionDiagnosis');
const { isNewer } = require('../../lib/version');
const { MAX_INTERVAL_MS } = require('../../validation/agentValidation');
// The fingerprint of a KEY (SHA-256 of its SPKI DER bytes) — what the vendor
// authorises and what the agent computes over the key it is offered.
const { publicKeyFingerprint } = require('../../lib/fingerprint');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The privileged half of /agents: everything the server PUSHES down an agent's
// socket — ping, diagnose, update, rekey, delete, install-tool, run-test,
// probe, speedtest — plus the two endpoints that explain and repair the socket
// itself (/connection, /reconnect).
//
// These are the routes that change a customer's host rather than read a row,
// so they are the reason the audit helpers and the command signer exist.
function createAgentCommandsRouter(ctx) {
  const router = express.Router();
  const {
    agentsRepo, agentCommander, agentSourceStore, releaseStore, releaseKeyService, releasePublicKey,
    licenseManager, publishRelease, auditRepo, auditEventsRepo, auditLogger, logger,
    reconnectWaitMs, reconnectPollMs,
    signCommand, canSignCommands, invalidId, notFound, validationError,
    recordRequested, recordSystemError, markFailed,
  } = ctx;

  router.post(
    '/:id/ping',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const startedAt = Date.now();
      const out = await agentCommander.sendCommandAndWait(id, { name: 'ping' }, { timeoutMs: 5000 });
      if (out.delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      res.json({
        connected: true,
        acked: !!out.acked,
        timedOut: !!out.timedOut,
        latencyMs: Date.now() - startedAt,
        agentVersion: reply.agentVersion || null,
        sources: Array.isArray(reply.sources) ? reply.sources : null,
        managed: reply.managed || null,
      });
    })
  );

  // POST /agents/:id/diagnose — ask the connected agent to introspect its flow
  // pipeline (monitor source, collector receive/decode counters, local exporter
  // state, last report) and report a snapshot, so an operator can see exactly
  // where flows stop. Read-only on the agent — viewer+. 409 if not connected,
  // 504 if it doesn't reply in time, 503 if the agent channel is unavailable.
  router.post(
    '/:id/diagnose',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const out = await agentCommander.sendCommandAndWait(id, { name: 'diagnose' }, { timeoutMs: 5000 });
      if (out.delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      if (out.timedOut || !out.reply) {
        return res.status(504).json({ error: 'Agent did not reply', connected: true, timedOut: true });
      }
      res.json({ connected: true, diagnostic: out.reply.diagnostic || null });
    })
  );

  // POST /agents/:id/update — ask a connected, systemd-managed agent to rebuild
  // and restart onto the new code. admin only. A signed release (uploaded via
  // POST /agents/releases) is pushed in preference to the startup-packaged source
  // bundle: the command then carries the release version + sha256 + Ed25519
  // signature, which the agent verifies before extracting. Falls back to the
  // source bundle (sha256 only) when no signed release exists, so existing
  // deployments keep working. Docker/unmanaged agents decline (host rebuilds).
  router.post(
    '/:id/update',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      let release = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
      const haveSource = agentSourceStore && typeof agentSourceStore.available === 'function' && agentSourceStore.available();
      const sourceVersion = agentSourceStore && typeof agentSourceStore.sourceVersion === 'function'
        ? agentSourceStore.sourceVersion() : null;
      // Prefer a SIGNED push. If none is published yet — or the newest one is
      // OLDER than the source now on disk — mint one from the current source,
      // provided this server holds a signing key. Without that second case a
      // stale signed release pins the whole fleet backwards: the host pulls the
      // agent to a new version, the store still holds the old signed bundle, and
      // every Update keeps pushing the old one. An unsigned push is the last
      // resort, because an agent that pinned a release key refuses it
      // ("signature downgrade"). publishRelease is a no-op without a signing
      // key, which leaves the legacy unsigned-source fallback intact.
      const releaseIsStale = !release
        || (sourceVersion && release.version && isNewer(sourceVersion, release.version));
      if (releaseIsStale && typeof publishRelease === 'function') {
        try {
          const minted = await publishRelease();
          if (minted && minted.version) release = releaseStore.latest();
        } catch (err) {
          (req.log || logger).warn(`agents: on-demand signed-release publish failed (${err.message}); falling back to source bundle`);
        }
      }
      // Still behind after the attempt (no signing key, or signing failed): push
      // the newer SOURCE rather than a signature for code nobody asked for.
      if (release && sourceVersion && isNewer(sourceVersion, release.version) && haveSource) {
        (req.log || logger).warn(
          `agents: signed release v${release.version} is older than the packaged source v${sourceVersion} `
          + '— pushing the unsigned source bundle. Generate a release signing key so updates stay signed.');
        release = null;
      }
      if (!release && !haveSource) {
        return res.status(503).json({ error: 'No agent source is published on the server' });
      }
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      // WHY the push is unsigned, when it is. The dashboard used to guess ("this
      // server has no release signing key") and send the operator to the wrong
      // screen; a key that exists but cannot sign — an env-only public key, or a
      // stored key whose private half no longer decrypts — looks identical from
      // the outside and needs different advice. Ask the key service instead.
      const signedReason = release
        ? null
        : (releaseKeyService && typeof releaseKeyService.signBlockedReason === 'function'
          ? (releaseKeyService.signBlockedReason() || 'sign-failed')
          : 'no-key');
      const command = release
        ? { name: 'update', version: release.version, sha256: release.sha256, signature: release.signature }
        : { name: 'update', sha256: agentSourceStore.sha256, version: (typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null) };
      const targetVersion = command.version;
      // Audit 'requested' first so the command can carry the audit id; the agent
      // echoes it back on completion (handled where the agent reports its result).
      const auditId = await recordRequested('upgrade', agent, req, targetVersion);
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, signCommand(id, command), { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      // A runtime that declines (docker/unmanaged) is a terminal outcome we know now.
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      // An unsigned push is a known-bad outcome on a pinned fleet, so it belongs
      // in the system log next to the failure it will cause — not only in a toast
      // the operator may have already clicked away.
      if (!release) {
        (req.log || logger).warn(
          `agents: update for agent ${id} sent UNSIGNED (${signedReason}) — an agent pinned to a release key will refuse it.`);
        await recordSystemError(req, {
          action: 'agent.update-unsigned',
          targetType: 'agent',
          targetId: id,
          targetLabel: agent.hostname || null,
          detail: { reason: signedReason, targetVersion },
        });
      }
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        runtime: reply.runtime || null,
        reason: reply.reason || null,
        targetVersion,
        signed: !!release,
        signedReason,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/rekey — replace the release trust anchor this agent pins,
  // with the key THIS server signs with now. admin only.
  //
  // An agent verifies every self-update against the key it pinned at install
  // time. When the server's signing key changes — rotated, regenerated after a
  // delete, or one whose private half no longer decrypts — that agent refuses
  // everything this server can produce ("refusing unsigned update", "release
  // signature did not verify") and nothing on the host can clear it: an installed
  // agent is managed FROM the server, with no shell on the machine. So the new
  // anchor goes out over the same authenticated channel that already carries
  // `update` and `delete`, signed with the key being replaced whenever this
  // server can still sign (a proper rotation, which a strict agent requires).
  //
  // 409 when the agent is not connected, 503 when this server publishes no key
  // to pin — re-keying a host onto nothing would only trade one deadlock for
  // another.
  router.post(
    '/:id/rekey',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const publicKey = (typeof releasePublicKey === 'function' ? releasePublicKey() : releasePublicKey) || '';
      if (!publicKey) {
        await recordSystemError(req, {
          action: 'agent.rekey-blocked',
          targetType: 'agent',
          targetId: id,
          targetLabel: agent.hostname || null,
          detail: { reason: 'no-key' },
        });
        return res.status(503).json({
          error: 'This server publishes no agent release key, so there is nothing to pin. Generate one under Settings → Agent key first.',
          code: 'NO_RELEASE_KEY',
        });
      }
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      // The fingerprint of the KEY (SHA-256 of its SPKI DER bytes), which is what
      // the vendor authorises and what the agent computes over the key it is
      // offered. Hashing the PEM text instead would make this depend on line
      // endings, and it decides whether a fleet accepts code.
      const fingerprint = publicKeyFingerprint(publicKey);

      // The vendor's authorisation, exactly as it was signed. The agent verifies
      // this against the vendor key it EMBEDS, so this server is a courier here,
      // not an authority: without a proof naming THIS key, an agent that has
      // already seen one refuses the rekey — which is precisely what stops a
      // server that has been taken over from re-anchoring its own fleet.
      const trustProof = licenseManager && typeof licenseManager.getTrustProof === 'function'
        ? licenseManager.getTrustProof() : null;
      const authorizedFingerprint = trustProof
        && trustProof.payload
        && trustProof.payload.trust
        && trustProof.payload.trust.server
        && trustProof.payload.trust.server.release_key
        ? trustProof.payload.trust.server.release_key.fingerprint : null;
      // Sending a proof that authorises a DIFFERENT key would only produce a
      // refusal at the agent. Say so here instead, where the operator is.
      const vendorAuthorized = !!authorizedFingerprint && authorizedFingerprint === fingerprint;
      if (trustProof && !vendorAuthorized) {
        await recordSystemError(req, {
          action: 'agent.rekey-unauthorized',
          targetType: 'agent',
          targetId: id,
          targetLabel: agent.hostname || null,
          detail: { reason: 'vendor-authorizes-another-key', fingerprint: fingerprint.slice(0, 16) },
        });
      }

      const auditId = await recordRequested('rekey', agent, req, fingerprint.slice(0, 32));
      const command = { name: 'rekey', publicKey };
      if (vendorAuthorized) command.vendorProof = trustProof;
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, signCommand(id, command), { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        reason: reply.reason || null,
        fingerprint,
        // Whether the command itself was signed with the key being replaced. An
        // agent that requires signed commands accepts nothing else, so the
        // dashboard has to be able to say why a rekey was refused.
        signed: canSignCommands(),
        // Whether the vendor has authorised THIS key. An agent that has ever seen
        // a vendor authorisation accepts nothing else, so this is the difference
        // between a rekey that will land and one that will be refused.
        vendorAuthorized,
        vendorAuthorizedFingerprint: authorizedFingerprint,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/delete — ask a connected agent to STOP its service, remove
  // its own files and securely wipe its token, then report back. admin only. The
  // action is audited (requested -> completed/failed). The server agent row is
  // removed only once the agent CONFIRMS the self-delete (handled where the agent
  // reports its result), so a declined/failed delete never orphans a live agent.
  // To force-remove the server-side record regardless, use DELETE /agents/:id.
  router.post(
    '/:id/delete',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const auditId = await recordRequested('delete', agent, req, null);
      const command = { name: 'delete' };
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, signCommand(id, command), { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        reason: reply.reason || null,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/install-tool { tool } — ask a connected agent to install a
  // missing diagnostic tool (e.g. traceroute) from its package manager, then
  // report back. operator/admin. The tool must be on the shared allowlist; the
  // agent independently enforces its OWN allowlist (so the server can never push
  // an arbitrary package). Audited (requested -> completed/failed) like
  // upgrade/delete, with the agent echoing the audit id back on completion.
  router.post(
    '/:id/install-tool',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const tool = String((req.body && req.body.tool) || '').trim().toLowerCase();
      if (!isAllowedTool(tool)) {
        return validationError(res, { tool: `tool must be one of ${INSTALLABLE_TOOLS.join(', ')}` });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const auditId = await recordRequested('install-tool', agent, req, tool);
      const command = { name: 'install-tool', tool };
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, signCommand(id, command), { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        reason: reply.reason || null,
        tool,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/run-test — push a "run test" command to a connected agent
  // over the live WebSocket. operator/admin. Returns 202 with how many
  // connections received it, 409 if the agent isn't currently connected.
  router.post(
    '/:id/run-test',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const command = { name: 'run-test' };
      // Optional repeat interval; ignore values outside (0, 1 day] rather than
      // forwarding an unbounded number across the server -> agent boundary.
      if (Number.isInteger(body.intervalMs) && body.intervalMs > 0 && body.intervalMs <= MAX_INTERVAL_MS) {
        command.intervalMs = body.intervalMs;
      }

      const delivered = agentCommander ? agentCommander.sendCommand(id, command) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id });
    })
  );

  // POST /agents/:id/probe — push an active probe (ping/tcp/dns/traceroute) to a
  // connected agent. operator/admin. The agent runs it and reports back via
  // POST /agents/probe-results. 409 if the agent isn't connected.
  router.post(
    '/:id/probe',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: probe, errors } = validateProbeSpec(req.body);
      if (errors) return validationError(res, errors);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const delivered = agentCommander ? agentCommander.sendCommand(id, { name: 'run-probe', probe }) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      // Starting a probe is an operator action against a customer network, so it
      // goes in the HASH-CHAINED compliance trail, not only in the activity feed
      // the audit middleware writes. The feed answers "what has been happening";
      // this answers "prove nobody edited the record of who ran what, when" —
      // which is the question asked after an incident, and the one an
      // append-only, tamper-evident chain exists for. Best-effort by design: the
      // logger swallows its own failures, so an audit outage never costs the
      // operator the probe they asked for.
      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(req, {
          category: 'agent',
          action: 'probe_start',
          target: `agent:${id}`,
          // Metadata only, and only the fields that say WHAT was asked for —
          // enough to reproduce the request, nothing that could carry a secret.
          detail: JSON.stringify({ type: probe.type, target: probe.host, port: probe.port ?? null }),
        });
      }
      res.status(202).json({ delivered, agentId: id, probe });
    })
  );

  // POST /agents/:id/run-speedtest — push an active speed test to a connected
  // agent. operator/admin. The agent measures download/upload Mbps against the
  // server and reports via POST /speedtest/results. 409 if not connected.
  router.post(
    '/:id/run-speedtest',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const command = { name: 'speedtest' };
      if (Number.isInteger(body.bytes) && body.bytes > 0) command.bytes = body.bytes;
      const delivered = agentCommander ? agentCommander.sendCommand(id, command) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id });
    })
  );

  // GET /agents/:id/connection — an explainable verdict on the agent's live
  // connection: connected or not, WHY (license gate, rejected token, fresh drop,
  // unreachable host), what evidence supports it, and what to do about it.
  // viewer+ (read-only; no agent interaction — this must work precisely when the
  // agent is NOT connected). Backed by diagnoseConnection() + the WS hub's
  // in-memory connection evidence.
  router.get(
    '/:id/connection',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const live = agentCommander && typeof agentCommander.getConnectionInfo === 'function'
        ? agentCommander.getConnectionInfo(id)
        : null;
      res.json({ agentId: id, ...diagnoseConnection({ agent, live }) });
    })
  );

  // POST /agents/:id/reconnect — force a clean reconnect of a CONNECTED agent:
  // the server closes its socket(s) and the agent re-dials on its own (backoff,
  // then reconcile + config reload), then we wait briefly for it to come back.
  // operator/admin. Connections are agent-initiated, so this cannot revive a
  // disconnected agent — that case returns 409 with the diagnosis explaining
  // why it is down and what will actually bring it back.
  router.post(
    '/:id/reconnect',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.disconnectAgent !== 'function'
        || typeof agentCommander.getConnectionInfo !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const live = agentCommander.getConnectionInfo(id);
      if (!live || !live.connected) {
        return res.status(409).json({
          error: 'Agent not connected — the server cannot dial out to an agent, so only a live connection can be reconnected',
          connected: false,
          diagnosis: diagnoseConnection({ agent, live }),
        });
      }
      const closed = agentCommander.disconnectAgent(id);
      const startedAt = Date.now();
      let reconnected = false;
      while (Date.now() - startedAt < reconnectWaitMs) {
        await sleep(reconnectPollMs);
        const info = agentCommander.getConnectionInfo(id);
        if (info && info.connected) { reconnected = true; break; }
      }
      res.json({ connected: reconnected, closed, reconnected, waitedMs: Date.now() - startedAt });
    })
  );

  // GET /agents — list, with the joined location name. Each agent carries the
  // latest hsflowd exporter status it reported (or null), for the dashboard.

  return router;
}

module.exports = { createAgentCommandsRouter };
