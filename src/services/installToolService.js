'use strict';

const { isAllowedTool, toolForProbeFailure } = require('../agentTools');

// Auto-install service: when a probe reports it could not run because a tool is
// missing on the host (e.g. "traceroute not installed"), and the operator has
// opted in (Settings → Agents → auto-install), push an install-tool command to
// that agent automatically — recording it in the audit trail as a SYSTEM-
// initiated action. Heavily guarded: opt-in only, allowlisted tools only, and
// de-duplicated so a host that keeps failing doesn't get spammed with installs.
// Everything is best-effort and must never break probe ingestion.
function createInstallToolService({
  agentCommander = null, auditRepo = null, auditEventsRepo = null,
  agentsRepo = null, settingsService = null, logger = console, throttleHours = 1,
} = {}) {
  async function autoEnabled() {
    if (!settingsService || typeof settingsService.getAgents !== 'function') return false;
    try { const s = await settingsService.getAgents(); return !!(s && s.autoInstallTools); } catch { return false; }
  }

  // Has an install of this tool already been requested for this agent recently?
  // Reuses the audit trail as the throttle memory (no extra state). The tool is
  // stored in target_version on the 'install-tool' rows.
  async function recentlyRequested(agentId, tool) {
    if (!auditRepo || typeof auditRepo.findByAgent !== 'function') return false;
    try {
      const rows = await auditRepo.findByAgent(agentId, { limit: 50 });
      const cutoff = Date.now() - Math.max(0, throttleHours) * 3600 * 1000;
      return rows.some((r) => {
        if ((r.action || '') !== 'install-tool') return false;
        if ((r.target_version ?? r.targetVersion) !== tool) return false;
        const at = new Date(r.requested_at ?? r.requestedAt ?? 0).getTime();
        return Number.isFinite(at) && at > cutoff;
      });
    } catch { return false; }
  }

  // Inspects freshly-ingested probe results and, for any that failed because a
  // tool is missing, auto-pushes the install (subject to the opt-in + throttle).
  async function maybeAutoInstall(agentId, results) {
    if (!agentCommander || typeof agentCommander.sendCommand !== 'function') return;
    if (!Array.isArray(results) || !results.length) return;
    if (!(await autoEnabled())) return;

    const tools = new Set();
    for (const r of results) {
      if (!r || !r.execError) continue;
      const tool = toolForProbeFailure(r.type, r.execError);
      if (tool && isAllowedTool(tool)) tools.add(tool);
    }
    if (!tools.size) return;

    let agent = null;
    try { agent = agentsRepo && typeof agentsRepo.findById === 'function' ? await agentsRepo.findById(agentId) : null; } catch { /* hostname is best-effort */ }

    for (const tool of tools) {
      try {
        if (await recentlyRequested(agentId, tool)) continue;

        let auditId = null;
        if (auditRepo && typeof auditRepo.record === 'function') {
          try {
            auditId = await auditRepo.record({
              agentId,
              agentHostname: agent ? (agent.hostname || null) : null,
              locationId: agent ? (agent.location_id ?? null) : null,
              action: 'install-tool',
              targetVersion: tool,
            });
          } catch { /* auditing is best-effort */ }
        }

        const command = { name: 'install-tool', tool };
        if (auditId) command.auditId = auditId;
        const delivered = agentCommander.sendCommand(agentId, command);
        if (!delivered && auditRepo && typeof auditRepo.complete === 'function' && auditId) {
          try { await auditRepo.complete(auditId, { state: 'failed', resultDetail: 'agent not connected' }); } catch { /* best-effort */ }
        }

        // Surface the auto-trigger itself in the unified audit trail (the agent's
        // completion adds the outcome row).
        if (auditEventsRepo && typeof auditEventsRepo.record === 'function') {
          try {
            await auditEventsRepo.record({
              actorType: 'system', actorId: agentId,
              action: 'agent.install-tool', targetType: 'tool', targetLabel: tool,
              detail: { tool, trigger: 'auto', delivered: !!delivered },
            });
          } catch { /* best-effort */ }
        }
      } catch (err) {
        try { logger.error && logger.error('auto-install failed:', err.message); } catch { /* ignore */ }
      }
    }
  }

  return { maybeAutoInstall };
}

module.exports = { createInstallToolService };
