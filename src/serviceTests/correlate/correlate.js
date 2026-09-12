'use strict';

const { LAYERS, KIND } = require('../observe/observations');

// The correlation engine (V3 Phase 1, docs/service-assurance-v3.md).
//
// Observations are facts. Correlation relates them into a picture:
//
//     Customer Search FAILED
//       → POST /api/customer/search
//       → HTTP 500
//       → Network OK
//       → Server reachable
//       → API failure repeated
//       → Likely application/API issue
//
// PURE: observations in, a correlation out. No database, no clock, no network.
//
// The design problem, and the thing this module is really about:
//
//   CONFIDENCE MUST COME FROM WHAT WAS RULED OUT.
//
// "It is the API, 92% confident" is only honest if something actually looked at
// the network and the server and found them fine. If nothing checked the
// network, the API is merely the layer we happened to observe — and saying 92%
// would be inventing certainty out of ignorance. So every layer nobody looked at
// LOWERS confidence, by name, and the result says which ones they were.
//
// Three rules:
//
//   1. A conclusion is an ASSESSMENT, never a fact. It says "likely", it carries
//      its confidence, and it always shows the evidence underneath.
//   2. Nothing is concluded from nothing. No failing observation means no
//      correlation — not a cheerful "everything is fine", and not a guess.
//   3. Confidence never reaches 100. A rule-based inference over a sample is
//      never certain, and a number that says it is would be the one thing on
//      the screen nobody should trust.

// The layers that can be RULED OUT, in the order a person checks them —
// outward-in, cheapest first. This order is also the order the chain is
// printed in, because it is how somebody actually reasons about an outage.
const DIAGNOSTIC_ORDER = ['network', 'infrastructure', 'server', 'api', 'page', 'application', 'browser'];

// What a bad layer means, in the operator's words. Correlation names a LAYER;
// ranking specific causes within one (DNS vs firewall vs TLS) is root cause
// analysis, which is Phase 2 and reads this.
const LAYER_CONCLUSION = {
  network: 'a network problem',
  infrastructure: 'an infrastructure problem',
  server: 'the server being unreachable',
  api: 'an application or API problem',
  page: 'a problem in the page itself',
  application: 'an application problem',
  browser: 'a problem in the browser or the test itself',
};

// Confidence arithmetic, published rather than tuned in secret. Every number
// here is arguable, which is the point — a confidence nobody can question is
// worth no more than no confidence at all.
const CONFIDENCE = {
  // A failing layer, observed directly. The floor for any conclusion.
  BASE: 45,
  // Each layer checked and found healthy. This is the real evidence: ruling
  // things out is what turns "the API failed" into "it is the API".
  PER_RULED_OUT: 12,
  // Each layer nobody looked at. Not a penalty for being wrong — a statement
  // that the picture is incomplete.
  PER_NOT_CHECKED: 8,
  // The same failure, again. Repetition separates a real fault from a blip.
  REPEATED: 10,
  // Neighbours of the failing thing still working. One endpoint failing while
  // the others answer narrows the fault considerably.
  NEIGHBOURS_HEALTHY: 10,
  // More than one layer failing at once. The picture is genuinely ambiguous and
  // the confidence should say so rather than picking the first one.
  MULTIPLE_BAD: 15,
  // Never certain. A rule-based inference over a sample is not a fact.
  CEILING: 92,
  FLOOR: 20,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const conclusionLayerIs = (layer, causeLayers) => causeLayers[0] === layer;

// A link in the chain: one observation, stated as what it showed.
function link(step, { layer = null, outcome = 'unknown', detail = null } = {}) {
  return { step, layer, outcome, detail };
}

// Groups observations by layer, keeping what each one said.
function byLayer(observations) {
  const out = {};
  for (const layer of LAYERS) out[layer] = { ok: [], bad: [], unknown: [] };
  for (const o of Array.isArray(observations) ? observations : []) {
    const bucket = out[o && o.layer];
    if (!bucket) continue;
    (bucket[o.outcome] || bucket.unknown).push(o);
  }
  return out;
}

// What actually broke, from the user's point of view.
//
// A failing STEP beats a failing run: "Search failed" is what the operator needs
// to hear, and "the test failed" is what they already know.
function primaryFailure(observations) {
  // Filtered rather than trusted. Correlation is fed from a database and from
  // other modules, and one null in the list must not take the analysis down —
  // an operator looking at an outage is the worst possible moment for the page
  // that explains it to go blank.
  const list = (Array.isArray(observations) ? observations : [])
    .filter((o) => o && typeof o === 'object');
  const step = list.find((o) => o.kind === KIND.STEP_OUTCOME && o.outcome === 'bad');
  if (step) return step;
  return list.find((o) => o.kind === KIND.RUN_OUTCOME && o.outcome === 'bad') || null;
}

// The technical observation that best explains the failure.
//
// Preference order is deliberate: an API answering 500 explains a broken journey
// far better than a console error does, and a request that never completed
// explains it better still — it means nothing answered at all.
function explainingObservation(grouped) {
  const network = grouped.network.bad[0];
  if (network) return network;
  const api = grouped.api.bad
    .slice()
    // The worst status first: a 503 is a better explanation than a 404, which
    // might just be a page that legitimately does not exist.
    .sort((a, b) => ((b.detail && b.detail.status) || 0) - ((a.detail && a.detail.status) || 0))[0];
  if (api) return api;
  return grouped.page.bad[0] || grouped.server.bad[0] || grouped.infrastructure.bad[0] || null;
}

// What a successful request PROVES about the layers underneath it.
//
// A browser test never probes the network or the server directly — it drives a
// page. But an HTTP 200 from anywhere is real evidence, not an assumption: the
// name resolved, the network carried the request, and something answered. That
// is exactly how a person reasons about an outage ("other calls are fine, so it
// is not the network"), and refusing to make the inference would leave every
// correlation saying "network not checked" forever, which is useless.
//
// It is labelled as an INFERENCE in the chain rather than presented as a probe.
// The difference matters: "the network was checked" and "the network must be
// working because something answered" are different claims, and only one of
// them is true here.
function inferReachability(grouped) {
  const out = {};
  const answered = grouped.api.ok.concat(grouped.page.ok, grouped.browser.ok)
    .filter((o) => o.kind === KIND.API_CALL || o.kind === KIND.RUN_OUTCOME);
  if (!answered.length) return out;
  const example = answered.find((o) => o.subject) || answered[0];
  const because = example.subject
    ? `network reachable — ${example.subject} answered`
    : 'network reachable — the page loaded';
  // Only where nothing observed the layer directly. A real observation always
  // wins over an inference drawn from a neighbouring one.
  if (!grouped.network.ok.length && !grouped.network.bad.length) out.network = because;
  if (!grouped.server.ok.length && !grouped.server.bad.length) {
    out.server = example.subject
      ? `a server answered — ${example.subject} returned a response`
      : 'a server answered';
  }
  return out;
}

// Correlates one run's observations, with optional recent history.
//
//   correlate({ observations, history: { sameFailureCount, window } })
//
// Returns null when there is nothing to correlate. A correlation that reports
// "everything is fine" is noise; silence is the honest answer when nothing
// failed.
function correlate(rawInput = {}) {
  // A default parameter only covers `undefined`. Null, a string and a number all
  // reach here otherwise — and correlation runs on a dashboard, where throwing
  // takes the page down instead of the analysis.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const { observations = [], history = null } = input;
  const list = (Array.isArray(observations) ? observations : []).filter((o) => o && typeof o === 'object');
  const failure = primaryFailure(list);
  // Rule 2: nothing is concluded from nothing.
  if (!failure) return null;

  const grouped = byLayer(list);
  const inferred = inferReachability(grouped);
  const bad = DIAGNOSTIC_ORDER.filter((l) => grouped[l].bad.length);
  const ruledOut = DIAGNOSTIC_ORDER.filter((l) => !grouped[l].bad.length
    && (grouped[l].ok.length || inferred[l]));
  const notChecked = DIAGNOSTIC_ORDER.filter((l) => !grouped[l].bad.length
    && !grouped[l].ok.length && !inferred[l]);

  // The technical layers only — a failing browser step is the SYMPTOM, and
  // concluding "the browser is at fault" because the test failed would be
  // circular.
  const causeLayers = bad.filter((l) => l !== 'browser');
  const explaining = explainingObservation(grouped);

  const chain = [];
  chain.push(link(failure.summary || `${failure.subject || 'A step'} failed`, {
    layer: failure.layer, outcome: 'bad',
  }));
  if (explaining && explaining !== failure) {
    chain.push(link(explaining.summary || explaining.subject || 'A technical failure was observed', {
      layer: explaining.layer, outcome: 'bad', detail: explaining.detail || null,
    }));
  }
  // What was checked and found fine. This is the part that makes the
  // conclusion worth anything, so it is IN the chain rather than a footnote —
  // and an INFERRED clearance says it was inferred, so nobody reads it as a
  // probe that never happened.
  for (const layer of ruledOut) {
    chain.push(link(inferred[layer] || `${layer} looked healthy`, { layer, outcome: 'ok' }));
  }
  // And what nobody looked at, said out loud. An operator reading the chain
  // should be able to see the hole in it.
  for (const layer of notChecked) {
    chain.push(link(`${layer} was not checked`, { layer, outcome: 'unknown' }));
  }

  const repeated = Number(history && typeof history === 'object' ? history.sameFailureCount : 0) || 0;
  if (repeated >= 2) {
    chain.push(link(`the same failure has happened ${repeated} times`, { layer: null, outcome: 'bad' }));
  }

  // ---- confidence, built from the evidence and shown as arithmetic ----
  const contributions = [];
  let confidence = 0;
  if (causeLayers.length) {
    confidence += CONFIDENCE.BASE;
    contributions.push({ reason: `${causeLayers[0]} failed, and it was observed directly`, points: CONFIDENCE.BASE });
  }
  if (ruledOut.length) {
    const points = ruledOut.length * CONFIDENCE.PER_RULED_OUT;
    confidence += points;
    // Observed and inferred are said differently. "The network was checked" and
    // "the network must be working because something answered" are different
    // claims, and only one of them is true when nothing probed the network.
    const observed = ruledOut.filter((l) => !inferred[l]);
    const deduced = ruledOut.filter((l) => inferred[l]);
    const parts = [];
    if (observed.length) parts.push(`${observed.join(', ')} ${observed.length === 1 ? 'was' : 'were'} checked and looked healthy`);
    if (deduced.length) parts.push(`${deduced.join(', ')} must be working, because other requests answered`);
    contributions.push({ reason: parts.join('; '), points });
  }
  // The spec's "other APIs healthy". One endpoint failing while its neighbours
  // answer is a much narrower fault than the whole tier being down, and it is
  // the difference between "the API is broken" and "this endpoint is broken".
  if (conclusionLayerIs('api', causeLayers) && grouped.api.ok.length) {
    confidence += CONFIDENCE.NEIGHBOURS_HEALTHY;
    contributions.push({
      reason: `${grouped.api.ok.length} other API call${grouped.api.ok.length === 1 ? '' : 's'} answered normally`,
      points: CONFIDENCE.NEIGHBOURS_HEALTHY,
    });
  }
  if (repeated >= 2) {
    confidence += CONFIDENCE.REPEATED;
    contributions.push({ reason: `the same failure happened ${repeated} times`, points: CONFIDENCE.REPEATED });
  }
  if (notChecked.length) {
    const points = -(notChecked.length * CONFIDENCE.PER_NOT_CHECKED);
    confidence += points;
    contributions.push({ reason: `${notChecked.join(', ')} ${notChecked.length === 1 ? 'was' : 'were'} not checked`, points });
  }
  if (causeLayers.length > 1) {
    confidence -= CONFIDENCE.MULTIPLE_BAD;
    contributions.push({
      reason: `${causeLayers.join(' and ')} both failed, so the picture is ambiguous`,
      points: -CONFIDENCE.MULTIPLE_BAD,
    });
  }

  // No technical layer failed at all: the journey broke and nothing underneath
  // explains it. That is a real and common answer — a missing element, a changed
  // page, a test that needs updating — and inventing a cause would be worse than
  // saying so.
  const conclusionLayer = causeLayers[0] || null;
  const conclusion = conclusionLayer
    ? `Likely ${LAYER_CONCLUSION[conclusionLayer] || `a problem in ${conclusionLayer}`}`
    : 'The journey failed, but nothing underneath it reported a problem';

  return {
    // Correlation names a LAYER. Ranking specific causes within it — DNS versus
    // firewall versus TLS — is root cause analysis, which reads this.
    layer: conclusionLayer,
    conclusion,
    // Rule 3: never certain, and never zero either — a conclusion with no
    // confidence at all should not have been drawn.
    confidence: causeLayers.length
      ? clamp(Math.round(confidence), CONFIDENCE.FLOOR, CONFIDENCE.CEILING)
      : null,
    // The arithmetic, itemised. "Why 68%?" must always have an answer.
    confidence_from: contributions,
    chain,
    failed: bad,
    ruled_out: ruledOut,
    not_checked: notChecked,
    // What the conclusion is about, so impact assessment does not have to
    // re-derive it.
    subject: (explaining && explaining.subject) || failure.subject || null,
    // The evidence, so a reader can check the conclusion rather than trust it.
    evidence: list
      .filter((o) => o.outcome !== 'unknown')
      .slice(0, 50)
      .map((o) => ({ layer: o.layer, kind: o.kind, subject: o.subject, outcome: o.outcome, summary: o.summary })),
    observed_at: failure.observed_at || null,
    // Rules, not a model. When AI later offers a second opinion it arrives as a
    // different source, and the two are never confused on screen.
    source: 'rules',
  };
}

// One sentence for the screen.
//
// The hedge is not politeness. A conclusion presented as a fact is one nobody
// checks, and the whole feature is that the evidence stays visible.
function describeCorrelation(result) {
  if (!result) return null;
  if (!result.layer) return result.conclusion;
  const holes = result.not_checked.length
    ? ` ${result.not_checked.join(', ')} ${result.not_checked.length === 1 ? 'was' : 'were'} not checked.`
    : '';
  return `${result.conclusion} (${result.confidence}% confident).${holes}`;
}

module.exports = {
  correlate, describeCorrelation, primaryFailure, byLayer,
  CONFIDENCE, DIAGNOSTIC_ORDER, LAYER_CONCLUSION,
};
