'use strict';

const { diffSnapshots, isInverse, flapKey, summarize } = require('./topologyDiff');
const { loadTopologyConfig, DEFAULTS } = require('./config');

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

const DEFAULT_FLAP_WINDOW_SEC = DEFAULTS.flapWindowSeconds;

function readFlapWindowSec(env = process.env) {
  return loadTopologyConfig(env).flapWindowSeconds;
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

  async function writeAudit(action, agentId, change, { target = null } = {}) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return null;
    return auditLogger.record(null, {
      category: 'topology',
      action,
      actorRole: 'system',
      target: target || `${agentId}:${change.remoteChassisId ?? ''}`,
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

  // THE SWITCH-SEEN PATH (migration 118). Every polled switch reports its own
  // LLDP table (snmp_neighbors), and until now nothing ever compared one poll
  // of it with the next — topology_changes was only fed by the agent's own
  // LLDP report, which agents do not send, so the table stayed empty while the
  // switches' neighbours changed underneath it.
  //
  // Same diff, same flap collapse, same audit evidence as processReport; the
  // differences are all about WHERE the previous snapshot comes from, which is
  // the caller's business (the SNMP topology ingest), and about what must NOT
  // be announced:
  //
  //   * The FIRST snapshot of a device is a baseline, not news. A switch added
  //     to the inventory with forty neighbours must not put forty
  //     "neighbour added" rows on the page a shift starts on.
  //   * An EMPTY current table is not "every neighbour left". An LLDP walk that
  //     timed out, or a switch with LLDP turned off, reports nothing; a switch
  //     that genuinely lost every neighbour at once is far rarer than either,
  //     and announcing it wrongly would be alarming.
  //
  // Nothing is deleted here — snmp_neighbors ages out on last_seen — so the
  // caller passes `prev` as the previous POLL's rows (not everything stored),
  // and a neighbour that went away is simply absent from the next `prev`.
  //
  //   prev/next: [{ localPort, remoteChassisId, remotePort, remoteName? }]
  async function processDeviceSnapshot({ agentId, deviceId, deviceName = null, prev = [], next = [] } = {}) {
    const out = { changes: [], collapsed: 0, baseline: false };
    const before = (Array.isArray(prev) ? prev : []).map(normEntry).filter((e) => e.remoteChassisId);
    const after = (Array.isArray(next) ? next : []).map(normEntry).filter((e) => e.remoteChassisId);
    if (!before.length) { out.baseline = true; return out; }
    if (!after.length) return out;
    if (typeof topologyChangesRepo.recentForDevice !== 'function') return out;

    const changes = diffSnapshots(before, after);
    if (!changes.length) return out;

    // A readable name for the far end: its sysName when the switch reported
    // one, the chassis id otherwise. Only the SUMMARY uses it — the flap key
    // stays on the chassis id, which is the identity.
    const names = new Map();
    for (const e of [...(prev || []), ...(next || [])]) {
      const chassis = e && (e.remoteChassisId ?? e.remote_chassis_id);
      const name = e && (e.remoteName ?? e.remoteSysName ?? e.remote_sys_name);
      if (chassis && name && !names.has(chassis)) names.set(chassis, name);
    }
    const label = deviceName || `device ${deviceId}`;
    const describe = (change, changeType = change.changeType) => {
      const chassis = change.remoteChassisId;
      const who = names.has(chassis) ? `${names.get(chassis)} (${chassis})` : chassis;
      return `${label}: ${summarize({ ...change, changeType, remoteChassisId: who })}`;
    };
    const target = (change) => `device:${deviceId}:${change.remoteChassisId ?? ''}`;

    const at = now();
    const since = new Date(at.getTime() - flapWindowMs);
    let recent = await topologyChangesRepo.recentForDevice({ deviceId, since });

    for (const change of changes) {
      const fk = flapKey(change);
      const existingFlap = recent.find((r) => r.changeType === 'flapping' && flapKey(r) === fk);
      const inv = existingFlap ? null : recent.find((r) => isInverse(r, change));
      const onto = existingFlap || inv;
      if (onto) {
        const summary = describe(change, 'flapping');
        const auditId = await writeAudit('topology_flapping', agentId, { ...change, summary }, { target: target(change) });
        await topologyChangesRepo.markFlapping(onto.id, { summary, detectedAt: at, auditLogId: auditId });
        onto.changeType = 'flapping';
        onto.detectedAt = at.toISOString();
        out.collapsed += 1;
        out.changes.push({ id: onto.id, changeType: 'flapping', collapsed: true });
        continue;
      }
      const summary = describe(change);
      const auditId = await writeAudit(`topology_${change.changeType}`, agentId, { ...change, summary }, { target: target(change) });
      const id = await topologyChangesRepo.insert({
        ...change, summary, agentId, deviceId, detectedAt: at, auditLogId: auditId,
      });
      recent = [{ ...change, summary, id, agentId, deviceId, detectedAt: at.toISOString() }, ...recent];
      out.changes.push({ id, changeType: change.changeType, collapsed: false });
    }
    return out;
  }

  return { processReport, processDeviceSnapshot, flapWindowSec };
}

module.exports = { createTopologyChangeService, readFlapWindowSec, DEFAULT_FLAP_WINDOW_SEC };
