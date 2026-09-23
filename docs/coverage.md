# Coverage gaps

"Which parts of the network do I **not** see?" Every other screen answers a
question about what BlueEyes can see. This one lists where it is blind — a site
with no agent, a switch nothing polls, an unmanaged switch in the path, a /24
the ARP tables keep mentioning that no agent sits in — with the evidence for
each and a suggested next step.

- API: `GET /api/coverage` (admin) — `src/routes/coverage.js`
- Rules (pure): `src/coverage/coverageGaps.js`
- Gathering (I/O): `src/coverage/coverageService.js`
- UI: **Administration → Coverage gaps** (`/coverage`, `public/views/coverage.js`),
  linked from **Settings → Setup**. Strings under `coverage.*` in `public/i18n.js`.
- No migrations, no tables of its own.

## Principles

**Computed, never ticked.** Every gap is derived from what the database already
holds, like the setup checklist (`src/services/setupChecklist.js`).
A list somebody maintains by hand starts lying the day the network changes.

**"No gaps" is only as good as the checks that ran.** Each gap belongs to a
*check*, each check names the *sources* it reads, and a check whose source is
not wired on this install (`unavailable`) or threw (`failed`) is reported as
`skipped` — never as clean. A read that came back at its bound makes the check
`partial`. The response always lists the checks, and the dashboard always
shows them, including under an empty list ("Based on the 11 of 13 checks that
could run…").

**Explainable.** Each gap carries the numbers it was decided on (`evidence`) and
a `suggestion` key; the few heuristics are named constants, listed below.

**The text is not in the API.** The server returns kinds, keys and numbers; the
dashboard words them in the reader's language (the same split as the setup
checklist).

**Admin only.** A list of blind spots — sites without an agent, switches
nothing can poll, subnets no agent sits in, unmanaged devices in the path — is
the map somebody would want before doing something they would rather not be
seen doing. Every fix it suggests (add a switch, a credential, a traffic source,
promote a discovery candidate) is also an admin action. Same reasoning as
`GET /api/setup/checklist`.

## API

`GET /api/coverage?limit=N`

| Param | Meaning |
|---|---|
| `limit` | rows listed **per gap kind**, 1–200, default 50. Anything else is `400 { error: 'Validation failed', details: { limit } }` — a caller asking for 1000 and silently getting 50 would read the list as complete. |

Answers: 401 without a session, 403 below admin, 404 for any sub-path, 500 only
if the report itself fails (a failing *source* is a skipped check, not a 500).

```jsonc
{
  "generatedAt": "2026-09-23T12:00:00.000Z",
  "summary": {
    "total": 14, "warn": 5, "info": 9,
    "byScope": { "site": 2, "agent": 3, "device": 8, "subnet": 1 },
    "byKind": { "siteNoAgent": 1, "unmonitoredHosts": 4, "…": 0 }
  },
  "gaps": [{
    "kind": "siteNoAgent",
    "severity": "warn",              // info | warn
    "scope": "site",                 // site | agent | device | subnet
    "subject": { "id": 2, "label": "Branch" },
    "evidence": { "snmpDevices": 0 },
    "suggestion": "enrollAgent",     // coverage.suggest.<key>
    "link": { "view": "enrollment" } // where "Fix this" goes (view, id?, tab?)
  }],
  "truncated": { "unmonitoredHosts": 3 },   // counted but not listed (limit)
  "limit": 50,
  "checks": [{
    "key": "switchPorts", "status": "partial",   // ok | partial | skipped
    "kinds": ["unmonitoredHosts"],
    "missing": ["agentMacs"],                    // sources not read
    "capped": []                                 // sources read only up to their bound
  }],
  "windows": { "flowHours": 24, "staleReportMinutes": 30 }
}
```

The summary counts every gap; `gaps` is capped per kind; `truncated` says by how
much. Gaps are ordered by kind (the order in the table below), warnings first,
then by label.

## Checks and gap kinds

| Check | Sources | Kind | Severity | Rule |
|---|---|---|---|---|
| siteAgents | locations, agents | `siteNoAgent` | warn | A location with no (real) agent. Evidence: how many enabled switches are polled there. |
| siteSources | locations, agents, snmpDevices | `siteNoFlowOrSnmp` | warn | A site with agents where **none** has a NetFlow/sFlow source and **no** enabled switch is polled — only the agents themselves are seen. |
| flowCoverage | agents, flows | `agentNoFlows` | warn | An **online** agent set to NetFlow/sFlow with no `flow_records` row in the last 24 h. Offline agents are already listed as offline. |
| | | `siteNoFlows` | info | A site with agents where none produced a flow record in 24 h. Not raised for a site already listed as `siteNoFlowOrSnmp` (same fact, less useful). |
| agentHealth | agents | `agentOffline` | warn | `status` is not `online`. |
| | | `agentStale` | warn | Online, but the newest measurement (`last_report_at`) is missing or older than 30 min. |
| agentSource | agents | `agentProcOnly` | info | Traffic source `proc` (the default): counts bytes on its own interfaces, sees no conversations. |
| snmpPolling | snmpDevices | `deviceDisabled` | info | Disabled switch. No other device rule is applied to it. |
| | | `deviceNoPoller` | warn | Enabled, no polling agent assigned. |
| | | `deviceNeverPolled` | warn | Has a poller, has never answered (`last_ok_at` null). Evidence carries the last error. |
| | | `deviceError` | warn | Has answered before, the last poll failed (`last_error` set). |
| snmpCredentials | snmpDevices, credentials | `deviceNoCredential` | warn | Enabled, has a poller, no own community, and `snmpProfilesRepo.resolveForAgent` resolves nothing. Suggestion `grantCredential` when a community exists but the agent is not granted it (`blocked`), else `assignCredential`. |
| snmpCollect | snmpDevices | `deviceNoCounters` | info | Answered at least once, and `ifcounters` is not collected, has no counter interval, or the device does not support it. |
| | | `deviceNoLldp` / `deviceNoFdb` | info | Answered at least once, and `lldp`/`fdb` is not in `collect` (`enableCollect`) or the device reports it does not support it (`deviceLacks`). |
| switchPorts | snmpDevices, portMacs, deviceNeighbours, deviceMacs (+ agentMacs, agentNeighbours) | `unmonitoredHosts` | info / **warn** | Per switch: learned MACs on operationally **up** ports with **no LLDP neighbour**, that belong to no agent or polled device. Warn when a port has ≥ 4 such MACs (probably an unmanaged switch or AP). |
| switchNeighbours | snmpDevices, agents, deviceNeighbours, deviceMacs (+ agentMacs, agentNeighbours) | `unmanagedNeighbour` | info / **warn** | A neighbour in a switch's LLDP table (`snmp_neighbors`) that is not a monitored switch or agent. |
| agentNeighbours | snmpDevices, agents, agentNeighbours, deviceMacs (+ agentMacs) | `unmanagedNeighbour` | info / **warn** | The same, from the agents' own LLDP (`lldp_neighbors`). Both checks aggregate into ONE gap per remote chassis; warn when seen from two or more monitored things (it sits between them, in the path). |
| subnets | agents, arpSubnets | `subnetUncovered` | info | An IPv4 /24 seen in the ARP tables (last 7 days) with no agent that has an address in it (`capabilities.ips`). Loopback, link-local (169.254/16), 0/8 and multicast+ are never listed. |
| discovery | discovered | `discoveredPending` | info | Discovery candidates still in status `discovered` (neither promoted nor ignored). The total counts all of them; the list is capped. |

"Real" agent: promoted discovery candidates are `agents` rows with platform
`snmp` and no software behind them. They count as known identities (their name
and host), but no agent-health rule is applied to them — they would be offline
forever.

### What "known" means

The switch-port and neighbour checks decide whether a MAC or a neighbour is
something BlueEyes monitors the same way the topology map does
(`src/topology/graph.js`):

- a port MAC read off a polled switch (`device_interfaces.phys_address`);
- an agent's own chassis MAC from its LLDP (`lldp_neighbors.local_chassis_id`);
- the MAC behind an agent's own IP in any ARP table (`arp_entries`, via
  `macsForIps`) — agents report their IPs, not their MACs;
- by name: an exact, case-insensitive match of the neighbour's system name (or a
  non-MAC chassis id) against a switch's display name or host, or an agent's
  hostname, display name or one of its IPs.

### Heuristics (named constants in `coverageGaps.js`)

| Constant | Value | Why |
|---|---|---|
| `STALE_REPORT_MINUTES` | 30 | Agents report every minute; thirty missed reports is past any restart. |
| `FLOW_WINDOW_HOURS` | 24 | A flow source silent for a day is not exporting. |
| `MULTI_MAC_PORT` | 4 | Four unknown MACs on one port reads as a device with ports of its own. |
| /24 | — | "The subnet" for ARP coverage. An agent in a /23 covers only its own half. |
| One port per MAC | — | A host is learned on its access port and on every uplink toward the reporting switch. Each MAC is counted once, on the port with the **fewest** MACs; if that port faces an LLDP neighbour, the neighbour's own report is where it belongs. |

## Bounds and cost

One query per source, run concurrently, plus one credential resolution per
enabled switch without its own community (capped at 500 — beyond that the check
is `partial`). Nothing scales with traffic volume:

| Source | Read | Bound |
|---|---|---|
| agents / locations / snmpDevices | existing `findAll` / `list` | the fleet |
| flows | `flowsRepo.lastFlowAtByAgent()` — `MAX(ts)` per agent, a loose index scan on `idx_flows_agent_ts` | one row per agent |
| portMacs | `fdbEntriesRepo.listUpPortMacs({ since: 24 h })` — learned MACs joined to `device_interfaces` on the port name, `oper_status = 'up'` | 20 000 rows |
| deviceMacs | `deviceInterfacesRepo.listMacs()` | 50 000 rows |
| deviceNeighbours | `snmpNeighborsRepo.listAll()` | 20 000 rows |
| agentNeighbours | `lldpNeighborsRepo.listAll({ since: 7 d })` | 20 000 rows |
| arpSubnets | `arpEntriesRepo.subnetSummary({ since: 7 d })` — aggregated per /24 in SQL | 500 prefixes |
| agentMacs | `arpEntriesRepo.macsForIps(agent IPs)` | 1 000 IPs in, 5 000 rows out |
| discovered | `discoveredDevicesRepo.list({ status: 'discovered', limit })` + `countByStatus()` | `limit` |

A source read back at its bound marks the checks built on it `partial`.

## Known limits

- **A monitored switch can show up as an unmanaged neighbour** when its LLDP
  chassis id is a base MAC that is none of its port MACs and its system name
  differs from its display name here. The suggestion says so: give it its LLDP
  system name as display name. The topology map has the same rule, on purpose —
  an adjacency is resolved, never guessed.
- **Agents too old to report `capabilities.ips`** cannot cover a subnet on paper;
  the subnet check says how many (`agentsWithoutIps`) and turns `partial`.
- **ARP is evidence of a segment, not of coverage.** An agent that ARPs for an
  address is next to that segment; the /24 is flagged only when no agent has an
  address inside it.
- The report is a snapshot, read on demand; nothing is stored or alerted on.
