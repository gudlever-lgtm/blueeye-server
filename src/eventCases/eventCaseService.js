'use strict';

const { DEFAULT_WINDOW_MS } = require('../analysis/correlator');
const { formatDeviceLabel } = require('./deviceLabel');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Auto-creation + grouping policy for the event_cases entity. Runs AFTER a
// finding (the system's "anomaly") has been saved by the pipeline, and decides
// which event it belongs to:
//
//   - a new finding on the same device (host_id) within `windowMs` of an existing
//     OPEN event's last activity is grouped into that event (its severity
//     is escalated + last_event_at advanced);
//   - otherwise a fresh event is opened automatically with status=open.
//
// The window reuses the correlator's default (60s) so event grouping and
// root-cause correlation see the same "same device / same time window". State
// transitions (investigating/resolved/closed/reopen) and the read API are added
// separately — this service only opens/extends events.
//
// Best-effort by contract: the caller wraps every call so a failure here never
// affects ingestion.
//
//   const svc = createEventCaseService({ eventCasesRepo, findingStore });
//   await svc.assignFinding(finding);
const DEFAULT_CONFIG_WINDOW_MS = 30 * 60 * 1000; // 30 min (configurable)

function createEventCaseService({
  eventCasesRepo,
  findingStore,
  windowMs = DEFAULT_WINDOW_MS,
  // Optional device-config correlation (Fase 3 pt 4). When wired, a new anomaly
  // is checked against config changes on the same device within configWindowMs
  // before it; the first such change is linked to the event.
  configSnapshotsRepo = null,
  configWindowMs = DEFAULT_CONFIG_WINDOW_MS,
  // Optional device identity. When wired, the auto-generated title names the
  // agent and its site instead of the bare agent id — "on core-sw
  // (Copenhagen HQ)" rather than "on 1" — so an event says where it is
  // without a lookup. Unwired (or an unknown host) falls back to the id.
  agentsRepo = null,
  now = () => new Date(),
  logger = silentLogger,
}) {
  // The device identity behind a finding's host_id, or null. Best-effort: a
  // failed lookup costs the title its name, never the event.
  async function deviceFor(host) {
    if (!agentsRepo || typeof agentsRepo.findById !== 'function') return null;
    const agentId = Number(host);
    if (!Number.isInteger(agentId)) return null;
    try {
      const agent = await agentsRepo.findById(agentId);
      if (!agent) return null;
      return {
        agentName: agent.display_name || agent.hostname || null,
        locationName: agent.location_name || null,
      };
    } catch (err) {
      logger.warn(`event-cases: device lookup failed for host ${host} (${err.message})`);
      return null;
    }
  }

  // A short, explainable title derived from the primary finding, e.g.
  // "CRIT interface_errors on core-sw (Copenhagen HQ)". Bounded to the column width.
  function titleFor(finding, device = null) {
    const where = formatDeviceLabel({ hostId: finding.hostId, ...(device || {}) });
    const metric = finding.metric || 'anomaly';
    const sev = finding.severity || 'INFO';
    return `${sev} ${metric} on ${where}`.slice(0, 255);
  }

  // Correlates a device-config change to an event: if a config snapshot was
  // captured on the device within configWindowMs BEFORE the anomaly, link it as
  // the suspected trigger. Guarded (setConfigChange only sets when NULL) so the
  // first correlated change wins. Best-effort — never throws to the caller.
  async function correlateConfigChange(eventId, host, at) {
    if (!configSnapshotsRepo || typeof configSnapshotsRepo.latestForDeviceBetween !== 'function') return;
    const deviceId = Number(host);
    if (!Number.isInteger(deviceId)) return; // host isn't an agent id → skip
    try {
      const from = new Date(at.getTime() - configWindowMs);
      const change = await configSnapshotsRepo.latestForDeviceBetween(deviceId, from, at);
      if (change) await eventCasesRepo.setConfigChange(eventId, change.id);
    } catch (err) {
      logger.warn(`event-cases: config correlation failed for event ${eventId} (${err.message})`);
    }
  }

  // Places one finding into an event case. Returns
  // { eventCaseId, created } or null when the finding can't be placed (no id
  // or host). Never throws — errors are logged and swallowed.
  async function assignFinding(finding) {
    if (!finding || !finding.id || finding.hostId == null) return null;
    const host = String(finding.hostId);
    const at = finding.createdAt ? new Date(finding.createdAt) : now();
    const severity = finding.severity || 'INFO';

    try {
      const open = await eventCasesRepo.findOpenByHost(host);
      if (open && open.lastEventAt) {
        const withinWindow = at.getTime() - new Date(open.lastEventAt).getTime() <= windowMs;
        if (withinWindow) {
          await eventCasesRepo.updateActivity(open.id, { lastEventAt: at, severity });
          await findingStore.setEventCase(finding.id, open.id);
          await correlateConfigChange(open.id, host, at);
          return { eventCaseId: open.id, created: false };
        }
      }

      const id = await eventCasesRepo.create({
        host_id: host,
        title: titleFor(finding, await deviceFor(host)),
        status: 'open',
        severity,
        primary_finding_id: finding.id,
        first_event_at: at,
        last_event_at: at,
        created_by: 'system',
      });
      await findingStore.setEventCase(finding.id, id);
      await correlateConfigChange(id, host, at);
      return { eventCaseId: id, created: true };
    } catch (err) {
      logger.warn(`event-cases: could not assign finding ${finding.id} (${err.message})`);
      return null;
    }
  }

  return { assignFinding };
}

module.exports = { createEventCaseService };
