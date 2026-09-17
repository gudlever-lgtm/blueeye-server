# Connection test

One address, the whole battery of checks, from one agent — with a Stop, a run
count, and a Repeat that becomes a real schedule.

Where to find it: **Probes & Tests → Connection test**.

## The question it answers

"I cannot reach X" is not one question, it is nine. Does the name resolve? Does
the host answer ICMP? Is port 443 open? Is 80? What does the path look like, and
where does it get bad? Does a full-size packet get through?

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
| Reverse DNS | — | **Not available yet** (agent-side work) |
| Ping (ICMP) | `ping`, count 4 | Loss, RTT, jitter |
| TCP connect | `tcp` port 80 | Handshake time to HTTP |
| TCP connect | `tcp` port 443 | Handshake time to HTTPS |
| TLS / certificate | — | **Not available yet** (agent-side work) |
| Traceroute | `traceroute`, 3 queries/hop | Per-hop loss and latency |
| TCP traceroute | `tcptraceroute` port 443 | The path a TCP session takes |
| Path MTU | `path_mtu`, per hop | The largest packet the path carries |

Two rules keep the list honest rather than tidy:

* **`available: false`** — reverse DNS and the TLS certificate check are in the
  catalogue but the agent cannot run them yet. They are **shown, disabled, with
  the reason** instead of hidden, so the list says what a connection test covers
  and what it will cover. The server refuses to dispatch them.
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
