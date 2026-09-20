'use strict';

const { normalizeMac, isUsableMac } = require('../identity/arpTable');

// Validation for the SNMP device inventory an admin manages, and for the
// topology batch an agent submits after polling those devices.
//
// TWO DIFFERENT TRUST LEVELS, ONE FILE.
//
//   * The INVENTORY is written by an admin. The risk is not a hostile value,
//     it is a mistake that makes the server reach somewhere it should not —
//     so `host` goes through the Service Assurance host policy, twice (once
//     here on write, once again before a poll is dispatched), the same
//     two-check rule the SSRF allowlist already uses.
//   * The TOPOLOGY BATCH comes from an agent, but every value in it came off a
//     switch. A malformed FDB row is skipped and counted; one bad entry out of
//     five thousand must not cost the other 4 999.

const COLLECT_KINDS = ['if', 'fdb', 'lldp', 'vlan'];
const VERSIONS = ['1', '2c'];
const HOST_MAX = 255;
const NAME_MAX = 255;
const COMMUNITY_MAX = 128;
const IFNAME_MAX = 64;

const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86400;
// Matches the agent's own cap (snmpTopology.MAX_FDB_ENTRIES). The agent already
// truncates; this is the boundary refusing to be told otherwise.
const MAX_FDB_PER_DEVICE = 5000;
const MAX_NEIGHBOURS_PER_DEVICE = 512;
const MAX_VLANS_PER_DEVICE = 4096;
const MAX_INTERFACES_PER_DEVICE = 4096;
const MAX_DEVICES_PER_BATCH = 200;

// A host is an IP literal or a DNS name. Not a URL, not a port, not a CIDR —
// the shape is checked here and the POLICY (private ranges, the allowlist) is
// the host policy's job, so the two never disagree about what a host even is.
const HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;

const isStr = (v) => typeof v === 'string';

function str(v, max) {
  if (!isStr(v)) return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function validateCollect(raw, errors, key = 'collect') {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) { errors[key] = `${key} must be an array`; return undefined; }
  const out = [];
  for (const item of raw) {
    if (!COLLECT_KINDS.includes(item)) {
      errors[key] = `${key} entries must be one of: ${COLLECT_KINDS.join(', ')}`;
      return undefined;
    }
    if (!out.includes(item)) out.push(item);
  }
  // An explicitly EMPTY list is refused rather than silently meaning
  // "everything": a device somebody meant to stop polling should be disabled,
  // which says so, not configured to collect nothing, which does not.
  if (!out.length) { errors[key] = `${key} must name at least one kind`; return undefined; }
  return out;
}

// Validates an admin's device create/update. `partial` drops the required-field
// check so the same rules serve a PATCH.
function validateSnmpDevice(raw, { partial = false } = {}) {
  const errors = {};
  const value = {};
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (body.host !== undefined || !partial) {
    const host = str(body.host, HOST_MAX);
    if (!host || !HOST_RE.test(host)) errors.host = 'host is required (an IP address or a DNS name)';
    else value.host = host;
  }

  if (body.port !== undefined) {
    const n = Number(body.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = 'port must be between 1 and 65535';
    else value.port = n;
  }

  if (body.version !== undefined) {
    // v3 is deliberately not offered yet: it needs an auth/priv credential pair
    // and a key-management story, and half-supporting it would be worse than
    // saying so. See docs/snmp-topology.md.
    if (!VERSIONS.includes(String(body.version))) {
      errors.version = `version must be one of: ${VERSIONS.join(', ')}`;
    } else {
      value.version = String(body.version);
    }
  }

  if (body.community !== undefined) {
    if (body.community === null) {
      value.community = null;
    } else if (!isStr(body.community) || !body.community || body.community.length > COMMUNITY_MAX) {
      errors.community = `community must be a string of at most ${COMMUNITY_MAX} characters`;
    } else {
      value.community = body.community;
    }
  }

  if (body.agentId !== undefined) {
    if (body.agentId === null) {
      value.agentId = null;
    } else {
      const n = Number(body.agentId);
      if (!Number.isInteger(n) || n < 1) errors.agentId = 'agentId must be a positive integer or null';
      else value.agentId = n;
    }
  }

  if (body.locationId !== undefined) {
    if (body.locationId === null) {
      value.locationId = null;
    } else {
      const n = Number(body.locationId);
      if (!Number.isInteger(n) || n < 1) errors.locationId = 'locationId must be a positive integer or null';
      else value.locationId = n;
    }
  }

  if (body.displayName !== undefined) {
    value.displayName = body.displayName === null ? null : str(body.displayName, NAME_MAX);
  }

  if (body.collect !== undefined) {
    const collect = validateCollect(body.collect, errors);
    if (collect !== undefined) value.collect = collect;
  }

  if (body.intervalSec !== undefined) {
    const n = Number(body.intervalSec);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_SEC || n > MAX_INTERVAL_SEC) {
      // Floored rather than clamped: a full bridge-table walk is the expensive
      // call on this path, and an admin who typed 5 should be told why it is
      // refused rather than discovering later that it silently became 60.
      errors.intervalSec = `intervalSec must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC} seconds`;
    } else {
      value.intervalSec = n;
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be a boolean';
    else value.enabled = body.enabled;
  }

  if (Object.keys(errors).length) return { errors };
  if (!partial && !Object.keys(value).length) return { errors: { host: 'host is required' } };
  return { value };
}

// One FDB row off a switch. Returns the normalised entry, or null when it is
// unusable — the count is what the response reports, not a per-row error.
function validateFdbEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Normalised through the SAME function the ARP ingest uses, so the five
  // spellings of a MAC resolve identically across both identity sources — the
  // whole point of having one normaliser.
  const mac = normalizeMac(raw.mac);
  if (!mac || !isUsableMac(mac)) return null;

  const bridgePort = Number(raw.bridgePort);
  if (!Number.isInteger(bridgePort) || bridgePort <= 0) return null;

  const vlan = Number.isInteger(raw.vlan) && raw.vlan >= 0 && raw.vlan <= 4095 ? raw.vlan : 0;

  let ifIndex = null;
  if (Number.isInteger(raw.ifIndex) && raw.ifIndex > 0) ifIndex = raw.ifIndex;

  const portMacCount = Number.isInteger(raw.portMacCount) && raw.portMacCount > 0
    ? Math.min(raw.portMacCount, 1000000)
    : 1;

  const status = isStr(raw.status) && raw.status.length <= 16 ? raw.status : 'learned';
  // The agent already drops these, but the boundary does not take that on
  // trust: a `self` row would claim the switch is plugged into itself.
  if (status === 'self' || status === 'invalid') return null;

  return {
    mac,
    vlan,
    bridgePort,
    ifIndex,
    ifName: str(raw.ifName, IFNAME_MAX),
    status,
    portMacCount,
  };
}

function validateNeighbour(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const remoteChassisId = str(raw.remoteChassisId, 255);
  if (!remoteChassisId) return null;
  return {
    localPort: Number.isInteger(raw.localPort) ? raw.localPort : null,
    localIfIndex: Number.isInteger(raw.localIfIndex) ? raw.localIfIndex : null,
    localIfName: str(raw.localIfName, IFNAME_MAX),
    remoteChassisId,
    remotePortId: str(raw.remotePortId, 255),
    remotePortDesc: str(raw.remotePortDesc, 255),
    remoteSysName: str(raw.remoteSysName, 255),
  };
}

// One device's result inside a submitted batch.
function validateDeviceTopology(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const deviceId = Number(raw.deviceId);
  if (!Number.isInteger(deviceId) || deviceId < 1) return null;

  const fdb = [];
  let fdbSkipped = 0;
  for (const row of Array.isArray(raw.fdb) ? raw.fdb.slice(0, MAX_FDB_PER_DEVICE) : []) {
    const e = validateFdbEntry(row);
    if (e) fdb.push(e); else fdbSkipped += 1;
  }

  const neighbours = [];
  for (const row of Array.isArray(raw.neighbours) ? raw.neighbours.slice(0, MAX_NEIGHBOURS_PER_DEVICE) : []) {
    const n = validateNeighbour(row);
    if (n) neighbours.push(n);
  }

  const vlans = [];
  for (const row of Array.isArray(raw.vlans) ? raw.vlans.slice(0, MAX_VLANS_PER_DEVICE) : []) {
    if (!row || typeof row !== 'object') continue;
    const vlan = Number(row.vlan);
    const name = str(row.name, 64);
    if (Number.isInteger(vlan) && vlan >= 0 && vlan <= 4095 && name) vlans.push({ vlan, name });
  }

  const interfaces = [];
  for (const row of Array.isArray(raw.interfaces) ? raw.interfaces.slice(0, MAX_INTERFACES_PER_DEVICE) : []) {
    if (!row || typeof row !== 'object') continue;
    const ifIndex = Number(row.ifIndex);
    const ifName = str(row.ifName, IFNAME_MAX);
    if (Number.isInteger(ifIndex) && ifIndex > 0 && ifName) {
      interfaces.push({ ifIndex, ifName, ifAlias: str(row.ifAlias, 255) });
    }
  }

  const supported = [];
  for (const kind of Array.isArray(raw.supported) ? raw.supported : []) {
    if (COLLECT_KINDS.includes(kind) && !supported.includes(kind)) supported.push(kind);
  }

  return {
    deviceId,
    fdb,
    fdbSkipped,
    fdbTruncated: !!raw.fdbTruncated,
    fdbTotal: Number.isInteger(raw.fdbTotal) && raw.fdbTotal >= 0 ? raw.fdbTotal : fdb.length,
    neighbours,
    vlans,
    interfaces,
    // NULL, not []. A device that reported nothing has not said it supports
    // nothing — absent is not zero, the same rule the agent applies to an
    // absent SNMP counter.
    supported: supported.length ? supported : null,
  };
}

// The whole submitted batch. Records errors and returns undefined only when the
// batch itself is malformed — which IS a 400, because the agent sent something
// that is not a batch at all.
function validateSnmpTopologyBatch(raw, errors) {
  const errs = errors && typeof errors === 'object' ? errors : {};
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!body) { errs.devices = 'body must be an object'; return undefined; }

  // `devices` is REQUIRED, not optional-and-defaulted. The agent's poller only
  // submits when it has something to say, so it always sends the key; a body
  // without it is a malformed submission, not "polled nothing". Defaulting it
  // would make a truncated or wrongly-shaped POST look like a successful empty
  // cycle, which is the one outcome nobody can tell from the outside.
  if (!Array.isArray(body.devices)) {
    errs.devices = 'devices must be an array';
    return undefined;
  }
  if (body.errors !== undefined && !Array.isArray(body.errors)) {
    errs.errors = 'errors must be an array';
    return undefined;
  }
  const rawDevices = body.devices;
  if (rawDevices.length > MAX_DEVICES_PER_BATCH) {
    errs.devices = `devices must contain at most ${MAX_DEVICES_PER_BATCH} entries`;
    return undefined;
  }

  const devices = [];
  let skipped = 0;
  for (const row of rawDevices) {
    const d = validateDeviceTopology(row);
    if (d) devices.push(d); else skipped += 1;
  }

  const failures = [];
  for (const row of (Array.isArray(body.errors) ? body.errors : []).slice(0, MAX_DEVICES_PER_BATCH)) {
    if (!row || typeof row !== 'object') continue;
    const deviceId = Number(row.deviceId);
    if (!Number.isInteger(deviceId) || deviceId < 1) continue;
    failures.push({
      deviceId,
      error: str(row.error, 255) || 'poll failed',
      code: str(row.code, 64),
    });
  }

  return { devices, failures, skipped };
}

module.exports = {
  validateSnmpDevice,
  validateSnmpTopologyBatch,
  validateDeviceTopology,
  validateFdbEntry,
  validateNeighbour,
  validateCollect,
  COLLECT_KINDS,
  VERSIONS,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  MAX_FDB_PER_DEVICE,
  MAX_DEVICES_PER_BATCH,
};
