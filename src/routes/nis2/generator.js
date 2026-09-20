'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { validateCustomReportSpec } = require('../../validation/nis2Validation');
const { computeDashboard } = require('../../nis2/dashboard');
const { renderRegisterHtml } = require('../../nis2/report');
const { SOURCE_KEYS, sourcesFor, buildCustomReport, customReportToCsv } = require('../../nis2/reportBuilder');

// The Report Generator: the operator picks sections, BlueEyes assembles them.
// Preview is viewer+ and stores nothing; export is licence-gated like the rest
// of the compliance pack.
function createGeneratorRouter(ctx) {
  const router = express.Router();
  const {
    reader, compliancePack, audit, fail, localeOf,
    nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo, nis2AuditRepo,
  } = ctx;

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

  return router;
}

module.exports = { createGeneratorRouter };
