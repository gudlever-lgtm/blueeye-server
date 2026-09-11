'use strict';

const { normalizeTarget, describeTarget } = require('./targeting');
const { TARGET_STRATEGIES } = require('./dsl');

// Self-healing selectors (V2 §5, P2 #7).
//
//     Original:   #login-button
//     Suggested:  button "Log ind"
//
// When a step's target no longer resolves, BlueEyes looks at what IS on the page
// and proposes the element it thinks the operator meant. It does NOT repoint the
// test. The spec is explicit and so is this file: *testen må ikke ændres
// automatisk uden brugerens accept*.
//
// That rule is not bureaucracy. A wrong heal is the worst outcome this module
// can produce: the test goes green while the service is broken, and nobody
// looks again. A missed heal only costs somebody five minutes in the designer.
// So everything below is biased towards proposing NOTHING rather than proposing
// something plausible-but-wrong.
//
// PURE: the original target and a list of observed candidates in, a proposal
// out. No DOM, no database. The browser side only OBSERVES (driver.js collects
// candidates); every judgement about what an observation means is made here,
// where it can be argued with in a test.

// What each matching hint is worth. The order is the spec's priority order —
// role, label, text, placeholder, name, id, css — and the weights say the same
// thing in numbers: a role+name match is what a human would call "the same
// button", while a matching id on its own is the weakest evidence there is,
// because an id is exactly what tends to change.
const WEIGHTS = {
  role: 3,
  label: 4,
  text: 3,
  placeholder: 3,
  name: 3,
  id: 1,
  css: 0, // never evidence: a CSS path matching is what just failed
};

// `name` qualifies `role` rather than standing alone (see targeting.js), so an
// accessible-name match is scored separately and weighted like a label: it is
// the words a person reads off the screen.
const NAME_WEIGHT = 4;

// Below this, nothing is proposed. Two independent hints, or one strong one
// plus a role, are the minimum — a lone id or a lone fuzzy text match is not
// enough to point a test at a different element.
const MIN_SCORE = 5;

// The gap the best candidate must have over the runner-up. Two elements that
// score the same are two elements BlueEyes cannot tell apart, and guessing
// between them is exactly the wrong-heal case.
const MIN_MARGIN = 2;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// How well two pieces of text match, 0..1. Deliberately crude and explainable:
// exact, then one containing the other, then nothing. No edit distance — a
// similarity score an operator cannot reproduce in their head is a score they
// cannot judge.
function textMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Containment only counts when the shorter side is substantial. "a" appearing
  // inside "Save and close" is not evidence of anything.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 3 && long.includes(short)) return 0.6;
  return 0;
}

// Scores one candidate against the original target, and says WHY in the words
// the operator will read.
//
//   { score, reasons: ['the button is still called "Log ind"', …] }
function scoreCandidate(target, candidate, { lang = 'en' } = {}) {
  const want = normalizeTarget(target) || {};
  const have = normalizeTarget(candidate) || {};
  let score = 0;
  const reasons = [];

  // Role first: it says what KIND of thing this is, and a button that became a
  // link is usually not the element the step meant.
  if (want.role && have.role && norm(want.role) === norm(have.role)) {
    score += WEIGHTS.role;
    reasons.push(lang === 'da' ? `samme type (${have.role})` : `same kind of element (${have.role})`);
  } else if (want.role && have.role) {
    // Not a disqualifier — an application can legitimately turn a link into a
    // button — but it is evidence against, and must not be free.
    score -= 2;
  }

  // The accessible name, but ONLY when a role is present — that is the exact
  // rule strategiesFor() uses, and mirroring it is what keeps `name` from being
  // counted twice. Without a role, `name` is the HTML attribute and the loop
  // below owns it.
  if (want.role && want.name && have.name) {
    const m = textMatch(want.name, have.name);
    if (m) {
      score += Math.round(NAME_WEIGHT * m);
      reasons.push(lang === 'da' ? `hedder stadig "${have.name}"` : `still called "${have.name}"`);
    }
  }

  for (const key of TARGET_STRATEGIES) {
    if (key === 'role' || key === 'css') continue;
    // `name` is ambiguous — the HTML attribute AND the accessible name that
    // qualifies a role (see targeting.js). When a role is present it was already
    // consumed above, and scoring it again both inflates the total and prints
    // the same evidence twice as if it were two independent facts.
    if (key === 'name' && want.role) continue;
    if (!want[key] || !have[key]) continue;
    const m = textMatch(want[key], have[key]);
    if (!m) continue;
    score += Math.round(WEIGHTS[key] * m);
    reasons.push(reasonFor(key, have[key], m, lang));
  }

  return { score, reasons };
}

function reasonFor(key, value, match, lang) {
  const exact = match === 1;
  const q = `"${value}"`;
  if (lang === 'da') {
    const map = {
      label: exact ? `samme feltnavn ${q}` : `feltnavnet ligner ${q}`,
      text: exact ? `samme tekst ${q}` : `teksten ligner ${q}`,
      placeholder: exact ? `samme pladsholder ${q}` : `pladsholderen ligner ${q}`,
      name: exact ? `samme name-attribut ${q}` : `name-attributten ligner ${q}`,
      id: exact ? `samme id ${q}` : `id'et ligner ${q}`,
    };
    return map[key] || `${key} ${q}`;
  }
  const map = {
    label: exact ? `same field label ${q}` : `a similar field label ${q}`,
    text: exact ? `same visible text ${q}` : `similar visible text ${q}`,
    placeholder: exact ? `same placeholder ${q}` : `a similar placeholder ${q}`,
    name: exact ? `same name attribute ${q}` : `a similar name attribute ${q}`,
    id: exact ? `same id ${q}` : `a similar id ${q}`,
  };
  return map[key] || `${key} ${q}`;
}

// The heal a step's target should be repointed at — or null, which is the
// answer far more often than not and is the right one whenever BlueEyes cannot
// be sure.
//
//   proposeHealing(originalTarget, candidates) -> {
//     target, confidence, reason, score, runner_up, original
//   } | null
//
// `candidates` are the elements the driver observed on the page when the step
// failed, in the same hint-bag shape a target has.
function proposeHealing(target, candidates, { lang = 'en', minScore = MIN_SCORE, minMargin = MIN_MARGIN } = {}) {
  const want = normalizeTarget(target);
  if (!want) return null;
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && typeof c === 'object');
  if (!list.length) return null;

  const scored = list
    .map((candidate) => ({ candidate, ...scoreCandidate(target, candidate, { lang }) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const best = scored[0];
  const runnerUp = scored[1] || null;

  // Not good enough on its own merits.
  if (best.score < minScore) return null;
  // Or good, but not distinguishably better than the next one. Two elements
  // BlueEyes cannot tell apart is precisely when a wrong heal happens.
  if (runnerUp && best.score - runnerUp.score < minMargin) return null;

  const proposed = normalizeTarget(best.candidate);
  if (!proposed) return null;
  // A "heal" that proposes what the step already says is not a heal — the
  // element did not resolve for some other reason (timing, a hidden ancestor),
  // and repointing it at itself would hide that.
  if (JSON.stringify(proposed) === JSON.stringify(want)) return null;

  return {
    original: want,
    target: proposed,
    score: best.score,
    confidence: confidenceFor(best.score, runnerUp),
    // Always in the operator's words, always saying what was looked for and what
    // was found — a proposal they cannot check is a proposal they should not
    // accept.
    reason: reasonSentence(want, proposed, best.reasons, lang),
    runner_up: runnerUp ? { target: normalizeTarget(runnerUp.candidate), score: runnerUp.score } : null,
  };
}

// The sentence the operator reads before deciding.
//
// When the two describe identically — the usual case, because what changed is
// the id and describeTarget prefers role+name — saying "the button X is gone,
// found the button X" is true and useless. So the difference is named instead.
function reasonSentence(want, proposed, reasons, lang) {
  const from = describeTarget(want, { lang });
  const to = describeTarget(proposed, { lang });
  const changed = changedHints(want, proposed);
  const what = from === to && changed.length
    ? (lang === 'da' ? `${from} findes ikke længere under ${changed.join(', ')}`
      : `${from} no longer matches on ${changed.join(', ')}`)
    : (lang === 'da' ? `${from} findes ikke længere. Fandt ${to}` : `${from} is gone. Found ${to}`);
  return `${what}: ${reasons.join(', ')}.`;
}

// Which hints differ between what the step says and what was found — the actual
// change, named, so the operator can see whether it is one they expected.
function changedHints(want, proposed) {
  const out = [];
  for (const key of TARGET_STRATEGIES) {
    if (!want[key]) continue;
    if (proposed[key] === undefined) { out.push(`${key} "${want[key]}"`); continue; }
    if (norm(proposed[key]) !== norm(want[key])) out.push(`${key} "${want[key]}" \u2192 "${proposed[key]}"`);
  }
  return out;
}

// High only when the match is strong AND unambiguous. An operator reading
// "high" should be able to click accept without opening the page.
function confidenceFor(score, runnerUp) {
  const margin = runnerUp ? score - runnerUp.score : score;
  if (score >= 7 && margin >= 4) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

module.exports = {
  proposeHealing, scoreCandidate, textMatch, confidenceFor,
  WEIGHTS, NAME_WEIGHT, MIN_SCORE, MIN_MARGIN,
};
