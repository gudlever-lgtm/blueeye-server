# Burst mode — one target, once a second, while the fault is happening

> The agent reports once a minute and the baselines are hourly. A five-second
> loss event never reaches the data at all, which means the fault a technician
> is standing in front of, on the phone, right now, does not exist in BlueEyes.
> Burst mode is the tool for that moment: not a new metric, a temporary
> resolution.

**Nav:** Diagnostics → Burst mode · **API:** `/api/burst`
**Agent:** `blueeye-agent/src/burst.js` · **Table:** `burst_runs` (migration 107)

---

## The shape of it

```
      dashboard                  server                        agent
      ─────────                  ──────                        ─────
  POST /api/burst  ──────▶  burstValidation.js   refuses out of range
                            burstService.start   row FIRST, id = command id
                                   │
                                   │  { name: 'burst', id, target, … }
                                   ▼
                              /ws/agent  ────────▶  burst.js  clamps, then
                                                    one probe per tick
                                   ◀────────────────  burst_sample per tick
       live chart  ◀──── notifyDashboard
                                   ◀────────────────  command-result { samples }
                            burstAnalysis.js   median + MAD, cluster the losses
                                   ▼
                              burst_runs        samples + the VERDICT, stored
```

The run id **is** the command id. The row is written before the command goes
out, so a result can always be matched back to the run that asked for it — no
correlation table, and no window in which samples arrive for a run that does not
exist yet.

---

## The sentence is the output

A burst produces "6.3 % loss, median 1.4 ms, jitter 0.4 ms". That is a row of
figures, and the technician already knew something was wrong or they would not
have run it. What they cannot see from a number is whether the loss is **spread
out** or **arrives in groups** — and that is the whole diagnostic value:

| Shape | What it reads as | Where to look |
| --- | --- | --- |
| `clean` | No loss in the window | Not this path dropping packets right now |
| `even` | Single losses, irregular gaps | Something continuously wrong: congestion, a duplex mismatch, a bad cable |
| `clustered` | Losses in groups, quiet between | Something that recurs: a spanning-tree reconvergence, a link renegotiating, a scheduled job, an interferer |
| `edge` | One run of losses at the very start or end | Usually the measurement starting or stopping, not the path |
| `total` | Every sample lost | Unreachable, not degraded |
| `insufficient` | Fewer than 10 samples | Two losses in six samples is not a pattern, it is two losses |

`src/probes/burstAnalysis.js` decides this, in code, deterministically — never
by a model. It uses the same `median` + `mad` helpers as the rest of the
analysis (`src/analysis/baselines.js`), because a second definition of "typical"
in this codebase is a second thing to keep honest.

### The one that is easy to get wrong

Five isolated losses in sixty seconds are periodic **only if the gaps are
alike**. Random 5 % loss also produces a median gap of twelve, and calling that
"every 12 seconds" sends somebody hunting for a scheduled job that does not
exist. So the test is the **spread** of the gaps, not their size: MAD against
the median, and only a relative spread of 0.25 or less (with at least three
clusters) is called regular.

---

## The caps are in two places, and neither is redundant

A burst is a **packet generator**. The thing that emits the packets must not
depend on the thing that asked for them having validated correctly — a future
server with a bug, or a replayed frame, must not be able to turn an agent into a
flood.

| | Server (`src/validation/burstValidation.js`) | Agent (`blueeye-agent/src/burst.js`) |
| --- | --- | --- |
| Duration | 5–120 s, **refused** outside | ≤ 120 s, **clamped** |
| Rate | 0.2–2 Hz, **refused** outside | 0.2–2 Hz, **clamped** |
| Probe | `ping` · `tcp` · `dns` | same three, anything else becomes `ping` |
| Concurrency | — | one burst at a time, per agent |

The asymmetry is deliberate: a person filling in a form should be told 3600 is
too long, while an agent handed a bad number mid-fault should still measure
something. What was asked for is stored beside what ran (`requested_seconds`),
so a short run is explainable rather than suspicious.

Only probes that **fit in one tick** are offered. A traceroute or a page load
takes longer than the interval, so every tick would overlap the last. The tick
also subtracts the time the probe itself took, so the cadence stays at 1 Hz
rather than drifting to "1 Hz plus however long a ping takes" — a chart whose
x-axis is a lie is worse than no chart.

---

## Routes

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/burst` | viewer+ | Recent runs, **without** samples. `agentId`, `limit` (≤100), `offset`. 404 for an unknown `agentId` |
| `GET` | `/api/burst/:id` | viewer+ | One run **with** its samples — the only read that carries them. 400 on a non-numeric id, 404 when there is no such run |
| `POST` | `/api/burst` | **operator+** | Starts one. **202** — the agent measures. 400 on validation, 404 unknown agent, 409 agent not connected (with the `runId` of the recorded failure), 503 when no agent channel is wired |
| `POST` | `/api/burst/:id/stop` | **operator+** | **202**; the agent stops at its next tick and reports the partial run. 409 if the run already finished or the agent is gone |

**Why operator and not admin.** Reading a finished burst is viewer+: it is a
measurement, the same class as a probe result. Starting one makes an agent emit
traffic at a rate nothing else here does, which is an operator's call — but not
an admin's, because the person standing in front of the fault at 02:00 is
usually not an admin, and a tool they cannot reach is a tool that does not
exist.

**Ownership.** A `command-result` may only complete a run that was dispatched to
**that** agent, so one agent cannot write another's measurement. A duplicate
result (a reconnect replaying a frame) leaves the first answer standing:
re-analysing would overwrite a stored verdict with an identical one at best, and
a truncated one at worst.

---

## Why the samples are a JSON column

A burst is at most 120 seconds at 2 Hz: 240 points, bounded, written once and
read as a whole. That is a small **field**, not a time series. A row-per-sample
table would add a hot-path insert loop, a second retention dimension and a join
to every read, to store something that is never queried across runs, never
aggregated and never grows after the run ends.

`probe_results` is the opposite case and stays as it is: unbounded, appended
forever, queried across time. The difference between the two is exactly why this
one is a column.

The **verdict** is stored beside the samples for the same reason every finding
in this product carries its explanation: the row reads the same in a report six
weeks later as it did on the screen, and nothing re-derives a verdict from data
that has since aged.

---

## Live samples

Each tick arrives from the agent as a `burst_sample` message and is forwarded
straight to the dashboard as `burst-sample`, so the chart grows while the
measurement happens. A dropped frame costs one
point — the authoritative series arrives with the finished run, and the screen
redraws from it. **No verdict is shown live**: the shape is computed from the
whole series, once there is one.

The finished run does not arrive on the socket. The screen polls
`GET /api/burst/:id` until the row is no longer `running`, with a deadline of
the run length plus thirty seconds; past that it says the agent stopped
reporting and keeps what did arrive.

A run whose agent goes away between the command and the result would sit at
`running` forever and read as live. The next `POST /api/burst` reconciles
anything still running after five minutes — a burst lasts at most two — and
marks it failed with *the agent never reported the result*. There is no sweeper
for this and there does not need to be: the only person who cares is the one
about to look at the list, and they are here. If that housekeeping fails, the
burst still starts.

---

## Retention

`RETENTION_BURST_DAYS`, default **90** — longer than the telemetry around it.
A burst is a measurement somebody chose to take while standing in front of a
fault, and its verdict gets quoted in a report weeks later; there are a handful
of rows a week, not a stream, so keeping them is cheap. Deleting the run takes
its samples with it, because they are a column on the row.

---

## Where things are

| | |
| --- | --- |
| Analysis (pure) | `src/probes/burstAnalysis.js` |
| Dispatch + recording | `src/probes/burstService.js` |
| Route | `src/routes/burst.js` · validation `src/validation/burstValidation.js` |
| Storage | `src/repositories/burstRunsRepository.js` · migration `107_create_burst_runs.sql` |
| Live frames | `src/ws/agentSocket.js` (`burst_sample` → `notifyDashboard`) |
| Screen | `burstView()` + `burstChart()` in `public/app.js`, keys `burst.*` (en+da) |
| Agent | `blueeye-agent/src/burst.js`, command recognisers in `src/command.js`, handler in `src/runtime.js` |
