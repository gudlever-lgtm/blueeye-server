'use strict';

// The accessibility rules (V2 §9).
//
// Every assertion here is an argument about what counts as a problem. The two
// that matter most are about what is NOT flagged: alt="" and hidden elements.
// An accessibility report earns its reputation on its false positives, and a
// noisy one gets switched off in a week — at which point it protects nobody.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { audit, accessibleName, isHidden, MAX_PER_RULE } = require('../rules');

const page = (over = {}) => ({
  document: { lang: 'en', title: 'Customer Portal', url: 'https://example.com/' },
  nodes: [],
  headings: [{ level: 1, text: 'Customer Portal', tag: 'h1', selector: 'h1' }],
  ...over,
});
const rules = (result) => result.findings.map((f) => f.rule);
const has = (result, rule) => rules(result).includes(rule);

// ------------------------------------------------------------------ naming
test('a control with no accessible name is serious; any naming source clears it', () => {
  const bare = audit(page({ nodes: [{ kind: 'button', tag: 'button', selector: '#go' }] }));
  assert.ok(has(bare, 'button-name'));
  assert.equal(bare.findings[0].impact, 'serious');
  // The finding has to be locatable and explain itself, or it is a rule code
  // nobody acts on.
  assert.equal(bare.findings[0].element.selector, '#go');
  assert.match(bare.findings[0].why, /screen reader/i);

  // Each of these is a real way a button gets its name, and any one is enough.
  for (const named of [
    { ariaLabel: 'Search' },
    { ariaLabelledByText: 'Search' },
    { title: 'Search' },
    { text: 'Search' },
    { value: 'Search' },
  ]) {
    const res = audit(page({ nodes: [{ kind: 'button', tag: 'button', selector: '#go', ...named }] }));
    assert.ok(!has(res, 'button-name'), `${JSON.stringify(named)} should name the button`);
  }
});

test('a link with no text is reported as a link, not as a button', () => {
  const res = audit(page({ nodes: [{ kind: 'link', tag: 'a', selector: 'a' }] }));
  assert.deepEqual(rules(res), ['link-name']);
  assert.match(res.findings[0].message, /link/i);
});

test('whitespace is not a name', () => {
  const res = audit(page({ nodes: [{ kind: 'button', tag: 'button', text: '   ', ariaLabel: '  ' }] }));
  assert.ok(has(res, 'button-name'), 'a button labelled with spaces is an unnamed button');
});

// -------------------------------------------------------------- form fields
test('an unlabelled field is serious, and a placeholder does not count as a label', () => {
  const res = audit(page({
    nodes: [{ kind: 'field', tag: 'input', selector: '#email', placeholder: 'Email' }],
  }));
  // Two distinct problems, deliberately: it has no label, AND the thing standing
  // in for one disappears the moment somebody types.
  assert.ok(has(res, 'field-label'));
  assert.ok(has(res, 'placeholder-not-label'));
  assert.match(res.findings.find((f) => f.rule === 'placeholder-not-label').message, /Email/);
});

test('a properly labelled field with a placeholder is not a finding', () => {
  const res = audit(page({
    nodes: [{ kind: 'field', tag: 'input', labelText: 'Email address', placeholder: 'you@example.com' }],
  }));
  // A placeholder alongside a real label is good practice, not a fault.
  assert.deepEqual(rules(res), []);
});

// ------------------------------------------------------------------ images
test('alt="" is correct for decoration and is never flagged', () => {
  // THE false positive that discredits a report. alt="" is how you say "this
  // picture carries no information"; flagging it pushes people into writing
  // noise for a screen reader to read out.
  const decorative = audit(page({ nodes: [{ kind: 'image', tag: 'img', alt: '' }] }));
  assert.deepEqual(rules(decorative), []);

  // Absent is a different fact from empty, and the collector keeps them apart.
  const missing = audit(page({ nodes: [{ kind: 'image', tag: 'img', alt: null, selector: 'img.logo' }] }));
  assert.deepEqual(rules(missing), ['image-alt']);
  assert.match(missing.findings[0].why, /alt=""/);
});

// ---------------------------------------------------------------- headings
test('a missing h1 is reported, and a skipped level is reported separately', () => {
  const noH1 = audit(page({ headings: [{ level: 2, text: 'Details' }] }));
  assert.ok(has(noH1, 'heading-h1'));

  const skips = audit(page({
    headings: [{ level: 1, text: 'Portal' }, { level: 2, text: 'Account' }, { level: 4, text: 'Address' }],
  }));
  assert.ok(has(skips, 'heading-order'));
  assert.match(skips.findings.find((f) => f.rule === 'heading-order').message, /h2 to h4/);
});

test('going back up a level is normal and is not a finding', () => {
  // h3 → h2 is simply the next section. Flagging it would make every real page
  // fail, which is how a check gets ignored.
  const res = audit(page({
    headings: [{ level: 1, text: 'A' }, { level: 2, text: 'B' }, { level: 3, text: 'C' }, { level: 2, text: 'D' }],
  }));
  assert.ok(!has(res, 'heading-order'));
});

test('a page with no headings at all is not accused of a heading order problem', () => {
  const res = audit(page({ headings: [] }));
  assert.ok(!has(res, 'heading-order'));
  assert.ok(!has(res, 'heading-h1'), 'no headings is a different fact from bad headings');
});

// ---------------------------------------------------------------- keyboard
test('a clickable div that cannot take focus is serious', () => {
  const res = audit(page({
    nodes: [{ kind: 'clickable', tag: 'div', selector: 'div.btn', text: 'Save', focusable: false }],
  }));
  assert.deepEqual(rules(res), ['keyboard-reachable']);
  assert.match(res.findings[0].why, /keyboard/i);
});

test('the same div with a tabindex is reachable and is left alone', () => {
  const res = audit(page({
    nodes: [{ kind: 'clickable', tag: 'div', text: 'Save', focusable: true, tabIndex: 0 }],
  }));
  assert.deepEqual(rules(res), []);
});

test('a positive tabindex is reported — it jumps the queue rather than joining it', () => {
  const res = audit(page({
    nodes: [{ kind: 'field', tag: 'input', labelText: 'Name', tabIndex: 3, focusable: true }],
  }));
  assert.deepEqual(rules(res), ['tabindex-positive']);
  assert.match(res.findings[0].why, /in front of everything/);
});

// ---------------------------------------------------------------- document
test('a page with no lang or no title says so', () => {
  const res = audit(page({ document: { lang: '', title: '' } }));
  assert.ok(has(res, 'html-lang'));
  assert.ok(has(res, 'document-title'));
});

// ------------------------------------------------------------------ hidden
test('an element hidden from everyone is not an accessibility problem', () => {
  // Carousels, drawers and off-screen menus are built this way. Flagging them is
  // how a report earns a reputation for noise.
  for (const hide of [{ ariaHidden: true }, { hidden: true }, { displayNone: true }]) {
    const res = audit(page({ nodes: [{ kind: 'button', tag: 'button', ...hide }] }));
    assert.deepEqual(rules(res), [], JSON.stringify(hide));
  }
});

// ------------------------------------------------------------------ volume
test('one bad pattern cannot crowd out every other kind of problem', () => {
  const nodes = [];
  for (let i = 0; i < 200; i += 1) nodes.push({ kind: 'field', tag: 'input', selector: `#f${i}` });
  nodes.push({ kind: 'button', tag: 'button', selector: '#only-button' });
  const res = audit(page({ nodes }));

  const fieldFindings = res.findings.filter((f) => f.rule === 'field-label');
  assert.equal(fieldFindings.length, MAX_PER_RULE, 'the per-rule cap applies');
  // Fifty unlabelled inputs and one unnamed button is a page with TWO problems,
  // and the second must not be pushed off the end of the list.
  assert.ok(has(res, 'button-name'), 'the other problem survived the flood');
  // "20 of 340" is a different fact from "20". An operator who cannot tell them
  // apart fixes twenty things and believes they are done.
  assert.equal(res.truncated, true);
  assert.ok(res.counts.total > res.findings.length);
});

test('serious findings come first — the order is the order to fix them in', () => {
  const res = audit(page({
    nodes: [
      { kind: 'field', tag: 'input', labelText: 'Name', tabIndex: 2, focusable: true },
      { kind: 'button', tag: 'button', selector: '#go' },
    ],
  }));
  assert.equal(res.findings[0].impact, 'serious');
  assert.equal(res.findings[res.findings.length - 1].impact, 'moderate');
});

// ------------------------------------------------------------- never throws
test('junk in, no findings out — an audit never takes a run down with it', () => {
  // An accessibility report is the last thing that should be able to fail a run.
  for (const junk of [null, undefined, {}, [], 'nope', 42, { nodes: 'no' }, { nodes: [null, undefined, 7] }]) {
    assert.doesNotThrow(() => audit(junk), JSON.stringify(junk));
  }
  assert.deepEqual(audit(null).findings, []);
  assert.deepEqual(audit({}).counts, { serious: 0, moderate: 0, minor: 0, total: 0 });
});

test('a clean page reports what it looked at, so "no findings" can be read honestly', () => {
  const res = audit(page({
    nodes: [{ kind: 'button', tag: 'button', text: 'Sign in' }],
  }));
  assert.deepEqual(res.findings, []);
  // A page where nothing was collected is not a page that passed, and the
  // counts are what let a reader tell the two apart.
  assert.equal(res.checked.elements, 1);
  assert.equal(res.checked.headings, 1);
});

// ------------------------------------------------------------------ helpers
test('accessibleName consults the sources in the order a browser does', () => {
  assert.equal(accessibleName({ ariaLabel: 'A', ariaLabelledByText: 'B', text: 'C' }), 'A');
  assert.equal(accessibleName({ ariaLabelledByText: 'B', labelText: 'L', text: 'C' }), 'B');
  assert.equal(accessibleName({ labelText: 'L', title: 'T' }), 'L');
  assert.equal(accessibleName(null), '');
});

test('isHidden is about being hidden from everyone, not just from sight', () => {
  assert.equal(isHidden({ ariaHidden: true }), true);
  assert.equal(isHidden({ displayNone: true }), true);
  assert.equal(isHidden({}), false);
  assert.equal(isHidden(null), false);
});
