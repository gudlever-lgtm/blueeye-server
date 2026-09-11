'use strict';

// Discovery → journey suggestions (V2 §3).
//
// These rules decide what BlueEyes PROPOSES, so the specs are mostly about what
// it must NOT propose: a journey nobody asked for is worse than none, because
// the operator has to read and reject it every time Discovery runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { suggestJourneys, weakest, isSubsetOf, NOT_A_JOURNEY } = require('../journeys');

const s = (name, confidence = 'medium', reason = '') => ({ name, confidence, reason });
const names = (list) => list.map((j) => j.name);
const members = (journey) => journey.steps.map((x) => x.suggestion_name);

test('a full estate yields the session journey and the search journey, not five variants', () => {
  const found = suggestJourneys([
    s('Availability', 'high'),
    s('Login', 'high', 'Found username, password and Login button.'),
    s('Authenticated navigation', 'medium', 'Reached 3 pages.'),
    s('Logout', 'medium'),
    s('Search', 'medium', 'Found a search field.'),
  ]);

  assert.deepEqual(names(found), ['Sign in and use the application', 'Sign in and search']);
  assert.deepEqual(members(found[0]), ['Login', 'Authenticated navigation', 'Logout']);
  // Signing out failing is a problem; it is not "nobody can use the service".
  assert.deepEqual(found[0].steps.map((x) => x.required), [true, true, false]);
});

test('"Sign in" is dropped when the bigger journey that contains it applies', () => {
  // Both rules match whenever there is a login AND pages behind it. Offering
  // both means accepting two journeys that watch the same login, then wondering
  // why one is redundant.
  const both = suggestJourneys([s('Login', 'high'), s('Authenticated navigation', 'medium'), s('Logout')]);
  assert.deepEqual(names(both), ['Sign in and use the application']);

  // With nothing to do behind the login, "Sign in" is the whole journey.
  const alone = suggestJourneys([s('Login', 'high')]);
  assert.deepEqual(names(alone), ['Sign in']);
  assert.deepEqual(members(alone[0]), ['Login']);
});

test('"Availability" never becomes a journey', () => {
  // Opening the front page and getting HTTP 200 is the definition of "the
  // website is up" — the exact sentence journeys exist so BlueEyes stops saying.
  assert.ok(NOT_A_JOURNEY.has('Availability'));
  assert.deepEqual(suggestJourneys([s('Availability', 'high')]), []);

  // And it is not smuggled in as a member of a real journey either.
  const withLogin = suggestJourneys([s('Availability', 'high'), s('Login', 'high')]);
  assert.deepEqual(names(withLogin), ['Sign in']);
  assert.ok(!members(withLogin[0]).includes('Availability'));
});

test('nothing found means nothing proposed', () => {
  assert.deepEqual(suggestJourneys([]), []);
  assert.deepEqual(suggestJourneys(), []);
  assert.deepEqual(suggestJourneys(null), []);
  assert.deepEqual(suggestJourneys('nope'), []);
  // Junk entries are skipped rather than throwing — one bad row must not cost
  // the operator the rules that did match.
  assert.deepEqual(names(suggestJourneys([null, 42, {}, s('Login', 'high')])), ['Sign in']);
});

test('search is proposed with the login in front of it when there is one', () => {
  const behindLogin = suggestJourneys([s('Login', 'high'), s('Search', 'medium')]);
  const search = behindLogin.find((j) => j.name === 'Sign in and search');
  assert.ok(search, 'a search behind a login should sign in first');
  assert.deepEqual(members(search), ['Login', 'Search']);

  const public_ = suggestJourneys([s('Search', 'medium')]);
  assert.deepEqual(names(public_), ['Search']);
  assert.deepEqual(members(public_[0]), ['Search']);
});

test('confidence is the weakest link, so attention goes to the part that might be wrong', () => {
  assert.equal(weakest([{ confidence: 'high' }, { confidence: 'low' }]), 'low');
  assert.equal(weakest([{ confidence: 'high' }, { confidence: 'medium' }]), 'medium');
  assert.equal(weakest([{ confidence: 'high' }, { confidence: 'high' }]), 'high');
  // An unrated or unknown member is treated as medium, never as high.
  assert.equal(weakest([{ confidence: 'high' }, {}]), 'medium');
  assert.equal(weakest([{ confidence: 'high' }, { confidence: 'excellent' }]), 'medium');
  assert.equal(weakest([]), 'high');

  const found = suggestJourneys([s('Login', 'high'), s('Authenticated navigation', 'low')]);
  assert.equal(found[0].confidence, 'low', 'a high-confidence login does not make a shaky journey confident');
});

test('every suggestion carries a reason, because a proposal without one cannot be judged', () => {
  const found = suggestJourneys([
    s('Login', 'high', 'Found username, password and Login button.'),
    s('Authenticated navigation', 'medium', 'Reached 3 pages after the login.'),
    s('Search', 'medium', 'Found a search field.'),
  ]);
  assert.ok(found.length);
  for (const j of found) {
    assert.ok(j.reason && j.reason.length > 10, `${j.name} has no usable reason`);
    assert.ok(j.description, `${j.name} has no description`);
    // Criticality is PROPOSED here and decided by the operator. It must always
    // be one the journey validator accepts.
    assert.ok(['critical', 'high', 'normal', 'low'].includes(j.criticality));
  }
});

test('isSubsetOf keeps equal sets, or both would be dropped', () => {
  const a = { steps: [{ suggestion_name: 'Login' }] };
  const b = { steps: [{ suggestion_name: 'Login' }, { suggestion_name: 'Logout' }] };
  const c = { steps: [{ suggestion_name: 'Login' }] };
  assert.equal(isSubsetOf(a, b), true);
  assert.equal(isSubsetOf(b, a), false);
  assert.equal(isSubsetOf(a, c), false, 'equal sets must both survive');
  assert.equal(isSubsetOf(b, { steps: [{ suggestion_name: 'Search' }, { suggestion_name: 'X' }] }), false);
});
