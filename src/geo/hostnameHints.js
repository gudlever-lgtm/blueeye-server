'use strict';

const { PLACES } = require('./networkPlaces');

// Reads a router's city out of its reverse-DNS name.
//
//   placeFromHostname('ae3.cph-bb1.telia.net')                  -> Copenhagen
//   placeFromHostname('be2376.ccr41.fra03.atlas.cogentco.com')  -> Frankfurt
//   placeFromHostname('ae-5.r20.frnkge08.de.bb.gin.ntt.net')    -> Frankfurt
//   placeFromHostname('xe-1.dkcph1.example.net')                -> Copenhagen (UN/LOCODE)
//   placeFromHostname('static-82-103-1-2.customer.example.dk')  -> null
//
// The name is split into words at dots, dashes and letter/digit boundaries
// (`fra03` -> `fra`, `03`). The registered domain (`telia.net`, `example.co.uk`)
// is dropped first: it names the operator, not the place. Each remaining word is
// looked up in the curated table in networkPlaces.js, and also read as a
// UN/LOCODE (`dkcph` = DK + CPH) when its country part matches the table's.
//
// ONE PLACE OR NONE. A name that yields two different cities (`ams-fra-link`,
// the two ends of a link) is ambiguous and returns null — the hop then falls
// back to GeoIP rather than being drawn at whichever end happened to come first.
//
// Deterministic and local: a table lookup, no network, no guessing beyond the
// table. The result says which word matched (`code`) so the UI can show why.

const MAX_NAME = 253;

// Second-level labels under a ccTLD that are part of the registered domain
// (example.co.uk, example.com.au, example.ne.jp).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'ltd', 'plc']);

function buildIndex(places) {
  const byCode = new Map();
  for (const p of places) {
    for (const c of p.codes) byCode.set(c, p);
  }
  return byCode;
}

const DEFAULT_INDEX = buildIndex(PLACES);

// A hostname as the server accepts it from an agent: lower case, no trailing
// dot, DNS characters only, at most 253 characters. Anything else is null — it
// is never stored, drawn or matched.
function cleanHostname(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > MAX_NAME) return null;
  if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(s)) return null;
  return s;
}

// The labels that can say where the router is: everything left of the
// registered domain.
function hostLabels(name) {
  const labels = name.split('.');
  if (labels.length < 3) return [];
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const domainLen = (tld.length === 2 && SECOND_LEVEL.has(sld) && labels.length >= 4) ? 3 : 2;
  return labels.slice(0, labels.length - domainLen);
}

function words(labels) {
  const out = [];
  for (const label of labels) {
    for (const part of label.split(/[-_]/)) {
      for (const w of part.split(/[0-9]+/)) if (w.length >= 3) out.push(w);
    }
  }
  return out;
}

function placeFromHostname(hostname, { index = DEFAULT_INDEX } = {}) {
  const name = cleanHostname(hostname);
  if (!name) return null;
  let found = null;
  let code = null;
  for (const w of words(hostLabels(name))) {
    let p = index.get(w) || null;
    // UN/LOCODE: two-letter country + three-letter place (dkcph, defra, nlams).
    if (!p && w.length === 5) {
      const q = index.get(w.slice(2));
      if (q && q.country.toLowerCase() === w.slice(0, 2)) p = q;
    }
    if (!p) continue;
    if (found && found !== p) return null; // two cities in one name: ambiguous
    if (!found) { found = p; code = w; }
  }
  if (!found) return null;
  return { city: found.city, country: found.country, lat: found.lat, lng: found.lng, code };
}

module.exports = { placeFromHostname, cleanHostname, buildIndex, hostLabels };
