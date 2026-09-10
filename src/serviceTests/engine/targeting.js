'use strict';

const { TARGET_STRATEGIES } = require('./dsl');

// Smart element targeting (spec §16).
//
// The operator never writes a CSS selector. Discovery records everything it knows
// about an element — its ARIA role and accessible name, its label, its visible
// text, its placeholder, its name attribute, its id — and stores ALL of it on the
// target. At run time the driver tries those strategies in priority order and
// uses the first that resolves.
//
// So a target is a bag of hints, not a selector:
//   { role: 'button', name: 'Login', text: 'Log ind', id: 'login-button' }
//
// A changed id does not break a test that also knows the role and name. That is
// the entire point of keeping every hint rather than the "best" one.
//
// This module is PURE — it decides WHAT to try and in which order. How a strategy
// is executed belongs to the driver.

// The legacy/simple form Discovery and the suggestion rules emit:
//   { type: 'label', value: 'Username' }  →  { label: 'Username' }
// Normalising here means the rest of the engine only ever sees the bag form.
function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const out = {};
  // Explicit { type, value } / { type:'role', role, name } shape.
  if (typeof target.type === 'string' && TARGET_STRATEGIES.includes(target.type)) {
    if (target.type === 'role') {
      if (target.role) out.role = String(target.role);
      if (target.name) out.name = String(target.name);
    } else if (target.value !== undefined) {
      out[target.type] = String(target.value);
    }
  }
  // Bag form — copy any recognised strategy key, plus `name`, which qualifies
  // `role` rather than standing on its own.
  for (const key of [...TARGET_STRATEGIES, 'name']) {
    if (target[key] !== undefined && target[key] !== null && target[key] !== '') {
      out[key] = String(target[key]);
    }
  }
  return Object.keys(out).length ? out : null;
}

// The ordered list of attempts for a target. Each entry is
// { strategy, value, [name] } — data the driver turns into a locator.
//
// `name` alone is ambiguous: it is both the HTML name attribute and the
// accessible name that qualifies a role. When a role is present, `name` belongs
// to the role strategy; otherwise it is the attribute.
function strategiesFor(target) {
  const t = normalizeTarget(target);
  if (!t) return [];
  const out = [];
  for (const strategy of TARGET_STRATEGIES) {
    if (strategy === 'role') {
      if (t.role) out.push({ strategy: 'role', value: t.role, name: t.name || null });
      continue;
    }
    if (strategy === 'name') {
      // Already consumed as the role's accessible name.
      if (t.role) continue;
      if (t.name) out.push({ strategy: 'name', value: t.name });
      continue;
    }
    if (t[strategy]) out.push({ strategy, value: t[strategy] });
  }
  return out;
}

// A short, human-readable description of what the test is pointing at, for logs
// and error messages: "knappen \"Log ind\"" reads better than a locator dump.
function describeTarget(target, { lang = 'da' } = {}) {
  const t = normalizeTarget(target);
  if (!t) return lang === 'da' ? 'elementet' : 'the element';
  const quoted = (v) => `"${v}"`;
  if (t.role && t.name) return lang === 'da' ? `${roleDa(t.role)} ${quoted(t.name)}` : `the ${t.role} ${quoted(t.name)}`;
  if (t.label) return lang === 'da' ? `feltet ${quoted(t.label)}` : `the field ${quoted(t.label)}`;
  if (t.text) return lang === 'da' ? `teksten ${quoted(t.text)}` : `the text ${quoted(t.text)}`;
  if (t.placeholder) return lang === 'da' ? `feltet ${quoted(t.placeholder)}` : `the field ${quoted(t.placeholder)}`;
  if (t.role) return lang === 'da' ? roleDa(t.role) : `the ${t.role}`;
  if (t.name) return lang === 'da' ? `feltet ${quoted(t.name)}` : `the field ${quoted(t.name)}`;
  if (t.id) return lang === 'da' ? `elementet ${quoted(t.id)}` : `the element ${quoted(t.id)}`;
  if (t.css) return lang === 'da' ? 'elementet' : 'the element';
  return lang === 'da' ? 'elementet' : 'the element';
}

function roleDa(role) {
  const map = {
    button: 'knappen', link: 'linket', textbox: 'feltet', checkbox: 'afkrydsningsfeltet',
    combobox: 'listen', heading: 'overskriften', radio: 'valgknappen', tab: 'fanen',
  };
  return map[role] || `elementet (${role})`;
}

// True when the ONLY way to find this element is a CSS selector. The designer
// surfaces that as a warning: such a target breaks the moment the markup changes,
// and it is the one case where the no-code promise leaks.
function isCssOnly(target) {
  const s = strategiesFor(target);
  return s.length === 1 && s[0].strategy === 'css';
}

module.exports = { normalizeTarget, strategiesFor, describeTarget, isCssOnly };
