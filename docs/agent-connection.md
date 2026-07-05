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

## Dashboard

On **Agents**, the status badge is clickable: it opens the connection modal
with the verdict, the "what to do" hints, the evidence, a **Re-check** button,
and — for connected agents, operator+ — **Force reconnect**.

## Testing

- `test/connectionDiagnosis.test.js` — the pure verdict logic.
- `test/agentConnection.test.js` — both routes (roles, 404/400/409/503).
- `test/agentSocket.test.js` — evidence tracking + `disconnectAgent()` against
  a real WebSocket server.
