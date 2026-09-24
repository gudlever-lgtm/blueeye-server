'use strict';

const crypto = require('crypto');
const { vendorForMac, isLocallyAdministered } = require('../identity/oui');
const { scopeKey } = require('../repositories/knownDevicesRepository');

// "A device we have never seen before just appeared" — as a finding.
//
// Until this existed a stranger's laptop (or a PLC nobody ordered) on a flat OT
// network became one more row on the ARP table and the discovery list, and
// nothing said so. This watches the two places a new address first shows up:
//
//   ARP        an agent's neighbour table (capabilities report + evidence
//              snapshots) → arp_entries. Identity is the MAC.
//   discovery  an active-discovery sweep (server-side, or an agent's scan) →
//              discovered_devices. Identity is the IP, because a sweep sees no
//              MAC; an IP some agent's ARP table already knows is not new.
//
// NEW means: this MAC has never been in the ARP table of ANY agent at this site
// (or of this agent, when it has no site) — a DHCP renewal that gives a known
// MAC a new IP is not a new device. The check runs BEFORE the upsert that would
// make the MAC known, which is why this module wraps the repositories rather
// than reading after them (see withArpDetection / withDiscoveryDetection).
//
// THE FLOOD GUARD. An agent's first report lists every neighbour it has, and
// every one of them is "never seen before". So nothing is flagged until the
// agent has a BASELINE: its oldest ARP row is at least `baselineHours` old
// (default 24). The same rule holds for discovery: the first sweep of a scope
// is a baseline, not fifty alarms. A second guard caps findings per agent (or
// per discovery) at `maxPerHour`; anything above the cap is reported as ONE
// summary finding rather than silently dropped.
//
// The finding is an ordinary finding — the same store, dashboard publish,
// event case, alert dispatch and ITSM emit as every other producer — so it
// pages the way the operator already configured paging. Metric `device.new`,
// kind THRESHOLD (a fixed rule, not a statistical deviation), with an
// explanation naming the IP, MAC, vendor hint, agent and site.
//
// TWO WAYS ONE DEVICE USED TO BE REPORTED TWICE, OR AGAIN:
//
//   Discovery first, ARP second. A sweep finds 10.20.0.50 (no MAC — a sweep
//   cannot see one) and raises it; an hour later an agent ARPs for it and the
//   MAC is "new" too. The same device, two findings. The ARP path now asks
//   whether discovery REPORTED that address inside the baseline window and, if
//   so, stays quiet: the device was announced once, and the MAC is recorded
//   in arp_entries and the known-device memory all the same.
//
//   Back after a month. arp_entries forgets a MAC 30 days after it was last
//   seen (RETENTION_ARP_DAYS), so a laptop back from holiday was "never seen
//   before". The known-device memory (known_devices, migration 131) keeps
//   every MAC a site has had for 400 days (RETENTION_KNOWN_DEVICE_DAYS); it is
//   consulted before anything is called new and touched after every ARP report.
//
// Best-effort throughout: nothing here can fail or slow the ingest it watches.

const METRIC = 'device.new';
const SEVERITIES = new Set(['INFO', 'WARN', 'CRIT']);
const HOUR_MS = 60 * 60 * 1000;

function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? d : n; }

// Env-driven, like the retention config. ON by default: an unknown device on
// the network is exactly what an operator expects to hear about.
function loadNewDeviceConfig(env = process.env) {
  const sev = String(env.NEW_DEVICE_SEVERITY || 'WARN').toUpperCase();
  return {
    enabled: env.NEW_DEVICE_ALERTS_ENABLED !== 'false',
    baselineHours: Math.max(0, toInt(env.NEW_DEVICE_BASELINE_HOURS, 24)),
    maxPerHour: Math.max(1, toInt(env.NEW_DEVICE_MAX_PER_HOUR, 20)),
    severity: SEVERITIES.has(sev) ? sev : 'WARN',
  };
}

function hoursBetween(a, b) { return Math.floor((b.getTime() - a.getTime()) / HOUR_MS); }

function createNewDeviceDetector({
  arpEntriesRepo = null,
  // device_arp_entries (migration 125): a polled router's / L3 switch's IP-MIB
  // ARP table. Optional: without it the router path is off and the agent path
  // works exactly as it did. See checkDeviceArp.
  deviceArpRepo = null,
  discoveredDevicesRepo = null,
  // The long-lived memory (migration 131). Optional: without it the detector
  // behaves as before, knowing only what arp_entries still holds.
  knownDevicesRepo = null,
  agentsRepo = null,
  locationsRepo = null,
  findingStore = null,
  eventCaseService = null,
  publishFinding = () => {},
  // Getters so the server can build this before the dispatcher exists.
  getDispatcher = () => null,
  alertingEnabled = () => false,
  integrationTrigger = null,
  licensed = () => true,
  config = loadNewDeviceConfig({}),
  lookupVendor = vendorForMac,
  now = () => new Date(),
  logger = null,
} = {}) {
  // scope -> timestamps of findings raised in the last hour (in memory: a
  // restart resetting a rate cap is the right failure mode).
  const raised = new Map();
  // scope -> ms of the last overflow summary, so one flood is one summary.
  const summarised = new Map();
  // ip -> ms discovery raised it at. The fast path of "did discovery already
  // report this address"; the durable path reads discovered_devices, so a
  // restart does not bring the duplicate back.
  const discoveryRaised = new Map();

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
  const info = (msg) => { if (logger && typeof logger.info === 'function') logger.info(msg); };
  const isOn = () => {
    try { return !!(config && config.enabled) && licensed(); } catch { return false; }
  };

  function budgetFor(scope, at) {
    const list = (raised.get(scope) || []).filter((t) => at.getTime() - t < HOUR_MS);
    raised.set(scope, list);
    return Math.max(0, config.maxPerHour - list.length);
  }

  async function describeAgent(agentId) {
    if (agentId == null || !agentsRepo || typeof agentsRepo.findById !== 'function') return { agentName: null, siteId: null, siteName: null };
    let agent = null;
    try { agent = await agentsRepo.findById(agentId); } catch { agent = null; }
    const siteId = agent && agent.location_id != null ? Number(agent.location_id) : null;
    let siteName = null;
    if (siteId != null && locationsRepo && typeof locationsRepo.findById === 'function') {
      try { const loc = await locationsRepo.findById(siteId); siteName = loc ? loc.name : null; } catch { siteName = null; }
    }
    return { agentName: agent ? (agent.display_name || agent.hostname || null) : null, siteId, siteName };
  }

  // Saves + fans out one finding the way the other producers do. Returns the
  // stored finding, or null when it could not be saved.
  async function emit(finding) {
    if (!findingStore) return null;
    let stored;
    try {
      const saved = await findingStore.save(finding);
      stored = saved && typeof saved === 'object' ? saved : finding;
    } catch (err) {
      warn(`new-device: could not save finding (${err.message})`);
      return null;
    }
    try { publishFinding(stored.hostId, { type: 'finding', payload: stored }); } catch { /* best effort */ }
    if (eventCaseService) {
      try { await eventCaseService.assignFinding(stored); } catch (err) { warn(`new-device: event assignment failed (${err.message})`); }
    }
    let alertOn = false;
    try { alertOn = typeof alertingEnabled === 'function' ? !!alertingEnabled() : !!alertingEnabled; } catch { alertOn = false; }
    const dispatcher = typeof getDispatcher === 'function' ? getDispatcher() : null;
    if (alertOn && dispatcher && typeof dispatcher.dispatch === 'function') {
      try { await dispatcher.dispatch(stored, null); } catch (err) { warn(`new-device: dispatch failed (${err.message})`); }
    }
    if (integrationTrigger && typeof integrationTrigger.emitFinding === 'function') {
      try { integrationTrigger.emitFinding(stored).catch(() => {}); } catch { /* never affects ingestion */ }
    }
    return stored;
  }

  function buildFinding({ hostId, at, explanation, labels }) {
    return {
      id: crypto.randomUUID(),
      hostId: String(hostId),
      deviceId: null,
      interfaceId: null,
      metric: METRIC,
      severity: config.severity,
      kind: 'THRESHOLD',
      observed: 1,
      baseline: null,
      deviation: null,
      window: [at, at],
      explanation,
      // The MetricSample shape the store expects. `target` is the address, so
      // anything keying findings by (metric, target) treats two new devices as
      // two findings and one device as one.
      evidence: [{ hostId: String(hostId), metric: METRIC, value: 1, ts: at, target: labels.ip, labels }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  // Raises findings for `items` (already known to be new) within the scope's
  // hourly budget, plus one summary for whatever the budget could not cover.
  async function raise(scope, items, { hostId, at, where, overflowText }) {
    const budget = budgetFor(scope, at);
    const stamps = raised.get(scope);
    const out = [];
    for (const item of items.slice(0, budget)) {
      const stored = await emit(buildFinding({ hostId, at, explanation: item.explanation, labels: item.labels }));
      if (stored) { out.push(stored); stamps.push(at.getTime()); }
    }
    const over = items.slice(budget);
    if (over.length) {
      const last = summarised.get(scope) || 0;
      if (at.getTime() - last >= HOUR_MS) {
        summarised.set(scope, at.getTime());
        const ips = over.slice(0, 10).map((i) => i.labels.ip);
        const explanation = `${over.length} more new device(s) ${where} were not raised individually: `
          + `the limit is ${config.maxPerHour} new-device findings per hour (NEW_DEVICE_MAX_PER_HOUR). `
          + `First addresses: ${ips.join(', ')}${over.length > ips.length ? ', …' : ''}. ${overflowText}`;
        const stored = await emit(buildFinding({
          hostId, at, explanation,
          labels: { ip: ips[0], summary: true, count: over.length, ips },
        }));
        if (stored) out.push(stored);
      } else {
        warn(`new-device: ${over.length} new device(s) ${where} over the hourly cap, summary already raised`);
      }
    }
    return out;
  }

  // ---- ARP ------------------------------------------------------------------

  // Called BEFORE the upsert. Returns what is new (or null when the detector is
  // off, the agent has no baseline yet, or nothing is new).
  async function checkArp(agentId, entries) {
    if (!isOn() || !arpEntriesRepo || typeof arpEntriesRepo.knownMacs !== 'function') return null;
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mac && e.ip);
    if (!list.length) return null;
    const at = now();

    // The flood guard: no baseline, no verdict.
    let oldest = null;
    try { oldest = await arpEntriesRepo.oldestFirstSeen(agentId); } catch { oldest = null; }
    if (!oldest || at.getTime() - oldest.getTime() < config.baselineHours * HOUR_MS) return null;

    const who = await describeAgent(agentId);
    let known;
    try {
      known = await arpEntriesRepo.knownMacs({ macs: list.map((e) => e.mac), agentId, locationId: who.siteId });
    } catch (err) {
      warn(`new-device: could not read known MACs for agent ${agentId} (${err.message})`);
      return null;
    }
    // A MAC a polled router at the same site already has is not new either.
    // Only with a site: without one there is no scope the two sources share.
    if (who.siteId != null && deviceArpRepo && typeof deviceArpRepo.knownMacs === 'function') {
      try {
        const viaRouters = await deviceArpRepo.knownMacs({ macs: list.map((e) => e.mac), locationId: who.siteId });
        for (const m of viaRouters) known.add(m);
      } catch (err) {
        warn(`new-device: could not read router-known MACs at site ${who.siteId} (${err.message})`);
      }
    }
    const seen = new Set();
    const candidates = [];
    for (const e of list) {
      if (known.has(e.mac) || seen.has(e.mac)) continue;
      seen.add(e.mac);
      candidates.push(e);
    }
    if (!candidates.length) return null;

    // Back after the ARP window: the long memory still knows it.
    const remembered = await rememberedMacs(agentId, who, candidates);
    const fresh = [];
    for (const e of candidates) {
      if (remembered.has(e.mac)) continue;
      // Discovery already announced this address: one device, one finding.
      // eslint-disable-next-line no-await-in-loop
      if (await reportedByDiscovery(e.ip, who, at)) {
        info(`new-device: ${e.ip} (MAC ${e.mac}) was already reported by discovery; not raised again from ARP`);
        continue;
      }
      fresh.push(e);
    }
    return fresh.length ? { agentId, at, oldest, who, fresh } : null;
  }

  // Which of `entries`' MACs the known-device memory holds for this scope. A
  // memory that cannot be read is treated as empty — the detector then knows
  // what it knew before the memory existed, and the hourly cap still holds.
  async function rememberedMacs(agentId, who, entries) {
    if (!knownDevicesRepo || typeof knownDevicesRepo.knownMacs !== 'function') return new Set();
    const scope = scopeKey({ siteId: who.siteId, agentId });
    if (!scope) return new Set();
    try {
      return await knownDevicesRepo.knownMacs({ scope, macs: entries.map((e) => e.mac) });
    } catch (err) {
      warn(`new-device: could not read the known-device memory for ${scope} (${err.message})`);
      return new Set();
    }
  }

  // Did discovery raise a device.new finding for `ip` inside the baseline
  // window? In memory when this process raised it; otherwise from the
  // candidate row: first seen inside the window AND after discovery's own
  // baseline (a row from the first sweep was a baseline, never a finding),
  // and — when the finder has a site — at the same site, because the same
  // private address legitimately exists at more than one.
  async function reportedByDiscovery(ip, who, at) {
    const windowMs = Math.max(1, config.baselineHours) * HOUR_MS;
    const raisedAt = discoveryRaised.get(ip);
    if (raisedAt != null && at.getTime() - raisedAt < windowMs) return true;
    if (!discoveredDevicesRepo || typeof discoveredDevicesRepo.findByIp !== 'function') return false;
    let row = null;
    try { row = await discoveredDevicesRepo.findByIp(ip); } catch { return false; }
    const first = row && row.firstSeen ? Date.parse(row.firstSeen) : NaN;
    if (!Number.isFinite(first) || at.getTime() - first >= windowMs) return false;
    let sweepBaseline = null;
    try { sweepBaseline = await discoveredDevicesRepo.oldestFirstSeen(); } catch { sweepBaseline = null; }
    if (!sweepBaseline || first - sweepBaseline.getTime() < config.baselineHours * HOUR_MS) return false;
    if (row.foundByAgentId != null && who.siteId != null) {
      const finder = await describeAgent(row.foundByAgentId);
      if (finder.siteId != null && finder.siteId !== who.siteId) return false;
    }
    return true;
  }

  // Records every MAC of a report in the known-device memory — all of them,
  // not only the new ones, so last_seen tracks the device and the 400-day
  // retention counts from the last time it was actually there. Called after
  // the ARP upsert (withArpDetection). Returns rows touched.
  async function rememberArp(agentId, entries, at = null) {
    if (!knownDevicesRepo || typeof knownDevicesRepo.touchMany !== 'function') return 0;
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mac);
    if (!list.length) return 0;
    const who = await describeAgent(agentId);
    const scope = scopeKey({ siteId: who.siteId, agentId });
    if (!scope) return 0;
    return knownDevicesRepo.touchMany(scope, list, at instanceof Date ? at : now());
  }

  // Called AFTER the upsert succeeded, with what checkArp returned.
  async function raiseArp(pending) {
    if (!pending) return [];
    const { agentId, at, oldest, who, fresh } = pending;
    const agentLabel = who.agentName ? `${who.agentName} (agent ${agentId})` : `agent ${agentId}`;
    const siteLabel = who.siteName || (who.siteId != null ? `site ${who.siteId}` : null);
    const scopeText = siteLabel ? `by any agent at site ${siteLabel}` : `by ${agentLabel}`;
    const items = fresh.map((e) => {
      const vendor = lookupVendor(e.mac);
      const vendorText = vendor
        ? `vendor ${vendor} (from the MAC prefix)`
        : (isLocallyAdministered(e.mac) ? 'vendor unknown — a locally administered (randomised or virtual) MAC' : 'vendor unknown');
      return {
        explanation: `New device ${e.ip} (MAC ${e.mac}, ${vendorText}) appeared in the ARP table of ${agentLabel}`
          + `${siteLabel ? ` at site ${siteLabel}` : ''}${e.interface ? ` on ${e.interface}` : ''}. `
          + `This MAC has never been seen before ${scopeText}`
          + `${knownDevicesRepo ? ' (nor in the known-device memory, which remembers a MAC long after the ARP table has forgotten it)' : ''}`
          + '; the agent\'s ARP baseline goes back to '
          + `${oldest.toISOString()} (${hoursBetween(oldest, at)} h), so this is not a first snapshot. `
          + 'Confirm the device is expected — an unknown host on a control network is worth a look.',
        labels: {
          ip: e.ip, mac: e.mac, vendor: vendor || null, interface: e.interface || null, source: 'arp',
          agentId: Number(agentId), agentName: who.agentName, siteId: who.siteId, siteName: who.siteName,
          baselineSince: oldest.toISOString(),
        },
      };
    });
    return raise(`arp:${agentId}`, items, {
      hostId: agentId, at, where: `in the ARP table of ${agentLabel}`,
      overflowText: 'A burst like this usually means a new segment became visible to the agent; check it on the ARP/Discovery pages.',
    });
  }

  // ---- router ARP (device_arp_entries) --------------------------------------
  //
  // In a flat OT network the router's IP-MIB table sees every device on every
  // segment it routes, including the ones no agent sits next to. Identity is
  // the MAC, the scope is the DEVICE'S site (snmp_devices.location_id) — or the
  // device alone when it has none — and the baseline guard is the same one the
  // agent path uses, on the device's own oldest row: a router added to the
  // inventory today is a baseline, not a thousand alarms. The two ARP sources
  // vouch for each other at a site, and so does the known-device memory.

  async function siteNameOf(siteId) {
    if (siteId == null || !locationsRepo || typeof locationsRepo.findById !== 'function') return null;
    try { const loc = await locationsRepo.findById(siteId); return loc ? loc.name : null; } catch { return null; }
  }

  // Called BEFORE the upsert, with the device row and the polling agent.
  async function checkDeviceArp(device, entries, { agentId = null } = {}) {
    if (!isOn() || !deviceArpRepo || typeof deviceArpRepo.knownMacs !== 'function') return null;
    if (!device || device.id == null) return null;
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mac && e.ip);
    if (!list.length) return null;
    const at = now();

    let oldest = null;
    try { oldest = await deviceArpRepo.oldestFirstSeen(device.id); } catch { oldest = null; }
    if (!oldest || at.getTime() - oldest.getTime() < config.baselineHours * HOUR_MS) return null;

    const siteId = device.locationId != null ? Number(device.locationId) : null;
    const macs = list.map((e) => e.mac);
    let known;
    try {
      known = await deviceArpRepo.knownMacs({ macs, deviceId: device.id, locationId: siteId });
    } catch (err) {
      warn(`new-device: could not read known MACs for device ${device.id} (${err.message})`);
      return null;
    }
    if (siteId != null && arpEntriesRepo && typeof arpEntriesRepo.knownMacs === 'function') {
      try {
        for (const m of await arpEntriesRepo.knownMacs({ macs, locationId: siteId })) known.add(m);
      } catch (err) {
        warn(`new-device: could not read agent-known MACs at site ${siteId} (${err.message})`);
      }
    }
    const seen = new Set();
    const candidates = [];
    for (const e of list) {
      if (known.has(e.mac) || seen.has(e.mac)) continue;
      seen.add(e.mac);
      candidates.push(e);
    }
    if (!candidates.length) return null;
    // The known-device memory, per site (a device without one has no scope
    // the memory keys on, and is judged on its own table alone).
    const remembered = siteId != null ? await rememberedMacs(null, { siteId }, candidates) : new Set();
    const fresh = candidates.filter((e) => !remembered.has(e.mac));
    if (!fresh.length) return null;
    return { device, agentId: agentId ?? device.agentId ?? null, siteId, at, oldest, fresh };
  }

  // Called AFTER the upsert succeeded, with what checkDeviceArp returned.
  async function raiseDeviceArp(pending) {
    if (!pending) return [];
    const { device, agentId, siteId, at, oldest, fresh } = pending;
    const deviceLabel = device.displayName ? `${device.displayName} (${device.host})` : String(device.host || `device ${device.id}`);
    const site = await siteNameOf(siteId);
    const siteLabel = site || (siteId != null ? `site ${siteId}` : null);
    // Where in the site, when the router says so: its own sysLocation.
    const room = device.sysLocation ? ` (${device.sysLocation})` : '';
    const scopeText = siteLabel ? `by any polled device or agent at site ${siteLabel}` : `by ${deviceLabel}`;
    const items = fresh.map((e) => {
      const vendor = lookupVendor(e.mac);
      const vendorText = vendor
        ? `vendor ${vendor} (from the MAC prefix)`
        : (isLocallyAdministered(e.mac) ? 'vendor unknown — a locally administered (randomised or virtual) MAC' : 'vendor unknown');
      return {
        explanation: `New device ${e.ip} (MAC ${e.mac}, ${vendorText}) appeared in the ARP table of ${deviceLabel}`
          + `${siteLabel ? ` at site ${siteLabel}` : ''}${room}${e.ifName ? ` on ${e.ifName}` : ''}. `
          + `This MAC has never been seen before ${scopeText}; the device's ARP baseline goes back to `
          + `${oldest.toISOString()} (${hoursBetween(oldest, at)} h), so this is not a first snapshot. `
          + 'Confirm the device is expected — an unknown host on a control network is worth a look.',
        labels: {
          ip: e.ip, mac: e.mac, vendor: vendor || null, interface: e.ifName || null, source: 'device-arp',
          deviceId: Number(device.id), deviceName: device.displayName || device.host || null,
          sysLocation: device.sysLocation || null,
          agentId: agentId == null ? null : Number(agentId), siteId, siteName: site,
          baselineSince: oldest.toISOString(),
        },
      };
    });
    // hostId is the POLLING AGENT, like every other switch finding, so a
    // per-agent read finds it; the device is named in the labels.
    return raise(`devarp:${device.id}`, items, {
      hostId: agentId == null ? `snmp-device:${device.id}` : agentId,
      at,
      where: `in the ARP table of ${deviceLabel}`,
      overflowText: 'A burst like this usually means a new segment is routed through this device; check it on the device page.',
    });
  }

  // The known-device memory learns every router sighting too, per site.
  async function rememberDeviceArp(device, entries, at = null) {
    if (!knownDevicesRepo || typeof knownDevicesRepo.touchMany !== 'function') return 0;
    const siteId = device && device.locationId != null ? Number(device.locationId) : null;
    const scope = scopeKey({ siteId });
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mac);
    if (!scope || !list.length) return 0;
    return knownDevicesRepo.touchMany(scope, list, at instanceof Date ? at : now());
  }

  // ---- discovery ------------------------------------------------------------

  async function checkDiscovery(candidate) {
    if (!isOn() || !discoveredDevicesRepo || typeof discoveredDevicesRepo.findByIp !== 'function') return null;
    const ip = candidate && typeof candidate.ip === 'string' ? candidate.ip.trim() : '';
    if (!ip) return null;
    const at = now();
    let oldest = null;
    try { oldest = await discoveredDevicesRepo.oldestFirstSeen(); } catch { oldest = null; }
    if (!oldest || at.getTime() - oldest.getTime() < config.baselineHours * HOUR_MS) return null;
    try {
      if (await discoveredDevicesRepo.findByIp(ip)) return null; // a refresh, not a new device
    } catch { return null; }
    // An address some agent's neighbour table already has is a device we know
    // by MAC; the ARP path is the one that says whether IT is new.
    if (arpEntriesRepo && typeof arpEntriesRepo.findByIp === 'function') {
      try { if ((await arpEntriesRepo.findByIp({ ip, limit: 1 })).length) return null; } catch { /* treat as unknown */ }
    }
    const agentId = Number(candidate.foundByAgentId) > 0 ? Number(candidate.foundByAgentId) : null;
    return { at, oldest, ip, candidate, agentId };
  }

  async function raiseDiscovery(pending) {
    if (!pending) return [];
    const { at, oldest, ip, candidate, agentId } = pending;
    const who = await describeAgent(agentId);
    const agentLabel = agentId == null ? 'the server\'s discovery sweep'
      : (who.agentName ? `${who.agentName} (agent ${agentId})` : `agent ${agentId}`);
    const siteLabel = who.siteName || (who.siteId != null ? `site ${who.siteId}` : null);
    const ports = Array.isArray(candidate.openPorts) && candidate.openPorts.length ? ` open ports ${candidate.openPorts.join(', ')};` : '';
    const host = candidate.hostname ? ` hostname ${candidate.hostname};` : '';
    const item = {
      explanation: `New device ${ip} answered active discovery for the first time (found by ${agentLabel}`
        + `${siteLabel ? ` at site ${siteLabel}` : ''};${host}${ports} MAC not visible to a sweep). `
        + `No discovery sweep and no agent's ARP table has seen this address before; discovery has been `
        + `running since ${oldest.toISOString()} (${hoursBetween(oldest, at)} h), so this is not a first sweep. `
        + 'Confirm the device is expected.',
      labels: {
        ip, mac: null, vendor: null, hostname: candidate.hostname || null,
        openPorts: Array.isArray(candidate.openPorts) ? candidate.openPorts : [], source: 'discovery',
        agentId, agentName: who.agentName, siteId: who.siteId, siteName: who.siteName,
        baselineSince: oldest.toISOString(),
      },
    };
    const out = await raise(agentId == null ? 'discovery' : `discovery:${agentId}`, [item], {
      hostId: agentId == null ? 'discovery' : agentId, at, where: `found by ${agentLabel}`,
      overflowText: 'A burst like this usually means the discovery scope was widened; review the Discovery page.',
    });
    // Remembered so the ARP path does not report the same device again when
    // an agent learns its MAC. Pruned to the window as it goes.
    if (out.length) {
      const windowMs = Math.max(1, config.baselineHours) * HOUR_MS;
      for (const [k, t] of discoveryRaised) if (at.getTime() - t >= windowMs) discoveryRaised.delete(k);
      discoveryRaised.set(ip, at.getTime());
    }
    return out;
  }

  return {
    checkArp, raiseArp, rememberArp, checkDeviceArp, raiseDeviceArp, rememberDeviceArp,
    checkDiscovery, raiseDiscovery, METRIC,
  };
}

// Wraps an arp_entries repository so every upsertMany (capabilities report and
// evidence snapshot alike) is watched: check BEFORE the write, raise AFTER it.
// The raise is not awaited, so a slow finding store never slows the report; a
// failed check never blocks the write it guards.
function withArpDetection(repo, detector, { logger = null } = {}) {
  if (!repo || !detector) return repo;
  return {
    ...repo,
    async upsertMany(agentId, entries, opts) {
      let pending = null;
      try { pending = await detector.checkArp(agentId, entries); } catch (err) {
        if (logger) logger.warn(`new-device: ARP check failed for agent ${agentId} (${err.message})`);
      }
      const res = await repo.upsertMany(agentId, entries, opts);
      if (pending) {
        Promise.resolve().then(() => detector.raiseArp(pending)).catch((err) => {
          if (logger) logger.warn(`new-device: raise failed for agent ${agentId} (${err.message})`);
        });
      }
      // The long memory learns every sighting, new or not (never awaited).
      if (typeof detector.rememberArp === 'function') {
        Promise.resolve().then(() => detector.rememberArp(agentId, entries, opts && opts.at)).catch((err) => {
          if (logger) logger.warn(`new-device: could not update the known-device memory for agent ${agentId} (${err.message})`);
        });
      }
      return res;
    },
  };
}

// The device_arp_entries twin of withArpDetection, around the SNMP topology
// ingest's upsert. The ingest passes the device row and the polling agent in
// the options: the detector needs the device's site, and the upsert ignores
// both.
function withDeviceArpDetection(repo, detector, { logger = null } = {}) {
  if (!repo || !detector || typeof detector.checkDeviceArp !== 'function') return repo;
  return {
    ...repo,
    async upsertMany(deviceId, entries, opts = {}) {
      const device = opts && opts.device ? opts.device : { id: deviceId };
      let pending = null;
      try { pending = await detector.checkDeviceArp(device, entries, { agentId: opts ? opts.agentId : null }); } catch (err) {
        if (logger) logger.warn(`new-device: router ARP check failed for device ${deviceId} (${err.message})`);
      }
      const res = await repo.upsertMany(deviceId, entries, opts);
      if (pending) {
        Promise.resolve().then(() => detector.raiseDeviceArp(pending)).catch((err) => {
          if (logger) logger.warn(`new-device: raise failed for device ${deviceId} (${err.message})`);
        });
      }
      if (typeof detector.rememberDeviceArp === 'function') {
        Promise.resolve().then(() => detector.rememberDeviceArp(device, entries, opts && opts.at)).catch((err) => {
          if (logger) logger.warn(`new-device: could not update the known-device memory for device ${deviceId} (${err.message})`);
        });
      }
      return res;
    },
  };
}

// The discovered_devices twin of the above, around upsertCandidate.
function withDiscoveryDetection(repo, detector, { logger = null } = {}) {
  if (!repo || !detector) return repo;
  return {
    ...repo,
    async upsertCandidate(candidate) {
      let pending = null;
      try { pending = await detector.checkDiscovery(candidate || {}); } catch (err) {
        if (logger) logger.warn(`new-device: discovery check failed (${err.message})`);
      }
      const res = await repo.upsertCandidate(candidate);
      if (pending) {
        Promise.resolve().then(() => detector.raiseDiscovery(pending)).catch((err) => {
          if (logger) logger.warn(`new-device: raise failed (${err.message})`);
        });
      }
      return res;
    },
  };
}

module.exports = {
  createNewDeviceDetector, withArpDetection, withDeviceArpDetection, withDiscoveryDetection, loadNewDeviceConfig, METRIC,
};
