'use strict';

const { externalEndpoint, isPrivate } = require('./privateIp');

// Turns a raw flow record into a geo-enriched one. Privacy is structural: only
// the external (public) endpoint of a flow is ever passed to the GeoIP provider;
// purely-internal flows (both ends private/RFC1918) are flagged `internal` and
// never geolocated. Country + ASN are the unit; lat/lng come from the country
// centroid (no city precision).
//
//   const enricher = createGeoEnricher({ provider, centroids });
//   const enriched = enricher.enrichMany(rawFlows);
function createGeoEnricher({ provider, centroids }) {
  if (!provider || typeof provider.lookup !== 'function') {
    throw new Error('createGeoEnricher requires a geo provider with lookup()');
  }

  function enrich(record) {
    const base = {
      agentId: record.agentId ?? null,
      ts: record.ts ?? null,
      srcIp: record.srcIp ?? null,
      dstIp: record.dstIp ?? null,
      proto: record.proto ?? null,
      srcPort: record.srcPort ?? null,
      dstPort: record.dstPort ?? null,
      bytes: Number(record.bytes) || 0,
      packets: Number(record.packets) || 0,
      flows: Number(record.flows) || 0,
    };

    const ext = externalEndpoint(record.srcIp, record.dstIp);
    if (!ext) {
      // Internal/topology flow — never geolocated.
      return { ...base, internal: true, extIp: null, direction: null, country: null, asn: null, asnName: null, lat: null, lng: null };
    }

    // Defensive: externalEndpoint already excludes private, but never look up a
    // private address even if a caller hands us an odd record.
    const geo = isPrivate(ext.ip) ? null : provider.lookup(ext.ip);
    const country = geo && geo.country ? geo.country : null;
    const point = country && centroids ? centroids.get(country) : null;

    return {
      ...base,
      internal: false,
      extIp: ext.ip,
      direction: ext.direction,
      country,
      asn: geo ? geo.asn ?? null : null,
      asnName: geo ? geo.asnName ?? null : null,
      lat: point ? point.lat : null,
      lng: point ? point.lng : null,
    };
  }

  function enrichMany(records) {
    if (!Array.isArray(records)) return [];
    return records.map(enrich);
  }

  return { enrich, enrichMany };
}

module.exports = { createGeoEnricher };
