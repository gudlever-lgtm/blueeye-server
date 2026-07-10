'use strict';

const { buildTimeline } = require('./timeline');
const { computeConfigDiff } = require('../config/diff');
const { maskIps, maskSecrets, maskConfigLine } = require('../config/mask');

// Builds the MASKED, aggregated context for the incident query-assistant
// (POST /api/incidents/:id/ask — the Mistral call itself is a later step). It
// reuses the same principle as the existing NIS2-draft / flow advisory: only
// aggregated and masked data ever leaves the process. In particular RAW device
// config text is NEVER forwarded — only masked diff summaries — and secret-
// bearing config lines and IP literals are redacted (via ../config/mask).

// Max changed config lines forwarded per config change (aggregation cap).
const MAX_CHANGED_LINES = 40;
// Max timeline events forwarded.
const MAX_TIMELINE = 100;

// Pure assembly + masking. Inputs are already-read rows; output is the object a
// later step hands to Mistral. No raw config_text is ever included.
function buildIncidentAskContext({ incident, timeline = [], configDiffs = [], similarIncidents = [] } = {}) {
  const maskedTimeline = timeline.slice(0, MAX_TIMELINE).map((e) => ({
    type: e.type,
    timestamp: e.timestamp,
    description: maskIps(e.description || ''),
    severity: e.severity ?? null,
    status: e.status ?? null,
  }));

  const configContext = configDiffs.map((d) => ({
    snapshotId: d.snapshotId ?? null,
    capturedAt: d.capturedAt ?? null,
    capturedVia: d.capturedVia ?? null,
    stats: d.stats || { added: 0, removed: 0 },
    // Masked, capped — NEVER the raw config_text.
    changedLines: (d.changedLines || []).slice(0, MAX_CHANGED_LINES).map((l) => ({
      op: l.op,
      text: maskConfigLine(l.text),
    })),
  }));

  return {
    incident: incident ? {
      id: incident.id,
      status: incident.status,
      severity: incident.severity,
      deviceId: incident.hostId,
      title: maskIps(incident.title || ''),
      firstEventAt: incident.firstEventAt ?? null,
      lastEventAt: incident.lastEventAt ?? null,
      resolvedAt: incident.resolvedAt ?? null,
    } : null,
    timeline: maskedTimeline,
    configContext,
    // Fase 4 (similar incidents) is not built yet — always empty for now, and
    // the flag below lets the caller/prompt say so honestly.
    similarIncidents,
    dataAvailability: {
      timelineEvents: maskedTimeline.length,
      configChanges: configContext.length,
      similarIncidents: similarIncidents.length,
      hasAnyData: maskedTimeline.length > 0 || configContext.length > 0 || similarIncidents.length > 0,
    },
  };
}

// Reads the pieces from the repos, then builds the masked context. Returns null
// when the incident does not exist (the future route maps that to 404). Mirrors
// the timeline route's source assembly so the assistant sees the same story.
async function gatherIncidentAskContext(id, {
  incidentCasesRepo,
  findingStore,
  auditEventsRepo = null,
  auditLogRepo = null,
  configSnapshotsRepo = null,
} = {}) {
  const incident = await incidentCasesRepo.findById(id);
  if (!incident) return null;

  const anomalies = await findingStore.listByIncidentCase(id);

  let configChanges = [];
  if (auditEventsRepo && typeof auditEventsRepo.findByTarget === 'function') {
    configChanges = await auditEventsRepo.findByTarget({
      targetType: 'agent',
      targetId: incident.hostId,
      from: incident.firstEventAt,
      to: incident.resolvedAt || null,
    });
  }

  let statusChanges = [];
  if (auditLogRepo && typeof auditLogRepo.listByTarget === 'function') {
    statusChanges = await auditLogRepo.listByTarget({ category: 'incident', target: String(id) });
  }

  const timeline = buildTimeline({ anomalies, configChanges, statusChanges });

  // Config diffs on the device (device_id = the incident host_id = agent id).
  const configDiffs = [];
  const deviceId = Number(incident.hostId);
  if (configSnapshotsRepo && Number.isInteger(deviceId)) {
    const snaps = await configSnapshotsRepo.listForDevice(deviceId, { limit: 5, withText: true });
    for (const snap of snaps) {
      // eslint-disable-next-line no-await-in-loop
      const prev = await configSnapshotsRepo.previousBefore(deviceId, snap.id);
      if (!prev) continue; // the initial baseline capture is not a "change"
      const diff = computeConfigDiff(prev.configText, snap.configText);
      if (diff.changed) {
        configDiffs.push({
          snapshotId: snap.id,
          capturedAt: snap.capturedAt,
          capturedVia: snap.capturedVia,
          stats: diff.stats,
          changedLines: diff.changedLines,
        });
      }
    }
  }

  const similarIncidents = []; // Fase 4 not built yet.

  return buildIncidentAskContext({ incident, timeline, configDiffs, similarIncidents });
}

module.exports = {
  buildIncidentAskContext,
  gatherIncidentAskContext,
  maskIps,
  maskSecrets,
  maskConfigLine,
};
