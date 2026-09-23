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
| `auth-rejected` | Recent 401 handshakes from the agent's last-known IP. The agent treats a 401 as fatal and stops retrying until restarted; a revoked token needs re-enrollment. | Agent host |
| `reconnecting` | Dropped < 90 s ago — inside the agent's backoff window; it should be back on its own. | Wait |
| `unreachable` | Offline past the grace window with no connection attempts seen since: process stopped, host down, or network path blocked. | Agent host |
| `never-connected` | Enrolled but never dialed in. | Agent host |

Evidence tracked by the hub: last session (peer IP, connect/disconnect times,
close code), last license rejection per agent, and a bounded ring of recent
anonymous 401 attempts (attributed to an agent by matching its last-known IP).
All of it is **in-memory** and resets on a server restart — the diagnosis says
so rather than overclaiming.

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
