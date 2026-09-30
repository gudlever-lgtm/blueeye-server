'use strict';

const os = require('os');
const crypto = require('crypto');
const { parseCidr, inScope } = require('../discovery/cidr');

// "One address just touched four hundred ports on nine machines" — as a
// finding.
//
// THE GAP THIS CLOSES. The SQL for this has existed for a long time. The flow
// explorer's `scans` array (flowsRepository.exploreFlows) counts distinct
// destination ports and hosts per source and labels anything over fifty a
// port-scan or a fan-out. It is a good signal and it was completely passive: a
// technician who already suspected something, already had the right agent
// open, and already picked the right time window, got told. Nobody else ever
// did. A scan at 03:00 was a query nobody ran.
//
// This turns the same query into a leader-only job that runs on its own, over
// the whole fleet, and raises an ordinary finding — stored, grouped, alerted,
// carried to ITSM — for anything that crosses the threshold.
//
// WHAT IT SAYS, AND WHAT IT DOES NOT. `net.scan` means: this source address
// touched this many distinct ports / hosts in this window, which is more than
// the configured threshold. It is not a judgement about intent. A vulnerability
// scanner on its Tuesday run, a backup agent walking the LAN, an asset
// inventory tool and an attacker enumerating a subnet all produce the same
// shape, which is why the explanation states the counts and the window and
// names the ignore list instead of claiming an attack.
//
// THE PRODUCT'S OWN SCANNER IS THE FIRST FALSE POSITIVE. BlueEyes ships an
// active-discovery sweep (src/discovery/scanner.js) that probes every address
// in an admin-configured scope on a schedule. It is, by construction, the
// loudest port-scan on the network, and a detector that paged on it would be
// uninstalled the same week. So the addresses this server sweeps FROM — its own
// host addresses, read from the interface list at run time — are ignored
// whenever discovery is enabled, and SCAN_IGNORE_SOURCES takes the addresses
// and CIDRs of every other scanner an operator knowingly runs.
//
// THRESHOLDS ARE CONFIGURABLE, AND THEY HAVE TO BE. Fifty ports is a sensible
// line on an office LAN and a silly one in front of a load balancer doing
// health checks on a port range. The explorer used to hard-code it in the
// repository; now both it and this read the same env-driven config, so tuning
// it moves the alert and the on-screen list together.

const MINUTE_MS = 60 * 1000;

function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// The defaults the flow explorer has always used, now named in one place.
const DEFAULT_PORT_THRESHOLD = 50;
const DEFAULT_HOST_THRESHOLD = 50;

function loadScanConfig(env = process.env) {
  const portThreshold = Math.max(2, toInt(env.SCAN_PORT_THRESHOLD, DEFAULT_PORT_THRESHOLD));
  const hostThreshold = Math.max(2, toInt(env.SCAN_HOST_THRESHOLD, DEFAULT_HOST_THRESHOLD));
  return {
    // ON by default, like the new-device detector: something sweeping the
    // network is what an operator expects to be told about.
    enabled: env.SCAN_ALERTS_ENABLED !== 'false',
    portThreshold,
    hostThreshold,
    // The line between "worth knowing" and "wake somebody". An order of
    // magnitude above the WARN line by default, and never below it.
    critPortThreshold: Math.max(portThreshold, toInt(env.SCAN_CRIT_PORT_THRESHOLD, portThreshold * 10)),
    critHostThreshold: Math.max(hostThreshold, toInt(env.SCAN_CRIT_HOST_THRESHOLD, hostThreshold * 10)),
    // How far back each run looks. Short, because a sweep is fast and a long
    // window buries a burst in an hour of ordinary traffic.
    windowMinutes: Math.max(1, toInt(env.SCAN_WINDOW_MINUTES, 15)),
    intervalMinutes: Math.max(1, toInt(env.SCAN_JOB_INTERVAL_MINUTES, 15)),
    // Quiet time per (agent, source) after raising. A scanner that runs for an
    // hour is one finding, not four.
    cooldownMinutes: Math.max(1, toInt(env.SCAN_COOLDOWN_MINUTES, 60)),
    maxPerRun: Math.max(1, toInt(env.SCAN_MAX_PER_RUN, 20)),
    // Addresses and CIDRs that are allowed to sweep: the operator's own
    // vulnerability scanner, an asset-discovery tool, a monitoring system that
    // port-knocks. IPv4 only — src/discovery/cidr.js is an IPv4 model, and an
    // entry it cannot parse is reported rather than silently ignoring nothing.
    ignoreSources: String(env.SCAN_IGNORE_SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// Builds the "never report this source" test.
//
// `ownAddresses` is read from the host's own interfaces, so it is whatever
// this server actually sends from — including an address an operator never
// wrote down. Only consulted when discovery sweeps are enabled: with the sweep
// off, this server scanning the network IS worth hearing about.
function buildIgnoreList({ config, discoveryEnabled = false, interfaces = () => os.networkInterfaces(), onBadEntry = () => {} } = {}) {
  const exact = new Set();
  const cidrs = [];
  for (const entry of config.ignoreSources) {
    if (entry.includes('/')) {
      const parsed = parseCidr(entry);
      if (parsed) cidrs.push(parsed); else onBadEntry(entry);
      continue;
    }
    exact.add(entry);
  }
  if (discoveryEnabled) {
    let nics = {};
    try { nics = interfaces() || {}; } catch { nics = {}; }
    for (const list of Object.values(nics)) {
      for (const nic of Array.isArray(list) ? list : []) {
        if (nic && nic.address && !nic.internal) exact.add(String(nic.address));
      }
    }
  }
  return {
    exact,
    cidrs,
    ignores(ip) {
      const v = String(ip == null ? '' : ip).trim();
      if (!v) return true;
      if (exact.has(v)) return true;
      return cidrs.length ? inScope(v, cidrs) : false;
    },
  };
}

// What a candidate row IS, or null when it is under both thresholds. Pure: the
// job's whole judgement lives here, so a threshold question is answered by
// reading one function.
//
// A source over BOTH lines is a port-scan — the more specific label — and the
// explanation names both counts either way.
function classify(row, config) {
  const ports = Number(row.distinctPorts) || 0;
  const hosts = Number(row.distinctHosts) || 0;
  const overPorts = ports >= config.portThreshold;
  const overHosts = hosts >= config.hostThreshold;
  if (!overPorts && !overHosts) return null;
  const severity = (ports >= config.critPortThreshold || hosts >= config.critHostThreshold) ? 'CRIT' : 'WARN';
  return { kind: overPorts ? 'port-scan' : 'fan-out', severity, ports, hosts };
}

function createScanDetector({
  flowsRepo = null,
  // Where a raised finding goes: store -> publish -> event case -> alert ->
  // integrations (src/devices/findingSink.js).
  findingSink = null,
  licensed = () => true,
  config = loadScanConfig({}),
  // Live, so turning the discovery sweep on or off changes what is ignored
  // without a restart.
  discoveryEnabled = () => false,
  logger = null,
  now = () => new Date(),
} = {}) {
  let timer = null;
  let running = false;
  // `${agentId}|${srcIp}` -> ms of the last finding. In memory: a restart
  // resetting a cooldown means at most one repeated finding, which is the
  // right failure mode for a quiet period.
  const lastRaised = new Map();

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
  const info = (msg) => { if (logger && typeof logger.info === 'function') logger.info(msg); };

  function isOn() {
    try { return !!(config && config.enabled) && !!licensed() && !!flowsRepo && !!findingSink; } catch { return false; }
  }

  function ignoreList() {
    let on = false;
    try { on = typeof discoveryEnabled === 'function' ? !!discoveryEnabled() : !!discoveryEnabled; } catch { on = false; }
    return buildIgnoreList({
      config,
      discoveryEnabled: on,
      onBadEntry: (entry) => warn(`scan-detect: ignoring unparseable SCAN_IGNORE_SOURCES entry "${entry}"`),
    });
  }

  function buildFinding({ row, verdict, from, to }) {
    const hostId = String(row.agentId);
    const scope = row.internal ? 'internal (RFC1918) destinations' : 'destinations outside this network';
    const windowFrom = row.firstSeen instanceof Date ? row.firstSeen : from;
    const windowTo = row.lastSeen instanceof Date ? row.lastSeen : to;
    const labels = {
      srcIp: row.srcIp,
      scanKind: verdict.kind,
      distinctPorts: verdict.ports,
      distinctHosts: verdict.hosts,
      flowCount: row.flowCount,
      bytes: row.bytes,
      portThreshold: config.portThreshold,
      hostThreshold: config.hostThreshold,
      windowMinutes: config.windowMinutes,
    };
    return {
      id: crypto.randomUUID(),
      // The agent that SAW the flows. The source address is the subject, and
      // it lives in the evidence target — a scanner is not necessarily a host
      // this server monitors, so it cannot be the host key.
      hostId,
      deviceId: null,
      interfaceId: null,
      metric: 'net.scan',
      severity: verdict.severity,
      kind: 'THRESHOLD',
      observed: verdict.kind === 'port-scan' ? verdict.ports : verdict.hosts,
      baseline: null,
      deviation: null,
      window: [windowFrom, windowTo],
      explanation: `${row.srcIp} reached ${verdict.ports} distinct ports across ${verdict.hosts} distinct hosts `
        + `(${scope}) in ${config.windowMinutes} minutes — over the ${verdict.kind === 'port-scan' ? `${config.portThreshold}-port` : `${config.hostThreshold}-host`} threshold. `
        + `Counted from flow metadata only (5-tuple), so this says what was touched, not what was sent or whether anything answered. `
        + `A vulnerability scanner, an asset inventory or a backup agent walking the LAN looks the same: `
        + `if this source is one of yours, add it to SCAN_IGNORE_SOURCES. `
        + `Open the flow explorer for this agent and this address to see the ports.`,
      evidence: [{
        hostId,
        metric: 'net.scan',
        value: verdict.kind === 'port-scan' ? verdict.ports : verdict.hosts,
        ts: windowTo,
        target: row.srcIp,
        labels,
      }],
      correlatedWith: [],
      createdAt: windowTo,
      acked: false,
    };
  }

  // One pass over the previous complete window. Returns a summary, or null
  // when it did not run (off, or already running).
  async function run() {
    if (!isOn() || running) return null;
    running = true;
    try {
      const t = now();
      const to = new Date(Math.floor(t.getTime() / MINUTE_MS) * MINUTE_MS);
      const from = new Date(to.getTime() - config.windowMinutes * MINUTE_MS);
      const ignore = ignoreList();

      const candidates = await flowsRepo.scanCandidates({
        from,
        to,
        portThreshold: config.portThreshold,
        hostThreshold: config.hostThreshold,
      });

      let ignored = 0;
      let cooling = 0;
      let raised = 0;
      let over = 0;
      for (const row of Array.isArray(candidates) ? candidates : []) {
        const verdict = classify(row, config);
        if (!verdict) continue;
        if (ignore.ignores(row.srcIp)) { ignored += 1; continue; }
        const key = `${row.agentId}|${row.srcIp}`;
        const last = lastRaised.get(key) || 0;
        if (t.getTime() - last < config.cooldownMinutes * MINUTE_MS) { cooling += 1; continue; }
        if (raised >= config.maxPerRun) { over += 1; continue; }
        lastRaised.set(key, t.getTime());
        try {
          // eslint-disable-next-line no-await-in-loop
          const stored = await findingSink.emit(buildFinding({ row, verdict, from, to }));
          if (stored) raised += 1;
        } catch (err) {
          warn(`scan-detect: could not raise net.scan for ${key} (${err.message})`);
        }
      }
      // The cooldown map would otherwise keep every source this server has ever
      // seen scan. Anything outside the cooldown is already forgotten in
      // effect, so drop it.
      const stale = t.getTime() - config.cooldownMinutes * MINUTE_MS;
      for (const [key, ms] of lastRaised) if (ms < stale) lastRaised.delete(key);

      if (over) {
        warn(`scan-detect: ${over} more scan source(s) in ${from.toISOString()}–${to.toISOString()} were not raised `
          + `(limit ${config.maxPerRun} per run, SCAN_MAX_PER_RUN) — a sweep this wide is one event, not ${over + raised}`);
      }
      if (raised || ignored) {
        info(`scan-detect: ${from.toISOString()}–${to.toISOString()} raised ${raised}, ignored ${ignored}, in cooldown ${cooling}`);
      }
      return { from: from.toISOString(), to: to.toISOString(), candidates: (candidates || []).length, raised, ignored, cooling, over };
    } catch (err) {
      warn(`scan-detect: run failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), config.intervalMinutes * MINUTE_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, run, classify: (row) => classify(row, config) };
}

module.exports = {
  createScanDetector,
  loadScanConfig,
  buildIgnoreList,
  classify,
  DEFAULT_PORT_THRESHOLD,
  DEFAULT_HOST_THRESHOLD,
};
