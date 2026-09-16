# Path MTU

The `path_mtu` probe measures the largest packet that survives the path from an
agent to a target, hop by hop, and says what a smaller one means.

## The failure it exists for

A mail server connects, negotiates, starts sending — and the transfer stalls
part-way through. Ping is clean. Traceroute completes. Loss is zero. Latency is
normal. Every test passes, and the service is broken.

The cause is a link on the path with a smaller MTU than the sender assumes,
combined with a firewall that drops the ICMP message which would have said so.
Path MTU Discovery works by the sender emitting a full-size packet with the
*don't fragment* bit set and being told, by ICMP type 3 code 4, to send less.
Drop that ICMP and the sender is never told: it retransmits a packet that can
never arrive, forever.

Every other probe in BlueEyes uses small packets. That is exactly why they all
come back clean. This one measures by **size**, which is the only way to see it.

## The four verdicts

Per hop, and the distinctions are the whole point:

| Verdict | What was observed | Is it a fault? |
|---|---|---|
| `ok` | The largest tested size got through. | No. |
| `reduced` | A lower MTU **and** an ICMP "fragmentation needed" explaining it. | **No.** Tunnels (IPsec, GRE, PPPoE) do this and PMTUD copes. |
| `blackhole` | Large packets vanish, small ones pass, no ICMP at all. | **Yes.** This is the one that costs hours. |
| `no_response` | The hop answers no ICMP whatever the size. | No, and never counted as one. A silent router is normal. |
| `skipped` | The run's time budget expired before this hop. | No — reported so a truncated run is visible rather than looking short. |

A fifth thing must not be mistaken for any of them: **ordinary packet loss**,
which does not depend on size. `probes_per_size` separates it — a size counts as
passing if *any* of its probes get through, so a lossy but unrestricted link
reports its true MTU instead of a fabricated ceiling.

## How a hop is measured

Not by pinging the hop. By pinging the **target** with the TTL limited to that
hop, so the packet crosses exactly the links up to it and a TTL-exceeded reply
means the whole prefix carried that size.

Two consequences, both load-bearing:

1. The measured MTU is **monotonically non-increasing** along the path. That is
   what makes `mtu_drop_at_hop` — the first hop carrying less than the one
   before — a meaningful answer rather than a guess.
2. Each hop can start its search from the previous hop's ceiling. A hop that
   adds no restriction costs two probes, not a full binary search.

Before any of that, a **control probe at `min_size`**. If the smallest packet
gets no answer, the point is silent and every larger size would "fail" for a
reason that has nothing to do with size. That probe is what keeps `no_response`
from being reported as a blackhole.

## Parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `target` / `host` | string | – | Hostname or IP. Validated on both sides; never reaches a shell. |
| `ip_version` | 4 \| 6 | from the target | An IPv6 literal selects 6 on its own; a hostname defaults to 4. |
| `min_size` | int | 576 (v4) / 1280 (v6) | Whole IP packet size, not payload. |
| `max_size` | int | 1500 | Up to 9216 for jumbo frames. |
| `per_hop` | bool | true | Measure each hop from the traceroute, not just end to end. |
| `probes_per_size` | int | 3 | What separates an MTU limit from packet loss. |
| `timeout_ms` | int | 1000 | Per probe. |
| `tcp_port` | int \| null | null | Optional MSS check. Opens a real TCP connection. |

Sizes are **IP packet** sizes — what an MTU is. The agent subtracts the header
overhead (28 bytes IPv4, 48 IPv6) before handing a payload length to `ping`.

`recommended_mss` is `path_mtu − 40` (IPv4) or `− 60` (IPv6). The server
**recomputes** it on ingest rather than storing what the agent sent: it is the
number an operator will type into a router, so it has to agree with the path MTU
stored beside it.

## Platforms

| OS | DF | Size | TTL | Per-probe timeout |
|---|---|---|---|---|
| Linux (v4 + v6) | `-M do` | `-s` | `-t` | `-W` (seconds) |
| macOS `ping` (v4) | `-D` | `-s` | `-m` | `-t` (seconds, whole run) |
| macOS `ping6` (v6) | — none needed | `-s` | `-h` | `-W` (milliseconds) |
| Windows | `-f` (v4 only) | `-l` | `-i` | `-w` (milliseconds) |

All of this lives in one module, `blueeye-agent/src/probes/ipFamily.js` — header
sizes, minimum packet sizes, address parsing and the argv for every
platform/family combination. The probes consume it; none of them knows the
difference on its own.

macOS `-t` is a **timeout** while Linux `-t` is a **TTL**. Copying one command
line to the other platform measures a different thing and reports it as a path
MTU, which is why the argv tables are separate and pinned by tests.

Windows `ping` never reports the next-hop MTU in its frag-needed message. The
probe still classifies correctly — it finds the size by search instead of
believing a hint — so a Windows agent sees `reduced` and `blackhole` apart
exactly as a Linux one does.

No root is required: `ping` with DF works unprivileged everywhere.

### IPv6

Fully supported, per hop, on all three platforms.

**There is no don't-fragment bit in IPv6.** RFC 8200 forbids routers from
fragmenting in transit, so "don't fragment" is the permanent behaviour and every
OS's DF flag is IPv4-only. A packet too large for a link comes back as **ICMPv6
Packet Too Big (type 2)** — the exact analogue of IPv4's "fragmentation needed
and DF set" (type 3 code 4). Both carry the next-hop MTU, both are filtered by
the same careless firewall rule, and a filtered one is a PMTUD blackhole either
way. Everything this probe concludes transfers unchanged; only the argv and the
message wording differ.

Two practical differences the module handles:

- **IPv6 tracing is split across two binaries** and which one exists depends on
  the distribution: `traceroute -6` on most modern Linux, the separate
  `traceroute6` on macOS and on older installs. Both are tried, in the order
  that is right for the platform.
- **The size floor is 1280, not 576** (RFC 8200 §5). A `min_size` legal on IPv4
  is rejected on IPv6, with the correct bound quoted.

An IPv6 literal target selects IPv6 on its own — on the server, so the stored
spec says which family actually ran, and so the size floor is validated against
the right one. `ip_version` is only needed to force a family for a hostname that
has both records.

A literal beginning with a colon (`::1`, `::ffff:192.0.2.1`) is accepted by the
server's host guard via `net.isIPv6`, not by loosening the leading-alphanumeric
rule — a string `isIPv6` accepts can never be read as a CLI flag, and a leading
`-` is still refused.

### Known limits

- **A local "message too long"** means this host's own interface could not emit
  the packet — nothing reached the wire. It re-bases the run's ceiling instead
  of being blamed on a hop.
- **The macOS `ping6` flags come from its man page, not from a run on macOS
  hardware.** They are pinned by a test that compares the argv, so a correction
  is a one-line change in `ipFamily.js` — but this is the one part of the
  platform table that has not been exercised against the real tool.

## The MSS check (Linux only)

With `tcp_port` set, the agent opens a TCP connection to the target and reads
the MSS the kernel negotiated for it out of `ss -tin`, matching the socket on
its **own local port** (`ss` prints addresses, so a hostname would never match,
and resolving it here could legitimately disagree with the first lookup).

An observed MSS above `recommended_mss` is the direct, observable evidence that
MSS clamping is missing: the connection will establish and then stall on its
first full-size segment. Other platforms report `mss_supported: false`.

## Root cause

`src/analysis/mtuFindings.js`, called from `probeFindings.js` on every
probe-results ingest.

| Finding | Severity | When |
|---|---|---|
| `probe.mtu.blackhole` | CRIT | `blackhole_detected`. Names ICMP **type 3 code 4** specifically — "allow ICMP" is neither acceptable to a firewall team nor actionable — plus the hop, its address, and the MSS to clamp to. |
| `probe.mtu.reduced` | INFO | A reduction with the ICMP arriving. Says it is expected and names the one condition under which it is not. |
| `probe.mtu.clamp` | WARN | `mss_observed` above `recommended_mss` by more than 8 bytes. Independent of the other two. |

A `no_response` hop produces nothing at all.

**Corroboration** comes from the ordinary ping probe to the same target. Small
packets getting through cleanly while sized packets do not is what makes the
ceiling about *size* rather than loss. When there is no ping row it is reported
as absent, never implied; when small packets are also being lost, the
explanation says so rather than claiming support it does not have.

## Why the probe reports `ok: true`

Even when it finds a blackhole. The finding is about the **path**, not the
agent, and `ok: false` would make `computeAgentHealth` count the target as
unreachable and take the agent's whole status down with it. A probe that
measured what it set out to measure succeeded; what it measured is the bad news.

The only `ok: false` is the agent being unable to run the probe at all (no
`ping` binary, an invalid target, IPv6 on macOS) — the same meaning `error`
carries on every other probe type.

## Storage

`probe_results.mtu`, a JSON column added in migration 096:

```json
{
  "ipVersion": 4, "pathMtu": 1420, "blackholeDetected": true,
  "icmpFragNeededSeen": false, "mtuDropAtHop": 5,
  "mssSupported": true, "mssObserved": 1460, "recommendedMss": 1380,
  "durationMs": 8421
}
```

Per-hop numbers ride in the existing `hops` column, which already carries one
object per hop for the trace probes; a path-MTU row adds `maxMtu` and `status`
and leaves the latency fields null. One hop shape, two kinds of measurement — so
the dashboard's hop table needs no second code path.

The agent reports the wire shape in `snake_case` (the documented probe
contract); `validateProbeResults` is the single translation point to the
`camelCase` the repository, the root-cause rules and the dashboard use, exactly
as `rtt_ms` becomes `rttMs`. It is an allowlist, field by field from a typed
source — a key a future agent invents does not reach the database.

## RBAC and audit

Starting a probe is `POST /agents/:id/probe`, **operator or admin**. Viewers may
read results.

Every start is recorded in the **hash-chained** `audit_log` as category `agent`,
action `probe_start`, target `agent:<id>`, with the requested type, target and
port as detail. The activity feed (`audit_events`) records it too, but that table
is not tamper-evident; the compliance trail is where "prove nobody edited the
record of who ran what" is answered. Audit is best-effort: a failure there never
costs the operator the probe.

This applies to every probe type, not only `path_mtu` — logging one kind of
active test against a customer network and not the others would have been
arbitrary.

## Using it

**Probes & Tests → Run a probe → Path MTU.** Set the target, optionally the size
window and an MSS-check port, and run. The result panel leads with the verdict,
then shows a bar per hop scaled against the largest MTU measured on *this* path
(so a jumbo path does not render as identical full bars), with the hop where it
narrows marked in text as well as colour.

From an existing path visualisation, **"Test MTU on this path"** starts the probe
against the same target from the same agent, so the answer arrives beside the
picture that raised the question. Operator+ only — the button is not offered to
a viewer whose request would come back 403.
