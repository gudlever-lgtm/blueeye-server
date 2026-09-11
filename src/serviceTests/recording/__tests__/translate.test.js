'use strict';

// Specs for recording → DSL (docs/service-assurance-v2.md §1).
//
// The rule the whole file defends: recording must not introduce a second test
// model. What comes out is the same definition the designer edits, the validator
// checks and the runner executes — so a recorded test is indistinguishable from
// a hand-built one the moment it is saved.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { translateRecording, pathOf, isSecretField, isUsernameField, RECORDED_STEP_TYPES } = require('../translate');
const { validateDefinition } = require('../../engine/validate');
const { STEP_TYPES } = require('../../engine/dsl');

const BASE = 'https://fellis.eu';
const ev = (kind, over = {}) => ({ kind, at: over.at || 1, ...over });

// The journey from the V2 spec: open, type a username, type a password, submit.
const LOGIN_SESSION = [
  ev('navigate', { at: 1, url: 'https://fellis.eu/login' }),
  ev('click', { at: 2, tagName: 'INPUT', target: { label: 'E-mail' } }),
  ev('input', { at: 3, tagName: 'INPUT', inputType: 'email', target: { label: 'E-mail' }, value: 'operator@kunde.dk' }),
  ev('input', { at: 4, tagName: 'INPUT', inputType: 'password', target: { label: 'Kodeord' }, value: 'hunter2-correct-horse' }),
  ev('click', { at: 5, tagName: 'BUTTON', target: { role: 'button', name: 'Log ind' } }),
];

test('a recorded session becomes a definition the existing validator accepts', () => {
  // The whole point: no second test model. If this ever fails, recording has
  // started emitting something the designer and runner do not understand.
  const { definition } = translateRecording(LOGIN_SESSION, { name: 'Customer Login', baseUrl: BASE });
  const { errors } = validateDefinition(definition);
  assert.equal(errors, undefined, JSON.stringify(errors));
  assert.equal(definition.version, 1);
  assert.equal(definition.name, 'Customer Login');
  for (const step of definition.steps) {
    assert.ok(STEP_TYPES.includes(step.type), `${step.type} is not a DSL step type`);
    assert.ok(RECORDED_STEP_TYPES.includes(step.type), `${step.type} is outside what recording may emit`);
  }
});

test('a recorded password is NEVER stored as a literal', () => {
  // It would otherwise reach the definition, the version history, the audit log
  // and the designer's screen. It becomes the reference the DSL already has.
  const { definition, requires_credential: needsCredential } = translateRecording(LOGIN_SESSION, { baseUrl: BASE });
  const json = JSON.stringify(definition);
  assert.ok(!json.includes('hunter2-correct-horse'), 'the password reached the definition');
  assert.ok(json.includes('{{credential.password}}'));
  assert.equal(needsCredential, true, 'the designer has to know to require a credential on save');
});

test('a username is a credential reference too, so the test is not pinned to one account', () => {
  const { definition } = translateRecording(LOGIN_SESSION, { baseUrl: BASE });
  const fill = definition.steps.find((s) => s.type === 'fill');
  assert.equal(fill.value, '{{credential.username}}');
  assert.ok(!JSON.stringify(definition).includes('operator@kunde.dk'));
});

test('a secret field is recognised by type OR by name, not by type alone', () => {
  assert.equal(isSecretField({ inputType: 'password' }), true);
  assert.equal(isSecretField({ inputType: 'text', autocomplete: 'current-password' }), true);
  assert.equal(isSecretField({ inputType: 'text', target: { name: 'pwd' } }), true);
  assert.equal(isSecretField({ inputType: 'text', target: { id: 'adgangskode' } }), true);
  // And a field that merely CONTAINS the letters is not one.
  assert.equal(isSecretField({ inputType: 'text', target: { name: 'passwordless_hint' } }), false);
  assert.equal(isSecretField({ inputType: 'text', target: { name: 'search' } }), false);
  assert.equal(isSecretField(null), false);
});

test('a username field is recognised without swallowing every text box', () => {
  assert.equal(isUsernameField({ inputType: 'email' }), true);
  assert.equal(isUsernameField({ inputType: 'text', target: { label: 'Brugernavn' } }), true);
  assert.equal(isUsernameField({ inputType: 'text', target: { name: 'search' } }), false);
  assert.equal(isUsernameField({ inputType: 'text', target: { label: 'Company' } }), false);
});

test('typing collapses to one fill with the final value', () => {
  // A test that types "a", "ad", "adm", "admi", "admin" is not a test anyone
  // wrote or wants to read.
  const events = [
    ev('navigate', { at: 1, url: 'https://fellis.eu/search' }),
    ...'admin'.split('').map((_, i) => ev('input', {
      at: 2 + i, tagName: 'INPUT', target: { label: 'Search' }, value: 'admin'.slice(0, i + 1),
    })),
  ];
  const { definition } = translateRecording(events, { baseUrl: BASE });
  const fills = definition.steps.filter((s) => s.type === 'fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].value, 'admin');
});

test('typing into a DIFFERENT field is a new step, not a collapse', () => {
  const events = [
    ev('input', { at: 1, tagName: 'INPUT', target: { label: 'First' }, value: 'a' }),
    ev('input', { at: 2, tagName: 'INPUT', target: { label: 'Last' }, value: 'b' }),
    ev('input', { at: 3, tagName: 'INPUT', target: { label: 'First' }, value: 'ab' }),
  ];
  const { definition } = translateRecording(events, { baseUrl: BASE });
  assert.deepEqual(definition.steps.map((s) => s.target.label), ['First', 'Last', 'First']);
});

test('the click that only focuses a field is dropped', () => {
  // Clicking into a box and typing produces a click AND an input on the same
  // element; the click says nothing the fill does not already imply.
  const { definition } = translateRecording(LOGIN_SESSION, { baseUrl: BASE });
  assert.deepEqual(definition.steps.map((s) => s.type), ['open', 'fill', 'fill', 'click']);
  assert.equal(definition.steps[3].target.name, 'Log ind', 'the SUBMIT click is kept');
});

test('a click on a real control is never dropped', () => {
  const events = [
    ev('click', { at: 1, tagName: 'BUTTON', target: { role: 'button', name: 'Accept' } }),
    ev('click', { at: 2, tagName: 'A', target: { text: 'Customers' } }),
  ];
  const { definition } = translateRecording(events, { baseUrl: BASE });
  assert.equal(definition.steps.length, 2);
  assert.deepEqual(definition.steps.map((s) => s.type), ['click', 'click']);
});

test('a recorded address becomes a PATH, so the test runs against any environment', () => {
  assert.equal(pathOf('https://fellis.eu/login?next=/feed', BASE), '/login?next=/feed');
  assert.equal(pathOf('https://fellis.eu', BASE), '/');
  // A different host is kept whole — it is not this application's page, and
  // rewriting it to a path would point the step at the wrong site.
  assert.equal(pathOf('https://accounts.google.com/o/oauth2', BASE), 'https://accounts.google.com/o/oauth2');
  assert.equal(pathOf('not a url', BASE), 'not a url');
});

test('a repeated navigation to the page we are already on is not a step', () => {
  const events = [
    ev('navigate', { at: 1, url: 'https://fellis.eu/feed' }),
    ev('navigate', { at: 2, url: 'https://fellis.eu/feed' }),
    ev('navigate', { at: 3, url: 'https://fellis.eu/profile' }),
  ];
  const { definition } = translateRecording(events, { baseUrl: BASE });
  assert.deepEqual(definition.steps.map((s) => s.url), ['/feed', '/profile']);
});

test('selects and checkboxes carry their value', () => {
  const events = [
    ev('select', { at: 1, tagName: 'SELECT', target: { label: 'Country' }, value: 'DK' }),
    ev('check', { at: 2, tagName: 'INPUT', target: { label: 'Remember me' }, checked: true }),
    ev('check', { at: 3, tagName: 'INPUT', target: { label: 'Newsletter' }, checked: false }),
  ];
  const { definition } = translateRecording(events, { baseUrl: BASE });
  assert.deepEqual(definition.steps, [
    { type: 'select', target: { label: 'Country' }, value: 'DK' },
    { type: 'checkbox', target: { label: 'Remember me' }, checked: true },
    { type: 'checkbox', target: { label: 'Newsletter' }, checked: false },
  ]);
  assert.equal(validateDefinition(definition).errors, undefined);
});

test('events arrive in time order even when the transport did not deliver them in it', () => {
  const shuffled = [LOGIN_SESSION[4], LOGIN_SESSION[0], LOGIN_SESSION[3], LOGIN_SESSION[1], LOGIN_SESSION[2]];
  const { definition } = translateRecording(shuffled, { baseUrl: BASE });
  assert.deepEqual(definition.steps.map((s) => s.type), ['open', 'fill', 'fill', 'click']);
});

test('a recording full of things this does not understand still yields the steps it does', () => {
  // It arrives from a browser: truncated, out of order, or carrying events from
  // a version that did not exist when the session started. Four good steps beat
  // an error.
  const events = [
    null, 42, 'nonsense', {},
    ev('wheel', { at: 1, target: { id: 'x' } }),
    ev('click', { at: 2, tagName: 'BUTTON', target: { role: 'button', name: 'Go' } }),
    ev('click', { at: 3, tagName: 'BUTTON' }), // no target at all
  ];
  let out;
  assert.doesNotThrow(() => { out = translateRecording(events, { baseUrl: BASE }); });
  assert.equal(out.definition.steps.length, 1);
  assert.equal(out.definition.steps[0].target.name, 'Go');
});

test('translating nothing is an empty definition, not a crash — and it is not saveable', () => {
  for (const input of [undefined, null, [], 'x', 42, {}]) {
    const out = translateRecording(input, { baseUrl: BASE });
    assert.deepEqual(out.definition.steps, []);
    assert.equal(out.requires_credential, false);
  }
  // The validator refuses a stepless test, which is correct: a recording where
  // the operator did nothing is not a test. So the UI must not offer "save" on
  // an empty recording rather than letting the server produce the error.
  const { errors } = validateDefinition(translateRecording([], { baseUrl: BASE }).definition);
  assert.match(errors.steps, /at least one step/);
});

test('an over-long name is bounded rather than rejected', () => {
  const { definition } = translateRecording([], { name: 'n'.repeat(500) });
  assert.equal(definition.name.length, 255);
});

test('a navigation that followed a click becomes an assertion, not a second open', () => {
  const { definition } = translateRecording([
    { kind: 'navigate', at: 1, url: 'https://portal.kunde.dk/login' },
    { kind: 'click', at: 2, target: { role: 'button', name: 'Log ind' }, tagName: 'BUTTON' },
    { kind: 'navigate', at: 3, url: 'https://portal.kunde.dk/dashboard' },
  ], { baseUrl: 'https://portal.kunde.dk' });

  assert.deepEqual(definition.steps.map((s) => s.type), ['open', 'click', 'assert_url_contains']);
  assert.equal(definition.steps[2].value, '/dashboard');
  // Replaying it as `open` would make the test navigate straight to /dashboard
  // and pass whether or not the login that was supposed to take it there worked.
  assert.ok(!definition.steps.slice(1).some((s) => s.type === 'open'), 'a consequence was replayed as an instruction');
});

test('a navigation the operator performed is still an open', () => {
  const { definition } = translateRecording([
    { kind: 'navigate', at: 1, url: 'https://portal.kunde.dk/a' },
    { kind: 'navigate', at: 2, url: 'https://portal.kunde.dk/b' },
  ], { baseUrl: 'https://portal.kunde.dk' });
  assert.deepEqual(definition.steps.map((s) => s.type), ['open', 'open']);
});
