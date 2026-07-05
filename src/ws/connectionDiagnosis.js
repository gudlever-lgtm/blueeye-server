'use strict';

// Turns the agent's DB row + the WS hub's live connection evidence into an
// explainable verdict on WHY an agent is (dis)connected and what to do about
// it. Pure — no I/O, no clock reads (callers pass `now`) — so it is unit-tested
// directly and the route stays thin.
//
// Important architectural fact this module encodes: connections are ALWAYS
// initiated by the agent (it dials the server's /ws/agent; the server cannot
// dial out). So every "disconnected" state ultimately resolves on the agent's
// side — the diagnosis explains which side of that handshake is failing and
// what evidence supports it.
//
// The live evidence (session, license rejections, auth failures) is tracked in
// memory by the WS hub and resets on a server restart; the diagnosis says so
// instead of overclaiming.

// The agent's reconnect backoff caps at 30 s by default — three missed windows
// before we stop calling a drop "reconnecting".
const RECONNECT_GRACE_MS = 90 * 1000;
// How recent a rejection (license 403 / auth 401) must be to count as the
// current cause rather than history.
const REJECTION_WINDOW_MS = 10 * 60 * 1000;

function toTime(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function within(value, windowMs, now) {
  const t = toTime(value);
  return t != null && now - t <= windowMs;
}

function fmtAge(value, now) {
  const t = toTime(value);
  if (t == null) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Recent 401 attempts, attributed to this agent when they come from its
// last-known address. Unattributed ones are still surfaced (as a caution, not
// a verdict) — the token of a rejected agent can't be resolved to an id.
function splitAuthFailures(live, session, now) {
  const all = ((live && live.authFailures) || []).filter((f) => within(f.at, REJECTION_WINDOW_MS, now));
  const ip = session && session.ip;
  return {
    matched: ip ? all.filter((f) => f.ip === ip) : [],
    unmatched: ip ? all.filter((f) => f.ip !== ip) : all,
  };
}

// { agent, live, now } -> { connected, state, explanation, hints, evidence }.
//   agent — the agents-repo row (status, last_seen, last_report_at, …).
//   live  — agentSocket.getConnectionInfo() output, or null when the WS hub
//           isn't up (diagnosis then falls back to the DB row alone).
function diagnoseConnection({ agent, live, now = Date.now() }) {
  const session = (live && live.session) || null;
  const connected = !!(live && live.connected);
  const { matched: authMatched, unmatched: authUnmatched } = splitAuthFailures(live, session, now);

  const evidence = [];
  const push = (label, value) => { if (value != null && value !== '') evidence.push({ label, value }); };
  push('Status (DB)', agent && agent.status);
  push('Last seen', agent && agent.last_seen ? `${fmtAge(agent.last_seen, now)}` : 'never');
  push('Live sockets', live ? live.sockets : 'unknown (WS hub not available)');
  if (session) {
    push('Agent address', session.ip || 'unknown');
    push('Connected at', session.connectedAt);
    if (session.disconnectedAt) push('Disconnected', `${fmtAge(session.disconnectedAt, now)} (close code ${session.closeCode ?? 'unknown'})`);
  }
  if (live && live.licenseRejectedAt) push('License rejection', fmtAge(live.licenseRejectedAt, now));
  if (authMatched.length) push('Rejected token attempts (this agent’s address)', authMatched.length);
  if (authUnmatched.length) push('Rejected token attempts (unattributed)', authUnmatched.length);
  if (live && live.licenseAcceptsNew === false) push('License gate', 'not accepting new connections');
  push('Note', 'Connection-attempt evidence is in-memory and resets when the server restarts.');

  const base = { connected, evidence };

  if (connected) {
    return {
      ...base,
      state: 'connected',
      explanation: `The agent has ${live.sockets} live connection${live.sockets === 1 ? '' : 's'} to the server${session && session.connectedAt ? ` (since ${fmtAge(session.connectedAt, now)})` : ''}.`,
      hints: ['If commands still fail or time out, use "Force reconnect" — the server closes the socket and the agent re-dials with a clean session within seconds.'],
    };
  }

  // Valid token, but the license gate turned it away — the one disconnect cause
  // that is fixable purely on the server.
  if (live && within(live.licenseRejectedAt, REJECTION_WINDOW_MS, now)) {
    return {
      ...base,
      state: 'license-blocked',
      explanation: `The agent IS reaching the server and its token is valid, but the server refused the connection (last time ${fmtAge(live.licenseRejectedAt, now)}) because the license is invalid or the agent limit is reached. The agent keeps retrying about every 30 s and will connect by itself as soon as capacity allows.`,
      hints: [
        'Check Settings → License: is the license valid, and is the connected-agent count at the plan limit?',
        'Free capacity (disconnect or delete an unused agent) or install a license with a higher agent limit — no action is needed on the agent itself.',
      ],
    };
  }

  // 401s from the agent's last-known address: its token is no longer accepted.
  // The agent client treats a 401 as fatal and stops retrying on purpose.
  if (authMatched.length) {
    return {
      ...base,
      state: 'auth-rejected',
      explanation: `${authMatched.length} connection attempt${authMatched.length === 1 ? '' : 's'} from this agent's last-known address (${session.ip}) ${authMatched.length === 1 ? 'was' : 'were'} rejected because the token was not accepted (HTTP 401). After a 401 the agent deliberately stops retrying and stays down until it is restarted.`,
      hints: [
        'If the agent was deleted or re-enrolled on the server, its old token is gone for good — re-enroll the agent with a new one-time code.',
        'Otherwise restart the agent service on its host: systemctl restart blueeye-agent.',
      ],
    };
  }

  // Fresh drop: the agent's own backoff (≤ 30 s) should bring it back.
  if (session && within(session.disconnectedAt, RECONNECT_GRACE_MS, now)) {
    return {
      ...base,
      state: 'reconnecting',
      explanation: `The agent disconnected ${fmtAge(session.disconnectedAt, now)} (close code ${session.closeCode ?? 'unknown'}). Agents reconnect on their own with exponential backoff of up to 30 s — it should be back shortly.`,
      hints: ['Wait a moment and retry the action, or re-check this diagnosis.'],
    };
  }

  // Never seen at all: enrolled but the installer/agent never dialed in.
  if (!(agent && agent.last_seen) && !session) {
    return {
      ...base,
      state: 'never-connected',
      explanation: 'This agent has never connected. Connections are always made by the agent (the server cannot dial out), so either the installer was never run on the host, or the agent cannot reach this server’s address/port.',
      hints: [
        'Verify the install finished on the host and the service is running: systemctl status blueeye-agent.',
        'From the host, verify it can reach the server URL (and that the port is open through firewalls).',
      ],
    };
  }

  // Default: it was here once, it isn't now, and no connection attempts have
  // been observed since — the cause is on the agent's side of the dial.
  const lastRef = (session && session.disconnectedAt) || (agent && agent.last_seen) || null;
  const unattributed = authUnmatched.length
    ? ` Note: ${authUnmatched.length} recent connection attempt${authUnmatched.length === 1 ? '' : 's'} with an unaccepted token ${authUnmatched.length === 1 ? 'was' : 'were'} seen from ${[...new Set(authUnmatched.map((f) => f.ip || 'unknown'))].join(', ')} — if that is this agent's address, its token is no longer valid and it needs re-enrolling.`
    : '';
  return {
    ...base,
    state: 'unreachable',
    explanation: `The agent has been offline since ${lastRef ? fmtAge(lastRef, now) : 'an unknown time'} and the server has seen no connection attempts from it since${session ? '' : ' the server started'}. Connections are always initiated by the agent, so the cause is on its side: the process is stopped, the host is down or asleep, or a network/firewall/DNS change is blocking it.${unattributed}`,
    hints: [
      'On the host: systemctl status blueeye-agent and journalctl -u blueeye-agent -n 100 show whether it is running and what it last logged.',
      'A restart is the agent-side "reconnect button": systemctl restart blueeye-agent.',
      'If the agent log shows a fatal 401, re-enroll the agent; if it shows connect timeouts, check the network path to this server.',
    ],
  };
}

module.exports = { diagnoseConnection, RECONNECT_GRACE_MS, REJECTION_WINDOW_MS };
