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

// Runtime-editable settings, backed by the app_settings store and overlaid on
// the env defaults. The map tile source and the traffic-type categories are
// editable from the UI; everything else stays env-driven. Validation lives here
// so the route stays thin.
function createSettingsService({ settingsRepo, config }) {
  function mapDefaults() {
    return {
      tileUrl: config.geo.tileUrl,
      attribution: config.geo.tileAttribution,
      maxZoom: config.geo.tileMaxZoom,
      geocodeUrl: config.geo.geocodeUrl,
    };
  }

  // Effective map config: stored override merged over the env defaults.
  async function getMap() {
    let override = null;
    try { override = await settingsRepo.get('map'); } catch { override = null; }
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
    if (errors) {
      const err = new Error('invalid map settings');
      err.statusCode = 400;
      err.details = errors;
      throw err;
    }
    const current = await getMap();
    const merged = { tileUrl: current.tileUrl, attribution: current.attribution, maxZoom: current.maxZoom, geocodeUrl: current.geocodeUrl, ...value };
    await settingsRepo.set('map', merged);
    return merged;
  }

  // ---- Traffic-type categories (DNS, Facebook, ...) -----------------------
  // Effective list: a stored override replaces the built-in defaults wholesale
  // (so a removed default stays removed). Empty/absent override -> defaults.
  async function getFlowCategories() {
    let override = null;
    try { override = await settingsRepo.get('flowCategories'); } catch { override = null; }
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
    if (errors) {
      const err = new Error('invalid flow categories');
      err.statusCode = 400;
      err.details = errors;
      throw err;
    }
    await settingsRepo.set('flowCategories', value);
    return value;
  }

  // Clears the override so the built-in defaults apply again.
  async function resetFlowCategories() {
    await settingsRepo.set('flowCategories', null);
    return listCategories(DEFAULT_CATEGORIES);
  }

  return { getMap, setMap, validateMap, getFlowCategories, setFlowCategories, resetFlowCategories, validateFlowCategories };
}

module.exports = { createSettingsService };
