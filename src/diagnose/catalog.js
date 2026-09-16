'use strict';

const fs = require('fs');
const path = require('path');
const { compile, ExprError } = require('./expr');
const { isKnownFactPath } = require('./facts');

// The playbook catalogue — the whole of what BlueEyes knows about network faults
// that a person can add to without writing code.
//
// One JSON file per playbook in ./playbooks, read and VALIDATED at startup. That
// last word is the design: a playbook is data, data is where mistakes live
// quietly, and a rule that does not parse must fail on the day it is written
// rather than on the day somebody is standing in front of an outage waiting for
// an answer. So every rule is compiled here, every test type is checked against
// the probes that actually exist, every view against the screens that actually
// exist, and every placeholder in a fix against the fields the rules can read.
// A bad playbook stops the server.
//
// Files rather than a table, because this is the thing the acceptance criteria
// ask to be addable without a code change, and a file gets that plus review,
// history, and a CI run that catches it before it ships. A per-customer overlay
// can go in app_settings later without changing the shape of any of this.

const PLAYBOOK_DIR = path.join(__dirname, 'playbooks');

// A test a playbook may ask for must be a probe the agent can actually run.
// Imported rather than restated: the day a probe type is added or removed, this
// list moves with it instead of drifting away from it.
const { PROBE_TYPES } = require('../validation/probeValidation');

// Dashboard views a playbook may deep-link to. Deliberately a short allowlist
// rather than "any string": a link that goes nowhere is worse than no link,
// because the reader assumes the screen exists and that they are missing it.
// Keep in step with public/index.html's data-view buttons.
const VIEWS = [
  'probes', 'flows', 'interfaces', 'topology', 'overview', 'fleet',
  'clusters', 'findings', 'events', 'agents', 'nics', 'troubleshooting',
  'serviceAssurance', 'transactions', 'geo', 'changes',
];

const EFFECTS = ['confirm', 'rule_out'];

// Every human-readable string in a playbook is { en, da }, and BOTH must be
// present. The alternative — English with Danish where somebody got round to it
// — is how a screen ends up half-translated, and the fixtures this module is
// judged on are Danish sentences a Danish technician typed. The catalogue is
// also the MATCHER's input: a playbook with no Danish keywords cannot be found
// by anybody describing the fault in Danish, and the failure is silent.
const LOCALES = Object.freeze(['en', 'da']);
const DEFAULT_LOCALE = 'en';

// Pulls a { en, da } value, insisting on both. `field` only ever appears in the
// error, so a bad playbook says which string it is.
function i18nString(file, field, value, max = LIMITS.text) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CatalogError(file, `${field} must be an object with an entry for each of ${LOCALES.join(', ')}`);
  }
  const out = {};
  for (const loc of LOCALES) {
    const v = value[loc];
    if (!isStr(v) || v.length > max) throw new CatalogError(file, `${field}.${loc} is required and must be under ${max} characters`);
    out[loc] = v.trim();
  }
  return out;
}

function i18nList(file, field, value, maxItems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CatalogError(file, `${field} must be an object with an array for each of ${LOCALES.join(', ')}`);
  }
  const out = {};
  for (const loc of LOCALES) {
    out[loc] = checkStringList(file, `${field}.${loc}`, value[loc], maxItems);
  }
  return out;
}

// Bounds. A playbook is a page of text, not a document.
const LIMITS = {
  id: 64, title: 120, summary: 200, symptoms: 30, keywords: 60,
  explanation: 1000, tests: 8, views: 8, rules: 12, fixes: 8,
  text: 500,
};

const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
// A placeholder in a fix: {path_mtu.recommended_mss}. It is filled from the same
// facts the rules read, so it can only name a path a rule could also have named.
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

class CatalogError extends Error {
  constructor(file, message) {
    super(`playbook ${file}: ${message}`);
    this.name = 'CatalogError';
  }
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const lower = (v) => String(v).trim().toLowerCase();

function checkStringList(file, field, value, maxItems) {
  if (!Array.isArray(value) || value.length === 0) throw new CatalogError(file, `${field} must be a non-empty array`);
  if (value.length > maxItems) throw new CatalogError(file, `${field} has more than ${maxItems} entries`);
  return value.map((v) => {
    if (!isStr(v) || v.length > LIMITS.text) throw new CatalogError(file, `${field} entries must be non-empty strings under ${LIMITS.text} characters`);
    return v.trim();
  });
}

function parsePlaybook(file, raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CatalogError(file, `is not valid JSON (${err.message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CatalogError(file, 'must be a JSON object');

  if (!isStr(doc.id) || !ID_RE.test(doc.id)) throw new CatalogError(file, 'id must be lower_snake_case, 2-63 characters');
  const title = i18nString(file, 'title', doc.title, LIMITS.title);
  const explanation = i18nString(file, 'explanation', doc.explanation, LIMITS.explanation);
  const summary = doc.summary === undefined ? null : i18nString(file, 'summary', doc.summary, LIMITS.summary);

  const symptoms = i18nList(file, 'symptoms', doc.symptoms, LIMITS.symptoms);
  const keywords = i18nList(file, 'keywords', doc.keywords, LIMITS.keywords);
  if (!Array.isArray(doc.fixes) || doc.fixes.length === 0) throw new CatalogError(file, 'fixes must be a non-empty array');
  if (doc.fixes.length > LIMITS.fixes) throw new CatalogError(file, `more than ${LIMITS.fixes} fixes`);
  const fixes = doc.fixes.map((f, i) => i18nString(file, `fixes[${i}]`, f));

  // --- tests ---------------------------------------------------------------
  if (!Array.isArray(doc.tests) || doc.tests.length === 0) throw new CatalogError(file, 'tests must be a non-empty array');
  if (doc.tests.length > LIMITS.tests) throw new CatalogError(file, `more than ${LIMITS.tests} tests`);
  const tests = doc.tests.map((t, i) => {
    if (!t || typeof t !== 'object') throw new CatalogError(file, `tests[${i}] must be an object`);
    if (!PROBE_TYPES.includes(t.type)) {
      throw new CatalogError(file, `tests[${i}].type "${t.type}" is not a probe this server can run (${PROBE_TYPES.join(', ')})`);
    }
    if (t.params !== undefined && (t.params === null || typeof t.params !== 'object' || Array.isArray(t.params))) {
      throw new CatalogError(file, `tests[${i}].params must be an object`);
    }
    // A test nobody can explain is a test nobody should run.
    const why = i18nString(file, `tests[${i}].why`, t.why);
    return { type: t.type, params: t.params ? { ...t.params } : {}, why };
  });

  // --- views ---------------------------------------------------------------
  if (!Array.isArray(doc.views)) throw new CatalogError(file, 'views must be an array');
  if (doc.views.length > LIMITS.views) throw new CatalogError(file, `more than ${LIMITS.views} views`);
  const views = doc.views.map((v, i) => {
    if (!v || typeof v !== 'object') throw new CatalogError(file, `views[${i}] must be an object`);
    if (!VIEWS.includes(v.view)) throw new CatalogError(file, `views[${i}].view "${v.view}" is not a screen in this dashboard (${VIEWS.join(', ')})`);
    // A link without "what am I looking at" is a dead end.
    const lookFor = i18nString(file, `views[${i}].look_for`, v.look_for);
    if (v.params !== undefined && (v.params === null || typeof v.params !== 'object' || Array.isArray(v.params))) {
      throw new CatalogError(file, `views[${i}].params must be an object`);
    }
    return { view: v.view, params: v.params ? { ...v.params } : {}, look_for: lookFor };
  });

  // --- rules ---------------------------------------------------------------
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) throw new CatalogError(file, 'rules must be a non-empty array');
  if (doc.rules.length > LIMITS.rules) throw new CatalogError(file, `more than ${LIMITS.rules} rules`);
  const seenRuleIds = new Set();
  const readablePaths = new Set();
  const rules = doc.rules.map((r, i) => {
    if (!r || typeof r !== 'object') throw new CatalogError(file, `rules[${i}] must be an object`);
    if (!isStr(r.id) || !ID_RE.test(r.id)) throw new CatalogError(file, `rules[${i}].id must be lower_snake_case`);
    if (seenRuleIds.has(r.id)) throw new CatalogError(file, `two rules share the id "${r.id}"`);
    seenRuleIds.add(r.id);
    if (!EFFECTS.includes(r.effect)) throw new CatalogError(file, `rules[${i}].effect must be one of ${EFFECTS.join(', ')}`);
    // A verdict without its reason is not explainable, which is the one thing
    // every result in this product is required to be.
    const because = i18nString(file, `rules[${i}].because`, r.because);
    let compiled;
    try {
      compiled = compile(r.when);
    } catch (err) {
      if (err instanceof ExprError) throw new CatalogError(file, `rules[${i}] (${r.id}): ${err.message}`);
      throw err;
    }
    // Every field a rule names must be one the fact builder can actually
    // produce. A typo'd path would otherwise evaluate to "unknown" for ever —
    // which looks exactly like "the test has not run", so the playbook would sit
    // there being permanently inconclusive with nothing anywhere saying why.
    for (const fp of compiled.paths) {
      if (!isKnownFactPath(fp)) {
        throw new CatalogError(file, `rules[${i}] (${r.id}) reads "${fp}", which is not a fact BlueEyes measures — see FACT_SCHEMA in src/diagnose/facts.js`);
      }
      readablePaths.add(fp);
    }
    return { id: r.id, effect: r.effect, when: compiled.source, because, paths: compiled.paths, run: compiled.run };
  });
  if (!rules.some((r) => r.effect === 'confirm')) throw new CatalogError(file, 'has no rule that can confirm it — then it can never be an answer');

  // --- fixes: every placeholder must be fillable ----------------------------
  // A fix that says "clamp MSS to {path_mtu.recommended_mss}" is only useful if
  // something measures that. Checked against the fact schema rather than against
  // this playbook's own rules: a fix may legitimately quote a number no rule
  // needed to reach its verdict — the MSS to clamp to is exactly that — and
  // requiring a rule to read it first would push made-up rules into playbooks.
  for (const fix of fixes.flatMap((f) => LOCALES.map((l) => f[l]))) {
    for (const m of fix.matchAll(PLACEHOLDER_RE)) {
      if (!isKnownFactPath(m[1])) {
        throw new CatalogError(file, `fix references {${m[1]}}, which is not a fact BlueEyes measures — see FACT_SCHEMA in src/diagnose/facts.js`);
      }
    }
  }

  return {
    id: doc.id,
    title,
    summary,
    explanation,
    symptoms,
    keywords: Object.fromEntries(LOCALES.map((l) => [l, [...new Set(keywords[l].map(lower))]])),
    // Pre-lowered symptom text per locale, so matching never re-does this per
    // request. The matcher reads every locale at once: a Danish technician
    // pasting an English error message must still find the playbook.
    symptomsLower: Object.fromEntries(LOCALES.map((l) => [l, symptoms[l].map(lower)])),
    tests,
    views,
    rules,
    fixes,
  };
}

// Loads every playbook in `dir`. Throws on the first bad one — see the module
// note: this runs at startup so it can.
function loadCatalog({ dir = PLAYBOOK_DIR, readDir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const files = readDir(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no playbooks found in ${dir}`);
  const byId = new Map();
  for (const file of files) {
    const pb = parsePlaybook(file, readFile(path.join(dir, file), 'utf8'));
    if (byId.has(pb.id)) throw new CatalogError(file, `id "${pb.id}" is already used by another playbook`);
    // The filename is the id, so a reader looking for `mtu_blackhole` finds
    // mtu_blackhole.json and not a file that merely happens to declare it.
    if (`${pb.id}.json` !== file) throw new CatalogError(file, `must be named ${pb.id}.json to match its id`);
    byId.set(pb.id, pb);
  }
  const all = [...byId.values()];
  return {
    list: () => all,
    get: (id) => byId.get(String(id)) || null,
    has: (id) => byId.has(String(id)),
    ids: () => [...byId.keys()],
    size: all.length,
    // The compact form the LLM is shown: enough to choose from, and nothing it
    // could quote back as though it were a measurement.
    summaries: (locale = DEFAULT_LOCALE) => all.map((p) => ({
      id: p.id,
      title: p.title[locale] ?? p.title[DEFAULT_LOCALE],
      symptoms: p.symptoms[locale] ?? p.symptoms[DEFAULT_LOCALE],
    })),
  };
}

// Renders one playbook into a single locale — the shape the API returns. The
// locale is a PARAMETER, never module state: a server renders for several users
// at once, and a shared "current language" is how one request's Danish ends up
// in another request's English answer (the same reason src/nis2/i18n.js is
// built the way it is).
function localize(pb, locale = DEFAULT_LOCALE) {
  if (!pb) return null;
  const loc = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const pick = (v) => (v ? (v[loc] ?? v[DEFAULT_LOCALE]) : null);
  return {
    id: pb.id,
    title: pick(pb.title),
    summary: pick(pb.summary),
    explanation: pick(pb.explanation),
    symptoms: pick(pb.symptoms),
    tests: pb.tests.map((t) => ({ type: t.type, params: t.params, why: pick(t.why) })),
    views: pb.views.map((v) => ({ view: v.view, params: v.params, look_for: pick(v.look_for) })),
    rules: pb.rules.map((r) => ({ id: r.id, effect: r.effect, when: r.when, because: pick(r.because) })),
    fixes: pb.fixes.map(pick),
  };
}

module.exports = { loadCatalog, parsePlaybook, localize, CatalogError, VIEWS, EFFECTS, LOCALES, DEFAULT_LOCALE, PLAYBOOK_DIR, LIMITS };
