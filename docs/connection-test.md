# Connection test

One address, the whole battery of checks, from one agent — with a Stop, a run
count, and a Repeat that becomes a real schedule.

Where to find it: **Probes & Tests → Connection test**.

## The question it answers

"I cannot reach X" is not one question, it is ten. Does the name resolve? Does
the host answer ICMP? Is port 443 open? Is 80? What does the path look like, and
where does it get bad? Does a full-size packet get through? And — the one every
other check only implies — does the service at the other end actually answer?

The Run-a-probe tab answers one of those at a time, which is the right tool when
you already know what you are looking for and the wrong one when somebody has
just told you a service is down. This screen types the address once and asks all
of them.

Nothing new is stored. Every check is an ordinary probe, so its result lands in
`probe_results` and shows up everywhere a probe already does: the latest-results
table, the path visualisation, fleet health, availability reporting, the
anomaly detector.

## The catalogue

The list lives on the server (`src/connectionTest/checks.js`) and is served by
`GET /api/connection-test/checks`. The dashboard renders what it is served and a
run builds its probe specs from the same entries, so a check the screen offers
is always a check the server can dispatch.

| Check | Probe | Note |
|---|---|---|
| DNS lookup | `dns` | Hostname targets only |
| Reverse DNS | `rdns` | The PTR, and whether it forward-confirms (agent 0.27+) |
| Ping (ICMP) | `ping`, count 4 | Loss, RTT, jitter |
| TCP connect | `tcp` port 80 | Handshake time to HTTP |
| TCP connect | `tcp` port 443 | Handshake time to HTTPS |
| TLS / certificate | `tls` port 443 | Expiry, chain, hostname, protocol (agent 0.27+) |
| Traceroute | `traceroute`, 3 queries/hop | Per-hop loss and latency |
| TCP traceroute | `tcptraceroute` port 443 | The path a TCP session takes |
| Path MTU | `path_mtu`, per hop | The largest packet the path carries |
| HTTP request | `http` to `https://<host>/` | Whether the **service** answers, not just the port |

Two rules keep the list honest rather than tidy:

* **`available: false`** — a check the catalogue knows about but the agent
  cannot run is **shown, disabled, with the reason** instead of hidden, so the
  list says what a connection test covers, and the server refuses to dispatch
  it. Nothing is marked so today: reverse DNS and TLS landed in blueeye-agent
  **0.27**. An agent older than that answers `unknown probe type`, which the row
  reports as the failure reason it is — see [scheduled-reports.md](scheduled-reports.md)'s
  sibling note on version skew in `docs/probe-tls-rdns.md`.
* **`appliesTo: 'hostname'`** — a DNS lookup of `1.1.1.1` resolves nothing. With
  an IP literal in the target field the row greys out and says why. A green tick
  for a question nobody asked is worse than no row at all.

Everything runnable starts **selected**: an operator who typed one address and
pressed Run wants all of it. Clearing a row is the exception, not the setup.

## Running

The count sits inside the Run button, because "Run 3 tests" is one control and
one sentence. It is the number of **rounds**: every selected check, that many
times, one round after another — for a fault that comes and goes, where a single
sample proves nothing.

Each round is **one request** (`POST /api/connection-test/run`) that pushes every
selected check to the agent, and **one record** in the hash-chained audit trail
— the same treatment a hand-run probe gets, not nine of them.

The screen then polls `GET /api/probes/latest` and fills each row in as its
result arrives. A result older than the round that asked for it never claims a
row: a stale green tick for a probe that has not come back is exactly the lie
this screen exists to avoid. The `:80` and `:443` rows are told apart by the
`host:port` target a TCP probe stores.

### Reading a row

A row that succeeded shows **the measurement**, not the word OK — `12 hops · 4%
worst hop loss` says more than a tick, and it is the same `probeMeasured()` the
Run-a-probe table uses.

A row that did not succeed shows **why**, in two lengths: a word in the pill and
the sentence underneath. The sentence is the agent's own `detail` whenever it
has one (`traceroute not installed`, `connect ECONNREFUSED 93.184.216.34:80`);
the word is read off it (`ctFailureReason()` in `public/app.js`) and never
invented. A failure nothing can classify says `failed` rather than dressing
itself up. Where the reason is a missing tool, the row carries the same
**Install** button the probe table offers — the answer to "why did this fail" is
one click from the fix.

"Skipped" is three different things, and the row says which: **not selected**
(cleared by hand), **not supported** (the agent cannot run it), **n/a** (the
target cannot answer it — a DNS lookup of an IP literal). The last two say so
before anybody presses Run.

A row with a result **opens in place** on click or Enter — the same
`probeDetail()` the Run-a-probe tab renders: the path map and per-hop table for
a traceroute, the MTU verdict for a path MTU, the RTT history for everything
else. One at a time, because two open traceroutes would each mount a path
visualisation and the second would overwrite the first's URL state.

**Stop** ends the run: no further rounds are sent. A check already handed to the
agent runs to the end on the agent — nothing can call it back — so its result
may still arrive a moment later. The screen says so rather than pretending the
Stop reached the network.

## Repeat

Repeat saves the same test as an ordinary **test package**
(`POST /api/connection-test/schedule`): it survives the page being closed, and it
is edited, paused and deleted on the Test packages tab like everything else.

The dialog asks four things:

* **Period** — hourly, daily, weekly or monthly.
* **Repetitions within the period** — rendered as the gap it produces ("every 4
  hours"), not as the number it is. The options are per period.
* **When it starts** — a time of day, plus a weekday or a day of the month where
  the period needs one.
* **Tests per run** — how many times the whole battery runs per scheduled run.

It writes the schedule out as a sentence before you save it, because a schedule
nobody can read back is a schedule nobody trusts.

### What a recurrence is

`test_packages.schedule_ms` was an interval: "run every N ms since the last run".
It cannot say a time of day and it cannot reach past 24 hours, so weekly and
monthly were inexpressible. Migration **099** adds `schedule_spec` beside it:

```json
{ "period": "daily",   "every": 6, "at": "08:00" }
{ "period": "weekly",  "every": 1, "at": "07:30", "weekday": 1 }
{ "period": "monthly", "every": 2, "at": "06:00", "dayOfMonth": 1 }
```

`every` is the number of runs **inside** one period, evenly spaced from the
anchor. A package has one kind of schedule or the other: saving a spec stores
`schedule_ms = 0`, so the scheduler never has to decide between two answers to
the same question.

The maths is `src/schedule/recurrence.js` — pure, no I/O, the instant passed in
by the caller. `nextRunAt(spec, fromMs)` walks the calendar rather than adding
constants, which is why:

* a daily 08:00 schedule stays at 08:00 across a DST change, and
* a monthly one spaces itself over 28, 30 or 31 days as the month really has.

Times are the **server's** local zone. A per-package time zone would be a column
and a promise we cannot keep on an on-prem box whose clock the customer owns.

Two floors protect the agents: runs must be at least **5 minutes** apart
(`MIN_SPACING_MS`), and one scheduled run may carry at most `MAX_ITEMS` (20)
tests — `checks × runs`, refused with the knob to turn down rather than silently
running fewer checks than the screen shows. A scheduled connection test is an
enabled test package, so it consumes an active-test-path slot under the plan
limit exactly like one built by hand.

`dayOfMonth` is capped at 28: "the 31st" is a schedule that skips February, which
is a bug report rather than a schedule.

## The API

| Method | Path | Role | Answers |
|---|---|---|---|
| `GET` | `/api/connection-test/checks?host=` | viewer+ | The catalogue; with a host, what applies to it |
| `POST` | `/api/connection-test/run` | operator+ | 202 + what was dispatched · 404 unknown agent · 409 agent not connected · 400 validation |
| `POST` | `/api/connection-test/schedule` | operator+ | 201 the created package · 404 · 403 plan limit · 400 validation |

Input validation is `src/validation/connectionTestValidation.js`. The target is
checked by `validateProbeSpec` rather than by a second host pattern — a host
this accepts is a host an agent will be asked to probe, and the two can never
drift apart. The check ids are a closed set from the catalogue, never a free
string that could become a probe type.

## Files

| What | Where |
|---|---|
| The catalogue | `src/connectionTest/checks.js` |
| Recurrence maths + validation | `src/schedule/recurrence.js` |
| HTTP input validation | `src/validation/connectionTestValidation.js` |
| Router | `src/routes/connectionTest.js` (mounted at `/api/connection-test`) |
| Storage | `test_packages.schedule_spec` (migration 099) |
| Scheduler | `src/services/testPackageScheduler.js` |
| Screen | `connectionTestView()` / `openRepeatModal()` in `public/app.js`, `ct.*` in `public/i18n.js` |
| Tests | `test/connectionTest.test.js` · `test/connectionTestView.test.js` · `test/recurrence.test.js` · `test/testPackageScheduler.test.js` |

## The same three controls elsewhere

The Repeat dialog is a shared component (`recurrenceFields()` / `openRepeatModal()`
in `public/app.js`), and the run controls travelled with it. The same question —
how often, starting when — is now asked in the same words on five screens:

| Screen | What repeats | Also gained |
|---|---|---|
| Probes & Tests → Connection test | the selected checks | rounds · Stop |
| Probes & Tests → Run a probe | the probe on screen | rounds · Stop |
| Probes & Tests → Test packages | the package | a calendar schedule instead of only an interval |
| Agents → Speed test | the speed test | — |
| Diagnose | the plan's selected tests (one package per agent — a test package pushes every item to every target, and a reverse test must not run from the wrong end) | rounds · Stop · per-test checkboxes |

Reporting has the same idea with a different payload — see
[scheduled-reports.md](scheduled-reports.md).


---

# The ladder

Ten rows is ten answers, and an operator still has to work out which one matters.
The ladder is that reading. It walks the layers **in the order a packet meets
them** and names the first one that breaks.

```
DNS → ARP → routing → firewall/ACL → TCP → NAT/load balancer → TLS → application
```

Where to find it: the same screen. Type the destination, say what is wrong in
your own words, press **Find where it stops**.

**API:** `POST /api/connection-test/walk` (operator+) dispatches every check in
the catalogue; `GET /api/connection-test/ladder?agentId=&host=` (viewer+) reads
the verdict back. **Code:** `src/connectionTest/ladder.js`,
`src/connectionTest/lb.js`, `src/connectionTest/arpContext.js`.

## The four rules it stands on

**A rung is only decided by a measurement.** No check, no verdict: the rung reads
`unknown`, and `unknown` is never promoted to `ok`. "We looked and it is fine"
and "nobody looked" are different sentences, and a ladder that blurs them is a
guess with a tick next to it.

**Everything above the break is `unreached`, not green.** A TLS handshake that
"succeeded" while DNS pointed at the wrong address proves nothing about TLS. The
rung keeps what it would have said in `would_have_said`, so the measurement is
not lost — it just does not get to be an answer.

**Every rung carries its own reason.** `because` is the measurement that decided
it, written out. A red rung whose explanation lives on another screen is the
thing this replaces.

**Nothing is re-measured.** Every input is an ordinary row in `probe_results`, so
the verdict can be recomputed at any time, answers for a run somebody else
started, and can never disagree with the row a screen is showing.

## Why the firewall rung sits where it does

It is decided by the **divergence** between ICMP and TCP, not by either alone —
which is the single most misread signal in network troubleshooting.

| ping | the port | the rung says |
| --- | --- | --- |
| answers | times out | **stops here.** A filter. The host is up (it answered ICMP) and the SYN is dropped in silence — a firewall rule, an ACL or a security group |
| answers | refused | **works.** A reset is the host *answering*. The path is open and nothing is listening: the service's problem, not the network's |
| answers | unclassified | **not tested.** An agent that did not report refused-vs-timeout cannot tell a drop from a reset, and this rung will not guess |
| no reply | connects | **worth knowing.** ICMP is filtered and the application path is open. An ICMP-only monitor calls this an outage; it is not one |
| no reply | fails | **not tested.** Both directions are broken, which is the path — routing owns it |

Going to the firewall team on a reset is the wrong trip, and the rung says so in
as many words.

## NAT / load balancer: observed, not guessed

Before this, a proxy in the path could only ever be *inferred* — Service
Assurance reads a 502 and proposes "a load balancer or reverse proxy" with
`basis: inferred`, because nothing was ever inspected. The ladder inspects.

`traceroute` walks the path ICMP takes; `tcptraceroute` walks the path a SYN to
the application port takes. On a plain routed path they end at the same address.
They end at **different** addresses when something terminates the TCP session
before the host that answers ping — which is what a load balancer, a reverse
proxy and a destination NAT all are.

| Evidence | Basis |
| --- | --- |
| The two paths end at different addresses | observed |
| Several addresses answered at one hop of one run | observed |
| The certificate does not carry the name asked for | observed |
| HTTP 502 / 503 / 504 | inferred — the status names the shape of what produced it |
| Both paths walked and they agree | observed — and the one case that may conclude *nothing is there* |

It never compares hop **counts**: ICMP and TCP are policed differently at nearly
every hop, so two paths of different lengths to the same address are normal, and
reading that as a finding would report a load balancer on most of the internet.

A middlebox is not a fault. It is reported as `suspect`, and when something above
it breaks it is carried into the verdict sentence — a healthy handshake under a
dead service is exactly what a load balancer explains.

## ARP: answered, and honestly bounded

ARP only resolves addresses on the sender's own segment. Anything routed goes to
the default gateway and the destination's MAC is never asked for, so "no ARP
entry" is the correct state of a working network, not a finding.

So the rung asks whether ARP is on the path **first**, from the agent's own
neighbour table in `arp_entries`: an address it has ARPed is by definition on one
of its segments, so the /24 (or /64) of every entry it reported is a segment it
sits on. Off-segment ⇒ `not applicable`. On-segment with a MAC ⇒ `ok`.
On-segment with no MAC ever reported ⇒ **the rung that breaks**. No neighbour
table at all ⇒ `unknown`.

No agent change was needed for any of it: agents have reported their ARP tables
since the `arp_entries` work (see [arp-identity.md](arp-identity.md)).

## The symptom is data

The free-text box travels as a JSON string value, is bounded at 500 characters,
is echoed back beside the verdict and is written to the audit detail. **Nothing
reads it to decide what to run.** The ladder is fixed, so a sentence typed into
that field can never change which commands an agent is asked to execute — the
same rule [diagnose.md](diagnose.md) follows for an operator's own words.

It is not wasted: the same text matched against the playbook catalogue picks
`firewall_acl` and the rest on **Diagnostics → Diagnose**, which is where the
causes, the reading rules and the fixes live. The ladder says *where*; a playbook
says *why* and *what to do*.

## A note on language

The rung sentences are written by the server in English, like the probe-failure
explanations in `src/analysis/probeFailure.js` that the probe table already
shows. They are the reading of a measurement and have to say the same thing
wherever they appear. Everything around them — the layer names, the statuses, the
outcome, the labels — goes through `public/i18n.js` in both catalogues.
