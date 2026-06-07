'use strict';

// Formats a single incident as an English-only text draft for a CFCS (Center for
// Cybersikkerhed) NIS2 notification. Hardcoded template, no i18n — the operator
// edits the prose before submitting; this just assembles the known facts so they
// don't have to be transcribed by hand. Pure: takes the API incident shape
// (incidentsRepository.mapRow) and returns a string.

function fmtDuration(seconds) {
  if (seconds == null) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

const METRIC_LABEL = {
  reachability: 'Reachability (service unreachable)',
  latency: 'Latency (elevated round-trip time)',
  packet_loss: 'Packet loss',
};

function nis2Draft(incident, { generatedAt = new Date() } = {}) {
  const detection = incident.startedAt ? new Date(incident.startedAt) : null;
  const resolved = incident.resolvedAt ? new Date(incident.resolvedAt) : null;
  const active = incident.status === 'active' || !resolved;

  const location = incident.locationName
    ? `${incident.locationName}${incident.locationId != null ? ` (location #${incident.locationId})` : ''}`
    : (incident.locationId != null ? `location #${incident.locationId}` : 'Unassigned (no location set)');

  const duration = active
    ? `Ongoing (not yet resolved) — at least ${fmtDuration(Math.round((generatedAt.getTime() - (detection ? detection.getTime() : generatedAt.getTime())) / 1000))} so far`
    : (incident.durationSeconds != null ? fmtDuration(incident.durationSeconds) : 'Unknown');

  const lines = [
    'NIS2 INCIDENT NOTIFICATION — DRAFT',
    'Recipient: Center for Cybersikkerhed (CFCS)',
    '(Auto-generated draft. Review and complete before submission.)',
    '',
    `Incident reference: #${incident.id}`,
    `Detection time (UTC): ${detection ? detection.toISOString() : 'unknown'}`,
    `Current status: ${active ? 'ACTIVE — incident ongoing' : 'RESOLVED'}`,
    resolved ? `Resolution time (UTC): ${resolved.toISOString()}` : null,
    `Duration: ${duration}`,
    `Severity: ${String(incident.severity || 'unknown').toUpperCase()}`,
    '',
    'Affected service / monitoring:',
    `  - Affected location: ${location}`,
    `  - Affected target: ${incident.affectedTarget}`,
    `  - Reporting agent: ${incident.agentName || `agent #${incident.agentId}`}`,
    `  - Impacted metric: ${METRIC_LABEL[incident.metric] || incident.metric}`,
    '',
    'Summary:',
    `  A ${String(incident.severity || '').toLowerCase()} incident was detected for ${incident.affectedTarget}`,
    `  at ${location}. The condition was identified by automated monitoring`,
    `  (${METRIC_LABEL[incident.metric] || incident.metric}) against the configured threshold.`,
    '',
    `Draft generated (UTC): ${generatedAt.toISOString()}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

module.exports = { nis2Draft };
