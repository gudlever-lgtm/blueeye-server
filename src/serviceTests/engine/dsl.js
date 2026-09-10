'use strict';

// The Service Tests DSL — version 1.
//
// This is the NEUTRAL description of a test. It never mentions Playwright, a CSS
// selector strategy or an HTTP client: a stored definition is a list of intents
// ("fill the field labelled Username"), and the runner decides how to carry them
// out. That separation is what lets the engine be swapped (WebDriver BiDi, say)
// without touching a single saved test — see docs/service-assurance.md §4.
//
// A definition:
//   { version: 1, name: 'Customer Login', steps: [ {type, ...}, … ] }
//
// Every step type is declared here once, with its category, whether it targets an
// element, and its fields. Validation, the designer's form controls, the plain-
// language label and the runner's dispatch table are all derived from this
// catalogue, so adding a step type is one entry rather than five edits.

const DSL_VERSION = 1;

// How an element is found, in priority order. The runner tries each strategy the
// target carries, in THIS order, and records which one matched. Role and label
// are first because they survive a redesign; css is last because it is the one a
// developer breaks without noticing.
const TARGET_STRATEGIES = ['role', 'label', 'text', 'placeholder', 'name', 'id', 'css'];

// Field types the designer knows how to render and the validator knows how to
// check. `credential` marks a field that may carry a {{credential.*}} reference.
const FIELD_TYPES = ['path', 'text', 'credential', 'int', 'boolean', 'method', 'enum'];

const CATEGORIES = ['navigation', 'interaction', 'validation', 'control', 'authentication', 'technical'];

// target: 'required' | 'optional' | undefined (the step has no element target).
const STEPS = {
  // ---------------------------------------------------------- navigation
  open: {
    category: 'navigation',
    label: 'Åbn side',
    fields: { url: { type: 'path', required: true, max: 1024 } },
  },
  back: { category: 'navigation', label: 'Gå tilbage', fields: {} },
  refresh: { category: 'navigation', label: 'Genindlæs', fields: {} },

  // ---------------------------------------------------------- interaction
  click: { category: 'interaction', label: 'Klik på', target: 'required', fields: {} },
  fill: {
    category: 'interaction',
    label: 'Indtast',
    target: 'required',
    fields: { value: { type: 'credential', required: true, max: 2048 } },
  },
  clear: { category: 'interaction', label: 'Ryd felt', target: 'required', fields: {} },
  select: {
    category: 'interaction',
    label: 'Vælg',
    target: 'required',
    fields: { value: { type: 'text', required: true, max: 512 } },
  },
  checkbox: {
    category: 'interaction',
    label: 'Sæt flueben',
    target: 'required',
    fields: { checked: { type: 'boolean', required: true } },
  },
  upload: {
    category: 'interaction',
    label: 'Upload fil',
    target: 'required',
    // A server-side path is deliberately NOT accepted — see validate.js. The
    // value names a file the operator uploaded to the run, not one on disk.
    fields: { file: { type: 'text', required: true, max: 255 } },
  },

  // ---------------------------------------------------------- validation
  assert_exists: { category: 'validation', label: 'Kontroller findes', target: 'required', fields: {} },
  assert_visible: { category: 'validation', label: 'Kontroller synlig', target: 'required', fields: {} },
  assert_not_visible: { category: 'validation', label: 'Kontroller ikke synlig', target: 'required', fields: {} },
  assert_text_contains: {
    category: 'validation',
    label: 'Kontroller tekst indeholder',
    target: 'required',
    fields: { value: { type: 'text', required: true, max: 1024 } },
  },
  assert_text_equals: {
    category: 'validation',
    label: 'Kontroller tekst er',
    target: 'required',
    fields: { value: { type: 'text', required: true, max: 1024 } },
  },
  // The page TITLE — what the browser tab says — not text on the page. It gets
  // its own step because a title cannot be reached any other way: `<title>`
  // lives in `<head>`, so a text target (which resolves through getByText, body
  // only) can never match it. Asserting a title as page text was exactly the bug
  // this step exists to fix: the suggested Login test ended on a title that was
  // never findable, and every accepted suggestion failed on it after burning the
  // full step timeout.
  assert_title_contains: {
    category: 'validation',
    label: 'Kontroller sidens titel',
    fields: { value: { type: 'text', required: true, max: 1024 } },
  },
  assert_url_contains: {
    category: 'validation',
    label: 'Kontroller adresse indeholder',
    fields: { value: { type: 'text', required: true, max: 1024 } },
  },
  assert_url_equals: {
    category: 'validation',
    label: 'Kontroller adresse er',
    fields: { value: { type: 'path', required: true, max: 1024 } },
  },

  // ---------------------------------------------------------- control
  // wait takes EITHER a duration or an element to wait for — never both, never
  // neither. validate.js enforces that; the catalogue can only say both are
  // optional on their own.
  wait: {
    category: 'control',
    label: 'Vent',
    target: 'optional',
    fields: { ms: { type: 'int', min: 0, max: 60000 } },
  },
  // A conditional block: run `then` only if the target is present. The one
  // use case that justifies nesting in a no-code designer is the cookie banner
  // that is sometimes there. Nesting is capped at one level (validate.js).
  condition: {
    category: 'control',
    label: 'Hvis til stede',
    target: 'required',
    block: 'then',
    fields: {},
  },

  // ---------------------------------------------------------- authentication
  // Uses the test's selected credential. The username/password never appear in
  // the definition — only the reference.
  login: { category: 'authentication', label: 'Log ind', fields: {} },
  logout: { category: 'authentication', label: 'Log ud', fields: {} },

  // ---------------------------------------------------------- technical
  api_request: {
    category: 'technical',
    label: 'Kald API',
    fields: {
      method: { type: 'method', required: true },
      url: { type: 'path', required: true, max: 1024 },
      body: { type: 'text', max: 8192 },
    },
  },
  // Asserts on the status of the most recent api_request or page navigation.
  assert_http_status: {
    category: 'technical',
    label: 'Kontroller HTTP-status',
    fields: { status: { type: 'int', required: true, min: 100, max: 599 } },
  },
};

const STEP_TYPES = Object.keys(STEPS);
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// Credential references. Only these two are resolvable — an arbitrary
// {{something}} is left verbatim, so a typo shows up in the UI instead of
// silently expanding to an empty string.
const CREDENTIAL_REFS = ['{{credential.username}}', '{{credential.password}}'];
const CREDENTIAL_REF_RE = /\{\{\s*credential\.(username|password)\s*\}\}/g;

const isStepType = (t) => Object.prototype.hasOwnProperty.call(STEPS, t);
const stepMeta = (t) => (isStepType(t) ? STEPS[t] : null);
const needsTarget = (t) => stepMeta(t) && stepMeta(t).target === 'required';
const acceptsTarget = (t) => !!(stepMeta(t) && stepMeta(t).target);
const blockField = (t) => (stepMeta(t) ? stepMeta(t).block || null : null);

// True when a string carries a credential reference — used by redact.js to know
// a value must never be logged, and by validate.js to require a credential.
function hasCredentialRef(value) {
  if (typeof value !== 'string') return false;
  CREDENTIAL_REF_RE.lastIndex = 0;
  return CREDENTIAL_REF_RE.test(value);
}

// Every credential reference in a definition, as a Set of 'username'|'password'.
function credentialRefsIn(definition) {
  const found = new Set();
  const walk = (steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== 'object') continue;
      for (const v of Object.values(step)) {
        if (typeof v === 'string') {
          CREDENTIAL_REF_RE.lastIndex = 0;
          let m = CREDENTIAL_REF_RE.exec(v);
          while (m) { found.add(m[1]); m = CREDENTIAL_REF_RE.exec(v); }
        }
      }
      if (Array.isArray(step.then)) walk(step.then);
      // `login` implies both, even with no literal reference in the definition.
      if (step.type === 'login') { found.add('username'); found.add('password'); }
    }
  };
  walk(definition && definition.steps);
  return found;
}

// The catalogue as the designer needs it: grouped by category, each entry
// carrying what a form must render. Serialisable — the UI fetches this rather
// than duplicating the list in JavaScript.
function catalogue() {
  return CATEGORIES.map((category) => ({
    category,
    steps: STEP_TYPES.filter((t) => STEPS[t].category === category).map((type) => ({
      type,
      label: STEPS[type].label,
      target: STEPS[type].target || null,
      block: STEPS[type].block || null,
      fields: Object.entries(STEPS[type].fields).map(([name, spec]) => ({ name, ...spec })),
    })),
  }));
}

module.exports = {
  DSL_VERSION,
  TARGET_STRATEGIES,
  FIELD_TYPES,
  CATEGORIES,
  STEPS,
  STEP_TYPES,
  HTTP_METHODS,
  CREDENTIAL_REFS,
  CREDENTIAL_REF_RE,
  isStepType,
  stepMeta,
  needsTarget,
  acceptsTarget,
  blockField,
  hasCredentialRef,
  credentialRefsIn,
  catalogue,
};
