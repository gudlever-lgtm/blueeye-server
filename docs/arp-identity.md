# ARP identity (IP ↔ MAC)

The universal search field needs to answer "where is this MAC" and "what holds
this IP". Before migration 073 the server could answer neither.

## The data existed and was unusable

| What was there | Why it did not work |
| --- | --- |
| `lldp_neighbors.remote_chassis_id` | Often a MAC, but it identifies a **switch chassis**, not a client. Wrong answer to "where is this laptop". |
| `arp.table` in `cluster_evidence_snapshots` | The agent **was already collecting it** — but only as a gzip blob of raw command output. Unparsed, unindexed, and only for clusters that happened to trigger a capture. |

So the collection worked; nothing could query it. `arp_entries` parses it into
rows.

## Two ingest sources

Both fold into the same table, tagged by `source`:

| `source` | Where | Trade-off |
| --- | --- | --- |
| `capabilities` | `POST /agents/me/capabilities`, field `capabilities.arp` | Fresh and continuous — but only from agents new enough to send it. |
| `evidence` | Parsed out of an evidence snapshot's `arp.table` item as it is captured | Needs **no agent change**, so it works against agents already in the field — but only fires when a cluster opens. |

Neither is authoritative alone; together they cover the fleet during the agent
rollout. That is why `source` is recorded per row rather than assumed.

Both seams are **best-effort and cannot break what they ride along with**: an
ARP failure never fails a capabilities report, and never fails an evidence
capture. The evidence snapshot itself stays exactly as it was — an immutable
record of what the agent said; the harvest only *also* parses one item on the way
past.

## The parser

`src/identity/arpTable.js` is pure — no I/O, no clock, no DB. It handles four
formats, detected **per line** (an evidence payload is a concatenation, and a
stray unparseable line must never discard the rest):

```
/proc/net/arp   192.168.1.1  0x1  0x2  00:11:22:33:44:55  *  eth0
ip neigh        192.168.1.1 dev eth0 lladdr 00:11:.. REACHABLE
arp -an (BSD)   ? (192.168.1.1) at 00:11:.. [ether] on eth0
arp -a (Win)    192.168.1.1    00-11-22-33-44-55   dynamic
```

Dropped at parse time, never stored and filtered later:

- incomplete entries (`/proc/net/arp` flag without `0x2`, `ip neigh` FAILED/INCOMPLETE, `<incomplete>`)
- the all-zero MAC, broadcast, IPv4/IPv6 multicast, IEEE-reserved (STP/LLDP)
- anything with the group bit set in the first octet

**Locally-administered unicast addresses are kept** (`aa:…`, `02:42:…`). Those
are VMs and containers — dropping them would blind the search to virtualised
hosts, which is most of them.

## Identity: one row per (agent, ip)

An IP's MAC changing is an **UPDATE, not a second row**. The current occupant of
an address is what a search must return; keeping history here would turn an
identity lookup into a time query.

The previous binding is not lost silently — `mac_changed_at` marks when the
binding last moved. That is exactly the signal a technician chasing an
intermittent fault wants flagged, and the MAC resolver surfaces it in the hit's
`detail`.

Scoped **per agent**, not globally: the same RFC1918 address legitimately exists
at several sites, and collapsing them would resolve `192.168.1.10` to whichever
site reported last. Search surfaces all matches with their observing agent.

## Retention

`RETENTION_ARP_DAYS`, default **30** — short by design. A neighbour table is a
snapshot of a segment, and a stale answer to "where is this MAC" is worse than no
answer. Purged in the nightly retention sweep alongside the other dimensions.

Ingest is an **upsert, not a wholesale replace** (unlike `host_connections`): an
evidence snapshot only covers what the neighbour table held at that instant, and
deleting rows it did not mention would throw away a binding learned from the
capabilities cycle. Age-out handles staleness instead.

## Privacy

Metadata only, consistent with the rest of the product: an address pairing
observed on the local segment. No payload, no DPI, no user identity. This does
**not** make the username resolver possible — see `docs/universal-search.md`.

## Files

- Migration `migrations/073_create_arp_entries.sql`
- Parser `src/identity/arpTable.js` (also exports `normalizeMac`, used by the search query layer so query and ingest normalise identically)
- Repository `src/repositories/arpEntriesRepository.js`
- Seam 1 — `src/routes/agentReports.js` (`POST /me/capabilities`)
- Seam 2 — `src/evidence/snapshotService.js` (`harvestArp`)
- Retention — `src/analysis/retention/{config,repo,purge}.js`
- Fake `makeArpEntriesRepo` in `test-support/fakes.js`
- Tests `test/arpTable.test.js` (parser), `test/arpIngest.test.js` (both seams + retention)
