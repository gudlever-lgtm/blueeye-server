'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

const TIMEOUT_MS = 8000;

// Server-side geocoding proxy. The geocodeUrl is admin-configured (Settings →
// Map); proxying here means the URL stays server-side, private-network geocoders
// (self-hosted/EU) work without browser network access, and CORS is a non-issue.
// fetch is injected so tests run offline.
function createGeocodeRouter({
  getGeocodeUrl,
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
} = {}) {
  const router = express.Router();

  async function proxy(url, res) {
    if (!fetchImpl) return res.status(503).json({ error: 'Geocoder not available' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      const body = r.ok ? await r.json() : [];
      res.json(body);
    } catch (err) {
      if (err.name === 'AbortError') return res.status(504).json({ error: 'Geocoder timed out' });
      res.status(502).json({ error: 'Geocoder unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }

  // GET /api/geocode/search?q=... — forward geocoding (address → coordinates list).
  router.get(
    '/search',
    requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q || q.length > 200) {
        return res.status(400).json({ error: 'Validation failed', details: { q: 'q is required (max 200 chars)' } });
      }
      const base = typeof getGeocodeUrl === 'function' ? await getGeocodeUrl() : null;
      if (!base) return res.status(503).json({ error: 'No geocoder configured — set a geocoder URL in Settings → Map' });
      return proxy(`${base}/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, res);
    })
  );

  // GET /api/geocode/reverse?lat=&lon=... — reverse geocoding (coordinates → address).
  router.get(
    '/reverse',
    requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const lat = parseFloat(req.query.lat);
      const lon = parseFloat(req.query.lon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Validation failed', details: { lat: 'lat must be between -90 and 90' } });
      }
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        return res.status(400).json({ error: 'Validation failed', details: { lon: 'lon must be between -180 and 180' } });
      }
      const base = typeof getGeocodeUrl === 'function' ? await getGeocodeUrl() : null;
      if (!base) return res.status(503).json({ error: 'No geocoder configured — set a geocoder URL in Settings → Map' });
      return proxy(`${base}/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, res);
    })
  );

  return router;
}

module.exports = { createGeocodeRouter };
