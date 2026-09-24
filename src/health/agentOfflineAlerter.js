'use strict';

// Alerts when an agent stops reporting. A disconnect used to set the status,
// tell the dashboard and write an audit row — and send nothing, so a site that
// lost its agent (or its uplink) was silent until somebody opened Fleet.
//
//   const alerter = createAgentOfflineAlerter({ dispatcher, isConnected, agentName });
//   alerter.onOffline(agentId, { closeCode });  // from the agent socket
//   alerter.onOnline(agentId);                  // from the agent socket
//   alerter.watch(agentIds);                    // at boot: agents that were alive
//
// A GRACE period rides out what is not an outage: an agent restarting, a
// self-update, a network blip that the agent's own reconnect bridges. Only an
// agent still disconnected when it runs out is alerted, once; when it comes
// back a recovery is sent for the same agent. The alert goes through the
// ordinary dispatcher, so channels, minimum severity, cooldown and maintenance
// windows all apply as they do to any other alert.
//
// In memory on purpose: a server restart drops every socket, so at boot the
// agents that were alive just before are watched again (watch()) — one that
// does not reconnect within the grace is alerted like any other.

const silentLogger = { info() {}, warn() {}, error() {} };
const DEFAULT_GRACE_MS = 2 * 60 * 1000;
// Closing a socket stamps last_seen itself (setStatus), a moment after the
// disconnect was noted here; only a touch clearly later than that means the
// agent is alive through another server instance.
const ALIVE_MARGIN_MS = 15 * 1000;

function createAgentOfflineAlerter({
  dispatcher,
  isConnected = () => false,
  agentName = async () => null,
  // When the agent was last heard from anywhere (the agents row), so an agent
  // that reconnected to ANOTHER server instance is not alerted by this one.
  lastSeen = async () => null,
  graceMs = DEFAULT_GRACE_MS,
  severity = 'CRIT',
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = silentLogger,
} = {}) {
  const pending = new Map(); // agentId -> { timer, since, closeCode }
  let stopped = false; // shutting down: the sockets closing now are ours
  const alerted = new Map(); // agentId -> since (ms)

  const key = (id) => String(id);

  function fmtMinutes(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
  }

  async function send(subject) {
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') return null;
    try {
      return await dispatcher.dispatch(subject, { likelyCause: subject.kind === 'OFFLINE' ? 'agent or its network path is down' : null });
    } catch (err) {
      logger.warn(`agent-offline: dispatch failed (${err && err.message})`);
      return null;
    }
  }

  async function fire(agentId) {
    const k = key(agentId);
    const p = pending.get(k);
    pending.delete(k);
    if (!p) return;
    let live = false;
    try { live = !!isConnected(agentId); } catch { live = false; }
    if (live) return; // it came back through a socket we were not told about
    let seen = null;
    try { seen = await lastSeen(agentId); } catch { seen = null; }
    const seenMs = seen ? new Date(seen).getTime() : NaN;
    if (Number.isFinite(seenMs) && seenMs > p.since + ALIVE_MARGIN_MS) return; // alive elsewhere
    let name = null;
    try { name = await agentName(agentId); } catch { name = null; }
    const label = name || `agent ${agentId}`;
    alerted.set(k, p.since);
    const at = new Date(p.since).toISOString();
    await send({
      id: `agent-offline:${agentId}:${p.since}`,
      hostId: String(agentId),
      metric: 'agent.connection',
      kind: 'OFFLINE',
      severity,
      explanation: `${label} has not been connected since ${at} (${fmtMinutes(now() - p.since)}). `
        + 'Either the agent stopped or the network between it and the server is down — '
        + 'check the other agents at the same site to tell which.',
      deviation: null,
      evidence: [{ disconnectedAt: at, closeCode: p.closeCode ?? null }],
      createdAt: new Date(now()).toISOString(),
    });
  }

  function schedule(agentId, since, closeCode) {
    if (stopped) return;
    const k = key(agentId);
    if (pending.has(k) || alerted.has(k)) return;
    const timer = setTimer(() => { fire(agentId); }, graceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pending.set(k, { timer, since, closeCode });
  }

  function onOffline(agentId, { closeCode = null } = {}) {
    if (agentId == null) return;
    schedule(agentId, now(), closeCode);
  }

  async function onOnline(agentId) {
    if (agentId == null) return;
    const k = key(agentId);
    const p = pending.get(k);
    if (p) { clearTimer(p.timer); pending.delete(k); }
    if (!alerted.has(k)) return;
    const since = alerted.get(k);
    alerted.delete(k);
    let name = null;
    try { name = await agentName(agentId); } catch { name = null; }
    await send({
      id: `agent-online:${agentId}:${now()}`,
      hostId: String(agentId),
      metric: 'agent.connection',
      kind: 'ONLINE',
      severity,
      explanation: `${name || `agent ${agentId}`} is connected again after ${fmtMinutes(now() - since)} offline.`,
      deviation: null,
      evidence: [{ reconnectedAt: new Date(now()).toISOString(), offlineSince: new Date(since).toISOString() }],
      createdAt: new Date(now()).toISOString(),
    });
  }

  // At boot every socket is new. The agents that were alive just before the
  // restart get the same grace as a disconnect; the ones that reconnect cancel
  // their own timer through onOnline().
  function watch(agentIds) {
    for (const id of agentIds || []) schedule(id, now(), null);
  }

  function stop() {
    stopped = true;
    for (const p of pending.values()) clearTimer(p.timer);
    pending.clear();
  }

  function state() {
    return { pending: [...pending.keys()], alerted: [...alerted.keys()] };
  }

  return { onOffline, onOnline, watch, stop, state };
}

module.exports = { createAgentOfflineAlerter, DEFAULT_GRACE_MS };
