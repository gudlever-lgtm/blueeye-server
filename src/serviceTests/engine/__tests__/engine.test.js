'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition, requiresCredential, flattenSteps, MAX_STEPS } = require('../validate');
const { STEP_TYPES, catalogue, credentialRefsIn, hasCredentialRef } = require('../dsl');
const { strategiesFor, describeTarget, normalizeTarget, isCssOnly } = require('../targeting');
const { createRedactor, MASK } = require('../redact');

// ------------------------------------------------------------------ catalogue
test('the catalogue covers every step type the spec asks for', () => {
  const required = [
    'open', 'back', 'refresh',
    'click', 'fill', 'clear', 'select', 'checkbox', 'upload',
    'assert_exists', 'assert_visible', 'assert_not_visible',
    'assert_text_contains', 'assert_text_equals', 'assert_title_contains',
    'assert_url_contains', 'assert_url_equals',
    'wait', 'condition', 'login', 'logout', 'api_request', 'assert_http_status',
  ];
  for (const type of required) assert.ok(STEP_TYPES.includes(type), `missing step type ${type}`);
  // The catalogue is what the designer renders from, so every type must appear.
  const catalogued = catalogue().flatMap((c) => c.steps.map((s) => s.type));
  assert.deepEqual([...STEP_TYPES].sort(), [...catalogued].sort());
});

test('the catalogue is serialisable — the UI fetches it rather than duplicating it', () => {
  const json = JSON.stringify(catalogue());
  assert.ok(json.length > 100);
  const parsed = JSON.parse(json);
  const open = parsed.flatMap((c) => c.steps).find((s) => s.type === 'open');
  assert.equal(open.fields[0].name, 'url');
  assert.equal(open.fields[0].required, true);
});

// ------------------------------------------------------------------ validate
test('the MVP login journey from the spec validates', () => {
  const { value, errors } = validateDefinition({
    version: 1,
    name: 'Customer Login',
    steps: [
      { type: 'open', url: '/login' },
      { type: 'fill', target: { type: 'label', value: 'Username' }, value: '{{credential.username}}' },
      { type: 'fill', target: { type: 'label', value: 'Password' }, value: '{{credential.password}}' },
      { type: 'click', target: { type: 'role', role: 'button', name: 'Login' } },
      { type: 'assert_visible', target: { type: 'text', value: 'Dashboard' } },
      { type: 'logout' },
    ],
  });
  assert.equal(errors, undefined, JSON.stringify(errors));
  assert.equal(value.steps.length, 6);
  // The { type, value } form is normalised to the hint-bag form.
  assert.deepEqual(value.steps[1].target, { label: 'Username' });
});

test('a step that needs a target is refused without one', () => {
  for (const type of ['click', 'fill', 'assert_visible', 'select']) {
    const { errors } = validateDefinition({ version: 1, steps: [{ type, value: 'x' }] });
    assert.ok(errors && errors['steps[0].target'], type);
  }
});

test('a step that has no target is refused when given one', () => {
  const { errors } = validateDefinition({ version: 1, steps: [{ type: 'refresh', target: { id: 'x' } }] });
  assert.ok(errors['steps[0].target']);
});

test('wait needs exactly one of a duration or something to wait for', () => {
  assert.ok(validateDefinition({ version: 1, steps: [{ type: 'wait' }] }).errors);
  assert.ok(validateDefinition({ version: 1, steps: [{ type: 'wait', ms: 100, target: { id: 'x' } }] }).errors);
  assert.equal(validateDefinition({ version: 1, steps: [{ type: 'wait', ms: 100 }] }).errors, undefined);
  assert.equal(validateDefinition({ version: 1, steps: [{ type: 'wait', target: { id: 'x' } }] }).errors, undefined);
});

test('a condition needs a block and may not nest inside another condition', () => {
  const empty = validateDefinition({ version: 1, steps: [{ type: 'condition', target: { text: 'x' }, then: [] }] });
  assert.ok(empty.errors['steps[0].then']);

  const nested = validateDefinition({
    version: 1,
    steps: [{
      type: 'condition',
      target: { text: 'x' },
      then: [{ type: 'condition', target: { text: 'y' }, then: [{ type: 'refresh' }] }],
    }],
  });
  assert.ok(nested.errors['steps[0].then[0].then'], 'one level of nesting is the limit a drag & drop designer can show');

  const ok = validateDefinition({
    version: 1,
    steps: [{ type: 'condition', target: { text: 'Accepter cookies' }, then: [{ type: 'click', target: { text: 'Accepter cookies' } }] }],
  });
  assert.equal(ok.errors, undefined);
});

test('the step cap is enforced and cannot be raised past the module ceiling', () => {
  const many = (n) => ({ version: 1, steps: Array.from({ length: n }, () => ({ type: 'refresh' })) });
  assert.equal(validateDefinition(many(5), { maxSteps: 10 }).errors, undefined);
  assert.ok(validateDefinition(many(11), { maxSteps: 10 }).errors.steps);
  // A setting above the ceiling does not raise it.
  assert.ok(validateDefinition(many(MAX_STEPS + 1), { maxSteps: 100000 }).errors.steps);
});

test('validateDefinition never throws, whatever it is handed', () => {
  for (const input of [undefined, null, 'str', 42, true, [], () => {}, { __proto__: null }, { steps: 'nope' }, { steps: [null, 42, 'x'] }]) {
    assert.doesNotThrow(() => validateDefinition(input));
    const r = validateDefinition(input);
    assert.ok(r.errors, `${JSON.stringify(input)} should be rejected`);
  }
});

test('requiresCredential sees both a reference and a login step, including inside a condition', () => {
  assert.equal(requiresCredential({ steps: [{ type: 'open', url: '/' }] }), false);
  assert.equal(requiresCredential({ steps: [{ type: 'login' }] }), true);
  assert.equal(requiresCredential({ steps: [{ type: 'fill', value: '{{credential.password}}' }] }), true);
  assert.equal(requiresCredential({
    steps: [{ type: 'condition', target: { text: 'x' }, then: [{ type: 'fill', value: '{{credential.username}}' }] }],
  }), true);
});

test('credentialRefsIn reports which halves of a credential a test needs', () => {
  const refs = credentialRefsIn({
    steps: [{ type: 'fill', value: '{{credential.username}}' }, { type: 'fill', value: '{{ credential.password }}' }],
  });
  assert.deepEqual([...refs].sort(), ['password', 'username']);
  assert.equal(hasCredentialRef('{{credential.password}}'), true);
  assert.equal(hasCredentialRef('{{credential.nope}}'), false);
  assert.equal(hasCredentialRef(42), false);
});

test('flattenSteps keeps a nested step under its parent position, so "step 4" means position 4', () => {
  const flat = flattenSteps({
    steps: [
      { type: 'open', url: '/' },
      { type: 'condition', target: { text: 'x' }, then: [{ type: 'click', target: { text: 'x' } }, { type: 'refresh' }] },
      { type: 'logout' },
    ],
  });
  assert.deepEqual(flat.map((f) => f.path), ['0', '1', '1.0', '1.1', '2']);
  assert.deepEqual(flat.map((f) => f.position), [0, 1, 1, 1, 2]);
  assert.equal(flat[2].conditional, true);
});

// ------------------------------------------------------------------ targeting
test('strategies are tried role → label → text → placeholder → name → id → css', () => {
  const all = strategiesFor({
    role: 'button', name: 'Login', label: 'L', text: 'T', placeholder: 'P', id: 'i', css: '.c',
  });
  assert.deepEqual(all.map((s) => s.strategy), ['role', 'label', 'text', 'placeholder', 'id', 'css']);
  // `name` qualifies the role rather than standing alone when a role is present.
  assert.equal(all[0].name, 'Login');
});

test('name is the attribute when there is no role', () => {
  const strategies = strategiesFor({ name: 'user', id: 'u' });
  assert.deepEqual(strategies.map((s) => s.strategy), ['name', 'id']);
});

test('keeping every hint is what survives a changed id', () => {
  // A target that only knew the id would be dead; this one still has two ways in.
  const target = { role: 'button', name: 'Login', id: 'login-button-v2' };
  assert.ok(strategiesFor(target).length >= 2);
  assert.equal(isCssOnly(target), false);
  assert.equal(isCssOnly({ css: '.btn > span:nth-child(2)' }), true, 'a css-only target is the fragile case worth flagging');
});

test('a target reads as words, never as a locator', () => {
  assert.equal(describeTarget({ role: 'button', name: 'Log ind' }), 'knappen "Log ind"');
  assert.equal(describeTarget({ label: 'Brugernavn' }), 'feltet "Brugernavn"');
  assert.equal(describeTarget({ role: 'link', name: 'Kunder' }), 'linket "Kunder"');
  assert.equal(describeTarget(null), 'elementet');
  assert.match(describeTarget({ role: 'button', name: 'Login' }, { lang: 'en' }), /the button "Login"/);
});

test('normalizeTarget rejects nonsense rather than producing an empty target', () => {
  for (const input of [null, undefined, 42, 'x', [], {}, { type: 'nope', value: 'x' }]) {
    assert.equal(normalizeTarget(input), null, JSON.stringify(input));
  }
});

// ------------------------------------------------------------------ redaction
test('redaction masks every occurrence, longest secret first', () => {
  const redact = createRedactor(['secret', 'secret-with-more']);
  assert.equal(redact.text('a secret-with-more here'), `a ${MASK} here`, 'a secret containing another is masked whole');
  assert.equal(redact.text('a secret here'), `a ${MASK} here`);
});

test('redaction reaches into nested structures and error stacks', () => {
  const redact = createRedactor(['hunter2-correct-horse']);
  const deep = redact.deep({ a: [{ b: 'hunter2-correct-horse' }], 'hunter2-correct-horse': 'x' });
  assert.ok(!JSON.stringify(deep).includes('hunter2-correct-horse'), 'keys are masked too, not just values');

  const err = new Error('login failed: hunter2-correct-horse');
  const masked = redact.error(err);
  assert.ok(!masked.message.includes('hunter2-correct-horse'));
  assert.ok(!masked.stack.includes('hunter2-correct-horse'), 'an interpolated secret survives into the stack too');
});

test('a value too short to mask safely is left alone rather than shredding the log', () => {
  // A two-character password would turn every stray "ab" into a mask. Such a
  // password is refused at entry (see the credential validator) instead.
  const redact = createRedactor(['ab']);
  assert.equal(redact.text('a fabulous label'), 'a fabulous label');
  assert.equal(redact.count, 0);
});

test('a redactor with no secrets is a pass-through, so callers never branch', () => {
  const redact = createRedactor([]);
  assert.equal(redact.text('anything at all'), 'anything at all');
  assert.equal(redact.isClean('anything'), true);
});

test('redaction survives a cyclic structure instead of hanging the runner', () => {
  const redact = createRedactor(['hunter2-correct-horse']);
  const cyclic = { name: 'hunter2-correct-horse' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => redact.deep(cyclic));
});
