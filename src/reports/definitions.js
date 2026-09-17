'use strict';

// What a report IS, in one place: its columns, how a stored row becomes a
// report row, and how to fetch the rows. The HTTP exports and the scheduled
// sends both build from here, so a column added for one appears in the other —
// a monthly SLA mail that quietly disagrees with the CSV a customer downloads
// is worse than either.
//
// The loaders take the repositories rather than a request: the scheduler has no
// request, and a report definition should not care where the period came from.

const { toCsv } = require('../lib/csv');
const { renderReportHtml } = require('../lib/reportHtml');

const REPORT_IDS = ['availability', 'probe_outages'];
const FORMATS = ['csv', 'html'];

const AVAIL_COLUMNS = [
  { key: 'location_name', label: 'Location' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'uptime_pct', label: 'Uptime %' },
  { key: 'up', label: 'Up' },
  { key: 'down', label: 'Down' },
  { key: 'total', label: 'Samples' },
];

const PROBE_OUTAGE_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'location_name', label: 'Location' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'metric', label: 'Metric' },
  { key: 'severity', label: 'Severity' },
  { key: 'started_at', label: 'Started' },
  { key: 'resolved_at', label: 'Resolved' },
  { key: 'duration_seconds', label: 'Duration (s)' },
  { key: 'affected_target', label: 'Target' },
];

const availRow = (r) => ({
  location_name: r.locationName ?? '(unassigned)',
  agent_name: r.agentName,
  uptime_pct: r.uptimePct == null ? '' : r.uptimePct,
  up: r.up,
  down: r.down,
  total: r.total,
});

const probeOutageRow = (r) => ({
  id: r.id,
  location_name: r.location_name ?? '(unassigned)',
  agent_name: r.agent_name,
  metric: r.metric,
  severity: r.severity,
  started_at: r.started_at,
  resolved_at: r.resolved_at ?? '(ongoing)',
  duration_seconds: r.duration_seconds ?? '',
  affected_target: r.affected_target ?? '',
});

const REPORTS = {
  availability: {
    id: 'availability',
    title: 'BlueEyes — Availability / SLA report',
    filename: 'blueeye-availability',
    columns: AVAIL_COLUMNS,
    row: availRow,
    load: ({ probeResultsRepo }, { from, to, locationId = null }) =>
      probeResultsRepo.availability({ from, to, locationId }),
  },
  probe_outages: {
    id: 'probe_outages',
    title: 'BlueEyes — Probe outages',
    filename: 'blueeye-probe-outages',
    columns: PROBE_OUTAGE_COLUMNS,
    row: probeOutageRow,
    load: ({ probeOutagesRepo }, { from, to, locationId = null, severity = null }) =>
      probeOutagesRepo.list({ from, to, severity, locationId }),
  },
};

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

// Fetches a report and renders it in one format. Returns the bytes plus what
// they are — the mailer needs a filename and a content type, and the exports
// need the same two.
async function buildReport({ report, format = 'csv', deps, params = {}, from, to }) {
  const def = REPORTS[report];
  if (!def) throw new Error(`unknown report: ${report}`);
  const rows = (await def.load(deps, { from, to, ...params })) || [];
  const mapped = rows.map(def.row);
  const subtitle = `${dayOf(from)} – ${dayOf(to)}`;
  if (format === 'html') {
    return {
      contentType: 'text/html; charset=utf-8',
      filename: `${def.filename}.html`,
      body: renderReportHtml({ title: def.title, subtitle, columns: def.columns, rows: mapped }),
      rowCount: mapped.length,
      title: def.title,
      subtitle,
    };
  }
  return {
    contentType: 'text/csv; charset=utf-8',
    filename: `${def.filename}.csv`,
    body: toCsv(def.columns.map((c) => c.key), mapped),
    rowCount: mapped.length,
    title: def.title,
    subtitle,
  };
}

module.exports = {
  REPORTS, REPORT_IDS, FORMATS,
  AVAIL_COLUMNS, PROBE_OUTAGE_COLUMNS, availRow, probeOutageRow,
  buildReport,
};
