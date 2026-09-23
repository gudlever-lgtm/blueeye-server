'use strict';

const { assessAgentOffline } = require('./agentOffline');
const { diagnoseConnection } = require('../ws/connectionDiagnosis');
const { normalizeMac } = require('../identity/arpTable');
const { FindingKind } = require('../analysis/constants');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// The metric an agent-offline finding carries. `agent.offline` is also the
// audit action for the transition itself; the two are the same condition seen
// from two sides (the moment it happened, and the verdict once it lasted).
const METRIC = 'agent.offline';

// Leader-only background job that makes "agent offline" something the product
// ACTS on rather than only draws.
//
// Before this, an agent's status changed only when its WebSocket closed — a
// server that missed the close (a half-open TCP connection, a crashed replica)
// showed a green badge on a dead agent until the next restart ran the one-shot
// startup reconcile. And an agent that did go offline raised nothing: no
// finding, no alert, no event, just a grey badge somebody had to notice.
//
// Every tick (default 60 s):
//   1. SWEEP — agents marked online but silent past `staleOfflineSec` are flipped
//      offline (never one with a live socket here), audited and pushed exactly
//      as the WS close handler would have.
//   2. RESOLVE — an agent we raised a finding for that is back online gets the
//      event case its finding opened resolved, when nothing else joined it.
//   3. RAISE — an agent offline continuously for `graceMs` gets ONE finding for
//      that offline episode, with an explainable dead-agent vs network-down
//      verdict (./agentOffline.js), through the same store → publish → event
//      case → dispatcher → integrations path the probe pipeline uses. The
//      dispatcher's maintenance silencer applies, so a planned window pages
//      nobody while the finding is still recorded.
//
// An EPISODE is keyed by the agent's last_seen: an agent that comes back and
// drops again has a new last_seen and is a new episode. Dedup is durable (a
// finding for this agent created since the episode began already exists → do
// not raise again), so a server restart does not re-raise every open outage.
function createAgentOfflineMonitor({
  agentsRepo,
  findingStore = null,
  eventCaseService = null,
  eventCasesRepo = null,
  auditLogRepo = null,
  auditEventsRepo = null,
  notifyDashboard = null,
  publishFinding = () => {},
  dispatcher = null,
  alertingEnabled = false,
  integrationTrigger = null,
  // Identity sources for the switch-port check. Each is optional; a missing one
  // makes that check `unknown`, never an error.
  arpEntriesRepo = null,
  fdbEntriesRepo = null,
  deviceInterfacesRepo = null,
  deviceEventsRepo = null,
  // () => [agentId]  — agents with a live socket on this process.
  connectedAgentIds = () => [],
  // (agentId) => agentSocket.getConnectionInfo() output, or null.
  getConnectionInfo = null,
  licensed = () => true,
  staleOfflineSec = 300,
  graceMs = 5 * 60 * 1000,
  // An agent silent for longer than this is abandoned, not newly failed: it is
  // already grey on the fleet page, and raising a finding (and paging) for
  // every long-dead agent the first time this job runs after an upgrade would
  // bury the outages that are actually new.
  maxAgeMs = 24 * 3600 * 1000,
  // Bounded work per tick. The rest are picked up on the next one.
  maxRaisePerTick = 25,
  intervalMs = 60 * 1000,
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  let timer = null;
  let running = false;
  // agentId (string) -> { findingId, eventCaseId, offlineSinceMs } for the
  // episode this process has raised (or found raised) and not yet resolved.
  const raised = new Map();

  const toMs = (v) => {
    if (v == null) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const nameOf = (a) => a.display_name || a.hostname || `agent ${a.id}`;

  function liveIds() {
    try { return (connectedAgentIds() || []).map(Number).filter((n) => Number.isInteger(n) && n > 0); } catch { return []; }
  }

  // --- 1. sweep ------------------------------------------------------------
  async function sweep() {
    if (!agentsRepo || typeof agentsRepo.sweepStaleOffline !== 'function') return [];
    let flipped = [];
    try {
      flipped = await agentsRepo.sweepStaleOffline({ olderThanSec: staleOfflineSec, exceptIds: liveIds() });
    } catch (err) {
      logger.warn(`agent-offline: stale sweep failed (${err.message})`);
      return [];
    }
    for (const id of flipped) {
      if (typeof notifyDashboard === 'function') {
        try { notifyDashboard({ type: 'agent-status', payload: { agentId: id, status: 'offline' } }); } catch { /* best-effort */ }
      }
      if (auditEventsRepo && typeof auditEventsRepo.record === 'function') {
        Promise.resolve(auditEventsRepo.record({ actorType: 'agent', actorId: id, action: 'agent.offline', ip: null }))
          .catch((err) => logger.warn(`agent-offline: audit of stale flip failed (${err.message})`));
      }
    }
    if (flipped.length) logger.info(`agent-offline: ${flipped.length} agent(s) silent past ${staleOfflineSec}s marked offline (no WS close was seen).`);
    return flipped;
  }

  // --- 2. resolve on reconnect ------------------------------------------------
  // Resolves the event case the offline finding OPENED, and only when nothing
  // else has joined it since: a case that has grown other findings is about
  // more than the agent being away, and closing it because the agent came back
  // would close those too. The finding itself stays (it is the record that the
  // agent was offline, and for how long); acknowledging it is the operator's.
  async function resolveEpisode(agentId, rec) {
    if (!rec.eventCaseId || !eventCasesRepo || typeof eventCasesRepo.findById !== 'function') return false;
    try {
      const ec = await eventCasesRepo.findById(rec.eventCaseId);
      if (!ec || (ec.status !== 'open' && ec.status !== 'investigating')) return false;
      if (String(ec.primaryFindingId) !== String(rec.findingId)) return false;
      const first = toMs(ec.firstEventAt);
      const last = toMs(ec.lastEventAt);
      if (first != null && last != null && last > first) return false; // something else joined
      const ok = await eventCasesRepo.updateStatus(ec.id, { from: ec.status, to: 'resolved', at: new Date(now()) });
      if (ok && auditLogRepo && typeof auditLogRepo.record === 'function') {
        try {
          await auditLogRepo.record({
            category: 'event',
            action: 'event_auto_resolve',
            actorRole: 'system',
            target: String(ec.id),
            detail: `${ec.status}→resolved (agent ${agentId} reconnected)`,
          });
        } catch { /* audit is best-effort */ }
      }
      return !!ok;
    } catch (err) {
      logger.warn(`agent-offline: could not resolve event ${rec.eventCaseId} (${err.message})`);
      return false;
    }
  }

  // --- 3. evidence ------------------------------------------------------------
  async function portEvidence(agent, ips, sinceMs) {
    if (!arpEntriesRepo || !fdbEntriesRepo || typeof arpEntriesRepo.findByIp !== 'function' || typeof fdbEntriesRepo.findByMac !== 'function') {
      return { reason: 'No switch forwarding tables are collected on this server.' };
    }
    if (!ips.length) return { reason: 'The agent has not reported its own addresses, so its MAC cannot be looked up.' };
    // IP -> MAC from OTHER hosts' neighbour tables (the agent's own table never
    // holds its own address).
    const macs = new Set();
    for (const ip of ips.slice(0, 4)) {
      const rows = await arpEntriesRepo.findByIp({ ip, limit: 5 });
      for (const r of rows || []) {
        if (Number(r.agentId) === Number(agent.id)) continue;
        const mac = normalizeMac(r.mac);
        if (mac) macs.add(mac);
      }
    }
    if (!macs.size) return { reason: `No neighbour table maps ${ips.slice(0, 3).join(', ')} to a MAC address.` };
    // MAC -> switch port. The MAC is learned on every switch along the path;
    // the ACCESS port is the one with the fewest MACs behind it (an uplink
    // carries the whole segment), freshest breaking the tie.
    let best = null;
    for (const mac of [...macs].slice(0, 4)) {
      const rows = await fdbEntriesRepo.findByMac(mac, { limit: 10 });
      for (const r of rows || []) {
        if (!r || !r.ifName) continue;
        const cand = { ...r, mac };
        if (!best
          || (cand.portMacCount || 0) < (best.portMacCount || 0)
          || ((cand.portMacCount || 0) === (best.portMacCount || 0) && (toMs(cand.lastSeen) || 0) > (toMs(best.lastSeen) || 0))) {
          best = cand;
        }
      }
    }
    if (!best) return { reason: `MAC ${[...macs][0]} is not in any polled switch's forwarding table.` };

    const port = {
      deviceId: best.deviceId,
      deviceName: best.deviceName || best.deviceHost || null,
      ifName: best.ifName,
      mac: best.mac,
      operStatus: null,
      adminStatus: null,
      polledAt: null,
      linkDownAt: null,
    };
    if (deviceInterfacesRepo && typeof deviceInterfacesRepo.listForDevice === 'function') {
      const ifaces = await deviceInterfacesRepo.listForDevice(best.deviceId, { limit: 1000 });
      const hit = (ifaces || []).find((i) => i && String(i.ifName).toLowerCase() === String(best.ifName).toLowerCase());
      if (hit) {
        port.operStatus = hit.operStatus || null;
        port.adminStatus = hit.adminStatus || null;
        port.polledAt = hit.lastSeen || null;
      }
    }
    if (deviceEventsRepo && typeof deviceEventsRepo.listForDevice === 'function') {
      // The switch's own word on the port, from a little before the agent went
      // quiet (the trap usually lands first). Only the NEWEST link event for the
      // port counts: a link.down followed by a link.up is a port that is up.
      const from = new Date(sinceMs - 5 * 60 * 1000);
      const events = await deviceEventsRepo.listForDevice(best.deviceId, { from, to: new Date(now()), limit: 200, newestFirst: true });
      const latest = (events || []).find((e) => e && (e.eventType === 'link.down' || e.eventType === 'link.up')
        && e.ifname && String(e.ifname).toLowerCase() === String(best.ifName).toLowerCase());
      if (latest && latest.eventType === 'link.down') {
        // A poll AFTER the trap that saw the port up again outranks the trap.
        const polled = toMs(port.polledAt);
        const trapped = toMs(latest.receivedAt);
        if (!(polled != null && trapped != null && polled > trapped && port.operStatus === 'up')) {
          port.linkDownAt = latest.receivedAt;
        }
      }
    }
    return port;
  }

  async function gatherFacts(agent, agents, sinceMs) {
    const caps = agent.capabilities && typeof agent.capabilities === 'object' ? agent.capabilities : {};
    const ips = Array.isArray(caps.ips) ? caps.ips.filter((ip) => typeof ip === 'string' && ip) : [];

    // (a) site peers
    const site = agent.location_id == null ? null : {
      locationId: agent.location_id,
      locationName: agent.location_name || null,
      peers: agents
        .filter((a) => a && a.id !== agent.id && a.location_id != null && String(a.location_id) === String(agent.location_id))
        .map((a) => ({ id: a.id, name: nameOf(a), status: a.status })),
    };

    // (b) other agents' probes to this host
    const targets = [...ips];
    if (agent.hostname) targets.push(String(agent.hostname));
    let probes = { targets: ips.length ? targets : [], rows: [] };
    if (ips.length && typeof agentsRepo.peerProbesTowards === 'function') {
      try {
        probes = { targets, rows: await agentsRepo.peerProbesTowards({ targets, from: new Date(sinceMs), excludeAgentId: agent.id, limit: 200 }) };
      } catch (err) {
        logger.warn(`agent-offline: probe evidence for ${agent.id} failed (${err.message})`);
        probes = { targets, rows: [], error: 'The probe-results lookup failed.' };
      }
    }

    // (c) switch port
    let port;
    try {
      port = await portEvidence(agent, ips, sinceMs);
    } catch (err) {
      logger.warn(`agent-offline: switch-port evidence for ${agent.id} failed (${err.message})`);
      port = { reason: 'The switch-port lookup failed.' };
    }

    // (d) the WS hub's connection evidence
    let connection = null;
    if (typeof getConnectionInfo === 'function') {
      try {
        const live = getConnectionInfo(agent.id);
        connection = diagnoseConnection({ agent, live, now: now() });
      } catch { connection = null; }
    }
    return { site, probes, port, connection };
  }

  function buildFinding(agent, assessment, sinceMs) {
    const at = new Date(now());
    return {
      hostId: String(agent.id),
      metric: METRIC,
      severity: assessment.severity,
      // Crossed a configured absolute threshold: offline for longer than the
      // grace period. Not a statistical anomaly — there is no baseline for "gone".
      kind: FindingKind.THRESHOLD,
      observed: Math.round((at.getTime() - sinceMs) / 60000),
      baseline: Math.round(graceMs / 60000),
      deviation: null,
      window: [new Date(sinceMs), at],
      explanation: assessment.explanation,
      evidence: [{
        ts: at,
        target: `agent:${agent.id}`,
        verdict: assessment.verdict,
        confidence: assessment.confidence,
        offlineSince: assessment.offlineSince,
        checks: assessment.checks,
      }],
      createdAt: at,
    };
  }

  async function alreadyRaised(agentId, sinceMs) {
    if (!findingStore || typeof findingStore.list !== 'function') return null;
    const rows = await findingStore.list(String(agentId), new Date(sinceMs), 1, undefined, { metric: METRIC });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function raise(agent, agents, sinceMs) {
    const facts = await gatherFacts(agent, agents, sinceMs);
    const assessment = assessAgentOffline({ agent, now: now(), offlineSince: sinceMs, ...facts });
    const finding = buildFinding(agent, assessment, sinceMs);
    const saved = await findingStore.save(finding);
    const stored = { ...finding, ...(saved || {}) };
    try { publishFinding(stored.hostId, { type: 'finding', payload: stored }); } catch (err) {
      logger.warn(`agent-offline: publish failed (${err.message})`);
    }
    let eventCaseId = null;
    if (eventCaseService && typeof eventCaseService.assignFinding === 'function') {
      try {
        const placed = await eventCaseService.assignFinding(stored);
        eventCaseId = placed && placed.created ? placed.eventCaseId : null;
      } catch (err) {
        logger.warn(`agent-offline: event assignment failed for ${stored.id} (${err.message})`);
      }
    }
    const alertOn = typeof alertingEnabled === 'function' ? alertingEnabled() : alertingEnabled;
    if (dispatcher && alertOn) {
      try { await dispatcher.dispatch(stored, null); } catch (err) {
        logger.warn(`agent-offline: dispatch failed for ${stored.id} (${err.message})`);
      }
    }
    if (integrationTrigger && typeof integrationTrigger.emitFinding === 'function') {
      try { Promise.resolve(integrationTrigger.emitFinding(stored)).catch(() => {}); } catch { /* never affects the job */ }
    }
    return { finding: stored, eventCaseId, assessment };
  }

  async function runOnce() {
    const result = { flipped: [], resolved: [], raised: [] };
    result.flipped = await sweep();

    let agents;
    try {
      agents = (await agentsRepo.findAll()) || [];
    } catch (err) {
      logger.warn(`agent-offline: could not list agents (${err.message})`);
      return result;
    }
    const byId = new Map(agents.map((a) => [String(a.id), a]));
    const live = new Set(liveIds().map(String));

    // 2. back online → resolve what this monitor opened.
    for (const [key, rec] of [...raised]) {
      const a = byId.get(key);
      if (!a) { raised.delete(key); continue; } // deleted agent
      // A newer last_seen on an offline row is also "came back": the agent
      // reconnected and dropped again between two ticks, which is a NEW
      // episode — the old one is over and must not be left open.
      const lastMs = toMs(a.last_seen);
      const back = live.has(key) || String(a.status).toLowerCase() === 'online'
        || (lastMs != null && lastMs > rec.offlineSinceMs);
      if (!back) continue;
      raised.delete(key);
      if (await resolveEpisode(key, rec)) result.resolved.push(Number(key));
    }

    // 3. raise, once per episode.
    if (!findingStore || typeof findingStore.save !== 'function') return result;
    let allowed = true;
    try { allowed = !!licensed(); } catch { allowed = false; }
    if (!allowed) return result;

    const nowMs = now();
    for (const agent of agents) {
      if (result.raised.length >= maxRaisePerTick) break;
      if (!agent || String(agent.status).toLowerCase() !== 'offline') continue;
      const key = String(agent.id);
      if (live.has(key)) continue; // a live socket outranks a stale row
      const sinceMs = toMs(agent.last_seen);
      if (sinceMs == null) continue; // never connected — nothing went offline
      const offFor = nowMs - sinceMs;
      if (offFor < graceMs || offFor > maxAgeMs) continue;
      const known = raised.get(key);
      if (known && known.offlineSinceMs === sinceMs) continue;
      try {
        const existing = await alreadyRaised(agent.id, sinceMs);
        if (existing) {
          raised.set(key, {
            findingId: existing.id,
            eventCaseId: existing.eventCaseId ?? null,
            offlineSinceMs: sinceMs,
          });
          continue;
        }
        const out = await raise(agent, agents, sinceMs);
        raised.set(key, {
          findingId: out.finding.id, eventCaseId: out.eventCaseId, offlineSinceMs: sinceMs,
        });
        result.raised.push({ agentId: agent.id, findingId: out.finding.id, verdict: out.assessment.verdict });
      } catch (err) {
        logger.warn(`agent-offline: could not raise a finding for agent ${agent.id} (${err.message})`);
      }
    }
    if (result.raised.length) logger.info(`agent-offline: raised ${result.raised.length} offline finding(s).`);
    return result;
  }

  // Overlapping ticks would double-raise (both see "not yet raised"), so a tick
  // that is still running when the next one fires is skipped rather than queued.
  async function tick() {
    if (running) return null;
    running = true;
    try { return await runOnce(); } finally { running = false; }
  }

  function start() {
    if (timer) return;
    tick().catch((err) => logger.error(`agent-offline: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      tick().catch((err) => logger.error(`agent-offline: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce: tick, sweep, start, stop };
}

module.exports = { createAgentOfflineMonitor, METRIC };
