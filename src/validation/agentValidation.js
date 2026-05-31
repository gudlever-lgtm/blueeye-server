'use strict';

const DISPLAY_NAME_MAX = 255;
const NOTES_MAX = 2000;
const META_MAX_BYTES = 65535;
const MONITOR_SOURCES = ['proc', 'snmp', 'netflow'];
const SNMP_VERSIONS = ['1', '2c'];
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

// Validates monitor_config (server-managed): which traffic source the agent
// should use and, for SNMP, how to reach the device. Returns the normalised
// value, or undefined when invalid (and records errors.monitor_config).
function validateMonitorConfig(raw, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.monitor_config = 'monitor_config must be an object or null';
    return undefined;
  }
  if (!MONITOR_SOURCES.includes(raw.source)) {
    errors.monitor_config = `monitor_config.source must be one of: ${MONITOR_SOURCES.join(', ')}`;
    return undefined;
  }

  const value = { source: raw.source };

  if (raw.intervalMs !== undefined && raw.intervalMs !== null) {
    if (!Number.isInteger(raw.intervalMs) || raw.intervalMs < 1000 || raw.intervalMs > MAX_INTERVAL_MS) {
      errors.monitor_config = `monitor_config.intervalMs must be an integer between 1000 and ${MAX_INTERVAL_MS}`;
      return undefined;
    }
    value.intervalMs = raw.intervalMs;
  }

  if (raw.source === 'snmp') {
    const s = raw.snmp;
    if (typeof s !== 'object' || s === null || typeof s.host !== 'string' || s.host.trim() === '') {
      errors.monitor_config = 'monitor_config.snmp.host is required when source is snmp';
      return undefined;
    }
    const snmp = { host: s.host.trim() };
    if (s.community !== undefined && s.community !== null) {
      if (typeof s.community !== 'string' || s.community.length > 128) {
        errors.monitor_config = 'monitor_config.snmp.community must be a string';
        return undefined;
      }
      snmp.community = s.community;
    }
    if (s.version !== undefined && s.version !== null) {
      if (!SNMP_VERSIONS.includes(String(s.version))) {
        errors.monitor_config = `monitor_config.snmp.version must be one of: ${SNMP_VERSIONS.join(', ')}`;
        return undefined;
      }
      snmp.version = String(s.version);
    }
    if (s.port !== undefined && s.port !== null) {
      if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        errors.monitor_config = 'monitor_config.snmp.port must be an integer 1-65535';
        return undefined;
      }
      snmp.port = s.port;
    }
    value.snmp = snmp;
  }

  if (raw.source === 'netflow') {
    const n = raw.netflow;
    const netflow = {};
    if (n !== undefined && n !== null) {
      if (typeof n !== 'object' || Array.isArray(n)) {
        errors.monitor_config = 'monitor_config.netflow must be an object';
        return undefined;
      }
      if (n.port !== undefined && n.port !== null) {
        if (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535) {
          errors.monitor_config = 'monitor_config.netflow.port must be an integer 1-65535';
          return undefined;
        }
        netflow.port = n.port;
      }
    }
    value.netflow = netflow; // {} is fine — the agent defaults the port to 2055
  }

  return value;
}

// Validates agent-reported capabilities (lenient: an object with a string
// `sources` array). Returns the value or undefined (records errors.capabilities).
function validateCapabilities(raw, errors) {
  if (raw === undefined || raw === null) {
    errors.capabilities = 'capabilities is required';
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.capabilities = 'capabilities must be an object';
    return undefined;
  }
  if (!Array.isArray(raw.sources) || !raw.sources.every((s) => typeof s === 'string')) {
    errors.capabilities = 'capabilities.sources must be an array of strings';
    return undefined;
  }
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > META_MAX_BYTES) {
    errors.capabilities = 'capabilities is not serialisable or is too large';
    return undefined;
  }
  return raw;
}

// Validates the server-managed fields of an agent. Only these four fields are
// accepted; any agent-reported fields in the body are ignored. Omitted fields
// default to null (PUT = replace the managed metadata).
function validateAgentManagedInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  // display_name — string or null.
  if (input.display_name === undefined || input.display_name === null) {
    value.display_name = null;
  } else if (typeof input.display_name !== 'string' || input.display_name.trim() === '') {
    errors.display_name = 'display_name must be a non-empty string or null';
  } else if (input.display_name.trim().length > DISPLAY_NAME_MAX) {
    errors.display_name = `display_name must be at most ${DISPLAY_NAME_MAX} characters`;
  } else {
    value.display_name = input.display_name.trim();
  }

  // location_id — positive integer or null (existence is checked in the route).
  if (input.location_id === undefined || input.location_id === null) {
    value.location_id = null;
  } else if (!Number.isInteger(input.location_id) || input.location_id <= 0) {
    errors.location_id = 'location_id must be a positive integer or null';
  } else {
    value.location_id = input.location_id;
  }

  // notes — string or null.
  if (input.notes === undefined || input.notes === null) {
    value.notes = null;
  } else if (typeof input.notes !== 'string') {
    errors.notes = 'notes must be a string or null';
  } else if (input.notes.length > NOTES_MAX) {
    errors.notes = `notes must be at most ${NOTES_MAX} characters`;
  } else {
    value.notes = input.notes;
  }

  // meta — JSON object/array or null.
  if (input.meta === undefined || input.meta === null) {
    value.meta = null;
  } else if (typeof input.meta !== 'object') {
    errors.meta = 'meta must be a JSON object or null';
  } else {
    let serialized;
    try {
      serialized = JSON.stringify(input.meta);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      errors.meta = 'meta must be JSON-serialisable';
    } else if (Buffer.byteLength(serialized, 'utf8') > META_MAX_BYTES) {
      errors.meta = 'meta is too large';
    } else {
      value.meta = input.meta;
    }
  }

  // monitor_config — server-managed traffic source selection.
  const mc = validateMonitorConfig(input.monitor_config, errors);
  if (mc !== undefined) value.monitor_config = mc;

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateAgentManagedInput, validateMonitorConfig, validateCapabilities };
