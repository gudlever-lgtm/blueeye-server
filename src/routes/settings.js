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
function createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig, releaseKeyService = null, publishRelease = null, geoipUpdater = null }) {
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
      alerting: settingsService ? await settingsService.getAlertingSafe() : (dispatcher ? dispatcher.describe() : null),
      retention: settingsService ? await settingsService.getRetention() : (retentionConfig || null),
      throughput: settingsService ? await settingsService.getThroughput() : null,
      agents: settingsService ? await settingsService.getAgents() : null,
      assistant: settingsService ? await settingsService.getAssistantSafe() : null,
      map: settingsService ? await settingsService.getMap() : null,
      geoip: settingsService ? await settingsService.getGeoip() : null,
      flowCategories: settingsService ? await settingsService.getFlowCategories() : null,
      maintenance: settingsService ? await settingsService.getMaintenance() : null,
      agentReleaseKey: releaseKeyService ? releaseKeyService.status() : { configured: false },
    });
  }));

  // --- Agent signing key (admin) -----------------------------------------------
  // The Ed25519 release-signing key, generated ON the server — the trust anchor for
  // secure agent management: the server signs agent releases with it and agents
  // verify those signatures. WRITE-ONCE and never viewable: the API only reports
  // that it exists (+ a non-secret fingerprint), never any key material.

  // GET status: { configured, source, createdAt, fingerprint, canSign }.
  router.get('/agent-release-key', ...admin, asyncHandler(async (req, res) => {
    res.json(releaseKeyService ? releaseKeyService.status() : { configured: false, source: null });
  }));

  // POST generate — create the key (write-once). 409 if one already exists. Returns
  // status only. Immediately publishes a signed release so upgrades are ready.
  router.post('/agent-release-key', ...admin, asyncHandler(async (req, res) => {
    if (!releaseKeyService) return res.status(503).json({ error: 'Key management is not available on this server' });
    try {
      const userId = (req.user && (req.user.id || req.user.sub)) || null;
      const status = await releaseKeyService.generate({ userId });
      if (publishRelease) { try { await publishRelease(); } catch { /* best-effort: a release can also be published later */ } }
      return res.status(201).json(status);
    } catch (err) {
      if (err.code === 'EXISTS') {
        return res.status(409).json({ error: 'A signing key already exists and cannot be changed. Delete it first if you must rotate it (existing agents would then need re-enrolling).', code: 'EXISTS' });
      }
      throw err;
    }
  }));

  // DELETE — remove the key. After this no new agents can be onboarded and no signed
  // upgrades can be issued until a key is generated again. The "are you sure" confirm
  // lives in the dashboard.
  router.delete('/agent-release-key', ...admin, asyncHandler(async (req, res) => {
    if (!releaseKeyService) return res.status(503).json({ error: 'Key management is not available on this server' });
    const status = await releaseKeyService.remove();
    return res.json(status);
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
  // masked hint, never the key itself. License-gated with the same 'assistant'
  // entitlement as the /api/assistant API, so an admin cannot enable or key a
  // module the server will refuse to run. Same fail-open-when-unwired shape.
  router.put('/assistant', ...admin, asyncHandler(async (req, res) => {
    if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
      return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
    }
    try {
      res.json({ assistant: await settingsService.setAssistant(req.body || {}) });
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      throw err;
    }
  }));

  // PUT /api/settings/alerting — alert channel config (admin). Enable flags,
  // per-channel minimum severity, recipients/URLs/hosts and the two secrets
  // (SMTP password + webhook HMAC). The secrets are write-only: the response only
  // reports *Set + a masked hint, never the value. License-gated with the same
  // 'alerting' entitlement as the dispatcher, so an admin cannot configure a
  // channel the server will refuse to dispatch through. Fail-open when unwired.
  router.put('/alerting', ...admin, asyncHandler(async (req, res) => {
    if (featureGate && !featureGate.isFeatureEnabled('alerting')) {
      return res.status(403).json({ error: 'This feature is not included in your license', feature: 'alerting', reason: 'license' });
    }
    try {
      res.json({ alerting: await settingsService.setAlerting(req.body || {}) });
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

  // PUT /api/settings/agents — agent-management toggles (currently the
  // auto-install-tools opt-in). { autoInstallTools: bool }.
  router.put('/agents', ...admin, asyncHandler(async (req, res) => {
    res.json({ agents: await settingsService.setAgents(req.body || {}) });
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

  // PUT /api/settings/geoip { dbPath?, autoUpdate? } — point the server at an
  // offline GeoIP/ASN range CSV and reload it live, and/or toggle monthly
  // auto-update (admin). Empty dbPath clears the override (falls back to env /
  // disables). The response reports how many ranges loaded, so a wrong/unreadable
  // path surfaces as ranges:0 rather than a silent no-op.
  router.put('/geoip', ...admin, asyncHandler(async (req, res) => {
    try {
      res.json({ geoip: await settingsService.setGeoip(req.body || {}) });
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ error: 'Validation failed', details: err.details || {} });
      }
      throw err;
    }
  }));

  // POST /api/settings/geoip/update — fetch the latest DB-IP Lite release, build
  // the CSV server-side (into the /data volume) and reload the provider (admin).
  // Runs in the background and returns 202 + the job status; poll GET to track it.
  // { countryOnly: true } skips the heavier ASN file.
  router.post('/geoip/update', ...admin, asyncHandler(async (req, res) => {
    if (!geoipUpdater) return res.status(503).json({ error: 'GeoIP auto-update is not available on this server' });
    const includeAsn = (req.body && req.body.countryOnly) ? false : true;
    res.status(202).json({ update: geoipUpdater.trigger({ includeAsn }) });
  }));

  // GET /api/settings/geoip/update — current update-job status (idle/running/ok/
  // error + month/ranges). viewer+ so the Settings page can poll/show progress.
  router.get('/geoip/update', ...reader, asyncHandler(async (req, res) => {
    if (!geoipUpdater) return res.json({ update: { state: 'unavailable' } });
    res.json({ update: geoipUpdater.status() });
  }));

  return router;
}

module.exports = { createSettingsRouter };
