'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Settings overview API (admin). Aggregates the effective configuration for the
// dashboard's Indstillinger page. Most of it is read-only (env-driven); only the
// map tile source is editable at runtime. Secrets (API keys, passwords, webhook
// secrets) are never included.
function createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig }) {
  const router = express.Router();
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];

  router.get('/', ...admin, asyncHandler(async (req, res) => {
    const a = analysisConfig || {};
    res.json({
      license: featureGate ? featureGate.summary() : null,
      analysis: settingsService ? await settingsService.getAnalysis() : {
        analysisEnabled: a.analysisEnabled, assistantEnabled: a.assistantEnabled,
        critSigma: a.critSigma, warnSigma: a.warnSigma, baselineDays: a.baselineDays, minSamples: a.minSamples,
      },
      alerting: dispatcher ? dispatcher.describe() : null,
      retention: settingsService ? await settingsService.getRetention() : (retentionConfig || null),
      map: settingsService ? await settingsService.getMap() : null,
      flowCategories: settingsService ? await settingsService.getFlowCategories() : null,
    });
  }));

  // PUT /api/settings/analysis — anomaly-detection thresholds (admin).
  router.put('/analysis', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json({ analysis: await settingsService.setAnalysis(req.body || {}) });
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      throw err;
    }
  }));

  // PUT /api/settings/retention — data-retention windows (admin).
  router.put('/retention', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json({ retention: await settingsService.setRetention(req.body || {}) });
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      throw err;
    }
  }));

  // PUT /api/settings/flow-categories — replace the traffic-type category list
  // ({ categories: [...] }) or reset to the built-in defaults ({ reset: true }).
  router.put('/flow-categories', ...admin, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.reset === true) {
      return res.json({ flowCategories: await settingsService.resetFlowCategories() });
    }
    try {
      const flowCategories = await settingsService.setFlowCategories(body.categories);
      res.json({ flowCategories });
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      }
      throw err;
    }
  }));

  // PUT /api/settings/map { tileUrl?, attribution?, maxZoom? } — update the map
  // tile source (admin). 400 with field details on invalid input.
  router.put('/map', ...admin, asyncHandler(async (req, res) => {
    try {
      const map = await settingsService.setMap(req.body || {});
      res.json({ map });
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      }
      throw err;
    }
  }));

  return router;
}

module.exports = { createSettingsRouter };
