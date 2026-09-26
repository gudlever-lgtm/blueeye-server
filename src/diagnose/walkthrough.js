'use strict';

const { DEFAULT_LOCALE } = require('./catalog');

// The guided walk-through: a diagnosis session read back as ONE ORDERED LIST of
// steps, one at a time, each with what to do, why, what it showed and what that
// means for the next one.
//
// WHY THIS EXISTS. A plan is a good answer to "what should I look at" and a bad
// answer to "what do I do now". It hands a technician four causes, nine tests
// and a page of views all at once, and the person who most needs it — the one
// who does not already know which measurement settles which question — is
// exactly the person who cannot order them. So they run everything, read
// everything, and are no closer to a verdict than when they started.
//
// The troubleshooting that actually works is a sequence where each step either
// eliminates something or points at the next step. That sequence is already
// implied by the catalogue; this module makes it explicit.
//
// THE ORDER IS CHEAP-AND-DECISIVE FIRST, and it is a fixed rank by probe type
// rather than the order the playbooks happen to list their tests in:
//
//   1. does anything answer at all        ping, dhcp
//   2. is the port open, does the name resolve   tcp, dns, rdns, tls
//   3. where on the path                  traceroute, tcptraceroute, path_mtu
//   4. does the application answer        http, curl, pageload, transaction
//
// That is the order a network engineer works in, and the reason is not taste:
// step 4 failing means nothing until step 1 has passed, while step 1 failing
// makes steps 2-4 a waste of everybody's afternoon. The forward direction goes
// before the reverse one at the same rank, because "A cannot reach B" is worth
// knowing before "B cannot reach A".
//
// WHAT EACH STEP SAYS AFTERWARDS. Once the results are in, a measure step
// carries the rules its measurement made decidable — with the playbook's own
// sentence for each — so the reader sees "this rule fired, and here is what
// that means" rather than a number they have to interpret. A step whose rules
// all came back false is progress too, and it says so: something has been
// eliminated.
//
// PURE. Session, tests, evaluation in; steps out. No database, no clock, no
// network — the route reads and this arranges. Every sentence that is not the
// catalogue's own belongs to the UI (public/i18n.js), so this returns the
// structure and the localized playbook text and never a hardcoded English
// string.

// Probe types in the order a diagnosis should walk them. Anything not listed
// sorts after everything listed, keeping its relative order — a probe type
// added to the catalogue tomorrow lands at the end rather than at random.
const PROBE_ORDER = [
  'ping', 'dhcp',
  'dns', 'rdns', 'tcp', 'tls',
  'traceroute', 'tcptraceroute', 'path_mtu',
  'http', 'curl', 'pageload', 'transaction',
];

const STEP = {
  MEASURE: 'measure',   // run a probe
  BLOCKED: 'blocked',   // a test the plan wanted and could not schedule
  LOOK: 'look',         // open a view and read something off it
  DECIDE: 'decide',     // the verdict
  FIX: 'fix',           // what to change
};

const STATUS = {
  DONE: 'done',
  CURRENT: 'current',
  PENDING: 'pending',
  WAITING: 'waiting',   // dispatched, no result yet
  FAILED: 'failed',
  BLOCKED: 'blocked',
};

// What a finished measure step turned out to be.
const OUTCOME = {
  SIGNAL: 'signal',     // a rule fired on it — this is the step that found something
  CLEAR: 'clear',       // its rules ran and none fired: something is eliminated
  UNREAD: 'unread',     // it ran, and no rule in this plan reads it
  WAITING: 'waiting',
  FAILED: 'failed',
};

const pick = (v, locale) => (v && typeof v === 'object' && !Array.isArray(v)
  ? (v[locale] ?? v[DEFAULT_LOCALE] ?? null)
  : (v ?? null));

const rank = (probeType) => {
  const i = PROBE_ORDER.indexOf(String(probeType || ''));
  return i === -1 ? PROBE_ORDER.length : i;
};

// Does this rule read THIS probe's measurements? Rule expressions address facts
// by a dotted path whose first segment is the probe type (`ping.size_64.loss_pct`),
// with the far end under `reverse.` (`reverse.ping.loss_pct`). Matching the root
// token is what lets a step say which rules it just made decidable.
//
// Anchored on a word boundary and a dot, so `ping` never matches `pingback` and
// `tcp` never matches `tcptraceroute`.
function rulesReading(evidence, probeType, direction) {
  const type = String(probeType || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = direction === 'reverse'
    ? new RegExp(`\\breverse\\.${type}\\.`)
    : new RegExp(`(?<!reverse\\.)\\b${type}\\.`);
  return (evidence || []).filter((e) => e && typeof e.when === 'string' && re.test(e.when));
}

// The test rows for one plan entry. A plan test and a stored row are matched on
// what makes them the same test — direction, probe type and target — because
// the plan's `index` is not stored on the row.
function rowsFor(planTest, tests) {
  return (tests || []).filter((r) => r
    && r.probeType === planTest.probeType
    && r.direction === planTest.direction
    && String(r.target ?? '') === String(planTest.target ?? ''));
}

function measureStatus(rows) {
  if (!rows.length) return STATUS.PENDING;
  if (rows.some((r) => r.status === 'failed')) return STATUS.FAILED;
  if (rows.every((r) => r.probeResultId != null)) return STATUS.DONE;
  if (rows.some((r) => r.dispatchedAt)) return STATUS.WAITING;
  return STATUS.PENDING;
}

// Builds the walk-through.
//
//   buildWalkthrough({ session, tests, evaluation, locale }) -> {
//     steps, total, position, done, verdict, stalled
//   }
//
// `position` is the step the reader should be on — the first one not finished.
// `stalled` is true when that step cannot move without the reader doing
// something outside this screen (a blocked test, an agent that is not
// connected), which is the state a walk-through has to be honest about rather
// than showing a spinner forever.
function buildWalkthrough({ session = null, tests = [], evaluation = null, locale = DEFAULT_LOCALE } = {}) {
  const plan = (session && session.plan) || {};
  const planTests = Array.isArray(plan.tests) ? plan.tests : [];
  const causes = Array.isArray(plan.causes) ? plan.causes : [];
  const evaluated = (evaluation && Array.isArray(evaluation.causes)) ? evaluation.causes : [];
  const evalById = new Map(evaluated.map((c) => [c.playbookId, c]));
  const allEvidence = evaluated.flatMap((c) => (c.evidence || []).map((e) => ({ ...e, playbookId: c.playbookId })));

  const steps = [];

  // ---- 1. the measurements, cheapest and most decisive first ---------------
  const ordered = planTests
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.probeType) - rank(b.t.probeType)
      || (a.t.direction === b.t.direction ? 0 : (a.t.direction === 'reverse' ? 1 : -1))
      || (a.i - b.i));

  for (const { t } of ordered) {
    const rows = rowsFor(t, tests);
    const status = measureStatus(rows);
    const reading = status === STATUS.DONE ? rulesReading(allEvidence, t.probeType, t.direction) : [];
    const fired = reading.filter((e) => e.result === true);
    const decided = reading.filter((e) => e.result !== null);

    let outcome = OUTCOME.WAITING;
    if (status === STATUS.FAILED) outcome = OUTCOME.FAILED;
    else if (status === STATUS.DONE) {
      if (fired.length) outcome = OUTCOME.SIGNAL;
      else if (decided.length) outcome = OUTCOME.CLEAR;
      else outcome = OUTCOME.UNREAD;
    }

    steps.push({
      kind: STEP.MEASURE,
      status,
      probeType: t.probeType,
      direction: t.direction,
      target: t.target,
      params: t.params || {},
      agentId: t.agentId ?? null,
      // The catalogue's own sentence for why this test is in the plan.
      why: pick(t.why, locale),
      testIds: rows.map((r) => r.id),
      causeIds: t.askedBy || [],
      outcome,
      // Only the rules this measurement actually decided, each with the
      // playbook's sentence — so the step says what it FOUND, not what it
      // measured. A rule still undecided is left out: it is the next step's.
      decided: decided.map((e) => ({
        ruleId: e.ruleId, playbookId: e.playbookId, effect: e.effect,
        because: e.because, result: e.result,
      })),
      // Why the run failed, when it did: an agent that is not connected, an
      // invalid spec. The reader can act on that; a silent failed step is the
      // one thing worse than no step.
      detail: rows.map((r) => r.detail).find((d) => d) || null,
    });
  }

  // ---- 2. the tests the plan deliberately could not schedule ---------------
  for (const s of Array.isArray(plan.skipped) ? plan.skipped : []) {
    steps.push({
      kind: STEP.BLOCKED,
      status: STATUS.BLOCKED,
      probeType: s.probeType,
      direction: s.direction,
      target: null,
      agentId: s.agentId ?? null,
      causeIds: s.playbookId ? [s.playbookId] : [],
      // The plan's own reason, already a sentence.
      why: pick(s.reason, locale),
      testIds: [],
      outcome: null,
      decided: [],
      detail: null,
    });
  }

  // ---- 3. the screens worth reading, once the numbers exist ---------------
  // A view step is only useful after its cause's measurements are in: sending
  // somebody to read a screen that has nothing on it yet is how a walk-through
  // loses the reader.
  // They are appended AFTER every measure step, so the reader reaches one only
  // once the measurements above it are finished — the ordering does the work,
  // and no view step needs a readiness flag of its own.
  const seenViews = new Set();
  for (const c of causes) {
    const verdict = evalById.get(c.id);
    // A cause the evidence has ruled out does not need its screens read.
    if (verdict && verdict.verdict === 'ruled_out') continue;
    for (const v of Array.isArray(c.views) ? c.views : []) {
      const key = `${v.view}|${JSON.stringify(v.params || {})}`;
      if (seenViews.has(key)) continue;
      seenViews.add(key);
      steps.push({
        kind: STEP.LOOK,
        status: STATUS.PENDING,
        view: { view: v.view, params: v.params || {} },
        // What to look for, in the catalogue's words.
        why: pick(v.look_for ?? v.lookFor, locale),
        causeIds: [c.id],
        testIds: [],
        outcome: null,
        decided: [],
        detail: null,
      });
    }
  }

  // ---- 4. the verdict -----------------------------------------------------
  const confirmed = evaluated.filter((c) => c.verdict === 'confirmed');
  const open = evaluated.filter((c) => c.verdict === 'inconclusive');
  steps.push({
    kind: STEP.DECIDE,
    status: evaluated.length ? STATUS.DONE : STATUS.PENDING,
    causeIds: evaluated.map((c) => c.playbookId),
    verdict: evaluated.length
      ? {
        confirmed: confirmed.map((c) => ({ playbookId: c.playbookId, title: c.title, decidedBy: c.decidedBy })),
        open: open.map((c) => ({ playbookId: c.playbookId, title: c.title, reason: c.reason })),
        ruledOut: evaluated.filter((c) => c.verdict === 'ruled_out').map((c) => ({ playbookId: c.playbookId, title: c.title })),
        // What the rules wanted and never got. This is the "run these and ask
        // again" list, and it is the difference between a dead end and a next
        // step.
        missingFacts: (evaluation && evaluation.missingFacts) || [],
      }
      : null,
    why: null,
    testIds: [],
    outcome: null,
    decided: [],
    detail: null,
  });

  // ---- 5. what to change --------------------------------------------------
  // Only for a CONFIRMED cause. A fix offered for a cause nothing confirmed is
  // an invitation to change a setting on a network that did not have that
  // problem — and the change will be blamed for the next unrelated fault.
  for (const c of confirmed) {
    for (const f of Array.isArray(c.fixes) ? c.fixes : []) {
      steps.push({
        kind: STEP.FIX,
        status: STATUS.PENDING,
        causeIds: [c.playbookId],
        // `complete` says every {placeholder} found a measurement. The UI puts
        // the fully-grounded advice first; the rest is still right, it just
        // still has a number missing.
        fix: { text: f.text, complete: f.complete !== false },
        why: null,
        testIds: [],
        outcome: null,
        decided: [],
        detail: null,
      });
    }
  }

  const numbered = steps.map((s, i) => ({ n: i + 1, id: `${s.kind}-${i + 1}`, ...s }));
  const firstOpen = numbered.find((s) => s.status !== STATUS.DONE);
  const position = firstOpen ? firstOpen.n : numbered.length;
  for (const s of numbered) if (s.n === position && s.status === STATUS.PENDING) s.status = STATUS.CURRENT;

  return {
    steps: numbered,
    total: numbered.length,
    position,
    done: numbered.filter((s) => s.status === STATUS.DONE).length,
    // Nothing more will happen here on its own. Either a step needs the reader
    // to go and do something, or a dispatched test failed.
    stalled: Boolean(firstOpen && (firstOpen.status === STATUS.BLOCKED || firstOpen.status === STATUS.FAILED)),
    verdict: evaluated.length ? { confirmed: confirmed.length, open: open.length, total: evaluated.length } : null,
  };
}

module.exports = { buildWalkthrough, PROBE_ORDER, STEP, STATUS, OUTCOME };
