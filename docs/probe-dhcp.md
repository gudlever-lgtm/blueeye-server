# DHCP test and host NIC duplex

Two gaps the failure-scenario audit found (docs/audit/fejlscenarie-audit.md,
scenarios 3 and 8): a DHCP server that stops answering was only noticed if it
happened to log the fact over syslog, and a duplex mismatch on the agent's own
NIC was invisible, because the proc source threw away every error column except
the totals and never read the negotiated duplex.

## The DHCP test

`{ type: 'dhcp', iface?, timeoutMs? }` → `blueeye-agent/src/probes/dhcp.js`

The agent broadcasts one **DHCPDISCOVER** (RFC 2131) from `0.0.0.0:68` to
`255.255.255.255:67` — broadcast flag set, a random `xid`, `chaddr` = the MAC of
`iface` (default: the interface of the default route), options 53, 55
(1, 3, 6, 15, 51, 54) and 61 — and collects **every DHCPOFFER** for that `xid`
until the timeout (3 s by default, 1–10 s).

**It never sends a DHCPREQUEST.** An offer is a proposal; a server that hears
nothing further lets it lapse. No lease is taken, so the test is safe to run on a
schedule against a small production pool, including a flat OT network.

What comes back, per offer (at most 8): the **server identifier** (option 54),
the **offered address** (`yiaddr`), the **lease** (51), the **router** (3),
**DNS** (6, at most 4), the **subnet mask** (1) and the **relay** (`giaddr`, set
when the offer came through an ip-helper — i.e. the answering server is on
another segment). Plus `serverCount`: the number of distinct server identifiers.

Two outcomes are faults, and they are different faults:

| Outcome | Finding | Severity | Why |
| --- | --- | --- | --- |
| No offer | `probe.dhcp.no_offer` — "No DHCP server answered on eth0 within 3 s …" | WARN; **CRIT** once two tests in a row heard nothing | One lost broadcast happens; two is a server that is not there. Existing leases keep working until they expire, so the damage shows up later — on the next reboot. |
| More than one server | `probe.dhcp.rogue` — "2 DHCP servers answered on eth0: 192.168.1.1, 192.168.1.66 — a rogue or misconfigured DHCP server …" | WARN | Whichever answers first hands out the default gateway and the resolver. On a flat OT network that is a security event, not only an availability one. The finding lists every server and what it offered. |

Both are built in `src/analysis/probeFindings.js` (`dhcpFindings`) from the
sentences in `src/analysis/probeFailure.js` (`describeDhcp`). They are judged on
their own terms — never through the median+MAD reachability verdict — and the
dhcp rows are kept out of that verdict entirely: a silent DHCP server is not
"1/5 probe targets not responding (e.g. eth0)".

### "Nobody answered" is not "could not listen"

Port 68 needs root or `CAP_NET_BIND_SERVICE`. A test that could not bind it, or
found no IPv4 interface, reports `error` (the agent's `execError`, audited as
`agent.probe-failed`) and **no `offers` list at all**. The server stores no
`dhcp` block for it and raises no finding: not measured is not "nobody answered".
A port held by the host's own DHCP client (dhclient, systemd-networkd,
NetworkManager) is retried with `SO_REUSEADDR` before it is reported by name.

### Storage

`probe_results.dhcp` JSON (migration 132): `{ iface, timeoutMs, offers[],
serverCount }`, copied field by field (`dhcpBlock` in
`src/validation/probeValidation.js`), every address checked as IPv4, and
`serverCount` **recomputed** from the offers that survived validation — it is the
number the rogue finding is decided on, so it must agree with the list beside it.
`dhcp` is in `DIAGNOSTIC_TYPES`: a broadcast test of the segment never moves the
uptime or fleet-health verdict of the agent that ran it.

### Running it

* **On demand:** Probes → Run → type **DHCP**; the target field becomes the
  (optional) interface. The detail row lists every offer.
* **On a schedule:** add `dhcp` or `dhcp:<iface>` to the agent's
  `BLUEEYE_PROBE_TARGETS` / `probeTargets`. It is **not** on by default.

### Limits

* IPv4 only (DHCPv6 is a different protocol).
* The DISCOVER leaves by the route the kernel picks for `255.255.255.255` — the
  default-route NIC. `iface` names whose hardware address is asked about; on a
  multi-homed host the broadcast still goes out of the default-route interface.
* A server configured to answer only known MACs (reservations only) will stay
  silent to the agent, and the test will say nobody answered. Point it at a
  segment that serves dynamic leases, or leave it off there.

## Host NIC duplex and error detail

The proc source (agent 0.40, Linux) now reports per interface:

| Field | From | Meaning |
| --- | --- | --- |
| `duplex` | `/sys/class/net/<if>/duplex` | `full` / `half` / `unknown` |
| `rxFrameErrors` | `/proc/net/dev` rx `frame` | CRC/alignment damage — cabling, or the full-duplex end of a mismatch |
| `rxFifoErrors` | rx `fifo` | the NIC's ring overran — the host is too slow, not the wire |
| `txCollisions` | tx `colls` | only moves on a half-duplex link |
| `txCarrierErrors` | tx `carrier` | the link dropped out under the transmitter |

The counters are per-interval deltas. All five are **null, never 0**, where they
cannot be read — Windows and macOS sources, older agents, a down link, most
virtual interfaces — for the same reason as late collisions: a measured zero is
what rules a fault out.

`src/health/interfaceHealth.js` turns them into named `reasons`:

| Reason | When | Status |
| --- | --- | --- |
| `duplex_mismatch` | half duplex AND collisions, frame errors or late collisions moving | bad |
| `half_duplex` | half duplex, nothing moving yet | warn |
| `crc_errors` | frame errors on a link that is not half duplex | bad |
| `carrier_errors` | carrier errors moving | bad |
| `fifo_overrun` | rx fifo errors moving | warn |

The fleet reason line leads with the named cause ("Duplex mismatch suspected
(eth1): half duplex with collisions or frame errors increasing."), the
Interfaces screen shows the duplex in the Link column and the reasons under the
status badge, and the diagnose facts `iface.duplex`,
`iface.collisions_per_sec`, `iface.frame_err_per_sec` and
`iface.carrier_err_per_sec` feed the `duplex_mismatch` rules
(`half_duplex_collisions`, `half_duplex_frame_errors` confirm;
`full_duplex_clean` rules out) and the `physical_errors` rules
(`crc_on_full_duplex`, `carrier_errors` confirm). See `docs/diagnose.md`.

## Tests

`test/dhcpProbe.test.js` (spec, result validation, storage, routes, findings),
`test/interfaceDuplex.test.js` (reasons, fleet reason, diagnose facts + rules),
`test/interfacesPage.test.js` and `test/probesView.test.js` (UI). Agent side:
`test/dhcpProbe.test.js` (codec on hand-built RFC 2131 packets, runner with an
injected socket) and `test/trafficMonitor.test.js` (real `/proc/net/dev` text).
