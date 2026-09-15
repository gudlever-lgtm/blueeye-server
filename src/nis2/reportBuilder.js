'use strict';

const {
  CATEGORIES, RISK_STATUSES, CONTROL_STATUSES, CONTROL_FREQUENCIES,
  INCIDENT_SEVERITIES, INCIDENT_STATUSES,
} = require('./constants');
const { cell } = require('../lib/csv');
const { createT } = require('./i18n');

// The Report Generator's data model. Each "source" the user can drop into a
// custom report declares: a label/description, the columns it can project, a
// sensible default column set, and the filters it understands. The frontend
// reads this (GET /custom-reports/sources) to build its selectors, and the
// builder below applies it server-side — so the two never drift.
//
// Labels are i18n KEYS, not text: the catalogue lives in ./i18n.js and is
// resolved per request, because two users can pull a report in two languages at
// once. What is NOT translated here is a record's own values — the Generator is
// an extraction tool, and a column the user picked comes back as the register
// holds it. (The executive and register documents in ./report.js do translate
// their enums; they are written to be read, not re-imported.)

const COL = (key, labelKey) => ({ key, labelKey });
// Filter options carry the raw value the builder compares against plus the key
// naming it — so translating a dropdown can never change what it filters on.
const OPT = (value, labelKey) => ({ value, labelKey });
const yesNoAny = [OPT('', 'filter.any'), OPT('yes', 'filter.yes'), OPT('no', 'filter.no')];
// Enum options label themselves from the enum catalogue (`prefix.value`), so a
// value with no translation still renders as itself rather than as a key.
const withAny = (prefix, opts) => [OPT('', 'filter.any'), ...opts.map((o) => ({ value: o, enumPrefix: prefix }))];

const SOURCES = {
  summary: {
    labelKey: 'src.summary.label',
    descriptionKey: 'src.summary.description',
    columns: [], defaultColumns: [], filters: [],
  },
  categories: {
    labelKey: 'src.categories.label',
    descriptionKey: 'src.categories.description',
    columns: [COL('category', 'col.category'), COL('controlCount', 'col.controls'), COL('score', 'col.score'), COL('status', 'col.status')],
    defaultColumns: ['category', 'controlCount', 'score', 'status'],
    filters: [],
  },
  risks: {
    labelKey: 'src.risks.label',
    descriptionKey: 'src.risks.description',
    columns: [
      COL('id', 'col.id'), COL('title', 'col.title'), COL('category', 'col.category'), COL('affectedAsset', 'col.asset'),
      COL('likelihood', 'col.likelihood'), COL('impact', 'col.impact'), COL('riskScore', 'col.score'), COL('band', 'col.band'),
      COL('owner', 'col.owner'), COL('status', 'col.status'), COL('mitigationPlan', 'col.mitigation'), COL('dueDate', 'col.due'),
      COL('managementAcceptance', 'col.mgmtAccepted'), COL('evidenceLink', 'col.evidence'),
      COL('createdAt', 'col.created'), COL('updatedAt', 'col.updated'),
    ],
    defaultColumns: ['title', 'category', 'riskScore', 'band', 'owner', 'status', 'dueDate'],
    filters: [
      { key: 'status', labelKey: 'col.status', type: 'enum', options: withAny('riskStatus', RISK_STATUSES) },
      { key: 'category', labelKey: 'col.category', type: 'enum', options: withAny('cat', CATEGORIES) },
      { key: 'band', labelKey: 'col.band', type: 'enum', options: withAny('band', ['Low', 'Medium', 'High', 'Critical']) },
      { key: 'minScore', labelKey: 'filter.minScore', type: 'number' },
    ],
  },
  controls: {
    labelKey: 'src.controls.label',
    descriptionKey: 'src.controls.description',
    columns: [
      COL('id', 'col.id'), COL('controlName', 'col.control'), COL('nis2Area', 'col.area'), COL('description', 'col.description'),
      COL('owner', 'col.owner'), COL('frequency', 'col.frequency'), COL('lastPerformed', 'col.lastPerformed'),
      COL('nextDue', 'col.nextDue'), COL('evidenceFile', 'col.evidence'), COL('hasEvidence', 'col.hasEvidence'),
      COL('status', 'col.status'), COL('comment', 'col.comment'), COL('createdAt', 'col.created'), COL('updatedAt', 'col.updated'),
    ],
    defaultColumns: ['controlName', 'nis2Area', 'owner', 'frequency', 'status', 'nextDue', 'hasEvidence'],
    filters: [
      { key: 'area', labelKey: 'col.area', type: 'enum', options: withAny('cat', CATEGORIES) },
      { key: 'status', labelKey: 'col.status', type: 'enum', options: withAny('controlStatus', CONTROL_STATUSES) },
      { key: 'frequency', labelKey: 'col.frequency', type: 'enum', options: withAny('frequency', CONTROL_FREQUENCIES) },
      { key: 'evidence', labelKey: 'col.evidence', type: 'enum', options: [OPT('', 'filter.any'), OPT('present', 'filter.evidencePresent'), OPT('missing', 'filter.evidenceMissing')] },
    ],
  },
  incidents: {
    labelKey: 'src.incidents.label',
    descriptionKey: 'src.incidents.description',
    columns: [
      COL('id', 'col.id'), COL('incidentId', 'col.ref'), COL('title', 'col.title'), COL('severity', 'col.severity'),
      COL('detectedAt', 'col.detected'), COL('startedAt', 'col.started'), COL('resolvedAt', 'col.resolved'),
      COL('affectedSystems', 'col.affectedSystems'), COL('businessImpact', 'col.businessImpact'),
      COL('rootCause', 'col.rootCause'), COL('actionsTaken', 'col.actionsTaken'),
      COL('nis2Relevant', 'col.nis2Relevant'), COL('notificationRequired', 'col.notify'),
      COL('status', 'col.status'), COL('lessonsLearned', 'col.lessons'),
      COL('createdAt', 'col.created'), COL('updatedAt', 'col.updated'),
    ],
    defaultColumns: ['incidentId', 'title', 'severity', 'detectedAt', 'status', 'nis2Relevant', 'notificationRequired'],
    filters: [
      { key: 'severity', labelKey: 'col.severity', type: 'enum', options: withAny('severity', INCIDENT_SEVERITIES) },
      { key: 'status', labelKey: 'col.status', type: 'enum', options: withAny('incidentStatus', INCIDENT_STATUSES) },
      { key: 'nis2Relevant', labelKey: 'col.nis2Relevant', type: 'enum', options: yesNoAny },
      { key: 'notificationRequired', labelKey: 'filter.notificationRequired', type: 'enum', options: yesNoAny },
      { key: 'from', labelKey: 'filter.detectedFrom', type: 'date' },
      { key: 'to', labelKey: 'filter.detectedTo', type: 'date' },
    ],
  },
  audit: {
    labelKey: 'src.audit.label',
    descriptionKey: 'src.audit.description',
    adminOnly: true,
    columns: [
      COL('id', 'col.id'), COL('createdAt', 'col.when'), COL('userEmail', 'col.user'),
      COL('action', 'col.action'), COL('entityType', 'col.entity'), COL('entityId', 'col.entityId'),
    ],
    defaultColumns: ['createdAt', 'userEmail', 'action', 'entityType', 'entityId'],
    filters: [
      { key: 'entityType', labelKey: 'col.entity', type: 'enum', options: withAny('entityType', ['risk', 'control', 'incident', 'report', 'evidence']) },
    ],
  },
};

const SOURCE_KEYS = Object.freeze(Object.keys(SOURCES));

// Resolves one filter option's display label. `enumPrefix` options label
// themselves from the enum catalogue; everything else names its key outright.
function optionLabel(opt, t) {
  return opt.enumPrefix ? t.enum(opt.enumPrefix, opt.value) : t(opt.labelKey);
}

// The serialisable source catalogue for the UI, hiding admin-only sources from
// non-admins so they never appear as a dead selector. Keys are resolved to text
// here — the frontend receives `label`/`description` exactly as it always did,
// in the requested language.
function sourcesFor(isAdmin, locale) {
  const t = createT(locale);
  return SOURCE_KEYS
    .filter((k) => isAdmin || !SOURCES[k].adminOnly)
    .map((k) => {
      const def = SOURCES[k];
      return {
        key: k,
        label: t(def.labelKey),
        description: t(def.descriptionKey),
        adminOnly: def.adminOnly === true,
        columns: def.columns.map((c) => ({ key: c.key, label: t(c.labelKey) })),
        defaultColumns: def.defaultColumns.slice(),
        filters: def.filters.map((f) => ({
          key: f.key,
          label: t(f.labelKey),
          type: f.type,
          ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: optionLabel(o, t) })) } : {}),
        })),
      };
    });
}

// ---- value + column projection --------------------------------------------

// A boolean is computed, not stored, so it is rendered rather than passed
// through — unlike the record's own string values, which stay verbatim.
function fmtVal(v, t) {
  if (v === true) return t('doc.yes');
  if (v === false) return t('doc.no');
  if (v == null) return '';
  return v;
}

// Resolves the requested columns against a source definition (invalid/unknown
// keys are dropped; an empty selection falls back to the defaults), then maps
// each record to an array of cell values aligned to the chosen headers.
function project(records, def, requestedCols, t) {
  const valid = def.columns.map((c) => c.key);
  let keys = Array.isArray(requestedCols) && requestedCols.length
    ? requestedCols.filter((k) => valid.includes(k))
    : def.defaultColumns.slice();
  if (!keys.length) keys = def.defaultColumns.slice();
  const headers = keys.map((k) => t(def.columns.find((c) => c.key === k).labelKey));
  const rows = records.map((rec) => keys.map((k) => fmtVal(rec[k], t)));
  return { headers, rows };
}

// ---- per-source section builders ------------------------------------------

function buildSummary(sec, { dashboard }, def, t) {
  if (!dashboard) return null;
  const rows = [
    [t('metric.readiness'), `${dashboard.readinessScore}%`],
    [t('metric.criticalRisks'), dashboard.openCriticalRisks],
    [t('metric.findings'), dashboard.openHighMediumFindings],
    [t('metric.incidents30'), dashboard.incidentsLast30Days],
    [t('metric.noEvidence'), dashboard.controlsWithoutEvidence],
    [t('metric.totalRisks'), dashboard.totals.risks],
    [t('metric.totalControls'), dashboard.totals.controls],
    [t('metric.totalIncidents'), dashboard.totals.incidents],
  ];
  return { source: 'summary', heading: t('summary.heading'), headers: [t('col.metric'), t('col.value')], rows, rowCount: rows.length };
}

function buildCategories(sec, { dashboard }, def, t) {
  if (!dashboard) return null;
  const { headers, rows } = project(dashboard.categories, def, sec.columns, t);
  return { source: 'categories', heading: t('categories.heading'), headers, rows, rowCount: dashboard.categories.length };
}

function buildRisks(sec, { risks = [] }, def, t) {
  const f = sec.filters || {};
  const filtered = risks.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.band && r.band !== f.band) return false;
    if (f.minScore !== undefined && f.minScore !== '' && f.minScore !== null && r.riskScore < Number(f.minScore)) return false;
    return true;
  }).sort((a, b) => b.riskScore - a.riskScore);
  const { headers, rows } = project(filtered, def, sec.columns, t);
  return { source: 'risks', heading: t('risk.heading', { n: filtered.length }), headers, rows, rowCount: filtered.length };
}

function buildControls(sec, { controls = [] }, def, t) {
  const f = sec.filters || {};
  const filtered = controls.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (f.area && c.nis2Area !== f.area) return false;
    if (f.frequency && c.frequency !== f.frequency) return false;
    if (f.evidence === 'present' && !c.hasEvidence) return false;
    if (f.evidence === 'missing' && c.hasEvidence) return false;
    return true;
  }).sort((a, b) => String(a.nis2Area).localeCompare(String(b.nis2Area)));
  const { headers, rows } = project(filtered, def, sec.columns, t);
  return { source: 'controls', heading: t('control.heading', { n: filtered.length }), headers, rows, rowCount: filtered.length };
}

function buildIncidents(sec, { incidents = [] }, def, t) {
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
  const { headers, rows } = project(filtered, def, sec.columns, t);
  return { source: 'incidents', heading: t('incidents.heading', { n: filtered.length }), headers, rows, rowCount: filtered.length };
}

function buildAudit(sec, { audit = [] }, def, t) {
  const f = sec.filters || {};
  const filtered = audit.filter((a) => (!f.entityType || a.entityType === f.entityType));
  const { headers, rows } = project(filtered, def, sec.columns, t);
  return { source: 'audit', heading: t('audit.heading', { n: filtered.length }), headers, rows, rowCount: filtered.length };
}

const BUILDERS = {
  summary: buildSummary, categories: buildCategories, risks: buildRisks,
  controls: buildControls, incidents: buildIncidents, audit: buildAudit,
};

// Builds a custom report from a validated spec + the loaded data. Sections are
// emitted in the spec's order; admin-only sources are skipped when !isAdmin
// (the route also rejects them up front, this is defence in depth). The output
// is directly compatible with report.js renderRegisterHtml.
function buildCustomReport(spec, data, { isAdmin = false, locale } = {}) {
  const t = createT(locale);
  const sections = [];
  for (const sec of spec.sections || []) {
    const def = SOURCES[sec.source];
    if (!def) continue;
    if (def.adminOnly && !isAdmin) continue;
    const built = BUILDERS[sec.source](sec, data, def, t);
    if (built) sections.push(built);
  }
  return {
    locale: t.locale,
    title: spec.title || t('title.custom'),
    org: spec.org || t('doc.org'),
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
