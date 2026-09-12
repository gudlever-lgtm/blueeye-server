# Service Assurance — the guide

**Start here.** This is the one document written to be read front to back. The
others are designs of record: precise, long, and organised around how the thing
was built rather than how it is used.

Service Assurance watches your web applications the way a user does — a real
browser, signing in, clicking through, checking the page said what it should —
and tells you what broke, where, and what to look at next.

---

## What it does, and what it will not do

It runs **user journeys** against your services on a schedule, from a real
browser, and turns what it sees into typed facts it can reason over. When
something fails it says which layer failed, ranks the likely causes, opens an
incident, and can tell you whether the same thing has happened before.

It will not:

- change a test, a selector or a setting on its own;
- run shell commands or arbitrary code;
- remediate anything, ever;
- reach any address you have not allowed;
- send a credential anywhere.

Those are design constraints, not defaults. There is no switch that turns them
off, because the value of an automated monitor that can also *act* on a
production system is not worth what it costs when it is wrong.

---

## Before you start

Three things have to be true.

**The licence covers it.** Service Assurance is a Professional-tier feature
(`service_tests`). Without it every route answers 403 and the nav entry is
hidden. An anonymous request answers 401 rather than telling an unauthenticated
caller which features you have bought.

**A worker is running.** The browser work happens in its own process, never
inside an API request — a Playwright run holds a browser for seconds to minutes,
and the API has to stay responsive:

```
npm run service-test-worker
```

Without it, tests queue and never run. The Runs screen says so at the top rather
than leaving you to work it out from a list that never changes.

**You are an operator or an administrator.** The whole module is operator+: a
crawl is real traffic against a customer's system and somebody will see it in
their logs. Viewers cannot reach any of it.

---

## 1. Register the application

**Applications → New.** A name and the address people actually open
(`https://…`). That address is the anchor for everything else: the allowlist, the
certificate watch, discovery, and every test's default base URL.

Add **environments** if you run more than one (production, staging). A test can
then be run against either without being rewritten.

Add a **login** under the application if your journeys need one. The secret is
encrypted at rest, is never returned by the API, and reaches exactly one place:
the worker, which decrypts it and seeds the redactor with its value before a
single step runs. Every string that comes back out of a run passes through that
redactor first.

---

## 2. Allow the addresses it may reach

**This is the step people skip, and then discovery finds one page.**

The browser will only open the application's own address and the hosts you have
explicitly allowed. Entries are a `host`, an `ip`, or a `cidr`. If your
application pulls its API from a second host, that host needs an entry or every
one of those calls is refused — and refused by BlueEyes, not by a firewall,
which is a distinction the analysis is careful to make later.

Four ranges can never be allowed at any permission level:

| Range | Why |
| --- | --- |
| `127.0.0.0/8` | loopback — a test browser could reach BlueEyes' own API from the server's own network position |
| `169.254.0.0/16` | link-local, including the `169.254.169.254` cloud metadata endpoint — the classic pivot |
| `0.0.0.0/8` | unspecified |
| broadcast | — |

The same refusal applies to a CIDR that merely *covers* one of them.

---

## 3. Discovery — let it look around

**Applications → your application → Discover.**

Discovery crawls the application read-only. It never submits a form and never
clicks anything whose effect it cannot determine — anything ambiguous is recorded
and left alone. It comes back with pages, forms, elements, and **suggestions**:
tests worth having, and the journeys those tests add up to.

### Signing in first

A logged-out crawl sees the front page. Everything behind the login — where the
real journeys are — is invisible. The Discover dialog offers two ways in:

- **Use a login test** — replay a test that already signs into this application.
  Only tests that sign in *and change nothing* are offered; discovery reads.
- **Use a stored login** — fill in the login form an earlier crawl found. Needs
  no test at all, which is what makes the first authenticated discovery possible
  on a brand new application.

The second bootstraps the first. Run one anonymous discovery, and the next one
can sign in with nothing but a stored login.

**If it could not sign in, it says so.** The page counts of a failed
authenticated crawl look exactly like a successful one — because they are, of
the public site. The note beside them is the only thing that says which you are
looking at, so it reads as a warning rather than a caption. The same applies if
the session is lost halfway: the crawl **stops** rather than carrying on
anonymously and reporting the result as the private map.

---

## 4. Accept tests, or build them

**Suggestions** can be accepted as they are. Or:

- **Tests → New** and drag steps into order. No code. 23 step types,
  from `open` and `click` to `assert_text_contains` and `api_request`.
- **Tests → Record a journey** — drag the recorder to your bookmarks bar, open
  your application, sign in as yourself, click the bookmark and perform the
  journey. You get the same editable step list the designer produces, because a
  recorded test is an ordinary test.

Password fields are never recorded as values. A field the recorder judges to be
a password becomes a reference to the application's stored login, so the test is
driven by that login rather than pinned to one person's account.

---

## 5. Journeys — what makes a set of tests mean something

**Journeys → New.** A journey is a complete thing a user does — sign in, look up
a customer, open the case — and the tests under it are how BlueEyes proves it
still works.

Each step is **required** or **optional**, and each journey has a criticality:
`critical`, `high`, `normal` or `low`.

| Something failing | Verdict |
| --- | --- |
| a required step | the journey FAILED — the user cannot get through |
| an optional step | DEGRADED — part of the service is gone, the journey is not |
| a critical journey | the whole service reads as FAILED |

Every verdict carries the sentence explaining it. The verdict is computed on
read, never stored, so it cannot drift from the runs underneath it.

---

## 6. Schedules

**Schedules → New.** Five cadences: every minute, 5 minutes, 15 minutes, hourly,
daily.

The next run is measured from the last one, so a worker that was down catches up
rather than resetting its clock. A due schedule is stamped *before* the run is
created, so a slow queue cannot fire the same schedule twice.

---

## 7. When something fails

### The run

**Runs → the run.** Top to bottom: the verdict, how long it took, which step
failed, and the failure in plain language with the technical detail behind a
disclosure. If a baseline exists, whether it was slower than this test's own
normal — measured with median + MAD, so one thirty-second timeout does not drag
"normal" up until nothing ever looks slow again.

### Why did this fail?

Below the failure, the analysis. First the **chain** — what failed, what was
checked and found fine, and **what nobody looked at**:

```
✗  Search failed
✗  GET /api/search → HTTP 500
✓  network reachable — /api/me answered
?  infrastructure was not checked
```

That third line is what the conclusion is worth. A verdict reached while nobody
checked the network has a hole in it, and the hole is on the screen rather than
in a footnote.

### The ranked causes

Then the causes, ranked, out of 14: DNS, network, firewall, TLS, load
balancer, web server, authentication, API, application, database, dependency,
timeout, configuration, browser/client.

**Each one says how it is known**, and this is the part to read carefully:

| Basis | Means |
| --- | --- |
| **seen** | BlueEyes observed it. A TLS handshake that failed is a TLS failure. |
| **deduced** | Inferred from something else. A 502 means a gateway answered for an upstream that did not — no proxy was inspected. |
| **not visible to BlueEyes** | It cannot see this from a browser at all. A place to go and look, never a finding. |

A database is always the third kind. BlueEyes observes DNS, TLS, HTTP status and
timing; it never observes a database, and "the database is slow" from an HTTP 500
is a hypothesis. A supposed cause can never outrank a watched one, however much
evidence piles up behind it.

If the top two are close, the summary says it could be either. A leader four
points clear is an artefact of the arithmetic, not a conclusion.

Two distinctions worth knowing, because they decide which building you walk to:

- **"BlueEyes' own configuration"** means the allowlist refused the address.
  Nothing at the other end was ever contacted. That is a setting here, not a
  fault in the service.
- **"One API endpoint"** rather than "the application" means its neighbours
  answered. A far narrower fault, and a much shorter log to read.

---

## 8. Service health

**Applications → your application.** A number out of 100, with the four parts it
is made of and the weight each carries:

| Part | Weight |
| --- | --- |
| Journeys (functional) | 45% |
| Reachable (availability) | 25% |
| API | 20% |
| Speed (performance) | 10% |

A part nobody measured reads **not measured** and is left *out* of the number
rather than counted as zero — an unmeasured part scored as zero is a service
reported broken because nobody looked at it. A service nothing has run against
shows a dash, not a 0.

The score exists to be argued with. If you cannot see why it is 74, it is not
doing its job.

---

## 9. Incidents

**Health** lists everything currently wrong. Open one.

An incident is one durable row per *thing* — a test, a certificate — so a service
down all weekend is one incident with 400 occurrences, not 400 incidents.
Severity only ever moves up while it is open, so a service flapping between a 503
and a timeout cannot quietly downgrade itself out of your alert threshold.

**The lifecycle:**

```
open → investigating → identified → resolved → closed
```

with the sensible ways back. Picking one up acknowledges it, which is what stops
alerting escalating something somebody is already working on. A closed incident
stays closed — if it happens again, that is a new incident.

**The timeline** is built from actual events, never a narrative written
afterwards, and each entry says what caused it: a run, a check, the analysis, or
a person. An incident with nothing recorded says so rather than having a history
invented from the row.

**Recurrence** answers the question the occurrence count does not: *was it ever
fixed?* A problem that returns within hours of being resolved was waited out. Gaps
that are closing mean it is getting worse. And if it has a rhythm — "every Monday
around 09:00" — that names a batch job somebody can go and look at. That claim
needs 4 occurrences and a weekday that holds for every one of them; below
that it says what it would have needed rather than guessing.

**Affected users is always Unknown.** BlueEyes does not know, and it will not
invent a number.

---

## 10. Alerts

Alerts go out through the same channels as every other BlueEyes finding — email,
webhook, syslog — configured once in **Settings → Alerting**. Severity floors,
cooldowns and maintenance windows apply to a certificate expiry exactly as they
do to a throughput anomaly.

An alert is a **state change**, not a heartbeat:

| Transition | Alert |
| --- | --- |
| nothing → open | yes, at the incident's severity |
| open → same or lower severity | no — it has already been reported |
| open → higher severity | yes |
| open → resolved | yes, at INFO |

**And one alert per problem, not per incident.** If `/api/auth` starts returning
500 and three journeys go red, that is four incidents and one problem — sent as
four messages at 03:00 it is four pages about one thing, and the fourth teaches
whoever is carrying the phone to stop reading them.

Grouping is on observed evidence only: a failing dependency both incidents hit,
the same host-level fault on the same host, or the same correlated layer within
half an hour. Never on "they happened near each other" — that would eventually
swallow an unrelated outage and nobody would find out.

**Nothing is suppressed silently.** Every incident folded into a group is named
in that group's message. `Settings → Reactions → groupAlerts` turns it off if you
would rather see all of them.

**A failing notification never hides an incident.** If the send fails, nothing is
marked as notified, everything stays visible, and the next sweep tries again.

---

## 11. Shared dependencies

**Applications → your application → Shared dependencies.**

The service map draws journey → test → endpoint. One endpoint under five
journeys is the most important thing on that picture and is invisible in it —
just another box with more lines going in. This is the reading of it.

Reach is weighted by criticality, not counted: three low-criticality journeys are
not worth more than one critical one. An address you do not control is marked as
such — but only when BlueEyes was told your own address, because guessing that
an unfamiliar host is third-party is how a service gets blamed on its CDN.

**Journeys that have never run are named.** Their dependencies are unknown, not
zero, and a short list must not be read as a complete one.

---

## 12. AI assistance (optional, off)

There is no AI in Service Assurance until you configure a provider in
**Settings → AI**. Until then the incident screen says:

```
Rule-based analysis: available
AI: unavailable — this deployment has no AI provider configured.
```

Both lines, deliberately. "AI: unavailable" on its own reads as "no analysis",
which is the opposite of true.

With a provider configured, **Explain this incident** asks it to put the
rule-based conclusion into plain language and say what to check next. It is asked
to explain what BlueEyes already concluded, not to reach its own conclusion.

**What it is allowed to see is an allowlist**, and that is worth understanding
before you turn it on. Every field is chosen by name. It never sees: a
credential, a cookie, an authorization header, a hostname, which person picked an
incident up, or any free-form column a detector writes into. URLs are reduced to
a path shape with identifiers collapsed — `/api/customers/{id}/cases`.

The answer is labelled **a suggestion, not a finding**, sits below the
rule-based conclusion, and keeps the exact context it was given so you can check
it — including next month, when the incident has moved on.

Asking is operator+ and audited: it sends your data to a third party, and who did
that should be answerable later. Reading an answer is open to anyone who can see
the incident.

Provider choice is yours. Mistral, Scaleway, OVHcloud, IONOS and Aleph Alpha are
EU-hosted; a local model works too. Nothing in Service Assurance names a
provider.

---

## 13. Settings worth knowing

**Settings → Service Assurance.** The defaults are chosen to be dull. The ones
that change behaviour rather than tuning it:

| Setting | Default | What it does |
| --- | --- | --- |
| `assurance.enabled` | on | off stops the reaction sweep entirely |
| `assurance.notify` | on | off keeps incidents and sends nothing — what you want for the first week, while you find out how noisy your own estate is |
| `assurance.groupAlerts` | on | off sends one message per incident, as before V3 |
| `assurance.failureStreak` | 2 | consecutive failures before an incident opens |
| `assurance.certificateWarnDays` | 30 | how early an expiring certificate is a WARN |
| `assurance.certificateCriticalDays` | 7 | and a CRIT |
| `runner.concurrency` | 2 | how many jobs one worker takes per tick |
| `runner.accessibility` | on | the read-only accessibility check at the end of a run |
| `discovery.maxPages` | 100 | the crawl budget — also `maxDepth` 5, `maxRequests` 500 |
| `artifacts.retentionDays` | 30 | how long failure screenshots are kept |
| `assurance.incidentRetentionDays` | 90 | how long resolved incidents are kept |

An operator can tighten a discovery budget per run but never widen it past what
an administrator set here.

---

## 14. When it goes wrong

| What you see | What it means |
| --- | --- |
| Tests queue and never run | No worker. `npm run service-test-worker`. The Runs screen says so at the top. |
| Discovery found one page | The allowlist. Every off-application address was refused — by BlueEyes, not by a firewall. |
| "Could not sign in, so this is the public site only" | Exactly that. The counts beside it are the public site. |
| "No login form has been found on this application yet" | Run one discovery without signing in first. It will find the form; the next one can fill it in. |
| A test fails on an element that moved | Look for a **healing proposal** on the run. The engine found something it thinks you meant — it is a proposal, and nothing changes until you accept it. |
| "Only N earlier runs to compare with" | Not enough history for a performance baseline yet. 5 successful runs is the floor, and a band drawn through three is noise with a label. |
| Health shows a dash | Nothing has run against this service. Not a zero. |
| The AI panel says unavailable | No provider configured, or it is switched off, or the key is missing. The reason is on the panel. |

---

## 15. The other documents

| Document | What it is |
| --- | --- |
| [service-assurance.md](service-assurance.md) | **V1 design of record.** The engine, the designer, discovery, the scheduler, the security pass, the reaction layer. The longest and the most precise. |
| [service-assurance-v2.md](service-assurance-v2.md) | **V2 spec.** Journeys, recording, self-healing, the service map, performance baselines. |
| [service-assurance-v3.md](service-assurance-v3.md) | **V3 spec + what was actually built.** Observations, correlation, root cause, incidents and their timeline, alert grouping, the AI layer, and the hardening pass. Each phase has an "as built" section saying what differs from the spec and why. |
| [service-assurance-journeys.md](service-assurance-journeys.md) | Journeys in depth. |
| [service-assurance-recording.md](service-assurance-recording.md) | The bookmarklet recorder, and what it refuses to record. |
| [service-assurance-healing.md](service-assurance-healing.md) | Self-healing selectors: how a proposal is scored, and why it stays a proposal. |
| [service-assurance-accessibility.md](service-assurance-accessibility.md) | The accessibility check, and why it can never change a verdict. |
| [service-assurance-visual.md](service-assurance-visual.md) | Visual regression and baselines. |
| [CODEMAP.md](../CODEMAP.md) | Where the code is. Start here for a change rather than a question. |

**Read them in that order if you are new to the module.** The V1 document assumes
nothing; each later one assumes the ones before it.

---

## What it deliberately does not do

Worth stating, because every one of these has been asked for and refused on
purpose:

- **No autonomous remediation.** It will not restart anything, fail anything
  over, or change a production system.
- **No autonomous test changes.** A healing proposal is a proposal. A suggested
  test is a suggestion. Somebody accepts them.
- **No arbitrary code.** Not shell, not JavaScript, not a plugin hook.
- **It is not a CMDB.** The service map is recomputed from what runs observed. A
  relation that stops being observed stops being drawn, and there is no screen
  for editing it — the moment there is, the map has opinions of its own and the
  rot starts.
- **It is not an APM.** No agents in your application, no traces, no payload.
  Everything here is what a browser and a TLS handshake can see from outside.
- **It is not a load tester.** One journey at a time, on a schedule.
