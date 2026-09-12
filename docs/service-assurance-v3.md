# Service Assurance V3 — the specification

> **New to Service Assurance?** Read [the guide](service-assurance-guide.md) first — it is written to be read front to back. This document is a design of record.

*V1 and V2 are in `docs/service-assurance.md` and `docs/service-assurance-v2.md`.
Everything here builds on them; nothing here replaces them.*

## The product principle

V3 moves BlueEyes from **synthetic testing** to **service assurance
intelligence**. The difference is what it says when something breaks.

Not:

> Website failed. Test failed.

But:

> Customer Portal is degraded.
> Customer Search is failing because the Customer API is returning HTTP 500.
> Network and infrastructure appear healthy.
> This is a recurring issue, seen 12 times in the last 7 days.
> The affected business function is Customer Search.

Find the fault. Understand the fault. Understand the consequence. Give the
operator a better basis for a decision.

## The object model

```
Application → Service → User Journey → Test → Run
                                               ↓
                                         Observations
                                               ↓
                                           Evidence
                                               ↓
                                          Correlation
                                               ↓
                                        Service Health
                                               ↓
                                             Alert
```

The **User Journey** stays the central perspective. A technical fault is
interesting *because* it affects a service or a journey — not on its own.

## Guardrails

V1 and V2 must not break. Discovery, journeys, recording, the test DSL,
Playwright execution, the scheduler, API correlation, failure intelligence,
performance baselines, the service map, visual regression, accessibility, the
dashboards, history, auth and the database all keep working.

Every change is backward compatible, modular, documented, testable and
reversible. No rewriting what already works.

## What V3 deliberately does NOT do

Stated here so it stays stated. BlueEyes is service assurance; it is not trying
to become everything.

- No autonomous remediation, and no automatic production changes
- No arbitrary shell execution, no arbitrary JavaScript
- No unrestricted AI agents; no autonomous selector or test changes
- Not a CMDB, an ITSM, an APM, a SIEM, a load-testing platform or a complete
  observability platform

## The pieces

### Service Health 2.0

A service's health is one assessment made from testable inputs: test results,
journey criticality, API failures, performance degradation, repeated failures,
infrastructure evidence and recent history. Critical journeys weigh more than
normal ones.

States: `HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`.

`UNKNOWN` is a real state and not a synonym for healthy. A service nothing has
run against is not a service that works.

### Observations

The raw facts a run produced, typed and sourced: browser, page, API,
application, server, network, infrastructure. Everything downstream reasons over
observations rather than over screenshots and prose.

### Correlation Engine

Relates observations into a picture:

```
Customer Search FAILED
  → POST /api/customer/search
  → HTTP 500
  → Network OK
  → Server reachable
  → API failure repeated
  → Likely application/API issue
```

Correlation works on **evidence, never guesses**. Every result carries its
observations, the relations between them, a confidence, a timestamp, a source
and a conclusion.

### Root Cause Analysis

Failure intelligence, extended to **rank** possible causes rather than name one:
DNS, network, firewall, TLS, load balancer, web server, authentication, API,
application, database, dependency, timeout, configuration, browser/client.

A root cause is **an assessment from evidence, never an unconditional fact**, and
the screen says so. The evidence behind the conclusion is always shown.

### Incidents

Several related failures become one incident, so a single problem does not
produce fifty alerts.

States: `OPEN`, `INVESTIGATING`, `IDENTIFIED`, `RESOLVED`, `CLOSED`.

Every incident has a **timeline built from actual events** — not a narrative
written after the fact.

### Impact

V3 distinguishes three things that are routinely confused:

```
Technical failure ≠ Service impact ≠ Business impact
```

Where the number of affected users is not known, it says **Unknown**. It is never
invented.

### Alerting

Deduplication, suppression, cooldown, recovery, escalation, severity,
criticality. One cause producing three symptoms is one incident, not three
alerts.

Channels start with email and webhook; everything else is an adapter behind one
neutral notification interface.

A failing notification system must **never hide the incident**. If notification
fails, the incident stays active and visible.

### Anomaly detection

Simple statistical rules over the existing performance baselines — response
time, failure rate, API errors, journey duration. No ML is needed for the first
implementation, and the repo's rule (robust statistics, explainable, local)
stands.

### Health score

A transparent number, 0–100, broken into its parts (functional, performance,
API, availability). The operator must be able to see **why** it is 82. A
black-box score is worse than no score.

### Historical intelligence and recurrence

Trends for availability, failure rate, response time, incidents and health — and
recognition that a problem is not new:

> Similar incidents detected. Customer API, HTTP 500. 12 occurrences.

### Dependency intelligence

The service map, extended with **observed** dependencies. When one dependency
affects several journeys, saying so matters more than drawing it prettily:

> Multiple journeys affected by the same dependency.

### Test recommendations and test quality

Discovery plus historical observation suggests journeys worth testing — and the
user approves before anything is created. A simple, readable assessment of a
test's own quality (stable selector, assertion present, API correlation, a
performance threshold) helps people improve them.

## AI

AI is an **assistance layer, never an execution dependency.**

It may explain incidents, summarise, propose root-cause hypotheses, analyse
historical failures, suggest tests and draft incident summaries.

It may **not** change tests, change selectors, change configuration, execute
shell commands or arbitrary code, contact external systems without an explicit
integration, or make irreversible decisions.

It must always be able to show the evidence its analysis rests on.

### The abstraction

```
AI Provider → AI Service Interface → BlueEyes Analysis
```

No hardcoded provider in Service Assurance core. Mistral, OpenAI, a local LLM or
an enterprise LLM are all configuration.

### It must be switchable off

The system works fully without AI. When the provider is unavailable:

```
Test:                 FAILED
Rule-based analysis:  AVAILABLE
AI analysis:          UNAVAILABLE
```

AI analysis is **asynchronous** and never blocks a test run.

## Security and privacy

All V1/V2 controls stand. For AI specifically: no secrets, passwords, tokens,
cookies or authorization headers ever reach a provider. Masking and redaction
happen **before** persistence and before AI processing, through one central
redaction service rather than re-implemented per feature — the same argument
that produced `recording/secrets.js`.

Tenant isolation applies the whole way down:

```
tenant → service → journey → run → evidence → incident → AI analysis
```

No cross-tenant data, anywhere.

> **As built, this is a statement of intent and not of fact, and it is written
> down here so nobody reads it as fact.** BlueEyes is single-tenant on-prem —
> `README.md` and `docs/service-assurance.md` both say so. Fourteen tables carry
> a nullable `tenant_id` for forward compatibility and **no query anywhere
> filters on it**; the V3 tables (`service_observations`,
> `service_incident_events`, `service_ai_analyses`) do not carry the column at
> all, which is consistent with every other child table in the module.
>
> The isolation boundary today is the DEPLOYMENT. Whoever can authenticate sees
> the whole installation, which is correct for an on-prem product bought by the
> organisation whose services it watches. Making the sentence above true would
> mean a tenant clause on every read in the module, and that is a decision to
> take deliberately if multi-tenancy ever arrives — not something to assume is
> already in place.

Collect only what is necessary.

## Observability

Service Assurance must itself be observable: test execution, scheduler, workers,
API, correlation engine, AI calls, notification failures, database failures.

Metrics: tests executed, tests failed, incidents created, incidents resolved, AI
analyses, notification failures, execution duration.

## Failure modes

Everything new must fail safely. A component that cannot do its job says so and
gets out of the way — it never degrades a result it is not qualified to judge,
and it never takes a run down with it. This is the same rule that governs V2's
accessibility checks and visual comparison, and it applies to correlation, root
cause, alerting and AI alike.

## Implementation order

**Phase 1 — Core.** Service Health 2.0 · observation model · correlation engine ·
incident model · incident timeline

**Phase 2 — Intelligence.** Root cause analysis · historical intelligence ·
recurrence detection · dependency intelligence · anomaly detection

**Phase 3 — Operations.** Alert engine · email/webhook notifications · incident
dashboard · service health dashboard · impact assessment

**Phase 4 — AI.** Abstraction layer · incident analysis · summaries ·
recommendations · test suggestions

**Phase 5 — Hardening.** Security review · privacy/redaction review · performance
testing · regression testing · API documentation · migration verification

## Definition of done

V3 is finished when BlueEyes can monitor user journeys, collect technical
observations, correlate browser/API/network/infrastructure evidence, identify
related failures, create incidents, assess service health, assess impact, rank
likely root causes, show the evidence behind the conclusion, recognise recurring
problems, detect performance anomalies, send relevant alerts, analyse incidents
with AI when enabled, suggest new tests — and give the operator one answer to:

> What happened? Where? When? Why is it likely happening? What is affected?
> What should I investigate next?

## Data model

Likely V3 tables, reusing V1/V2 where possible and avoiding duplicate models:

```
service_services              service_service_dependencies
service_observations          service_correlations
service_incidents             service_incident_events
service_incident_evidence     service_health_snapshots
service_alert_rules           service_alert_events
service_notifications         service_ai_analyses
service_ai_providers
```

Note `service_test_incidents` already exists from V2 (the assurance reactor).
Where V3's incident model supersedes it, it is migrated rather than duplicated.

## API

Every V3 feature is reachable over REST, versioned under `/api/v1/...`:
services, journeys, runs, observations, incidents, correlations, health, alerts,
notifications, AI analysis.

---

## Phase 4 as built — the AI layer

**No provider is named in Service Assurance core.** The provider arrives as the
`ai` port (`isEnabled` / `status` / `analyse`), satisfied in `src/server.js` by a
thin adapter over the existing assistant. Mistral, a local model or an
enterprise LLM are configuration on the host side, and nothing under
`src/serviceTests/` can tell which it is talking to — a spec asserts that the
module's own source names none of them.

**Having no provider is the normal state**, not a failure. Every route answers
200 either way, the screen shows `Rule-based analysis: available` beside
`AI: unavailable`, and the reason is on the page — "switched off" and "no key
set" are different problems for whoever has to fix them.

**What a provider may see is an allowlist** (`src/serviceTests/ai/context.js`),
and that is the whole security argument rather than an implementation detail.
The obvious design — take an incident and strip what looks like a secret —
loses the first time a gateway puts a token in an error message in a format
nobody wrote a pattern for, and it loses silently. So every field is chosen by
name from a typed source; there is no spread anywhere in the file and a test
fails the build if one appears. A canary planted in every source object must not
turn up in the context.

Left out by name: `subject_key` (it encodes a host and port), host names
anywhere including inside free text, `actor_id` (which person picked an incident
up), and an observation's open `detail` column — two fields are taken out of it
individually. URLs are reduced to a path shape with identifiers collapsed.

The pattern scrub over free text is **defence in depth, never the first
control**. It caught a real bug in its own first draft: the Authorization rule
matched `\S+`, which ate the word "Bearer" and left the token after the mask.
The spec that asserted a mask was *present* passed on that happily; the one that
asserts the secret is *absent* is what found it. Every case in that spec now
pairs an input with the secret in it.

**An answer is a suggestion, and it is stored with the exact context it was
given** (migration 092). Not a pointer at today's data, which will have moved
on — "why did it say that" has to be answerable next month. The screen labels it
a suggestion, shows it *below* the rule-based conclusion, and lets the evidence
be inspected.

**It changes nothing.** There is no path from the layer to a test, a selector, a
setting or a shell, and a spec asserts the service exposes no function that
could create one. Asking is operator+ and audited: it sends a customer's data to
a third party, and who did that is answerable later. Reading an answer is open
to anyone who can see the incident.

---

## Phase 5 as built — hardening

Four things came out of it that were not documentation.

**A credential could reach the database through `network_errors`.** The
redactor is meant to be the single chokepoint every string passes through before
it is stored, and it was not: `console_errors` were masked and `api_calls` URLs
were masked, while `network_errors` — which carry a URL, and a URL is exactly
where a credential ends up when an application puts one in a query string — went
out raw. The value landed in `service_test_runs.network_errors` and, since V3,
in `service_observations` as well. Fixed at the source in `runner/execute.js`,
and `test/redactionChokepoint.test.js` now sweeps the WHOLE result rather than
the field that was wrong, so a field added later that forgets the redactor fails
the build.

**The service map made one query per test.** At the map's own cap of 200 tests
that was 200 serialised round trips on a page somebody opens while something is
already wrong, and the alert grouping did the same walk on every sweep. The
obvious fix — one statement with `ROW_NUMBER() OVER (PARTITION BY test_id)` —
was measured against 468,000 observations and is WORSE: to number the rows the
window has to read every run of every test, 40,000 rows scanned and filesorted
to return 2,000, against ten index-perfect rows per query the other way. So the
queries stayed and only their serialisation went (`runs.recentForTests`, a
bounded fan-out). Dependencies 364 ms → 131 ms; the reactor's per-sweep work
150 ms → 58 ms, on a local socket where latency is nearly zero.

**The V3 routes were already inside the security gate's sweep** — it enumerates
every registered route rather than the ones somebody remembered, so 401-without-
credentials, the viewer-write allowlist, missing-id 404 and non-numeric-id
no-500 all covered them from the day they were mounted. Worth checking rather
than assuming, which is what this pass did.

**Migrations and repositories are verified against a real MySQL**, not only
against the model: `npm run verify-schema` and `npm run verify-repositories`, in
CI on every push. The chain is applied twice, because a migration that is not
re-runnable takes the server down on the next deploy.
