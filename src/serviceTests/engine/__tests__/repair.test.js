'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { repairDefinition, repairStep, isGeneratedTitleAssertion } = require('../repair');
const { validateDefinition } = require('../validate');

const TITLE = 'fellis.eu – Connect. Share. Discover';
const broken = (over = {}) => ({ type: 'assert_text_contains', target: { text: TITLE }, value: TITLE, ...over });

test('the generated title assertion is recognised, and nothing else is', () => {
  assert.equal(isGeneratedTitleAssertion(broken()), true);

  const notIt = [
    // A hand-built step: the designer creates every target as { text: '' } and
    // offers no way to edit a target, while `value` is required and non-empty.
    { type: 'assert_text_contains', target: { text: '' }, value: 'Velkommen' },
    // A real text assertion against an element.
    { type: 'assert_text_contains', target: { role: 'heading', name: 'Feed' }, value: 'Feed' },
    // Same text, different value — a genuine "this element contains that".
    { type: 'assert_text_contains', target: { text: 'Velkommen tilbage' }, value: 'Velkommen' },
    // A richer target that happens to carry the title.
    { type: 'assert_text_contains', target: { text: TITLE, role: 'heading' }, value: TITLE },
    // Other step types are never touched.
    { type: 'assert_text_equals', target: { text: TITLE }, value: TITLE },
    { type: 'assert_exists', target: { text: TITLE } },
    { type: 'assert_title_contains', value: TITLE },
    null, undefined, {}, { type: 'assert_text_contains' },
    { type: 'assert_text_contains', target: [], value: TITLE },
  ];
  for (const step of notIt) {
    assert.equal(isGeneratedTitleAssertion(step), false, JSON.stringify(step));
  }
});

test('a repaired step asserts the title and drops the target it can never match', () => {
  const fixed = repairStep(broken({ label: 'Kontroller at teksten … indeholder …' }));
  assert.equal(fixed.type, 'assert_title_contains');
  assert.equal(fixed.value, TITLE);
  assert.equal(fixed.target, undefined);
  assert.equal(fixed.label, undefined, 'a stale label would describe the step this no longer is');
});

test('a step that is not the generated one comes back byte-identical', () => {
  const step = { type: 'assert_text_contains', target: { role: 'heading', name: 'Feed' }, value: 'Feed' };
  assert.equal(repairStep(step), step, 'the same object, so a caller can count changes by identity');
});

test('the accepted Login test is repaired and still validates', () => {
  const definition = {
    version: 1,
    name: 'Login',
    steps: [
      { type: 'open', url: '/login' },
      { type: 'fill', target: { label: 'E-mail' }, value: '{{credential.username}}' },
      { type: 'fill', target: { label: 'Kodeord' }, value: '{{credential.password}}' },
      { type: 'click', target: { role: 'button', name: 'Log ind' } },
      broken(),
    ],
  };
  const { definition: repaired, changed } = repairDefinition(definition);
  assert.equal(changed, 1);
  assert.equal(repaired.steps[4].type, 'assert_title_contains');
  assert.deepEqual(repaired.steps.slice(0, 4), definition.steps.slice(0, 4), 'the rest of the journey is untouched');
  assert.notEqual(repaired, definition, 'the input is never mutated');
  assert.deepEqual(definition.steps[4], broken(), 'really never mutated');

  // The point of the repair: what comes out is a definition the server accepts.
  const { errors } = validateDefinition(repaired);
  assert.equal(errors, undefined, JSON.stringify(errors));
});

test('a broken step nested inside a condition block is repaired too', () => {
  const definition = {
    version: 1,
    name: 'Login',
    steps: [
      { type: 'open', url: '/' },
      { type: 'condition', target: { text: 'Accepter cookies' }, then: [{ type: 'click', target: { role: 'button', name: 'OK' } }, broken()] },
      broken(),
    ],
  };
  const { definition: repaired, changed } = repairDefinition(definition);
  assert.equal(changed, 2, 'a top-level-only sweep would miss the nested one');
  assert.equal(repaired.steps[1].then[1].type, 'assert_title_contains');
  assert.equal(repaired.steps[2].type, 'assert_title_contains');
  assert.equal(repaired.steps[1].target.text, 'Accepter cookies', "the condition's own target is not a step to repair");
});

test('repairing is idempotent, and a definition with nothing to fix is returned as-is', () => {
  const clean = { version: 1, steps: [{ type: 'assert_title_contains', value: TITLE }] };
  const first = repairDefinition(clean);
  assert.equal(first.changed, 0);
  assert.equal(first.definition, clean, 'no copy is made when there is nothing to change');

  const once = repairDefinition({ version: 1, steps: [broken()] });
  const twice = repairDefinition(once.definition);
  assert.equal(twice.changed, 0, 'running the repair again must be a no-op');
});

test('garbage in does not throw — the repair runs across every stored definition', () => {
  for (const input of [undefined, null, 42, 'x', [], {}, { steps: 'nope' }, { steps: [null, 7] }]) {
    assert.doesNotThrow(() => repairDefinition(input), JSON.stringify(input));
    assert.equal(repairDefinition(input).changed, 0);
  }
});
