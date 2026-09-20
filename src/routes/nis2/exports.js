'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { toCsv } = require('../../lib/csv');
const { computeDashboard, actionText } = require('../../nis2/dashboard');
const { buildExecutiveReport, renderExecutiveHtml, renderRegisterHtml } = require('../../nis2/report');
const { createT } = require('../../nis2/i18n');

// The compliance pack's artefacts: CSV for the three registers, and print-ready
// HTML for the executive summary, the readiness view and each register. All
// licence-gated (reports_compliance) and all read-only.
function createExportsRouter(ctx) {
  const router = express.Router();
  const {
    reader, compliancePack, localeOf, orgOf, loadAll,
    nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo, nis2ReportsRepo,
  } = ctx;

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

module.exports = { createExportsRouter };
