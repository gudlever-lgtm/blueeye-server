'use strict';

// Self-healing selectors (V2 §5).
//
// These rules decide when BlueEyes offers to repoint a test at a different
// element. Most of the specs are about when it must NOT: a wrong heal turns the
// test green while the service stays broken, and nobody looks again. A missed
// heal costs somebody five minutes in the designer.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { proposeHealing, scoreCandidate, textMatch, confidenceFor } = require('../heal');

test('the spec\'s own example: the id changed, the button did not', () => {
  //   Original:   #login-button
  //   Suggested:  button "Log ind"
  const proposal = proposeHealing(
    { id: 'login-button', role: 'button', name: 'Log ind' },
    [{ role: 'button', name: 'Log ind', id: 'signin-btn' }, { role: 'link', name: 'Glemt kodeord' }]
  );
  assert.ok(proposal);
  assert.equal(proposal.confidence, 'high');
  assert.equal(proposal.target.id, 'signin-btn');
  assert.equal(proposal.target.role, 'button');
  // The reason has to name what changed, or the operator cannot check it.
  assert.match(proposal.reason, /login-button.*signin-btn/);
  assert.match(proposal.reason, /still called "Log ind"/);
});

test('two elements it cannot tell apart produce no proposal', () => {
  // The wrong-heal case in its purest form: guessing between them is a coin
  // flip, and the losing side is a test that passes for the wrong reason.
  const proposal = proposeHealing(
    { role: 'button', name: 'Save', id: 'save1' },
    [{ role: 'button', name: 'Save', id: 'a' }, { role: 'button', name: 'Save', id: 'b' }]
  );
  assert.equal(proposal, null);
});

test('weak evidence produces no proposal', () => {
  // A lone id match. An id is the thing that changes, so an id agreeing is the
  // weakest evidence there is.
  assert.equal(proposeHealing({ id: 'btn' }, [{ id: 'btn-2', role: 'button' }]), null);
  // Nothing in common at all.
  assert.equal(proposeHealing({ role: 'button', name: 'Log ind' },
    [{ role: 'link', name: 'Cookies' }, { role: 'textbox', label: 'Search' }]), null);
  // A one-character overlap is not a match.
  assert.equal(proposeHealing({ role: 'button', name: 'A' }, [{ role: 'button', name: 'Save and close' }]), null);
});

test('a proposal identical to what the step already says is not a proposal', () => {
  // The element did not resolve for some other reason — timing, a hidden
  // ancestor — and repointing the step at itself would hide that.
  assert.equal(proposeHealing({ role: 'button', name: 'Log ind' }, [{ role: 'button', name: 'Log ind' }]), null);
});

test('nothing to work with yields nothing', () => {
  assert.equal(proposeHealing(null, [{ role: 'button' }]), null);
  assert.equal(proposeHealing({}, [{ role: 'button' }]), null);
  assert.equal(proposeHealing({ role: 'button', name: 'x' }, []), null);
  assert.equal(proposeHealing({ role: 'button', name: 'x' }, null), null);
  assert.equal(proposeHealing({ role: 'button', name: 'x' }, [null, 42, 'nope']), null);
});

test('a changed kind of element counts against, it is not free', () => {
  // A button that became a link might be the same control — applications do
  // that — but it is evidence against and must cost something.
  const sameKind = scoreCandidate({ role: 'button', name: 'Log ind' }, { role: 'button', name: 'Log ind' });
  const changedKind = scoreCandidate({ role: 'button', name: 'Log ind' }, { role: 'link', name: 'Log ind' });
  assert.ok(changedKind.score < sameKind.score, 'a role change must reduce the score');
});

test('`name` is scored once, not twice', () => {
  // targeting.js: `name` is the accessible name when a role is present, and the
  // HTML attribute otherwise. Scoring it both ways inflates the total and prints
  // the same evidence twice as if it were two independent facts.
  const withRole = scoreCandidate({ role: 'button', name: 'Log ind' }, { role: 'button', name: 'Log ind' });
  assert.equal(withRole.reasons.length, 2, 'role + accessible name, not three reasons');
  assert.ok(!withRole.reasons.some((r) => /name attribute/.test(r)));

  const withoutRole = scoreCandidate({ name: 'username' }, { name: 'username', role: 'textbox' });
  assert.deepEqual(withoutRole.reasons, ['same name attribute "username"']);
});

test('textMatch is exact, then substantial containment, then nothing', () => {
  assert.equal(textMatch('Log ind', 'log ind'), 1, 'case and spacing do not matter');
  assert.equal(textMatch('Log  ind', 'Log ind'), 1);
  assert.equal(textMatch('Log ind', 'Log ind nu'), 0.6);
  assert.equal(textMatch('a', 'Save and close'), 0, 'a one-character overlap is not evidence');
  assert.equal(textMatch('', 'x'), 0);
  assert.equal(textMatch(null, undefined), 0);
  assert.equal(textMatch('Login', 'Logout'), 0);
});

test('confidence is high only when the match is strong AND unambiguous', () => {
  assert.equal(confidenceFor(7, null), 'high');
  assert.equal(confidenceFor(7, { score: 3 }), 'high');
  // Strong, but something else is nearly as good — the operator should look.
  assert.equal(confidenceFor(7, { score: 5 }), 'medium');
  assert.equal(confidenceFor(5, null), 'medium');
  assert.equal(confidenceFor(3, null), 'low');
});

test('a renamed button is proposed, with the rename stated', () => {
  const proposal = proposeHealing(
    { role: 'button', name: 'Log ind', id: 'b1' },
    [{ role: 'button', name: 'Log ind nu', id: 'b1' }, { role: 'link', name: 'Help' }]
  );
  assert.ok(proposal);
  assert.equal(proposal.target.name, 'Log ind nu');
  assert.match(proposal.reason, /Log ind nu/);
  // Not high: the words changed, so a person should read it.
  assert.notEqual(proposal.confidence, 'high');
});

test('the runner-up is reported, so a close call is visible', () => {
  const proposal = proposeHealing(
    { role: 'button', name: 'Log ind', label: 'Log ind', id: 'x' },
    [
      { role: 'button', name: 'Log ind', label: 'Log ind', id: 'new' },
      { role: 'button', name: 'Log ind igen' },
      { role: 'link', name: 'Cookies' },
    ]
  );
  assert.ok(proposal);
  assert.ok(proposal.runner_up, 'a second candidate scored, and the operator should know');
  assert.ok(proposal.score > proposal.runner_up.score);
});

test('the threshold is adjustable, so the caller can be stricter but never silently looser', () => {
  const target = { role: 'button', name: 'Log ind', id: 'old' };
  const candidates = [{ role: 'button', name: 'Log ind', id: 'new' }, { role: 'link', name: 'x' }];
  assert.ok(proposeHealing(target, candidates));
  assert.equal(proposeHealing(target, candidates, { minScore: 99 }), null);

  // The margin measures AMBIGUITY BETWEEN candidates, so it needs a second one
  // that actually scored. `{ role: 'link', name: 'x' }` above scores nothing and
  // is dropped before the comparison — with one plausible candidate there is no
  // ambiguity to guard against, and raising the margin correctly changes nothing.
  assert.ok(proposeHealing(target, candidates, { minMargin: 99 }),
    'a lone candidate is not ambiguous, whatever the margin is set to');

  const ambiguous = [{ role: 'button', name: 'Log ind', id: 'a' }, { role: 'button', name: 'Log ind nu', id: 'b' }];
  assert.ok(proposeHealing(target, ambiguous), 'clear enough at the default margin');
  assert.equal(proposeHealing(target, ambiguous, { minMargin: 99 }), null, 'and suppressed by a stricter one');
});
