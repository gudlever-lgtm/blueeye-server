'use strict';

// Validation for test packages (POST/PUT /api/test-packages). A package has a
// name, an optional schedule, a target selector and a list of items. Each probe
// item reuses validateProbeSpec so the same host/port/count rules apply.

const { validateProbeSpec } = require('./probeValidation');

const NAME_MAX = 255;
const MAX_ITEMS = 20;
const MAX_TARGET_IDS = 500;
const MIN_SCHEDULE_MS = 30 * 1000; // 30s floor, so a package can't burst agents
const MAX_SCHEDULE_MS = 24 * 60 * 60 * 1000; // 1 day
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // run-test repeat cap (matches agent)

const TARGET_MODES = ['all', 'agents', 'location'];

function validateTargets(raw, errors) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.targets = 'targets must be an object';
    return undefined;
  }
  const mode = String(raw.mode || '');
  if (!TARGET_MODES.includes(mode)) {
    errors.targets = `targets.mode must be one of: ${TARGET_MODES.join(', ')}`;
    return undefined;
  }
  const out = { mode, agentIds: [], locationIds: [] };

  function ids(field, key) {
    const list = raw[field];
    if (!Array.isArray(list) || list.length === 0) {
      errors.targets = `targets.${field} must be a non-empty array for mode '${mode}'`;
      return false;
    }
    if (list.length > MAX_TARGET_IDS) { errors.targets = `targets.${field} has too many entries`; return false; }
    for (const id of list) {
      if (!Number.isInteger(id) || id <= 0) { errors.targets = `targets.${field} must be positive integers`; return false; }
    }
    out[key] = list;
    return true;
  }

  if (mode === 'agents' && !ids('agentIds', 'agentIds')) return undefined;
  if (mode === 'location' && !ids('locationIds', 'locationIds')) return undefined;
  return out;
}

function validateItems(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.items = 'items must be a non-empty array';
    return undefined;
  }
  if (raw.length > MAX_ITEMS) {
    errors.items = `too many items (max ${MAX_ITEMS})`;
    return undefined;
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const it = raw[i];
    if (!it || typeof it !== 'object') { errors.items = `items[${i}] must be an object`; return undefined; }
    const type = String(it.type || '');
    if (type === 'run-test') {
      const item = { type: 'run-test' };
      if (it.intervalMs !== undefined && it.intervalMs !== null) {
        const n = Number(it.intervalMs);
        if (!Number.isInteger(n) || n < 100 || n > MAX_INTERVAL_MS) { errors.items = `items[${i}].intervalMs is out of range`; return undefined; }
        item.intervalMs = n;
      }
      out.push(item);
    } else if (type === 'probe') {
      const { value, errors: pe } = validateProbeSpec(it.probe);
      if (pe) { errors.items = `items[${i}].probe: ${Object.values(pe).join('; ')}`; return undefined; }
      out.push({ type: 'probe', probe: value });
    } else {
      errors.items = `items[${i}].type must be 'probe' or 'run-test'`;
      return undefined;
    }
  }
  return out;
}

function validateTestPackageInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.name = 'name is required';
  } else if (input.name.trim().length > NAME_MAX) {
    errors.name = `name must be at most ${NAME_MAX} characters`;
  } else {
    value.name = input.name.trim();
  }

  value.enabled = input.enabled === undefined ? true : !!input.enabled;

  // schedule_ms: 0 / unset = manual only; otherwise within [MIN, MAX].
  let schedule = 0;
  const s = input.schedule_ms;
  if (s !== undefined && s !== null && s !== 0 && s !== '0') {
    const n = Number(s);
    if (!Number.isInteger(n) || n < MIN_SCHEDULE_MS || n > MAX_SCHEDULE_MS) {
      errors.schedule_ms = `schedule_ms must be 0 (manual) or between ${MIN_SCHEDULE_MS} and ${MAX_SCHEDULE_MS}`;
    } else {
      schedule = n;
    }
  }
  value.schedule_ms = schedule;

  const targets = validateTargets(input.targets, errors);
  if (targets !== undefined) value.targets = targets;

  const items = validateItems(input.items, errors);
  if (items !== undefined) value.items = items;

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = {
  validateTestPackageInput,
  MIN_SCHEDULE_MS,
  MAX_SCHEDULE_MS,
  MAX_ITEMS,
};
