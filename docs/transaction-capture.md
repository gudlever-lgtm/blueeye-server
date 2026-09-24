# Transaction phases and header capture — network or application?

> Every "the system is slow" report becomes the same argument: is it the
> network or the application? A transaction result used to carry ONE number per
> step — the wall time from just before the request to the end of the response
> body — and a 4200 ms step reads identically whether the name server, the path,
> the handshake, the server or the download was responsible. Two layers of
> evidence now answer it.

**Agent:** `blueeye-agent/src/transactions/phases.js` · `blueeye-agent/src/capture/`
**Server:** `src/analysis/transactionPhases.js` · `src/analysis/captureAnalysis.js`
**API:** `/api/transactions/:id/run` · `/api/transactions/:id/captures`
**Tables:** `transaction_results.step_phases`, `transaction_captures` (migration 135)

---

## Layer 1 — phases. Free, and where most answers are

A Node socket already announces the moments that matter. The agent was throwing
them away; now it records them.

```
   t0 ──lookup──▶ ──connect──▶ ──secureConnect──▶ ──headers──▶ ──end──▶
      \_ dns _/   \_ tcp ___/   \_ tls _______/   \_ ttfb __/  \_ transfer _/
```

| phase | what it is |
| --- | --- |
| `dns` | name resolution |
| `tcp` | the TCP handshake — **exactly one round trip, so this IS the network RTT**, measured without a capture and without a ping |
| `tls` | the TLS handshake: about two more round trips, plus the crypto |
| `ttfb` | request sent → first response byte |
| `transfer` | first byte → last byte: response size over throughput |

The derived number that ends the argument:

```
think ≈ ttfb − tcp
```

`ttfb` contains one round trip of travel; the rest is the server thinking. So
"4050 ms ttfb against a 31 ms round trip" is 4019 ms of application, stated in
one line, with no capture, no privileges, and on every platform.

**`null` is not zero.** It means the moment never happened: no TLS on a plain
http step, no handshake at all on a step that reused a keep-alive socket
(`reused: true` says which). A step that never got a first byte reports
`ttfb: null` **and** `transfer: null` — a body that never arrived must not read
as a fast download. Rendering a missing handshake as an instant one is the lie
this rule exists to prevent.

`step_phases` rides **alongside** `step_timings`, not instead of it: the
baselines (`transaction_baselines`) and the deviation detector index on
`step_timings`, and a second definition of "how long the step took" would be a
second thing to keep true.

### The verdict

`src/analysis/transactionPhases.js` turns the split into one of:

| verdict | when |
| --- | --- |
| `dns` | resolution ≥ 50 % of the step |
| `application` | think time ≥ 50 % of the step |
| `network` | the handshake alone ≥ 30 % of the step |
| `tls` | the TLS handshake ≥ 50 % of the step |
| `transfer` | the body ≥ 50 % of the step |
| `mixed` | nothing dominates — the explanation then lists every phase |
| `unknown` | no breakdown (an older agent, or a type that cannot measure one) |

The network threshold is lower than the rest because a round trip is never
*most* of a slow request: if a third of it went on the handshake, the path is
the story even though the server took the remainder.

On a **failed** step the verdict comes from where it stopped, not from which
phase was largest — on a failure the largest phase is usually just the timeout.
A step that completed its handshake and then failed is `mixed`, never
`network`: the path demonstrably carried packets both ways, and a verdict must
not contradict the sentence printed beside it.

It is derived **on read**, not stored: unlike a capture's verdict it is a pure
function of columns that are right there in the row, so there is nothing to go
stale and nothing to migrate when the rule improves.

---

## Layer 2 — header capture. For what timings cannot see

A 900 ms handshake looks the same whether the SYN was sent four times because
three were dropped, or whether it arrived first time and the server was slow to
accept. Same number, same graph, different fault, different owner. Five things
are only visible on the wire:

| signal | what it means |
| --- | --- |
| retransmissions | the same segment sent again — the first was lost |
| duplicate ACKs | the receiver asking again for a gap — out-of-order delivery |
| resets | a refusal, which a connect timeout looks exactly like |
| zero windows | the **receiver** out of buffer — an application fault dressed as a network one |
| MSS | what each end offered: an MTU or tunnel mismatch, found before it becomes an unexplainable stall |

### Why this is not a packet capture product

Five properties, each enforced in code rather than promised:

1. **The filter is derived from the test, never typed.**
   `blueeye-agent/src/capture/filter.js` computes it from the test's own
   configuration: every address has passed `net.isIP`, every port is an integer.
   There is no BPF grammar to validate because there is no user-supplied filter.
   A filter that cannot be built is a **refusal**, never a wider capture.
2. **snaplen is 96 bytes and fixed.** Not a parameter.
3. **Nothing is written to disk.** `tcpdump` writes its pcap stream to a pipe;
   each frame is decoded into named header fields and the buffer is dropped.
   There is nothing to delete afterwards because nothing was written.
4. **Only header fields exist downstream.** A packet record is
   `{ t, src, dst, proto, sport, dport, len, ttl, flags, seq, ack, win, mss, icmp, payload }`,
   where `payload` is the byte **count**. No DNS question name, no TLS SNI, no
   HTTP host or path. The server's ingest validator copies that key list and
   nothing else, so even an agent that sent more could not get it stored.
5. **Capture-on-fault is the default shape.** Under `on_fault` the capture runs
   on every run and is **kept only when the run failed or broke its latency
   threshold**; otherwise the records are discarded on the agent, in the
   function that made them. Rows exist because something went wrong.

A second narrowing happens in memory before anything leaves the agent: the
filter can only name the far end, so it also matched any other conversation this
host had with that address and port during the window. The run reports which
local ports it used (from the phase records), everything else is dropped, and
the count of what was dropped is reported as `foreign` — the honest measure of
how sharply the capture was scoped.

### Caps

| | limit | enforced where |
| --- | --- | --- |
| packets | 2000 | the agent's ring **and** `tcpdump -c` |
| duration | 30 s (normally the test's timeout + 2 s) | the agent |
| snaplen | 96 bytes, fixed | the agent |
| concurrency | one capture per agent | the agent |
| retention | **7 days** | `RETENTION_TRANSACTION_CAPTURE_DAYS` |

### Requirements

Linux, `tcpdump`, and `CAP_NET_RAW`. The systemd unit needs `AF_PACKET` in
`RestrictAddressFamilies` (it is listed last in the unit so it is the obvious
line to remove on a host that does not want the feature). A host missing any of
them reports `capabilities.unavailable.capture` with the reason and runs its
tests exactly as before — **a capture is an extra, never a precondition for
measuring.** `tcpdump` is on the agent's `install-tool` allowlist, so a missing
binary is fixable from the dashboard; the capability is not.

### The verdict

`src/analysis/captureAnalysis.js`, deterministic and local like every other
verdict in this product — robust counting, no model. It is computed **once, at
ingest, and stored**, so the row reads the same in a report six weeks later as
it did on the screen. The counts are stored beside it so a later reader can
disagree with the sentence.

| pattern | reads as |
| --- | --- |
| `blackhole` | SYNs sent, nothing back at all — something drops silently |
| `refused` | SYN answered with a reset — the port is closed, or a firewall rejects |
| `reset` | established, then reset mid-conversation |
| `window_limited` | a zero window — the application is not reading fast enough |
| `loss` | retransmissions, with the rate |
| `reordering` | duplicate ACKs but nothing retransmitted — a split path |
| `slow_path` | clean, but the handshake is slow: that is simply this path's RTT |
| `reduced_mss` | clean, but the segment size was shrunk — a tunnel or VPN |
| `clean` | nothing wrong on the wire; whatever failed did not fail here |
| `empty` | the capture matched nothing — check the interface |

---

## Running a test on demand

```
POST /api/transactions/:id/run   { agent_id, capture?: bool }    operator+
```

The point: a customer is on the phone about this system, and the next scheduled
run is up to an interval away. The agent runs the test immediately, answers with
the result **and its phase verdict**, and the run also lands in the normal
history — not a parallel one.

`capture: true` keeps the packets whatever the test's own mode says: somebody
asked for this specific run, and it is the one run where the wire-level answer
is wanted whether or not it failed.

It is **operator+**, not admin, because the capture can only ever contain
traffic the agent itself is about to send. Configuring `capture: 'always'` on a
test is a standing collection and stays **admin**.

Answers: `400` (bad id, missing `agent_id`, an agent not assigned to this test,
a non-boolean `capture`), `403` (viewer), `404` (no such test), `409` (agent not
connected, or the agent refused — its own reason is relayed), `504` (no answer
in time; the run may still be in progress), `502` (the command could not be
sent), `503` (on-demand runs not configured).

## Frames

| frame | direction | note |
| --- | --- | --- |
| `transaction_result` | agent → server | now carries `step_phases`. **Buffered** across a reconnect. |
| `transaction_capture` | agent → server | one capture. **Not buffered** — by the time a disconnected agent reconnects, the fault its packets describe is history, and the result row already carries the verdict. |

The two are matched by `(test_id, agent_id, time)` — the same natural key the
result row carries — so neither frame has to arrive before the other, and a
capture whose result was dropped is still readable evidence.
