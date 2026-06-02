'use strict';

// Traffic-type categories for the dashboard. Two kinds, both derived from
// metadata only (no payload / DPI):
//
//   - 'port': matched on a flow's service port — DNS = 53, Web = 80/443, ...
//             Source is the agent's `byPort` summary (netflow/sflow). Reliable.
//   - 'asn':  matched on the destination ASN of geo-enriched flows —
//             Facebook/Meta = AS32934, ... Approximate: CDNs/cloud blur it, and
//             one ASN can host many services (e.g. Google covers YouTube).
//
// The list is intentionally small and explainable; ports/ASNs are the public,
// well-known ones. It can be extended later (e.g. admin-editable via settings)
// by passing an override array to listCategories().
const DEFAULT_CATEGORIES = [
  // Service ports (reliable).
  { id: 'dns', label: 'DNS', kind: 'port', ports: [53, 853, 5353] },
  { id: 'web', label: 'Web (HTTP/S)', kind: 'port', ports: [80, 443, 8080, 8443] },
  { id: 'mail', label: 'E-mail', kind: 'port', ports: [25, 110, 143, 465, 587, 993, 995] },
  { id: 'ssh', label: 'SSH', kind: 'port', ports: [22] },
  { id: 'rdp', label: 'RDP', kind: 'port', ports: [3389] },
  { id: 'ntp', label: 'NTP', kind: 'port', ports: [123] },
  { id: 'voip', label: 'VoIP / SIP', kind: 'port', ports: [5060, 5061] },
  { id: 'vpn', label: 'VPN', kind: 'port', ports: [500, 1194, 1701, 4500, 51820] },
  // Destination organisations by ASN (approximate).
  { id: 'facebook', label: 'Facebook / Meta', kind: 'asn', asns: [32934, 54115, 63293] },
  { id: 'google', label: 'Google', kind: 'asn', asns: [15169, 19527, 36040, 36384, 396982] },
  { id: 'netflix', label: 'Netflix', kind: 'asn', asns: [2906, 40027, 55095, 394406] },
  { id: 'microsoft', label: 'Microsoft', kind: 'asn', asns: [8075, 8068, 8069, 12076] },
  { id: 'amazon', label: 'Amazon / AWS', kind: 'asn', asns: [16509, 14618, 7224, 8987] },
  { id: 'apple', label: 'Apple', kind: 'asn', asns: [714, 6185, 2709] },
  { id: 'cloudflare', label: 'Cloudflare', kind: 'asn', asns: [13335] },
  { id: 'akamai', label: 'Akamai', kind: 'asn', asns: [20940, 16625, 12222, 35994] },
];

// Returns a shallow copy of the categories (defaults, or `overrides` if given a
// non-empty array). Copies keep callers from mutating the shared defaults.
function listCategories(overrides) {
  const list = Array.isArray(overrides) && overrides.length ? overrides : DEFAULT_CATEGORIES;
  return list.map((c) => ({ ...c }));
}

// Builds fast lookup maps (port -> categoryId, asn -> categoryId) from a list.
function buildIndex(categories) {
  const portToCat = new Map();
  const asnToCat = new Map();
  for (const c of categories || []) {
    if (c.kind === 'port') for (const p of c.ports || []) portToCat.set(Number(p), c.id);
    else if (c.kind === 'asn') for (const a of c.asns || []) asnToCat.set(Number(a), c.id);
  }
  return { portToCat, asnToCat };
}

function classifyPort(port, index) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;
  return index.portToCat.get(p) || null;
}

function classifyAsn(asn, index) {
  const a = Number(asn);
  if (!Number.isFinite(a) || a <= 0) return null;
  return index.asnToCat.get(a) || null;
}

module.exports = { DEFAULT_CATEGORIES, listCategories, buildIndex, classifyPort, classifyAsn };
