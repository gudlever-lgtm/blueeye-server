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

## 2b. Shipped so far

**§5 API correlation.** The runner watched every request the page made and kept
only the failures, with no method and no timing — so "The server rejected the
request" could never be resolved into *which* request. `runner/apiLog.js` records
every `xhr`/`fetch`/`document` call with method, masked URL, status and duration;
the run page reads it as `Browser ✓ · Page ✓ · API ✗ · HTTP 503` (§13's shape)
over a table of what failed and what was slowest. Migration 081 adds
`service_test_runs.api_calls`.

What is deliberately NOT stored: request or response bodies, headers, cookies.
URLs keep their sensitive query values masked (`token`, `api_key`, `session`, …)
and userinfo credentials dropped — masked on the way IN, so a secret that never
enters the column cannot leave it through a template someone forgot to scrub.
Images, fonts and stylesheets are not recorded: a page load is a hundred of them
and none says whether the service works.

**§6, the path half.** BlueEye already detected AS-path changes. It could not say
what the reroute COST: "the path changed" is a fact an operator can do nothing
with. A path-change finding now carries the latency either side of it, and a
reroute that measurably hurt is a WARN even when the origin AS is unchanged —
the case the old rule could not see, because it only looked at the control plane.

The two sides are not symmetric and the code says so: a change is detected on the
tick it happens, so the baseline is the **median** of the runs on the old path
(where noise protection is both needed and possible) while the new path usually
has one run. The sample counts are printed rather than hidden, and a shift counts
only when it is material both relatively (≥25%) and absolutely (≥10 ms) — 15 ms
on a 12 ms path is a different event from 15 ms on a 400 ms path.

**Not done, and not by accident: hop-level route change detection.** ECMP means
the hop sequence to a target legitimately differs run to run, so a hop-diff alarm
would fire constantly and be switched off within a week. The AS-path is the level
at which a change means something happened.

### §1 Recording — shipped

`recording/translate.js` turns a captured session into the **existing** DSL:
`{ version, name, steps }`, the same object the designer edits, the validator
checks and the runner executes. That is the guardrail the spec asks for in as
many words — recording must not introduce a second test model — and it is pinned
by a spec that runs the output through `validateDefinition()` and asserts every
emitted step type is one the DSL already knows.

What it decides, so the browser-side recorder can stay dumb and only observe:

- **A password is never a literal.** It becomes `{{credential.password}}`, and a
  username field becomes `{{credential.username}}`. Recording a real password
  into a definition would put it in the database, the version history, the audit
  log and the designer's screen — and pin the test to one person's account. The
  field is recognised by input type OR by name/autocomplete, because a login form
  that uses `type="text"` is common and would otherwise leak.
- **Typing collapses.** Consecutive input on one element becomes a single `fill`
  with the final value; nobody wants a test that types a, ad, adm, admi, admin.
- **The focusing click is dropped.** Clicking into a box and typing produces a
  click AND an input on the same element; the fill already implies reaching it.
  A click on a real control is never dropped.
- **Addresses become paths**, so the test runs against whichever environment it
  is pointed at — except on another host, which is kept whole rather than
  silently rewritten to point at the wrong site.
- **A navigation that followed a click is a consequence, not an instruction.**
  It becomes `assert_url_contains`, because replaying it as `open` would be
  actively harmful: the test would navigate straight to `/dashboard` and pass
  whether or not the login that was supposed to take it there worked.
- **It never throws.** A recording arrives from a browser: truncated, out of
  order, carrying events from a version that did not exist when it started. Four
  good steps beat an error.

**The transport: a bookmarklet.** Chosen over the two alternatives, and the
reasoning is worth keeping because it will be asked again:

| | How | Cost |
| --- | --- | --- |
| **Bookmarklet** ✅ | a script this server serves, injected by the operator into their own browser on their own site | no new infrastructure; the operator must drag a bookmark once, and the page's CSP can refuse it |
| **Browser extension** | a signed extension per browser | best capture fidelity; a new artifact to build, sign and distribute per browser, per release |
| **Headful remote browser** | a non-headless Playwright on the worker, streamed to the dashboard | nothing to install for the operator; needs a remote display service (VNC/noVNC), new dependencies and a new attack surface — against "no new frameworks without a concrete technical need" |

The bookmarklet wins on the thing that matters most here: the operator records on
the **real** application, signed in as themselves, from their own machine. The
extension would capture marginally better and cost a signed release per browser
forever. The remote browser would mean BlueEye holding a live session with the
customer's real traffic passing through it — the opposite of the privacy rule.

**The other limit:** a bookmarklet lives in the page it was injected into, so a
full page load removes it. Clicking the bookmark again resumes the same
recording — the token is still valid and the events keep accumulating — and the
re-injection records the new page as the next step, which is what you want
anyway. Single-page applications need one click for the whole journey.

**The limit, stated up front:** a site with a strict `script-src` CSP will refuse
to load the recorder, and the bookmarklet will do nothing there. That is the
site's policy working correctly. The bookmarklet says so in an `onerror` alert
and the UI says so before the operator tries; the fallback is the designer.

### The capture path, and why it is not a hole

Recording is the ONE Service Assurance path that carries no session. It has to
be: the caller is a script on the customer's own site, in the operator's browser,
which has no BlueEye session and cannot get one. So the surface is split:

| Mount | Guards | Who calls it |
| --- | --- | --- |
| `/api/service-tests/recordings` | licence + `requireAuth` + RBAC (operator writes, viewer reads) | the dashboard |
| `/api/service-capture/{events,stop}` | the capture token, and nothing else | the recorder on the customer's site |

What keeps the second row honest:

- A capture token exists **only** because an authorised operator on a licensed
  install started a recording. An unlicensed or unauthenticated install has no
  valid token anywhere, so every request there is 401.
- The token is stored as **SHA-256**, never as itself (`token_hash CHAR(64)`).
  It is shown once, in the bookmarklet. If the table leaks, what leaks is a hash
  of a credential that already expired.
- It resolves only while the recording is `status='recording'` **and** not past
  `expires_at` (default 30 minutes, capped at 240). An abandoned session is not a
  capture endpoint left open on the internet; a background job deletes it.
- It reaches exactly **one row**, append-only. There is no read, no list, and no
  way to name another recording.
- Missing, unknown, expired and stopped all answer the same `401 Unauthorized`,
  so the endpoint does not tell a caller holding a guess which part was right.
- CORS allows the origin (`*`) and **never** credentials, so a browser attaches
  no cookie and the token stays the only authority on the request.
- The ingest is bounded at every level: 200 events per batch, 2000 per recording,
  512 bytes per field, and only recognised keys survive — an unknown key is
  dropped rather than stored.

### The password rule, enforced twice

The recorder is written to send `value: null` for a password field. That is not
what makes it safe: the recorder runs on a page the customer controls, so
trusting it would be trusting the wrong side of the boundary. The rule is
enforced **again on the server**, in `recording/validate.js`, where it holds even
if the browser-side script is replaced entirely.

`recording/secrets.js` is the single definition both sides read. It used to be a
copy each, and the copies drifted — one looked at the element's visible LABEL and
the other did not, so a field labelled "Adgangskode" with an innocuous `id` had
its value stored. The visible label is usually the strongest signal a human has
that a field is a password, so it is the one a scrubber can least afford to skip.
The match is deliberately generous: a false positive costs one step the operator
corrects in the designer; a false negative puts a real password in the database,
the version history and the audit log.

Accepting a recording **clears its raw events**: the test is the artefact now,
and keeping the capture would keep a copy of everything the operator typed long
after it stopped being useful.

### §2 User Journeys — shipped

The central object, and the one that changes what the product SAYS. A journey is
a complete thing a user does; the tests under it are how BlueEyes proves it still
works. `migrations/083`, `journeys/health.js` (pure), `api/journeys.js`, a
Journeys tab, and [docs/service-assurance-journeys.md](service-assurance-journeys.md).

The decision that shapes everything else: **a journey owns no tests.** It orders
tests that already exist and has no steps, no definition, no second test format —
so the designer, recording, the runner, history, screenshots, incidents and
schedules all work inside a journey on the day it is created, without one of them
being taught what a journey is. The same test can be step 1 of several journeys,
which is the normal case for "Login" and the reason membership is its own table.

**Required vs optional is the whole value.** A broken required step fails the
journey — the user cannot get through. A broken optional one degrades it: part of
the service is gone, the journey is not. Logout failing is not Login failing, and
a system that cannot say so makes its own alerts worthless.

Two rules that look like details and are not:

- **"Not known yet" is not a failure.** A journey nobody has run, or one
  described but not yet implemented, reports as unknown and says which. Colouring
  it red would train people to ignore red.
- **A journey's duration is unknown unless EVERY step was measured.** A partial
  sum against a whole-journey expectation reads as a speed-up when it is really a
  missing measurement. Writing this turned up the same bug twice — `Number(null)`
  is `0` and `Number.isFinite(0)` is true, so a missing duration first counted as
  measured-and-zero in the rollup, then produced a verdict claiming the journey
  took 0 ms. Missing data must never read as good news.

### §3 Discovery → Journey suggestions — shipped

Discovery proposed tests. A test suggestion answers "what could we check here";
it does not answer "what does a user DO here". `suggest/journeys.js` answers the
second question, and migration 084 gives `service_test_suggestions` a `kind`
rather than adding a second suggestions table — the accept/dismiss flow, the
discovery link and the statuses already exist and behave identically for both.

**Journey rules derive from the TEST suggestions, not from the crawl again.** So
there is exactly one place that knows how to turn a discovered element into a DSL
step; a journey suggestion only GROUPS what has already been proposed, and names
its members by name because the tests do not exist until it is accepted.

Accepting one is the spec's chain in a single request: the member tests are
created (or reused, if the operator accepted one earlier — a second copy of the
same check splits its history across two rows), then the journey, then the
ordering. A member that has gone refuses the whole accept BEFORE anything is
created: half a journey is worse than a clear refusal.

Four deliberate rules:

- **"Availability" never becomes a journey.** "The front page answered" is the
  sentence journeys exist so the product stops saying.
- **A journey contained by a bigger one is dropped**, or the operator accepts two
  journeys watching the same login and then wonders which to delete.
- **Confidence is the weakest link**, so attention goes to the shakiest member.
- **Criticality is proposed, never decided.** Overridable in the accept request.

The bulk "create selected tests" button refuses a journey rather than building an
empty test from its (deliberately empty) `proposed_steps`.

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
