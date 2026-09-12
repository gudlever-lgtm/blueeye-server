# Service Assurance V3 — the specification

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
