# System health — is BlueEyes itself all right?

`GET /system/self` (viewer+), `src/system/selfHealth.js`, and the screen at
**Administration → System health** (`public/views/systemHealth.js`).

Every other screen answers with data this server collected. This one answers
whether it could collect anything at all.

## Three states, never two

| state | means |
| --- | --- |
| **ok** | we measured it and it is fine |
| **failing** | we measured it and it is not |
| **unknown** | we could not measure it, so we cannot say |

A two-state version — healthy or not — has to file "could not read" under one of
them, and either choice is a lie. Filed as healthy, a dead probe reads as a
working system; filed as failing, a feature nobody switched on pages somebody at
3am. So `unknown` is a first-class answer: it is never rendered green, never
counted as fine, and every signal that returns it says **why** in one sentence.

The overall state is the worst present, and `unknown` is **not** rounded down:

```
failing > unknown > ok
```

"Eight ok, three unknown" is not a healthy system. It is a system we can only
partly see, and the thing we cannot see could be the thing that is broken.

## The signals

Each is composed from something another screen already reads — this endpoint
measures nothing new.

| signal | ok | failing | unknown |
| --- | --- | --- | --- |
| `database` | `db.ping()` answered | — | ping threw, or no probe wired |
| `telemetry` | TSDB answered | — | **not enabled** (the default) |
| `license` | valid | grace, expired, invalid | licence manager not wired |
| `signing` | this server can sign | a key is stored but cannot be decrypted, or there is none | verify-only (public key, no private half) |
| `trustKeys` | both anchors unchanged | unacknowledged drift | guard not wired |
| `agents` | all reporting | some not reporting | **no agents enrolled** |
| `ingest` | newest sample < 15 min old | newest sample older | nothing ever stored |
| `commandQueue` | nothing waiting, or waiting by design | — | queue not wired |
| `assuranceWorkers` | a heartbeat in the last 2 min | none | **Service Assurance not enabled** |
| `backgroundJobs` | all started | one failed to start | none has run yet |
| `storage` | disk below 85% | 85%+ / 95%+ | **disk usage unreadable** |

Two of those deserve their reasoning spelled out:

- **No agents enrolled is `unknown`, not `ok`.** A monitoring system with
  nothing reporting is not healthy, it is blind.
- **An unreadable disk is `unknown`, never 0%.** `Number(null)` is `0`, and 0%
  full is the healthiest possible disk — so the probe uses `numOrNull`
  (`src/lib/num.js`). The validation gate enforces this pattern across the
  codebase, and it caught this file.

## It cannot fail

Every probe runs, in parallel, every time, and a probe that throws becomes
`unknown` with its message. The route therefore cannot 500 because a subsystem
is down — which is the one thing a health endpoint must never do. A screen that
breaks when something is unhealthy is worse than no screen.

## What it does not yet know

`backgroundJobs` reports what each job's **start** did, not what its last tick
did: nothing in those jobs records a tick outcome, so the signal says "N started,
none failed to start" and claims no more. Per-tick tracking is a change to every
job and belongs in its own commit rather than half-done here.

There is also no history: the endpoint answers for *now*. "This has been
unknown for six hours" is a more useful sentence than "this is unknown", and it
needs somewhere to write the samples.
