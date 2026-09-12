'use strict';

// Service Health 2.0 (V3 Phase 1).
//
// Every assertion here is an argument about what a service's health MEANS. The
// two that matter most:
//
//   * UNKNOWN is not green. A service nothing has run against is not a service
//     that works, and reporting it healthy is the most dangerous thing a health
//     screen can do.
//   * The score is never a black box. "Why is it 82?" must always have an
//     answer, or nobody can act on it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessService, functionalHealth, performanceHealth, scoreOf, worst, HEALTH, SCORE_WEIGHTS,
} = require('../serviceHealth');

const layers = (over = {}) => ({
  browser: { outcome: 'ok' }, page: { outcome: 'ok' }, api: { outcome: 'ok' },
  application: { outcome: 'unknown' }, server: { outcome: 'ok' },
  network: { outcome: 'ok' }, infrastructure: { outcome: 'unknown' },
  assurance: { outcome: 'unknown' },
  ...over,
});

// -------------------------------------------------------------- unknown
test('a service nothing has run against is UNKNOWN, never healthy', () => {
  const res = assessService({});
  assert.equal(res.status, HEALTH.UNKNOWN);
  // No score either. A number would imply somebody measured something.
  assert.equal(res.score, null);
  assert.match(res.reason, /Nothing has run/);
});

test('one journey nobody has run does not drag a working service into UNKNOWN', () => {
  // UNKNOWN loses to every real verdict. It survives only when it is all there
  // is — otherwise a newly-added journey would grey out a healthy service.
  const res = assessService({
    journeys: [
      { name: 'Login', health: 'healthy', criticality: 'critical' },
      { name: 'Brand new', health: 'unknown', criticality: 'normal' },
    ],
    layers: layers(),
  });
  assert.equal(res.status, HEALTH.HEALTHY);
});

// ----------------------------------------------------------- criticality
test('a CRITICAL journey failing fails the service; a normal one degrades it', () => {
  // The spec's "critical journeys weigh more", made concrete. No number of
  // healthy low-criticality journeys makes up for "a caseworker cannot sign in".
  const critical = assessService({
    journeys: [
      { name: 'Login', health: 'failed', criticality: 'critical' },
      { name: 'Newsletter', health: 'healthy', criticality: 'low' },
      { name: 'Footer links', health: 'healthy', criticality: 'low' },
    ],
    layers: layers(),
  });
  assert.equal(critical.status, HEALTH.FAILED);
  assert.match(critical.reason, /Login is failing, and it is critical/);

  const normal = assessService({
    journeys: [{ name: 'Search', health: 'failed', criticality: 'normal' }],
    layers: layers(),
  });
  assert.equal(normal.status, HEALTH.DEGRADED);
});

test('a degraded journey degrades the service without failing it', () => {
  const res = functionalHealth([{ name: 'Search', health: 'degraded', criticality: 'high' }]);
  assert.equal(res.status, HEALTH.DEGRADED);
  assert.match(res.reason, /only partly working/);
});

// ------------------------------------------------------------ the layers
test('unreachable is FAILED; an API error is DEGRADED', () => {
  // Different facts. "We cannot reach it at all" and "one call answered 500"
  // must not land in the same box.
  const unreachable = assessService({
    journeys: [{ name: 'Login', health: 'healthy', criticality: 'normal' }],
    layers: layers({ network: { outcome: 'bad' } }),
  });
  assert.equal(unreachable.status, HEALTH.FAILED);
  assert.equal(unreachable.parts.availability.status, HEALTH.FAILED);

  const apiBad = assessService({
    journeys: [{ name: 'Login', health: 'healthy', criticality: 'normal' }],
    layers: layers({ api: { outcome: 'bad' } }),
  });
  assert.equal(apiBad.status, HEALTH.DEGRADED);
  assert.equal(apiBad.parts.api.status, HEALTH.DEGRADED);
});

test('a layer nobody observed leaves that part UNKNOWN rather than passing it', () => {
  const res = assessService({
    journeys: [{ name: 'Login', health: 'healthy', criticality: 'normal' }],
    layers: layers({ api: { outcome: 'unknown' }, network: { outcome: 'unknown' }, server: { outcome: 'unknown' } }),
  });
  assert.equal(res.parts.api.status, HEALTH.UNKNOWN);
  assert.equal(res.parts.availability.status, HEALTH.UNKNOWN);
  assert.match(res.parts.availability.reason, /Nothing has checked/);
});

// ----------------------------------------------------------- performance
test('slow is DEGRADED, never FAILED — a slow service still works', () => {
  const slow = performanceHealth({ current_ms: 5200, baseline_ms: 1200 });
  assert.equal(slow.status, HEALTH.DEGRADED);
  assert.match(slow.reason, /4.3 times longer/);

  assert.equal(performanceHealth({ current_ms: 1300, baseline_ms: 1200 }).status, HEALTH.HEALTHY);
});

test('a timing nobody took is UNKNOWN, never instant', () => {
  // Number(null) is 0, and Number('   ') is 0. Either one read as a real
  // measurement would score an unmeasured service as infinitely fast — the
  // most flattering possible lie.
  for (const nothing of [null, undefined, '', '   ', {}, true]) {
    assert.equal(performanceHealth({ current_ms: nothing, baseline_ms: 1000 }).status, HEALTH.UNKNOWN,
      `current_ms=${JSON.stringify(nothing)}`);
    assert.equal(performanceHealth({ current_ms: 1000, baseline_ms: nothing }).status, HEALTH.UNKNOWN,
      `baseline_ms=${JSON.stringify(nothing)}`);
  }
  // A genuine zero is still a measurement, and is not thrown away with them.
  assert.equal(performanceHealth({ current_ms: 0, baseline_ms: 1000 }).status, HEALTH.HEALTHY);
});

test('no baseline means UNKNOWN, not fast', () => {
  // A first run has nothing to be compared against, and calling that healthy
  // would be a verdict on evidence nobody has.
  assert.equal(performanceHealth({ current_ms: 900 }).status, HEALTH.UNKNOWN);
  assert.equal(performanceHealth(null).status, HEALTH.UNKNOWN);
});

// -------------------------------------------------------------- repetition
test('the same failure repeating degrades a service, but never fails it on its own', () => {
  // Repetition says a problem is PERSISTENT, not how bad it is.
  const res = assessService({
    journeys: [{ name: 'Search', health: 'healthy', criticality: 'normal' }],
    layers: layers(),
    recentFailures: 8,
  });
  assert.equal(res.status, HEALTH.DEGRADED);
  assert.ok(res.reasons.some((r) => /8 times/.test(r)));
});

// ------------------------------------------------------------------ score
test('the score always comes with the parts that produced it', () => {
  // A score nobody can question is a score nobody can act on.
  const res = assessService({
    journeys: [{ name: 'Search', health: 'failed', criticality: 'normal' }],
    layers: layers(),
    performance: { current_ms: 1000, baseline_ms: 900 },
  });
  assert.ok(Number.isInteger(res.score));
  for (const part of ['functional', 'availability', 'api', 'performance']) {
    assert.ok(part in res.parts, part);
    assert.ok('reason' in res.parts[part], `${part} must say why`);
  }
  // And the weighting is published, not tuned in secret.
  assert.deepEqual(res.weights, SCORE_WEIGHTS);
});

test('an unknown part is left out of the score rather than scored zero', () => {
  // Scoring "nobody has checked performance" as zero would punish a service for
  // a check that was never run — a lie about the service.
  const everythingKnown = scoreOf({
    functional: HEALTH.HEALTHY, availability: HEALTH.HEALTHY, api: HEALTH.HEALTHY, performance: HEALTH.HEALTHY,
  });
  const performanceUnknown = scoreOf({
    functional: HEALTH.HEALTHY, availability: HEALTH.HEALTHY, api: HEALTH.HEALTHY, performance: HEALTH.UNKNOWN,
  });
  assert.equal(everythingKnown.score, 100);
  assert.equal(performanceUnknown.score, 100, 'an unmeasured part must not lower the score');
  assert.equal(performanceUnknown.parts.performance, null);

  assert.equal(scoreOf({}).score, null, 'nothing known means no score at all');
});

test('a failed critical journey drives the score down, visibly', () => {
  const res = scoreOf({
    functional: HEALTH.FAILED, availability: HEALTH.HEALTHY, api: HEALTH.HEALTHY, performance: HEALTH.HEALTHY,
  });
  assert.equal(res.parts.functional, 0);
  // 0×0.45 + 100×0.55 = 55
  assert.equal(res.score, 55);
});

// ------------------------------------------------------------ combining
test('worst() takes the worst KNOWN verdict', () => {
  assert.equal(worst([HEALTH.HEALTHY, HEALTH.DEGRADED]), HEALTH.DEGRADED);
  assert.equal(worst([HEALTH.DEGRADED, HEALTH.FAILED]), HEALTH.FAILED);
  assert.equal(worst([HEALTH.UNKNOWN, HEALTH.HEALTHY]), HEALTH.HEALTHY);
  assert.equal(worst([HEALTH.UNKNOWN, HEALTH.UNKNOWN]), HEALTH.UNKNOWN);
  assert.equal(worst([]), HEALTH.UNKNOWN);
});

// --------------------------------------------------------------- reasons
test('a status always carries the sentence that explains it', () => {
  // A verdict with no reason is exactly what V3 exists to replace.
  const healthy = assessService({
    journeys: [{ name: 'Login', health: 'healthy', criticality: 'critical' }],
    layers: layers(),
  });
  assert.equal(healthy.status, HEALTH.HEALTHY);
  assert.equal(healthy.reason, 'Everything checked is working.');

  const broken = assessService({
    journeys: [{ name: 'Login', health: 'failed', criticality: 'critical' }],
    layers: layers({ api: { outcome: 'bad' } }),
    performance: { current_ms: 9000, baseline_ms: 1000 },
  });
  // Worst thing first, and everything else still listed — an operator reading
  // one line should get the most important fact, not an arbitrary one.
  assert.match(broken.reason, /critical/);
  assert.ok(broken.reasons.length >= 3);
});

// ----------------------------------------------------------- never throws
test('junk in, an honest UNKNOWN out', () => {
  for (const junk of [null, undefined, 'nope', 42, [], { journeys: 'no' }, { layers: 'no' },
    { journeys: [null, {}, { health: 'weird' }] }]) {
    assert.doesNotThrow(() => assessService(junk), JSON.stringify(junk));
  }
  assert.equal(assessService({ journeys: [null] }).status, HEALTH.UNKNOWN);
});
