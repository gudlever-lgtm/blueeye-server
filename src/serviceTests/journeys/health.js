'use strict';

// What a journey's state IS, computed from the tests under it (V2 §8).
//
// The product principle this file exists to serve, in the spec's own words:
// BlueEyes must not say "the website is up". It must say "the service works" —
// and when it does not, which part failed.
//
// So a journey is never just a colour. It is a verdict plus the evidence that
// produced it, and the evidence is the per-step outcomes an operator can read
// without opening anything.
//
// PURE: steps and their latest runs in, a verdict out. No database, no clock.
// Every rule below is one an operator can check against the screen.

// Ordered worst-first. `unknown` is deliberately NOT the worst: a journey nobody
// has run yet is not a failing journey, and colouring it red would train people
// to ignore red.
const STATES = ['failed', 'degraded', 'healthy', 'unknown'];

const RANK = { failed: 3, degraded: 2, healthy: 1, unknown: 0 };

// A run status, reduced to what it means for the journey above it.
//
//   pass                → the step works
//   warning             → it works, but something was off (slow, a soft
//                         assertion). Never a failure on its own
//   fail | error        → the step does not work
//   queued | running    → we do not know YET, which is not the same as
//                         "we do not know" and not the same as broken
//   skipped | (no run)  → we have never found out
function outcomeOf(run) {
  if (!run || !run.status) return 'unknown';
  switch (run.status) {
    case 'pass': return 'ok';
    case 'warning': return 'warning';
    case 'fail': case 'error': return 'broken';
    case 'queued': case 'running': return 'pending';
    default: return 'unknown';
  }
}

// The rule, stated so it can be argued with:
//
//   * a broken REQUIRED step fails the journey — the user cannot get through;
//   * a broken OPTIONAL step degrades it — part of the service is gone, the
//     journey is not. Logout failing is not Login failing, and a monitoring
//     system that cannot say so makes its own alerts worthless;
//   * a warning anywhere degrades, never fails;
//   * every step ok → healthy;
//   * nothing has ever run → unknown, and unknown is not a failure.
//
// A journey with no steps is `unknown` and says why: an empty journey is a
// statement of intent nobody has implemented, and reporting it as healthy would
// be the most misleading thing this file could do.
function journeyHealth(steps, { lang = 'en' } = {}) {
  const list = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : [];
  if (!list.length) {
    return {
      status: 'unknown',
      reason: lang === 'da' ? 'Rejsen har ingen trin endnu.' : 'This journey has no steps yet.',
      steps: [],
      counts: { ok: 0, warning: 0, broken: 0, pending: 0, unknown: 0 },
      broken_step: null,
      duration_ms: null,
    };
  }

  const counts = { ok: 0, warning: 0, broken: 0, pending: 0, unknown: 0 };
  const detail = [];
  let brokenRequired = null;
  let brokenOptional = null;
  let total = 0;
  let timed = 0;

  for (const step of list) {
    const outcome = outcomeOf(step.run);
    counts[outcome] += 1;
    const required = step.required !== false;
    if (outcome === 'broken' && required && !brokenRequired) brokenRequired = step;
    if (outcome === 'broken' && !required && !brokenOptional) brokenOptional = step;
    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a null duration
    // would count as measured and contribute nothing — the journey then looks
    // FASTER for missing data, which is the one direction this must never err in.
    const ms = step.run == null ? null : step.run.duration_ms;
    if (ms !== null && ms !== undefined && ms !== '' && Number.isFinite(Number(ms))) {
      total += Number(ms);
      timed += 1;
    }
    detail.push({
      test_id: step.test_id,
      position: step.position,
      label: step.label || (step.test && step.test.name) || null,
      required,
      outcome,
      status: (step.run && step.run.status) || null,
      duration_ms: (step.run && step.run.duration_ms) || null,
      failure_kind: (step.run && step.run.failure_kind) || null,
      error_message: (step.run && step.run.error_message) || null,
      ran_at: (step.run && (step.run.ended_at || step.run.started_at)) || null,
      run_id: (step.run && step.run.id) || null,
    });
  }

  const status = brokenRequired ? 'failed'
    : (brokenOptional || counts.warning) ? 'degraded'
      : counts.ok ? 'healthy'
        : 'unknown';

  return {
    status,
    reason: reasonFor({ status, brokenRequired, brokenOptional, counts, lang }),
    steps: detail,
    counts,
    broken_step: (brokenRequired || brokenOptional)
      ? {
        test_id: (brokenRequired || brokenOptional).test_id,
        label: (brokenRequired || brokenOptional).label
          || ((brokenRequired || brokenOptional).test && (brokenRequired || brokenOptional).test.name)
          || null,
      }
      : null,
    // The journey's duration is the sum of its steps', and ONLY when every step
    // has one. A partial sum compared against an expectation for the whole
    // journey would read as a speed-up when it is really a missing measurement.
    duration_ms: timed === list.length ? total : null,
  };
}

// One sentence saying WHY, in the words the operator would use. It reports what
// was OBSERVED — a probable cause belongs to the run that produced it, and is
// never presented here as a fact.
function reasonFor({ status, brokenRequired, brokenOptional, counts, lang }) {
  const nameOf = (s) => (s && (s.label || (s.test && s.test.name))) || (lang === 'da' ? 'et trin' : 'a step');
  if (status === 'failed') {
    return lang === 'da'
      ? `"${nameOf(brokenRequired)}" fejler, så brugeren kan ikke komme igennem.`
      : `"${nameOf(brokenRequired)}" is failing, so the user cannot get through.`;
  }
  if (status === 'degraded' && brokenOptional) {
    return lang === 'da'
      ? `"${nameOf(brokenOptional)}" fejler, men rejsen kan gennemføres.`
      : `"${nameOf(brokenOptional)}" is failing, but the journey can still be completed.`;
  }
  if (status === 'degraded') {
    return lang === 'da'
      ? `${counts.warning} trin advarer, men rejsen virker.`
      : `${counts.warning} step(s) warned, but the journey works.`;
  }
  if (status === 'healthy') return lang === 'da' ? 'Alle trin virker.' : 'Every step works.';
  return lang === 'da' ? 'Ingen trin er kørt endnu.' : 'No step has run yet.';
}

// Is this journey slower than the operator said it should be? Only when they
// said — an unstated expectation produces no verdict rather than a made-up one.
//
// The tolerance is deliberately generous: a synthetic journey drives a real
// browser over a real network, and calling 1.1x "slow" would fire constantly.
function durationVerdict(durationMs, expectedMs, { tolerance = 1.5 } = {}) {
  const actual = Number(durationMs);
  const expected = Number(expectedMs);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  const ratio = actual / expected;
  return {
    expected_ms: expected,
    duration_ms: actual,
    ratio: Math.round(ratio * 100) / 100,
    slow: ratio > tolerance,
  };
}

// Rolls many journeys up into one application-level verdict, by the same rule:
// the worst journey decides, and the counts say how widespread it is.
function applicationHealth(journeys) {
  const list = Array.isArray(journeys) ? journeys.filter(Boolean) : [];
  const counts = { failed: 0, degraded: 0, healthy: 0, unknown: 0 };
  if (!list.length) return { status: 'unknown', ...counts, total: 0 };
  let worst = 'unknown';
  for (const j of list) {
    const s = STATES.includes(j.status) ? j.status : 'unknown';
    counts[s] += 1;
    if (RANK[s] > RANK[worst]) worst = s;
  }
  return { status: worst, ...counts, total: list.length };
}

module.exports = { journeyHealth, applicationHealth, durationVerdict, outcomeOf, STATES, RANK };
