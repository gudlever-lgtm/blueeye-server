'use strict';

// "Which parts of the network do I NOT see?" — the coverage-gap report.
//
// WHY THIS EXISTS. Every other screen answers a question about what the
// product can see. None of them says where it is blind, and a monitoring
// system's blind spots are exactly where the next outage is explained too
// late: a site nobody put an agent in, a switch that has never answered its
// poll, an unmanaged switch in the path between two monitored ones, a /24 the
// neighbour tables keep mentioning that no agent sits in.
//
// EVERY GAP IS COMPUTED FROM WHAT THE DATABASE HOLDS, NEVER TICKED. The same
// rule the setup checklist follows (src/services/setupChecklist.js), for the
// same reason: a list somebody maintains by hand starts lying the day the
// network changes.
//
// "NO GAPS" IS ONLY AS GOOD AS THE CHECKS THAT RAN. Each gap belongs to a
// CHECK, each check names the sources it needs, and a check whose source could
// not be read is reported as SKIPPED — never as clean. An empty gap list with
// three skipped checks is not "fully covered", and the answer says which
// checks it is based on so the dashboard can say so too. Reporting an
// unreadable store as "nothing missing" would be inventing coverage, which is
// the one thing a coverage report must not do.
//
// EXPLAINABLE, NOT CLEVER. Each rule is a plain comparison between two things
// the product already stores ("a location with no agent", "a MAC on an up port
// that belongs to nothing we monitor"). Each gap carries the numbers it was
// decided on (`evidence`) and a suggested next step (`suggestion`), and the
// few heuristics there are — a /24 as "the subnet", four MACs on one port as
// "probably a switch" — are named constants, documented in docs/coverage.md.
//
// THE TEXT IS NOT HERE. This returns WHAT is true and the numbers; the
// dashboard says it in the reader's language (`coverage.*` in public/i18n.js).
//
// Pure: no I/O. src/coverage/coverageService.js gathers the sources.

const { normaliseMac, nameKey } = require('../topology/graph');
const { FLOW_SOURCES } = require('../services/setupChecklist');

// An online agent with no measurement for this long is connected but not
// reporting. Agents report every minute; half an hour is thirty missed
// reports, well past a restart or a slow cycle.
const STALE_REPORT_MINUTES = 30;
// A flow source that has sent nothing for a day is not exporting.
const FLOW_WINDOW_HOURS = 24;
// Unknown MACs on one port at or above this count read as a device with its
// own ports behind it (an unmanaged switch, an access point) rather than one
// host — which is why the gap is raised to a warning.
const MULTI_MAC_PORT = 4;
// How many examples a gap carries (ports on a switch, who saw a neighbour).
const SAMPLE = 5;
// Rows per gap kind in one answer. The summary counts every gap; the list is
// capped so one busy kind cannot bury the rest.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The checks, in the order the report lists them. `needs` must all have been
// read for the check to run at all; `optional` sources make it more precise,
// and a missing one makes the check PARTIAL rather than skipped.
const CHECKS = Object.freeze([
  { key: 'siteAgents', needs: ['locations', 'agents'], kinds: ['siteNoAgent'] },
  { key: 'siteSources', needs: ['locations', 'agents', 'snmpDevices'], kinds: ['siteNoFlowOrSnmp'] },
  { key: 'agentHealth', needs: ['agents'], kinds: ['agentOffline', 'agentStale'] },
  { key: 'agentSource', needs: ['agents'], kinds: ['agentProcOnly'] },
  { key: 'flowCoverage', needs: ['agents', 'flows'], kinds: ['agentNoFlows', 'siteNoFlows'] },
  { key: 'snmpPolling', needs: ['snmpDevices'], kinds: ['deviceDisabled', 'deviceNoPoller', 'deviceNeverPolled', 'deviceError'] },
  { key: 'snmpCredentials', needs: ['snmpDevices', 'credentials'], kinds: ['deviceNoCredential'] },
  { key: 'snmpCollect', needs: ['snmpDevices'], kinds: ['deviceNoCounters', 'deviceNoLldp', 'deviceNoFdb'] },
  {
    key: 'switchPorts',
    needs: ['snmpDevices', 'portMacs', 'deviceNeighbours', 'deviceMacs'],
    optional: ['agentMacs', 'agentNeighbours'],
    kinds: ['unmonitoredHosts'],
  },
  {
    key: 'switchNeighbours',
    needs: ['snmpDevices', 'agents', 'deviceNeighbours', 'deviceMacs'],
    optional: ['agentMacs', 'agentNeighbours'],
    kinds: ['unmanagedNeighbour'],
  },
  {
    key: 'agentNeighbours',
    needs: ['snmpDevices', 'agents', 'agentNeighbours', 'deviceMacs'],
    optional: ['agentMacs'],
    kinds: ['unmanagedNeighbour'],
  },
  { key: 'subnets', needs: ['agents', 'arpSubnets'], kinds: ['subnetUncovered'] },
  { key: 'discovery', needs: ['discovered'], kinds: ['discoveredPending'] },
]);

// Every kind, with its scope — the order the dashboard groups them in.
const KINDS = Object.freeze({
  siteNoAgent: 'site',
  siteNoFlowOrSnmp: 'site',
  siteNoFlows: 'site',
  agentOffline: 'agent',
  agentStale: 'agent',
  agentNoFlows: 'agent',
  agentProcOnly: 'agent',
  deviceNoPoller: 'device',
  deviceNeverPolled: 'device',
  deviceError: 'device',
  deviceNoCredential: 'device',
  deviceDisabled: 'device',
  deviceNoCounters: 'device',
  deviceNoLldp: 'device',
  deviceNoFdb: 'device',
  unmonitoredHosts: 'device',
  unmanagedNeighbour: 'device',
  subnetUncovered: 'subnet',
  discoveredPending: 'device',
});

const asArray = (v) => (Array.isArray(v) ? v : []);
const toMs = (v) => {
  if (v == null || v === '') return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const iso = (v) => {
  const ms = toMs(v);
  return ms == null ? null : new Date(ms).toISOString();
};

function clampLimit(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

function sourceOf(agent) {
  const mc = agent && agent.monitor_config;
  return String((mc && typeof mc === 'object' && mc.source) || 'proc');
}
const agentLabel = (a) => a.display_name || a.hostname || `#${a.id}`;
const deviceLabel = (d) => d.displayName || d.host || `#${d.id}`;

// `a.b.c.d` -> `a.b.c`, or null for anything that is not a dotted quad.
function prefix24(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}
// Space that is never "a subnet we should have an agent in": this host,
// link-local, multicast and above.
function reservedPrefix(prefix) {
  const [a, b] = String(prefix).split('.').map(Number);
  return a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254);
}

function agentIps(agent) {
  const caps = agent && agent.capabilities;
  return caps && typeof caps === 'object' && Array.isArray(caps.ips) ? caps.ips : [];
}

// Builds the report from already-read sources. Each source is
//   { status: 'ok' | 'unavailable' | 'failed', value, capped }
// where `unavailable` means this install has no such store wired and
// `capped` means the read hit its bound, so the answer may be incomplete.
function buildCoverageReport(input) {
  const f = input && typeof input === 'object' ? input : {};
  const sources = f.sources && typeof f.sources === 'object' ? f.sources : {};
  const nowMs = toMs(f.now) ?? Date.now();
  const limit = clampLimit(f.limit);

  const ok = (name) => !!(sources[name] && sources[name].status === 'ok');
  const val = (name) => (ok(name) ? sources[name].value : null);

  // ---- which checks can run ------------------------------------------------
  const checks = CHECKS.map((c) => {
    const missing = c.needs.filter((n) => !ok(n));
    const optionalMissing = asArray(c.optional).filter((n) => !ok(n));
    const capped = [...c.needs, ...asArray(c.optional)].filter((n) => ok(n) && sources[n].capped);
    let status = 'ok';
    if (missing.length) status = 'skipped';
    else if (optionalMissing.length || capped.length) status = 'partial';
    return {
      key: c.key,
      status,
      kinds: c.kinds.slice(),
      // The sources that decided it: what could not be read, and what was
      // read only up to its bound. Named so the dashboard can say WHY.
      missing: [...missing, ...optionalMissing],
      capped,
    };
  });
  const runs = (key) => {
    const c = checks.find((x) => x.key === key);
    return !!c && c.status !== 'skipped';
  };

  const gaps = [];
  const extraTotals = {}; // gaps counted but not listed (a source that pre-aggregates)
  const add = (kind, severity, subject, evidence, suggestion, link) => {
    gaps.push({
      kind,
      severity,
      scope: KINDS[kind],
      subject,
      evidence,
      suggestion,
      link: link || null,
    });
  };

  const allAgents = asArray(val('agents')).filter((a) => a && a.id != null);
  // Promoted discovery candidates are `agents` rows with platform 'snmp' and
  // no software behind them (agentsRepository.insertSnmpDevice). They are
  // known identities, but they measure nothing and never connect, so every
  // "is this agent healthy" rule would flag them forever.
  const agents = allAgents.filter((a) => a.platform !== 'snmp');
  const devices = asArray(val('snmpDevices')).filter((d) => d && d.id != null);
  const enabledDevices = devices.filter((d) => d.enabled !== false);
  const locations = asArray(val('locations')).filter((l) => l && l.id != null);

  const agentsBySite = new Map();
  for (const a of agents) {
    if (a.location_id == null) continue;
    const k = Number(a.location_id);
    if (!agentsBySite.has(k)) agentsBySite.set(k, []);
    agentsBySite.get(k).push(a);
  }
  const devicesBySite = new Map();
  for (const d of enabledDevices) {
    if (d.locationId == null) continue;
    const k = Number(d.locationId);
    devicesBySite.set(k, (devicesBySite.get(k) || 0) + 1);
  }

  // ---- sites ---------------------------------------------------------------
  if (runs('siteAgents')) {
    for (const l of locations) {
      if (agentsBySite.has(Number(l.id))) continue;
      add('siteNoAgent', 'warn', { id: Number(l.id), label: l.name || `#${l.id}` },
        { snmpDevices: ok('snmpDevices') ? (devicesBySite.get(Number(l.id)) || 0) : null },
        'enrollAgent', { view: 'enrollment' });
    }
  }

  // A site whose agents all count bytes on their own interfaces, with no
  // switch polled there either: it is on the map, and nothing in it is seen
  // except the agents themselves.
  const noSourceSites = new Set();
  if (runs('siteSources')) {
    for (const l of locations) {
      const here = agentsBySite.get(Number(l.id));
      if (!here || !here.length) continue; // siteNoAgent's job
      const flowAgents = here.filter((a) => FLOW_SOURCES.includes(sourceOf(a)));
      if (flowAgents.length || devicesBySite.get(Number(l.id))) continue;
      noSourceSites.add(Number(l.id));
      add('siteNoFlowOrSnmp', 'warn', { id: Number(l.id), label: l.name || `#${l.id}` },
        { agents: here.length, sources: [...new Set(here.map(sourceOf))].sort().join(', ') },
        'addFlowOrSnmp', { view: 'settings', tab: 'snmp' });
    }
  }

  // ---- agents --------------------------------------------------------------
  if (runs('agentHealth')) {
    for (const a of agents) {
      const subject = { id: Number(a.id), label: agentLabel(a) };
      if (a.status !== 'online') {
        add('agentOffline', 'warn', subject,
          { status: a.status || null, lastSeen: iso(a.last_seen), site: a.location_name || null },
          'checkAgent', { view: 'agent', id: Number(a.id) });
        continue;
      }
      const last = toMs(a.last_report_at);
      if (last == null || nowMs - last > STALE_REPORT_MINUTES * 60000) {
        add('agentStale', 'warn', subject,
          { lastReportAt: iso(a.last_report_at), lastSeen: iso(a.last_seen), staleMinutes: STALE_REPORT_MINUTES },
          'checkReporting', { view: 'agent', id: Number(a.id) });
      }
    }
  }

  if (runs('agentSource')) {
    for (const a of agents) {
      if (sourceOf(a) !== 'proc') continue;
      add('agentProcOnly', 'info', { id: Number(a.id), label: agentLabel(a) },
        { source: 'proc', site: a.location_name || null },
        'setFlowSource', { view: 'agent', id: Number(a.id) });
    }
  }

  if (runs('flowCoverage')) {
    const lastFlow = new Map();
    for (const r of asArray(val('flows'))) {
      if (r && r.agentId != null) lastFlow.set(Number(r.agentId), toMs(r.lastFlowAt));
    }
    const since = nowMs - FLOW_WINDOW_HOURS * 3600000;
    const recent = (a) => {
      const t = lastFlow.get(Number(a.id));
      return t != null && t >= since;
    };
    for (const a of agents) {
      // An offline agent is already on the list, and "no flows" from a host
      // that is not connected says nothing new about the exporter.
      if (a.status !== 'online' || !FLOW_SOURCES.includes(sourceOf(a)) || recent(a)) continue;
      const t = lastFlow.get(Number(a.id));
      add('agentNoFlows', 'warn', { id: Number(a.id), label: agentLabel(a) },
        { source: sourceOf(a), lastFlowAt: t == null ? null : new Date(t).toISOString(), windowHours: FLOW_WINDOW_HOURS },
        'checkFlowExport', { view: 'agent', id: Number(a.id) });
    }
    for (const [siteId, here] of agentsBySite) {
      // A site already reported as having no flow source at all says the
      // same thing more usefully; this one is for the sites that have a
      // source, or a switch, and still show no conversations.
      if (noSourceSites.has(siteId) || here.some(recent)) continue;
      add('siteNoFlows', 'info', { id: siteId, label: here[0].location_name || `#${siteId}` },
        { agents: here.length, windowHours: FLOW_WINDOW_HOURS },
        'checkFlowExport', { view: 'location', id: siteId });
    }
  }

  // ---- SNMP devices --------------------------------------------------------
  const devSubject = (d) => ({ id: Number(d.id), label: deviceLabel(d) });
  const devLink = (d) => ({ view: 'snmpDevice', id: Number(d.id) });
  if (runs('snmpPolling')) {
    for (const d of devices) {
      if (d.enabled === false) {
        add('deviceDisabled', 'info', devSubject(d), { host: d.host, lastOkAt: iso(d.lastOkAt) }, 'enableDevice', devLink(d));
        continue;
      }
      if (d.agentId == null) {
        add('deviceNoPoller', 'warn', devSubject(d), { host: d.host }, 'assignPoller', devLink(d));
        continue;
      }
      if (!d.lastOkAt) {
        add('deviceNeverPolled', 'warn', devSubject(d),
          { host: d.host, lastPolledAt: iso(d.lastPolledAt), lastError: d.lastError || null },
          'checkPolling', devLink(d));
      } else if (d.lastError) {
        add('deviceError', 'warn', devSubject(d),
          { host: d.host, lastError: d.lastError, lastOkAt: iso(d.lastOkAt), lastPolledAt: iso(d.lastPolledAt) },
          'checkPolling', devLink(d));
      }
    }
  }

  if (runs('snmpCredentials')) {
    const creds = val('credentials') instanceof Map ? val('credentials') : new Map();
    for (const d of enabledDevices) {
      const c = creds.get(Number(d.id));
      // Only devices the resolver actually answered for: one with its own
      // community, or no polling agent, was never asked (and is either fine
      // or already reported as deviceNoPoller).
      if (!c || c.resolved) continue;
      add('deviceNoCredential', 'warn', devSubject(d),
        { host: d.host, blocked: c.blocked != null, siteSet: d.locationId != null },
        c.blocked != null ? 'grantCredential' : 'assignCredential',
        { view: 'settings', tab: 'snmpcommunities' });
    }
  }

  if (runs('snmpCollect')) {
    for (const d of enabledDevices) {
      // Only a device that has answered at least once: before that, what it
      // collects is not the gap, reaching it is.
      if (!d.lastOkAt || d.agentId == null) continue;
      const collect = asArray(d.collect);
      const supported = Array.isArray(d.supported) ? d.supported : null;
      const gap = (what) => {
        const inCollect = collect.includes(what);
        const unsupported = !!supported && !supported.includes(what);
        return { inCollect, unsupported, missing: !inCollect || unsupported };
      };
      const counters = gap('ifcounters');
      const noInterval = counters.inCollect && d.counterIntervalSec == null;
      if (counters.missing || noInterval) {
        add('deviceNoCounters', 'info', devSubject(d),
          { host: d.host, inCollect: counters.inCollect, unsupported: counters.unsupported, noInterval },
          counters.inCollect && counters.unsupported ? 'deviceLacks' : 'enableCounters', devLink(d));
      }
      for (const [what, kind] of [['lldp', 'deviceNoLldp'], ['fdb', 'deviceNoFdb']]) {
        const g = gap(what);
        if (!g.missing) continue;
        add(kind, 'info', devSubject(d),
          { host: d.host, inCollect: g.inCollect, unsupported: g.unsupported },
          g.inCollect ? 'deviceLacks' : 'enableCollect', devLink(d));
      }
    }
  }

  // ---- identities: what "known" means for a MAC or a neighbour -------------
  // A port MAC we have read off a polled switch, an agent's own chassis from
  // its LLDP, or the MAC behind an agent's own IP in anybody's ARP table.
  const knownMacs = new Set();
  const deviceIds = new Set(devices.map((d) => Number(d.id)));
  for (const m of asArray(val('deviceMacs'))) {
    const mac = normaliseMac(m && m.physAddress);
    if (mac && deviceIds.has(Number(m.deviceId))) knownMacs.add(mac);
  }
  const agentChassisRaw = new Set();
  for (const r of asArray(val('agentNeighbours'))) {
    const mac = normaliseMac(r && r.localChassisId);
    if (mac) knownMacs.add(mac);
    const raw = nameKey(r && r.localChassisId);
    if (raw) agentChassisRaw.add(raw);
  }
  for (const r of asArray(val('agentMacs'))) {
    const mac = normaliseMac(r && r.mac);
    if (mac) knownMacs.add(mac);
  }
  const knownNames = new Set();
  const claim = (v) => { const k = nameKey(v); if (k) knownNames.add(k); };
  for (const d of devices) { claim(d.displayName); claim(d.host); }
  for (const a of allAgents) {
    claim(a.hostname); claim(a.display_name);
    for (const ip of agentIps(a)) claim(ip);
  }

  // ---- switch ports: hosts nothing monitors --------------------------------
  if (runs('switchPorts')) {
    const enabledIds = new Set(enabledDevices.map((d) => Number(d.id)));
    const lldpPorts = new Set();
    for (const n of asArray(val('deviceNeighbours'))) {
      if (n && n.localIfName) lldpPorts.add(`${Number(n.deviceId)}|${n.localIfName}`);
    }
    // One port per MAC: the one with the FEWEST MACs behind it. A host is
    // learned on its own access port and on every uplink between it and the
    // switch doing the reporting; the access port is the one with fewest
    // neighbours. Counting every sighting would count one PC once per hop.
    const edge = new Map();
    for (const r of asArray(val('portMacs'))) {
      if (!r || !r.ifName || !enabledIds.has(Number(r.deviceId))) continue;
      const mac = normaliseMac(r.mac);
      if (!mac) continue;
      const cur = edge.get(mac);
      if (!cur || (Number(r.portMacCount) || 1) < (Number(cur.portMacCount) || 1)) edge.set(mac, { ...r, mac });
    }
    const perDevice = new Map();
    for (const r of edge.values()) {
      // Behind a port with an LLDP neighbour: that neighbour's own report is
      // where the host belongs — or, if it is unmanaged, it is listed below.
      if (lldpPorts.has(`${Number(r.deviceId)}|${r.ifName}`)) continue;
      if (knownMacs.has(r.mac)) continue;
      if (!perDevice.has(r.deviceId)) perDevice.set(r.deviceId, new Map());
      const ports = perDevice.get(r.deviceId);
      ports.set(r.ifName, (ports.get(r.ifName) || 0) + 1);
    }
    const byId = new Map(devices.map((d) => [Number(d.id), d]));
    for (const [deviceId, ports] of perDevice) {
      const d = byId.get(Number(deviceId));
      if (!d) continue;
      const list = [...ports.entries()].map(([ifName, macs]) => ({ ifName, macs }))
        .sort((a, b) => b.macs - a.macs || String(a.ifName).localeCompare(String(b.ifName)));
      const macs = list.reduce((n, p) => n + p.macs, 0);
      const multiMacPorts = list.filter((p) => p.macs >= MULTI_MAC_PORT).length;
      add('unmonitoredHosts', multiMacPorts ? 'warn' : 'info', devSubject(d),
        { ports: list.length, macs, multiMacPorts, multiMacThreshold: MULTI_MAC_PORT, topPorts: list.slice(0, SAMPLE) },
        'reviewPorts', devLink(d));
    }
  }

  // ---- neighbours nothing monitors -----------------------------------------
  const unknownNeighbours = new Map();
  const isKnown = (chassisId, sysName) => {
    const mac = normaliseMac(chassisId);
    if (mac && knownMacs.has(mac)) return true;
    const byName = nameKey(sysName);
    if (byName && knownNames.has(byName)) return true;
    const raw = nameKey(chassisId);
    return !!raw && (knownNames.has(raw) || agentChassisRaw.has(raw));
  };
  const note = (chassisId, sysName, seen) => {
    const key = normaliseMac(chassisId) || nameKey(sysName) || nameKey(chassisId);
    if (!key) return;
    let e = unknownNeighbours.get(key);
    if (!e) {
      e = { key, chassisId: String(chassisId || ''), sysName: sysName || null, seenBy: [], seen: new Set() };
      unknownNeighbours.set(key, e);
    }
    if (!e.sysName && sysName) e.sysName = sysName;
    const who = `${seen.type}:${seen.id}`;
    if (e.seen.has(who)) return;
    e.seen.add(who);
    if (e.seenBy.length < SAMPLE) e.seenBy.push(seen);
  };
  if (runs('switchNeighbours')) {
    const byId = new Map(enabledDevices.map((d) => [Number(d.id), d]));
    for (const n of asArray(val('deviceNeighbours'))) {
      const d = n && byId.get(Number(n.deviceId));
      if (!d || !n.remoteChassisId || isKnown(n.remoteChassisId, n.remoteSysName)) continue;
      note(n.remoteChassisId, n.remoteSysName,
        { type: 'device', id: Number(d.id), label: deviceLabel(d), port: n.localIfName || null });
    }
  }
  if (runs('agentNeighbours')) {
    const byId = new Map(allAgents.map((a) => [Number(a.id), a]));
    for (const n of asArray(val('agentNeighbours'))) {
      const a = n && byId.get(Number(n.localAgentId));
      if (!a || !n.remoteChassisId || isKnown(n.remoteChassisId, null)) continue;
      note(n.remoteChassisId, null,
        { type: 'agent', id: Number(a.id), label: agentLabel(a), port: n.localPort || null });
    }
  }
  for (const e of unknownNeighbours.values()) {
    // Seen from two or more monitored things, it sits BETWEEN them: every
    // path through it is one this product cannot see into.
    add('unmanagedNeighbour', e.seen.size >= 2 ? 'warn' : 'info',
      { id: e.key, label: e.sysName || e.chassisId },
      { chassisId: e.chassisId, sysName: e.sysName, seenByCount: e.seen.size, seenBy: e.seenBy },
      'addNeighbour', { view: 'settings', tab: 'snmp' });
  }

  // ---- subnets seen but not covered ----------------------------------------
  if (runs('subnets')) {
    const covered = new Set();
    for (const a of agents) for (const ip of agentIps(a)) { const p = prefix24(ip); if (p) covered.add(p); }
    for (const r of asArray(val('arpSubnets'))) {
      const p = r && prefix24(`${r.prefix}.0`);
      if (!p || covered.has(p) || reservedPrefix(p)) continue;
      add('subnetUncovered', 'info', { id: `${p}.0/24`, label: `${p}.0/24` },
        { ips: Number(r.ips) || 0, learnedBy: Number(r.agents) || 0, lastSeen: iso(r.lastSeen) },
        'coverSubnet', { view: 'discovery' });
    }
    const check = checks.find((c) => c.key === 'subnets');
    // An agent too old to report its own addresses cannot cover a subnet on
    // paper even if it sits in one — said, so the list is read accordingly.
    check.agentsWithoutIps = agents.filter((a) => !agentIps(a).length).length;
    if (check.agentsWithoutIps && check.status === 'ok') check.status = 'partial';
  }

  // ---- discovery candidates nobody has looked at ---------------------------
  if (runs('discovery')) {
    const d = val('discovered') || {};
    const rows = asArray(d.rows);
    for (const c of rows) {
      if (!c || c.id == null) continue;
      add('discoveredPending', 'info', { id: Number(c.id), label: c.hostname || c.ip },
        { ip: c.ip, hostname: c.hostname || null, openPorts: asArray(c.openPorts).join(', '), lastSeen: iso(c.lastSeen) },
        'reviewCandidate', { view: 'discovery' });
    }
    const total = Number(d.total);
    if (Number.isInteger(total) && total > rows.length) extraTotals.discoveredPending = total - rows.length;
  }

  // ---- order, count, cap ---------------------------------------------------
  const kindOrder = Object.keys(KINDS);
  gaps.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)
    || (a.severity === b.severity ? 0 : (a.severity === 'warn' ? -1 : 1))
    || String(a.subject.label).localeCompare(String(b.subject.label)));

  const byKind = {};
  const byScope = { site: 0, agent: 0, device: 0, subnet: 0 };
  const bySeverity = { warn: 0, info: 0 };
  for (const g of gaps) {
    byKind[g.kind] = (byKind[g.kind] || 0) + 1;
    byScope[g.scope] += 1;
    bySeverity[g.severity] += 1;
  }
  for (const [kind, n] of Object.entries(extraTotals)) {
    byKind[kind] = (byKind[kind] || 0) + n;
    byScope[KINDS[kind]] += n;
    bySeverity.info += n;
  }

  const listed = [];
  const truncated = {};
  const seenPerKind = {};
  for (const g of gaps) {
    seenPerKind[g.kind] = (seenPerKind[g.kind] || 0) + 1;
    if (seenPerKind[g.kind] <= limit) listed.push(g);
  }
  for (const [kind, n] of Object.entries(byKind)) {
    const shown = listed.filter((g) => g.kind === kind).length;
    if (n > shown) truncated[kind] = n - shown;
  }

  return {
    summary: {
      total: bySeverity.warn + bySeverity.info,
      warn: bySeverity.warn,
      info: bySeverity.info,
      byScope,
      byKind,
    },
    gaps: listed,
    truncated,
    limit,
    checks: checks.map((c) => {
      const out = { key: c.key, status: c.status, kinds: c.kinds, missing: c.missing, capped: c.capped };
      if (c.agentsWithoutIps != null) out.agentsWithoutIps = c.agentsWithoutIps;
      return out;
    }),
    windows: { flowHours: FLOW_WINDOW_HOURS, staleReportMinutes: STALE_REPORT_MINUTES },
  };
}

module.exports = {
  buildCoverageReport,
  CHECKS,
  KINDS,
  STALE_REPORT_MINUTES,
  FLOW_WINDOW_HOURS,
  MULTI_MAC_PORT,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  prefix24,
};
