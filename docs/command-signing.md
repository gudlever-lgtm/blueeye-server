# Signing the privileged agent commands

Four of the commands this server pushes down `/ws/agent` change the **host**
rather than measure it: `update` (rebuild and restart onto new code), `delete`
(wipe the token and remove the agent), `install-tool` and `rekey` (replace the
release trust anchor). Authenticated by the WebSocket session alone, anything
that reaches a live agent socket can reconfigure or wipe the host.

So the server signs them with the managed **release key** — the same key that
signs releases — and the agent verifies against the key it already pins
(`blueeye-agent src/commandAuth.js`). `src/services/commandSigner.js` is the one
place that signs; `routes/agents/_context.js` exposes it as `signCommand`, and
every privileged path goes through it.

## What is signed

The canonical bytes of the command, minus `commandSignature` and minus the
transport correlation `id` (stamped on at send time, carries no authority). The
signer adds four fields before signing:

| field | why |
| --- | --- |
| `agentId` | binds the signature to one agent — a captured command cannot be replayed across the fleet |
| `commandId` | a UUID nonce — the agent remembers the ids it carried out and refuses a second delivery, so a captured command cannot be replayed at the **same** agent inside its window |
| `issuedAt` | when it was made; the agent tolerates ±5 min of clock skew |
| `expiresAt` | `issuedAt + 120 s`, stated explicitly instead of left to whatever window the agent happens to allow |

All four are inside the signature, so none can be edited in flight. The agent
checks `expiresAt` **in addition to** its own skew window, never instead of it:
a server asking for a week does not get one.

A signed command with no `commandId` is **refused** by the agent. A server old
enough not to send one is old enough not to sign at all, and its unsigned
commands still follow the lenient/strict policy below — accepting a signed one
without a nonce would silently drop exactly the protection the nonce exists for.

## Fail closed

`sign()` **throws** rather than returning an unsigned command:

| situation | outcome |
| --- | --- |
| the key signs | signed command sent |
| signing throws (key unreadable, HSM gone, …) | `CommandSigningError` → HTTP **503**, nothing sent, audit row `agent.command-signing-failed` |
| no managed signing key at all | sent unsigned (a deployment that never had the signature, not one losing it) — the agent's own ratchet decides whether to accept it |
| no managed signing key, `BLUEEYE_REQUIRE_COMMAND_SIGNING=1` | refused, same 503 |

The earlier behaviour — warn and send it unsigned — was a downgrade an attacker
could reach for: break the signer and every agent that has not yet latched
accepts socket-only authority again.

Where a refusal lands:

- **single-agent routes** (`POST /agents/:id/update|delete|install-tool|rekey`):
  503 with the reason, via `middleware/errorHandler` (which honours `statusCode`
  + `expose` on a 5xx);
- **fleet rollout**: that one target gets `outcome: 'refused'` and its audit row
  is marked failed; the rest of the batch still moves;
- **queued command delivered on connect**: stays queued, logged — it is signed at
  delivery, not at enqueue, because a signature made when the operator clicked
  would be outside the freshness window by the time the host dials in;
- **agent-requested self-update**: `sign-failed` on the ack.

## The agent's side of the contract

The ratchet, the strict/lenient policy and why `rekey` is strict by default are
documented in `blueeye-agent PROTOCOL.md` ("Command authenticity") and in the
long comments in `blueeye-agent src/commandAuth.js`. Short version: leniency is
dropped the first time this server proves it can sign, and never returns.

## Residual risk

Signing proves *this server* asked. It does not help against a server that is
itself compromised — that server holds the signing key and can sign whatever it
likes. What it cannot do is re-anchor the fleet's trust: a `rekey` to a new key
needs a **vendor-signed** licence proof (`docs/agent-trust.md` in
blueeye-licens), and once an agent has accepted one, nothing but another vendor
authorisation is accepted again. So a compromised on-prem server can misuse the
authority it already has, but cannot make itself a permanent new trust anchor.
