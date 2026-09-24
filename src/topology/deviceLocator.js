'use strict';

// "Where is device X?" and "which way does traffic from A to B go?" — the I/O
// half of the L2 path feature. The decisions live in ./l2Path.js (pure); this
// file resolves what the technician typed to MACs, reads the forwarding tables
// and the switch graph, and dresses the answer with port state and counters.
// See docs/l2-path.md.
//
// IDENTITY, IN THE ORDER IT IS TRUSTED:
//   * an agent's own report (`capabilities.ips`) and a polled switch's address
//     say WHO an IP is;
//   * ARP says which MAC holds an IP — agents' neighbour tables
//     (`arp_entries`), and a ROUTER's ARP table when one is collected
//     (`deviceArpRepo`, optional — see below);
//   * an agent's LLDP chassis id is often its NIC MAC, and is used as one more
//     candidate when nothing's ARP table holds the agent's address;
//   * `discovered_devices` gives a hostname to an address a sweep found.
// Then `fdb_entries` says where each MAC is plugged in.
//
// THE ROUTER ARP REPO IS OPTIONAL AND DUCK-TYPED. It is another package's
// table; this file depends on it only through `deviceArpRepo`, and only through
// two methods that may each be missing:
//   findByIp({ ip, limit })   -> [{ deviceId, ip, mac, lastSeen }]
//   findByMac({ mac, limit }) -> [{ deviceId, ip, mac, lastSeen }]
// Without it the agents' ARP tables are the only IP->MAC source, and a routed
// path's gateway can only be named by the caller (`gateway=`).
//
// BOUNDED. Every read carries a limit (see the constants), the per-endpoint
// work is capped at MAX_CANDIDATE_MACS MACs, and the per-hop reads are one per
// switch on the path, which BFS caps at MAX_HOPS.
//
// The essential reads (the switch list, the forwarding table) throw through to
// the route — a 500 is the honest answer when the thing the question is about
// cannot be read. The decorations (counters, VLAN names, discovery, LLDP) are
// best-effort and a failure is named in `sources`, never silently empty.

const {
  buildSwitchGraph, pickAccessPort, computeSegment, portKey,
} = require('./l2Path');
const { normalizeMac, isUsableMac, isIpv4, isIpv6 } = require('../identity/arpTable');
const { vendorForMac, isLocallyAdministered } = require('../identity/oui');
const { normaliseMac } = require('./graph');
const { silentLogger } = require('../logger');
const { numOrNull } = require('../lib/num');

const ARP_LIMIT = 10;
const FDB_LIMIT = 50;
const MAX_CANDIDATE_MACS = 4;
const MAX_ENDPOINT_IPS = 4;
const NEIGHBOUR_LIMIT = 20000;
const DEVICE_MAC_LIMIT = 50000;
const MAX_DEVICES = 5000;
const INTERFACE_LIMIT = 1000;
const MAX_NAME_MATCHES = 5;
// Inventory reads.
const INVENTORY_ARP_LIMIT = 5000;
const INVENTORY_ARP_WINDOW_MS = 7 * 24 * 3600 * 1000;
const INVENTORY_PORT_MAC_LIMIT = 20000;
const INVENTORY_FDB_WINDOW_MS = 24 * 3600 * 1000;
const INVENTORY_DISCOVERED_LIMIT = 2000;

const has = (obj, fn) => !!obj && typeof obj[fn] === 'function';
const toMs = (v) => {
  if (v == null || v === '') return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const iso = (v) => { const ms = toMs(v); return ms == null ? null : new Date(ms).toISOString(); };
const newer = (a, b) => ((toMs(a) || 0) >= (toMs(b) || 0) ? a : b);
const agentName = (a) => (a && (a.display_name || a.hostname)) || (a ? `agent ${a.id}` : null);
const deviceName = (d) => (d && (d.displayName || d.host)) || (d ? `#${d.id}` : null);
const agentIps = (a) => {
  const ips = a && a.capabilities && Array.isArray(a.capabilities.ips) ? a.capabilities.ips : [];
  return ips.filter((ip) => typeof ip === 'string' && ip).map((ip) => ip.toLowerCase());
};
const lower = (v) => (v == null ? null : String(v).trim().toLowerCase() || null);
const isIp = (s) => isIpv4(s) || isIpv6(s);

function uncertainty(code, severity, message, evidence = {}) {
  return { code, severity, message, evidence };
}

function createDeviceLocator({
  agentsRepo = null,
  locationsRepo = null,
  snmpDevicesRepo = null,
  snmpNeighborsRepo = null,
  deviceInterfacesRepo = null,
  fdbEntriesRepo = null,
  counterSamplesRepo = null,
  arpEntriesRepo = null,
  deviceArpRepo = null,
  lldpNeighborsRepo = null,
  discoveredDevicesRepo = null,
  ouiTable = undefined,
  now = () => new Date(),
  logger = silentLogger,
} = {}) {
  // Whether the question can be asked at all on this install.
  const canLocate = () => has(snmpDevicesRepo, 'list') && has(fdbEntriesRepo, 'findByMac');

  async function best(name, sources, fn, fallback) {
    try {
      const v = await fn();
      if (sources[name] !== 'failed') sources[name] = 'ok';
      return v;
    } catch (err) {
      sources[name] = 'failed';
      logger.warn(`l2-path: ${name} could not be read (${err.message})`);
      return fallback;
    }
  }

  // ---- the shared context: switches, their graph, agents, sites -------------
  async function loadContext(sources) {
    const [devices, neighbours, deviceMacs] = await Promise.all([
      snmpDevicesRepo.list({}),
      has(snmpNeighborsRepo, 'listAll')
        ? best('neighbours', sources, () => snmpNeighborsRepo.listAll({ limit: NEIGHBOUR_LIMIT }), [])
        : (sources.neighbours = 'unavailable', []),
      has(deviceInterfacesRepo, 'listMacs')
        ? best('deviceMacs', sources, () => deviceInterfacesRepo.listMacs({ limit: DEVICE_MAC_LIMIT }), [])
        : (sources.deviceMacs = 'unavailable', []),
    ]);
    const allDevices = (Array.isArray(devices) ? devices : []).slice(0, MAX_DEVICES);
    const graph = buildSwitchGraph({ devices: allDevices, neighbours, deviceMacs });
    const [agents, sites] = await Promise.all([
      has(agentsRepo, 'findAll') ? best('agents', sources, () => agentsRepo.findAll(), []) : [],
      has(locationsRepo, 'findAll') ? best('sites', sources, () => locationsRepo.findAll(), []) : [],
    ]);
    const siteName = new Map((sites || []).map((s) => [Number(s.id), s.name]));
    return {
      graph,
      allDevices,
      deviceById: new Map(allDevices.map((d) => [Number(d.id), d])),
      agents: Array.isArray(agents) ? agents : [],
      agentById: new Map((agents || []).map((a) => [Number(a.id), a])),
      siteName,
    };
  }

  // ---- identity: what the input IS, and which MACs it could have -----------
  function blankIdentity(spec) {
    return {
      input: spec.raw,
      kind: spec.kind,
      label: spec.raw,
      hostname: null,
      agentId: null,
      deviceId: null,
      discoveredId: null,
      siteId: null,
      ips: new Set(),
      macs: new Map(),
      reportedBy: [],
      alternatives: [],
      uncertainties: [],
      found: false,
    };
  }

  function addMac(ident, raw, source, { lastSeen = null, by = null } = {}) {
    const mac = normalizeMac(raw);
    if (!mac || !isUsableMac(mac)) return;
    let e = ident.macs.get(mac);
    if (!e) { e = { mac, sources: [], lastSeen: null }; ident.macs.set(mac, e); }
    if (!e.sources.includes(source)) e.sources.push(source);
    e.lastSeen = e.lastSeen ? newer(e.lastSeen, lastSeen) : (lastSeen || null);
    if (by) ident.reportedBy.push({ source, ...by, mac, lastSeen: iso(lastSeen) });
    ident.found = true;
  }

  function takeAgent(ident, a) {
    ident.found = true;
    ident.agentId = Number(a.id);
    ident.label = agentName(a);
    ident.hostname = a.hostname || null;
    ident.siteId = a.location_id == null ? null : Number(a.location_id);
    for (const ip of agentIps(a)) ident.ips.add(ip);
  }

  function takeDevice(ident, d) {
    ident.found = true;
    ident.deviceId = Number(d.id);
    ident.label = deviceName(d);
    if (d.host && isIp(d.host)) ident.ips.add(String(d.host).toLowerCase());
    ident.siteId = d.locationId == null ? null : Number(d.locationId);
  }

  async function macsForIp(ident, ip, ctx, sources) {
    if (has(arpEntriesRepo, 'findByIp')) {
      const rows = await best('arp', sources, () => arpEntriesRepo.findByIp({ ip, limit: ARP_LIMIT }), []);
      for (const r of rows || []) {
        // An agent's own table never holds its own address; a row claiming to
        // is not evidence about it.
        if (ident.agentId != null && Number(r.agentId) === ident.agentId) continue;
        const a = ctx.agentById.get(Number(r.agentId));
        addMac(ident, r.mac, 'arp', { lastSeen: r.lastSeen, by: { agentId: Number(r.agentId), agentName: agentName(a), ip } });
      }
    }
    if (has(deviceArpRepo, 'findByIp')) {
      const rows = await best('routerArp', sources, () => deviceArpRepo.findByIp({ ip, limit: ARP_LIMIT }), []);
      for (const r of rows || []) {
        const d = ctx.deviceById.get(Number(r.deviceId));
        addMac(ident, r.mac, 'routerArp', { lastSeen: r.lastSeen, by: { deviceId: Number(r.deviceId), deviceName: deviceName(d), ip } });
      }
    }
  }

  async function identify(spec, ctx, sources) {
    const ident = blankIdentity(spec);
    if (spec.kind === 'agent') {
      const a = ctx.agentById.get(spec.value)
        || (has(agentsRepo, 'findById') ? await agentsRepo.findById(spec.value) : null);
      if (!a) return ident;
      takeAgent(ident, a);
    } else if (spec.kind === 'ip') {
      ident.ips.add(spec.value);
      const a = ctx.agents.find((x) => agentIps(x).includes(spec.value));
      if (a) takeAgent(ident, a);
      const d = ctx.allDevices.find((x) => lower(x.host) === spec.value);
      if (d) takeDevice(ident, d);
      if (has(discoveredDevicesRepo, 'findByIp')) {
        const found = await best('discovery', sources, () => discoveredDevicesRepo.findByIp(spec.value), null);
        if (found) {
          ident.found = true;
          ident.discoveredId = found.id;
          ident.hostname = ident.hostname || found.hostname || null;
          if (ident.label === spec.raw && found.hostname) ident.label = found.hostname;
          ident.reportedBy.push({ source: 'discovery', agentId: found.foundByAgentId ?? null, agentName: agentName(ctx.agentById.get(Number(found.foundByAgentId))), ip: found.ip, lastSeen: iso(found.lastSeen), firstSeen: iso(found.firstSeen) });
        }
      }
    } else if (spec.kind === 'mac') {
      addMac(ident, spec.value, 'input');
      if (has(arpEntriesRepo, 'findByMac')) {
        const rows = await best('arp', sources, () => arpEntriesRepo.findByMac({ mac: spec.value, limit: ARP_LIMIT }), []);
        for (const r of rows || []) {
          if (r.ip) ident.ips.add(String(r.ip).toLowerCase());
          const a = ctx.agentById.get(Number(r.agentId));
          ident.reportedBy.push({ source: 'arp', agentId: Number(r.agentId), agentName: agentName(a), ip: r.ip, mac: spec.value, lastSeen: iso(r.lastSeen) });
        }
      }
      if (has(deviceArpRepo, 'findByMac')) {
        const rows = await best('routerArp', sources, () => deviceArpRepo.findByMac({ mac: spec.value, limit: ARP_LIMIT }), []);
        for (const r of rows || []) {
          if (r.ip) ident.ips.add(String(r.ip).toLowerCase());
          ident.reportedBy.push({ source: 'routerArp', deviceId: Number(r.deviceId), deviceName: deviceName(ctx.deviceById.get(Number(r.deviceId))), ip: r.ip, mac: spec.value, lastSeen: iso(r.lastSeen) });
        }
      }
      // The MAC's own address may be an agent's.
      const a = ctx.agents.find((x) => agentIps(x).some((ip) => ident.ips.has(ip)));
      if (a) { takeAgent(ident, a); ident.found = true; }
    } else {
      // A hostname: an agent, a switch, or a discovered address — exactly, or
      // as the short name of an FQDN. Never a substring: "sw1" must not answer
      // for "sw10".
      const q = spec.value;
      const nameHit = (v) => { const k = lower(v); return !!k && (k === q || k.startsWith(`${q}.`)); };
      const agents = ctx.agents.filter((a) => nameHit(a.hostname) || nameHit(a.display_name));
      // A switch answers to the name an admin gave it, its address, and the
      // name it calls itself (SNMPv2-MIB sysName) — the last is what a
      // technician reads off the CLI prompt, and what /api/search already finds.
      const devices = ctx.allDevices.filter((d) => nameHit(d.displayName) || nameHit(d.host) || nameHit(d.sysName));
      let discovered = [];
      if (!agents.length && !devices.length && has(discoveredDevicesRepo, 'search')) {
        discovered = (await best('discovery', sources, () => discoveredDevicesRepo.search({ q, limit: 10 }), []) || [])
          .filter((r) => nameHit(r.hostname));
      }
      const all = [
        ...agents.map((a) => ({ kind: 'agent', label: agentName(a), ref: a })),
        ...devices.map((d) => ({ kind: 'switch', label: deviceName(d), ref: d })),
        ...discovered.map((r) => ({ kind: 'discovered', label: r.hostname || r.ip, ref: r })),
      ];
      if (!all.length) return ident;
      const pick = all[0];
      if (all.length > 1) {
        ident.alternatives = all.slice(1, MAX_NAME_MATCHES + 1).map((m) => ({ kind: m.kind, label: m.label }));
        ident.uncertainties.push(uncertainty('ambiguousName', 'warn',
          `"${spec.raw}" matches ${all.length} things; this answer is for ${pick.label} (${pick.kind}).`,
          { matches: all.slice(0, MAX_NAME_MATCHES + 1).map((m) => ({ kind: m.kind, label: m.label })) }));
      }
      if (pick.kind === 'agent') takeAgent(ident, pick.ref);
      else if (pick.kind === 'switch') takeDevice(ident, pick.ref);
      else {
        ident.found = true;
        ident.discoveredId = pick.ref.id;
        ident.hostname = pick.ref.hostname || null;
        ident.label = pick.ref.hostname || pick.ref.ip;
        if (pick.ref.ip) ident.ips.add(String(pick.ref.ip).toLowerCase());
        ident.reportedBy.push({ source: 'discovery', agentId: pick.ref.foundByAgentId ?? null, agentName: agentName(ctx.agentById.get(Number(pick.ref.foundByAgentId))), ip: pick.ref.ip, lastSeen: iso(pick.ref.lastSeen), firstSeen: iso(pick.ref.firstSeen) });
      }
    }

    // IP -> MAC for whatever addresses the identity now carries.
    if (spec.kind !== 'mac' && ident.deviceId == null) {
      for (const ip of [...ident.ips].slice(0, MAX_ENDPOINT_IPS)) await macsForIp(ident, ip, ctx, sources);
    }
    // An agent's LLDP chassis id is usually one of its own NIC MACs — a
    // weaker candidate, used when nothing's ARP table knows its address.
    if (ident.agentId != null && !ident.macs.size && has(lldpNeighborsRepo, 'listByAgent')) {
      const rows = await best('agentLldp', sources, () => lldpNeighborsRepo.listByAgent(ident.agentId), []);
      for (const r of (rows || []).slice(0, 20)) {
        if (normaliseMac(r.localChassisId)) addMac(ident, r.localChassisId, 'lldp', { lastSeen: r.lastSeen });
      }
    }
    const ipMacs = [...ident.macs.values()].filter((m) => m.sources.includes('arp') || m.sources.includes('routerArp'));
    if (spec.kind === 'ip' && ipMacs.length > 1) {
      ident.uncertainties.push(uncertainty('ipMultipleMacs', 'warn',
        `${spec.raw} is held by ${ipMacs.length} different MACs in the ARP tables read — the same private address at two sites, or an address that changed hands.`,
        { macs: ipMacs.map((m) => m.mac) }));
    }
    return ident;
  }

  // ---- location: which switch port the identity is on -----------------------
  async function locate(ident, ctx) {
    ident.location = null;
    ident.fdbRows = [];
    if (ident.deviceId != null) {
      // The endpoint IS a switch. It is its own location; a disabled one is not
      // in the graph, and a path to it cannot be walked.
      const d = ctx.deviceById.get(ident.deviceId);
      if (!ctx.graph.devices.has(ident.deviceId)) {
        ident.uncertainties.push(uncertainty('deviceDisabled', 'warn',
          `${deviceName(d)} is disabled in the SNMP inventory, so its links are not in the switch graph.`, { deviceId: ident.deviceId }));
      }
      ident.location = { deviceId: ident.deviceId, ifName: null, vlan: null, self: true, lastSeen: d ? d.lastOkAt : null };
      return ident;
    }
    if (!ident.macs.size) {
      if (ident.found) {
        ident.uncertainties.push(uncertainty('noMac', 'warn',
          `No ARP table read by this server maps ${[...ident.ips].slice(0, 3).join(', ') || ident.label} to a MAC address, so it cannot be looked up in the switches' forwarding tables.`,
          { ips: [...ident.ips].slice(0, MAX_ENDPOINT_IPS) }));
      }
      return ident;
    }
    const macs = [...ident.macs.values()]
      .sort((a, b) => (toMs(b.lastSeen) || 0) - (toMs(a.lastSeen) || 0))
      .slice(0, MAX_CANDIDATE_MACS);
    const located = [];
    let uplinkOnly = null;
    for (const m of macs) {
      const rows = ((await fdbEntriesRepo.findByMac(m.mac, { limit: FDB_LIMIT })) || []).map((r) => ({ ...r, mac: m.mac }));
      const pick = pickAccessPort(rows, ctx.graph);
      if (pick.self != null) {
        const d = ctx.deviceById.get(pick.self);
        takeDevice(ident, d || { id: pick.self });
        ident.location = { deviceId: pick.self, ifName: null, vlan: null, self: true, lastSeen: null };
        ident.fdbRows = rows;
        return ident;
      }
      if (pick.port) located.push({ mac: m.mac, port: pick.port, rows });
      else if (pick.uplinkOnly) uplinkOnly = { mac: m.mac, rows };
    }
    if (!located.length) {
      if (uplinkOnly) {
        const seen = uplinkOnly.rows.slice(0, 5).map((r) => ({ deviceId: r.deviceId, name: deviceName(ctx.deviceById.get(Number(r.deviceId))), ifName: r.ifName }));
        ident.uncertainties.push(uncertainty('uplinkOnly', 'warn',
          `${uplinkOnly.mac} is only learned on ports that face other managed switches — its own access switch is not polled (or not reporting its forwarding table).`,
          { mac: uplinkOnly.mac, seenOn: seen }));
        ident.fdbRows = uplinkOnly.rows;
      } else {
        ident.uncertainties.push(uncertainty('notInFdb', 'warn',
          `${macs.map((m) => m.mac).join(', ')} is not in any polled switch's forwarding table — the switch it is on is not polled, or the entry aged out (a quiet host is forgotten by its switch in minutes).`,
          { macs: macs.map((m) => m.mac) }));
      }
      return ident;
    }
    located.sort((a, b) => (toMs(b.port.lastSeen) || 0) - (toMs(a.port.lastSeen) || 0));
    const chosen = located[0];
    ident.location = { ...chosen.port, mac: chosen.mac, self: false };
    ident.fdbRows = chosen.rows;
    const elsewhere = located.slice(1).filter((l) => portKey(l.port.deviceId, l.port.ifName) !== portKey(chosen.port.deviceId, chosen.port.ifName));
    if (elsewhere.length) {
      ident.alternatives.push(...elsewhere.map((l) => ({ kind: 'port', mac: l.mac, deviceId: l.port.deviceId, name: deviceName(ctx.deviceById.get(l.port.deviceId)), ifName: l.port.ifName, lastSeen: l.port.lastSeen })));
      ident.uncertainties.push(uncertainty('ambiguousEndpoint', 'warn',
        `${ident.label} has ${located.length} MACs on different switch ports; the freshest (${chosen.mac} on ${deviceName(ctx.deviceById.get(chosen.port.deviceId))} ${chosen.port.ifName}) is used.`,
        { alternatives: ident.alternatives.filter((x) => x.kind === 'port') }));
    }
    if (chosen.port.sharedPort) {
      ident.uncertainties.push(uncertainty('sharedPort', 'info',
        `${chosen.port.ifName} on ${deviceName(ctx.deviceById.get(chosen.port.deviceId))} has ${chosen.port.portMacCount} MACs behind it — an unmanaged switch, an access point or a hypervisor probably sits between ${ident.label} and this port.`,
        { deviceId: chosen.port.deviceId, ifName: chosen.port.ifName, portMacCount: chosen.port.portMacCount }));
    }
    if (chosen.port.neighbours && chosen.port.neighbours.length) {
      ident.uncertainties.push(uncertainty('neighbourOnPort', 'info',
        `${chosen.port.ifName} reports an LLDP/CDP neighbour this server does not poll (${chosen.port.neighbours.map((n) => n.sysName || n.chassisId).filter(Boolean).join(', ')}) — ${ident.label} may be behind it rather than on the port itself.`,
        { deviceId: chosen.port.deviceId, ifName: chosen.port.ifName, neighbours: chosen.port.neighbours }));
    }
    return ident;
  }

  function summary(ident, ctx) {
    if (!ident) return null;
    const loc = ident.location;
    const d = loc ? ctx.deviceById.get(loc.deviceId) : null;
    const siteId = d && d.locationId != null ? Number(d.locationId) : ident.siteId;
    return {
      input: ident.input,
      kind: ident.kind,
      label: ident.label,
      hostname: ident.hostname,
      agentId: ident.agentId,
      deviceId: ident.deviceId,
      discoveredId: ident.discoveredId,
      ips: [...ident.ips].slice(0, 16),
      macs: [...ident.macs.values()].slice(0, 8).map((m) => ({
        mac: m.mac,
        vendor: vendorForMac(m.mac, ouiTable),
        locallyAdministered: isLocallyAdministered(m.mac),
        sources: m.sources,
        lastSeen: iso(m.lastSeen),
      })),
      site: siteId != null ? { id: siteId, name: ctx.siteName.get(siteId) || null } : null,
      location: loc ? {
        deviceId: loc.deviceId,
        deviceName: deviceName(d),
        host: d ? d.host || null : null,
        sysLocation: d ? d.sysLocation ?? null : null,
        ifName: loc.ifName || null,
        mac: loc.mac || null,
        vlan: loc.vlan ?? null,
        portMacCount: loc.portMacCount ?? null,
        sharedPort: !!loc.sharedPort,
        self: !!loc.self,
        firstSeen: iso(loc.firstSeen),
        lastSeen: iso(loc.lastSeen),
      } : null,
      alternatives: ident.alternatives,
      found: ident.found,
    };
  }

  // ---- port decorations: status, speed, errors, utilisation ----------------
  async function portInfo(deviceIds, sources) {
    const out = new Map();
    await Promise.all([...deviceIds].map(async (id) => {
      const ifaces = has(deviceInterfacesRepo, 'listForDevice')
        ? await best('interfaces', sources, () => deviceInterfacesRepo.listForDevice(id, { limit: INTERFACE_LIMIT }), [])
        : (sources.interfaces = 'unavailable', []);
      const counters = has(counterSamplesRepo, 'latestForDevice')
        ? await best('counters', sources, () => counterSamplesRepo.latestForDevice(id), new Map())
        : (sources.counters = 'unavailable', new Map());
      const byName = new Map();
      for (const i of ifaces || []) if (i && i.ifName) byName.set(String(i.ifName).toLowerCase(), i);
      out.set(id, { byName, counters: counters instanceof Map ? counters : new Map() });
    }));
    return out;
  }

  function describePort(info, ifName) {
    if (!ifName) return null;
    const i = info ? info.byName.get(String(ifName).toLowerCase()) : null;
    if (!i) return { ifName, known: false };
    const s = info.counters.get(Number(i.id)) || null;
    const n = numOrNull;
    return {
      ifName,
      known: true,
      alias: i.ifAlias || null,
      operStatus: i.operStatus || null,
      adminStatus: i.adminStatus || null,
      speedMbps: n(i.speedMbps),
      polledAt: iso(i.lastSeen),
      counters: s ? {
        at: iso(s.ts),
        inErrPps: n(s.inErrPps), outErrPps: n(s.outErrPps),
        inDiscPps: n(s.inDiscPps), outDiscPps: n(s.outDiscPps),
        inUtilPct: n(s.inUtilPct), outUtilPct: n(s.outUtilPct),
        inBps: n(s.inBps), outBps: n(s.outBps),
      } : null,
    };
  }

  async function decorate(segments, sources) {
    const ids = new Set();
    for (const s of segments) for (const h of s.hops) if (h.type === 'switch') ids.add(h.deviceId);
    const info = await portInfo(ids, sources);
    for (const s of segments) {
      for (const h of s.hops) {
        if (h.type !== 'switch') continue;
        const pi = info.get(h.deviceId);
        h.ingress = { ...h.ingress, port: describePort(pi, h.ingress.ifName) };
        h.egress = { ...h.egress, port: describePort(pi, h.egress.ifName) };
        h.vlans = [...new Set(h.sightings.map((x) => x.vlan).filter((v) => v != null))].sort((a, b) => a - b);
      }
    }
  }

  // The router between two subnets: a device whose ARP table holds BOTH ends.
  async function inferGateway(a, b, ctx, sources) {
    if (!has(deviceArpRepo, 'findByIp')) return null;
    const devicesFor = async (ident) => {
      const set = new Map();
      for (const ip of [...ident.ips].slice(0, MAX_ENDPOINT_IPS)) {
        const rows = await best('routerArp', sources, () => deviceArpRepo.findByIp({ ip, limit: ARP_LIMIT }), []);
        for (const r of rows || []) if (r && r.deviceId != null) set.set(Number(r.deviceId), r);
      }
      return set;
    };
    const [sa, sb] = [await devicesFor(a), await devicesFor(b)];
    const common = [...sa.keys()].filter((id) => sb.has(id)).sort((x, y) => x - y);
    if (!common.length) return null;
    const id = common[0];
    const d = ctx.deviceById.get(id);
    const ident = blankIdentity({ raw: deviceName(d) || `#${id}`, kind: 'router' });
    ident.found = true;
    ident.deviceId = id;
    ident.label = deviceName(d) || `#${id}`;
    ident.reportedBy.push({ source: 'routerArp', deviceId: id, deviceName: ident.label, ips: [sa.get(id).ip, sb.get(id).ip] });
    if (ctx.graph.devices.has(id)) {
      ident.location = { deviceId: id, ifName: null, vlan: null, self: true };
      return ident;
    }
    // Not a node of the graph: find the router by its own port MACs.
    if (has(deviceInterfacesRepo, 'listForDevice')) {
      const ifaces = await best('interfaces', sources, () => deviceInterfacesRepo.listForDevice(id, { limit: INTERFACE_LIMIT }), []);
      for (const i of (ifaces || []).slice(0, 64)) if (i && i.physAddress) addMac(ident, i.physAddress, 'routerPort');
      ident.deviceId = null; // locate by MAC; the router itself is not walkable
      await locate(ident, ctx);
      ident.deviceId = id;
    }
    return ident.location ? ident : null;
  }

  // ---- the three questions --------------------------------------------------
  async function path({ from, to, gateway = null }) {
    if (!canLocate()) return { unavailable: true };
    const sources = {};
    const ctx = await loadContext(sources);
    const [a, b] = await Promise.all([identify(from, ctx, sources), identify(to, ctx, sources)]);
    const missing = [];
    if (!a.found) missing.push('from');
    if (!b.found) missing.push('to');
    if (missing.length) return { notFound: missing };
    await locate(a, ctx);
    await locate(b, ctx);
    a.rows = a.fdbRows; b.rows = b.fdbRows;

    const uncertainties = [
      ...a.uncertainties.map((u) => ({ ...u, endpoint: 'from' })),
      ...b.uncertainties.map((u) => ({ ...u, endpoint: 'to' })),
    ];
    const vlanA = a.location ? a.location.vlan ?? null : null;
    const vlanB = b.location ? b.location.vlan ?? null : null;
    const shared = vlanA != null && vlanB != null ? vlanA === vlanB : null;
    const routed = shared === false;
    if (a.location && b.location && (vlanA == null || vlanB == null) && !a.location.self && !b.location.self) {
      uncertainties.push(uncertainty('vlanUnknown', 'info',
        'At least one switch did not say which VLAN the endpoint is in (BRIDGE-MIB only), so whether the two share a VLAN is unknown.',
        { from: vlanA, to: vlanB }));
    }

    let gw = null;
    const segments = [];
    // A gateway the caller NAMED splits the path too, unless the two ends are
    // known to share a VLAN (then no router is in the way).
    if (routed || (gateway && shared !== true)) {
      if (routed) {
        uncertainties.push(uncertainty('differentVlans', 'info',
          `Different VLANs (${vlanA} and ${vlanB}) — traffic is routed; the L2 path ends at the gateway.`,
          { from: vlanA, to: vlanB }));
      }
      if (gateway) {
        gw = await identify(gateway, ctx, sources);
        if (gw.found) await locate(gw, ctx);
        else uncertainties.push(uncertainty('gatewayNotFound', 'warn', `The gateway "${gateway.raw}" is not known to this server.`, { gateway: gateway.raw }));
      } else {
        gw = await inferGateway(a, b, ctx, sources);
      }
      if (gw && gw.location) {
        gw.rows = gw.fdbRows || [];
        const s1 = computeSegment(ctx.graph, a, gw, { names: ['from', 'gateway'] });
        const s2 = computeSegment(ctx.graph, gw, b, { names: ['gateway', 'to'] });
        segments.push({ from: 'from', to: 'gateway', complete: s1.complete, hops: s1.hops });
        segments.push({ from: 'gateway', to: 'to', complete: s2.complete, hops: s2.hops });
        uncertainties.push(...s1.uncertainties, ...s2.uncertainties);
      } else {
        if (gw && !gw.location) uncertainties.push(...gw.uncertainties.map((u) => ({ ...u, endpoint: 'gateway' })));
        uncertainties.push(uncertainty('gatewayUnknown', 'warn',
          gateway
            ? `The gateway "${gateway.raw}" could not be placed on a switch port, so the path is not split there. The path below is the physical switch path between the two access switches.`
            : 'The gateway between the two VLANs could not be located (no router ARP table holds both addresses). The path below is the physical switch path between the two access switches — traffic may leave it at the gateway. Pass gateway=<ip|mac|hostname> to split it there.',
          { routerArp: has(deviceArpRepo, 'findByIp') ? 'no common router' : 'not collected', gateway: gateway ? gateway.raw : null }));
      }
    }
    if (!segments.length && a.location && b.location) {
      const s = computeSegment(ctx.graph, a, b, { names: ['from', 'to'] });
      segments.push({ from: 'from', to: 'to', complete: s.complete, physicalOnly: routed || undefined, hops: s.hops });
      uncertainties.push(...s.uncertainties);
    }
    await decorate(segments, sources);
    for (const s of segments) {
      for (const h of s.hops) {
        if (h.type === 'switch') h.siteName = h.siteId != null ? ctx.siteName.get(h.siteId) || null : null;
      }
    }
    return {
      from: summary(a, ctx),
      to: summary(b, ctx),
      gateway: gw ? summary(gw, ctx) : null,
      vlans: { from: vlanA, to: vlanB, shared },
      routed,
      complete: segments.length > 0 && segments.every((s) => s.complete),
      segments,
      uncertainties,
      graph: { switches: ctx.graph.devices.size, links: ctx.graph.links },
      sources,
      generatedAt: now().toISOString(),
    };
  }

  async function where({ q }) {
    const sources = {};
    const ctx = canLocate() ? await loadContext(sources) : await (async () => {
      sources.fdb = 'unavailable';
      const empty = buildSwitchGraph({});
      const agents = has(agentsRepo, 'findAll') ? await best('agents', sources, () => agentsRepo.findAll(), []) : [];
      return { graph: empty, allDevices: [], deviceById: new Map(), agents, agentById: new Map(agents.map((a) => [Number(a.id), a])), siteName: new Map() };
    })();
    const ident = await identify(q, ctx, sources);
    if (!ident.found) return null;
    if (canLocate()) await locate(ident, ctx);
    else ident.location = null;
    const out = summary(ident, ctx);
    let port = null;
    let vlanName = null;
    if (out.location && out.location.ifName) {
      const info = await portInfo(new Set([out.location.deviceId]), sources);
      port = describePort(info.get(out.location.deviceId), out.location.ifName);
      if (out.location.vlan != null && has(fdbEntriesRepo, 'listVlans')) {
        const vlans = await best('vlanNames', sources, () => fdbEntriesRepo.listVlans(out.location.deviceId, { limit: 4096 }), []);
        const v = (vlans || []).find((x) => Number(x.vlan) === out.location.vlan);
        vlanName = v ? v.name : null;
      }
    }
    const fdbBy = (ident.fdbRows || []).slice(0, 10).map((r) => ({
      source: 'fdb', deviceId: Number(r.deviceId), deviceName: deviceName(ctx.deviceById.get(Number(r.deviceId))),
      ifName: r.ifName || null, vlan: Number(r.vlan) > 0 ? Number(r.vlan) : null, portMacCount: r.portMacCount ?? null,
      mac: r.mac || null, lastSeen: iso(r.lastSeen), firstSeen: iso(r.firstSeen),
    }));
    const times = [...(ident.fdbRows || []), ...ident.reportedBy].map((r) => r);
    const firstSeen = times.reduce((m, r) => { const t = toMs(r.firstSeen); return t != null && (m == null || t < m) ? t : m; }, null);
    const lastSeen = times.reduce((m, r) => { const t = toMs(r.lastSeen); return t != null && (m == null || t > m) ? t : m; }, null);
    return {
      query: q.raw,
      ...out,
      port,
      vlanName,
      firstSeen: firstSeen == null ? null : new Date(firstSeen).toISOString(),
      lastSeen: lastSeen == null ? null : new Date(lastSeen).toISOString(),
      reportedBy: [...ident.reportedBy.slice(0, 20), ...fdbBy],
      uncertainties: ident.uncertainties,
      sources,
      generatedAt: now().toISOString(),
    };
  }

  // Every device this server knows, with its best-known location, in one
  // bounded list: agents, polled switches, discovery candidates, and hosts only
  // an ARP table has seen.
  async function inventory({ limit = 50, offset = 0, kind = null, q = null } = {}) {
    const at = now();
    const sources = {};
    const [agents, devices] = await Promise.all([
      has(agentsRepo, 'findAll') ? agentsRepo.findAll() : [],
      has(snmpDevicesRepo, 'list') ? snmpDevicesRepo.list({}) : [],
    ]);
    const [sites, discovered, arp, portMacs, neighbours, deviceMacs] = await Promise.all([
      has(locationsRepo, 'findAll') ? best('sites', sources, () => locationsRepo.findAll(), []) : [],
      has(discoveredDevicesRepo, 'list')
        ? best('discovery', sources, () => discoveredDevicesRepo.list({ limit: INVENTORY_DISCOVERED_LIMIT }), [])
        : (sources.discovery = 'unavailable', []),
      has(arpEntriesRepo, 'listRecent')
        ? best('arp', sources, () => arpEntriesRepo.listRecent({ since: new Date(at.getTime() - INVENTORY_ARP_WINDOW_MS), limit: INVENTORY_ARP_LIMIT }), [])
        : (sources.arp = 'unavailable', []),
      has(fdbEntriesRepo, 'listUpPortMacs')
        ? best('fdb', sources, () => fdbEntriesRepo.listUpPortMacs({ since: new Date(at.getTime() - INVENTORY_FDB_WINDOW_MS), limit: INVENTORY_PORT_MAC_LIMIT }), [])
        : (sources.fdb = 'unavailable', []),
      has(snmpNeighborsRepo, 'listAll') ? best('neighbours', sources, () => snmpNeighborsRepo.listAll({ limit: NEIGHBOUR_LIMIT }), []) : [],
      has(deviceInterfacesRepo, 'listMacs') ? best('deviceMacs', sources, () => deviceInterfacesRepo.listMacs({ limit: DEVICE_MAC_LIMIT }), []) : [],
    ]);
    const result = buildInventory({
      agents, devices: (devices || []).slice(0, MAX_DEVICES), sites, discovered, arp, portMacs, neighbours, deviceMacs, ouiTable,
    });
    const capped = {
      arp: Array.isArray(arp) && arp.length >= INVENTORY_ARP_LIMIT,
      fdb: Array.isArray(portMacs) && portMacs.length >= INVENTORY_PORT_MAC_LIMIT,
      discovery: Array.isArray(discovered) && discovered.length >= INVENTORY_DISCOVERED_LIMIT,
    };
    let items = result.items;
    if (kind) items = items.filter((i) => i.kind === kind);
    if (q) {
      // A switch's sysName and sysLocation are searchable too: "rack b" finds
      // what is in rack B, and the name on the CLI prompt finds the switch.
      items = items.filter((i) => [i.name, i.hostname, i.sysName, i.location && i.location.self ? i.location.sysLocation : null,
        ...i.ips, ...i.macs.map((m) => m.mac)]
        .some((v) => v != null && String(v).toLowerCase().includes(q)));
    }
    return {
      total: items.length,
      limit,
      offset,
      items: items.slice(offset, offset + limit),
      counts: result.counts,
      capped,
      partial: Object.values(sources).includes('failed'),
      sources,
      generatedAt: at.toISOString(),
    };
  }

  return { path, where, inventory, canLocate };
}

// The inventory merge, pure. One row per thing, keyed so the same device seen
// by three sources is one row with three sources rather than three rows:
//   an agent owns its reported IPs; a switch owns its management address; a
//   discovery candidate or an ARP-only host that shares an address with either
//   is folded into it. ARP-only hosts are grouped by MAC.
const KIND_ORDER = { agent: 0, switch: 1, discovered: 2, host: 3 };

function buildInventory({
  agents = [], devices = [], sites = [], discovered = [], arp = [], portMacs = [], neighbours = [], deviceMacs = [], ouiTable,
} = {}) {
  const graph = buildSwitchGraph({ devices, neighbours, deviceMacs });
  const siteName = new Map((sites || []).map((s) => [Number(s.id), s.name]));
  const deviceById = new Map((devices || []).map((d) => [Number(d.id), d]));
  const agentById = new Map((agents || []).map((a) => [Number(a.id), a]));
  const items = [];
  const byIp = new Map();
  const claimIp = (ip, item) => { const k = lower(ip); if (k && !byIp.has(k)) byIp.set(k, item); };
  const mk = (o) => ({ hostname: null, ips: [], macs: [], siteId: null, lastSeen: null, sources: [], location: null, ...o });

  for (const a of agents || []) {
    if (!a || a.id == null) continue;
    const item = mk({
      key: `agent:${a.id}`, kind: 'agent', id: Number(a.id), name: agentName(a), hostname: a.hostname || null,
      ips: agentIps(a), siteId: a.location_id == null ? null : Number(a.location_id),
      lastSeen: iso(a.last_seen), status: a.status || null, sources: ['agent'],
    });
    items.push(item);
    for (const ip of item.ips) claimIp(ip, item);
  }
  for (const d of devices || []) {
    if (!d || d.id == null) continue;
    const item = mk({
      key: `switch:${d.id}`, kind: 'switch', id: Number(d.id), name: deviceName(d),
      ips: d.host && isIp(d.host) ? [String(d.host).toLowerCase()] : [],
      hostname: d.host && !isIp(d.host) ? d.host : null,
      siteId: d.locationId == null ? null : Number(d.locationId), lastSeen: iso(d.lastOkAt),
      sysName: d.sysName ?? null,
      enabled: d.enabled !== false, sources: ['snmp'],
      location: { deviceId: Number(d.id), deviceName: deviceName(d), ifName: null, self: true, sysLocation: d.sysLocation ?? null },
    });
    items.push(item);
    for (const ip of item.ips) claimIp(ip, item);
  }
  for (const r of discovered || []) {
    if (!r || !r.ip || r.status === 'ignored') continue;
    const owner = byIp.get(lower(r.ip)) || (r.promotedAgentId != null ? items.find((i) => i.key === `agent:${r.promotedAgentId}`) : null);
    if (owner) {
      if (!owner.sources.includes('discovery')) owner.sources.push('discovery');
      if (!owner.hostname && r.hostname) owner.hostname = r.hostname;
      continue;
    }
    const finder = agentById.get(Number(r.foundByAgentId));
    const item = mk({
      key: `discovered:${r.id}`, kind: 'discovered', id: Number(r.id), name: r.hostname || r.ip, hostname: r.hostname || null,
      ips: [String(r.ip).toLowerCase()], siteId: finder && finder.location_id != null ? Number(finder.location_id) : null,
      lastSeen: iso(r.lastSeen), status: r.status || null, sources: ['discovery'],
    });
    items.push(item);
    claimIp(r.ip, item);
  }
  const hostByMac = new Map();
  const addItemMac = (item, mac, lastSeen) => {
    let m = item.macs.find((x) => x.mac === mac);
    if (!m) {
      m = { mac, vendor: vendorForMac(mac, ouiTable), locallyAdministered: isLocallyAdministered(mac) };
      item.macs.push(m);
    }
    item.lastSeen = item.lastSeen ? newer(item.lastSeen, iso(lastSeen)) : iso(lastSeen);
  };
  for (const r of arp || []) {
    const mac = normalizeMac(r && r.mac);
    if (!mac || !isUsableMac(mac) || !r.ip) continue;
    const owner = byIp.get(lower(r.ip));
    if (owner) {
      // An agent's own table never lists itself; another agent's does.
      if (owner.kind === 'agent' && Number(r.agentId) === owner.id) continue;
      if (owner.macs.length < 8) addItemMac(owner, mac, r.lastSeen);
      if (!owner.sources.includes('arp')) owner.sources.push('arp');
      continue;
    }
    let item = hostByMac.get(mac);
    if (!item) {
      const reporter = agentById.get(Number(r.agentId));
      item = mk({
        key: `host:${mac}`, kind: 'host', id: null, name: String(r.ip), sources: ['arp'],
        siteId: reporter && reporter.location_id != null ? Number(reporter.location_id) : null,
        reportedBy: [],
      });
      hostByMac.set(mac, item);
      items.push(item);
    }
    const ip = String(r.ip).toLowerCase();
    if (!item.ips.includes(ip) && item.ips.length < 8) item.ips.push(ip);
    if (!item.reportedBy.includes(Number(r.agentId)) && item.reportedBy.length < 8) item.reportedBy.push(Number(r.agentId));
    addItemMac(item, mac, r.lastSeen);
  }

  // Best-known location, from the up-port MAC table: the access port per MAC.
  const rowsByMac = new Map();
  for (const r of portMacs || []) {
    const mac = normalizeMac(r && r.mac);
    if (!mac) continue;
    if (!rowsByMac.has(mac)) rowsByMac.set(mac, []);
    rowsByMac.get(mac).push({ ...r, mac, status: 'learned' });
  }
  for (const item of items) {
    if (item.location) continue;
    for (const m of item.macs) {
      const pick = pickAccessPort(rowsByMac.get(m.mac) || [], graph);
      if (!pick.port) continue;
      const d = deviceById.get(pick.port.deviceId);
      item.location = {
        deviceId: pick.port.deviceId, deviceName: deviceName(d), ifName: pick.port.ifName,
        sharedPort: pick.port.sharedPort, portMacCount: pick.port.portMacCount, mac: m.mac, self: false,
        sysLocation: d ? d.sysLocation ?? null : null,
      };
      if (d && d.locationId != null) item.siteId = Number(d.locationId);
      break;
    }
  }
  const counts = { agent: 0, switch: 0, discovered: 0, host: 0, located: 0 };
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.location) counts.located += 1;
    item.site = item.siteId != null ? { id: item.siteId, name: siteName.get(item.siteId) || null } : null;
    delete item.siteId;
  }
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
    || String(a.key).localeCompare(String(b.key)));
  return { items, counts };
}

module.exports = {
  createDeviceLocator,
  buildInventory,
  MAX_CANDIDATE_MACS,
  FDB_LIMIT,
  ARP_LIMIT,
};
