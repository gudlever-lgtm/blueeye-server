'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGeoEnricher } = require('../enricher');
const { createCentroids } = require('../centroids');
const { isPrivate } = require('../privateIp');

// A provider spy that FAILS if ever asked to geolocate a private address — this
// is how we prove the privacy guarantee in tests.
function spyProvider(result = { country: 'DE', asn: 3320, asnName: 'DTAG' }) {
  const seen = [];
  return {
    seen,
    lookup(ip) {
      seen.push(ip);
      if (isPrivate(ip)) throw new Error(`provider must never see a private ip (${ip})`);
      return result;
    },
  };
}

const centroids = createCentroids();

test('requires a provider with lookup()', () => {
  assert.throws(() => createGeoEnricher({ provider: {}, centroids }), /provider/);
});

test('enriches an outbound flow with country, asn and a country centroid', () => {
  const provider = spyProvider();
  const e = createGeoEnricher({ provider, centroids });
  const out = e.enrich({ agentId: 1, srcIp: '10.0.0.5', dstIp: '80.1.2.3', bytes: 100, proto: 'tcp', dstPort: 443 });
  assert.equal(out.internal, false);
  assert.equal(out.direction, 'out');
  assert.equal(out.extIp, '80.1.2.3');
  assert.equal(out.country, 'DE');
  assert.equal(out.asn, 3320);
  assert.equal(out.lat, 51.2);
  assert.equal(out.lng, 10.4);
  assert.deepEqual(provider.seen, ['80.1.2.3']); // only the public peer
});

test('inbound flow: the public source is the peer, direction in', () => {
  const provider = spyProvider();
  const e = createGeoEnricher({ provider, centroids });
  const out = e.enrich({ srcIp: '8.8.8.8', dstIp: '192.168.0.10' });
  assert.equal(out.direction, 'in');
  assert.equal(out.extIp, '8.8.8.8');
});

test('PRIVACY: an internal flow is never geolocated', () => {
  const provider = spyProvider();
  const e = createGeoEnricher({ provider, centroids });
  const out = e.enrich({ srcIp: '10.0.0.1', dstIp: '192.168.1.1', bytes: 50 });
  assert.equal(out.internal, true);
  assert.equal(out.country, null);
  assert.equal(out.asn, null);
  assert.equal(out.lat, null);
  assert.equal(out.extIp, null);
  assert.deepEqual(provider.seen, []); // provider was NOT called
});

test('a known country with no centroid yields null lat/lng but keeps country', () => {
  const provider = spyProvider({ country: 'ZZ', asn: 1, asnName: 'X' }); // ZZ not in the table
  const e = createGeoEnricher({ provider, centroids });
  const out = e.enrich({ srcIp: '10.0.0.1', dstIp: '8.8.8.8' });
  assert.equal(out.country, 'ZZ');
  assert.equal(out.lat, null);
  assert.equal(out.lng, null);
});

test('enrichMany maps a batch and tolerates non-arrays', () => {
  const e = createGeoEnricher({ provider: spyProvider(), centroids });
  assert.deepEqual(e.enrichMany(null), []);
  const out = e.enrichMany([
    { srcIp: '10.0.0.1', dstIp: '80.1.2.3' },
    { srcIp: '10.0.0.1', dstIp: '10.0.0.2' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].country, 'DE');
  assert.equal(out[1].internal, true);
});
