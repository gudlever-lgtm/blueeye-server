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
    by `validateProbeSpec` (ping / tcp / dns / traceroute / tcptraceroute / http / curl). A `curl`
    probe takes a URL plus optional content expectations
    (`method`, `expectStatus`, `expectBody` substring or `/regex/`, `expectHeader`,
    `minBytes`/`maxBytes`) and verifies the received traffic — the agent inspects
    the body locally but reports only metadata (status, byte count, content-type,
    pass/fail), never the body. Or
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
byte counts and rates — never payload, consistent with the rest of BlueEyes.
Predefined templates use neutral targets (e.g. Quad9 `9.9.9.9`, `example.com`);
the speed test talks only to the BlueEyes server itself.

## Automated test suite: realistic fixtures

(Not the Test-packages feature above — this is about `npm test`.) Most
endpoint tests build their bodies by hand. The ones below use data that was
not written for this codebase, so a validator that disagrees with what a real
agent sends fails in CI rather than on a customer's switch:

| Test | Fixture | What it is |
| --- | --- | --- |
| `test/snmpRealPayloads.test.js` | `test/fixtures/snmp-real/*.json` | The exact `POST /agents/me/snmp-topology` and `/agents/me/snmp-counters` bodies blueeye-agent produces for an HPE ProCurve 6120XG and a Cisco Catalyst 3750, from snmpsim recordings of those switches (BSD 2-Clause, snmpsim-data). Posted through the real routes and ingest over the fakes. |

The fixture README says how they were generated and how to regenerate them
from the agent. Two things they caught: the ProCurve names two interfaces
`lo0` and ports are keyed by name, so one is lost (pinned as a known gap in the
test), and the agent read Counter64 values above 2^47 256× low (fixed in the
agent).

The agent carries the rest of the realistic data — raw hsflowd sFlow
datagrams, Net-SNMP `snmptrap` v1/v2c/v3 traps, logger/rsyslog and
vendor-published Cisco/Junos syslog lines, and the snmpsim recordings
themselves — under blueeye-agent `test/fixtures/{sflow,traps,syslog,snmprec}/`,
each with a README naming the source, version, date and licence.

## Route sweep against the real database (`npm run verify-routes`)

`scripts/verify-routes-against-mysql.js` is the third MySQL job in
`.github/workflows/schema.yml`, after `verify-schema` and `verify-repositories`.
Those two check the schema and individual repositories; this one boots the
**whole wired app** — `node src/server.js`, `NODE_ENV=production` — against a
scratch database and asks two questions no fake can answer:

1. **Does any route answer 500** (or 502/503/504 that is not allow-listed), a
   non-JSON body where JSON is expected, or a body carrying a stack trace, a
   MySQL error code, SQL text, a server file path or the database name/address?
2. **Does agent ingest land?** After an enrolled agent has reported, every table
   each `/agents/*` ingest path should write must have rows.

```
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret npm run verify-routes
```

It needs a MySQL it may create and drop databases on. Exit code 0 = green,
1 = a failure was found, 2 = the run could not start. Knobs:
`VERIFY_ROUTES_KEEP=1` keeps the scratch database and working directory,
`VERIFY_ROUTES_ONLY=<substring>` sweeps only matching route paths,
`VERIFY_ROUTES_TRACE=<substring>` prints every matching call with its status,
`VERIFY_ROUTES_VERBOSE=1` prints failures as they happen.

**How it runs**

- *Database*: a `be_routes_*` scratch database, migrated with `src/migrate.js`
  (the admin is seeded with a generated password the script knows), dropped
  at the end whatever happened.
- *Licence*: a stand-in blueeye-licens on a local port signs a `valid:true`
  proof with every feature on (`LICENSE_PUBLIC_KEY` +
  `TRUST_ANCHOR_OVERRIDE_ACK`), so the real licence manager unlocks every route.
- *Server*: spawned from a scratch working directory with a minimal, explicit
  environment — nothing from the caller's shell (an SMTP host, a webhook URL, an
  LLM key) reaches it, and every outbound default (geocoder, GeoIP source,
  assistant) points at a closed local port. Analysis, alerting (no channel
  configured), geo (a three-range offline CSV) and retention (first run 5 s after
  boot) are on; active discovery is off. A preload
  (`scripts/verify-routes/route-dump-preload.js`) writes the live app's route
  table when it starts listening — the production route list, not the fake
  app's. Every request carries its own `X-Request-Id`, so a server log line is
  traced to the exact call.
- *Seed*: through the public API — users (operator, viewer, a throwaway),
  locations, enrollment codes and two enrolled agents, SNMP profiles and
  devices, thresholds, severity rules, runbooks, test packages, transaction
  tests, report schedules, integrations, API tokens, LDAP/OIDC/SAML role maps,
  the NIS2 register (risks, controls, incidents, reports, evidence), Service
  Assurance applications/environments/credentials/tests/journeys/monitors/
  schedules/recordings, a diagnosis, an investigation, a burst run and the
  signing key. Rows no endpoint creates on demand (cross-agent clusters and
  their evidence, remediation playbooks, Service Assurance healing/suggestions/
  baselines — those come from jobs or the browser worker) are inserted directly.
  Hosts are `.invalid` names or TEST-NET addresses, so a background job that
  does reach for one goes nowhere.
- *Ingest*: agent payloads shaped by blueeye-agent `PROTOCOL.md`
  (`scripts/verify-routes/fixtures.js`): capabilities twice (ARP, connection
  table, NIC, IPs, an LLDP set that changes), proc traffic with an interface
  going down, sFlow flows, one probe result of every type (traceroute hops with
  ECMP `ips`, DNS `errorCode`, TCP `failure`, DHCP offers, path MTU, TLS, rDNS, a
  failing ping history, an expiring certificate), two SNMP topology cycles (a
  port down, a MAC move, a swapped neighbour, CDP, VLANs, ARP, ENTITY inventory,
  a poll error for the second switch), two counter snapshots, syslog + trap
  device events, discovery candidates, a speed test, and a WebSocket session
  with `transaction_result`, `sflow.status` and `agent.error` frames. The data
  check then prints *ingest path → table → rows*; a required table that is empty
  fails the run, a table that does not exist yet is skipped with a note.
- *Sweep*: every route × admin, operator, viewer, no auth and the agent token.
  Path parameters get a real id (the primary row for reads, the throwaway row
  for writes), `999999`, `abc`, and for string parameters a traversal-shaped
  value. GETs run with no query and with a default one (route-specific where a
  route requires parameters). Writes get `{}`, `{x:{y:1}}` and — for the routes
  listed in `validBodies()` — a minimal valid body. Reads run first, then
  writes, then deletes, so destruction only ever hits what comes after it. A
  throwaway agent stays connected over `/ws/agent` for the whole sweep and
  acknowledges-but-declines every command like a Docker-managed agent, so the
  command routes run their real paths without anything executing. After every
  2xx write the three user sessions are checked, and a session the sweep took
  away is logged and re-established.
- *Log scan*: the server's own output is scanned for `ERROR`, `ER_*`, MySQL error
  texts, `TypeError`/`ReferenceError`/`Unhandled`; lines about the optional
  services this run deliberately leaves unconfigured are classified benign.

**Policy lives in the script, deliberately.** `SKIP` lists the routes never
called and why (each reaches outside the process: mail, LLM, IdP, geocoder,
crawler, the host update command). `ALLOWED_5XX` is where a documented
feature-off 503 goes, with its reason. `DISCLOSURE_ALLOWED` names the few admin
screens whose job is to show a path or the database name. The summary also lists
**coverage gaps** — routes that never answered 2xx to anyone, whose happy path
therefore was not exercised — so "no 500" is never read as more than it is.
Extend these deliberately, like the gate's allowlists; never loosen a check to
get green.
