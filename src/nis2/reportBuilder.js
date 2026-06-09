'use strict';

const {
  CATEGORIES, RISK_STATUSES, CONTROL_STATUSES, CONTROL_FREQUENCIES,
  INCIDENT_SEVERITIES, INCIDENT_STATUSES,
} = require('./constants');
const { cell } = require('../lib/csv');

// The Report Generator's data model. Each "source" the user can drop into a
// custom report declares: a label/description, the columns it can project, a
// sensible default column set, and the filters it understands. The frontend
// reads this (GET /custom-reports/sources) to build its selectors, and the
// builder below applies it server-side — so the two never drift.

const COL = (key, label) => ({ key, label });
const yesNoAny = [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const withAny = (opts) => ['', ...opts].map((o) => (o === '' ? { value: '', label: 'Any' } : { value: o, label: o }));

const SOURCES = {
  summary: {
    label: 'Readiness summary',
    description: 'Headline NIS2 metrics (readiness %, open risks, incidents, evidence gaps).',
    columns: [], defaultColumns: [], filters: [],
  },
  categories: {
    label: 'Category status',
    description: 'Per-category readiness score and status.',
    columns: [COL('category', 'Category'), COL('controlCount', 'Controls'), COL('score', 'Score'), COL('status', 'Status')],
    defaultColumns: ['category', 'controlCount', 'score', 'status'],
    filters: [],
  },
  risks: {
    label: 'Risk register',
    description: 'Risks with likelihood/impact, score band, owner and status.',
    columns: [
      COL('id', 'ID'), COL('title', 'Title'), COL('category', 'Category'), COL('affectedAsset', 'Asset'),
      COL('likelihood', 'Likelihood'), COL('impact', 'Impact'), COL('riskScore', 'Score'), COL('band', 'Band'),
      COL('owner', 'Owner'), COL('status', 'Status'), COL('mitigationPlan', 'Mitigation'), COL('dueDate', 'Due'),
      COL('managementAcceptance', 'Mgmt accepted'), COL('evidenceLink', 'Evidence'),
      COL('createdAt', 'Created'), COL('updatedAt', 'Updated'),
    ],
    defaultColumns: ['title', 'category', 'riskScore', 'band', 'owner', 'status', 'dueDate'],
    filters: [
      { key: 'status', label: 'Status', type: 'enum', options: withAny(RISK_STATUSES) },
      { key: 'category', label: 'Category', type: 'enum', options: withAny(CATEGORIES) },
      { key: 'band', label: 'Band', type: 'enum', options: withAny(['Low', 'Medium', 'High', 'Critical']) },
      { key: 'minScore', label: 'Min score', type: 'number' },
    ],
  },
  controls: {
    label: 'Controls',
    description: 'Control-evidence activities with status, owner, cadence and evidence.',
    columns: [
      COL('id', 'ID'), COL('controlName', 'Control'), COL('nis2Area', 'Area'), COL('description', 'Description'),
      COL('owner', 'Owner'), COL('frequency', 'Frequency'), COL('lastPerformed', 'Last performed'),
      COL('nextDue', 'Next due'), COL('evidenceFile', 'Evidence'), COL('hasEvidence', 'Has evidence'),
      COL('status', 'Status'), COL('comment', 'Comment'), COL('createdAt', 'Created'), COL('updatedAt', 'Updated'),
    ],
    defaultColumns: ['controlName', 'nis2Area', 'owner', 'frequency', 'status', 'nextDue', 'hasEvidence'],
    filters: [
      { key: 'area', label: 'Area', type: 'enum', options: withAny(CATEGORIES) },
      { key: 'status', label: 'Status', type: 'enum', options: withAny(CONTROL_STATUSES) },
      { key: 'frequency', label: 'Frequency', type: 'enum', options: withAny(CONTROL_FREQUENCIES) },
      { key: 'evidence', label: 'Evidence', type: 'enum', options: [{ value: '', label: 'Any' }, { value: 'present', label: 'Has evidence' }, { value: 'missing', label: 'Missing evidence' }] },
    ],
  },
  incidents: {
    label: 'Security incidents',
    description: 'Recorded security incidents with severity, status and NIS2 flags.',
    columns: [
      COL('id', 'ID'), COL('incidentId', 'Ref'), COL('title', 'Title'), COL('severity', 'Severity'),
      COL('detectedAt', 'Detected'), COL('startedAt', 'Started'), COL('resolvedAt', 'Resolved'),
      COL('affectedSystems', 'Affected systems'), COL('businessImpact', 'Business impact'),
      COL('rootCause', 'Root cause'), COL('actionsTaken', 'Actions taken'),
      COL('nis2Relevant', 'NIS2 relevant'), COL('notificationRequired', 'Notify'),
      COL('status', 'Status'), COL('lessonsLearned', 'Lessons learned'),
      COL('createdAt', 'Created'), COL('updatedAt', 'Updated'),
    ],
    defaultColumns: ['incidentId', 'title', 'severity', 'detectedAt', 'status', 'nis2Relevant', 'notificationRequired'],
    filters: [
      { key: 'severity', label: 'Severity', type: 'enum', options: withAny(INCIDENT_SEVERITIES) },
      { key: 'status', label: 'Status', type: 'enum', options: withAny(INCIDENT_STATUSES) },
      { key: 'nis2Relevant', label: 'NIS2 relevant', type: 'enum', options: yesNoAny },
      { key: 'notificationRequired', label: 'Notification required', type: 'enum', options: yesNoAny },
      { key: 'from', label: 'Detected from', type: 'date' },
      { key: 'to', label: 'Detected to', type: 'date' },
    ],
  },
  audit: {
    label: 'Audit trail',
    description: 'Change log for risks, controls, incidents and reports (admin only).',
    adminOnly: true,
    columns: [
      COL('id', 'ID'), COL('createdAt', 'When'), COL('userEmail', 'User'),
      COL('action', 'Action'), COL('entityType', 'Entity'), COL('entityId', 'Entity ID'),
    ],
    defaultColumns: ['createdAt', 'userEmail', 'action', 'entityType', 'entityId'],
    filters: [
      { key: 'entityType', label: 'Entity', type: 'enum', options: withAny(['risk', 'control', 'incident', 'report', 'evidence']) },
    ],
  },
};

const SOURCE_KEYS = Object.freeze(Object.keys(SOURCES));

// The serialisable source catalogue for the UI, hiding admin-only sources from
// non-admins so they never appear as a dead selector.
function sourcesFor(isAdmin) {
  return SOURCE_KEYS
    .filter((k) => isAdmin || !SOURCES[k].adminOnly)
    .map((k) => ({ key: k, ...SOURCES[k] }));
}

// ---- value + column projection --------------------------------------------

function fmtVal(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v == null) return '';
  return v;
}

// Resolves the requested columns against a source definition (invalid/unknown
// keys are dropped; an empty selection falls back to the defaults), then maps
// each record to an array of cell values aligned to the chosen headers.
function project(records, def, requestedCols) {
  const valid = def.columns.map((c) => c.key);
  let keys = Array.isArray(requestedCols) && requestedCols.length
    ? requestedCols.filter((k) => valid.includes(k))
    : def.defaultColumns.slice();
  if (!keys.length) keys = def.defaultColumns.slice();
  const headers = keys.map((k) => def.columns.find((c) => c.key === k).label);
  const rows = records.map((rec) => keys.map((k) => fmtVal(rec[k])));
  return { headers, rows };
}

// ---- per-source section builders ------------------------------------------

function buildSummary(sec, { dashboard }) {
  if (!dashboard) return null;
  const rows = [
    ['Readiness score', `${dashboard.readinessScore}%`],
    ['Open critical risks', dashboard.openCriticalRisks],
    ['Open high/medium findings', dashboard.openHighMediumFindings],
    ['Incidents (last 30 days)', dashboard.incidentsLast30Days],
    ['Controls without evidence', dashboard.controlsWithoutEvidence],
    ['Total risks', dashboard.totals.risks],
    ['Total controls', dashboard.totals.controls],
    ['Total incidents', dashboard.totals.incidents],
  ];
  return { source: 'summary', heading: 'Readiness summary', headers: ['Metric', 'Value'], rows, rowCount: rows.length };
}

function buildCategories(sec, { dashboard }, def) {
  if (!dashboard) return null;
  const { headers, rows } = project(dashboard.categories, def, sec.columns);
  return { source: 'categories', heading: 'Category status', headers, rows, rowCount: dashboard.categories.length };
}

function buildRisks(sec, { risks = [] }, def) {
  const f = sec.filters || {};
  const filtered = risks.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.band && r.band !== f.band) return false;
    if (f.minScore !== undefined && f.minScore !== '' && f.minScore !== null && r.riskScore < Number(f.minScore)) return false;
    return true;
  }).sort((a, b) => b.riskScore - a.riskScore);
  const { headers, rows } = project(filtered, def, sec.columns);
  return { source: 'risks', heading: `Risk register (${filtered.length})`, headers, rows, rowCount: filtered.length };
}

function buildControls(sec, { controls = [] }, def) {
  const f = sec.filters || {};
  const filtered = controls.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (f.area && c.nis2Area !== f.area) return false;
    if (f.frequency && c.frequency !== f.frequency) return false;
    if (f.evidence === 'present' && !c.hasEvidence) return false;
    if (f.evidence === 'missing' && c.hasEvidence) return false;
    return true;
  }).sort((a, b) => String(a.nis2Area).localeCompare(String(b.nis2Area)));
  const { headers, rows } = project(filtered, def, sec.columns);
  return { source: 'controls', heading: `Controls (${filtered.length})`, headers, rows, rowCount: filtered.length };
}

function buildIncidents(sec, { incidents = [] }, def) {
  const f = sec.filters || {};
  const fromT = f.from ? new Date(f.from).getTime() : null;
  const toT = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;
  const filtered = incidents.filter((i) => {
    if (f.severity && i.severity !== f.severity) return false;
    if (f.status && i.status !== f.status) return false;
    if (f.nis2Relevant === 'yes' && !i.nis2Relevant) return false;
    if (f.nis2Relevant === 'no' && i.nis2Relevant) return false;
    if (f.notificationRequired === 'yes' && !i.notificationRequired) return false;
    if (f.notificationRequired === 'no' && i.notificationRequired) return false;
    if (fromT != null) { const t = i.detectedAt ? new Date(i.detectedAt).getTime() : null; if (t == null || t < fromT) return false; }
    if (toT != null) { const t = i.detectedAt ? new Date(i.detectedAt).getTime() : null; if (t == null || t > toT) return false; }
    return true;
  }).sort((a, b) => new Date(b.detectedAt || b.createdAt || 0) - new Date(a.detectedAt || a.createdAt || 0));
  const { headers, rows } = project(filtered, def, sec.columns);
  return { source: 'incidents', heading: `Security incidents (${filtered.length})`, headers, rows, rowCount: filtered.length };
}

function buildAudit(sec, { audit = [] }, def) {
  const f = sec.filters || {};
  const filtered = audit.filter((a) => (!f.entityType || a.entityType === f.entityType));
  const { headers, rows } = project(filtered, def, sec.columns);
  return { source: 'audit', heading: `Audit trail (${filtered.length})`, headers, rows, rowCount: filtered.length };
}

const BUILDERS = {
  summary: buildSummary, categories: buildCategories, risks: buildRisks,
  controls: buildControls, incidents: buildIncidents, audit: buildAudit,
};

// Builds a custom report from a validated spec + the loaded data. Sections are
// emitted in the spec's order; admin-only sources are skipped when !isAdmin
// (the route also rejects them up front, this is defence in depth). The output
// is directly compatible with report.js renderRegisterHtml.
function buildCustomReport(spec, data, { isAdmin = false } = {}) {
  const sections = [];
  for (const sec of spec.sections || []) {
    const def = SOURCES[sec.source];
    if (!def) continue;
    if (def.adminOnly && !isAdmin) continue;
    const built = BUILDERS[sec.source](sec, data, def);
    if (built) sections.push(built);
  }
  return {
    title: spec.title || 'Custom Report',
    org: spec.org || 'Organisation',
    generatedAt: new Date().toISOString(),
    sections,
  };
}

// Serialises a multi-section custom report to CSV: each section is a heading
// comment line, a header row, then its rows. Uses the injection-safe cell().
function customReportToCsv(report) {
  const blocks = report.sections.map((s) => {
    const lines = [`# ${s.heading}`, s.headers.map(cell).join(',')];
    for (const r of s.rows) lines.push(r.map(cell).join(','));
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

module.exports = { SOURCES, SOURCE_KEYS, sourcesFor, buildCustomReport, customReportToCsv };
