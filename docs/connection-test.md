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

## The verdict links to its explanation

The ladder says **where** the communication stops. A playbook says **why** and
**what to do**. The join between them is data: each playbook declares the rungs
it explains.

```jsonc
// src/diagnose/playbooks/firewall_acl.json
"rungs": ["firewall"]
```

Validated at load against the rung ids the ladders actually declare, so a typo
(`firewal`) fails the build rather than producing a playbook that can never be
offered. Optional: a playbook that explains a fault no rung measures is still a
playbook, it is just not reachable from a verdict.

`GET /api/connection-test/ladder` returns the matching playbooks for the rung it
stopped at, in the same locale as the verdict, and the screen opens them **in
place** under the verdict — title, explanation and the fixes. The operator is
already looking at the answer; sending them to another screen to describe the
same fault a second time is the hop this removes.

| Rung | Playbook |
| --- | --- |
| `firewall` | `firewall_acl` |
| `dns`, `resolver` | `dns_resolution` |
| `routing` | `hop_packet_loss`, `ecmp_member_link` |
| `symmetry`, `direction` | `asymmetric_routing` |
| `errors`, `counters` | `physical_errors`, `congestion`, `l2_loop` |
| `duplex` | `duplex_mismatch` |
| `mtu` | `mtu_blackhole` |
| `nat_lb` | `ecmp_member_link` |

A rung nothing explains yet — `tls`, `arp`, `identity`, `port` — returns an empty
list. The verdict still says where it stops; it just has nothing further to
offer, which is honest and not a gap worth hiding. **Adding a playbook for one
is a `rungs` entry in its JSON and nothing else.**

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

## Language

The rung sentences are rendered on the **server**, in the locale the request
asks for (`GET /api/connection-test/ladder?locale=da`; the dashboard sends its
own current language). The catalogue is `src/connectionTest/i18n.js` — the same
per-request-locale pattern `src/nis2/i18n.js` uses for the report documents, and
for the same reason: `public/i18n.js` keeps one active locale in module state,
and on a server that would let one request's language leak into another's
verdict.

A rung carries a message **key and its parameters**, never a sentence. The
sentence is rendered once, at the end of the walk. A rung evaluator therefore
does not know locales exist, and a rung added with an English sentence only
fails the build (`missingKeys()` is asserted in `test/connectionLadder.test.js`).

**Technical terms are not translated, in any locale.** DNS, ARP, ICMP, TCP, SYN,
RST, TLS, ACL, MTU, HTTP, NAT, VIP, firewall, load balancer, proxy, security
group, ping, traceroute, reset, timeout. They are what the equipment, its
documentation and the engineer all call them; a Danish word for SYN makes a
sentence harder to act on, not easier. Everything around them is the local
language:

> Kommunikationen stopper ved firewallen: ICMP besvares, og TCP/443 droppes
> lydløst — en firewall-regel, en ACL eller en security group der tillader ping
> og nægter applikationsporten. En vært der var nede kunne ikke have svaret på
> ping.

One thing stays in the words it was written in: a clause the **agent** produced
(`detail` — `connect ECONNREFUSED 93.184.216.34:80`, `certificate expired 3 days
ago`). It is a measurement in the words of the thing that measured it, the probe
table already shows it as-is, and rewriting it here would create a second
version of a string an operator may need to match against a log. The sentence
around it is translated; the clause is quoted inside it.

---

# Four ladders

A ladder is an ordered list of rungs, an evaluator per rung, and a rule for
reading the result. That is a table, not a constant — so each one is a file in
`src/connectionTest/ladders/` and the shared machinery lives once, in
`registry.js`. **API:** `GET /api/connection-test/ladders` serves the catalogue;
the screen renders what it is served, the same rule the check catalogue follows.

| Ladder | Needs | Rungs | Dispatches |
| --- | --- | --- | --- |
| `reachability` | one agent, a destination | DNS → ARP → routing → firewall → TCP → NAT/LB → TLS → application | the check catalogue |
| `two_way` | **two** agents | forward → reverse → symmetry → direction → latency → MTU | ping, traceroute, path MTU, from **both** ends |
| `local_host` | one agent | link → duplex → errors → DHCP → gateway → resolver | DHCP, traceroute, DNS |
| `device_location` | a device | identity → switch → port → state → counters → VLAN | **nothing** |

What every ladder shares is in the registry, not repeated in each: a rung is
only decided by a measurement, the first failure is the answer, everything above
it is `unreached`, a rung switched off is reported rather than dropped, and the
sentences are rendered once at the end in the caller's language.

## `two_way` — the same question from both ends

A one-way ladder can say the communication stops; it cannot say which
**direction** is broken. That is the whole answer for a class of faults a
forward test reports as "the network is fine":

- **a stateful firewall on the return path**, which never saw the SYN and drops
  the answer. From the near end that is indistinguishable from a dead service,
  until the far end reports that *its* traffic arrives;
- **asymmetric routing** — the two directions take different paths, so one can
  be broken while the other is perfect;
- **one-way loss**, which a round-trip measurement averages into something mild;
- **an MTU that differs per direction**, so a request fits and the reply vanishes.

Both ends probe the other's own reported address (`capabilities.ips`); an agent
that has never reported one leaves the far end nothing to aim at, and is told so
rather than probing a blank.

**What it does not claim.** A round trip cannot be split into two one-way
latencies without synchronised clocks, which BlueEyes does not have and will not
invent. The latency rung compares two **round** trips — A→B→A against B→A→B — and
says so: a difference means the two round trips are not the same path, which is a
real finding and a different one from "the outbound leg is slow".

Path symmetry reuses `comparePaths()` from `src/diagnose/facts.js` rather than
re-implementing it, because a second, quietly different answer to "is this path
symmetric" is worse than no second opinion. Asymmetry alone is a `suspect`, never
a break — it is normal on the internet and across most WANs. It becomes the
answer when a direction is also losing, and the direction rung is what says so.

## `local_host` — is it this machine?

Asked before a destination ladder means anything. Every rung of `reachability`
measures the path to somewhere; none of them can tell you the NIC negotiated
half duplex, that two DHCP servers answered, or that the default gateway two
feet away is what is unreachable.

Everything it reads is data agents **already** report: interface health from the
traffic payload, the DHCP probe's offers, the first hop of a traceroute (which
*is* the gateway this host uses, read off the wire rather than out of a config
file), and any DNS probe.

Two rungs carry a distinction worth stating:

- **duplex** — late collisions *name* a mismatch; they only happen when one end
  may transmit while the other is transmitting. Half duplex on a switched port
  is a negotiation that failed and behaves as a network fault that gets worse
  under load, which is how it survives weeks of being diagnosed as congestion.
  Duplex that was not reported reads `unknown`, never `ok`;
- **DHCP** — nobody answering and *several* servers answering are different
  faults. The second is a security finding as much as an availability one:
  whichever answers first hands out the default gateway and the resolver. A test
  that could not **run** (no permission for port 68) says nothing about the
  network and is reported as saying nothing.

## `device_location` — where is it plugged in?

Answers **where**, not why, and dispatches nothing: every rung reads what the
fleet already collected, through the same `src/topology/deviceLocator.js` the
Path & location screen uses. One locator, so there is one answer to "where is
this".

It is a ladder rather than a page because "where is it" fails in stages with
different owners, and a page of blanks makes all of them look like "the tool
does not know":

| Rung fails | What it actually means |
| --- | --- |
| identity | no ARP table this server reads covers that segment — a coverage gap, not a missing device |
| switch | the switches in front of it are not polled here |
| port | the switch knows the MAC and reported no port |
| state | administratively down (somebody shut it) is told apart from a port that fell over |

A port with more MACs behind it than `accessPortMaxMacs` is an uplink or a
trunk, not where the device is plugged in — it is the *direction* the device
lies in, and reporting it as "the port" sends somebody to unplug a switch. VLAN
is a fact, not a fault, unless the caller said which one it should be on.

A device nothing has ever seen is a **verdict**, not a 404: the first rung says
so in a sentence, and a 404 would make it look like the API was wrong.

---

# Settings → Diagnostics

Each ladder keeps its own configuration, because "which rungs run" means
something different for each of them. The defaults **are** the shipped ladders,
so a server that never opens this screen behaves exactly as it did before it
existed.

**API:** `PUT /api/settings/ladder/:id` (admin), all of them carried in `GET
/api/settings` as `ladders`. **Code:** the `LADDER_*` half of
`src/services/settings.js`, `settingsLadderView()` in `public/app.js`, and the
model itself in `src/connectionTest/ladders/` — imported by the settings service
rather than restated, so the panel and the walk can never disagree about what a
rung is or which orders are legal. The fields are rendered from the server's own
`defaults`, so a ladder that gains a knob gains a field without the screen being
taught about it.

| Setting | Ladders | What it does |
| --- | --- | --- |
| `order`, `enabled` | all | which rungs run, in what order |
| `ports` | reachability | the TCP ports the TCP and firewall rungs read. 80 and 443 by default — and the wrong answer for a service on 8443, 22 or 1433, which is most of why this is configurable |
| `certWarnDays`, `lossThresholdPct` | reachability | a certificate expiring within this is `suspect`; sustained per-hop loss at or above this is the routing rung's break |
| `latencyRatio`, `latencyMinMs` | two_way | how much slower one round trip must be than the other before it is worth a sentence, with an absolute floor so a sub-millisecond LAN never trips it |
| `errPerSec`, `dropPerSec`, `resolverSlowMs` | local_host | what counts as a fault on the NIC, and when a resolver is slow |
| `accessPortMaxMacs`, `errPps`, `discPps` | device_location | above how many MACs a port is an uplink, and what its counters may read |

## Half the order is fixed, and that is not tidiness

Every ladder declares a **causal chain** — rungs where each is only reachable
because the one before it worked:

```
reachability     DNS → routing → firewall → TCP → TLS → application
two_way          forward → reverse → symmetry → direction
local_host       link → duplex → DHCP → gateway → resolver
device_location  identity → switch → port → state
```

A name has to resolve before a path can be walked to it; there is nothing to
compare until both directions have been measured; a link has to be up before
duplex means anything; without a MAC there is no forwarding-table lookup. Move
TLS above TCP and the ladder reports "stops at TLS" for a host whose port never
opened — a confident, wrong answer, which is worse than no answer.

Everything else is an observation **about** the subject rather than a step along
it — `arp` and `nat_lb`, `latency` and `mtu`, `errors`, `counters` and `vlan` —
and moves freely, to anywhere in the list or off it.

The rule is enforced in `validateOrder()` and the screen asks it before drawing
a ▲▼ button, so this is a panel that cannot request something the server would
refuse rather than one trusted to behave. A `PUT` that breaks a chain is a **400
naming the pair**, never a silent fallback: a screen showing an order the server
is not walking is exactly the failure this avoids.

## A rung switched off is reported, not dropped

The ladder still shows it, with `disabled: true` and a sentence saying it was
switched off in Settings. Shrinking the ladder would make an incomplete answer
look like a complete one — the same rule as `unknown` never being promoted to
`ok`, applied to a decision an operator made rather than to a missing
measurement.
