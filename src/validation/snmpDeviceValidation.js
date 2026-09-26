'use strict';

const {
  normalizeMac, isUsableMac, isIpv4, isIpv6,
} = require('../identity/arpTable');
const { MAX_DELTA_SEC } = require('../devices/counterDelta');

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

// What a device may be polled for. 'ifcounters' is the interface counter time
// series (migration 109) and is deliberately its own kind rather than part of
// 'if': the port inventory is a handful of rows that change when somebody
// rewires something, and the counters are ~1.4 million rows a day for twenty
// switches. Opting into one must not opt into the other.
//
// 'cdp' (CISCO-CDP-MIB neighbours), 'arp' (the IP-MIB ARP table of a router or
// L3 switch) and 'entity' (the ENTITY-MIB inventory) are read by agents from
// 0.40 on; an older agent ignores a kind it does not know, so listing one for
// it costs nothing.
const COLLECT_KINDS = ['if', 'fdb', 'lldp', 'vlan', 'ifcounters', 'cdp', 'arp', 'entity'];
// What a NEW device is polled for when the admin does not say. 'ifcounters' is
// still opt-in (it is the volume). A device that does not implement one of
// these MIBs answers with an empty walk, which is "not supported", never an
// error — so the wide default is safe on anything.
const DEFAULT_COLLECT = ['if', 'fdb', 'lldp', 'vlan', 'cdp', 'arp', 'entity'];
// What a device row with NO stored collect has always meant. Rows created
// before the default widened keep meaning exactly this: nothing silently
// starts walking a router's ARP table because the server was upgraded.
const LEGACY_DEFAULT_COLLECT = ['if', 'fdb', 'lldp', 'vlan'];
const NEIGHBOUR_PROTOCOLS = ['lldp', 'cdp'];
const INVENTORY_CLASSES = ['chassis', 'module'];
// Which OID the interface NAME came from. Not every switch implements ifName;
// some only have ifDescr, which is less stable, and a row built from the weaker
// one should say so rather than leaving it to be assumed.
const NAME_SOURCES = ['ifName', 'ifDescr', 'ifIndex'];
// IF-MIB ifAdminStatus / ifOperStatus, already named by the agent. Anything
// else becomes null: an unknown status is not a status.
const IF_STATUSES = ['up', 'down', 'testing', 'dormant', 'notPresent', 'lowerLayerDown', 'unknown'];
// Versions a DEVICE ROW may carry. v3 is accepted now (migration 112), but a
// device row cannot hold a v3 credential: an auth/priv key pair belongs on a
// CREDENTIAL PROFILE, where it is encrypted once and shared by every switch at
// a site. A v3 device therefore resolves its credential from a profile, and
// saying so is what keeps half-configured v3 from looking configured.
const VERSIONS = ['1', '2c'];
const DEVICE_VERSIONS = ['1', '2c', '3'];
const HOST_MAX = 255;
const NAME_MAX = 255;
const COMMUNITY_MAX = 128;
const IFNAME_MAX = 64;
const SYSDESCR_MAX = 255;

const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86400;
// Matches the agent's own cap (snmpTopology.MAX_FDB_ENTRIES). The agent already
// truncates; this is the boundary refusing to be told otherwise.
const MAX_FDB_PER_DEVICE = 5000;
const MAX_NEIGHBOURS_PER_DEVICE = 512;
// Matches the agent's own cap (snmpTopology.MAX_ARP_ENTRIES).
const MAX_ARP_PER_DEVICE = 8192;
// Every chassis (16) plus the bounded modules (32), as the agent caps them.
const MAX_INVENTORY_PER_DEVICE = 48;
// sysObjectID is an OID: dotted decimal and nothing else.
const OID_RE = /^\d+(\.\d+){1,127}$/;
const MAX_VLANS_PER_DEVICE = 4096;
const MAX_INTERFACES_PER_DEVICE = 4096;
// An upper sanity bound on ifMtu. Not a hardware limit — jumbo ports report
// 9216 and some platforms report far more for internal interfaces — just the
// line past which a device is answering nonsense rather than reporting an MTU.
// IPv4's own theoretical maximum datagram is 65535, so nothing above it is a
// packet size any interface can mean.
const MAX_MTU = 65535;
const MAX_DEVICES_PER_BATCH = 200;

// The counter batch. A chassis with a thousand ports is real, and the agent
// caps at the same number — this is the boundary refusing to be told otherwise.
const MAX_COUNTER_INTERFACES_PER_DEVICE = 1024;
const MIN_COUNTER_INTERVAL_SEC = 30;
// The counter cadence has a CEILING OF ITS OWN, and it is not the topology
// interval's. `counterDelta.MAX_DELTA_SEC` voids the rate across any gap wider
// than it, so a device configured to report counters every twenty minutes
// would store readings for ever and never produce a single rate — a screen of
// raw octets and empty columns, with nothing saying why. Importing the number
// rather than repeating it is what stops the two drifting apart.
const MAX_COUNTER_INTERVAL_SEC = MAX_DELTA_SEC;
// Every counter column the agent may send. An unlisted key is ignored rather
// than stored: a future agent adding a column must not be able to write one the
// schema has no room for.
const COUNTER_FIELDS = [
  'inOctets', 'outOctets', 'inUcastPkts', 'outUcastPkts',
  'inMcastPkts', 'inBcastPkts', 'outMcastPkts', 'outBcastPkts',
  'inErrors', 'outErrors', 'inDiscards', 'outDiscards',
  'fcsErrors', 'alignmentErrors', 'lateCollisions', 'carrierSenseErrors',
];

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
    if (!DEVICE_VERSIONS.includes(String(body.version))) {
      errors.version = `version must be one of: ${DEVICE_VERSIONS.join(', ')}`;
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

  // A v3 device with a community is a contradiction: v3 has no community, and a
  // row carrying both would poll with whichever the resolution chain reached
  // first. A v3 device takes its credential from a PROFILE.
  if (String(value.version || body.version) === '3' && value.community) {
    errors.community = 'SNMPv3 has no community string — point this device at a v3 credential profile instead';
  }

  // Which profile to resolve through. NULL means "work it out": the device's
  // site, then the global default.
  if (body.credentialProfileId !== undefined) {
    if (body.credentialProfileId === null) {
      value.credentialProfileId = null;
    } else {
      const n = Number(body.credentialProfileId);
      if (!Number.isInteger(n) || n < 1) errors.credentialProfileId = 'credentialProfileId must be a positive integer';
      else value.credentialProfileId = n;
    }
  }

  // The counter cadence, when this device is polled for counters at all. Its
  // own setting because a counter series' interval IS its resolution.
  if (body.counterIntervalSec !== undefined) {
    if (body.counterIntervalSec === null) {
      value.counterIntervalSec = null;
    } else {
      const n = Number(body.counterIntervalSec);
      if (!Number.isInteger(n) || n < MIN_COUNTER_INTERVAL_SEC || n > MAX_COUNTER_INTERVAL_SEC) {
        errors.counterIntervalSec = `counterIntervalSec must be between ${MIN_COUNTER_INTERVAL_SEC} and ${MAX_COUNTER_INTERVAL_SEC} seconds`;
      } else {
        value.counterIntervalSec = n;
      }
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

// An address that is one. The agent already renders it; the boundary does not
// store a string that merely looks like one.
function ipOrNull(v) {
  const s = str(v, 45);
  return s && (isIpv4(s) || isIpv6(s)) ? s.toLowerCase() : null;
}

function validateNeighbour(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const remoteChassisId = str(raw.remoteChassisId, 255);
  if (!remoteChassisId) return null;
  return {
    // Absent on every agent older than CDP support — all of whose neighbours
    // are LLDP, which is what the default says.
    protocol: NEIGHBOUR_PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'lldp',
    localPort: Number.isInteger(raw.localPort) ? raw.localPort : null,
    localIfIndex: Number.isInteger(raw.localIfIndex) ? raw.localIfIndex : null,
    localIfName: str(raw.localIfName, IFNAME_MAX),
    remoteChassisId,
    remotePortId: str(raw.remotePortId, 255),
    remotePortDesc: str(raw.remotePortDesc, 255),
    remoteSysName: str(raw.remoteSysName, 255),
    remoteAddress: ipOrNull(raw.remoteAddress),
    remotePlatform: str(raw.remotePlatform, 255),
  };
}

// One row of a router's ARP table. Null when unusable — counted, not an error.
function validateArpEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ip = ipOrNull(raw.ip);
  if (!ip) return null;
  // The SAME normaliser the agent-ARP and FDB ingests use, so a MAC found here
  // matches the one found there however either device spelled it.
  const mac = normalizeMac(raw.mac);
  if (!mac || !isUsableMac(mac)) return null;
  const ifIndex = Number.isInteger(raw.ifIndex) && raw.ifIndex > 0 ? raw.ifIndex : null;
  return { ip, mac, ifIndex, ifName: str(raw.ifName, IFNAME_MAX) };
}

// One ENTITY-MIB row.
function validateInventoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entIndex = Number(raw.entIndex);
  if (!Number.isInteger(entIndex) || entIndex < 1 || entIndex > 2147483647) return null;
  if (!INVENTORY_CLASSES.includes(raw.class)) return null;
  return {
    entIndex,
    class: raw.class,
    name: str(raw.name, 64),
    descr: str(raw.descr, 255),
    model: str(raw.model, 128),
    serial: str(raw.serial, 64),
    vendor: str(raw.vendor, 128),
    hardwareRev: str(raw.hardwareRev, 64),
    firmwareRev: str(raw.firmwareRev, 64),
    softwareRev: str(raw.softwareRev, 64),
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
      const speed = Number(row.speedMbps);
      const ifType = Number(row.ifType);
      const mtu = Number(row.mtu);
      const mac = normalizeMac(row.physAddress);
      interfaces.push({
        ifIndex,
        ifName,
        // The name is the identity of the row, so where it came from travels
        // with it (migration 108). An unrecognised value is the safe default,
        // never a made-up provenance.
        nameSource: NAME_SOURCES.includes(row.nameSource) ? row.nameSource : 'ifName',
        ifAlias: str(row.ifAlias, 255),
        ifDescr: str(row.ifDescr, 255),
        ifType: Number.isInteger(ifType) && ifType > 0 ? ifType : null,
        // 0 is what a device reports for a port whose speed it does not know.
        // Storing it as 0 would make "unknown" look like "stalled".
        speedMbps: Number.isInteger(speed) && speed > 0 ? speed : null,
        // ifMtu (migration 139) — what this port was configured to carry. Same
        // rule as the speed above and for a sharper reason: the link-MTU
        // mismatch rule compares the two ends of a cable, so a 0 coerced from a
        // port the device stayed silent about would raise a finding against a
        // port nobody has measured. MAX_MTU is a sanity bound, not a hardware
        // one — anything past it is a device answering nonsense.
        mtu: Number.isInteger(mtu) && mtu > 0 && mtu <= MAX_MTU ? mtu : null,
        adminStatus: IF_STATUSES.includes(row.adminStatus) ? row.adminStatus : null,
        operStatus: IF_STATUSES.includes(row.operStatus) ? row.operStatus : null,
        physAddress: mac && isUsableMac(mac) ? mac : null,
      });
    }
  }

  // The router's ARP table (IP-MIB), one row per address. Deduplicated here
  // too: the upsert keys on (device, ip), and two rows for one address in one
  // statement would make the stored MAC whichever came last.
  const arp = [];
  let arpSkipped = 0;
  const arpSeen = new Set();
  for (const row of Array.isArray(raw.arp) ? raw.arp.slice(0, MAX_ARP_PER_DEVICE) : []) {
    const e = validateArpEntry(row);
    if (!e) { arpSkipped += 1; continue; }
    if (arpSeen.has(e.ip)) continue;
    arpSeen.add(e.ip);
    arp.push(e);
  }

  const inventory = [];
  const entSeen = new Set();
  for (const row of Array.isArray(raw.inventory) ? raw.inventory.slice(0, MAX_INVENTORY_PER_DEVICE) : []) {
    const e = validateInventoryEntry(row);
    if (e && !entSeen.has(e.entIndex)) { entSeen.add(e.entIndex); inventory.push(e); }
  }

  const supported = [];
  for (const kind of Array.isArray(raw.supported) ? raw.supported : []) {
    if (COLLECT_KINDS.includes(kind) && !supported.includes(kind)) supported.push(kind);
  }
  const sysObjectId = str(raw.sysObjectId, 128);

  return {
    deviceId,
    // SNMPv2-MIB sysDescr — what the device says it is (model, OS, firmware).
    // Optional: an agent older than migration 116 does not send it, and null
    // is what makes the ingest keep the one it already has rather than erase it.
    sysDescr: str(raw.sysDescr, SYSDESCR_MAX),
    // SNMPv2-MIB sysName — what the device calls itself, and the name its
    // LLDP/CDP neighbours report it by (migration 133). Optional; null keeps
    // what is stored.
    sysName: str(raw.sysName, SYSDESCR_MAX),
    // The rest of the system group, optional like sysDescr and for the same
    // reason: null keeps what is stored.
    sysLocation: str(raw.sysLocation, SYSDESCR_MAX),
    sysContact: str(raw.sysContact, SYSDESCR_MAX),
    sysObjectId: sysObjectId && OID_RE.test(sysObjectId) ? sysObjectId : null,
    fdb,
    fdbSkipped,
    fdbTruncated: !!raw.fdbTruncated,
    fdbTotal: Number.isInteger(raw.fdbTotal) && raw.fdbTotal >= 0 ? raw.fdbTotal : fdb.length,
    neighbours,
    vlans,
    interfaces,
    arp,
    arpSkipped,
    arpTruncated: !!raw.arpTruncated,
    arpTotal: Number.isInteger(raw.arpTotal) && raw.arpTotal >= 0 ? raw.arpTotal : arp.length,
    inventory,
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

// One device's counter snapshot. Returns null for a row that cannot be stored
// at all; a row with SOME unusable columns keeps the ones that are fine, the
// same rule the forwarding table follows — one bad column out of forty must
// not cost the other thirty-nine.
function validateDeviceCounters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const deviceId = Number(raw.deviceId);
  if (!Number.isInteger(deviceId) || deviceId < 1) return null;

  // The AGENT's clock when the read happened. Without it there is no elapsed
  // time, and without elapsed time there is no rate — so a batch with no
  // timestamp is not a measurement.
  const readAt = typeof raw.readAt === 'string' ? new Date(raw.readAt) : null;
  if (!readAt || Number.isNaN(readAt.getTime())) return null;

  const ticks = Number(raw.sysUpTimeTicks);
  const interfaces = [];
  for (const row of Array.isArray(raw.interfaces) ? raw.interfaces.slice(0, MAX_COUNTER_INTERFACES_PER_DEVICE) : []) {
    if (!row || typeof row !== 'object') continue;
    const ifIndex = Number(row.ifIndex);
    const ifName = str(row.ifName, IFNAME_MAX);
    // A sample needs SOMETHING to identify its port. The name is the identity
    // (migration 108) and the index is the fallback; with neither there is
    // nothing for the measurement to be a measurement of.
    if (!ifName && !(Number.isInteger(ifIndex) && ifIndex > 0)) continue;

    const iface = { ifIndex: Number.isInteger(ifIndex) && ifIndex > 0 ? ifIndex : null, ifName };
    for (const f of COUNTER_FIELDS) {
      const n = Number(row[f]);
      // Negative is impossible for a counter and NaN is not an answer. Both
      // become null — absent, not zero, because zero errors is what RULES OUT
      // a fault and a value we could not read has ruled out nothing.
      iface[f] = row[f] == null || !Number.isFinite(n) || n < 0 ? null : n;
    }
    iface.duplex = ['half', 'full', 'unknown'].includes(row.duplex) ? row.duplex : null;
    interfaces.push(iface);
  }

  return {
    deviceId,
    readAt: readAt.toISOString(),
    sysUpTimeTicks: Number.isFinite(ticks) && ticks >= 0 ? ticks : null,
    // Whether the 64-bit counters were available. It decides whether a
    // decreasing octet counter can be reasoned about as a wrap at all.
    hc: raw.hc !== false,
    // Ports whose ifIndex moved on this cycle, by NAME. A rate across that
    // boundary is two different ports subtracted from each other.
    renumbered: (Array.isArray(raw.renumbered) ? raw.renumbered : [])
      .map((n) => str(n, IFNAME_MAX)).filter(Boolean).slice(0, MAX_COUNTER_INTERFACES_PER_DEVICE),
    interfaces,
  };
}

// The whole counter batch. Same shape and same rules as the topology batch:
// `devices` is REQUIRED rather than defaulted, because a truncated POST must
// not look like a successful empty cycle.
function validateSnmpCounterBatch(raw, errors) {
  const errs = errors && typeof errors === 'object' ? errors : {};
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!body) { errs.devices = 'body must be an object'; return undefined; }
  if (!Array.isArray(body.devices)) { errs.devices = 'devices must be an array'; return undefined; }
  if (body.errors !== undefined && !Array.isArray(body.errors)) {
    errs.errors = 'errors must be an array';
    return undefined;
  }
  if (body.devices.length > MAX_DEVICES_PER_BATCH) {
    errs.devices = `devices must contain at most ${MAX_DEVICES_PER_BATCH} entries`;
    return undefined;
  }

  const devices = [];
  let skipped = 0;
  for (const row of body.devices) {
    const d = validateDeviceCounters(row);
    if (d) devices.push(d); else skipped += 1;
  }

  const failures = [];
  for (const row of (Array.isArray(body.errors) ? body.errors : []).slice(0, MAX_DEVICES_PER_BATCH)) {
    if (!row || typeof row !== 'object') continue;
    const deviceId = Number(row.deviceId);
    if (!Number.isInteger(deviceId) || deviceId < 1) continue;
    failures.push({ deviceId, error: str(row.error, 255) || 'counter poll failed', code: str(row.code, 64) });
  }

  return { devices, failures, skipped };
}

module.exports = {
  NAME_SOURCES,
  IF_STATUSES,
  validateSnmpDevice,
  validateSnmpTopologyBatch,
  validateSnmpCounterBatch,
  validateDeviceTopology,
  validateDeviceCounters,
  validateFdbEntry,
  validateNeighbour,
  validateArpEntry,
  validateInventoryEntry,
  validateCollect,
  COLLECT_KINDS,
  DEFAULT_COLLECT,
  LEGACY_DEFAULT_COLLECT,
  NEIGHBOUR_PROTOCOLS,
  MAX_ARP_PER_DEVICE,
  MAX_INVENTORY_PER_DEVICE,
  VERSIONS,
  DEVICE_VERSIONS,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  MAX_FDB_PER_DEVICE,
  MAX_DEVICES_PER_BATCH,
  MAX_COUNTER_INTERFACES_PER_DEVICE,
  MIN_COUNTER_INTERVAL_SEC,
  MAX_COUNTER_INTERVAL_SEC,
  COUNTER_FIELDS,
};
