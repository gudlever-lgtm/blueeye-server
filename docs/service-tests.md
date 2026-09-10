# Service Tests V1 — implementation plan

> **Status: plan only.** No Service Tests code exists yet. This document is the
> agreed integration design (guardrail 34) and the file/table/route inventory the
> implementation follows. Read it with [CODEMAP.md](../CODEMAP.md).

**What it is:** a no-code module where a non-technical operator registers a web
application, runs Discovery, accepts suggested tests, builds them with drag &
drop, runs them, sees why they failed, and schedules them.

**What it is not:** a general QA framework. No AI, no self-healing selectors, no
visual regression, no CI/CD integration, no arbitrary script execution (spec §33).

---

## 1. What the existing codebase actually is

The implementation prompt assumed React/Vite. It is not. Corrected baseline:

| Assumed | Actual |
| --- | --- |
| React + Vite frontend | Dependency-free vanilla-JS SPA in `public/` — **no build step** |
| — | **CommonJS only** (`require`/`module.exports`), not ESM, not TypeScript |
| Express + MySQL | Correct — Express 4 + mysql2 pool, `createX(deps)` factories everywhere |
| — | Auth is **JWT + roles** (`viewer` < `operator` < `admin`) via `src/auth/middleware.js`, plus a separate agent-token path |
| — | **Single-tenant on-prem.** No tenant system exists |

So: no new frontend stack, no build step, no ESM. Playwright is the **only** new
dependency, and it is confined to the worker process (§7).

### Existing machinery Service Tests reuses instead of reinventing

| Need | Reuse |
| --- | --- |
| Auth + RBAC | `requireAuth` / `requireRole(ROLES.…)` — `src/auth/middleware.js` |
| Secret storage | `src/lib/secretBox.js` (AES-256-GCM, `v1.gcm.…`, keyed off `SECRET_ENCRYPTION_KEY`) — already used for integration + LDAP credentials |
| SSRF blocking | `src/integrations/ssrfGuard.js` (`isBlockedHost`, `baseUrlBlockedReason`) |
| Audit trail | `auditLogger.record()` + `auditEventsRepo` |
| Background jobs | The `{ start, stop }` singleton-job contract in `src/server.js`; pacing pattern from `src/services/testPackageScheduler.js` |
| Validation contract | `{ value }` \| `{ errors }` pure validators; HTTP `400 { error:'Validation failed', details }` |
| Migrations | numbered `migrations/NNN_*.sql` + `npm run build-schema` |
| DSL/secret-reference precedent | `transaction_tests` (`{{secret:name}}` refs, write-only secrets) — migration 046 |
| UI shell | `views.<tab>` + `data-view` button + `PAGE_INFO` + `dataCard()` + `t()` |

**Nothing changes in `blueeye-agent` or `blueeye-licens`.** Service Tests run
server-side; agents are not involved.

---

## 2. Module boundary (spec §32 — standalone-ready)

Everything lives under one root. BlueEye touches it through exactly one factory
and one adapter object — no Service Tests file reaches into a BlueEye internal.

```
src/serviceTests/
├── index.js          # createServiceTestsModule(ports) → { router, jobs }  ← THE ONLY SEAM
├── ports.js          # the adapter interfaces: { db, secrets, auth, audit, logger, clock }
├── engine/           # the neutral DSL — PURE, no Playwright, no DB
│   ├── dsl.js        #   step catalogue + version 1 schema
│   ├── validate.js   #   definition → { value | errors }
│   ├── targeting.js  #   target object → ordered fallback strategies
│   └── redact.js     #   scrubs credential values out of any string/object
├── discovery/
│   ├── crawl.js      #   drives an injected browser port; scope + budget enforcement
│   ├── extract.js    #   PURE: page snapshot → pages/links/buttons/inputs/forms/selects
│   └── safety.js     #   PURE: destructive-action classification (read-only default)
├── suggest/
│   └── rules.js      #   PURE: discovery result → suggestions (rule-based; NO AI)
├── runner/
│   ├── execute.js    #   PURE dispatch: DSL step → calls on a driver interface
│   ├── driver.js     #   the Playwright adapter — THE ONLY file that requires playwright
│   └── classify.js   #   PURE: failure → { category, likely_cause, explanation }
├── scheduler/
│   ├── queue.js      #   DB-backed claim/complete over service_test_runs
│   ├── schedule.js   #   PURE: due-time arithmetic (interval + timezone)
│   └── worker.js     #   the loop: claim → run → persist → repeat
├── storage/          # repositories (pool in, plain objects out) — one per table group
├── validation/       # HTTP input validators (pure, { value | errors })
└── api/              # Express routers, one per resource

public/serviceTests.js    # the whole UI (window.ServiceTests), loaded by its own <script>
public/serviceTests.css   # own stylesheet, every selector prefixed .st-
scripts/service-test-worker.js   # worker entrypoint (separate process)
```

`public/app.js` gains **one** function:

```js
views.serviceTests = async () => window.ServiceTests.render({ el, api, t, dataCard, toast, isAdmin, isOperator });
```

plus one `PAGE_INFO.serviceTests` entry and one `data-view="serviceTests"` nav
button. That is the entire footprint in existing UI code. No global CSS is
touched — `serviceTests.css` only adds `.st-*` rules and consumes the existing
design tokens.

**Extraction test:** deleting the nav button, the `views.serviceTests` line, the
`PAGE_INFO` entry and the `routes/index.js` mount removes the module completely.
Reconnecting it elsewhere means re-implementing `ports.js` — nothing else.

---

## 3. Database — migration `078_create_service_tests.sql`

Twelve tables, all prefixed `service_test_`, all with `id`, `created_at`,
`updated_at`, and a **nullable, unused `tenant_id INT NULL`** (spec §27 — forward
compatibility only; BlueEye has no tenant system and V1 introduces none). No FKs
to existing BlueEye tables in either direction.

| Table | Holds |
| --- | --- |
| `service_test_applications` | name, description, `base_url`, enabled |
| `service_test_environments` | `application_id`, name, `base_url`, type (production/staging/development/test/custom), enabled |
| `service_test_credentials` | `application_id`, label, username, `secret_encrypted` (AES-256-GCM), never returned |
| `service_test_allowed_hosts` | per-application host allowlist — the SSRF escape hatch (§6) |
| `service_test_tests` | `application_id`, name, `definition` JSON (the DSL), `version` INT, enabled |
| `service_test_test_steps` | denormalised step rows for ordering/drag & drop + per-step enable/rename |
| `service_test_test_versions` | prior `definition` snapshots (spec §38 — rollback later) |
| `service_test_runs` | **also the job queue**: status, `environment_id`, start/end, duration, `failed_step`, `error_message`, `screenshot_path`, browser, `console_errors`, `network_errors` |
| `service_test_run_steps` | per-step status, ms, message, technical detail |
| `service_test_discoveries` | one crawl: scope, budgets, counters, started/finished |
| `service_test_discovery_pages` | url, title, status, redirects, timing |
| `service_test_discovery_elements` | links/buttons/inputs/forms/selects + the `possible_login` flags |
| `service_test_suggestions` | name, description, confidence, reason, proposed steps, accepted/dismissed |
| `service_test_schedules` | test_id, environment_id, interval, start time, timezone, enabled, `last_run_at` |

Run status enum: `queued` · `running` · `pass` · `fail` · `warning` · `skipped` ·
`error`. The spec lists five; `queued` and `error` are added because the queue and
the "the runner itself broke" case are otherwise unrepresentable.

Then `npm run build-schema` — `npm test` fails on a stale `schema.sql`.

---

## 4. The DSL (spec §3 — no Playwright in the definition)

Stored verbatim as the spec's `{ version, name, steps[] }` JSON. Step types
implemented in V1:

```
navigation    open · back · refresh
interaction   click · fill · clear · select · checkbox · upload
validation    assert_exists · assert_visible · assert_not_visible ·
              assert_text_contains · assert_text_equals ·
              assert_url_contains · assert_url_equals
control       wait · condition
auth          login · logout
technical     api_request · assert_http_status
```

`engine/targeting.js` turns a target object into an ordered strategy list —
**role → label → text → placeholder → name → id → css** — and the driver tries
them in order, recording which one matched. Multiple fallbacks are stored per
target so a changed id doesn't break a test that has a role+name.

Credential references are `{{credential.username}}` / `{{credential.password}}`,
resolved by the worker at execution time only. `engine/redact.js` runs over every
string that leaves the runner (log line, error message, exception, technical
detail); password/token/credential-bound inputs are masked in the DOM before any
screenshot is captured.

`execute.js` is pure: it takes a `driver` interface and dispatches steps onto it.
`driver.js` is the only file that requires Playwright, so **every runner test runs
offline against a fake driver** (`test-support/serviceTestFakes.js`).

---

## 5. HTTP API — mounted at `/api/service-tests`

One line in `src/routes/index.js`:

```js
if (serviceTests) router.use('/api/service-tests', serviceTests.router);
```

| Route | Role |
| --- | --- |
| `GET/POST /applications`, `GET/PUT/DELETE /applications/:id` | read viewer+ · write **admin** |
| `GET/POST/PUT/DELETE /environments…` | read viewer+ · write **admin** |
| `GET/POST/PUT/DELETE /credentials…` | **admin only**, secret write-only, never returned |
| `GET/POST/PUT/DELETE /tests…` | read viewer+ · write **operator+** |
| `POST /tests/:id/run` | **operator+** — enqueues, returns `202 { run_id }` |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/screenshot` | viewer+ |
| `POST /discovery`, `GET /discovery/:id` | **operator+** |
| `GET /suggestions`, `POST /suggestions/:id/accept`, `POST /suggestions/:id/dismiss` | **operator+** |
| `GET/POST/PUT/DELETE /schedules…` | read viewer+ · write **operator+** |

No route is public. No route is viewer-writable — so neither gate allowlist
(`PUBLIC_ROUTES`, `VIEWER_WRITE_ALLOWED` in `test/gate/security.test.js`) changes.
Credential, application and test writes are recorded through `auditLogger` under
category `service_tests`.

Versioning: the mount path stays `/api/service-tests`; a future `/api/service-tests/v2`
mounts beside it because the router is built inside the module, not spliced into
`routes/index.js`.

---

## 6. Security

**SSRF (spec §10) — `src/serviceTests/security/hostPolicy.js`.** This module makes
the server a browser, so it is the one place a bug turns BlueEye into an open
proxy. The policy wraps the existing `ssrfGuard` and adds what a browser needs:

1. **Scheme allowlist** — `http:`/`https:` only. `file:`, `ftp:`, `data:`, `blob:`,
   `ws:` and everything else are refused.
2. **Host allowlist** — a request is allowed only if its host is the application's
   base-URL host, an environment base-URL host, or a row in
   `service_test_allowed_hosts`. Everything else is blocked, external links included.
3. **Resolved-IP check** — the host is resolved and *every* returned address is run
   through `ssrfGuard`, closing the DNS-rebinding gap the existing literal-only
   guard documents. Loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT,
   ULA and `localhost` are refused.
4. **Enforced at three points** — validation time (base URLs), navigation time
   (every `open`), and request time via Playwright `page.route()`, which aborts
   every off-policy request the page itself makes, redirects included.

**The on-prem exception, stated plainly.** BlueEye is on-prem software; the
applications customers most want to test live on RFC1918. Rule 3 blocks exactly
those. So `service_test_allowed_hosts` carries an explicit, admin-only, audited
per-application entry that permits a named private host — that is the "explicit
enterprise configuration" §10 anticipates, kept secure-by-default: nothing private
is reachable until an admin names it, one host at a time. No CIDR wildcards in V1.

**Budgets** — max pages (100), max depth (5), max requests, per-navigation timeout
(30 s), total crawl duration (5 min), max steps per test, max run duration. Stored
per discovery run so a change is visible in history.

**Discovery is read-only** (spec §8). `discovery/safety.js` classifies any control
whose text/method/action suggests mutation (submit on non-GET forms, delete/remove/
pay/send/reset wording, `type=submit` on an unknown form) as
`potentially_destructive`; the crawler records and skips them, never clicks them.
Contact forms are discovered but never submitted.

**Secrets** — encrypted at rest via `secretBox`, decrypted only inside the worker,
never in an API response, never in a log line, error, exception, screenshot or
test definition. A dedicated gate-style test asserts a known credential value
appears in **no** run artefact.

---

## 7. Worker and Playwright (spec §22–23)

```
UI → Express API → service_test_runs (status=queued) → worker claims → Playwright → result rows
```

Playwright never runs inside an Express request. `POST /tests/:id/run` inserts a
`queued` run and returns `202` immediately. The worker (`scripts/service-test-worker.js`,
`npm run service-test-worker`) claims work with a conditional update —
`UPDATE … SET status='running', claimed_by=?, claimed_at=? WHERE id=? AND status='queued'` —
so the claim is atomic and multiple workers are safe from day one. A run stuck in
`running` past its timeout is reaped back to `error`. `queue.js` is the seam a real
queue (Redis, NATS) replaces later without touching the runner.

**Deployment, and the one open question.** The server image is `node:22-alpine`,
which is not a supported Playwright platform, and a full `playwright` install pulls
~400 MB of browser binaries into an image that is currently ~200 MB. So:

- the server keeps **no** Playwright dependency;
- the worker declares **`playwright-core`** (Apache-2.0) and gets its Chromium from
  the distro, via a separate `docker/Dockerfile.service-test-worker` on
  `node:22-bookworm-slim` + the Debian `chromium` package, wired with
  `PLAYWRIGHT_CHROMIUM_PATH` → `executablePath`;
- a new `service-tests-worker` service in `docker-compose.yml`, sharing the DB.

This avoids downloading Microsoft-hosted browser builds and keeps the server image
unchanged. Playwright itself is Microsoft-authored open source running entirely
on-prem — no US SaaS, no telemetry, no outbound calls — but it is a US-origin
project, so it is called out here rather than assumed against the "no US vendors"
convention, which targets tiles/GeoIP/geocoder/fonts. **Confirm before implementation.**

Without a running worker the UI shows runs as queued with "no worker connected"
(derived from the newest `claimed_at`), never a silent hang.

---

## 8. UI (spec §14, §29, §39)

One nav entry under **Diagnostics**, beside Probes & Tests and Transaktionstests.
Sub-tabs inside the view: **Applications · Discovery · Suggested tests · Tests ·
Schedules · Runs**.

The Test Designer is a vertical list of step cards, reordered with the HTML5 drag
& drop API (`draggable="true"` + `dragover`/`drop`) — no library, matching the
no-build-step convention. Each card: rename, edit fields via form controls, disable,
duplicate, delete. Every step reads as plain language — *Åbn side · Indtast · Klik
på · Vælg · Vent på · Kontroller* — with selectors, timeouts and the raw Playwright
error folded behind a **Technical details** disclosure. No user path requires
writing JSON, CSS selectors or code.

Failures render as the spec's shape: step number, plain-language cause, HTTP status,
likely cause, screenshot. All new strings go through `t('serviceTests.*')` and are
added to **both** `en` and `da` in `public/i18n.js` (the gate enforces key and
placeholder parity).

---

## 9. Gate extensions (deliberate, not loosening)

| Gate | Extension |
| --- | --- |
| `security.test.js` | Nothing to allowlist — no public and no viewer-write routes. Add one rule: no credential value ever appears in a run artefact |
| `ui.test.js` | Picks up the new `data-view` / `views.serviceTests` / `PAGE_INFO` / `t()` keys automatically. Add `public/serviceTests.js` + `.css` to the parse sweep (automatic — it globs `public/`) |
| `validation.test.js` | The suite asserts every `src/validation/*.js` module has a named rule. Service Tests validators live in `src/serviceTests/validation/` for the standalone boundary, so **extend the sweep to that directory too** and add the per-module rules |

Route-count and validator-count floors only rise.

---

## 10. Delivery order

Each phase is independently testable and leaves `main` green.

| PR | Phase (spec §40) | Contents |
| --- | --- | --- |
| 1 | 1–2 | Module skeleton, `ports.js`, migration 078, `schema.sql`, repositories + repo tests |
| 2 | 3–4 | Applications, Environments, Credentials — routers, validators, RBAC, audit, host policy, UI list/forms |
| 3 | 5 | The DSL: `dsl.js`, `validate.js`, `targeting.js`, `redact.js` — pure, fully unit-tested |
| 4 | 6 | `driver.js` (Playwright), `execute.js`, `classify.js`, worker + queue, compose service |
| 5 | 7–8 | Test Designer (drag & drop), run + results + screenshots + logs, failure classification UI |
| 6 | 9–10 | Discovery (crawl, extract, safety, budgets) + rule-based suggestions + the accept flow |
| 7 | 11–12 | Scheduler + history (last run, success rate, avg duration, last failure) |
| 8 | 13–14 | Security hardening pass, gate extensions, `docs/` update, UI polish, i18n sweep |

Every PR: `npm test` green, endpoints tested for 400/401/403/404/500, no outbound
network in tests, `npm version patch|minor --no-git-tag-version`, `CHANGELOG.md` entry.

**Definition of done** is spec §41 — the 18-step non-technical user journey, end to
end, without writing code.

---

## 11. Decisions needed before code

1. **Playwright + Chromium via a separate Debian worker image** (§7) — confirm, given
   the "no US vendors" convention and the image-size cost.
2. **Per-application private-host allowlist** (§6) — confirm it ships in V1; without
   it Service Tests cannot reach any on-prem application.
3. **License gating** — V1 proposes RBAC only, no new feature key, so the nav button
   carries no `data-feature` (matching Transaction tests). Say if Service Tests should
   instead be a Professional-tier feature.
