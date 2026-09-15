'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { toCsv } = require('../lib/csv');
const { canonicalize } = require('../lib/canonicalize');
const {
  validateRiskInput, validateControlInput, validateIncidentInput,
  validateEvidenceInput, validateReportRequest, validateCustomReportSpec,
} = require('../validation/nis2Validation');
const { computeDashboard, actionText } = require('../nis2/dashboard');
const { computeIncidentDeadlines, withDeadlines, deadlineOverview } = require('../nis2/deadlines');
const { buildExecutiveReport, buildSnapshot, managementConclusion, renderExecutiveHtml, renderRegisterHtml } = require('../nis2/report');
const { CATEGORIES } = require('../nis2/constants');
const { SOURCE_KEYS, sourcesFor, buildCustomReport, customReportToCsv } = require('../nis2/reportBuilder');
const { createT, resolveLocale } = require('../nis2/i18n');

// NIS2 Reporting Center API. Mounted at /api/nis2. Reads are viewer+, mutations
// to the register/controls/incidents/evidence are operator+, report approval and
// the audit trail are admin-only. Every create/update/delete is recorded in the
// generic audit log (best-effort — an audit failure never fails the request).
function createNis2Router({
  nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo,
  nis2ReportsRepo, nis2EvidenceRepo, nis2AuditRepo,
  featureGate = null, planService = null,
  // The server's Ed25519 signer (shared with agent-release signing). Used to
  // produce tamper-evident, signed + timestamped evidence manifests for reports.
  releaseKeyService = null,
}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);
  const approver = requireRole(ROLES.ADMIN); // admin/compliance approves reports
  // The generated/exportable "Compliance report pack" is licence-gated
  // (reports_compliance, Professional+). The risk/control/incident registers and
  // the readiness dashboard stay open as part of the NIS2 module; producing the
  // report artifacts (generate / approve / CSV / print-ready HTML) requires it.
  const compliancePack = requirePlanFeature({ featureGate, planService }, 'reports_compliance');

  // Best-effort audit write. Never throws into the request path.
  async function audit(req, action, entityType, entityId, oldValue, newValue) {
    if (!nis2AuditRepo) return;
    try {
      await nis2AuditRepo.record({
        userId: req.user && req.user.id, userEmail: req.user && req.user.email,
        action, entityType, entityId, oldValue, newValue,
      });
    } catch { /* audit is non-fatal */ }
  }

  // The language a report document is rendered in. `?locale=` wins (the
  // dashboard passes the user's chosen language); otherwise Accept-Language, so
  // a scripted export — the compliance pack is fetched by more than the UI —
  // gets a sensible document without having to know about the parameter.
  // Anything unrecognised resolves to English rather than failing the export.
  const localeOf = (req) => resolveLocale(
    (typeof req.query.locale === 'string' && req.query.locale) || req.get('accept-language') || ''
  );
  const orgOf = (req) => (typeof req.query.org === 'string' && req.query.org.trim()
    ? req.query.org.trim().slice(0, 120)
    : createT(localeOf(req))('doc.org'));
  // Query filters must be plain strings before they reach a `col = ?` binding:
  // Express parses ?x=a&x=b into an array (and ?x[y]=1 into an object), which
  // mysql2 expands into invalid/shifted SQL. Anything non-string → no filter.
  const qstr = (v) => (typeof v === 'string' && v ? v : null);
  const fail = (res, errors) => res.status(400).json({ error: 'Validation failed', details: errors });

  // Loads the three core record sets in parallel — the dashboard + reports basis.
  async function loadAll() {
    const [risks, controls, incidents] = await Promise.all([
      nis2RisksRepo.findAll(), nis2ControlsRepo.findAll(), nis2IncidentsRepo.findAll(),
    ]);
    return { risks, controls, incidents };
  }

  // ---- Meta -----------------------------------------------------------------

  // The category vocabulary — lets the dashboard build its forms without
  // hard-coding the enum twice.
  router.get('/meta', requireAuth, reader, (req, res) => {
    res.json({ categories: CATEGORIES });
  });

  // ---- Dashboard ------------------------------------------------------------

  router.get('/dashboard', requireAuth, reader, asyncHandler(async (req, res) => {
    const data = await loadAll();
    res.json(computeDashboard(data));
  }));

  // ---- Risk register --------------------------------------------------------

  router.get('/risks', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json(await nis2RisksRepo.findAll({
      status: qstr(req.query.status),
      category: qstr(req.query.category),
    }));
  }));

  router.get('/risks/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const risk = await nis2RisksRepo.findById(id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    res.json(risk);
  }));

  router.post('/risks', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateRiskInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2RisksRepo.create(value);
    await audit(req, 'create', 'risk', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/risks/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2RisksRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Risk not found' });
    const { value, errors } = validateRiskInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2RisksRepo.update(id, value);
    await audit(req, 'update', 'risk', id, before, updated);
    res.json(updated);
  }));

  router.delete('/risks/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2RisksRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Risk not found' });
    await nis2RisksRepo.remove(id);
    await audit(req, 'delete', 'risk', id, before, null);
    res.status(204).end();
  }));

  // ---- Controls -------------------------------------------------------------

  router.get('/controls', requireAuth, reader, asyncHandler(async (req, res) => {
    if (req.query.withoutEvidence === 'true') {
      return res.json(await nis2ControlsRepo.findWithoutEvidence());
    }
    res.json(await nis2ControlsRepo.findAll({
      status: qstr(req.query.status),
      area: qstr(req.query.area),
    }));
  }));

  router.get('/controls/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const control = await nis2ControlsRepo.findById(id);
    if (!control) return res.status(404).json({ error: 'Control not found' });
    res.json(control);
  }));

  router.post('/controls', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateControlInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2ControlsRepo.create(value);
    await audit(req, 'create', 'control', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/controls/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ControlsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Control not found' });
    const { value, errors } = validateControlInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2ControlsRepo.update(id, value);
    await audit(req, 'update', 'control', id, before, updated);
    res.json(updated);
  }));

  router.delete('/controls/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ControlsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Control not found' });
    await nis2ControlsRepo.remove(id);
    await audit(req, 'delete', 'control', id, before, null);
    res.status(204).end();
  }));

  // ---- Incidents ------------------------------------------------------------

  router.get('/incidents', requireAuth, reader, asyncHandler(async (req, res) => {
    let nis2Relevant = null;
    if (req.query.nis2Relevant === 'true') nis2Relevant = true;
    else if (req.query.nis2Relevant === 'false') nis2Relevant = false;
    const incidents = await nis2IncidentsRepo.findAll({
      status: qstr(req.query.status),
      severity: qstr(req.query.severity),
      nis2Relevant,
    });
    // Attach the computed NIS2 Art.23 reporting deadlines (additive field).
    res.json(withDeadlines(incidents));
  }));

  // NIS2 Art.23 reporting-deadline overview — incidents that carry a reporting
  // duty, most-urgent first (overdue → due-soon → upcoming) + counts. Drives a
  // compliance "deadlines" panel so 24h/72h/1-month duties are tracked, not just
  // described. viewer+.
  router.get('/deadlines', requireAuth, reader, asyncHandler(async (req, res) => {
    const incidents = await nis2IncidentsRepo.findAll({ nis2Relevant: null });
    res.json(deadlineOverview(incidents));
  }));

  router.get('/incidents/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const incident = await nis2IncidentsRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ ...incident, deadlines: computeIncidentDeadlines(incident) });
  }));

  router.post('/incidents', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateIncidentInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2IncidentsRepo.create(value);
    await audit(req, 'create', 'incident', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/incidents/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2IncidentsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Incident not found' });
    const { value, errors } = validateIncidentInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2IncidentsRepo.update(id, value);
    await audit(req, 'update', 'incident', id, before, updated);
    res.json(updated);
  }));

  router.delete('/incidents/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2IncidentsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Incident not found' });
    await nis2IncidentsRepo.remove(id);
    await audit(req, 'delete', 'incident', id, before, null);
    res.status(204).end();
  }));

  // ---- Evidence -------------------------------------------------------------

  router.get('/evidence', requireAuth, reader, asyncHandler(async (req, res) => {
    // A present-but-invalid entityId must be a 400, not a silently widened
    // "no filter" result set (the convention every :id route here follows).
    let entityId = null;
    if (req.query.entityId !== undefined) {
      entityId = parseId(req.query.entityId);
      if (entityId === null) return res.status(400).json({ error: 'Invalid entityId' });
    }
    res.json(await nis2EvidenceRepo.findAll({
      entityType: qstr(req.query.entityType),
      entityId,
    }));
  }));

  router.post('/evidence', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateEvidenceInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2EvidenceRepo.create({
      ...value, uploadedBy: req.user && req.user.id, uploadedByEmail: req.user && req.user.email,
    });
    await audit(req, 'create', 'evidence', created.id, null, created);
    res.status(201).json(created);
  }));

  router.delete('/evidence/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2EvidenceRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Evidence not found' });
    await nis2EvidenceRepo.remove(id);
    await audit(req, 'delete', 'evidence', id, before, null);
    res.status(204).end();
  }));

  // ---- Reports --------------------------------------------------------------

  router.get('/reports', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json(await nis2ReportsRepo.findAll({ type: qstr(req.query.type) }));
  }));

  router.get('/reports/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const report = await nis2ReportsRepo.findById(id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  }));

  // Generates + persists a report (snapshot frozen for trend comparison). The
  // body chooses the type; the title/period are optional. operator+.
  router.post('/reports', requireAuth, writer, compliancePack, asyncHandler(async (req, res) => {
    const { value, errors } = validateReportRequest(req.body);
    if (errors) return fail(res, errors);
    const data = await loadAll();
    const dashboard = computeDashboard(data);
    const snapshot = buildSnapshot(dashboard);
    // A stored report is frozen text, so it is written once in the language the
    // creator was working in — the live /export documents re-render in whatever
    // the reader asks for.
    const t = createT(localeOf(req));
    const defaultTitles = {
      readiness: t('title.readiness'), executive: t('title.executive'),
      risk: t('title.risk'), control: t('title.control'),
      incident: t('title.incident'),
    };
    const summary = managementConclusion(dashboard, t.locale);
    const created = await nis2ReportsRepo.create({
      reportType: value.reportType,
      title: value.title || defaultTitles[value.reportType],
      periodStart: value.periodStart, periodEnd: value.periodEnd,
      status: 'draft', summary, snapshot,
      generatedBy: req.user && req.user.id, generatedByEmail: req.user && req.user.email,
    });
    await audit(req, 'create', 'report', created.id, null, created);
    res.status(201).json(created);
  }));

  // Approve a draft report — admin/compliance only.
  router.post('/reports/:id/approve', requireAuth, approver, compliancePack, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ReportsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Report not found' });
    if (before.status === 'approved') return res.status(409).json({ error: 'Report is already approved' });
    const updated = await nis2ReportsRepo.approve(id, {
      approvedBy: req.user && req.user.id, approvedByEmail: req.user && req.user.email,
    });
    if (!updated) return res.status(409).json({ error: 'Report could not be approved' });
    await audit(req, 'approve', 'report', id, before, updated);
    res.json(updated);
  }));

  // GET /reports/:id/evidence — a SIGNED, TIMESTAMPED evidence manifest for a
  // report. Binds the report's content (sha256 over its canonical bytes) plus a
  // server-issued timestamp, signed with the server's Ed25519 key, so an auditor
  // can verify OFFLINE that an exported NIS2 report is authentic and unaltered.
  // This is the cryptographic complement to the draft→approved (organisational)
  // sign-off. reader+, compliance-pack gated; 503 when no signing key exists.
  //
  // Verify: recompute sha256 over canonicalize(report), check it equals
  // manifest.sha256, then Ed25519-verify `signature` over canonicalize(manifest)
  // with `publicKey` (the same key agents use for signed releases). An optional
  // RFC3161/TSA trusted timestamp can be layered on top later.
  router.get('/reports/:id/evidence', requireAuth, reader, compliancePack, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    if (!releaseKeyService || typeof releaseKeyService.sign !== 'function' || !releaseKeyService.canSign()) {
      return res.status(503).json({ error: 'No server signing key configured — generate one under Settings → Updates to sign evidence', code: 'NO_SIGNING_KEY' });
    }
    const report = await nis2ReportsRepo.findById(id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const sha256 = crypto.createHash('sha256').update(canonicalize(report), 'utf8').digest('hex');
    const manifest = {
      type: 'nis2-evidence',
      algorithm: 'ed25519',
      contentHashAlg: 'sha256',
      reportId: report.id,
      reportType: report.reportType,
      title: report.title,
      status: report.status,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      approvedByEmail: report.approvedByEmail,
      approvedAt: report.approvedAt,
      sha256,
      signedAt: new Date().toISOString(),
      serverFingerprint: (releaseKeyService.status && releaseKeyService.status().fingerprint) || null,
    };
    const signature = releaseKeyService.sign(manifest);
    await audit(req, 'export', 'report', id, null, { evidence: true, sha256, signedAt: manifest.signedAt });
    res.json({ manifest, signature, publicKey: releaseKeyService.getPublicKey() });
  }));

  router.delete('/reports/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ReportsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Report not found' });
    await nis2ReportsRepo.remove(id);
    await audit(req, 'delete', 'report', id, before, null);
    res.status(204).end();
  }));

  // ---- Audit trail (admin) --------------------------------------------------

  router.get('/audit', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    res.json(await nis2AuditRepo.findAll({
      entityType: qstr(req.query.entityType),
      limit: Number.isFinite(limit) ? limit : 100,
    }));
  }));

  // ---- Get-started seed -----------------------------------------------------

  // Seeds a baseline control per NIS2 category (status Missing) so a fresh
  // install has something to evidence against. No-op (409) if controls already
  // exist, so it can't duplicate. operator+.
  router.post('/seed', requireAuth, writer, asyncHandler(async (req, res) => {
    const existing = await nis2ControlsRepo.findAll();
    if (existing.length > 0) return res.status(409).json({ error: 'Controls already exist — seed skipped', count: existing.length });
    const created = [];
    for (const area of CATEGORIES) {
      const control = await nis2ControlsRepo.create({
        controlName: `${area} baseline control`, nis2Area: area,
        description: `Starter control for ${area}. Replace with your real assurance activity.`,
        frequency: 'quarterly', status: 'Missing',
      });
      created.push(control);
      await audit(req, 'create', 'control', control.id, null, control);
    }
    res.status(201).json({ created: created.length, controls: created });
  }));

  // ---- Report Generator (custom, selector-driven) ---------------------------

  const isAdmin = (req) => req.user && req.user.role === 'admin';
  const wantsAudit = (spec) => (spec.sections || []).some((s) => s.source === 'audit');

  // The source catalogue the UI builds its selectors from (admin-only sources
  // hidden from non-admins).
  router.get('/custom-reports/sources', requireAuth, reader, (req, res) => {
    res.json({ sources: sourcesFor(isAdmin(req), localeOf(req)) });
  });

  // Loads exactly the data the requested sections need, then builds the report.
  // Audit data is only loaded for admins. Returns the built report + isAdmin.
  async function assembleCustomReport(spec, req) {
    const sources = new Set((spec.sections || []).map((s) => s.source));
    const needRisks = sources.has('risks');
    const needControls = sources.has('controls') || sources.has('summary') || sources.has('categories');
    const needIncidents = sources.has('incidents') || sources.has('summary');
    const needDashboard = sources.has('summary') || sources.has('categories');
    const [risks, controls, incidents] = await Promise.all([
      needRisks || needDashboard ? nis2RisksRepo.findAll() : Promise.resolve([]),
      needControls || needDashboard ? nis2ControlsRepo.findAll() : Promise.resolve([]),
      needIncidents || needDashboard ? nis2IncidentsRepo.findAll() : Promise.resolve([]),
    ]);
    const dashboard = needDashboard ? computeDashboard({ risks, controls, incidents }) : null;
    const admin = isAdmin(req);
    const audit = admin && sources.has('audit') ? await nis2AuditRepo.findAll({ limit: 500 }) : [];
    return buildCustomReport(spec, { risks, controls, incidents, dashboard, audit }, { isAdmin: admin, locale: localeOf(req) });
  }

  // On-screen preview (JSON). Rows are capped per section so a huge register
  // can't bloat the response; `truncated` tells the UI to note the cap.
  router.post('/custom-reports/preview', requireAuth, reader, asyncHandler(async (req, res) => {
    const { value, errors } = validateCustomReportSpec(req.body, { sourceKeys: SOURCE_KEYS });
    if (errors) return fail(res, errors);
    if (wantsAudit(value) && !isAdmin(req)) return res.status(403).json({ error: 'The audit source requires the admin role' });
    const report = await assembleCustomReport(value, req);
    const CAP = 100;
    report.sections = report.sections.map((s) => ({
      ...s, rows: s.rows.slice(0, CAP), truncated: s.rowCount > CAP,
    }));
    res.json(report);
  }));

  // Export the custom report as PDF-ready HTML, CSV, or JSON (format in body).
  router.post('/custom-reports/export', requireAuth, reader, compliancePack, asyncHandler(async (req, res) => {
    const { value, errors } = validateCustomReportSpec(req.body, { sourceKeys: SOURCE_KEYS });
    if (errors) return fail(res, errors);
    if (wantsAudit(value) && !isAdmin(req)) return res.status(403).json({ error: 'The audit source requires the admin role' });
    const report = await assembleCustomReport(value, req);
    if (value.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="custom-report.csv"');
      return res.send(customReportToCsv(report));
    }
    if (value.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="custom-report.json"');
      return res.send(JSON.stringify(report, null, 2));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderRegisterHtml(report.title, report.sections, { org: report.org, locale: report.locale }));
  }));

  // ---- CSV / PDF export -----------------------------------------------------
  // All downloadable report artifacts under /export are the licence-gated
  // "Compliance report pack" (reports_compliance). This prefix guard runs
  // auth → role → feature before any specific export route below.
  router.use('/export', requireAuth, reader, compliancePack);

  function sendCsv(res, name, columns, rows) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(toCsv(columns, rows));
  }

  router.get('/export/risks.csv', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2RisksRepo.findAll();
    sendCsv(res, 'nis2-risks.csv',
      ['id', 'title', 'category', 'affectedAsset', 'likelihood', 'impact', 'riskScore', 'band', 'owner', 'status', 'mitigationPlan', 'dueDate', 'managementAcceptance', 'evidenceLink', 'createdAt', 'updatedAt'],
      rows);
  }));

  router.get('/export/controls.csv', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2ControlsRepo.findAll();
    sendCsv(res, 'nis2-controls.csv',
      ['id', 'controlName', 'nis2Area', 'description', 'owner', 'frequency', 'lastPerformed', 'nextDue', 'evidenceFile', 'hasEvidence', 'status', 'comment', 'createdAt', 'updatedAt'],
      rows);
  }));

  router.get('/export/incidents.csv', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2IncidentsRepo.findAll();
    sendCsv(res, 'nis2-incidents.csv',
      ['id', 'incidentId', 'title', 'severity', 'detectedAt', 'startedAt', 'resolvedAt', 'affectedSystems', 'businessImpact', 'rootCause', 'actionsTaken', 'nis2Relevant', 'notificationRequired', 'status', 'lessonsLearned', 'createdAt', 'updatedAt'],
      rows);
  }));

  // ---- PDF (print-ready HTML) export ----------------------------------------

  function sendHtml(res, html) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  // Executive report — full, rendered live from current data (the headline PDF).
  router.get('/export/executive.html', requireAuth, reader, asyncHandler(async (req, res) => {
    const data = await loadAll();
    const dashboard = computeDashboard(data);
    const previous = await nis2ReportsRepo.findLatest('executive');
    const report = buildExecutiveReport({ ...data, dashboard, previous, locale: localeOf(req) });
    sendHtml(res, renderExecutiveHtml(report, { org: orgOf(req) }));
  }));

  // Readiness report — the dashboard scorecard as a document.
  router.get('/export/readiness.html', requireAuth, reader, asyncHandler(async (req, res) => {
    const data = await loadAll();
    const d = computeDashboard(data);
    const t = createT(localeOf(req));
    sendHtml(res, renderRegisterHtml(t('title.readiness'), [
      {
        heading: t('readiness.heading', { score: d.readinessScore }),
        intro: t('readiness.intro', {
          criticalRisks: d.openCriticalRisks, findings: d.openHighMediumFindings,
          incidents: d.incidentsLast30Days, noEvidence: d.controlsWithoutEvidence,
        }),
        headers: [t('col.category'), t('col.controls'), t('col.score'), t('col.status')],
        rows: d.categories.map((c) => [t.enum('cat', c.category), c.controlCount, `${c.score}%`, t.enum('catStatus', c.status)]),
      },
      {
        heading: t('readiness.actions'),
        headers: [t('col.priority'), t('col.action')],
        rows: d.topActions.map((a) => [t.enum('priority', a.priority), actionText(a, t)]),
      },
    ], { org: orgOf(req), locale: t.locale }));
  }));

  router.get('/export/risk.html', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2RisksRepo.findAll();
    const t = createT(localeOf(req));
    const dash = t('doc.dash');
    sendHtml(res, renderRegisterHtml(t('title.risk'), [{
      heading: t('risk.heading', { n: rows.length }),
      intro: t('risk.intro'),
      headers: [t('col.id'), t('col.title'), t('col.category'), t('col.asset'), t('col.l'), t('col.i'), t('col.score'), t('col.band'), t('col.owner'), t('col.status'), t('col.due')],
      rows: rows.map((r) => [r.id, r.title, t.enum('cat', r.category), r.affectedAsset || dash, r.likelihood, r.impact, r.riskScore, t.enum('band', r.band), r.owner || dash, t.enum('riskStatus', r.status), r.dueDate || dash]),
    }], { org: orgOf(req), locale: t.locale }));
  }));

  router.get('/export/control.html', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2ControlsRepo.findAll();
    const t = createT(localeOf(req));
    const dash = t('doc.dash');
    sendHtml(res, renderRegisterHtml(t('title.control'), [{
      heading: t('control.heading', { n: rows.length }),
      intro: t('control.intro'),
      headers: [t('col.id'), t('col.control'), t('col.area'), t('col.owner'), t('col.frequency'), t('col.lastPerformed'), t('col.nextDue'), t('col.evidence'), t('col.status')],
      rows: rows.map((c) => [c.id, c.controlName, t.enum('cat', c.nis2Area), c.owner || dash, t.enum('frequency', c.frequency), c.lastPerformed || dash, c.nextDue || dash, t.yesNo(c.hasEvidence), t.enum('controlStatus', c.status)]),
    }], { org: orgOf(req), locale: t.locale }));
  }));

  router.get('/export/incident.html', requireAuth, reader, asyncHandler(async (req, res) => {
    const rows = await nis2IncidentsRepo.findAll();
    const t = createT(localeOf(req));
    const dash = t('doc.dash');
    const when = (v) => (v ? new Date(v).toLocaleString(t.htmlLang) : dash);
    sendHtml(res, renderRegisterHtml(t('title.incident'), [{
      heading: t('incident.heading', { n: rows.length }),
      intro: t('incident.intro'),
      headers: [t('col.ref'), t('col.title'), t('col.severity'), t('col.detected'), t('col.resolved'), t('col.status'), t('col.nis2'), t('col.notify')],
      rows: rows.map((i) => [i.incidentId, i.title, t.enum('severity', i.severity), when(i.detectedAt), when(i.resolvedAt), t.enum('incidentStatus', i.status), t.yesNo(i.nis2Relevant), t.yesNo(i.notificationRequired)]),
    }], { org: orgOf(req), locale: t.locale }));
  }));

  return router;
}

module.exports = { createNis2Router };
