'use strict';

const { DEFAULT_CATEGORIES, listCategories } = require('../flows/categories');

// Parses a list of integers, keeping only unique values within [min, max].
// Returns null if the result is empty or the cap is exceeded.
function uniqInts(arr, min, max, cap) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length > cap) return null;
  }
  return out.length ? out : null;
}

// Builds a 400 error carrying a field -> message map; the settings routes turn
// it into a "Validation failed" response. Thrown by the set* methods.
function badRequest(message, details) {
  const err = new Error(message);
  err.statusCode = 400;
  err.details = details;
  return err;
}

// Runtime-editable settings, backed by the app_settings store and overlaid on
// the env defaults. The map tile source and the traffic-type categories are
// editable from the UI; everything else stays env-driven. Validation lives here
// so the route stays thin.
function createSettingsService({ settingsRepo, config, liveAnalysis = null, liveRetention = null }) {
  function mapDefaults() {
    return {
      tileUrl: config.geo.tileUrl,
      attribution: config.geo.tileAttribution,
      maxZoom: config.geo.tileMaxZoom,
      geocodeUrl: config.geo.geocodeUrl,
    };
  }

  // Loads a stored settings override; a read error is treated as "no override".
  async function loadOverride(key) {
    try {
      return await settingsRepo.get(key);
    } catch {
      return null;
    }
  }

  // Effective map config: stored override merged over the env defaults.
  async function getMap() {
    const override = await loadOverride('map');
    const o = override && typeof override === 'object' ? override : {};
    return { ...mapDefaults(), ...o };
  }

  function validateMap(patch) {
    const errors = {};
    const value = {};
    if (patch.tileUrl !== undefined) {
      const u = String(patch.tileUrl).trim();
      if (!/^https?:\/\//i.test(u) || !u.includes('{z}') || !u.includes('{x}') || !u.includes('{y}') || u.length > 500) {
        errors.tileUrl = 'tileUrl must be an http(s) URL containing {z}, {x} and {y}';
      } else {
        value.tileUrl = u;
      }
    }
    if (patch.attribution !== undefined) {
      const a = String(patch.attribution);
      if (a.length > 300) errors.attribution = 'attribution must be at most 300 characters';
      else value.attribution = a;
    }
    if (patch.maxZoom !== undefined) {
      const z = Number(patch.maxZoom);
      if (!Number.isInteger(z) || z < 1 || z > 22) errors.maxZoom = 'maxZoom must be an integer between 1 and 22';
      else value.maxZoom = z;
    }
    if (patch.geocodeUrl !== undefined) {
      const g = String(patch.geocodeUrl).trim();
      if (g !== '' && (!/^https?:\/\//i.test(g) || g.length > 500)) errors.geocodeUrl = 'geocodeUrl must be an http(s) URL';
      else value.geocodeUrl = g;
    }
    return { errors: Object.keys(errors).length ? errors : null, value };
  }

  // Validates + persists a (partial) map config; returns the new effective map.
  async function setMap(patch) {
    const { errors, value } = validateMap(patch || {});
    if (errors) throw badRequest('invalid map settings', errors);
    const current = await getMap();
    const merged = { tileUrl: current.tileUrl, attribution: current.attribution, maxZoom: current.maxZoom, geocodeUrl: current.geocodeUrl, ...value };
    await settingsRepo.set('map', merged);
    return merged;
  }

  // ---- Traffic-type categories (DNS, Facebook, ...) -----------------------
  // Effective list: a stored override replaces the built-in defaults wholesale
  // (so a removed default stays removed). Empty/absent override -> defaults.
  async function getFlowCategories() {
    const override = await loadOverride('flowCategories');
    return Array.isArray(override) && override.length ? override.map((c) => ({ ...c })) : listCategories();
  }

  function validateFlowCategories(list) {
    if (!Array.isArray(list)) return { errors: { _: 'must be an array of categories' } };
    if (list.length > 100) return { errors: { _: 'too many categories (max 100)' } };
    const errors = {};
    const value = [];
    const seen = new Set();
    list.forEach((c, i) => {
      const at = `#${i + 1}`;
      if (!c || typeof c !== 'object') { errors[at] = 'must be an object'; return; }
      const id = String(c.id || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) { errors[at] = 'id must be 1-32 chars of [a-z0-9_-]'; return; }
      if (seen.has(id)) { errors[at] = `duplicate id "${id}"`; return; }
      seen.add(id);
      const label = String(c.label || '').trim();
      if (!label || label.length > 60) { errors[at] = 'label is required (max 60 chars)'; return; }
      const kind = c.kind === 'asn' ? 'asn' : c.kind === 'port' ? 'port' : null;
      if (!kind) { errors[at] = 'kind must be "port" or "asn"'; return; }
      if (kind === 'port') {
        const ports = uniqInts(c.ports, 1, 65535, 200);
        if (!ports) { errors[at] = 'ports must be 1-200 integers in 1..65535'; return; }
        value.push({ id, label, kind, ports });
      } else {
        const asns = uniqInts(c.asns, 1, 4294967295, 500);
        if (!asns) { errors[at] = 'asns must be 1-500 positive integers'; return; }
        value.push({ id, label, kind, asns });
      }
    });
    return Object.keys(errors).length ? { errors } : { value };
  }

  // Validates + persists the full category list; returns the stored list.
  async function setFlowCategories(list) {
    const { errors, value } = validateFlowCategories(list);
    if (errors) throw badRequest('invalid flow categories', errors);
    await settingsRepo.set('flowCategories', value);
    return value;
  }

  // Clears the override so the built-in defaults apply again.
  async function resetFlowCategories() {
    await settingsRepo.set('flowCategories', null);
    return listCategories(DEFAULT_CATEGORIES);
  }

  // ---- Maintenance windows / alert silencing ------------------------------
  // Stored as { windows: [{ id, name, scope, targetId?, from, to }] }. During an
  // active window the dispatcher suppresses notifications (findings still record).
  const SCOPES = ['global', 'agent', 'location'];

  async function getMaintenance() {
    let override = null;
    try { override = await settingsRepo.get('maintenance'); } catch { override = null; }
    const windows = override && Array.isArray(override.windows) ? override.windows : [];
    return { windows };
  }

  function validateMaintenance(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const list = Array.isArray(p.windows) ? p.windows : null;
    if (!list) return { errors: { windows: 'windows must be an array' } };
    if (list.length > 50) return { errors: { windows: 'too many windows (max 50)' } };
    const errors = {};
    const value = [];
    const seen = new Set();
    list.forEach((w, i) => {
      const at = `#${i + 1}`;
      if (!w || typeof w !== 'object') { errors[at] = 'must be an object'; return; }
      let id = String(w.id || '').trim();
      if (id && !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(id)) { errors[at] = 'id must be 1-40 chars of [a-z0-9-]'; return; }
      if (!id) id = `mw-${Date.now().toString(36)}-${i}`;
      if (seen.has(id)) { errors[at] = `duplicate id "${id}"`; return; }
      seen.add(id);
      const name = String(w.name || '').trim();
      if (!name || name.length > 100) { errors[at] = 'name is required (max 100 chars)'; return; }
      const scope = SCOPES.includes(w.scope) ? w.scope : null;
      if (!scope) { errors[at] = `scope must be one of ${SCOPES.join(', ')}`; return; }
      const out = { id, name, scope };
      if (scope !== 'global') {
        const tid = Number(w.targetId);
        if (!Number.isInteger(tid) || tid <= 0) { errors[at] = 'targetId (positive integer) is required for agent/location scope'; return; }
        out.targetId = tid;
      }
      const from = new Date(w.from);
      const to = new Date(w.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) { errors[at] = 'from/to must be valid dates'; return; }
      if (from.getTime() >= to.getTime()) { errors[at] = 'from must be before to'; return; }
      out.from = from.toISOString();
      out.to = to.toISOString();
      value.push(out);
    });
    return Object.keys(errors).length ? { errors } : { value };
  }

  async function setMaintenance(patch) {
    const { errors, value } = validateMaintenance(patch || {});
    if (errors) { const err = new Error('invalid maintenance windows'); err.statusCode = 400; err.details = errors; throw err; }
    await settingsRepo.set('maintenance', { windows: value });
    return { windows: value };
  }

  // ---- Analysis thresholds (Settings → Analysis) ----------------------
  // Editable subset of the analysis config; the AI assistant + secrets stay
  // env-only. Defaults mirror src/analysis/config.js.
  const ANALYSIS_DEFAULTS = { analysisEnabled: true, assistantEnabled: false, critSigma: 4.0, warnSigma: 3.0, baselineDays: 7, minSamples: 200 };

  function num(patch, key, min, max, isInt, errors, value) {
    if (patch[key] === undefined) return;
    const n = Number(patch[key]);
    const ok = (isInt ? Number.isInteger(n) : Number.isFinite(n)) && n >= min && n <= max;
    if (!ok) errors[key] = `${key} must be ${isInt ? 'an integer' : 'a number'} between ${min} and ${max}`;
    else value[key] = n;
  }
  function bool(patch, key, value) {
    if (patch[key] === undefined) return;
    value[key] = patch[key] === true || patch[key] === 'true';
  }

  function validateAnalysis(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const errors = {};
    const value = {};
    bool(p, 'analysisEnabled', value);
    num(p, 'critSigma', 0.5, 20, false, errors, value);
    num(p, 'warnSigma', 0.5, 20, false, errors, value);
    num(p, 'baselineDays', 1, 90, true, errors, value);
    num(p, 'minSamples', 10, 100000, true, errors, value);
    return { errors: Object.keys(errors).length ? errors : null, value };
  }

  async function getAnalysis() {
    const override = await loadOverride('analysis');
    const o = override && typeof override === 'object' ? override : {};
    const base = { ...ANALYSIS_DEFAULTS, ...(liveAnalysis || {}), ...o };
    return {
      analysisEnabled: !!base.analysisEnabled, assistantEnabled: !!base.assistantEnabled,
      critSigma: base.critSigma, warnSigma: base.warnSigma, baselineDays: base.baselineDays, minSamples: base.minSamples,
    };
  }

  async function setAnalysis(patch) {
    const { errors, value } = validateAnalysis(patch || {});
    if (errors) throw badRequest('invalid analysis settings', errors);
    const current = await getAnalysis();
    const merged = { ...current, ...value };
    await settingsRepo.set('analysis', { analysisEnabled: merged.analysisEnabled, critSigma: merged.critSigma, warnSigma: merged.warnSigma, baselineDays: merged.baselineDays, minSamples: merged.minSamples });
    if (liveAnalysis) Object.assign(liveAnalysis, value); // live-apply (consumers read lazily)
    return merged;
  }

  // ---- Retention windows (Settings → Retention) ----------------------
  const RETENTION_DEFAULTS = { enabled: true, rawRetentionDays: 7, rollupRetentionDays: 90, findingRetentionDays: 365, rollupIntervalMinutes: 60 };

  function validateRetention(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const errors = {};
    const value = {};
    bool(p, 'enabled', value);
    num(p, 'rawRetentionDays', 1, 3650, true, errors, value);
    num(p, 'rollupRetentionDays', 1, 3650, true, errors, value);
    num(p, 'findingRetentionDays', 1, 3650, true, errors, value);
    return { errors: Object.keys(errors).length ? errors : null, value };
  }

  async function getRetention() {
    const override = await loadOverride('retention');
    const o = override && typeof override === 'object' ? override : {};
    const base = { ...RETENTION_DEFAULTS, ...(liveRetention || {}), ...o };
    return {
      enabled: !!base.enabled, rawRetentionDays: base.rawRetentionDays, rollupRetentionDays: base.rollupRetentionDays,
      findingRetentionDays: base.findingRetentionDays, rollupIntervalMinutes: base.rollupIntervalMinutes,
    };
  }

  async function setRetention(patch) {
    const { errors, value } = validateRetention(patch || {});
    if (errors) throw badRequest('invalid retention settings', errors);
    const current = await getRetention();
    const merged = { ...current, ...value };
    await settingsRepo.set('retention', { enabled: merged.enabled, rawRetentionDays: merged.rawRetentionDays, rollupRetentionDays: merged.rollupRetentionDays, findingRetentionDays: merged.findingRetentionDays });
    if (liveRetention) Object.assign(liveRetention, value);
    return merged;
  }

  // ---- Throughput health thresholds (Settings → Analysis) -----------------
  // Flags an agent on the Overview when its latest speed test falls below these
  // Mbps floors. Disabled by default — "too slow" depends on the link, so
  // nothing is flagged until an admin sets a floor.
  const THROUGHPUT_DEFAULTS = { enabled: false, downWarnMbps: 0, downBadMbps: 0, upWarnMbps: 0, upBadMbps: 0 };

  function validateThroughput(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const errors = {};
    const value = {};
    bool(p, 'enabled', value);
    num(p, 'downWarnMbps', 0, 1000000, false, errors, value);
    num(p, 'downBadMbps', 0, 1000000, false, errors, value);
    num(p, 'upWarnMbps', 0, 1000000, false, errors, value);
    num(p, 'upBadMbps', 0, 1000000, false, errors, value);
    return { errors: Object.keys(errors).length ? errors : null, value };
  }

  async function getThroughput() {
    const override = await loadOverride('throughput');
    const o = override && typeof override === 'object' ? override : {};
    const base = { ...THROUGHPUT_DEFAULTS, ...o };
    return {
      enabled: !!base.enabled,
      downWarnMbps: base.downWarnMbps, downBadMbps: base.downBadMbps,
      upWarnMbps: base.upWarnMbps, upBadMbps: base.upBadMbps,
    };
  }

  async function setThroughput(patch) {
    const { errors, value } = validateThroughput(patch || {});
    if (errors) throw badRequest('invalid throughput settings', errors);
    const current = await getThroughput();
    const merged = { ...current, ...value };
    await settingsRepo.set('throughput', merged);
    return merged;
  }

  // ---- AI assistant (Settings → AI assistant) -----------------------------
  // The opt-in LLM assistant's enable flag, API key and model — editable at
  // runtime (admin) instead of env-only. Defaults come from the env-loaded
  // analysis config (liveAnalysis), so existing .env deployments keep working.
  // The API key is a secret: stored in app_settings but NEVER returned by the
  // API — reads expose only whether a key is set, plus a short masked hint.
  function assistantDefaults() {
    const a = liveAnalysis || {};
    return { enabled: !!a.assistantEnabled, apiKey: a.assistantApiKey || '', model: a.assistantModel || 'mistral-small-latest' };
  }

  // Effective assistant config INCLUDING the raw key — server-internal only
  // (used to live-apply onto the running assistant; never sent to a client).
  async function getAssistant() {
    const override = await loadOverride('assistant');
    const o = override && typeof override === 'object' ? override : {};
    const base = { ...assistantDefaults(), ...o };
    return { enabled: !!base.enabled, apiKey: base.apiKey || '', model: base.model || 'mistral-small-latest' };
  }

  // The client-safe view: only whether a key is set + a masked hint, never the key.
  function redactAssistant(a) {
    const key = a.apiKey || '';
    return { enabled: !!a.enabled, model: a.model || 'mistral-small-latest', apiKeySet: key !== '', apiKeyHint: key ? `••••${key.slice(-4)}` : '' };
  }
  async function getAssistantSafe() {
    return redactAssistant(await getAssistant());
  }

  function validateAssistant(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const errors = {};
    const value = {};
    bool(p, 'enabled', value);
    if (p.model !== undefined) {
      const m = String(p.model).trim();
      if (m === '' || m.length > 100 || !/^[\w.:-]+$/.test(m)) errors.model = 'model must be 1-100 chars of letters, digits and . _ - :';
      else value.model = m;
    }
    // apiKey is write-only. clearApiKey removes it; an empty apiKey is ignored,
    // so saving the form without retyping the key never wipes it by accident.
    if (p.clearApiKey === true || p.clearApiKey === 'true') {
      value.apiKey = '';
    } else if (p.apiKey !== undefined) {
      const k = String(p.apiKey).trim();
      if (k === '') { /* leave the stored key unchanged */ }
      else if (k.length > 300) errors.apiKey = 'apiKey must be at most 300 characters';
      else value.apiKey = k;
    }
    return { errors: Object.keys(errors).length ? errors : null, value };
  }

  // Validates + persists the assistant config and live-applies it onto the
  // running analysis config so the assistant picks it up without a restart.
  // Returns the redacted (key-free) view.
  async function setAssistant(patch) {
    const { errors, value } = validateAssistant(patch || {});
    if (errors) throw badRequest('invalid assistant settings', errors);
    const current = await getAssistant();
    const merged = { ...current, ...value };
    await settingsRepo.set('assistant', { enabled: merged.enabled, apiKey: merged.apiKey, model: merged.model });
    if (liveAnalysis) {
      liveAnalysis.assistantEnabled = merged.enabled;
      liveAnalysis.assistantApiKey = merged.apiKey;
      liveAnalysis.assistantModel = merged.model;
    }
    return redactAssistant(merged);
  }

  // Re-applies persisted analysis/retention/assistant overrides onto the live
  // config objects at boot, so admin edits survive a restart. Best-effort.
  async function applyStoredOverrides() {
    try {
      const a = await settingsRepo.get('analysis');
      if (a && liveAnalysis) Object.assign(liveAnalysis, validateAnalysis(a).value);
    } catch { /* ignore */ }
    try {
      const r = await settingsRepo.get('retention');
      if (r && liveRetention) Object.assign(liveRetention, validateRetention(r).value);
    } catch { /* ignore */ }
    try {
      const a = await settingsRepo.get('assistant');
      if (a && liveAnalysis) {
        if (a.enabled !== undefined) liveAnalysis.assistantEnabled = !!a.enabled;
        if (a.apiKey !== undefined) liveAnalysis.assistantApiKey = a.apiKey || '';
        if (a.model) liveAnalysis.assistantModel = a.model;
      }
    } catch { /* ignore */ }
  }

  return {
    getMap, setMap, validateMap,
    getMaintenance, setMaintenance, validateMaintenance,
    getFlowCategories, setFlowCategories, resetFlowCategories, validateFlowCategories,
    getAnalysis, setAnalysis, validateAnalysis,
    getRetention, setRetention, validateRetention,
    getThroughput, setThroughput, validateThroughput,
    getAssistant, getAssistantSafe, setAssistant, validateAssistant,
    applyStoredOverrides,
  };
}

module.exports = { createSettingsService };
