'use strict';

const { diffSnapshots, isInverse, flapKey, summarize } = require('./topologyDiff');

// Detects topology changes between LLDP poll cycles and records them.
//
// Each agent capabilities report is a "poll": compare the agent's PREVIOUS
// neighbour snapshot (its current lldp_neighbors rows) against the reported set,
// emit discrete change records, and:
//   - suppress flapping — a change reverting within `flapWindowSec` (default 300)
//     collapses the pair into a SINGLE 'flapping' record;
//   - persist each change to `topology_changes`;
//   - write each to the hash-chained audit_log as immutable evidence (fail-safe);
//   - reconcile state so removed/moved edges don't re-emit next poll.
//
// Off the ingest hot path is not required — this runs inline on the (infrequent)
// capabilities report, and is best-effort: a failure never breaks the report.

const DEFAULT_FLAP_WINDOW_SEC = 300;

function readFlapWindowSec(env = process.env) {
  const n = Number(env.TOPOLOGY_FLAP_WINDOW_SECONDS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FLAP_WINDOW_SEC;
}

function normEntry(e) {
  return {
    localPort: e.localPort ?? e.local_port ?? null,
    remoteChassisId: e.remoteChassisId ?? e.remote_chassis_id ?? null,
    remotePort: e.remotePort ?? e.remote_port ?? null,
    linkState: e.linkState ?? e.link_state ?? null,
  };
}

function createTopologyChangeService({ topologyChangesRepo, lldpNeighborsRepo, auditLogger = null, flapWindowSec = readFlapWindowSec(), now = () => new Date() }) {
  const flapWindowMs = flapWindowSec * 1000;

  async function writeAudit(action, agentId, change) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return null;
    return auditLogger.record(null, {
      category: 'topology',
      action,
      actorRole: 'system',
      target: `${agentId}:${change.remoteChassisId ?? ''}`,
      detail: change.summary,
    });
  }

  async function processReport(agentId, reportedNeighbours) {
    const prev = (await lldpNeighborsRepo.listByAgent(agentId)).map(normEntry);
    const next = (Array.isArray(reportedNeighbours) ? reportedNeighbours : [])
      .map(normEntry)
      .filter((e) => e.remoteChassisId);

    const changes = diffSnapshots(prev, next);
    if (!changes.length) return { changes: [], collapsed: 0 };

    const at = now();
    const since = new Date(at.getTime() - flapWindowMs);
    // Recent history for this agent within the flap window (newest first). Loaded
    // once; each collapse mutates a row we then also reflect locally.
    let recent = await topologyChangesRepo.recentForAgent({ agentId, since });

    const emitted = [];
    let collapsed = 0;

    for (const change of changes) {
      const fk = flapKey(change);

      // 1. Continued flapping: an existing 'flapping' record on the same edge
      //    within the window — keep it a single record, just refresh it.
      const existingFlap = recent.find((r) => r.changeType === 'flapping' && flapKey(r) === fk);
      if (existingFlap) {
        const summary = summarize({ ...change, changeType: 'flapping' });
        const auditId = await writeAudit('topology_flapping', agentId, { ...change, summary });
        await topologyChangesRepo.markFlapping(existingFlap.id, { summary, detectedAt: at, auditLogId: auditId });
        existingFlap.detectedAt = at.toISOString();
        collapsed += 1;
        emitted.push({ id: existingFlap.id, changeType: 'flapping', collapsed: true });
        continue;
      }

      // 2. New flap: this change reverts a recent discrete change on the same edge.
      const inv = recent.find((r) => isInverse(r, change));
      if (inv) {
        const summary = summarize({ ...change, changeType: 'flapping' });
        const auditId = await writeAudit('topology_flapping', agentId, { ...change, summary });
        await topologyChangesRepo.markFlapping(inv.id, { summary, detectedAt: at, auditLogId: auditId });
        inv.changeType = 'flapping';
        inv.detectedAt = at.toISOString();
        collapsed += 1;
        emitted.push({ id: inv.id, changeType: 'flapping', collapsed: true });
        continue;
      }

      // 3. Normal discrete change.
      const auditId = await writeAudit(`topology_${change.changeType}`, agentId, change);
      const id = await topologyChangesRepo.insert({ ...change, agentId, detectedAt: at, auditLogId: auditId });
      const stored = { ...change, id, agentId, detectedAt: at.toISOString() };
      recent = [stored, ...recent]; // a later change this poll can revert this one
      emitted.push({ id, changeType: change.changeType, collapsed: false });
    }

    // Reconcile state so removed / moved-from edges don't re-emit next poll. The
    // caller upserts the reported set; here we drop what disappeared.
    for (const change of changes) {
      if (change.changeType === 'neighbour_removed') {
        await lldpNeighborsRepo.deleteEdge({ localAgentId: agentId, localPort: change.localPort, remoteChassisId: change.remoteChassisId, remotePort: change.remotePort });
      } else if (change.changeType === 'port_moved') {
        await lldpNeighborsRepo.deleteEdge({ localAgentId: agentId, localPort: change.fromLocalPort, remoteChassisId: change.remoteChassisId, remotePort: change.remotePort });
      }
    }

    return { changes: emitted, collapsed };
  }

  return { processReport, flapWindowSec };
}

module.exports = { createTopologyChangeService, readFlapWindowSec, DEFAULT_FLAP_WINDOW_SEC };
