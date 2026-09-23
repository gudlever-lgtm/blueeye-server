'use strict';

const crypto = require('crypto');
const { vendorForMac, isLocallyAdministered } = require('../identity/oui');

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
  discoveredDevicesRepo = null,
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

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
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
    const seen = new Set();
    const fresh = [];
    for (const e of list) {
      if (known.has(e.mac) || seen.has(e.mac)) continue;
      seen.add(e.mac);
      fresh.push(e);
    }
    return fresh.length ? { agentId, at, oldest, who, fresh } : null;
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
          + `This MAC has never been seen before ${scopeText}; the agent's ARP baseline goes back to `
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
    return raise(agentId == null ? 'discovery' : `discovery:${agentId}`, [item], {
      hostId: agentId == null ? 'discovery' : agentId, at, where: `found by ${agentLabel}`,
      overflowText: 'A burst like this usually means the discovery scope was widened; review the Discovery page.',
    });
  }

  return { checkArp, raiseArp, checkDiscovery, raiseDiscovery, METRIC };
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
  createNewDeviceDetector, withArpDetection, withDiscoveryDetection, loadNewDeviceConfig, METRIC,
};
