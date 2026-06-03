'use strict';

// Per-agent data-quality: can we trust what this agent reports? Derived from
// signals the agent ALREADY sends — no agent change:
//   • NetFlow droppedPackets / sFlow droppedDatagrams  → collector overload / loss
//   • agent timestamp (finishedAt) vs server receive time (created_at) → clock skew
//   • agentVersion (from the capabilities POST)         → out-of-date agents
// Pure + explainable; every verdict carries a reason + evidence.

const DROP_WARN = 1; // % of netflow/sflow datagrams dropped by the collector
const DROP_BAD = 5;
const SKEW_WARN = 5 * 1000; // ms of clock skew vs the server
const SKEW_BAD = 60 * 1000;

const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const TIER = { bad: 0, warn: 1, ok: 2, unknown: 3 };
const worse = (a, b) => (TIER[a] <= TIER[b] ? a : b);

function computeDataQuality({ capabilities = null, latest = null, now = Date.now() } = {}) {
  const version = capabilities && capabilities.agentVersion ? String(capabilities.agentVersion) : null;
  const out = { version, source: null, clockSkewMs: null, dropPct: null, status: 'unknown', reason: 'No measurements yet.', evidence: [] };
  if (!latest || !latest.payload) return out;

  const payload = latest.payload;
  const traffic = payload.traffic || {};
  out.source = traffic.source || (Array.isArray(traffic.interfaces) ? 'proc' : null);

  // Clock skew = server receive time − agent's own timestamp.
  const agentTsRaw = payload.finishedAt || payload.startedAt || payload.at || traffic.at || null;
  const recvMs = latest.created_at instanceof Date ? latest.created_at.getTime() : (latest.created_at ? Date.parse(latest.created_at) : null);
  if (agentTsRaw && Number.isFinite(recvMs)) {
    const a = Date.parse(agentTsRaw);
    if (Number.isFinite(a)) out.clockSkewMs = recvMs - a;
  }

  // Collector drop-rate (netflow/sflow only; proc/snmp have no drop concept).
  if (traffic.source === 'netflow') {
    const p = Number(traffic.packets) || 0;
    const d = Number(traffic.droppedPackets) || 0;
    if (p + d > 0) out.dropPct = round1((d / (p + d)) * 100);
  } else if (traffic.source === 'sflow') {
    const p = Number(traffic.datagrams) || 0;
    const d = Number(traffic.droppedDatagrams) || 0;
    if (p + d > 0) out.dropPct = round1((d / (p + d)) * 100);
  }

  let status = 'ok';
  const evidence = [];
  if (out.dropPct != null && out.dropPct >= DROP_BAD) { status = worse(status, 'bad'); evidence.push({ metric: 'drop', dropPct: out.dropPct }); }
  else if (out.dropPct != null && out.dropPct >= DROP_WARN) { status = worse(status, 'warn'); evidence.push({ metric: 'drop', dropPct: out.dropPct }); }

  const skewAbs = out.clockSkewMs == null ? null : Math.abs(out.clockSkewMs);
  if (skewAbs != null && skewAbs >= SKEW_BAD) { status = worse(status, 'bad'); evidence.push({ metric: 'clock', skewMs: out.clockSkewMs }); }
  else if (skewAbs != null && skewAbs >= SKEW_WARN) { status = worse(status, 'warn'); evidence.push({ metric: 'clock', skewMs: out.clockSkewMs }); }

  out.status = status;
  out.evidence = evidence;
  out.reason = reasonFor(out, evidence);
  return out;
}

function reasonFor(q, evidence) {
  const top = evidence[0];
  if (!top) return `Data looks healthy${q.version ? ` (agent v${q.version})` : ''}.`;
  if (top.metric === 'drop') return `Collector is dropping ${top.dropPct}% of ${q.source} packets.`;
  if (top.metric === 'clock') return `Agent clock is ${Math.round(Math.abs(top.skewMs) / 1000)} s out of sync with the server.`;
  return 'OK.';
}

module.exports = { computeDataQuality, THRESHOLDS: { DROP_WARN, DROP_BAD, SKEW_WARN, SKEW_BAD } };
