# Topology change detection

Detects and records LLDP/CDP topology changes between poll cycles. Each agent
capabilities report is a "poll": the reported neighbour set is diffed against the
agent's previous snapshot (`lldp_neighbors`), and the differences become change
records — reusing the target-timeline event shape, and written to the
hash-chained audit log as evidence.

## Change types

| Type                 | Trigger                                                        |
| -------------------- | ------------------------------------------------------------- |
| `neighbour_added`    | An edge present in the report but not the previous snapshot.  |
| `neighbour_removed`  | An edge in the previous snapshot but not the report.          |
| `link_state_changed` | Same edge, different `link_state` (requires agents to report it). |
| `port_moved`         | The same `remote_chassis_id` seen on a different `local_port`. |
| `flapping`           | A change that reverts within the flap window (see below).     |

## Flap suppression

A change reverting within `TOPOLOGY_FLAP_WINDOW_SECONDS` (default 300) collapses
the pair into a **single `flapping` record** — the discrete change is rewritten
in place rather than emitting a new row. Sustained flapping on the same edge
stays one record (it is refreshed, not duplicated). Window boundary is inclusive
(a revert at exactly the window collapses; just past it does not).

## Where changes surface

Change records reuse the **target-timeline event shape** — there is no second
changes format:

```
{ timestamp, source: 'topology', type: 'topology.<change_type>', severity, summary, ref_id }
```

- **Device activity timeline** — `GET /api/targets/:id/timeline` merges topology
  changes with findings/events/agent events (source `topology`, rendered
  "Topology change").
- **Dedicated feed** — `GET /api/topology/changes` (operator+, `?host=<agentId>`):
  400 invalid, 404 unknown host, 500 on store failure.
- **Audit evidence** — each change is written to the hash-chained `audit_log`
  (category `topology`, action `topology_<change_type>`, `actorRole: 'system'`,
  no actor user) via the fail-safe compliance logger, so it is tamper-evident
  (`GET /api/audit-log/verify`).

## Data model & flow

- Migration 067 adds `topology_changes` (the change records) and a nullable
  `link_state` column to `lldp_neighbors` (so a previous snapshot can carry state
  to diff against; NULL when the agent doesn't report it).
- Diff seam is at ingest: `POST /agents/me/capabilities` runs
  `topologyChangeService.processReport(agentId, capabilities.lldp)` **before** the
  existing upsert (the diff must see the old rows first), then reconciles removed/
  moved edges so they don't re-emit next poll.
- Pure diff `src/topology/topologyDiff.js`; service (flap-collapse + persist +
  audit + reconcile) `src/topology/topologyChangeService.js`; repo
  `src/repositories/topologyChangesRepository.js`; timeline source in
  `src/timeline/targetTimeline.js`.

## Where the neighbours come from

- **Agent-local LLDP** (agent v0.39.0+): when `lldpd` is installed on the host,
  the agent reads `lldpctl -f json` and sends `capabilities.lldp` (+
  `lldpChassisId`) with every capabilities report — at start, on reconnect and
  every 5 minutes (`BLUEEYE_CAPABILITIES_INTERVAL_MS`). Without lldpd the field is
  omitted (never sent as `[]`, which would read as "every neighbour removed") and
  `capabilities.unavailable.lldp` says why.
- `link_state_changed` uses the per-neighbour `linkState` the agent derives from
  `/sys/class/net/<if>/operstate`.
- Switch-side LLDP learnt over SNMP (`snmp_neighbors`) is diffed on each SNMP
  topology ingest (`topologyChangeService.processDeviceSnapshot`, migration 118):
  the switch's neighbours from its previous poll against this one, with the same
  change types, flap collapse and audit evidence. Those rows carry `device_id`
  (the switch) beside `agent_id` (the agent that polled it), and their summary
  names the switch. The **first** snapshot of a switch is a baseline and emits
  nothing, and an **empty** table is not read as "every neighbour left" (a walk
  that timed out, or LLDP turned off, reports nothing too). The agent-LLDP flap
  lookup ignores device rows, and the device lookup ignores agent rows.
