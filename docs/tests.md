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
  - `{ type: 'run-test', intervalMs? }` — a passive traffic/throughput snapshot.
  - `{ type: 'speedtest', bytes? }` — an active download+upload speed test against
    the server (see below).

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

## Speed test (active throughput)

A self-contained download/upload test between the agent and **this** server — no
external speed-test service, so it works on air-gapped networks.

- `GET /speedtest/download?bytes=N` and `POST /speedtest/upload` (agent token)
  transfer synthetic zero-filled bytes (capped at 200 MB); the agent times each
  to compute Mbps.
- The agent posts the result to `POST /speedtest/results`; read it back via
  `GET /api/speedtest?agentId=&limit=` (viewer+). Stored in `speedtest_results`
  (migration 018).
- Trigger on demand with `POST /agents/:id/run-speedtest` (operator+) or add a
  `speedtest` item to a package. The dashboard shows results in the **Speed**
  modal on each agent row.

### Throughput in the health verdict

The latest speed test is surfaced on the **Overview** (a Speed column) and the
agent page. It is also folded into the agent's health verdict — like loss /
latency / interface — when an admin sets a floor under **Settings → Analysis →
Throughput (speed-test) health** (`down/up WARN/CRITICAL Mbps`; `0` = that floor
is off). Thresholds are opt-in and persisted via `app_settings` (key
`throughput`); the fleet route reads the latest speed test per agent
(`speedtest_results.latestPerAgent`) and `settingsService.getThroughput()`.
Below a floor (or a failed test) the agent reads WARNING/CRITICAL with a reason
like "Download 12 Mbps (below 50)."

## Privacy

Metadata only: probe targets and timings, traffic byte/packet counts, speed-test
byte counts and rates — never payload, consistent with the rest of BlueEye.
Predefined templates use neutral targets (e.g. Quad9 `9.9.9.9`, `example.com`);
the speed test talks only to the BlueEye server itself.
