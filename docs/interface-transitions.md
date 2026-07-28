# Interface state transitions

"Did the link go down, and when?" is the question a technician asks most. Until
migration 075 this server could not answer it.

## The problem

Interfaces are **not a persisted entity** here. Interface health is computed on
the fly from `results.payload.traffic` by `src/health/interfaceHealth.js`, so
only the *current* state ever existed. The changes landing page could report
agent up/down and topology link changes, but not the one dimension in between.

## Why not just poll

Reconstructing the history by polling current state was explicitly ruled out. A
poller sees whatever state happens to be true at the moment it looks, misses
everything between two looks, and stamps what it finds with the *poll* time
rather than the *event* time. The result is a change log that quietly lies about
when things happened — worse than no log, because people trust it.

Instead, transitions are recorded **at the results-ingest seam**
(`POST /agents/results`), the one place that sees every observation, where state
is already being determined.

## Two tables

Mirrors the `lldp_neighbors` + `topology_changes` pair (migrations 063/067) that
solves the identical problem for L2 links.

| Table | Role |
| --- | --- |
| `interface_states` | Current known state per `(agent, iface)`. Upserted on every report. Exists **only** to diff against. |
| `interface_state_transitions` | One row per actual change. The history. |

A snapshot table rather than "read the latest transition", because an interface
that never changes would have its last transition aged out by retention — and we
would then re-announce its state as a change the next time it was seen.

## What is and is not a transition

| Situation | Recorded? |
| --- | --- |
| Status changed (`ok`→`down`, `warn`→`bad`, …) | ✅ |
| First sighting, already unhealthy | ✅ (`from_status` NULL) |
| First sighting, healthy | ❌ — announcing every interface on every new agent would bury the real changes on enrolment day |
| Interface **disappeared** from a report | ❌ — see below |
| No change | ❌ (the snapshot's `last_seen` still moves) |

**A disappeared interface is not reported.** An interface missing from one report
is far more often a collection hiccup — an SNMP timeout, a truncated payload —
than an interface that ceased to exist, and "eth0 vanished" is an alarming thing
to say wrongly. Its stored state simply stops being refreshed and ages out.

## Severity

| Transition | Severity | Why |
| --- | --- | --- |
| → `down` on a real NIC | `CRIT` | usually the thing being looked for |
| → `down` on a **virtual** iface | `INFO` | docker0/veth/tun are routinely down because they are idle; treating that as an outage makes the feed unreadable every time a container exits |
| → `bad` / `warn` | `WARN` | errors, discards, saturation |
| → `ok` (recovery) | `INFO` | good news is never surfaced at the severity of the fault it ended |

Virtual-interface detection reuses `isVirtual()` from `interfaceHealth.js` — one
list of patterns, not two.

## Flap suppression

An interface bouncing every 20 seconds is the classic intermittent fault. It is
also the classic way to fill a change feed with 400 rows nobody reads.

A transition that **reverses** a recent one (within
`INTERFACE_FLAP_WINDOW_SECONDS`, default 300) collapses onto the earlier row as
`flapping` with a bumped `flap_count`, and the summary becomes
`eth0 link went down (flapping 14×)`.

Once a row is marked flapping, **every** further transition on that interface in
the window collapses onto it — not only reversals. A collapsed row keeps
describing the first direction it saw (`ok→down`), so the third bounce
(`ok→down` again) does not reverse it and would otherwise open a second row, then
a third. This was a real bug caught by the flap test.

The signal is preserved and arguably sharpened: "flapping 14×" *is* the finding.

## Best-effort

The service can never cost an agent its results report. A failure in the diff,
the flap lookup or the write is logged and swallowed; the ingest still returns
`201`. A deployment that has not run migration 075 has no service wired at all
and the seam is inert.

## Retention

`RETENTION_INTERFACE_TRANSITION_DAYS`, default **90** — long enough to cover an
investigation spanning several shifts, which is the point of recording them. The
same cutoff purges `interface_states` rows whose `last_seen` has not moved, i.e.
interfaces that stopped being reported entirely.

## In the changes feed

Transitions appear as `kind: 'interface_state'`, `source: 'interface'`, with
`currentState: false` — they are real transitions with a real timestamp, unlike
the heartbeat/version-skew rows. A failure of this source degrades the feed to
`partial` rather than emptying it.

## Files

- Migration `migrations/075_create_interface_states.sql`
- Pure diff `src/health/interfaceStateDiff.js` (`diffInterfaceStates`, `severityFor`, `isReversal`, `isWorsening`)
- Service `src/health/interfaceStateService.js` (ingest seam + flap collapse)
- Repository `src/repositories/interfaceStatesRepository.js`
- Seam — `src/routes/agentReports.js` (`POST /results`)
- Feed mapper — `fromInterfaceTransitions` in `src/changes/changeFeed.js`
- Retention — `src/analysis/retention/{config,repo,purge}.js`
- Fake `makeInterfaceStatesRepo` in `test-support/fakes.js`
- Tests `test/interfaceState.test.js`
