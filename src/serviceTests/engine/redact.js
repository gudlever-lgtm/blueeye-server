'use strict';

// Credential redaction.
//
// A run touches secrets in three places: the resolved value typed into a field,
// anything the page echoes back, and whatever an exception happens to carry. This
// module is the single chokepoint every string passes through before it is
// stored, logged or returned — see docs/service-assurance.md §6.
//
// The rule is deliberately blunt: given the set of secret values used by a run,
// ANY occurrence of one in ANY outgoing string becomes ••••••. There is no
// cleverness about which field it came from, because the failure mode of being
// too clever is a password in a log line.

const MASK = '••••••';

// Values shorter than this are not masked: a two-character password would turn
// every stray "ab" in a log into a mask and make the output useless. Such a
// password is a problem to reject at entry, not to paper over here.
const MIN_MASKABLE_LENGTH = 4;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds a redactor bound to one run's secrets.
//   const redact = createRedactor(['hunter2-correct-horse', 'svc-test']);
//   redact('login failed for svc-test / hunter2-correct-horse')
//   → 'login failed for svc-test / ••••••'      (username is not a secret)
function createRedactor(secrets = []) {
  const values = [...new Set((Array.isArray(secrets) ? secrets : [secrets])
    .filter((v) => typeof v === 'string' && v.length >= MIN_MASKABLE_LENGTH))]
    // Longest first, so a secret that contains another is masked whole.
    .sort((a, b) => b.length - a.length);

  const patterns = values.map((v) => new RegExp(escapeRegExp(v), 'g'));

  // Redacts a string. Non-strings pass through untouched (redactDeep handles
  // structures).
  function text(value) {
    if (typeof value !== 'string' || !patterns.length) return value;
    let out = value;
    for (const re of patterns) { re.lastIndex = 0; out = out.replace(re, MASK); }
    return out;
  }

  // Redacts every string inside a structure, in place of the original. Depth is
  // bounded so a cyclic or pathological object cannot hang the runner; anything
  // deeper is dropped rather than returned unredacted.
  function deep(value, depth = 0) {
    if (depth > 8) return null;
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.slice(0, 500).map((v) => deep(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[text(k)] = deep(v, depth + 1);
      return out;
    }
    return value;
  }

  // An Error's message AND stack can both carry an interpolated secret.
  function error(err) {
    if (!err) return { message: '', stack: null };
    return {
      message: text(err.message || String(err)),
      stack: err.stack ? text(err.stack) : null,
    };
  }

  // Whether a string still contains a secret — the assertion the security spec
  // uses to prove an artefact is clean.
  function isClean(value) {
    if (typeof value !== 'string') return true;
    return !values.some((v) => value.includes(v));
  }

  return { text, deep, error, isClean, count: values.length };
}

// The redactor used when a run has no credentials: a pass-through, so callers
// never branch on "is there a redactor".
const nullRedactor = createRedactor([]);

module.exports = { createRedactor, nullRedactor, MASK, MIN_MASKABLE_LENGTH };
