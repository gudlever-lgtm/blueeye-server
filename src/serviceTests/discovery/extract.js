'use strict';

const { numOrNull } = require('../storage/shape');

const { classifyElement } = require('./safety');

// Turns a raw page snapshot into the structured record Discovery stores.
//
// PURE — no browser, no DOM. crawl.js runs a small script in the page and hands
// the resulting plain objects here, which means every extraction rule (what
// counts as a login field, which hints a target keeps, how a form is summarised)
// is unit-testable without launching anything.
//
// The snapshot shape crawl.js produces:
//   { url, title, status, redirectedTo, loadMs, links[], buttons[], inputs[],
//     forms[], selects[], consoleErrors[], requests[] }

const MAX_PER_KIND = 200;
const trim = (v, n = 512) => (v === null || v === undefined ? null : String(v).slice(0, n));

// The hints that become a DSL target. Everything known is kept, in the priority
// order the runner will try — a changed id must not break a test that also knows
// the role and the accessible name (spec §16).
function targetFor(el) {
  const target = {};
  if (el.role) target.role = trim(el.role, 40);
  if (el.accessibleName || el.ariaLabel) target.name = trim(el.accessibleName || el.ariaLabel, 255);
  if (el.label) target.label = trim(el.label, 255);
  if (el.text) target.text = trim(el.text, 255);
  if (el.placeholder) target.placeholder = trim(el.placeholder, 255);
  if (el.name) target.name = target.name || trim(el.name, 255);
  if (el.id) target.id = trim(el.id, 255);
  if (!Object.keys(target).length && el.css) target.css = trim(el.css, 512);
  return Object.keys(target).length ? target : null;
}

// Login heuristics (spec §7). Deliberately reported as POSSIBLE — Discovery must
// never claim certainty about a login flow.
const USERNAME_HINTS = ['user', 'username', 'brugernavn', 'email', 'e-mail', 'mail', 'login', 'logon', 'account'];
const PASSWORD_HINTS = ['password', 'passwd', 'pass', 'adgangskode', 'kodeord'];
const LOGIN_BUTTON_HINTS = ['log in', 'login', 'log ind', 'sign in', 'signin', 'log on', 'logon', 'continue', 'fortsæt'];

const haystack = (el) => [el.label, el.name, el.id, el.placeholder, el.ariaLabel, el.autocomplete, el.text]
  .filter(Boolean).join(' ').toLowerCase();

function isPasswordField(input) {
  if (String(input.type).toLowerCase() === 'password') return true;
  if (String(input.autocomplete || '').toLowerCase().includes('current-password')) return true;
  const h = haystack(input);
  return PASSWORD_HINTS.some((w) => h.includes(w));
}

function isUsernameField(input) {
  const type = String(input.type || '').toLowerCase();
  if (type === 'password') return false;
  const auto = String(input.autocomplete || '').toLowerCase();
  if (auto === 'username' || auto === 'email') return true;
  if (type === 'email') return true;
  const h = haystack(input);
  return USERNAME_HINTS.some((w) => h.includes(w));
}

function isLoginButton(button) {
  const h = haystack(button);
  return LOGIN_BUTTON_HINTS.some((w) => h.includes(w));
}

// The verdict for ONE page: does it look like it carries a sign-in flow?
// Requires a password field — everything else is corroboration. Without one,
// there is no login here, however suggestive the wording.
function detectLogin(inputs = [], buttons = [], url = '') {
  const password = inputs.filter(isPasswordField);
  if (!password.length) return { possible: false, confidence: null, reasons: [] };

  const username = inputs.filter(isUsernameField);
  const loginButtons = buttons.filter(isLoginButton);
  const urlHints = /login|signin|sign-in|logon|auth/i.test(String(url));

  const reasons = [`Detected ${password.length} password field${password.length === 1 ? '' : 's'}`];
  if (username.length) reasons.push(`a username or email field ("${username[0].label || username[0].name || username[0].placeholder || 'unnamed'}")`);
  if (loginButtons.length) reasons.push(`a "${(loginButtons[0].text || loginButtons[0].ariaLabel || 'login').trim()}" button`);
  if (urlHints) reasons.push('a sign-in style address');

  // Three or more corroborating signals reads as high; a lone password field is
  // low, because a change-password form looks exactly like that too.
  const signals = 1 + (username.length ? 1 : 0) + (loginButtons.length ? 1 : 0) + (urlHints ? 1 : 0);
  const confidence = signals >= 3 ? 'high' : (signals === 2 ? 'medium' : 'low');

  return {
    possible: true,
    confidence,
    reasons,
    username_field: username[0] ? targetFor(username[0]) : null,
    password_field: targetFor(password[0]),
    submit: loginButtons[0] ? targetFor(loginButtons[0]) : null,
  };
}

// Extracts the storable element rows for one page. Every element carries its
// safety verdict, so the crawler never has to re-derive it and the UI can show
// why something was left alone.
function extractElements(snapshot = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const out = [];

  const push = (kind, raw, extra = {}) => {
    const verdict = classifyElement({ kind, ...raw });
    out.push({
      kind,
      label: trim(raw.label || raw.text || raw.ariaLabel || raw.name || raw.placeholder || raw.action, 512),
      attributes: {
        ...raw,
        target: targetFor(raw),
        safety_reason: verdict.reason || verdict.safe_reason || null,
      },
      possible_login: !!extra.possibleLogin,
      potentially_destructive: verdict.destructive,
    });
  };

  const login = detectLogin(s.inputs || [], s.buttons || [], s.url);

  for (const link of (s.links || []).slice(0, MAX_PER_KIND)) push('link', link);
  for (const button of (s.buttons || []).slice(0, MAX_PER_KIND)) {
    push('button', button, { possibleLogin: login.possible && isLoginButton(button) });
  }
  for (const input of (s.inputs || []).slice(0, MAX_PER_KIND)) {
    push('input', input, { possibleLogin: login.possible && (isPasswordField(input) || isUsernameField(input)) });
  }
  for (const form of (s.forms || []).slice(0, MAX_PER_KIND)) push('form', form);
  for (const select of (s.selects || []).slice(0, MAX_PER_KIND)) push('select', select);

  return { elements: out, login };
}

// The page row itself.
function extractPage(snapshot = {}, depth = 0) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const failed = (s.requests || []).filter((r) => r && (Number(r.status) >= 400 || Number(r.status) === 0));
  return {
    url: trim(s.url, 1024) || '',
    title: trim(s.title, 512),
    // Not `Number(s.status)`: that turns a missing status into 0, and 0 is a
    // REAL value here — apiLog uses it for "the request never completed".
    http_status: numOrNull(s.status),
    redirected_to: s.redirectedTo && s.redirectedTo !== s.url ? trim(s.redirectedTo, 1024) : null,
    depth,
    // Same trap, worse consequence: an unmeasured page would report as having
    // loaded in 0 ms — the fastest page in the estate.
    load_ms: numOrNull(s.loadMs),
    console_errors: (s.consoleErrors || []).slice(0, 50).map((e) => trim(e, 500)),
    failed_requests: failed.slice(0, 50).map((r) => ({ url: trim(r.url, 512), status: Number(r.status) || 0 })),
  };
}

module.exports = {
  extractPage, extractElements, detectLogin, targetFor,
  isPasswordField, isUsernameField, isLoginButton,
  USERNAME_HINTS, PASSWORD_HINTS, LOGIN_BUTTON_HINTS,
};
