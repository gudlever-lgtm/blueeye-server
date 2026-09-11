'use strict';

// The ingest scrubber. This is the boundary where data written by a script on a
// page BlueEye does not control becomes rows in BlueEye's database, so the specs
// here are about what does NOT get through.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateCaptureBatch, validateRecordingStart, cleanEvent, cleanTarget } = require('../validate');
const { isSecretField, isUsernameField } = require('../secrets');

test('a password field never keeps its value, however the event is dressed up', () => {
  const disguises = [
    { kind: 'input', inputType: 'password', target: { id: 'x' }, value: 'hunter2' },
    { kind: 'input', inputType: 'PASSWORD', target: { id: 'x' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { id: 'user_password' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { name: 'pwd' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { label: 'Adgangskode' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { label: 'Kodeord' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { placeholder: 'Enter your password' }, value: 'hunter2' },
    { kind: 'input', inputType: 'text', target: { id: 'a' }, autocomplete: 'current-password', value: 'hunter2' },
  ];
  for (const raw of disguises) {
    const cleaned = cleanEvent(raw);
    assert.ok(cleaned, JSON.stringify(raw));
    assert.equal(cleaned.value, null, `value survived: ${JSON.stringify(raw)}`);
    assert.ok(isSecretField(cleaned), `not recognised as secret: ${JSON.stringify(raw)}`);
  }
});

test('an ordinary field keeps its value — the scrubber is not a blanket', () => {
  const cleaned = cleanEvent({ kind: 'input', inputType: 'text', target: { label: 'Kundenummer' }, value: '4711' });
  assert.equal(cleaned.value, '4711');
  assert.equal(isSecretField(cleaned), false);
  assert.equal(isUsernameField(cleaned), false);
});

test('a username field is recognised, and a password field is never also a username', () => {
  assert.ok(isUsernameField({ inputType: 'text', target: { label: 'Brugernavn' } }));
  assert.ok(isUsernameField({ inputType: 'email', target: { id: 'x' } }));
  // "Bekræft adgangskode" mentions neither, but must not be misread as a login.
  assert.equal(isUsernameField({ inputType: 'password', target: { label: 'Bekræft adgangskode' } }), false);
});

test('only recognised target keys survive — an unknown key is data nobody agreed to store', () => {
  const target = cleanTarget({
    role: 'button', name: 'Log ind', label: 'x', text: 'y', placeholder: 'z', id: 'b', css: 'div > button',
    onclick: 'alert(1)', innerHTML: '<script>', dataset: { token: 'secret' },
  });
  assert.deepEqual(Object.keys(target).sort(), ['css', 'id', 'label', 'name', 'placeholder', 'role', 'text']);
});

test('an unusable event is dropped rather than stored', () => {
  for (const raw of [null, 42, 'nope', [], {}, { kind: 'teleport' }, { kind: 'click' }, { kind: 'navigate' }]) {
    assert.equal(cleanEvent(raw), null, JSON.stringify(raw));
  }
  // A navigation needs a URL; a click needs something to point at.
  assert.ok(cleanEvent({ kind: 'navigate', url: 'https://x.dk/a' }));
  assert.ok(cleanEvent({ kind: 'click', target: { id: 'b' } }));
});

test('the batch is bounded: token length, event count and field length', () => {
  assert.ok(validateCaptureBatch({ token: 'x'.repeat(200) }).errors);
  assert.ok(validateCaptureBatch({ token: '' }).errors);
  assert.ok(validateCaptureBatch({ token: 't', events: 'no' }).errors);
  assert.ok(validateCaptureBatch(null).errors);
  assert.ok(validateCaptureBatch([]).errors);

  const flood = Array.from({ length: 5000 }, () => ({ kind: 'click', target: { id: 'b' } }));
  const { value } = validateCaptureBatch({ token: 't', events: flood });
  assert.equal(value.events.length, 200, 'the batch cap must hold');

  const long = validateCaptureBatch({
    token: 't',
    events: [{ kind: 'input', inputType: 'text', target: { id: 'a', label: 'L'.repeat(5000) }, value: 'v'.repeat(5000) }],
  });
  assert.ok(long.value.events[0].value.length <= 512);
  assert.ok(long.value.events[0].target.label.length <= 512);
});

test('starting a recording bounds its lifetime', () => {
  assert.ok(validateRecordingStart({}).errors);
  assert.ok(validateRecordingStart({ application_id: 0, name: 'x' }).errors);
  assert.ok(validateRecordingStart({ application_id: 1, name: '' }).errors);
  assert.ok(validateRecordingStart({ application_id: 1, name: 'x', ttl_minutes: 0 }).errors);
  assert.ok(validateRecordingStart({ application_id: 1, name: 'x', ttl_minutes: 241 }).errors);
  assert.deepEqual(validateRecordingStart({ application_id: '2', name: ' Login ', ttl_minutes: 30 }).value,
    { application_id: 2, name: 'Login', ttl_minutes: 30 });
});
