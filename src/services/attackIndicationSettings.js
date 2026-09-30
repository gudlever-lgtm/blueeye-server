'use strict';

const net = require('net');
const { parseCidr } = require('../discovery/cidr');

// The pure half of Settings → Attack indication: what an admin may set, what
// the bounds are, and how a patch merges onto what is stored. No database, no
// Express — the same split src/auth/securityPolicy.js uses, so the rules can be
// tested without either and the settings service stays a thin wrapper.
//
// WHY THIS SCREEN EXISTS AT ALL. The four detectors shipped env-driven, and
// two of their knobs are ones a deployment cannot avoid touching:
//
//   NEW_PEER_BASELINE_HOURS  — how long a site stays silent while its memory of
//                              "networks we have reached" fills up. Too short on
//                              a fresh install and the first day is a siren.
//   SCAN_IGNORE_SOURCES      — the addresses allowed to sweep the network. This
//                              server's own sweep is excluded automatically; a
//                              CUSTOMER's vulnerability scanner is not, and
//                              until it is listed it produces a CRIT every run.
//
// Both were "edit .env and restart the server", which on a customer's on-prem
// box means a change window for a threshold. They are settings, and so is
// everything beside them here.
//
// ENV IS STILL THE FLOOR. Every value falls back to what the process loaded at
// boot, so a deployment that never opens this screen behaves exactly as it did
// before it existed, and `source` tells the screen which fields an admin has
// actually taken over.

const SEVERITIES = new Set(['INFO', 'WARN', 'CRIT']);
const SECTIONS = Object.freeze(['scan', 'newPeer', 'beacon', 'securityEvents']);

// Caps on the list fields. Generous — an operator with forty scanners is real —
// and present so a paste of a routing table cannot become a settings row that
// every detector run then parses.
const MAX_LIST = 200;
const MAX_RULES = 20;
const RULE_TYPE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// A comma-separated string or an array, as a trimmed array. The UI sends the
// string (one text field is friendlier than a list editor for six entries);
// the API accepts either, and what is STORED is always an array.
function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

function isAddressOrCidr(entry) {
  if (entry.includes('/')) return !!parseCidr(entry);
  return net.isIP(entry) !== 0;
}

// ---------------------------------------------------------------------------
// Field readers. Each writes into `value` on success or into `errors` on
// failure, so one patch reports every bad field at once rather than the first.
// ---------------------------------------------------------------------------

function readBool(p, key, path, errors, value) {
  if (p[key] === undefined) return;
  if (typeof p[key] !== 'boolean') { errors[`${path}.${key}`] = 'must be true or false'; return; }
  value[key] = p[key];
}

function readNum(p, key, { min, max, integer = true }, path, errors, value) {
  if (p[key] === undefined) return;
  const n = Number(p[key]);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    errors[`${path}.${key}`] = `must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`;
    return;
  }
  value[key] = n;
}

function readSeverity(p, key, path, errors, value) {
  if (p[key] === undefined) return;
  const s = String(p[key]).toUpperCase();
  if (!SEVERITIES.has(s)) { errors[`${path}.${key}`] = 'must be INFO, WARN or CRIT'; return; }
  value[key] = s;
}

function readAddressList(p, key, path, errors, value) {
  if (p[key] === undefined) return;
  const list = toList(p[key]);
  if (list === null) { errors[`${path}.${key}`] = 'must be a list of addresses or CIDRs'; return; }
  if (list.length > MAX_LIST) { errors[`${path}.${key}`] = `at most ${MAX_LIST} entries`; return; }
  const bad = list.filter((e) => !isAddressOrCidr(e));
  if (bad.length) {
    // Named, not counted: an operator who mistyped one of twelve entries needs
    // to know which one, and the field is text they typed themselves.
    errors[`${path}.${key}`] = `not an address or CIDR: ${bad.slice(0, 5).join(', ')}`;
    return;
  }
  value[key] = [...new Set(list)];
}

function readIntList(p, key, { min, max }, path, errors, value) {
  if (p[key] === undefined) return;
  const list = toList(p[key]);
  if (list === null) { errors[`${path}.${key}`] = 'must be a list of numbers'; return; }
  if (list.length > MAX_LIST) { errors[`${path}.${key}`] = `at most ${MAX_LIST} entries`; return; }
  const out = [];
  const bad = [];
  for (const e of list) {
    const n = Number.parseInt(e, 10);
    if (!Number.isInteger(n) || String(n) !== e.replace(/^\+/, '') || n < min || n > max) { bad.push(e); continue; }
    out.push(n);
  }
  if (bad.length) { errors[`${path}.${key}`] = `must be numbers ${min}–${max}: ${bad.slice(0, 5).join(', ')} is not`; return; }
  value[key] = [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function validateScan(p, errors) {
  const v = {};
  readBool(p, 'enabled', 'scan', errors, v);
  readNum(p, 'portThreshold', { min: 2, max: 65535 }, 'scan', errors, v);
  readNum(p, 'hostThreshold', { min: 2, max: 1000000 }, 'scan', errors, v);
  readNum(p, 'critPortThreshold', { min: 2, max: 65535 }, 'scan', errors, v);
  readNum(p, 'critHostThreshold', { min: 2, max: 1000000 }, 'scan', errors, v);
  readNum(p, 'windowMinutes', { min: 1, max: 1440 }, 'scan', errors, v);
  readNum(p, 'cooldownMinutes', { min: 1, max: 10080 }, 'scan', errors, v);
  readNum(p, 'maxPerRun', { min: 1, max: 500 }, 'scan', errors, v);
  readAddressList(p, 'ignoreSources', 'scan', errors, v);
  return v;
}

function validateNewPeer(p, errors) {
  const v = {};
  readBool(p, 'enabled', 'newPeer', errors, v);
  readBool(p, 'asnEnabled', 'newPeer', errors, v);
  readBool(p, 'countryEnabled', 'newPeer', errors, v);
  // 0 is legal and means "no warm-up": a deployment restoring a database that
  // already holds the memory does not need to wait a day for it again.
  readNum(p, 'baselineHours', { min: 0, max: 720 }, 'newPeer', errors, v);
  readSeverity(p, 'asnSeverity', 'newPeer', errors, v);
  readSeverity(p, 'countrySeverity', 'newPeer', errors, v);
  readNum(p, 'maxPerScope', { min: 1, max: 200 }, 'newPeer', errors, v);
  readNum(p, 'minBytes', { min: 0, max: 1000000000 }, 'newPeer', errors, v);
  return v;
}

function validateBeacon(p, errors) {
  const v = {};
  readBool(p, 'enabled', 'beacon', errors, v);
  readNum(p, 'windowHours', { min: 1, max: 168 }, 'beacon', errors, v);
  readNum(p, 'minObservations', { min: 4, max: 10000 }, 'beacon', errors, v);
  readNum(p, 'minSpanMinutes', { min: 1, max: 10080 }, 'beacon', errors, v);
  readNum(p, 'minCadenceMultiple', { min: 1.5, max: 100, integer: false }, 'beacon', errors, v);
  readNum(p, 'maxJitter', { min: 0.001, max: 1, integer: false }, 'beacon', errors, v);
  readNum(p, 'critJitter', { min: 0, max: 1, integer: false }, 'beacon', errors, v);
  readNum(p, 'cooldownMinutes', { min: 1, max: 20160 }, 'beacon', errors, v);
  readNum(p, 'maxCandidates', { min: 1, max: 1000 }, 'beacon', errors, v);
  readNum(p, 'maxPerRun', { min: 1, max: 500 }, 'beacon', errors, v);
  readIntList(p, 'ignorePorts', { min: 1, max: 65535 }, 'beacon', errors, v);
  readIntList(p, 'ignoreAsns', { min: 1, max: 4294967295 }, 'beacon', errors, v);
  readAddressList(p, 'ignoreDestinations', 'beacon', errors, v);
  return v;
}

function validateSecurityEvents(p, errors) {
  const v = {};
  readBool(p, 'enabled', 'securityEvents', errors, v);
  readNum(p, 'cooldownMinutes', { min: 1, max: 1440 }, 'securityEvents', errors, v);
  if (p.rules !== undefined) {
    if (!p.rules || typeof p.rules !== 'object' || Array.isArray(p.rules)) {
      errors['securityEvents.rules'] = 'must be an object keyed by event type';
      return v;
    }
    const keys = Object.keys(p.rules);
    if (keys.length > MAX_RULES) { errors['securityEvents.rules'] = `at most ${MAX_RULES} rules`; return v; }
    const rules = {};
    for (const type of keys) {
      // An event type the server's catalogue has not heard of is ACCEPTED: the
      // agent's classifier ships ahead of it (deviceEventCatalog.js says so),
      // and refusing one would mean an agent upgrade could not be acted on.
      if (!RULE_TYPE.test(type)) { errors[`securityEvents.rules.${type}`] = 'not a valid event type'; continue; }
      const r = p.rules[type];
      if (!r || typeof r !== 'object' || Array.isArray(r)) { errors[`securityEvents.rules.${type}`] = 'must be an object'; continue; }
      const out = {};
      readNum(r, 'warn', { min: 1, max: 1000000 }, `securityEvents.rules.${type}`, errors, out);
      readNum(r, 'crit', { min: 1, max: 1000000 }, `securityEvents.rules.${type}`, errors, out);
      readNum(r, 'windowMinutes', { min: 1, max: 1440 }, `securityEvents.rules.${type}`, errors, out);
      if (Object.keys(out).length) rules[type] = out;
    }
    if (Object.keys(rules).length) v.rules = rules;
  }
  return v;
}

// Validates a patch. Returns { errors, value } where `value` holds only the
// sections and fields the patch actually carried — so saving one card never
// restates, or silently resets, another's values.
function validateAttackIndication(patch) {
  const errors = {};
  const value = {};
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  for (const key of Object.keys(p)) {
    if (!SECTIONS.includes(key)) errors[key] = `unknown section (expected ${SECTIONS.join(', ')})`;
  }
  const run = (key, fn) => {
    if (p[key] === undefined) return;
    if (!p[key] || typeof p[key] !== 'object' || Array.isArray(p[key])) { errors[key] = 'must be an object'; return; }
    const v = fn(p[key], errors);
    if (Object.keys(v).length) value[key] = v;
  };
  run('scan', validateScan);
  run('newPeer', validateNewPeer);
  run('beacon', validateBeacon);
  run('securityEvents', validateSecurityEvents);
  return { errors: Object.keys(errors).length ? errors : null, value };
}

// Cross-field rules, checked against the MERGED result rather than the patch:
// raising the WARN threshold in one save and the CRIT one in the next must not
// be refused for a state that only ever existed between two requests.
//
// A CRIT line below its WARN line is not a preference, it is a rule that can
// never fire as WARN — so it is refused and named, not quietly clamped the way
// the env loader does. The loader has no one to tell.
function checkCoherence(effective) {
  const errors = {};
  const s = effective.scan || {};
  if (s.critPortThreshold < s.portThreshold) {
    errors['scan.critPortThreshold'] = `must be at least the WARN threshold (${s.portThreshold})`;
  }
  if (s.critHostThreshold < s.hostThreshold) {
    errors['scan.critHostThreshold'] = `must be at least the WARN threshold (${s.hostThreshold})`;
  }
  const b = effective.beacon || {};
  if (b.critJitter > b.maxJitter) {
    errors['beacon.critJitter'] = `must not be above the WARN jitter limit (${b.maxJitter})`;
  }
  const se = effective.securityEvents || {};
  for (const [type, r] of Object.entries(se.rules || {})) {
    if (r && r.crit < r.warn) {
      errors[`securityEvents.rules.${type}.crit`] = `must be at least the WARN count (${r.warn})`;
    }
  }
  return Object.keys(errors).length ? errors : null;
}

// Overlays a stored override onto the env-loaded defaults. Section by section,
// field by field — an override written when a section had six fields must not
// erase a seventh added since.
function mergeAttackIndication(base, override) {
  const o = override && typeof override === 'object' ? override : {};
  const out = {};
  for (const section of SECTIONS) {
    const b = (base && base[section]) || {};
    const s = (o[section] && typeof o[section] === 'object') ? o[section] : {};
    out[section] = { ...b, ...s };
    if (section === 'securityEvents') {
      const rules = {};
      for (const [type, r] of Object.entries(b.rules || {})) rules[type] = { ...r };
      for (const [type, r] of Object.entries(s.rules || {})) {
        rules[type] = { ...(rules[type] || {}), ...r };
        // A stored rule for a type the shipped table does not carry needs a
        // metric name of its own, derived exactly the way the detector derives
        // one, so the finding it raises is named the same either way.
        if (!rules[type].metric) rules[type].metric = `security.${type.replace(/[^a-z0-9]+/gi, '_')}`;
      }
      out[section].rules = rules;
    }
  }
  return out;
}

// Which fields an admin has taken over, per section — so the screen can say
// "set here" versus "from the environment" instead of showing one flat column
// of numbers whose origin nobody can tell.
function sourceOf(override) {
  const o = override && typeof override === 'object' ? override : {};
  const out = {};
  for (const section of SECTIONS) {
    const s = (o[section] && typeof o[section] === 'object') ? o[section] : {};
    out[section] = Object.keys(s);
  }
  return out;
}

module.exports = {
  validateAttackIndication,
  checkCoherence,
  mergeAttackIndication,
  sourceOf,
  SECTIONS,
  MAX_LIST,
  MAX_RULES,
};
