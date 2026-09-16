'use strict';

const { readFact } = require('./facts');
const { DEFAULT_LOCALE } = require('./catalog');

// Turning test results into a verdict per candidate cause.
//
// DETERMINISTIC, IN CODE. The rules are evaluated here and nowhere else — an
// LLM may help choose which playbooks to consider and may write the summary
// afterwards, but it never decides whether a cause is confirmed. A verdict is
// the one thing in this module an operator will act on without re-checking, so
// it has to come from arithmetic somebody can read.
//
// Three verdicts, and the third one carries its own reason, because "we do not
// know" has three quite different causes and they lead to different next steps:
//
//   confirmed     — a confirm rule matched.
//   ruled_out     — a rule_out rule matched.
//   inconclusive  — and then:
//       missing_data          the tests it needs have not run. Run them.
//       no_rule_matched       they ran, and none of the patterns fit. Look
//                             elsewhere; this cause is not showing its signature.
//       conflicting_evidence  something both confirmed and ruled it out. Neither
//                             claim is safe, and silently preferring one would
//                             hide that the data disagrees with itself.
//
// Pure: a playbook and a fact object in, a verdict out. No I/O, no clock.

const VERDICTS = { CONFIRMED: 'confirmed', RULED_OUT: 'ruled_out', INCONCLUSIVE: 'inconclusive' };
const REASONS = {
  MISSING: 'missing_data',
  NO_MATCH: 'no_rule_matched',
  CONFLICT: 'conflicting_evidence',
};

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

// What a fix says where a number should be but nothing measured it. A blank or a
// literal `{path_mtu.recommended_mss}` both read as a bug; this reads as the
// truth, which is that the step is right and the figure is still missing.
const UNMEASURED = { en: '(not measured yet)', da: '(ikke målt endnu)' };

const pick = (v, locale) => (v && typeof v === 'object' ? (v[locale] ?? v[DEFAULT_LOCALE]) : v);

// Renders one fix, filling {fact.path} from the measurements. `complete` says
// whether every placeholder found a number, so the UI can put the fully-grounded
// advice first without dropping the rest.
function fillFix(text, facts, locale) {
  const missing = [];
  const filled = text.replace(PLACEHOLDER_RE, (whole, path) => {
    const v = readFact(facts, path);
    if (v === undefined) { missing.push(path); return pick(UNMEASURED, locale); }
    return String(v);
  });
  return { text: filled, complete: missing.length === 0, missing };
}

// Evaluates every rule in one playbook against the facts.
function evaluatePlaybook(pb, facts, { locale = DEFAULT_LOCALE } = {}) {
  const evidence = [];
  const confirmed = [];
  const ruledOut = [];
  const missingFacts = new Set();

  for (const rule of pb.rules) {
    const { value, missing } = rule.run(facts);
    for (const m of missing) missingFacts.add(m);
    evidence.push({
      ruleId: rule.id,
      effect: rule.effect,
      when: rule.when,
      because: pick(rule.because, locale),
      // true fired, false did not, null could not be decided from what we have.
      result: value,
      missing,
    });
    if (value === true) (rule.effect === 'confirm' ? confirmed : ruledOut).push(rule.id);
  }

  let verdict;
  let reason = null;
  if (confirmed.length && ruledOut.length) {
    verdict = VERDICTS.INCONCLUSIVE;
    reason = REASONS.CONFLICT;
  } else if (confirmed.length) {
    verdict = VERDICTS.CONFIRMED;
  } else if (ruledOut.length) {
    verdict = VERDICTS.RULED_OUT;
  } else {
    verdict = VERDICTS.INCONCLUSIVE;
    // A rule that could not be decided means a test is missing. A rule that came
    // back false means the test ran and the pattern is not there. Only the first
    // is fixed by running something.
    reason = evidence.some((e) => e.result === null) ? REASONS.MISSING : REASONS.NO_MATCH;
  }

  const fixes = pb.fixes.map((f) => fillFix(pick(f, locale), facts, locale));

  return {
    playbookId: pb.id,
    title: pick(pb.title, locale),
    verdict,
    reason,
    // The rules that actually fired, so the UI can link straight to the evidence
    // instead of making the reader scan all of them. On a conflict this holds
    // both sides, which is the point: the disagreement is the finding.
    decidedBy: [...confirmed, ...ruledOut],
    evidence,
    missingFacts: [...missingFacts],
    // A cause that is ruled out does not need a repair plan, and showing one
    // invites somebody to do it anyway.
    fixes: verdict === VERDICTS.RULED_OUT ? [] : fixes,
  };
}

// Ranks the evaluated causes the way somebody works through an outage: what is
// confirmed, then what is still open, then what has been eliminated. Within a
// group the incoming order (the matcher's ranking) is preserved, so the list
// never reshuffles for reasons the reader cannot see.
const GROUP = { [VERDICTS.CONFIRMED]: 0, [VERDICTS.INCONCLUSIVE]: 1, [VERDICTS.RULED_OUT]: 2 };

function evaluateSession(playbooks, facts, { locale = DEFAULT_LOCALE } = {}) {
  const results = playbooks.map((pb, i) => ({ ...evaluatePlaybook(pb, facts, { locale }), order: i }));
  results.sort((a, b) => (GROUP[a.verdict] - GROUP[b.verdict]) || (a.order - b.order));
  const counts = {
    confirmed: results.filter((r) => r.verdict === VERDICTS.CONFIRMED).length,
    ruled_out: results.filter((r) => r.verdict === VERDICTS.RULED_OUT).length,
    inconclusive: results.filter((r) => r.verdict === VERDICTS.INCONCLUSIVE).length,
  };
  return {
    counts,
    // Every fact the rules wanted and did not get, across all the causes. This
    // is the "run these and ask me again" list, and it is the difference between
    // a dead end and a next step.
    missingFacts: [...new Set(results.flatMap((r) => r.missingFacts))],
    causes: results.map(({ order, ...r }) => r),
  };
}

module.exports = { evaluatePlaybook, evaluateSession, fillFix, VERDICTS, REASONS, UNMEASURED };
