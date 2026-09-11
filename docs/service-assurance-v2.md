# BlueEye Service Assurance V2 — design of record

> V1 answers **“the website is up.”**
> V2 has to answer **“the service works”** — and when it does not:
> *this is what failed, where it failed, and what is most likely causing it.*

**Status: specified, not built.** This is the agreed scope for V2 and the order
it gets built in. Read it with [service-assurance.md](service-assurance.md),
which remains the design of record for everything already shipped.

V1 is: **Discover → Suggest → Build → Run**.
V2 extends that to: **Discover → Build → Record → Test → Monitor → Explain**.

---

## 0. What V2 changes about V1's stated scope

V1's own summary says, in as many words:

> **What it is not:** a general QA framework. No AI, no self-healing selectors,
> no visual regression, no CI/CD integration, no arbitrary script execution.

Two of those are now in scope: **self-healing selectors** (§3) and **visual
regression** (§9). That is a deliberate reversal and it is recorded here rather
than left as a contradiction between two documents — a spec that disagrees with
itself is worse than either answer.

What has NOT changed, and is restated because V2 is the release where it would
be easiest to lose:

- **No AI requirement.** V2 may be *prepared* for AI; the first implementation of
  every feature here is deterministic, explainable, testable and reproducible.
- **No arbitrary script or shell execution**, no unrestricted URLs, no
  unrestricted network access. Recording is bound by the same host policy as a
  run.
- **The DSL stays neutral.** `CLICK`, `FILL`, `ASSERT`, `WAIT`, `LOGIN` are
  abstract actions. Playwright is the execution engine, never the test format —
  and recording must produce the SAME DSL, not a second test model beside it.
- **The module stays extractable.** Everything still arrives through
  `ports.js`; BlueEye never depends on Service Assurance internals.

## 1. Guardrails

V2 builds on V1 rather than replacing it. Nothing that works today may be
rewritten without a concrete reason: the database, the APIs, authentication,
routing, the UI, the DSL, the Playwright engine, Discovery, the runner, the
scheduler and the stored history all stay. Every change is backward compatible,
modular, documented, and local where it can be.

Same stack: Node.js, CommonJS, Express, Playwright, MySQL, the existing
dependency-free dashboard. No new framework without a concrete technical need.

Every V1 security control still applies, unchanged: SSRF protection, host
allowlisting, authn/authz, tenant isolation, CSRF, rate limiting, encrypted
credentials, secret masking, audit logging, execution timeouts, resource limits.

## 2. The features

| # | Feature | What it adds |
| --- | --- | --- |
| 1 | **Recording** | Record a real user journey in a browser and convert it to the existing DSL — navigation, clicks, input, select, checkbox, links, submit, URL changes — using the existing smart targeting. Afterwards the flow is editable in the designer: reorder, delete, insert assertions, save. No separate test model. |
| 2 | **Business Transactions / User Journeys** | A complete function seen from the user's side (login → search → open → verify → logout), with name, description, steps, **criticality** (Critical/High/Normal/Low), expected duration, environment and schedule. The dashboard reads journeys, not just tests. |
| 3 | **Self-healing selectors** | When the original target no longer resolves, try the ordered alternatives (role → label → visible text → placeholder → name → id → CSS → prior element info). A found alternative is **proposed, never applied**: Accept / Reject / Edit, and the change is logged. |
| 4 | **API correlation** | On failure, show the network events behind it: URL, method, status, response time, timing, failed requests — so a result reads `Browser ✓ · Page ✓ · API ✗ · HTTP 503`. Secrets never stored uncritically: no passwords, tokens, cookies or authorization headers in ordinary logs. |
| 5 | **Failure intelligence** | Extend the rule-based classification to answer *what failed* and *likely cause* across DNS, network, TLS, web server, authentication, API, application, timeout, missing element, unexpected content, redirect, browser/JS. **Observed and likely cause stay visually distinct — a probable cause is never presented as a fact.** |
| 6 | **Performance baselines** | Record execution time, step duration, page load, API response time and total journey duration; compute a baseline from historical *successful* runs and warn on significant deviation. Simple statistics only — no ML in V2. |
| 7 | **Service map** | Application → journey → page → API → endpoint, built only from **observed** relations. Explicitly not a CMDB. |
| 8 | **Visual regression** | Opt-in screenshot baselines on selected steps: create, compare, accept a new baseline, ignore a change. Must not turn small dynamic differences into false failures. |
| 9 | **Accessibility** | Basic checks — missing labels, buttons with no accessible name, images without alt, fields without labels, heading structure, keyboard access on key elements. Reported **separately from functional failures**. |
| 10 | **Dashboard** | Applications, journeys, tests, runs, failures, warnings, performance — with critical journeys listed by name and verdict. |

## 3. Build order

Exactly this order, because each step is what makes the next one worth having:

1. Recording
2. Business Transactions / User Journeys
3. Improved Discovery (journey grouping, confidence + reason per suggestion)
4. Self-healing selectors
5. API correlation
6. Failure intelligence
7. Performance baselines
8. Service map
9. Visual regression
10. Accessibility

After each feature: run the V1 regression, run the security suite, and document
the API and database changes. The gate refuses the build if any of that fails.

## 4. Out of scope for V2

Full AI test generation, autonomous agents, mobile device testing, distributed
cloud workers, billing, SaaS subscription, a customer portal, a full
browser/device matrix, arbitrary code or shell execution, advanced machine
learning, full load/stress testing.

## 5. Definition of done

A non-technical operator can, without writing code: discover an application, be
offered user journeys, record one, edit it visually, run it automatically, see
browser + API information when it fails, get a likely cause, see performance over
time, see the relations in the service map, and check visual and accessibility
problems.
