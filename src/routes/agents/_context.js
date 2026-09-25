'use strict';

const { silentLogger } = require('../../logger');
const { createAgentUpdateService } = require('../../services/agentUpdateService');

// Everything the three agent sub-routers share.
//
// agents.js was 855 lines holding nineteen routes across three jobs that only
// happen to sit under /agents: the CRUD of an agent RECORD, the privileged
// COMMANDS the server pushes down an agent's socket, and the signed RELEASE
// artefacts those commands install. They share an audit trail, a signer and
// four response helpers — and nothing else.
//
// Those shared pieces are built once here and handed to each sub-router as
// `ctx`, which is what lets index.js be a mounting table instead of a fourth
// place where this logic lives.
function createAgentsContext({
  agentsRepo, locationsRepo, resultsRepo, agentCommander, agentSourceStore,
  releaseStore = null, releasePublicKey = '', releaseKeyService = null, publishRelease = null,
  // The licence manager carries the vendor-signed authorisation a rekey relays:
  // this server may hold a key, but only the vendor can say the fleet should
  // accept it (see licenseManager.getTrustProof).
  licenseManager = null,
  auditRepo = null, auditEventsRepo = null, auditLogger = null, integrationTrigger = null,
  commandSigner = null, logger = silentLogger, reconnect = {},
  // The auto-update policy (Settings → Agents): whether agents may update
  // themselves, inside which local-time window, and how many a fleet rollout
  // moves at once.
  settingsService = null,
  // Commands left for an agent that is not connected (migration 137). Optional:
  // without it an offline agent still answers 409, as it always did.
  commandQueue = null,
  // Where the "what do we push, and can it be signed" decision lives now, shared
  // with the fleet rollout and with an agent that asks for its own update.
  updateService = null,
  // Read-only here: GET /agents/:id/tests answers "which saved tests already
  // target this agent?". Optional wiring — the endpoint returns an empty list
  // without it rather than failing.
  testPackagesRepo = null,
}) {
  // How long POST /:id/reconnect waits for the agent to re-dial after the forced
  // close (the agent's first backoff step is ~1 s), and how often it re-checks.
  const reconnectWaitMs = Number.isInteger(reconnect.waitMs) ? reconnect.waitMs : 12000;
  const reconnectPollMs = Number.isInteger(reconnect.pollMs) ? reconnect.pollMs : 250;

  // Signs a privileged command (upgrade/delete/install-tool) so the agent can
  // verify the SERVER asked for it, not merely something holding its socket.
  // A server without a managed signing key returns the command unchanged — the
  // agent stays lenient by default, so nothing breaks. Must be called LAST, once
  // auditId is attached: the audit id is part of what gets signed.
  const signCommand = (agentId, command) => (commandSigner ? commandSigner.sign(agentId, command) : command);

  // Response helpers for the error shapes repeated across this router.
  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Agent not found' });
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  // Audit helpers for server-initiated actions (upgrade/delete). Best-effort:
  // auditing must never fail or block the action it records. record() returns the
  // new row id (so the command can carry it for the agent to echo on completion);
  // markFailed() flips it terminal when we already know it won't proceed.
  async function recordRequested(action, agent, req, targetVersion = null) {
    if (!auditRepo || typeof auditRepo.record !== 'function') return null;
    try {
      return await auditRepo.record({
        agentId: agent.id,
        agentHostname: agent.hostname || null,
        locationId: agent.location_id ?? null,
        actorUserId: (req.user && req.user.id) || null,
        actorEmail: (req.user && req.user.email) || null,
        actorRole: (req.user && req.user.role) || null,
        action,
        targetVersion,
      });
    } catch (err) {
      // Best-effort audit: never block the action. But the FAILURE of an audit
      // write belongs in the operational log (we can't audit the audit system),
      // so it isn't lost silently. See docs/audit-vs-logging.md.
      (req.log || logger).warn(`agents: audit record(${action}) for agent ${agent && agent.id} failed (${err.message})`);
      return null;
    }
  }
  // Records a server-side fault the operator will also SEE in the dashboard, so
  // the log and the screen say the same thing. Best-effort and deduplicated — a
  // fault that repeats every time Update is clicked leaves one annotated row, not
  // a hundred.
  async function recordSystemError(req, { action, targetType = null, targetId = null, targetLabel = null, detail = null }) {
    if (!auditEventsRepo || typeof auditEventsRepo.recordRecurring !== 'function') return;
    try {
      const user = (req && req.user) || {};
      await auditEventsRepo.recordRecurring({
        actorType: 'system',
        actorId: user.id ?? null,
        actorLabel: user.email ?? null,
        actorRole: user.role ?? null,
        action,
        targetType,
        targetId: targetId == null ? null : String(targetId),
        targetLabel,
        detail,
        dedupKey: `system:${action}:${targetType || '-'}:${targetId == null ? '-' : targetId}:${(detail && detail.reason) || '-'}`,
      });
    } catch (err) {
      (req && req.log ? req.log : logger).warn(`agents: system-log record(${action}) failed (${err.message})`);
    }
  }

  async function markFailed(auditId, resultDetail) {
    if (!auditId || !auditRepo || typeof auditRepo.complete !== 'function') return;
    try { await auditRepo.complete(auditId, { state: 'failed', resultDetail }); } catch (err) { logger.warn(`agents: audit complete(failed) for auditId ${auditId} failed (${err.message})`); }
  }

  // Whether this server can sign privileged commands at all. The rekey
  // response tells the operator, because an UNSIGNED push is a different thing
  // to click OK on — so the fact has to be readable without handing the signer
  // itself to a router that has no business holding it.
  const canSignCommands = () => Boolean(
    commandSigner && typeof commandSigner.canSign === 'function' && commandSigner.canSign()
  );

  const updates = updateService || createAgentUpdateService({
    releaseStore, agentSourceStore, publishRelease, releaseKeyService, commandQueue, logger,
  });

  return {
    // repositories + services
    agentsRepo, locationsRepo, resultsRepo, agentCommander, agentSourceStore,
    testPackagesRepo,
    commandQueue, updateService: updates, settingsService,
    releaseStore, releasePublicKey, releaseKeyService, licenseManager, publishRelease,
    auditRepo, auditEventsRepo, auditLogger, integrationTrigger, logger,
    // reconnect tuning (POST /:id/reconnect)
    reconnectWaitMs, reconnectPollMs,
    // helpers
    signCommand, canSignCommands, invalidId, notFound, validationError,
    recordRequested, recordSystemError, markFailed,
  };
}

module.exports = { createAgentsContext };
