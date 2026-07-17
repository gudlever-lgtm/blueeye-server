'use strict';

const { COMMAND_SET_VERSION, DEFAULT_ITEMS } = require('./commandAllowlist');

// Evidence snapshot capture engine (Fase 6). On cluster-open (and on a manual
// re-snapshot), captures a READ-ONLY diagnostic snapshot from each affected
// target over the EXISTING authenticated agent-command path (sendCommandAndWait),
// then stores one compressed blob per (cluster, target), referenced from the
// incident timeline.
//
// Bounded + best-effort by contract:
//   * hard per-target timeout (default 30s) — a slow agent never delays anything;
//   * concurrency cap (default 4) across targets;
//   * an offline agent is retried ONCE after 60s, then recorded 'agent-offline';
//   * partial results are valid — each item's outcome is recorded;
//   * every method swallows its own errors — capture NEVER blocks clustering,
//     alerting or the incident page (the trigger is fire-and-forget).
//
// Signing: the evidence command is Ed25519-signed with the existing release key
// (releaseKeyService) when one is configured, so the agent can verify it — the
// agent ALSO enforces its own read-only allowlist (defense in depth).

const silentLogger = { info() {}, warn() {} };
const OUTCOME = { OK: 'ok', TIMEOUT: 'timeout', REFUSED: 'refused', OFFLINE: 'agent-offline' };

function createSnapshotService({
  evidenceRepo,
  agentCommander,
  releaseKeyService = null,
  auditLogger = null,
  publishCluster = () => {},
  timeoutMs = 30 * 1000,
  concurrency = 4,
  retryDelayMs = 60 * 1000,
  scheduleRetry = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  now = () => new Date(),
  logger = silentLogger,
} = {}) {
  // Signs the evidence command with the release key (when available), so the agent
  // can verify it. Returns the command with `signature` set, or unchanged.
  function signed(command) {
    if (!releaseKeyService || typeof releaseKeyService.sign !== 'function') return command;
    try {
      if (typeof releaseKeyService.canSign === 'function' && !releaseKeyService.canSign()) return command;
      return { ...command, signature: releaseKeyService.sign(command) };
    } catch (err) {
      logger.warn(`evidence: could not sign command (${err.message})`);
      return command;
    }
  }

  // Turns the agent's reply items into { status, items, payloadText }.
  function summarize(replyItems) {
    const items = (Array.isArray(replyItems) ? replyItems : []).map((it) => ({
      name: it && it.name, status: it && it.status ? it.status : OUTCOME.TIMEOUT,
    }));
    const parts = [];
    for (const it of Array.isArray(replyItems) ? replyItems : []) {
      const body = it && it.payload != null ? String(it.payload) : '';
      parts.push(`# ${it && it.name} [${(it && it.status) || 'unknown'}]\n${body}`.trim());
    }
    const okCount = items.filter((i) => i.status === OUTCOME.OK).length;
    let status = 'failed';
    if (items.length && okCount === items.length) status = 'complete';
    else if (okCount > 0) status = 'partial';
    return { status, items, payloadText: parts.join('\n\n') };
  }

  // Builds the read-only evidence command for a target snapshot.
  function buildCommand(snapshotId, clusterId) {
    return signed({
      name: 'evidence',
      snapshotId,
      clusterId,
      commandSetVersion: COMMAND_SET_VERSION,
      items: DEFAULT_ITEMS,
    });
  }

  async function auditCapture(clusterId, target, status) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return;
    try {
      // Evidence-class action so audits separate "BlueEye looked" from "BlueEye acted".
      await auditLogger.record(null, {
        category: 'incident', action: 'evidence_snapshot', target: String(clusterId),
        actorEmail: 'system', actorRole: 'system',
        detail: `Read-only evidence snapshot of target ${target} → ${status} (${COMMAND_SET_VERSION}).`,
      });
    } catch (err) { logger.warn(`evidence: audit failed (${err.message})`); }
  }

  // Sends the evidence command to one target and finalises its snapshot row.
  // `attempt` 0 = first try, 1 = the single retry after an offline result.
  async function captureTarget(clusterId, target, snapshotId, attempt = 0) {
    let out;
    try {
      out = await agentCommander.sendCommandAndWait(target, buildCommand(snapshotId, clusterId), { timeoutMs });
    } catch (err) {
      logger.warn(`evidence: command send failed for target ${target} (${err.message})`);
      out = { delivered: 0, acked: false, reply: null };
    }

    // Offline: retry ONCE after retryDelayMs, then give up.
    if (!out || out.delivered === 0) {
      if (attempt === 0) {
        scheduleRetry(() => { captureTarget(clusterId, target, snapshotId, 1).catch(() => {}); }, retryDelayMs);
        return; // leave the row 'pending' until the retry finalises it
      }
      await evidenceRepo.complete(snapshotId, { status: 'agent-offline', items: DEFAULT_ITEMS.map((n) => ({ name: n, status: OUTCOME.OFFLINE })), payloadText: null });
      await auditCapture(clusterId, target, 'agent-offline');
      publishCluster({ id: clusterId, evidence: { snapshotId, target, status: 'agent-offline' } });
      return;
    }

    if (out.timedOut || !out.reply) {
      await evidenceRepo.complete(snapshotId, { status: 'failed', items: DEFAULT_ITEMS.map((n) => ({ name: n, status: OUTCOME.TIMEOUT })), payloadText: null });
      await auditCapture(clusterId, target, 'failed');
      publishCluster({ id: clusterId, evidence: { snapshotId, target, status: 'failed' } });
      return;
    }

    const evidence = out.reply.evidence || {};
    const { status, items, payloadText } = summarize(evidence.items);
    await evidenceRepo.complete(snapshotId, { status, items, payloadText });
    await auditCapture(clusterId, target, status);
    publishCluster({ id: clusterId, evidence: { snapshotId, target, status } });
  }

  // Runs the tasks with a bounded concurrency cap.
  async function pooled(tasks) {
    const queue = tasks.slice();
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        try { await task(); } catch (err) { logger.warn(`evidence: capture task failed (${err.message})`); }
      }
    });
    await Promise.all(workers);
  }

  // Captures evidence from every affected target. NEVER throws. Returns a summary
  // { snapshots: [...] } of the rows opened (their final state is written async).
  async function captureForCluster(clusterId, targets, { trigger = 'auto' } = {}) {
    const uniq = [...new Set((Array.isArray(targets) ? targets : []).map((t) => t != null && String(t)).filter(Boolean))];
    if (!uniq.length) return { snapshots: [] };
    if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') return { snapshots: [] };

    const opened = [];
    const tasks = [];
    for (const target of uniq) {
      let snapshotId;
      try {
        snapshotId = await evidenceRepo.create({ clusterId, target, commandSetVersion: COMMAND_SET_VERSION, capturedAt: now(), trigger });
      } catch (err) {
        logger.warn(`evidence: could not open snapshot for ${target} (${err.message})`);
        continue;
      }
      opened.push({ snapshotId, target });
      tasks.push(() => captureTarget(clusterId, target, snapshotId));
    }
    // Fire the pool without awaiting the individual captures blocking the caller's
    // return — but await the pool so a synchronous test can observe completion.
    await pooled(tasks);
    return { snapshots: opened };
  }

  return { captureForCluster, captureTarget, summarize };
}

module.exports = { createSnapshotService, OUTCOME };
