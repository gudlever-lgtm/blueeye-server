'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { canonicalize } = require('../../lib/canonicalize');
const { validateReportRequest } = require('../../validation/nis2Validation');
const { computeDashboard } = require('../../nis2/dashboard');
const { buildSnapshot, managementConclusion } = require('../../nis2/report');
const { createT } = require('../../nis2/i18n');

// Management reports: generate a point-in-time snapshot, approve it, and export
// a signed + timestamped evidence manifest an auditor can verify offline.
function createReportsRouter(ctx) {
  const router = express.Router();
  const {
    reader, writer, approver, compliancePack, audit, fail, qstr,
    localeOf, loadAll, nis2ReportsRepo, releaseKeyService,
  } = ctx;

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

  return router;
}

module.exports = { createReportsRouter };
