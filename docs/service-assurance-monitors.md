# Service Assurance — monitors (the checks that are not a browser)

> Start with [the guide](service-assurance-guide.md) if you have not read it. This
> document describes one part of the module: the checks that do not drive a browser.

A **monitor** asks one question on an interval:

* does the mail we send actually arrive, and how long does it take?
* is SPF / DKIM / DMARC still published for our domain?
* is our sending address on a blacklist?
* can anyone still bind to the directory?
* is the clock on that host right?
* when does the certificate on port 993 expire?
* is that port open, and is the right service behind it?
* can the application still reach its database?

Every one of them fails **silently**. Nothing in a mail log says "this was accepted
and then dropped". Nothing reports that a DNS edit removed an `include:` from an
SPF record. A blacklisting happens entirely at the receiving end. These are found
today when a customer says "I never got your invoice" — which is the outage
already having happened, days ago.

The browser tests answer "can a user do X". Monitors answer the questions
underneath them.

---

## Why monitors are not tests

| | Service test | Monitor |
| --- | --- | --- |
| What it is | A list of browser intents (the DSL) | One protocol exchange |
| Where it runs | The worker process, with Playwright | The API process, like the certificate watcher |
| What it needs | A browser, an application, a journey | A host, a port, sometimes a credential |
| Its history | Runs and steps | One result row per check |
| Its schedule | `service_test_schedules` | `interval_sec` on the monitor itself |

Sharing a table would mean either giving the DSL steps it cannot execute, or
giving the worker runs it cannot claim. So monitors have their own two tables
(migration 094) and their own sweep.

---

## The catalogue

`src/serviceTests/monitors/types.js` declares every check type once — its fields,
their bounds, which are secrets, which hold a host, what it measures and which
observation layer its result belongs to. The validator, `GET
/api/service-tests/monitors/types`, the UI form and the checker registry are all
derived from it, so adding a type is one entry plus one checker file.

| Type | Measures | What it catches |
| --- | --- | --- |
| `mail` | delivery ms (or acceptance ms) | mail that is accepted and never arrives |
| `dns_record` | lookup ms | SPF/DKIM/DMARC/MX gone or weakened |
| `rbl` | lists | the sending address blacklisted |
| `ldap_bind` | bind ms | nobody can sign in |
| `db_connect` | query ms | rotated password, connection limit, dead replica |
| `ntp_offset` | \|offset\| ms | clock drift, which presents as five other faults |
| `tls_port` | days remaining | certificates on 465/636/993/3389 nobody has a reminder for |
| `tcp_port` | connect ms | a port that is open without the service being up |

### Mail, in two depths

**Send-only** runs the SMTP conversation and stops at the `250`: connect →
STARTTLS → AUTH → `MAIL FROM` / `RCPT TO` / `DATA`. It proves the server **took**
the message. It does not prove delivery — a full queue, a rewritten alias and a
spam filter all accept first and drop later.

**Round-trip** (`roundtrip: true`) sends the same message with a unique token in
the subject and in an `X-BlueEyes-Probe` header, then looks in the destination
mailbox over IMAP until the token shows up or the deadline passes. The
measurement is from our send to the receiving server's own `INTERNALDATE`, and
the probe message deletes itself once found (`cleanup`, on by default).

The SMTP and IMAP clients are written in this repo
(`monitors/smtpClient.js`, `monitors/imapClient.js`) rather than taken from a
library. Two reasons, and the second is the real one: no new dependency, and a
library reports "sent" or "threw" while this check exists to measure **where the
time went**. A server that authenticates in four seconds has a different problem
from one that queues for four seconds, and per-phase timings are not something a
`send()` helper hands back.

The phase is the diagnosis, and it decides the verdict:

| Phase it died in | Verdict | Whose problem |
| --- | --- | --- |
| connect / greeting / tls | `unreachable` | the network or the server |
| auth | `mail_auth_failed` (WARN) | **ours** — the probe's own credentials |
| envelope / data, 4xx or 5xx | `mail_rejected` | the server's policy, with its code |
| accepted, token never seen | `mail_undelivered` (CRIT) | the queue, a filter, a forward |

---

## The verdict vocabulary

Every check type answers in the same six words, so one list screen and one policy
can read them all:

| Status | Means |
| --- | --- |
| `ok` | the question was answered and the answer was good |
| `slow` | good, but over the operator's threshold |
| `failed` | the check ran and the answer was bad |
| `unreachable` | nothing answered; there is no answer to judge |
| `misconfigured` | the MONITOR cannot run — ours to fix, never the service's |
| `unknown` | no verdict could be formed |

`kind` is the finer-grained reason (`mail_undelivered`, `dns_record_missing`,
`rbl_listed`, …) and is what `monitors/policy.js` decides a severity from. Every
kind has a plain-language explanation — what it means, the likely cause, and what
it costs — stored on the incident, because an operator woken at 02:00 deserves a
sentence rather than an identifier.

### Nothing watches until it has worked once

A monitor is created **pending**: saved, listed, checkable by hand — and not
swept. The first check that comes back `ok` or `slow` stamps `activated_at`, and
from that moment it runs on its interval like anything else.

The reason is the failure this feature would otherwise cause: before the gate, a
new monitor was due the moment it was saved, so a mistyped mail server failed
every interval and opened an incident. An operator would find out about their own
typo as an outage, at two in the morning, from an alert.

**While pending, a failing check opens no incident and sends no alert.** The
result rows are stored — they are how the operator sees *why* it will not start —
and nothing else happens.

**`POST /monitors/:id/activate` is the override**, and the gate needs one: when
the service is genuinely down at the moment you create the monitor, watching it
is exactly what you want. Activation is idempotent and keeps the date it first
started watching, because that is what "watching since" means.

On upgrade, every monitor that had already run keeps running (migration 095) — an
upgrade that silently paused an estate's monitoring would be the worst possible
reading of this.

### Starting it, and stopping it

There is no "run once" monitor. `interval_sec` **is** the monitor: once the gate
has opened, the sweep takes it every interval, day and night, and nothing stops
it on its own. Two things stop it, and the screen names both:

* **Pause** — `PATCH /monitors/:id { "enabled": false }`. The sweep skips it
  (`dueForCheck` filters on `enabled = 1`); the history, the settings and the
  incidents all stay. Resume puts it back on the same interval. This is the
  button to reach for; it was missing at first, and the only way to stop a
  monitor was to delete it, which throws the history away with it.
* **Delete** — the monitor and its results go.

Lowering the interval to zero is not one of them: the floor is
`monitors.minIntervalSec` (60 by default, never lower), and
`GET /monitors/types` serves it as `limits.min_interval_sec` so the dialog can
put it on the input and say it in the help text rather than let the operator
discover it by being rejected.

### What pages, and what does not

* **One bad check is not an outage.** A failure waits for the operator's failure
  streak (`assurance.failureStreak`, default 2).
* **Except where the condition is simply true.** A certificate expiring, a record
  that is gone, an address that is listed — these do not become more true by
  being checked twice.
* **Our own misconfiguration is a WARN and stays one.** A monitor whose password
  is wrong is not an outage, and paging somebody because BlueEyes mistyped a
  credential is how alerting loses its audience.
* **Silently lost mail is a CRIT.** Nothing else will ever report it.

---

## The flow

```
monitor sweep (its own job, default every 60 s, API process)
  → monitors due by interval_sec
  → in `concurrency` lanes: runner.run(monitor)
       checker does its protocol exchange, with a hard cap
       thresholds re-judge a healthy result as `slow`
  → service_monitor_results  (one row per check — the history)
  → service_monitors         (last status, last summary, failure streak)
  → service_observations     (one typed fact, the same store runs write to)
  → policy → open / escalate / resolve one incident per monitor
  → alerts, grouped, on a state CHANGE only
```

The sweep is a separate job from the certificate/test sweep for a plain reason: a
TLS handshake takes a moment and a mail round-trip can wait five minutes for
delivery. Sharing a timer would mean running one of them on the other's schedule.

Both jobs share the reactor's alert batch, so a sweep sends one grouped alert per
problem rather than one message per row.

---

## API

Mounted under the licensed, authenticated `/api/service-tests` mount. Reads are
viewer+, writes operator+.

| Method | Path | Role | Answers |
| --- | --- | --- | --- |
| `GET` | `/monitors/types` | viewer+ | the catalogue the UI builds its form from, plus `limits` (`min_interval_sec`, `max_interval_sec`, `max_ms`, `max_monitors`, `recipient_domains`) |
| `GET` | `/monitors` | viewer+ | list (filters: `application_id`, `type`, `enabled`) |
| `POST` | `/monitors` | operator+ | 201, or 400 `{ error: 'Validation failed', details }` |
| `GET` | `/monitors/:id` | viewer+ | the monitor + its last 20 results + a 24h summary |
| `PATCH` | `/monitors/:id` | operator+ | 200 / 400 / 404 |
| `DELETE` | `/monitors/:id` | operator+ | 204 / 404 |
| `POST` | `/monitors/:id/check` | operator+ | runs it NOW — 200, or 409 while one is already running |
| `GET` | `/monitors/:id/results` | viewer+ | history + summary (`limit`, `hours`) |
| `GET` | `/monitors/:id/series` | viewer+ | availability per bucket for the chart (`period`, `at`, `tz_offset`) |
| `POST` | `/monitors/:id/activate` | operator+ | the activation override — 200 (idempotent) / 400 / 404 |

A manual check answers 409 rather than queueing: two probes racing for one
mailbox delete each other's message and both report "undelivered".

### The series

`GET /monitors/:id/series?period=day|week|month|year&at=&tz_offset=` answers the
question the 24-hour number cannot: **is it getting worse?** A mail monitor at
100% whose delivery time tripled over a week is the finding, and no single
percentage shows it.

It reuses `stats/period.js` — the same calendar the run-history charts use, cut
in the VIEWER's time zone, so "this week" means one thing across the product.
Every bucket in the period is returned, empty ones included: a gap is the reading
an operator needs ("it stopped checking on Thursday"), and it only exists if the
empty buckets are in the answer.

Two rules in the numbers:

* `ok` and `slow` are **available** (the exchange worked); `failed`,
  `unreachable` and `misconfigured` are not.
* `unknown` counts towards neither. It is the outcome that says nobody managed to
  look, and folding it into either side would invent a fact. It stays in `checks`
  so a bucket still adds up.

A bucket where nothing was judged reports `availability: null`, never `0` — the
screen draws that as a gap rather than as a bar at the bottom, because "nothing
ran" and "everything failed" are different statements.

### Result shape

```json
{
  "id": 812, "monitor_id": 7, "status": "ok", "kind": null,
  "checked_at": "2026-09-15T08:12:03.221Z",
  "value": 4130, "unit": "ms", "duration_ms": 4130,
  "timings": { "connect": 24, "tls": 61, "auth": 38, "data": 142, "delivery": 4130 },
  "summary": "Delivered to mailprobe@kunde.dk in 4.1 s (accepted in 142 ms).",
  "detail": { "smtp_code": 250, "queue_id": "4bXk2", "measured": "delivery", "attempts": 2 },
  "trigger_source": "manual"
}
```

---

## Security

Three controls, each deliberate:

1. **The permanent deny-list applies to every host field.** A monitor is an
   outbound connection the server makes on a schedule with credentials attached,
   so loopback, link-local and the cloud metadata address are refused — the same
   rule `security/hostPolicy.js` applies to a browser test. Private LAN addresses
   are allowed: the directory, the relay and the database live there, and that is
   the point of on-prem software. (A mail server on the BlueEyes host itself is
   therefore monitored by its LAN address, not by `127.0.0.1`.)
2. **A mail monitor may only send to an allowlisted domain** when
   `monitors.mailRecipientDomains` is set (Settings → Service Assurance,
   comma-separated). Empty means no restriction. Without that setting filled in,
   "send a mail and measure it" is a scheduled mail sender pointed at any address
   on the internet.
3. **A database monitor may only run a single SELECT.** Refused by the validator
   and again by the checker: a scheduled statement that can write is a scheduled
   accident.

Secrets (SMTP, IMAP, bind and database passwords) live in one AES-256-GCM blob
through the same `secretBox` the credentials table uses. `list()` and
`findById()` report `has_secrets: { smtp_password: true }` and never the value;
only `findByIdWithSecrets()` decrypts, and only the checker calls it. On an
update an absent secret is left alone, a value replaces it, and `''` clears it.

**The form only shows what applies.** A field can declare `showWhen` in the
catalogue — a DKIM selector belongs to the DKIM preset, the mailbox fields belong
to a mail check with round-trip on — and the form hides the rest. It is a display
rule, not a validation one: a hidden field keeps its value, so switching the
preset back does not lose what was typed, and a sometimes-hidden field can never
be required (the surface sweep asserts both).

**Types are checked, not coerced.** Text fields take text: a number sent as
`smtp_host` would be accepted as the host `"42"` and an object as
`"[object Object]"`, and both would then be monitored on a schedule forever. An
integer field accepts the digits a browser form posts (`"587"`) and nothing else
— `Number(true)` is `1` and `Number('1e3')` is `1000`, and neither is a port
anybody typed. `config: null` on a create is an empty configuration, not an
absent one. Unknown keys in `config` are dropped: the config is a declared shape
from the catalogue, not a bag, so `__proto__` and friends never reach storage.
A default is read with `numOrNull`, never `Number()` — `Number(null)` is `0`,
which would turn "no warning window set" into "warn zero days ahead", i.e.
never.

Interval floor: 60 s by default (`monitors.minIntervalSec`), and at most
`monitors.maxMonitors` (200) monitors. A mail probe sends a real message to a
real mailbox; both limits exist so this feature cannot be turned into the thing
the blacklist monitor warns about.

---

## Settings

Settings → Service Assurance, section `monitors`:

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | the sweep runs at all |
| `notify` | `true` | incidents are sent as well as recorded |
| `sweepIntervalMs` | `60000` | how finely the sweep can honour an interval |
| `minIntervalSec` | `60` | the floor under a monitor's own interval |
| `maxMonitors` | `200` | how many monitors may exist |
| `concurrency` | `4` | checks run side by side in one sweep |
| `hardCapMs` | `1800000` | a check that has not finished by here is abandoned |
| `resultRetentionDays` | `90` | how long result history is kept |
| `mailRecipientDomains` | `''` | the recipient allowlist (empty = unrestricted) |

Severity still comes from `assurance.failureStreak` and the certificate windows,
so the two halves of the reaction layer are tuned in one place.

---

## What is deliberately not here

* **RADIUS, DHCP, SMB and IPP checks.** All four are useful and all four need a
  protocol implementation of their own; `tcp_port` covers "is it listening"
  today.
* **An HTTP monitor.** The agents already probe HTTP, curl and page loads
  (`docs/probe-outages.md`), and Service Assurance drives a real browser. A third
  HTTP check would be a third answer to one question.
* **Anything that writes.** No test mail to a customer's real address, no
  database write, no directory modification. Everything a monitor does is a read
  or a message to a mailbox the operator owns.

---

## Where the code is

| Piece | File |
| --- | --- |
| The catalogue | `src/serviceTests/monitors/types.js` |
| SMTP / IMAP clients | `src/serviceTests/monitors/smtpClient.js`, `imapClient.js` |
| The checks | `src/serviceTests/monitors/checks/*.js` |
| Verdict → severity | `src/serviceTests/monitors/policy.js` |
| type → checker, the runner | `src/serviceTests/monitors/registry.js` |
| Storage | `src/serviceTests/storage/monitorsRepository.js`, `monitorResultsRepository.js` |
| Validation | `src/serviceTests/validation/monitors.js` |
| HTTP | `src/serviceTests/api/monitors.js` |
| The sweep + the job | `src/serviceTests/assurance/reactor.js` (`sweepMonitors`, `createMonitorsJob`) |
| UI | `public/serviceAssurance.js` (`views.monitors`), nav tab **Monitors** |
| Schema | `migrations/094_create_service_monitors.sql` |

## Where an operator is told about this

* **Service Assurance → Monitors** — the screen itself.
* **The Service Assurance guide** (Guides → Service Assurance), step *Monitors*:
  what the checks are, the two mail depths, the recipient allowlist, and an
  action card that creates the mail check through this same API.
* **Documentation → "Check that mail arrives (and the other silent failures)"** —
  the in-app handbook article, viewer+.

## The suites that keep it honest

Beyond the per-check specs:

* `monitors/__tests__/surface.test.js` — sweeps the module's own source: every
  export must have a caller (dead code fails the build), every catalogue entry
  must be complete (a declared secret must be a secret field, a declared host
  field must exist, and every field typed as a host must be declared — that last
  one is what caught `hostFields` being decorative), every default must be inside
  its own bounds, every failure kind must be classified AND explained, and the
  status vocabulary the checkers return must be one the database column accepts.
* `api/__tests__/monitorsHostile.test.js` — every wrong shape at every route
  (strings where objects belong and objects where strings belong), both GETs
  swept with hostile query parameters, and each repository method made to throw
  so the 500 path is a clean error rather than a crash.
