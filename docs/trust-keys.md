# Trust keys — the two that must never change

Two Ed25519 public keys decide whether an agent will ever accept anything from
this server again.

| Kind | Where it lives | What it does |
| --- | --- | --- |
| `license` | `src/license/publicKey.js` (embedded), mirrored in `blueeye-agent/src/license/vendorRoot.js` | Every licence proof from **blueeye-licens** is verified against it. Inside that proof the vendor names the key fingerprint this server is authorised to sign with — which is how an agent learns what to trust without taking this server's word for it. |
| `agent_release` | `agent_release_key` (generated here, private half encrypted at rest) | Signs agent releases and privileged commands. Every installed agent **pins its fingerprint** and refuses anything signed by another key. |

Neither is meant to change. Ever.

## Why this needed its own guard

Both keys were already used correctly. What nothing watched was whether they are
the **same ones as yesterday**.

A key change breaks nothing here. The server boots. The dashboard loads.
Enrollment codes still generate. The damage lands on the agents, one at a time,
the next time each is asked to take an update — as `signature did not verify` in
a log on a host nobody is looking at. By the time somebody notices, the change is
weeks old and nobody remembers making it.

So the fingerprints are recorded (`trust_key_identity`, migration 140), compared
on every boot, and a difference is stated in the loudest terms the product has.

## What it does, and what it deliberately does not

**It warns. It never blocks.** An admin recovering a server from backup, or
deliberately rotating after a compromise, is doing the right thing and must not
be locked out by the alarm about it — the same reasoning that keeps a `401` from
being terminal on the agent side. What the guard owes that admin is the number of
agents about to go deaf, not a closed door.

On drift you get, all carrying the same sentence:

* a boxed `TRUST KEY CHANGED` block in the server log at startup;
* an `audit_events` row (`trust_key_changed`) that dates it;
* a red banner above **every** dashboard view — a key that moved is not a
  property of the page you happen to be on;
* the count of agents that have the old key pinned.

## The count

Agents from 0.28 report `capabilities.releaseKeyFingerprint` — the key they
actually pinned. `agentsRepository.countByReleaseKeyFingerprint()` buckets the
fleet against the current and previous fingerprints:

```json
{ "total": 52, "pinnedToCurrent": 0, "pinnedToPrevious": 47, "pinnedToOther": 0, "unknown": 5 }
```

Older agents report nothing and are counted as `unknown`, never as matching. A
guess in the reassuring direction is the wrong guess to make here: it would
understate how many hosts the change is about to strand.

## States

`src/license/keyIdentity.js` is a pure decision plus a thin service over the
repository. The states, and why each one exists:

| State | Meaning | Alarm? |
| --- | --- | --- |
| `absent` | Nothing configured, nothing recorded. A fresh server before its key is generated looks exactly like this. | no |
| `first` | First sighting. Nothing to have changed from. | no |
| `unchanged` | The normal answer, on every boot, forever. | no |
| `changed` | The fingerprint differs from the recorded one. | **yes** |
| `cleared` | Something was recorded and there is nothing now — the key was deleted. From an agent's point of view this is the same event as `changed`. | **yes** |
| `restored` | Back to the last real key this server held, after a spell with none. The fleet's pins are valid again. | no |

A deleted key is stored as `CLEARED_FINGERPRINT` (64 zeroes — a value no SHA-256
of a real PEM produces), with the real key kept in `previous_fingerprint`. Two
consequences, both deliberate:

* Booting again does not look like a second change, so `change_count` does not
  inflate and an acknowledged deletion does not re-alarm on every restart.
* **Delete-then-generate is judged against the last real key**, so it reads as a
  change — which is exactly what the fleet experiences. Comparing the new key
  against the sentinel would have read as a harmless first sighting.

## Acknowledgement

`POST /system/trust-keys/:kind/acknowledge` (admin) records that somebody meant
to do this. It is stored **against the fingerprint**, not as a boolean, so it
silences today's change and nothing else — the next one is loud again.

The change itself stays on the record (`drift` remains true); only
`unacknowledgedDrift` clears. The banner is what goes away.

## API

| Route | Role | Notes |
| --- | --- | --- |
| `GET /system/trust-keys` | viewer+ | Both kinds, always. A fingerprint is a public value — it is served unauthenticated at `/enroll/agent-release-key` — and the whole point is that nobody has to be an admin to notice the fleet is about to go deaf. Answers `available:false` when the guard is not wired, rather than a reassuring "no drift" nobody checked for. |
| `POST /system/trust-keys/:kind/acknowledge` | admin | `400` unknown kind · `404` nothing in drift for that kind · `503` monitoring not wired. |

## Getting out of it

A changed **agent signing key** is recoverable from the dashboard: Fleet → the
agent → **Re-pin**, which sends the new key over the agent's own connection. No
shell on the host, no re-install. Agents too old for `rekey` (< 0.28) need the
`/enroll/repin.sh` one-liner instead; the dialog shows it.

A changed **licence trust anchor** is not something an on-prem admin fixes — it
is the vendor's key, embedded in both this server and every agent. If it has
moved, the builds on the two sides disagree and the fleet needs the matching
agent version.

## Related

* [updates.md](updates.md) — how updates reach agents, and what the signed proof
  carries.
* [licensing.md](licensing.md) — the proof itself, and the trust-anchor guard
  that stops an operator overriding the vendor key in production.
* [security-hardening.md](security-hardening.md) — the rest of the surface.
