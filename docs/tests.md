# Test packages

Server-defined sets of tests ("test packages") that the server pushes to agents
to run, on a schedule or on demand. They reuse the existing agent command
channel — there is **no new agent capability**: each item becomes a `run-probe`
or `run-test` command, the agent executes it and reports back through the normal
endpoints, so results appear on the **Probes** and **Traffic** pages as usual.

Managed from the **Tests** tab in the dashboard.

## Model

A package (`test_packages`, migration 017) has:

- **name**
- **enabled** — disabled packages are never scheduled (you can still "Run now").
- **schedule_ms** — `0` = manual only; otherwise an interval (floor 30s, max 24h).
  The schedule applies to *every* target agent in the package; for different
  cadences on different agents, create separate packages.
- **targets** — `{ mode: 'all' | 'agents' | 'location', agentIds, locationIds }`.
- **items** — an array of:
  - `{ type: 'probe', probe: { type, host, port?, count?, maxHops? } }` — validated
    by `validateProbeSpec` (ping / tcp / dns / traceroute), or
  - `{ type: 'run-test', intervalMs? }` — a traffic/throughput snapshot.

## Running

`testPackageRunner.run(pkg)` resolves the target agent ids from the selector,
maps each item to a command and calls `agentCommander.sendCommand` for every
(agent, item). Only **connected** agents receive a command — `sendCommand`
returns 0 for an offline agent, counted as "not reached". The run summary
(`{ at, targeted, reached, delivered, items }`) is stored on the package
(`last_run_at` / `last_run_summary`).

`testPackageScheduler` ticks every 15s, loads enabled+scheduled packages and runs
those whose interval has elapsed. Last-run times are kept in memory but seeded
from the persisted `last_run_at`, so a restart does not immediately re-run
everything. A scheduled run only reaches agents connected at that moment;
offline agents pick up the next run when they reconnect.

## API

All under `/api/test-packages` (user JWT; viewer reads, operator/admin writes):

| Method | Path        | Role        | Purpose                          |
| ------ | ----------- | ----------- | -------------------------------- |
| GET    | `/`         | viewer+     | list packages                    |
| GET    | `/:id`      | viewer+     | one package                      |
| POST   | `/`         | operator+   | create                           |
| PUT    | `/:id`      | operator+   | update                           |
| DELETE | `/:id`      | operator+   | delete                           |
| POST   | `/:id/run`  | operator+   | run now (returns the run summary)|

## Privacy

Metadata only: probe targets and timings, traffic byte/packet counts — never
payload, consistent with the rest of BlueEye. Predefined templates use neutral
targets (e.g. Quad9 `9.9.9.9`, `example.com`).
