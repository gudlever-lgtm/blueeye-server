'use strict';

const { haversineKm, KM_PER_MS_RTT } = require('./hopLocation');

// Is a hop's position consistent with the hops around it?
//
// WHY THIS EXISTS. `locateHop` answers each hop ALONE: an address block, a
// router name, a country centroid. That is exactly where GeoIP is weakest —
// a block is registered where the operator's head office is, not where the
// rack is — and one hop placed a continent away turns a readable path into a
// line that crosses an ocean twice. The path itself knows better. Three
// consecutive hops a millisecond apart are in one building, whatever their
// address blocks say, and that is a measurement, not a guess.
//
// So the path is read as evidence ABOUT its own hops: a hop whose position
// disagrees with BOTH its neighbours, while those neighbours agree with each
// other, is almost certainly placed wrong. The physics is the same one
// `hopLocation` uses against the agent — light covers ~200 km per ms in fibre,
// so an RTT difference of d ms between two hops allows at most d x 100 km
// between them — applied between hops instead of from the agent.
//
// NOTHING IS MOVED. The check only marks: `place.suspect` on the node, with
// the evidence that made it suspect and what the neighbours suggest instead.
// Moving a hop on this evidence would be the same mistake `settlePath` was
// written to avoid (a chain of small corrections creeping a pin across a
// continent), and it would hide the thing an operator needs to see: that the
// GeoIP data for this address is wrong, and that somebody should correct it.
// Correcting it is a deliberate act — `hop_locations` (migration 144), the
// server's own verified table, which outranks every GeoIP source afterwards.

// Slack on a hop-to-hop bound. Wider than the agent-to-hop slack (150 km)
// because BOTH ends are now estimates, and because a router answering ICMP
// from its slow path inflates the difference in either direction.
const NEIGHBOUR_SLACK_KM = 250;

// Below this, a difference is noise rather than distance: two hops in one rack
// routinely differ by a few tenths of a millisecond in either direction, and
// "0.2 ms apart" must not read as "they may be 20 km apart, so 80 km is a
// contradiction". The floor is what one ms of budget buys.
const MIN_BUDGET_KM = KM_PER_MS_RTT + NEIGHBOUR_SLACK_KM;

// Sources whose placement is never second-guessed.
//   manual/ripe  somebody (or the RIPE registry) SAID where this router is.
//                That is the answer this check exists to produce; re-deciding
//                it from GeoIP neighbours would undo the correction.
//   latency      the hop was already placed FROM a neighbour (settlePath), so
//                it agrees with its neighbours by construction.
const TRUSTED_SOURCES = Object.freeze(new Set(['manual', 'ripe', 'latency']));

// The farthest two hops can be apart given the difference in their reply times.
// |dA - dB| ms of round trip buys |dA - dB| x 100 km of one-way distance.
function segmentBudgetKm(rttA, rttB) {
  const delta = Math.abs(rttA - rttB);
  return Math.max(MIN_BUDGET_KM, delta * KM_PER_MS_RTT + NEIGHBOUR_SLACK_KM);
}

function placed(item) {
  const n = item && item.node;
  return !!(n && !n.private && n.place && Number.isFinite(n.lat) && Number.isFinite(n.lng)
    && typeof item.rttMs === 'number' && Number.isFinite(item.rttMs));
}

function describe(item) {
  const n = item.node;
  return {
    hop: item.hop,
    ip: n.ip || null,
    city: n.place ? n.place.city || null : null,
    country: n.place ? n.place.country || null : null,
  };
}

// checkNeighbours(items, { origin }) -> [{ hop, ip, ... }]  (the suspects)
//
// `items` are the same { hop, rttMs, node } records `settlePath` takes — run
// this AFTER it, so a hop placed from its neighbours is already placed.
// `rttMs` is the hop's fastest reply; `origin` is the agent's position, used as
// hop 0 so a wrongly-placed FIRST hop is caught too (it has no hop before it,
// but it does have the agent).
//
// A hop is suspect when it disagrees with the hop before it AND the hop after
// it, while those two agree with each other. One-sided disagreement is left
// alone on purpose: at the end of a path there is nothing to tell "this hop is
// placed wrong" apart from "the path really does end in another country".
function checkNeighbours(items, { origin = null } = {}) {
  const sorted = (items || []).filter((x) => x && x.node).slice().sort((a, b) => a.hop - b.hop);
  const list = sorted.filter(placed);
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
    list.unshift({
      hop: 0,
      rttMs: 0,
      node: { ip: null, lat: origin.lat, lng: origin.lng, place: { city: null, country: null, source: 'site' } },
    });
  }

  const suspects = [];
  for (let i = 1; i < list.length - 1; i += 1) {
    const cur = list[i];
    const source = cur.node.place.source || null;
    if (TRUSTED_SOURCES.has(source)) continue;
    const prev = list[i - 1];
    const next = list[i + 1];

    const toPrev = haversineKm(prev.node, cur.node);
    const toNext = haversineKm(cur.node, next.node);
    const across = haversineKm(prev.node, next.node);
    const prevBudget = segmentBudgetKm(prev.rttMs, cur.rttMs);
    const nextBudget = segmentBudgetKm(cur.rttMs, next.rttMs);
    // What the two neighbours are allowed between THEM is the whole stretch the
    // hop sits in the middle of — the hop's own reply time cancels out.
    const acrossBudget = segmentBudgetKm(prev.rttMs, next.rttMs);

    if (toPrev <= prevBudget || toNext <= nextBudget) continue;
    // The neighbours must agree with each other, or all three positions are in
    // doubt and singling out the middle one would be arbitrary.
    if (across > acrossBudget) continue;

    // Which neighbour to suggest: the one whose reply time is closest, because
    // that is the one the hop most likely shares a building with.
    const near = Math.abs(cur.rttMs - prev.rttMs) <= Math.abs(next.rttMs - cur.rttMs) ? prev : next;
    const suspect = {
      reason: 'neighbours',
      source,
      prev: { ...describe(prev), distanceKm: Math.round(toPrev), allowedKm: Math.round(prevBudget) },
      next: { ...describe(next), distanceKm: Math.round(toNext), allowedKm: Math.round(nextBudget) },
      // Where the path says it is, for the operator to accept as a correction.
      suggestion: {
        lat: near.node.lat,
        lng: near.node.lng,
        city: near.node.place.city || null,
        country: near.node.place.country || null,
        fromHop: near.hop,
      },
    };
    cur.node.place.suspect = suspect;
    suspects.push({ hop: cur.hop, ip: cur.node.ip || null, ...suspect });
  }
  return suspects;
}

module.exports = {
  checkNeighbours, segmentBudgetKm,
  NEIGHBOUR_SLACK_KM, MIN_BUDGET_KM, TRUSTED_SOURCES,
};
