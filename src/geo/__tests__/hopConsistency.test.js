'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkNeighbours, segmentBudgetKm, MIN_BUDGET_KM } = require('../hopConsistency');

const CPH = { lat: 55.6761, lng: 12.5683 };
const AMS = { lat: 52.3676, lng: 4.9041 };
const SIN = { lat: 1.3521, lng: 103.8198 };

// hop(n, rtt, place) — a node shaped the way pathGraph builds them.
function hop(n, rttMs, at, place = {}) {
  return {
    hop: n,
    rttMs,
    node: {
      ip: `1.0.0.${n}`,
      lat: at.lat,
      lng: at.lng,
      place: { city: place.city || null, country: place.country || null, source: place.source || 'geoip-city', certainty: 'exact' },
    },
  };
}

test('a hop placed a continent away from both neighbours is suspect', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, SIN, { city: 'Singapore', country: 'SG' }),
    hop(3, 3, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  const suspects = checkNeighbours(items, { origin: CPH });
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].hop, 2);
  assert.equal(suspects[0].reason, 'neighbours');
  // The evidence says how far it sits and how far the reply times allow.
  assert.ok(suspects[0].prev.distanceKm > suspects[0].prev.allowedKm);
  assert.ok(suspects[0].next.distanceKm > suspects[0].next.allowedKm);
  // And what the path suggests instead.
  assert.equal(suspects[0].suggestion.city, 'Copenhagen');
  assert.equal(items[1].node.place.suspect.reason, 'neighbours');
});

test('nothing is moved — the hop keeps the position GeoIP gave it', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, SIN, { city: 'Singapore', country: 'SG' }),
    hop(3, 3, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  checkNeighbours(items, { origin: CPH });
  assert.equal(items[1].node.lat, SIN.lat);
  assert.equal(items[1].node.lng, SIN.lng);
});

test('a real long haul is not suspect — the reply time pays for the distance', () => {
  // Copenhagen -> Singapore is ~9500 km; 190 ms of extra round trip buys 19 000.
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 191, SIN, { city: 'Singapore', country: 'SG' }),
    hop(3, 193, SIN, { city: 'Singapore', country: 'SG' }),
  ];
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
});

test('a hop that disagrees with only one neighbour is left alone', () => {
  // The path genuinely leaves the country at hop 2 and stays away.
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, AMS, { city: 'Amsterdam', country: 'NL' }),
    hop(3, 3, AMS, { city: 'Amsterdam', country: 'NL' }),
  ];
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
});

test('neighbours that disagree with each other accuse nobody', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, SIN, { city: 'Singapore', country: 'SG' }),
    hop(3, 3, AMS, { city: 'Amsterdam', country: 'NL' }),
    hop(4, 200, SIN, { city: 'Singapore', country: 'SG' }),
  ];
  // Hop 2 sits between CPH and AMS, which are 620 km apart on a 2 ms budget —
  // the neighbours do not agree either, so no hop is singled out.
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
});

test('a corrected hop is never second-guessed', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, SIN, { city: 'Singapore', country: 'SG', source: 'manual' }),
    hop(3, 3, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
  assert.equal(items[1].node.place.suspect, undefined);
});

test('a hop placed FROM its neighbours is never suspect (settlePath output)', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    hop(2, 2, SIN, { city: null, country: null, source: 'latency' }),
    hop(3, 3, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
});

test('the agent counts as hop 0, so a wrong FIRST hop is caught', () => {
  const items = [
    hop(1, 1, SIN, { city: 'Singapore', country: 'SG' }),
    hop(2, 2, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  const suspects = checkNeighbours(items, { origin: CPH });
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].hop, 1);
  assert.equal(suspects[0].prev.hop, 0);
});

test('private and unplaced hops are skipped, not accused', () => {
  const items = [
    hop(1, 1, CPH, { city: 'Copenhagen', country: 'DK' }),
    { hop: 2, rttMs: 2, node: { ip: '10.0.0.1', private: true, lat: null, lng: null, place: null } },
    { hop: 3, rttMs: 3, node: { ip: '1.0.0.3', lat: null, lng: null, place: null } },
    hop(4, 4, CPH, { city: 'Copenhagen', country: 'DK' }),
  ];
  assert.deepEqual(checkNeighbours(items, { origin: CPH }), []);
});

test('no origin and no hops is not an error', () => {
  assert.deepEqual(checkNeighbours([], {}), []);
  assert.deepEqual(checkNeighbours(null, {}), []);
  assert.deepEqual(checkNeighbours(undefined, undefined), []);
});

test('the budget never falls below one millisecond of slack', () => {
  assert.equal(segmentBudgetKm(1.0, 1.0), MIN_BUDGET_KM);
  // Two hops 0.2 ms apart must not read as "80 km is a contradiction".
  assert.ok(segmentBudgetKm(1.0, 1.2) >= 250);
  assert.equal(segmentBudgetKm(1, 11), 10 * 100 + 250);
});
