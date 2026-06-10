'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateReportRange, validateSeverityFilter } = require('../validation/incidentValidation');
const { nis2Draft } = require('../incidents/nis2');
const { toCsv } = require('../lib/csv');
const { renderReportHtml } = require('../lib/reportHtml');

// Reporting endpoints over derived incidents + probe availability. All under the
// existing user-JWT auth: availability + incident listing are viewer+, the NIS2
// draft (a regulator-facing document) is operator+.
//
// Downloadable exports are licence-gated: CSV behind `reports_csv` and the
// print-ready HTML (Print → PDF) behind `reports_pdf`. The JSON read endpoints
// stay ungated as part of "Basic reports". featureGate/planService are optional
// so a server wired without the plan layer keeps the JSON endpoints working.
function createReportsRouter({ probeResultsRepo, incidentsRepo, locationsRepo, featureGate = null, planService = null, auditLogger = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const csvGate = requirePlanFeature({ featureGate, planService }, 'reports_csv');
  const pdfGate = requirePlanFeature({ featureGate, planService }, 'reports_pdf');

  // Parses an optional ?location_id= filter. Returns { value } (number|null) or
  // { error } when it is present but not a positive integer.
  function parseLocationFilter(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const id = parseId(raw);
    if (id === null) return { error: 'location_id must be a positive integer' };
    return { value: id };
  }

  // Shared validation + fetch for the availability report. Resolves to
  // { error } (with status/body) or { range, loc, rows }.
  async function loadAvailability(req) {
    const { value: range, errors } = validateReportRange(req.query);
    if (errors) return { error: { status: 400, body: { error: 'Validation failed', details: errors } } };
    const loc = parseLocationFilter(req.query.location_id);
    if (loc.error) return { error: { status: 400, body: { error: 'Validation failed', details: { location_id: loc.error } } } };
    if (loc.value != null && locationsRepo) {
      const location = await locationsRepo.findById(loc.value);
      if (!location) return { error: { status: 404, body: { error: 'Location not found' } } };
    }
    const rows = await probeResultsRepo.availability({ from: range.from, to: range.to, locationId: loc.value });
    return { range, loc, rows };
  }

  async function loadIncidents(req) {
    const { value: range, errors } = validateReportRange(req.query);
    if (errors) return { error: { status: 400, body: { error: 'Validation failed', details: errors } } };
    const sev = validateSeverityFilter(req.query.severity);
    if (sev.errors) return { error: { status: 400, body: { error: 'Validation failed', details: sev.errors } } };
    const loc = parseLocationFilter(req.query.location_id);
    if (loc.error) return { error: { status: 400, body: { error: 'Validation failed', details: { location_id: loc.error } } } };
    if (loc.value != null && locationsRepo) {
      const location = await locationsRepo.findById(loc.value);
      if (!location) return { error: { status: 404, body: { error: 'Location not found' } } };
    }
    const rows = await incidentsRepo.list({ from: range.from, to: range.to, severity: sev.value, locationId: loc.value });
    return { range, loc, sev, rows };
  }

  // Column definitions shared by the CSV and HTML renderers.
  const AVAIL_COLUMNS = [
    { key: 'location_name', label: 'Location' },
    { key: 'agent_name', label: 'Agent' },
    { key: 'uptime_pct', label: 'Uptime %' },
    { key: 'up', label: 'Up' },
    { key: 'down', label: 'Down' },
    { key: 'total', label: 'Samples' },
  ];
  const INCIDENT_COLUMNS = [
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
    location_name: r.locationName ?? '(unassigned)', agent_name: r.agentName,
    uptime_pct: r.uptimePct == null ? '' : r.uptimePct, up: r.up, down: r.down, total: r.total,
  });
  const incidentRow = (r) => ({
    id: r.id, location_name: r.location_name ?? '(unassigned)', agent_name: r.agent_name,
    metric: r.metric, severity: r.severity, started_at: r.started_at, resolved_at: r.resolved_at ?? '(ongoing)',
    duration_seconds: r.duration_seconds ?? '', affected_target: r.affected_target ?? '',
  });

  function sendCsv(res, filename, columns, rows) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(columns.map((c) => c.key), rows));
  }
  function sendHtml(res, html) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
  async function auditExport(req, format, report, range) {
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'report', action: 'report_generate',
        target: `${report}.${format}`,
        detail: `${range.from.toISOString()}..${range.to.toISOString()}`,
      });
    }
  }

  // ---- Availability (SLA) -------------------------------------------------
  // GET /api/reports/availability?from=&to=&location_id= — uptime % per
  // location/agent over the period, from probe reachability. viewer+ (JSON).
  router.get('/availability', requireAuth, reader, asyncHandler(async (req, res) => {
    const out = await loadAvailability(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    res.json({ from: out.range.from.toISOString(), to: out.range.to.toISOString(), locationId: out.loc.value, agents: out.rows });
  }));

  // GET /api/reports/availability.csv — CSV export (reports_csv).
  router.get('/availability.csv', requireAuth, reader, csvGate, asyncHandler(async (req, res) => {
    const out = await loadAvailability(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    await auditExport(req, 'csv', 'availability', out.range);
    return sendCsv(res, 'blueeye-availability', AVAIL_COLUMNS, out.rows.map(availRow));
  }));

  // GET /api/reports/availability.html — print-ready report → PDF (reports_pdf).
  router.get('/availability.html', requireAuth, reader, pdfGate, asyncHandler(async (req, res) => {
    const out = await loadAvailability(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    await auditExport(req, 'pdf', 'availability', out.range);
    return sendHtml(res, renderReportHtml({
      title: 'BlueEye — Availability / SLA report',
      subtitle: `${out.range.from.toISOString().slice(0, 10)} – ${out.range.to.toISOString().slice(0, 10)}`,
      columns: AVAIL_COLUMNS, rows: out.rows.map(availRow),
    }));
  }));

  // ---- Incidents ----------------------------------------------------------
  // GET /api/reports/incidents?from=&to=&severity=&location_id= — viewer+ (JSON).
  router.get('/incidents', requireAuth, reader, asyncHandler(async (req, res) => {
    const out = await loadIncidents(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    res.json({ from: out.range.from.toISOString(), to: out.range.to.toISOString(), severity: out.sev.value, locationId: out.loc.value, incidents: out.rows });
  }));

  // GET /api/reports/incidents.csv — CSV export (reports_csv).
  router.get('/incidents.csv', requireAuth, reader, csvGate, asyncHandler(async (req, res) => {
    const out = await loadIncidents(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    await auditExport(req, 'csv', 'incidents', out.range);
    return sendCsv(res, 'blueeye-incidents', INCIDENT_COLUMNS, out.rows.map(incidentRow));
  }));

  // GET /api/reports/incidents.html — print-ready report → PDF (reports_pdf).
  router.get('/incidents.html', requireAuth, reader, pdfGate, asyncHandler(async (req, res) => {
    const out = await loadIncidents(req);
    if (out.error) return res.status(out.error.status).json(out.error.body);
    await auditExport(req, 'pdf', 'incidents', out.range);
    return sendHtml(res, renderReportHtml({
      title: 'BlueEye — Incident report',
      subtitle: `${out.range.from.toISOString().slice(0, 10)} – ${out.range.to.toISOString().slice(0, 10)}`,
      columns: INCIDENT_COLUMNS, rows: out.rows.map(incidentRow),
    }));
  }));

  // GET /api/reports/nis2-draft/:incident_id — one incident as an English CFCS
  // notification draft. operator+ (regulator-facing document).
  router.get('/nis2-draft/:incident_id', requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.incident_id);
    if (id === null) return res.status(400).json({ error: 'incident_id must be a positive integer' });
    const incident = await incidentsRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ incidentId: incident.id, incident, draft: nis2Draft(incident) });
  }));

  return router;
}

module.exports = { createReportsRouter };
