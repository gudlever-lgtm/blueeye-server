'use strict';

const { LAYERS } = require('../observe/observations');
const { numOrNull } = require('../storage/shape');

// Service Health 2.0 (V3 Phase 1, docs/service-assurance-v3.md).
//
// One assessment of a service, made from things that can be checked: journey
// verdicts weighted by criticality, what the layers observed, performance
// against a baseline, and whether the same thing keeps happening.
//
//     Customer Portal — DEGRADED
//
//     User Journeys          API              Performance
//       Login        ok        Auth      ok     Search   slow
//       Search       fail      Customer  fail
//       Create Case  ok
//
// PURE: inputs in, a verdict and its reasons out. No database, no clock.
//
// Two rules the whole thing rests on:
//
//   1. UNKNOWN is a real state, not a synonym for healthy. A service nothing
//      has run against is not a service that works, and reporting it green is
//      the single most dangerous thing a health screen can do.
//   2. The score is never a black box. Every number comes back with the facts
//      that produced it, because a score nobody can question is a score nobody
//      can act on — "why is it 82?" must always have an answer on screen.

const HEALTH = { HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN' };

// Worst-first, so two verdicts can be combined without a lookup table.
const RANK = { UNKNOWN: 0, HEALTHY: 1, DEGRADED: 2, FAILED: 3 };

// How much a journey's verdict counts. A critical journey failing is the
// service failing; a low-criticality one failing degrades it. This is the
// spec's "critical journeys weigh more" made concrete and arguable.
const CRITICALITY_WEIGHT = { critical: 4, high: 3, normal: 2, low: 1 };

// The four parts of the score and what each is worth. Published rather than
// tuned in secret: an operator who disagrees with the weighting should be able
// to see it and say so.
const SCORE_WEIGHTS = { functional: 0.45, availability: 0.25, api: 0.20, performance: 0.10 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const weightOf = (criticality) => CRITICALITY_WEIGHT[String(criticality || 'normal').toLowerCase()] || 2;

// Combines verdicts worst-first, ignoring UNKNOWN wherever anything is known.
//
// UNKNOWN loses to every real verdict on purpose: one journey nobody has run
// must not drag a service with three passing journeys down to "we don't know".
// It survives only when it is ALL there is.
function worst(verdicts) {
  const known = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v && v !== HEALTH.UNKNOWN);
  if (!known.length) return HEALTH.UNKNOWN;
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), HEALTH.HEALTHY);
}

// The journeys' verdict, weighted by criticality.
//
// A critical journey failing IS the service failing — no number of healthy
// low-criticality journeys makes up for "a caseworker cannot sign in".
function functionalHealth(journeys) {
  const list = (Array.isArray(journeys) ? journeys : []).filter((j) => j && j.health);
  if (!list.length) return { status: HEALTH.UNKNOWN, reason: 'No journeys have run yet.', failing: [], degraded: [] };

  const failing = list.filter((j) => j.health === 'failed');
  const degraded = list.filter((j) => j.health === 'degraded');
  const known = list.filter((j) => j.health !== 'unknown');
  if (!known.length) {
    return { status: HEALTH.UNKNOWN, reason: 'None of the journeys have run yet.', failing: [], degraded: [] };
  }

  const criticalFailing = failing.filter((j) => weightOf(j.criticality) >= CRITICALITY_WEIGHT.critical);
  if (criticalFailing.length) {
    const names = criticalFailing.map((j) => j.name).join(', ');
    return {
      status: HEALTH.FAILED,
      reason: `${names} ${criticalFailing.length === 1 ? 'is' : 'are'} failing, and ${criticalFailing.length === 1 ? 'it is' : 'they are'} critical.`,
      failing: failing.map((j) => j.name),
      degraded: degraded.map((j) => j.name),
    };
  }
  if (failing.length) {
    const names = failing.map((j) => j.name).join(', ');
    return {
      status: HEALTH.DEGRADED,
      reason: `${names} ${failing.length === 1 ? 'is' : 'are'} failing.`,
      failing: failing.map((j) => j.name),
      degraded: degraded.map((j) => j.name),
    };
  }
  if (degraded.length) {
    const names = degraded.map((j) => j.name).join(', ');
    return {
      status: HEALTH.DEGRADED,
      reason: `${names} ${degraded.length === 1 ? 'is' : 'are'} only partly working.`,
      failing: [],
      degraded: degraded.map((j) => j.name),
    };
  }
  return { status: HEALTH.HEALTHY, reason: 'Every journey is passing.', failing: [], degraded: [] };
}

// What the layers observed. This is what lets a screen say
// "Network ok, Server ok, API failed" with a straight face.
function layerHealth(layers) {
  const summary = layers && typeof layers === 'object' ? layers : {};
  const bad = LAYERS.filter((l) => summary[l] && summary[l].outcome === 'bad');
  const seen = LAYERS.filter((l) => summary[l] && summary[l].outcome !== 'unknown');
  if (!seen.length) return { status: HEALTH.UNKNOWN, reason: 'Nothing has been observed yet.', bad: [] };
  if (!bad.length) return { status: HEALTH.HEALTHY, reason: `${seen.join(', ')} all looked healthy.`, bad: [] };
  return { status: HEALTH.DEGRADED, reason: `${bad.join(', ')} reported problems.`, bad };
}

// Performance against the baseline. Never FAILED on its own: a slow service is
// a service that still works, and calling it failed would put a latency spike
// and an outage in the same box.
function performanceHealth(performance) {
  // numOrNull, not Number(): Number(null) is 0, and "no timing" must never read
  // as "it took no time at all" — which would score a service that nobody
  // measured as infinitely fast.
  const current = performance ? numOrNull(performance.current_ms) : null;
  const baseline = performance ? numOrNull(performance.baseline_ms) : null;
  if (current === null) return { status: HEALTH.UNKNOWN, reason: 'No timings yet.' };
  if (baseline === null) return { status: HEALTH.UNKNOWN, reason: 'No baseline to compare against yet.' };
  const ratio = current / Math.max(1, baseline);
  if (ratio >= 2) {
    return {
      status: HEALTH.DEGRADED,
      reason: `Taking ${ratio.toFixed(1)} times longer than usual (${Math.round(current)} ms against ${Math.round(baseline)} ms).`,
      ratio,
    };
  }
  return {
    status: HEALTH.HEALTHY,
    reason: `Running at about the usual speed (${Math.round(current)} ms).`,
    ratio,
  };
}

// The score, 0-100, in four published parts.
//
// A single number invites people to watch the number instead of the service, so
// it always travels with its parts and their weights. Nobody should have to
// guess why it is 82.
function scoreOf({ functional, availability, api, performance } = {}) {
  const part = (status) => {
    if (status === HEALTH.HEALTHY) return 100;
    if (status === HEALTH.DEGRADED) return 60;
    if (status === HEALTH.FAILED) return 0;
    return null; // UNKNOWN scores nothing rather than scoring badly
  };
  const parts = {
    functional: part(functional),
    availability: part(availability),
    api: part(api),
    performance: part(performance),
  };
  // Only the parts actually known contribute, and the weights are re-normalised
  // over them. Scoring an unknown part as zero would punish a service for a
  // check nobody has run, which is a lie about the service.
  const known = Object.entries(parts).filter(([, v]) => v !== null);
  if (!known.length) return { score: null, parts, weights: SCORE_WEIGHTS };
  const totalWeight = known.reduce((sum, [key]) => sum + SCORE_WEIGHTS[key], 0);
  const score = known.reduce((sum, [key, value]) => sum + (value * (SCORE_WEIGHTS[key] / totalWeight)), 0);
  return { score: Math.round(clamp(score, 0, 100)), parts, weights: SCORE_WEIGHTS };
}

// The whole assessment for one service.
//
//   assessService({ journeys, layers, performance, recentFailures, openIncidents })
//
// Every screen and every alert reads THIS rather than each computing its own,
// so the dashboard and the email can never disagree about whether a service is
// degraded.
function assessService(rawInput = {}) {
  // A default parameter only covers `undefined`. Null, a string and a number
  // all reach here otherwise, and a health assessment that throws is one that
  // takes a dashboard down with it.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const functional = functionalHealth(input.journeys);
  const layers = layerHealth(input.layers);
  const performance = performanceHealth(input.performance);
  const summary = input.layers && typeof input.layers === 'object' ? input.layers : {};

  // Availability is reachability specifically — "can the service be reached at
  // all" — as distinct from "does the journey work".
  const reachability = [summary.network, summary.server, summary.infrastructure]
    .filter((l) => l && l.outcome !== 'unknown');
  const availability = !reachability.length
    ? { status: HEALTH.UNKNOWN, reason: 'Nothing has checked reachability yet.' }
    : (reachability.some((l) => l.outcome === 'bad')
      ? { status: HEALTH.FAILED, reason: 'The service could not be reached.' }
      : { status: HEALTH.HEALTHY, reason: 'The service is reachable.' });

  const api = summary.api && summary.api.outcome !== 'unknown'
    ? (summary.api.outcome === 'bad'
      ? { status: HEALTH.DEGRADED, reason: 'An API call failed.' }
      : { status: HEALTH.HEALTHY, reason: 'Every API call answered.' })
    : { status: HEALTH.UNKNOWN, reason: 'No API calls were observed.' };

  // Repetition is a fact about the service, not about one run. The same failure
  // eight times in half an hour is a different situation from one blip.
  const repeated = Number(input.recentFailures) || 0;
  const status = worst([
    functional.status,
    availability.status,
    api.status,
    performance.status,
    // Never FAILED from repetition alone: repetition says a problem is
    // persistent, not how bad it is.
    repeated >= 3 ? HEALTH.DEGRADED : HEALTH.UNKNOWN,
  ]);

  const { score, parts, weights } = scoreOf({
    functional: functional.status,
    availability: availability.status,
    api: api.status,
    performance: performance.status,
  });

  // The sentence, worst thing first. A status with no reason is what V3 exists
  // to replace.
  const reasons = [functional, availability, api, performance, layers]
    .filter((p) => p.status !== HEALTH.HEALTHY && p.status !== HEALTH.UNKNOWN)
    .map((p) => p.reason);
  if (repeated >= 3) reasons.push(`The same failure has happened ${repeated} times recently.`);

  return {
    status,
    score,
    reason: reasons.length
      ? reasons[0]
      : (status === HEALTH.UNKNOWN ? 'Nothing has run against this service yet.' : 'Everything checked is working.'),
    reasons,
    parts: {
      functional: { ...functional, score: parts.functional },
      availability: { ...availability, score: parts.availability },
      api: { ...api, score: parts.api },
      performance: { ...performance, score: parts.performance },
      layers,
    },
    weights,
    open_incidents: Number(input.openIncidents) || 0,
    recent_failures: repeated,
  };
}

module.exports = {
  assessService, functionalHealth, layerHealth, performanceHealth, scoreOf, worst,
  HEALTH, RANK, CRITICALITY_WEIGHT, SCORE_WEIGHTS,
};
