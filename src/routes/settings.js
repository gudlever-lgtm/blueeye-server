'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Settings overview API (admin). Aggregates the effective configuration for the
// dashboard's Settings page. Some of it is read-only (env-driven). Secrets
// (passwords, webhook secrets) are never included; the AI assistant's API key is
// editable here but only ever reported as "set or not" + a masked hint, never
// echoed back in full.
function createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig }) {
  const router = express.Router();
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];
  const reader = [requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];

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
      throughput: settingsService ? await settingsService.getThroughput() : null,
      assistant: settingsService ? await settingsService.getAssistantSafe() : null,
      map: settingsService ? await settingsService.getMap() : null,
      flowCategories: settingsService ? await settingsService.getFlowCategories() : null,
      maintenance: settingsService ? await settingsService.getMaintenance() : null,
    });
  }));

  // GET /api/settings/maintenance — current windows. viewer+ (benign, no secrets)
  // so the dashboard can show a "maintenance active" indicator to everyone.
  router.get('/maintenance', ...reader, asyncHandler(async (req, res) => {
    res.json(settingsService ? await settingsService.getMaintenance() : { windows: [] });
  }));

  // PUT /api/settings/maintenance { windows: [...] } — replace the window list (admin).
  router.put('/maintenance', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json(await settingsService.setMaintenance(req.body || {}));
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      throw err;
    }
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

  // PUT /api/settings/assistant — AI-assistant enable flag, API key + model
  // (admin). The key is write-only: the response only reports apiKeySet + a
  // masked hint, never the key itself.
  router.put('/assistant', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json({ assistant: await settingsService.setAssistant(req.body || {}) });
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

  // PUT /api/settings/throughput — speed-test health thresholds (admin).
  router.put('/throughput', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json({ throughput: await settingsService.setThroughput(req.body || {}) });
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
