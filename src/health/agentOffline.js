'use strict';

// "The agent is offline — is the AGENT dead, or is the NETWORK down?"
//
// An offline badge says the server cannot hear the agent. It does not say why,
// and the two answers send somebody to completely different places: a stopped
// service is fixed on the host, a dead uplink is fixed in a wiring closet, and
// a whole site going dark is a call to the ISP. Every one of those looks
// identical from the WebSocket's point of view.
//
// So this looks at what ELSE the server knows, and says which way the evidence
// points and how strongly. Pure — no I/O, no clock (callers pass `now`) — so the
// verdict is unit-tested directly and the monitor that feeds it stays thin.
//
// Four independent checks, each of which can come back `unknown` when the data
// is not there. Unknown is an answer, not a failure: a site with one agent has
// no peers to compare against, a host nobody probes has no probe evidence, and
// a switch that is not polled cannot say anything about its ports. The finding
// lists every check with its result so an operator can see what the verdict is
// standing on — and what it is not.
//
//   site         — the other agents at the same location (agents.location_id).
//                  All offline → the site or its uplink; some online → local.
//   peer_probes  — other agents' ping/TCP/HTTP probes to this host's own
//                  addresses (capabilities.ips) since it went offline.
//                  Answering → host up, agent process down. Silent → host gone.
//   switch_port  — the host's MAC in a polled switch's forwarding table, and
//                  that port's oper status + any link.down since. A port that
//                  is down is the strongest evidence there is.
//   connection   — the WS hub's own evidence (src/ws/connectionDiagnosis.js).
//                  A license or token rejection means the agent IS reaching the
//                  server, which rules the network out entirely.

const CHECK = Object.freeze({
  SITE: 'site',
  PEER_PROBES: 'peer_probes',
  SWITCH_PORT: 'switch_port',
  CONNECTION: 'connection',
});

// The verdicts, strongest evidence first. The dashboard translates the code
// (`agents.offlineVerdict.<code>` in public/i18n.js); the explanation carried
// on the finding is the server's own English sentence with the evidence in it.
const VERDICT = Object.freeze({
  REJECTED_BY_SERVER: 'rejected_by_server',
  SWITCH_PORT_DOWN: 'switch_port_down',
  SITE_OUTAGE: 'site_outage',
  AGENT_PROCESS_DOWN: 'agent_process_down',
  HOST_UNREACHABLE: 'host_unreachable',
  HOST_OR_ACCESS_LINK: 'host_or_access_link',
  UNKNOWN: 'unknown',
});
const VERDICT_CODES = Object.freeze(Object.values(VERDICT));

// One short server-side phrase per verdict, for the places that carry the
// server's own English (the changes-feed summary, the event title). The
// dashboard renders the code through t() instead.
const VERDICT_SUMMARY = Object.freeze({
  [VERDICT.REJECTED_BY_SERVER]: 'agent alive but refused by the server (license/token)',
  [VERDICT.SWITCH_PORT_DOWN]: 'switch port down',
  [VERDICT.SITE_OUTAGE]: 'site/uplink outage likely',
  [VERDICT.AGENT_PROCESS_DOWN]: 'host reachable, agent process down',
  [VERDICT.HOST_UNREACHABLE]: 'host unreachable',
  [VERDICT.HOST_OR_ACCESS_LINK]: 'agent host or its access link',
  [VERDICT.UNKNOWN]: 'cause unknown (not enough evidence)',
});

// Interface oper states that mean "no link". `dormant`/`testing` are not in
// here on purpose: neither says the cable is dead.
const PORT_DOWN_STATES = new Set(['down', 'lowerLayerDown', 'notPresent']);

function toMs(v) {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function toIso(v) {
  const t = toMs(v);
  return t == null ? null : new Date(t).toISOString();
}

function agentName(a) {
  if (!a) return 'agent';
  return a.display_name || a.hostname || `agent ${a.id}`;
}

function fmtMinutes(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

// --- the four checks -------------------------------------------------------

// site: { locationId, locationName, peers: [{ id, name, status }] }
function siteCheck(site) {
  const peers = (site && Array.isArray(site.peers)) ? site.peers : [];
  if (!site || site.locationId == null) {
    return { check: CHECK.SITE, result: 'unknown', detail: 'The agent is not assigned to a site, so there are no site peers to compare with.' };
  }
  const where = site.locationName ? `site "${site.locationName}"` : `site ${site.locationId}`;
  if (!peers.length) {
    return { check: CHECK.SITE, result: 'unknown', detail: `No other agent at ${where} to compare with.` };
  }
  const online = peers.filter((p) => String(p.status || '').toLowerCase() === 'online');
  const data = { site: site.locationName || String(site.locationId), peers: peers.length, online: online.length };
  if (!online.length) {
    return {
      check: CHECK.SITE,
      result: 'all_offline',
      detail: `All ${peers.length} other agent${peers.length === 1 ? '' : 's'} at ${where} ${peers.length === 1 ? 'is' : 'are'} offline too.`,
      data,
    };
  }
  return {
    check: CHECK.SITE,
    result: 'peers_online',
    detail: `${online.length} of ${peers.length} other agent${peers.length === 1 ? '' : 's'} at ${where} ${online.length === 1 ? 'is' : 'are'} online (${online.slice(0, 3).map((p) => p.name).join(', ')}${online.length > 3 ? ', …' : ''}).`,
    data,
  };
}

// probes: { targets: [ip|hostname], rows: [{ agentId, agentName?, type, target, ok, ts }] }
// Rows are the OTHER agents' probes since the agent went offline. The newest
// result per (prober, target) is the vote — an old success does not outvote a
// fresh failure.
function peerProbeCheck(probes) {
  const targets = (probes && Array.isArray(probes.targets)) ? probes.targets : [];
  if (!targets.length) {
    return { check: CHECK.PEER_PROBES, result: 'unknown', detail: 'The agent has not reported its own addresses, so no probe evidence can be matched to it.' };
  }
  if (probes && probes.error) {
    return { check: CHECK.PEER_PROBES, result: 'unknown', detail: String(probes.error) };
  }
  const rows = (probes && Array.isArray(probes.rows)) ? probes.rows : [];
  if (!rows.length) {
    return {
      check: CHECK.PEER_PROBES,
      result: 'unknown',
      detail: `No other agent has probed ${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ', …' : ''} since the agent went offline.`,
    };
  }
  const latest = new Map();
  for (const r of rows) {
    if (!r || r.target == null) continue;
    const key = `${r.agentId}|${r.target}`;
    const prev = latest.get(key);
    if (!prev || (toMs(r.ts) || 0) > (toMs(prev.ts) || 0)) latest.set(key, r);
  }
  const votes = [...latest.values()];
  const ok = votes.filter((r) => r.ok);
  const probers = new Set(votes.map((r) => String(r.agentId))).size;
  const data = { probers, answered: ok.length, failed: votes.length - ok.length };
  if (ok.length) {
    const r = ok[0];
    return {
      check: CHECK.PEER_PROBES,
      result: 'reachable',
      detail: `${ok.length} of ${votes.length} recent probe${votes.length === 1 ? '' : 's'} from ${probers} other agent${probers === 1 ? '' : 's'} still get an answer (e.g. ${r.type} to ${r.target}${r.agentName ? ` from ${r.agentName}` : ''} at ${toIso(r.ts)}).`,
      data,
    };
  }
  return {
    check: CHECK.PEER_PROBES,
    result: 'unreachable',
    detail: `All ${votes.length} recent probe${votes.length === 1 ? '' : 's'} from ${probers} other agent${probers === 1 ? '' : 's'} to ${[...new Set(votes.map((r) => r.target))].slice(0, 3).join(', ')} fail.`,
    data,
  };
}

// port: null (not resolvable) or { reason } (why not) or
//   { deviceId, deviceName, ifName, mac, operStatus, adminStatus, polledAt, linkDownAt }
function switchPortCheck(port, { offlineSinceMs }) {
  if (!port || !port.ifName) {
    return {
      check: CHECK.SWITCH_PORT,
      result: 'unknown',
      detail: (port && port.reason) || 'The host\'s MAC address was not found on any polled switch port.',
    };
  }
  const where = `${port.deviceName || `device ${port.deviceId}`}/${port.ifName}`;
  const data = { deviceId: port.deviceId, device: port.deviceName || null, port: port.ifName, mac: port.mac || null, operStatus: port.operStatus || null };
  const linkDownMs = toMs(port.linkDownAt);
  const polledMs = toMs(port.polledAt);
  const fresh = polledMs != null && offlineSinceMs != null && polledMs >= offlineSinceMs;
  const operDown = PORT_DOWN_STATES.has(String(port.operStatus || ''));
  if (linkDownMs != null || (operDown && fresh)) {
    const bits = [];
    if (operDown) bits.push(`oper status ${port.operStatus}${polledMs != null ? ` at the ${toIso(port.polledAt)} poll` : ''}`);
    if (String(port.adminStatus || '') === 'down') bits.push('administratively shut down');
    if (linkDownMs != null) bits.push(`link.down reported at ${toIso(port.linkDownAt)}`);
    return {
      check: CHECK.SWITCH_PORT,
      result: 'down',
      detail: `Switch port ${where} (where the host's MAC${port.mac ? ` ${port.mac}` : ''} is learned) is down: ${bits.join('; ')}.`,
      data,
    };
  }
  if (!fresh) {
    return {
      check: CHECK.SWITCH_PORT,
      result: 'unknown',
      detail: `The host is on switch port ${where}, but that switch has not been polled since the agent went offline${polledMs != null ? ` (last poll ${toIso(port.polledAt)})` : ''}.`,
      data,
    };
  }
  return {
    check: CHECK.SWITCH_PORT,
    result: 'up',
    detail: `Switch port ${where} is ${port.operStatus || 'not reported down'} at the ${toIso(port.polledAt)} poll — the access link has carrier.`,
    data,
  };
}

// connection: the diagnoseConnection() output, or null.
function connectionCheck(connection) {
  if (!connection || !connection.state) {
    return { check: CHECK.CONNECTION, result: 'unknown', detail: 'No live connection evidence (the WS hub is not available).' };
  }
  const state = String(connection.state);
  if (state === 'license-blocked' || state === 'auth-rejected') {
    return {
      check: CHECK.CONNECTION,
      result: 'rejected',
      detail: state === 'license-blocked'
        ? 'The agent is still reaching the server, but the license gate refuses the connection.'
        : 'Connection attempts from the agent\'s last-known address are being rejected (token not accepted).',
      data: { state },
    };
  }
  return {
    check: CHECK.CONNECTION,
    result: 'no_attempts',
    detail: 'The server has seen no rejected connection attempts from the agent — it is not dialling in at all.',
    data: { state },
  };
}

// --- the verdict -----------------------------------------------------------

// facts: { agent, now, offlineSince, site, probes, port, connection }
// Returns { verdict, confidence, severity, explanation, checks[] }.
function assessAgentOffline({
  agent, now = Date.now(), offlineSince = null, site = null, probes = null, port = null, connection = null,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const sinceMs = toMs(offlineSince);
  const checks = [
    siteCheck(site),
    peerProbeCheck(probes),
    switchPortCheck(port, { offlineSinceMs: sinceMs }),
    connectionCheck(connection),
  ];
  const by = Object.fromEntries(checks.map((c) => [c.check, c]));
  const siteR = by[CHECK.SITE].result;
  const probeR = by[CHECK.PEER_PROBES].result;
  const portR = by[CHECK.SWITCH_PORT].result;
  const connR = by[CHECK.CONNECTION].result;

  let verdict;
  let confidence;
  let conclusion;
  if (connR === 'rejected') {
    verdict = VERDICT.REJECTED_BY_SERVER;
    confidence = 'high';
    conclusion = 'The agent is alive and reaching the server, but the server refuses it — this is not a network fault. See the agent\'s connection diagnosis.';
  } else if (portR === 'down') {
    verdict = VERDICT.SWITCH_PORT_DOWN;
    confidence = 'high';
    conclusion = `The switch port the host is plugged into is down (${by[CHECK.SWITCH_PORT].data.device || `device ${by[CHECK.SWITCH_PORT].data.deviceId}`}/${by[CHECK.SWITCH_PORT].data.port}) — cable, NIC, host power or the port itself.`;
  } else if (siteR === 'all_offline') {
    verdict = VERDICT.SITE_OUTAGE;
    confidence = 'medium';
    conclusion = probeR === 'reachable'
      ? 'Every agent at the site is offline while the host still answers probes — the site\'s path to this server (uplink, VPN, firewall) is the likely fault, not the hosts.'
      : 'Every agent at the site is offline — a site power or uplink outage is likely.';
  } else if (probeR === 'reachable') {
    verdict = VERDICT.AGENT_PROCESS_DOWN;
    confidence = 'medium';
    conclusion = 'The host still answers other agents\' probes, so the host and its network are up — the agent process or service has stopped, or it can no longer reach this server.';
  } else if (probeR === 'unreachable') {
    verdict = VERDICT.HOST_UNREACHABLE;
    confidence = 'medium';
    conclusion = siteR === 'peers_online'
      ? 'Other agents at the site are online but cannot reach the host either — the host is down or its access link is.'
      : 'Other agents cannot reach the host either — the host is down or the network in front of it is.';
  } else if (siteR === 'peers_online') {
    verdict = VERDICT.HOST_OR_ACCESS_LINK;
    confidence = 'low';
    conclusion = 'Other agents at the site are online, so the site is up — the fault is on this agent\'s host or its access link.';
  } else {
    verdict = VERDICT.UNKNOWN;
    confidence = 'low';
    conclusion = 'There is not enough evidence to tell a stopped agent from a network fault.';
  }

  const offFor = sinceMs == null ? null : nowMs - sinceMs;
  const head = `${agentName(agent)} has been offline${offFor != null ? ` for ${fmtMinutes(offFor)} (since ${toIso(sinceMs)})` : ''}.`;
  const ran = checks.filter((c) => c.result !== 'unknown').length;
  const explanation = [
    head,
    conclusion,
    `Checks (${ran} of ${checks.length} had data): ${checks.map((c) => `${c.check}=${c.result}`).join(', ')}.`,
    ...checks.map((c) => `- ${c.check}: ${c.detail}`),
  ].join('\n');

  // A whole site going dark is several agents at once and a bigger problem than
  // one host; everything else is one agent, which is a warning.
  const severity = verdict === VERDICT.SITE_OUTAGE ? 'CRIT' : 'WARN';

  return { verdict, confidence, severity, explanation, checks, offlineSince: toIso(sinceMs), offlineForMs: offFor };
}

module.exports = {
  assessAgentOffline, VERDICT, VERDICT_CODES, VERDICT_SUMMARY, CHECK, PORT_DOWN_STATES,
};
