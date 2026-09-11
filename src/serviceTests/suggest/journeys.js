'use strict';

const { CONFIDENCE } = require('./rules');

// Discovery → JOURNEY suggestions (V2 §3, P1 #3).
//
// The test rules next door answer "what could we check here". They do not answer
// the question the product exists to answer, which is "what does a user actually
// DO here". This file answers that one:
//
//     Sign in and use the application            confidence: medium
//       1. Login                      required
//       2. Authenticated navigation   required
//       3. Logout                     optional
//     Reason: found a login flow and reached 3 pages behind it.
//
// EXPLICITLY NOT AI, like every rule in this module. Each journey below is a
// stated condition over what Discovery found, and carries the reason it was
// proposed — so an operator judges it instead of trusting it.
//
// PURE: test suggestions and the discovery result in, journey suggestions out.
//
// A journey suggestion names its members by the NAME of the test suggestions
// beside it, never by id: those tests do not exist yet. Accepting the journey is
// what creates them. That also means this file invents no steps of its own — it
// GROUPS what the test rules already proposed, so there is exactly one place
// that knows how to turn a discovered element into a DSL step.

// What the product must not do, stated once so the rules below can point at it:
// "Availability" is not a journey. Opening the front page and getting HTTP 200
// is the definition of "the website is up", and the whole point of journeys is
// that BlueEyes stops saying that. It stays a useful test; it never becomes a
// user journey.
const NOT_A_JOURNEY = new Set(['Availability']);

const has = (suggestions, name) => suggestions.some((s) => s.name === name);
const find = (suggestions, name) => suggestions.find((s) => s.name === name) || null;

// Confidence is the WEAKEST link. A journey built from a high-confidence login
// and a low-confidence search is a low-confidence journey — the operator's
// attention should go to the part that might be wrong.
const RANK = { low: 0, medium: 1, high: 2 };
function weakest(suggestions) {
  let out = CONFIDENCE.HIGH;
  for (const s of suggestions) {
    const c = s && RANK[s.confidence] !== undefined ? s.confidence : CONFIDENCE.MEDIUM;
    if (RANK[c] < RANK[out]) out = c;
  }
  return out;
}

// A member reference: which test suggestion, and whether the journey fails
// without it.
const step = (suggestion, required = true) => ({
  suggestion_name: suggestion.name,
  required,
});

// ------------------------------------------------------------------ sign in
// The smallest real journey, and usually the most important one: can a user get
// in at all. Logout rides along as OPTIONAL — signing out failing is a problem,
// but it is not "nobody can use the service".
function signIn(tests) {
  const login = find(tests, 'Login');
  if (!login) return null;
  const logout = find(tests, 'Logout');
  const members = [step(login, true)];
  if (logout) members.push(step(logout, false));

  return {
    name: 'Sign in',
    description: 'Can a user sign in at all? The first thing to know when something is wrong.',
    // Proposed, not decided. Criticality is the customer's judgement — this is a
    // starting point the operator is expected to change, and the UI says so.
    criticality: 'high',
    confidence: weakest(members.map((m) => find(tests, m.suggestion_name))),
    reason: logout
      ? `Discovery found a possible login flow and a sign-out control. ${login.reason || ''}`.trim()
      : `Discovery found a possible login flow. ${login.reason || ''}`.trim(),
    steps: members,
  };
}

// -------------------------------------------------------- sign in and use it
// The spec's own example shape: login → do something → logout. Only proposed
// when there is something to do BETWEEN them, otherwise it is "Sign in" with
// extra words.
function signInAndUse(tests) {
  const login = find(tests, 'Login');
  const nav = find(tests, 'Authenticated navigation');
  if (!login || !nav) return null;
  const logout = find(tests, 'Logout');

  const members = [step(login, true), step(nav, true)];
  if (logout) members.push(step(logout, false));

  return {
    name: 'Sign in and use the application',
    description: 'Sign in, reach the pages behind the login, and sign out again — the shape of an ordinary session.',
    criticality: 'high',
    confidence: weakest(members.map((m) => find(tests, m.suggestion_name))),
    reason: `Discovery found a login flow and reached pages behind it. ${nav.reason || ''}`.trim(),
    steps: members,
  };
}

// ------------------------------------------------------------------ look up
// Searching is what most internal applications are FOR, so it is worth a journey
// of its own rather than a step inside a bigger one. When a login exists the
// search is almost certainly behind it, so the journey signs in first.
function lookSomethingUp(tests) {
  const search = find(tests, 'Search');
  if (!search) return null;
  const login = find(tests, 'Login');

  const members = [];
  if (login) members.push(step(login, true));
  members.push(step(search, true));

  return {
    name: login ? 'Sign in and search' : 'Search',
    description: 'Find something — usually the reason the application exists.',
    criticality: 'normal',
    confidence: weakest(members.map((m) => find(tests, m.suggestion_name))),
    reason: login
      ? `Discovery found a search field and a login flow, so the search is probably behind the login. ${search.reason || ''}`.trim()
      : `${search.reason || 'Discovery found a search field.'}`,
    steps: members,
  };
}

const JOURNEY_RULES = [signInAndUse, signIn, lookSomethingUp];

// Runs every journey rule over the test suggestions Discovery produced.
//
// A rule that throws is skipped rather than failing the pass — one bad heuristic
// must not cost the operator the others. Same posture as suggestTests.
//
// Journeys that are a SUBSET of another journey are dropped: "Sign in" and "Sign
// in and use the application" both apply whenever both rules match, and offering
// both means the operator accepts two journeys that watch the same login and
// then wonders why one is redundant. The larger one wins because it says more.
function suggestJourneys(testSuggestions = []) {
  const tests = (Array.isArray(testSuggestions) ? testSuggestions : [])
    .filter((s) => s && typeof s === 'object' && s.name && !NOT_A_JOURNEY.has(s.name));

  const out = [];
  for (const rule of JOURNEY_RULES) {
    try {
      const journey = rule(tests);
      if (journey && journey.steps && journey.steps.length) out.push(journey);
    } catch { /* skip this rule */ }
  }

  return out.filter((journey, i) => !out.some((other, j) => j !== i && isSubsetOf(journey, other)));
}

// True when every member of `a` is also a member of `b`, and `b` has more. Equal
// sets are NOT subsets of each other — that would drop both.
function isSubsetOf(a, b) {
  const mine = new Set(a.steps.map((s) => s.suggestion_name));
  const theirs = new Set(b.steps.map((s) => s.suggestion_name));
  if (mine.size >= theirs.size) return false;
  for (const name of mine) if (!theirs.has(name)) return false;
  return true;
}

module.exports = { suggestJourneys, JOURNEY_RULES, isSubsetOf, weakest, NOT_A_JOURNEY };
