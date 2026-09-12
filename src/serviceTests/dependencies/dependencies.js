'use strict';

const { numOrNull } = require('../storage/shape');

// Dependency intelligence (V3 Phase 2, docs/service-assurance-v3.md
// §"Dependency intelligence").
//
//     Multiple journeys affected by the same dependency.
//
// The service map already draws what a run observed: journey → test → page →
// endpoint. Drawing it is not the same as reading it, and the reading is the
// part an operator needs. One endpoint under five journeys is the single most
// important thing on that map, and it is invisible in the picture — it is just
// another box with more lines going into it.
//
// PURE: a service map in, what it MEANS out. No database, no clock, no network.
//
// Three rules:
//
//   1. OBSERVED ONLY, like the map itself. A journey that has never run has no
//      dependencies here — not zero, UNKNOWN — and it is named, so nobody reads
//      a short list as a complete one. This is the same line the map draws
//      against becoming a CMDB: a CMDB tells you what somebody once said the
//      world looked like.
//   2. SHARED AND FAILING ARE DIFFERENT LISTS. An endpoint under five journeys
//      that has never failed is a risk worth knowing about. One under two that
//      is failing now is what is breaking the service this minute. Merging them
//      into one "dependency problems" list buries the second in the first.
//   3. Blast radius is weighted by what depends on it, not counted. Three
//      low-criticality journeys are not worth more than one critical one, and a
//      list sorted by count says they are.

// What a journey is worth when something it depends on breaks. The same scale
// the health score uses, deliberately — two modules disagreeing about what
// "critical" means is worse than either being wrong.
const CRITICALITY_WEIGHT = { critical: 4, high: 3, normal: 2, low: 1 };

// Below two journeys there is nothing to say. One journey calling an endpoint
// is not a shared dependency, it is a journey.
const MIN_SHARED = 2;

// How a blast radius reads. Thresholds over the WEIGHTED total, so one critical
// journey (4) already reads as serious and three low ones (3) do not.
const BLAST = [
  { at: 8, label: 'critical' },
  { at: 5, label: 'high' },
  { at: 3, label: 'moderate' },
  { at: 0, label: 'low' },
];

const text = (v) => (v === null || v === undefined ? '' : String(v));

function blastLabel(weight) {
  return (BLAST.find((b) => weight >= b.at) || BLAST[BLAST.length - 1]).label;
}

// Same site, not same string. `api.kunde.dk` and `www.kunde.dk` are one
// service; calling the customer's own API a third party sends them to the wrong
// supplier.
function sameSite(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return true;
  const tail = (h) => h.split('.').slice(-2).join('.');
  return tail(x) === tail(y);
}

function hostOf(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  try { return new URL(raw).hostname.toLowerCase(); } catch { /* not a URL */ }
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw.toLowerCase() : null;
}

// What the map means.
//
// `map` is what buildServiceMap returned. `baseUrl` is the application's own
// address, and without it nothing is claimed about who owns a host — guessing
// that an unfamiliar host is third-party is how a service gets blamed on its
// CDN.
function analyseDependencies(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const map = (input.map && typeof input.map === 'object' && !Array.isArray(input.map)) ? input.map : {};
  const nodes = (Array.isArray(map.nodes) ? map.nodes : []).filter((n) => n && typeof n === 'object');
  const edges = (Array.isArray(map.edges) ? map.edges : []).filter((e) => e && typeof e === 'object');
  const ownHost = hostOf(input.baseUrl);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const journeyNodes = nodes.filter((n) => n.kind === 'journey');
  const endpointNodes = nodes.filter((n) => n.kind === 'endpoint');

  // journey → its tests → their endpoints. Walked rather than assumed: the map
  // records journey→test as "verified-by" and test→endpoint as "calls", and an
  // endpoint reached any other way was not observed under that journey.
  const testsOfJourney = new Map();
  for (const edge of edges) {
    if (edge.kind !== 'verified-by') continue;
    if (!testsOfJourney.has(edge.from)) testsOfJourney.set(edge.from, []);
    testsOfJourney.get(edge.from).push(edge.to);
  }
  const endpointsOfTest = new Map();
  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    if (!endpointsOfTest.has(edge.from)) endpointsOfTest.set(edge.from, []);
    endpointsOfTest.get(edge.from).push(edge.to);
  }

  // Which journeys depend on each endpoint, and which journeys were never
  // actually exercised. Rule 1: a journey with no observed run contributes
  // nothing and is NAMED, so a short list is not read as a complete one.
  const dependants = new Map();
  const unobserved = [];
  for (const journey of journeyNodes) {
    const tests = testsOfJourney.get(journey.id) || [];
    const observed = tests.some((id) => {
      const node = byId.get(id);
      return node && Number(node.observations) > 0;
    });
    if (!observed) {
      unobserved.push({ id: journey.key, label: journey.label, criticality: journey.criticality || 'normal' });
      continue;
    }
    const reached = new Set();
    for (const testId of tests) {
      for (const endpointId of endpointsOfTest.get(testId) || []) reached.add(endpointId);
    }
    for (const endpointId of reached) {
      if (!dependants.has(endpointId)) dependants.set(endpointId, []);
      dependants.get(endpointId).push({
        id: journey.key,
        label: journey.label,
        criticality: journey.criticality || 'normal',
        health: journey.health || null,
      });
    }
  }

  const observedJourneys = journeyNodes.length - unobserved.length;

  const shared = [];
  for (const endpoint of endpointNodes) {
    const journeys = dependants.get(endpoint.id) || [];
    if (journeys.length < MIN_SHARED) continue;

    const weight = journeys.reduce((sum, j) => sum + (CRITICALITY_WEIGHT[j.criticality] || CRITICALITY_WEIGHT.normal), 0);
    const observations = numOrNull(endpoint.observations) || 0;
    const failures = numOrNull(endpoint.failures) || 0;
    shared.push({
      endpoint: endpoint.id,
      label: endpoint.label,
      host: endpoint.host || null,
      // An address the customer does not control, under several of their
      // journeys, is the most actionable finding here — and it is only claimable
      // when we were told what their own address is.
      third_party: ownHost ? !sameSite(endpoint.host, ownHost) : null,
      methods: Array.isArray(endpoint.methods) ? endpoint.methods : [],
      journeys,
      journey_count: journeys.length,
      // Of the journeys that actually ran. The denominator matters: "5 of 6" and
      // "5 of 40" are different situations.
      share: observedJourneys > 0 ? journeys.length / observedJourneys : null,
      blast_weight: weight,
      blast: blastLabel(weight),
      observations,
      failures,
      // Null rather than 0 when nothing was observed: "we did not look" and "we
      // looked and it was fine" must never collapse into one answer.
      failure_rate: observations > 0 ? failures / observations : null,
      status: observations === 0 ? 'unknown' : (failures > 0 ? 'failing' : 'healthy'),
      summary: describe(endpoint, journeys, weight, failures, observedJourneys, ownHost),
    });
  }

  // Rule 3: by what depends on it, then by how many, then by name so the list
  // is the same list every time rather than one that shuffles between loads.
  shared.sort((a, b) => (b.blast_weight - a.blast_weight)
    || (b.journey_count - a.journey_count)
    || String(a.label).localeCompare(String(b.label)));

  // Rule 2: two lists, because they are two questions.
  const failing = shared.filter((d) => d.status === 'failing');

  return {
    shared,
    // What is breaking the service right now, shared by more than one journey.
    failing,
    // Journeys whose dependencies are simply not known, because nothing has run
    // them. Named so a short list is not mistaken for a complete one.
    unobserved_journeys: unobserved,
    counts: {
      journeys: journeyNodes.length,
      journeys_observed: observedJourneys,
      endpoints: endpointNodes.length,
      shared: shared.length,
      failing: failing.length,
    },
    summary: overall(shared, failing, unobserved, observedJourneys),
    source: 'rules',
  };
}

function describe(endpoint, journeys, weight, failures, observedJourneys, ownHost) {
  const names = journeys.slice(0, 3).map((j) => j.label).filter(Boolean);
  const more = journeys.length - names.length;
  const who = names.length
    ? names.join(', ') + (more > 0 ? ` and ${more} more` : '')
    : `${journeys.length} journeys`;
  const foreign = ownHost && endpoint.host && !sameSite(endpoint.host, ownHost)
    ? ' It is not on an address this application controls.'
    : '';
  const scope = observedJourneys > 0 && journeys.length === observedJourneys && observedJourneys > 1
    ? ' Every journey that has run depends on it.'
    : '';
  const failing = failures > 0
    ? ` It has failed ${failures} time${failures === 1 ? '' : 's'}.`
    : '';
  return `${journeys.length} journeys depend on ${endpoint.label} — ${who}.${scope}${failing}${foreign}`;
}

function overall(shared, failing, unobserved, observedJourneys) {
  if (failing.length) {
    const worst = failing[0];
    return `Multiple journeys affected by the same dependency. ${worst.label} is failing and `
      + `${worst.journey_count} journeys depend on it.`;
  }
  if (!observedJourneys) {
    return 'No journey has run yet, so nothing is known about what this service depends on.';
  }
  if (!shared.length) {
    const caveat = unobserved.length
      ? ` ${unobserved.length} journey${unobserved.length === 1 ? ' has' : 's have'} never run, so their dependencies are unknown.`
      : '';
    return `No endpoint is shared between journeys in what has been observed.${caveat}`;
  }
  const worst = shared[0];
  const caveat = unobserved.length
    ? ` ${unobserved.length} journey${unobserved.length === 1 ? ' has' : 's have'} never run, so their dependencies are unknown.`
    : '';
  return `${worst.journey_count} journeys share ${worst.label}, and none of them has seen it fail.${caveat}`;
}

module.exports = {
  analyseDependencies, blastLabel, sameSite,
  CRITICALITY_WEIGHT, MIN_SHARED, BLAST,
};
