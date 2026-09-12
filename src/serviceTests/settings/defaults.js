'use strict';

// Service Tests settings catalogue — the DEFAULTS live here in code, the
// OVERRIDES live in the database (`service_test_settings`). Nothing in this
// module reads an environment variable for a limit: an operator changes a budget,
// a cap or a retention window from the UI and it takes effect without a redeploy
// (docs/service-assurance.md §6, §7).
//
// Every field is bounded. The bounds are a hard contract — a stored row that
// falls outside them is ignored in favour of the default, so a bad write (or a
// hand-edited row) can never widen a security control by accident.

// [default, min, max] for the numeric fields of each section.
const NUMBER_BOUNDS = {
  discovery: {
    maxPages: [100, 1, 1000],
    maxDepth: [5, 1, 20],
    maxRequests: [500, 1, 20000],
    navigationTimeoutMs: [30000, 1000, 300000],
    maxDurationMs: [300000, 10000, 3600000],
  },
  allowlist: {
    // The binding control on how much of a private network one application may
    // reach. Counted with cidr.totalAddresses(), which never enumerates.
    maxAddressesPerApplication: [65536, 1, 16777216],
    // Secondary guard: refuse a single range broader than this prefix. The
    // address cap above still applies on top, so lowering this alone cannot open
    // more than the cap allows.
    minCidrPrefix: [16, 8, 32],
  },
  runner: {
    stepTimeoutMs: [30000, 1000, 300000],
    maxRunDurationMs: [300000, 10000, 3600000],
    maxStepsPerTest: [100, 1, 500],
    // How many jobs ONE worker runs side by side. Each lane builds its own
    // browser, so this is a memory dial as much as a throughput one: budget a
    // few hundred MB per lane and keep it under what the container can carry.
    // More workers (docker compose --scale) adds machines; this adds lanes on
    // the machine you have.
    concurrency: [2, 1, 16],
  },
  artifacts: {
    // Screenshots are the module's unbounded-growth risk: one five-minute test
    // failing across a weekend writes ~115 MB at PNG sizes. Hence failure-only
    // capture, a lossy format, a per-run cap and a retention window.
    quality: [70, 1, 100],
    maxPerRun: [5, 0, 50],
    retentionDays: [30, 1, 3650],
  },
  assurance: {
    // How often the reaction sweep runs: certificates re-checked, failing tests
    // re-counted, incidents opened/resolved. Cheap — a TLS handshake and a
    // couple of indexed reads — so this is about how fast an operator hears,
    // not about load.
    sweepIntervalMs: [300000, 30000, 3600000],
    // A certificate is re-read this often. Six hours is far below any renewal
    // cadence and far above anything a CA would consider rude.
    certificateCheckIntervalMinutes: [360, 5, 10080],
    // Days remaining at which an expiry becomes a WARN, and at which it becomes
    // a CRIT. The default pair says: "start reminding me a month out, wake me a
    // week out" — which is how a 90-day certificate is actually renewed.
    certificateWarnDays: [30, 0, 365],
    certificateCriticalDays: [7, 0, 365],
    certificateTimeoutMs: [10000, 1000, 60000],
    // Consecutive failing runs before a test opens an incident. One failure is
    // a bad minute; two in a row is a service.
    failureStreak: [2, 1, 20],
    // Resolved incidents are kept this long as history, then swept.
    incidentRetentionDays: [90, 1, 3650],
  },
  queue: {
    // A run left `running` longer than this is reaped back to `error`.
    claimTimeoutMs: [600000, 30000, 7200000],
    pollIntervalMs: [5000, 1000, 60000],
    // How long a worker's last heartbeat may be before it counts as gone. A
    // worker writes one every poll tick, so this is a multiple of
    // pollIntervalMs, not a guess about how long a test takes.
    workerHeartbeatTimeoutMs: [60000, 5000, 3600000],
  },
};

// Non-numeric fields: [default, allowed values] for enums, [default] for booleans.
const ENUM_FIELDS = {
  runner: { browser: ['chromium', ['chromium', 'firefox', 'webkit']] },
  artifacts: { format: ['webp', ['webp', 'jpeg', 'png']] },
};

// Free-text fields. Each carries its own validator rather than a bound, because
// "valid" for a string is never a range. An empty string always means "not set"
// and falls back to whatever the feature did before the setting existed — so a
// blank field is never a broken one.
const STRING_FIELDS = {
  recording: {
    // The address a CUSTOMER'S browser must use to reach this server, for the
    // recording bookmarklet. Empty = work it out from the request, which is
    // right for a direct install and for a proxy that sets X-Forwarded-Proto.
    //
    // Here as well as in BLUEEYE_PUBLIC_URL because the two are answered by
    // different people: the env var needs a redeploy and a shell, this needs a
    // dashboard and the operator who just watched recording fail. Settings win
    // over the env var — the more specific, more recent answer.
    publicUrl: {
      default: '',
      max: 512,
      // http is ACCEPTED, not silently corrected: a BlueEyes genuinely served
      // over plain HTTP on an internal network is a real deployment, and the
      // recording dialog already warns that HTTPS applications will refuse it.
      // Refusing to store the truth would be worse than reporting it.
      check(raw) {
        let url;
        try { url = new URL(raw); } catch { return 'that does not look like a full address (https://host)'; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'the address must start with https:// or http://';
        if (!url.hostname) return 'the address needs a hostname';
        if (url.search || url.hash) return 'the address must not carry a query or fragment';
        return null;
      },
      // Stored without a trailing slash, so every caller can append a path.
      clean: (raw) => String(raw).trim().replace(/\/+$/, ''),
    },
  },
};

const BOOLEAN_FIELDS = {
  artifacts: { screenshotOnFailure: true, fullPage: false },
  // The accessibility check (V2 §9). On by default: it is one read-only evaluate
  // at the end of a run, it can never change the outcome, and a check nobody
  // turns on finds nothing. The switch exists so a customer with a page it
  // chokes on can stop collecting without losing the test.
  runner: { accessibility: true },
  // `enabled` off stops the sweep entirely; `notify` off keeps the incidents but
  // sends nothing, which is what an operator wants for the first week while they
  // find out how noisy their own estate is.
  // `enabled` off stops the sweep entirely; `notify` off keeps the incidents but
  // sends nothing. `groupAlerts` off sends one message per incident instead of
  // one per problem — the behaviour before V3, kept as a switch because an
  // operator who does not trust the grouping should be able to see everything
  // rather than turn alerting off altogether.
  assurance: {
    enabled: true, notify: true, watchCertificates: true, watchTests: true, groupAlerts: true,
  },
};

const SECTIONS = [...new Set([
  ...Object.keys(NUMBER_BOUNDS),
  ...Object.keys(ENUM_FIELDS),
  ...Object.keys(BOOLEAN_FIELDS),
  ...Object.keys(STRING_FIELDS),
])].sort();

function isSection(name) {
  return SECTIONS.includes(name);
}

// Safe label for an arbitrary value in an error message. A caller can hand this
// module anything — the gate's validation sweep deliberately does — and a plain
// template literal throws on a null-prototype object or a Symbol.
function label(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try { return String(value); } catch { return typeof value; }
}

// The shipped defaults for one section, as a fresh object.
function defaultsFor(section) {
  const out = {};
  for (const [field, [def]] of Object.entries(NUMBER_BOUNDS[section] || {})) out[field] = def;
  for (const [field, [def]] of Object.entries(ENUM_FIELDS[section] || {})) out[field] = def;
  for (const [field, def] of Object.entries(BOOLEAN_FIELDS[section] || {})) out[field] = def;
  for (const [field, spec] of Object.entries(STRING_FIELDS[section] || {})) out[field] = spec.default;
  return out;
}

function allDefaults() {
  const out = {};
  for (const s of SECTIONS) out[s] = defaultsFor(s);
  return out;
}

// Validates a partial patch for one section. Pure: returns { value } or
// { errors }, never both, and never throws — the repo-wide validator contract.
// Unknown fields are rejected rather than ignored, so a typo is visible instead
// of silently doing nothing.
function validateSection(section, patch) {
  if (!isSection(section)) return { errors: { section: `unknown settings section "${label(section)}"` } };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: { _: 'settings patch must be an object' } };
  }
  const numbers = NUMBER_BOUNDS[section] || {};
  const enums = ENUM_FIELDS[section] || {};
  const booleans = BOOLEAN_FIELDS[section] || {};
  const strings = STRING_FIELDS[section] || {};
  const errors = {};
  const value = {};

  for (const [field, raw] of Object.entries(patch)) {
    if (Object.prototype.hasOwnProperty.call(numbers, field)) {
      const [, min, max] = numbers[field];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        errors[field] = `${field} must be an integer between ${min} and ${max}`;
      } else {
        value[field] = n;
      }
    } else if (Object.prototype.hasOwnProperty.call(enums, field)) {
      const [, allowed] = enums[field];
      if (!allowed.includes(raw)) errors[field] = `${field} must be one of ${allowed.join(', ')}`;
      else value[field] = raw;
    } else if (Object.prototype.hasOwnProperty.call(booleans, field)) {
      if (typeof raw !== 'boolean') errors[field] = `${field} must be true or false`;
      else value[field] = raw;
    } else if (Object.prototype.hasOwnProperty.call(strings, field)) {
      const spec = strings[field];
      if (raw === null || raw === '' || raw === undefined) {
        // Clearing it is always allowed, and always means "go back to working
        // it out yourself" rather than "store an empty address".
        value[field] = '';
      } else if (typeof raw !== 'string') {
        errors[field] = `${field} must be text`;
      } else if (raw.trim().length > spec.max) {
        errors[field] = `${field} is too long (max ${spec.max})`;
      } else {
        const cleaned = spec.clean ? spec.clean(raw) : raw.trim();
        const problem = spec.check ? spec.check(cleaned) : null;
        if (problem) errors[field] = problem;
        else value[field] = cleaned;
      }
    } else {
      errors[field] = `unknown setting "${label(field)}" for section ${label(section)}`;
    }
  }

  return Object.keys(errors).length ? { errors } : { value };
}

// Merges a stored override over the defaults, DISCARDING any field that is
// unknown or out of bounds. A corrupt row degrades to the defaults rather than
// taking a limit with it.
function mergeSection(section, stored) {
  const base = defaultsFor(section);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  for (const [field, raw] of Object.entries(stored)) {
    const { value } = validateSection(section, { [field]: raw });
    if (value && Object.prototype.hasOwnProperty.call(value, field)) base[field] = value[field];
  }
  return base;
}

module.exports = {
  SECTIONS,
  label,
  NUMBER_BOUNDS,
  ENUM_FIELDS,
  BOOLEAN_FIELDS,
  isSection,
  defaultsFor,
  allDefaults,
  validateSection,
  mergeSection,
};
