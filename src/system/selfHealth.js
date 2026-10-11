'use strict';

// "Is BlueEyes itself all right?" — the one screen that is about the monitoring
// system rather than about the network it monitors.
//
// THE RULE THIS FILE EXISTS FOR: three states, never two.
//
//   ok       we measured it and it is fine
//   failing  we measured it and it is not
//   unknown  we could not measure it, so we cannot say
//
// A two-state version of this — healthy or not — has to put "could not read"
// somewhere, and wherever it puts it is a lie. Filed as healthy, a dead probe
// reads as a working system; filed as failing, a feature nobody switched on
// pages somebody at 3am. So `unknown` is a first-class answer here, it is never
// rendered green, and every signal that returns it says WHY in one sentence.
//
// Each probe is injected as a function. That keeps this module pure (it is the
// composition and the rules, not the I/O) and lets the route hand it whatever
// the deployment actually wired — a signal with no probe is `unknown` with
// "not wired on this server", which is the honest answer for an optional
// subsystem.

const STATES = ['ok', 'failing', 'unknown'];

// Worst-first, and `failing` beats `unknown` beats `ok`. The order matters: a
// system with one dead probe and one real fault is failing, and a system with
// one dead probe and nothing else wrong is NOT ok — it is unknown, because the
// thing we cannot see might be the thing that is broken.
const RANK = { failing: 3, unknown: 2, ok: 1 };

function worst(states) {
  let out = 'ok';
  for (const s of states) {
    if ((RANK[s] || 0) > (RANK[out] || 0)) out = s;
  }
  return out;
}

// Runs one probe and never throws. A probe that rejects IS the unknown case —
// that is the whole point of the state — so it is translated rather than
// propagated.
async function probe(id, fn, { optional = false } = {}) {
  if (typeof fn !== 'function') {
    return {
      id,
      state: 'unknown',
      reason: optional ? 'not_enabled' : 'not_wired',
      detail: optional
        ? 'This subsystem is not switched on here, so there is nothing to report.'
        : 'This server did not wire a probe for this signal.',
    };
  }
  try {
    const res = await fn();
    if (!res || !STATES.includes(res.state)) {
      return { id, state: 'unknown', reason: 'bad_probe', detail: 'The probe answered with something this screen cannot read.' };
    }
    return { id, ...res };
  } catch (err) {
    return {
      id,
      state: 'unknown',
      reason: 'probe_failed',
      detail: `Could not read it: ${(err && err.message) || 'unknown error'}`,
    };
  }
}

// The signals, in the order they are shown. `optional` marks a subsystem whose
// absence is a deployment choice rather than a fault — Service Assurance and
// the telemetry store are off by default, and a screen that shouts about them
// teaches people to ignore it.
const SIGNALS = [
  { id: 'database', optional: false },
  { id: 'telemetry', optional: true },
  { id: 'license', optional: false },
  { id: 'signing', optional: false },
  { id: 'trustKeys', optional: false },
  { id: 'agents', optional: false },
  { id: 'ingest', optional: false },
  { id: 'commandQueue', optional: false },
  { id: 'assuranceWorkers', optional: true },
  { id: 'backgroundJobs', optional: false },
  { id: 'storage', optional: false },
];

// Builds the whole answer. `probes` is { [signalId]: () => Promise<{state, reason?, detail?, ...}> }.
//
// Every probe runs, every time, in parallel: a screen that stops at the first
// failure tells you about one thing when you came to find out about eleven.
async function buildSelfHealth({ probes = {}, now = () => new Date() } = {}) {
  const signals = await Promise.all(
    SIGNALS.map((s) => probe(s.id, probes[s.id], { optional: s.optional }))
  );
  const counts = { ok: 0, failing: 0, unknown: 0 };
  for (const s of signals) counts[s.state] += 1;
  return {
    checkedAt: now().toISOString(),
    // The overall state is the worst one present, and `unknown` is not rounded
    // down to ok. "Eight ok, three unknown" is not a healthy system; it is a
    // system we can only partly see, and the number says so.
    state: worst(signals.map((s) => s.state)),
    counts,
    signals,
  };
}

module.exports = { buildSelfHealth, worst, SIGNALS, STATES, RANK };
