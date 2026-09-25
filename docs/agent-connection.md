# Agent connection diagnosis & reconnect

Answers the operator question behind every `409 Agent not connected`:
**why** is the agent disconnected, and can I get it back from the server?

## The architectural constraint

Connections are always **initiated by the agent** — it dials the server's
`/ws/agent` WebSocket (customer hosts sit behind NAT/firewalls; the agent
doesn't listen on anything). The server therefore cannot "reconnect to" a
disconnected agent. What it *can* do:

- **Explain** why the agent isn't connected, from the evidence it holds.
- **Force a clean re-dial** of a *connected* agent by closing its socket
  (close code `4001`); the agent's client reconnects with backoff (≤ 30 s by
  default), re-runs its reconcile and reloads its transaction config. Useful
  when a session is wedged (commands time out) or after server-side changes.

## Endpoints

| Route | Role | What it does |
| --- | --- | --- |
| `GET /agents/:id/connection` | viewer+ | Explainable verdict: `{ connected, state, explanation, hints, evidence }`. Works precisely when the agent is *not* connected. |
| `POST /agents/:id/reconnect` | operator+ | Closes the agent's live socket(s) and waits (≤ 12 s) for it to re-dial → `{ closed, reconnected, waitedMs }`. `409` + the diagnosis when the agent has no live connection (nothing to reconnect). Audited as `agent.reconnect`. |

## Diagnosis states

Produced by the pure `src/ws/connectionDiagnosis.js` (unit-tested directly),
from the agents-table row plus in-memory evidence the WS hub
(`src/ws/agentSocket.js`) tracks per agent:

| State | Meaning / evidence | Fix lives |
| --- | --- | --- |
| `connected` | Live socket(s) open. | — |
| `license-blocked` | A *valid* token was refused by the license gate within the last 10 min (license invalid or agent limit reached). The agent keeps retrying and connects by itself once capacity allows. | **Server** (the only server-side-fixable cause) |
| `auth-rejected` | Recent 401 handshakes from the agent's last-known IP. The agent PAUSES (stops measuring) and re-dials on a long timer — 15 min by default — so a token the server starts accepting again brings it back by itself. It never re-enrolls on its own. | Server, then it recovers |
| `reconnecting` | Dropped < 90 s ago — inside the agent's backoff window; it should be back on its own. | Wait |
| `unreachable` | Offline past the grace window with no connection attempts seen since: process stopped, host down, or network path blocked. | Agent host |
| `never-connected` | Enrolled but never dialed in. | Agent host |

Evidence tracked by the hub: last session (peer IP, connect/disconnect times,
close code), last license rejection per agent, and a bounded ring of recent
anonymous 401 attempts (attributed to an agent by matching its last-known IP).
All of it is **in-memory** and resets on a server restart — the diagnosis says
so rather than overclaiming.

## What the agent does to stay connected

The server explains a disconnection; the agent is what has to come back. Four
things on the agent side (all in `blueeye-agent/src/agentClient.js` unless said
otherwise), because each of them was once a way for a fleet to go dark with no
way in from here:

- **A dead connection is noticed.** The heartbeat is a SEND, and a send says
  nothing about whether anything is still listening. Every heartbeat now also
  sends a WebSocket ping, and anything arriving from the server refreshes a
  deadline (`BLUEEYE_STALE_CONNECTION_MS`, default 3 × heartbeat = 45 s).
  Nothing for that long on an open socket = terminate and re-dial. Without it a
  half-open TCP connection — a NAT entry that expired, a firewall that stopped
  forwarding, a load balancer that went away — left the agent believing it was
  connected until the kernel gave up retransmitting, which on Linux is 10–15
  minutes of a green badge on an agent that is taking no commands. TCP keepalive
  (`BLUEEYE_SOCKET_KEEPALIVE_MS`, default 30 s) is set on the socket as well.
- **A refused token is not the end.** A 401 used to be terminal: the agent
  exited, systemd hit its start limit and gave up, and the unit stayed dead until
  someone logged into the host. A revoked token deserves that; a server restored
  from backup, a re-provisioned server or a half-finished token rotation does
  not — and those take the whole fleet at once. The agent now pauses and re-dials
  every `BLUEEYE_AUTH_RETRY_MS` (default 15 min), and resumes when the token is
  accepted again. It still never re-enrolls by itself. The systemd unit dropped
  its `StartLimitBurst` for the same reason and uses `Restart=always`.
- **More than one way in.** `BLUEEYE_SERVER_URLS` lists alternative URLs for the
  same server, tried in order when a connection cannot be ESTABLISHED (a
  connection that opened and later dropped, or one that answered 401, says
  nothing bad about the URL). REST follows the live channel, so a failover moves
  the whole agent. Certificate pinning takes a LIST
  (`BLUEEYE_SERVER_CERT_FINGERPRINT`, comma-separated): a pin is to one leaf
  certificate, so holding the next certificate's fingerprint alongside the
  current one is what keeps a renewal from locking every pinned agent out of the
  only channel that could fix it.
- **Measurements survive a short outage.** A reading is taken at a moment that
  does not come back, so a failed submit is spooled and re-sent, oldest first, on
  the next attempt that gets through (`BLUEEYE_RESULT_SPOOL_MAX`, default 240
  batches, oldest dropped). What is waiting shows in the agent's Diagnose
  snapshot (`spool`), which is the difference between "this agent stopped
  measuring" and "this agent cannot get its measurements to me".

## Offline detection, and "agent dead or network down?"

The connection diagnosis above answers "why can't the server hear it" from the
server's own socket. `src/health/agentOfflineMonitor.js` (a background job, every
`AGENT_OFFLINE_SWEEP_MS`, default 60 s) goes further:

1. **Stale sweep.** An agent marked `online` but silent past
   `AGENT_STALE_OFFLINE_SEC` (default 300, floor 120) is flipped `offline` — the
   same rule the startup reconcile runs, now at runtime too, so a WS close the
   server never saw (half-open TCP) no longer leaves a green badge on a dead
   agent. Agents with a live socket on this process are never flipped. Each flip
   is audited (`agent.offline`) and pushed to the dashboard like a real close.
2. **One finding per offline episode.** Offline continuously for
   `AGENT_OFFLINE_GRACE_MINUTES` (default 5) → ONE `agent.offline` finding
   (kind `THRESHOLD`), through the same store → dashboard → event case →
   alerting → integrations path as probe findings. Maintenance windows silence
   the notification (the dispatcher's silencer), never the finding. An episode is
   keyed by `last_seen`; dedup is durable (a finding already stored since the
   episode began is not raised again after a restart). Agents silent longer than
   `AGENT_OFFLINE_MAX_AGE_HOURS` (default 24) are treated as abandoned — no
   finding — so an upgrade does not page for every long-dead agent.
3. **Reconnect.** When the agent is back, the event case its finding opened is
   resolved (audited as `event_auto_resolve`) — only when nothing else joined the
   case. The finding stays as the record of the outage. This bookkeeping is
   in-memory: a case whose agent came back while the server was down is left to
   the operator.

The finding's explanation and `evidence[0]` carry an explainable verdict from the
pure `src/health/agentOffline.js`, with every check and its result:

| Check | Data | Result → meaning |
| --- | --- | --- |
| `site` | other agents with the same `location_id` | `all_offline` → site/uplink outage likely · `peers_online` → local to this host |
| `peer_probes` | other agents' ping/TCP/HTTP probes to this agent's `capabilities.ips` (+ hostname) since it went offline; path_mtu/tls/rdns excluded | `reachable` → host up, agent process down · `unreachable` → host gone |
| `switch_port` | IP → MAC from other hosts' ARP tables → access port in `fdb_entries` (fewest MACs) → `device_interfaces.oper_status` (only a poll newer than the outage counts) + newest `link.down`/`link.up` device event for the port | `down` → "switch port sw/port is down" (strongest) |
| `connection` | the diagnosis above | `rejected` (license/token) → alive and reaching the server: not a network fault |

Verdicts, strongest evidence first: `rejected_by_server`, `switch_port_down`,
`site_outage` (CRIT), `agent_process_down`, `host_unreachable`,
`host_or_access_link`, `unknown`. Any check without data is `unknown` and says
why. The changes feed puts the verdict on the finding/event row
(`offlineVerdict`), and the connection modal shows it (below).

## Dashboard

On **Agents**, the status badge is clickable: it opens the connection modal
with the verdict, the "what to do" hints, the evidence, a **Re-check** button,
and — for connected agents, operator+ — **Force reconnect**. For an offline
agent whose current episode has an `agent.offline` finding, the modal also shows
the dead-agent vs network-down verdict and its checks (`ag.offline.*` keys).

## Testing

- `test/connectionDiagnosis.test.js` — the pure verdict logic.
- `test/agentConnection.test.js` — both routes (roles, 404/400/409/503).
- `test/agentSocket.test.js` — evidence tracking + `disconnectAgent()` +
  `connectedAgentIds()` against a real WebSocket server.
- `test/agentOffline.test.js` — the pure dead-agent vs network-down verdict.
- `test/agentOfflineMonitor.test.js` — sweep, grace, one finding per episode,
  evidence gathering, reconnect resolve.
- In **blueeye-agent**: `test/connectionResilience.test.js` — the stale-read
  timer, the keepalive, the non-fatal 401 and the URL failover, against the real
  client with a fake socket; `test/resultSpool.test.js` — the offline spool.
