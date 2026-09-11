'use strict';

const { normalizeTarget } = require('../engine/targeting');
const { STEP_TYPES } = require('../engine/dsl');

// Recording → the EXISTING DSL (docs/service-assurance-v2.md §1).
//
// The rule that shapes this whole file: recording must NOT introduce a second
// test model. What comes out here is the same `{ version, name, steps }` the
// designer already edits, the validator already checks and the runner already
// executes — so a recorded test is indistinguishable from a hand-built one the
// moment it is saved, and every feature that exists for one exists for both.
//
// Pure: captured events in, a definition out. No DOM, no database, no clock.
// The browser-side recorder (public/recorder.js) only OBSERVES; every decision
// about what an observation means is made here, where it is testable.
//
// A captured event is deliberately dumb — the recorder does not know the DSL:
//
//   { kind: 'click'|'input'|'change'|'navigate'|'submit'|'select'|'check',
//     at: 1699999999999,
//     url: 'https://portal.kunde.dk/login',
//     target: { role, name, label, text, placeholder, name, id, css },
//     value: 'typed text', checked: true, tagName: 'INPUT', inputType: 'password' }

// Clicks that only move focus into a field produce a `click` AND an `input` on
// the same element; the click is noise the operator never meant to record.
const FOCUSING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

// Typing fires an event per keystroke. Consecutive inputs on the SAME element
// collapse to one `fill` with the final value — a test that types "a", "ad",
// "adm", "admi", "admin" is not a test anyone wrote or wants to read.
function sameTarget(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(normalizeTarget(a) || {}) === JSON.stringify(normalizeTarget(b) || {});
}

// A password field's value is a CREDENTIAL, never a recorded literal. It becomes
// the reference the DSL already has, so the saved test carries no secret at all
// and the runner resolves it from the application's stored credential. Recording
// a real password into a definition would put it in the database, the version
// history, the audit log and the designer's screen.
function isSecretField(event) {
  if (!event) return false;
  if (String(event.inputType || '').toLowerCase() === 'password') return true;
  const hints = `${event.autocomplete || ''} ${(event.target && event.target.name) || ''} ${(event.target && event.target.id) || ''}`.toLowerCase();
  return /(^|[^a-z])(password|passwd|pwd|kodeord|adgangskode)([^a-z]|$)/.test(hints);
}

// Does this look like the username beside a password? Recording it as a literal
// would pin the test to one person's account; the credential reference lets the
// application's stored login drive it.
function isUsernameField(event) {
  if (!event) return false;
  const type = String(event.inputType || '').toLowerCase();
  if (type === 'email') return true;
  const hints = `${event.autocomplete || ''} ${(event.target && event.target.name) || ''} ${(event.target && event.target.id) || ''} ${(event.target && event.target.label) || ''}`.toLowerCase();
  return /(^|[^a-z])(user|username|login|email|e-mail|brugernavn|bruger)([^a-z]|$)/.test(hints);
}

// A path, not an absolute URL: the test must run against whichever environment
// it is pointed at, and a recorded absolute URL would pin it to the one the
// operator happened to record on.
function pathOf(url, baseUrl) {
  try {
    const u = new URL(String(url));
    const base = baseUrl ? new URL(String(baseUrl)) : null;
    // A different host is kept whole — it is not this application's page, and
    // silently rewriting it to a path would point the step at the wrong site.
    if (base && u.host !== base.host) return u.toString();
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return String(url || '/');
  }
}

function stepFor(event, { baseUrl, usedCredential }) {
  const target = normalizeTarget(event.target);
  switch (event.kind) {
    case 'navigate':
      return { type: 'open', url: pathOf(event.url, baseUrl) };
    case 'click':
      return target ? { type: 'click', target } : null;
    case 'submit':
      // A submit with no element of its own is the form being submitted by the
      // Enter key; the click that would have done it was never fired.
      return target ? { type: 'click', target } : null;
    case 'input': {
      if (!target) return null;
      if (isSecretField(event)) {
        usedCredential.value = true;
        return { type: 'fill', target, value: '{{credential.password}}' };
      }
      if (isUsernameField(event)) {
        usedCredential.value = true;
        return { type: 'fill', target, value: '{{credential.username}}' };
      }
      return { type: 'fill', target, value: String(event.value == null ? '' : event.value) };
    }
    case 'select':
      return target ? { type: 'select', target, value: String(event.value == null ? '' : event.value) } : null;
    case 'check':
      return target ? { type: 'checkbox', target, checked: !!event.checked } : null;
    default:
      return null;
  }
}

// Turns a captured session into a definition.
//
//   translateRecording(events, { name, baseUrl }) -> { version, name, steps }
//
// Never throws: a recording arrives from a browser and may be truncated, out of
// order or full of events from a version that did not exist when it started.
// An event this does not understand is dropped, because a recording that yields
// four good steps is worth more than one that yields an error.
function translateRecording(events, { name = 'Recorded test', baseUrl = null } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const ordered = list.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

  const steps = [];
  const usedCredential = { value: false };
  let lastInput = null; // the element the previous step typed into

  for (const event of ordered) {
    // A click that only focuses a field the operator then types into says
    // nothing: the fill already implies reaching the field.
    if (event.kind === 'click' && FOCUSING_TAGS.has(String(event.tagName || '').toUpperCase())) {
      const next = ordered[ordered.indexOf(event) + 1];
      if (next && (next.kind === 'input' || next.kind === 'select' || next.kind === 'check')
        && sameTarget(next.target, event.target)) continue;
    }

    const step = stepFor(event, { baseUrl, usedCredential });
    if (!step) continue;

    // Collapse consecutive typing into the same field to its final value.
    if (step.type === 'fill' && lastInput !== null && sameTarget(steps[lastInput].target, step.target)) {
      steps[lastInput] = step;
      continue;
    }
    // A repeated navigation to the page we are already on is not a step.
    if (step.type === 'open' && steps.length && steps[steps.length - 1].type === 'open'
      && steps[steps.length - 1].url === step.url) continue;

    steps.push(step);
    lastInput = step.type === 'fill' ? steps.length - 1 : null;
  }

  return {
    definition: { version: 1, name: String(name || 'Recorded test').slice(0, 255), steps },
    // The designer needs to know whether to require a credential on save.
    requires_credential: usedCredential.value,
  };
}

// Every step type a recording can produce. Used by the spec to prove the output
// stays inside the DSL the designer and runner already know — a recorder that
// invented a step type would be the second test model this is written to avoid.
const RECORDED_STEP_TYPES = ['open', 'click', 'fill', 'select', 'checkbox'];

module.exports = {
  translateRecording, stepFor, pathOf, isSecretField, isUsernameField, sameTarget,
  RECORDED_STEP_TYPES, STEP_TYPES,
};
