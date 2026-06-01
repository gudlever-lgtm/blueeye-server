'use strict';

// Country-centroid lookup. Loads the committed ISO2 -> [lat, lng] table once.
// Country level only — by design we never claim city precision (see
// docs/geo.md). Injectable (`table`) for tests.

const defaultTable = require('./countryCentroids.json');

function createCentroids({ table = defaultTable } = {}) {
  const map = new Map();
  if (table && typeof table === 'object') {
    for (const [code, point] of Object.entries(table)) {
      if (code.startsWith('_')) continue; // documentation key
      if (Array.isArray(point) && point.length === 2) {
        map.set(code.toUpperCase(), [Number(point[0]), Number(point[1])]);
      }
    }
  }

  // Returns { lat, lng } for an ISO2 country code, or null if unknown.
  function get(country) {
    if (!country) return null;
    const p = map.get(String(country).toUpperCase());
    return p ? { lat: p[0], lng: p[1] } : null;
  }

  return { get, size: map.size };
}

module.exports = { createCentroids };
