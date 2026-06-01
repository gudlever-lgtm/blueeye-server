'use strict';

// Runtime-editable settings, backed by the app_settings store and overlaid on
// the env defaults. Currently only the map tile source is editable from the UI;
// everything else stays env-driven. Validation lives here so the route stays thin.
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

  return { getMap, setMap, validateMap };
}

module.exports = { createSettingsService };
