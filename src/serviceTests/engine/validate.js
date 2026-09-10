'use strict';

const {
  DSL_VERSION, STEPS, isStepType, stepMeta, needsTarget, acceptsTarget, blockField,
  HTTP_METHODS, hasCredentialRef,
} = require('./dsl');
const { normalizeTarget } = require('./targeting');

// Validation for a DSL definition. Pure: returns { value } or { errors }, never
// both, and never throws — the repo-wide validator contract, and the one the
// gate's garbage sweep exercises.
//
// Errors are keyed by a path the designer can point at:
//   { 'steps[3].target': 'this step needs something to point at' }
//
// Two rules here are security, not ergonomics:
//   * `open`/`api_request`/`assert_url_equals` take a PATH or an absolute URL,
//     and an absolute URL is only accepted so the host policy can judge it at run
//     time. Nothing here decides reachability — that is hostPolicy.js — but a
//     non-http(s) scheme is refused outright, because no policy would ever
//     permit `file:` and there is no reason to carry one into the runner.
//   * `upload` names a file attached to the test, never a path on the server.
//     A value containing a slash or a drive letter is refused, so a test cannot
//     be used to read /etc/shadow off the box running the browser.

const NAME_MAX = 255;
const MAX_STEPS = 100;         // hard ceiling; the effective cap is a DB setting
const MAX_BLOCK_STEPS = 20;
const SAFE_SCHEMES = ['http:', 'https:'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Safe string coercion — the validator is handed arbitrary input by the gate.
function str(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return String(value); } catch { return ''; }
}

// A path ('/login'), or an absolute http(s) URL. Anything else — a scheme we
// would never allow, or a protocol-relative '//evil.example' — is refused.
function validUrlOrPath(raw) {
  const v = str(raw).trim();
  if (!v) return { error: 'must not be empty' };
  if (v.startsWith('//')) return { error: 'must be a path (/side) or a full http(s) address' };
  if (v.startsWith('/')) return { value: v };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
    let parsed;
    try { parsed = new URL(v); } catch { return { error: 'is not a valid address' }; }
    if (!SAFE_SCHEMES.includes(parsed.protocol)) {
      return { error: `only http and https are allowed (got ${parsed.protocol.replace(':', '')})` };
    }
    return { value: v };
  }
  // A bare relative path like 'login' — accept it, the runner resolves it
  // against the environment base URL.
  return { value: v };
}

// An uploaded file is referenced by NAME. A path separator means someone is
// pointing at the worker's filesystem.
function validUploadName(raw) {
  const v = str(raw).trim();
  if (!v) return { error: 'must name a file attached to the test' };
  if (/[/\\]/.test(v) || /^[a-zA-Z]:/.test(v) || v.includes('..')) {
    return { error: 'must be the name of a file attached to the test, not a path on the server' };
  }
  return { value: v };
}

function validateField(name, spec, raw, prefix, errors) {
  const required = !!spec.required;
  const missing = raw === undefined || raw === null || raw === '';
  if (missing) {
    if (required) errors[`${prefix}.${name}`] = `${name} is required`;
    return undefined;
  }
  switch (spec.type) {
    case 'path': {
      const { value, error } = validUrlOrPath(raw);
      if (error) { errors[`${prefix}.${name}`] = `${name} ${error}`; return undefined; }
      if (spec.max && value.length > spec.max) { errors[`${prefix}.${name}`] = `${name} is too long (max ${spec.max})`; return undefined; }
      return value;
    }
    case 'credential':
    case 'text': {
      const v = str(raw);
      if (spec.max && v.length > spec.max) { errors[`${prefix}.${name}`] = `${name} is too long (max ${spec.max})`; return undefined; }
      return v;
    }
    case 'int': {
      const n = Number(raw);
      const min = spec.min ?? Number.MIN_SAFE_INTEGER;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isInteger(n) || n < min || n > max) {
        errors[`${prefix}.${name}`] = `${name} must be a whole number between ${min} and ${max}`;
        return undefined;
      }
      return n;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') { errors[`${prefix}.${name}`] = `${name} must be true or false`; return undefined; }
      return raw;
    }
    case 'method': {
      const m = str(raw).toUpperCase();
      if (!HTTP_METHODS.includes(m)) { errors[`${prefix}.${name}`] = `${name} must be one of ${HTTP_METHODS.join(', ')}`; return undefined; }
      return m;
    }
    default:
      errors[`${prefix}.${name}`] = `${name} has an unsupported field type`;
      return undefined;
  }
}

// Validates and normalises one step. `depth` guards the single level of nesting
// a `condition` block may introduce.
function validateStep(raw, prefix, errors, depth) {
  if (!isPlainObject(raw)) { errors[prefix] = 'each step must be an object'; return null; }
  const type = str(raw.type).trim();
  if (!isStepType(type)) {
    errors[`${prefix}.type`] = type ? `unknown step type "${type}"` : 'step type is required';
    return null;
  }
  const meta = stepMeta(type);
  const step = { type };

  // Optional presentation fields every step may carry.
  if (raw.label !== undefined && raw.label !== null && raw.label !== '') step.label = str(raw.label).slice(0, NAME_MAX);
  if (raw.enabled === false) step.enabled = false;

  // ---- target
  if (acceptsTarget(type)) {
    const target = normalizeTarget(raw.target);
    if (!target && needsTarget(type)) {
      errors[`${prefix}.target`] = 'this step needs something to point at';
    } else if (target) {
      step.target = target;
    }
  } else if (raw.target !== undefined && raw.target !== null) {
    errors[`${prefix}.target`] = `a ${type} step does not point at an element`;
  }

  // ---- declared fields
  for (const [name, spec] of Object.entries(meta.fields)) {
    let value;
    if (spec.type === 'text' && type === 'upload' && name === 'file') {
      const { value: v, error } = validUploadName(raw[name]);
      if (error) errors[`${prefix}.${name}`] = `${name} ${error}`; else value = v;
    } else {
      value = validateField(name, spec, raw[name], prefix, errors);
    }
    if (value !== undefined) step[name] = value;
  }

  // ---- per-type rules the catalogue cannot express
  if (type === 'wait') {
    const hasMs = step.ms !== undefined;
    const hasTarget = !!step.target;
    if (hasMs === hasTarget) {
      errors[`${prefix}.wait`] = 'wait needs either a duration or something to wait for — not both, not neither';
    }
  }

  const block = blockField(type);
  if (block) {
    if (depth >= 1) {
      errors[`${prefix}.${block}`] = 'a condition cannot contain another condition';
    } else {
      const rawBlock = Array.isArray(raw[block]) ? raw[block] : [];
      if (!rawBlock.length) {
        errors[`${prefix}.${block}`] = 'a condition needs at least one step to run';
      } else if (rawBlock.length > MAX_BLOCK_STEPS) {
        errors[`${prefix}.${block}`] = `too many steps inside the condition (max ${MAX_BLOCK_STEPS})`;
      } else {
        const inner = [];
        for (let i = 0; i < rawBlock.length; i += 1) {
          const s = validateStep(rawBlock[i], `${prefix}.${block}[${i}]`, errors, depth + 1);
          if (s) inner.push(s);
        }
        step[block] = inner;
      }
    }
  }

  return step;
}

// Validates a whole definition. `maxSteps` comes from the DB-backed settings, so
// an operator can tighten it; the module's own MAX_STEPS is the ceiling that
// setting may not exceed.
function validateDefinition(raw, { maxSteps = MAX_STEPS } = {}) {
  const errors = {};
  if (!isPlainObject(raw)) return { errors: { definition: 'the test definition must be an object' } };

  const version = raw.version === undefined ? DSL_VERSION : Number(raw.version);
  if (version !== DSL_VERSION) errors.version = `unsupported definition version (expected ${DSL_VERSION})`;

  const name = str(raw.name).trim();
  if (name.length > NAME_MAX) errors.name = `name is too long (max ${NAME_MAX})`;

  if (!Array.isArray(raw.steps)) {
    errors.steps = 'the test needs a list of steps';
    return { errors };
  }
  const cap = Math.min(MAX_STEPS, Math.max(1, Number(maxSteps) || MAX_STEPS));
  if (raw.steps.length === 0) errors.steps = 'a test needs at least one step';
  if (raw.steps.length > cap) errors.steps = `too many steps (max ${cap})`;

  const steps = [];
  if (!errors.steps) {
    for (let i = 0; i < raw.steps.length; i += 1) {
      const step = validateStep(raw.steps[i], `steps[${i}]`, errors, 0);
      if (step) steps.push(step);
    }
  }

  if (Object.keys(errors).length) return { errors };
  return { value: { version: DSL_VERSION, name, steps } };
}

// A definition uses credentials when any step references one, or uses `login`.
// The route uses this to refuse saving a test that needs a credential without
// one selected — a failure that is much better at save time than at 03:00.
function requiresCredential(definition) {
  const walk = (steps) => (Array.isArray(steps) ? steps : []).some((s) => {
    if (!isPlainObject(s)) return false;
    if (s.type === 'login') return true;
    if (Object.values(s).some((v) => hasCredentialRef(v))) return true;
    return walk(s.then);
  });
  return walk(definition && definition.steps);
}

// Flattens nested condition blocks into a linear list of { step, path } for the
// runner's step numbering and the results table. A step inside a condition keeps
// its parent's index, so "step 4" in a failure message means what the operator
// sees at position 4 in the designer.
function flattenSteps(definition) {
  const out = [];
  const steps = (definition && definition.steps) || [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    out.push({ step, position: i, path: `${i}`, depth: 0 });
    const block = step && blockField(step.type);
    if (block && Array.isArray(step[block])) {
      for (let j = 0; j < step[block].length; j += 1) {
        out.push({ step: step[block][j], position: i, path: `${i}.${j}`, depth: 1, conditional: true });
      }
    }
  }
  return out;
}

module.exports = {
  validateDefinition,
  validateStep,
  requiresCredential,
  flattenSteps,
  validUrlOrPath,
  validUploadName,
  MAX_STEPS,
  MAX_BLOCK_STEPS,
  NAME_MAX,
  STEPS,
};
