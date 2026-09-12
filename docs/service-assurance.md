# BlueEye Service Assurance — implementation plan

> **New to Service Assurance?** Read [the guide](service-assurance-guide.md) first — it is written to be read front to back. This document is a design of record.

> **Know when your digital services stop working — before your users do.**

> **Status: V1 complete, plus the reaction layer (§14).** All fourteen phases are
> implemented — data model, applications/environments/credentials, the DSL, the
> Playwright engine, the Test Designer, runs and results, Discovery, rule-based
> suggestions, the scheduler, history, the security pass and the UI — and the
> module now ACTS on what it finds: TLS certificates are watched on their own
> schedule, failing tests and expiring certificates open incidents, and those
> incidents go out through the existing alerting channels. The module is mounted in
> `src/routes/index.js` and assembled in `src/server.js`; the browser worker runs
> as its own process (`npm run service-test-worker`).
>
> This document remains the design of record. Read it with [CODEMAP.md](../CODEMAP.md).

**What it is:** a no-code module where a non-technical operator registers a web
application, runs Discovery, accepts suggested tests, builds them with drag &
drop, runs them, sees why they failed, and schedules them.

### A note on the name

The product is **Service Assurance** — that is the nav entry, the page header,
the licence label and the word every screen uses. The INTERNAL identifiers stay
`service_test*`: `src/serviceTests/`, the `service_test_*` tables, the
`/api/service-tests` mount and the `service_tests` licence key. The tables shipped
under those names before the product was named, and renaming a schema to match a
label buys nothing a customer can see. Anywhere a human reads it, it says Service
Assurance.

**What it is not:** a general QA framework. No AI, no CI/CD integration, no
arbitrary script execution (spec §33).

> Self-healing selectors and visual regression were on that list too, and are
> now in scope for V2 — see [service-assurance-v2.md](service-assurance-v2.md)
> §0, which records the reversal rather than leaving two documents disagreeing
> with each other. Everything else on the list still holds, V2 included.

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
| Licence gating | `requirePlanFeature(deps, key)` + `FEATURE_CATALOG` — `src/license/features.js`, `plans.js` |
| Secret storage | `src/lib/secretBox.js` (AES-256-GCM, `v1.gcm.…`, keyed off `SECRET_ENCRYPTION_KEY`) — already used for integration + LDAP credentials |
| SSRF blocking | `src/integrations/ssrfGuard.js` (`isBlockedHost`, `baseUrlBlockedReason`) |
| CIDR maths for the host allowlist | `src/discovery/cidr.js` — `parseCidr`, `totalAddresses` (counts **without** enumerating, so an over-cap range is refused before any allocation), `inScope` |
| CSV export | `src/lib/csv.js` (`toCsv` — RFC4180 + formula-injection guard) |
| Audit trail | `auditLogger.record()` + `auditEventsRepo` |
| Artefact retention | the rollup/purge/scheduler pattern in `src/analysis/retention/` |
| Background jobs | the `{ start, stop }` singleton contract in `src/server.js`; pacing from `src/services/testPackageScheduler.js` |
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
├── ports.js          # the adapter interfaces: { db, secrets, auth, licence, audit, logger, clock }
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
│   ├── artifacts.js  #   screenshot capture, encoding, masking, retention hooks
│   └── classify.js   #   PURE: failure → { category, likely_cause, explanation }
├── scheduler/
│   ├── queue.js      #   DB-backed claim/complete over service_test_runs
│   ├── schedule.js   #   PURE: due-time arithmetic (interval + timezone)
│   └── worker.js     #   the loop: claim → run → persist → repeat
├── security/
│   ├── hostPolicy.js #   the SSRF decision: deny-list ∩ allowlist (§6)
│   └── allowlistIo.js#   CSV/line-list import + export of allowlist entries
├── storage/          # repositories (pool in, plain objects out) — one per table group
├── validation/       # HTTP input validators (pure, { value | errors })
└── api/              # Express routers, one per resource

public/serviceTests.js    # the whole UI (window.ServiceTests), loaded by its own <script>
public/serviceTests.css   # own stylesheet, every selector prefixed .st-
scripts/service-test-worker.js   # worker entrypoint (separate process)
docker/Dockerfile.service-test-worker
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

Fourteen tables, all prefixed `service_test_`, all with `id`, `created_at`,
`updated_at`, and a **nullable, unused `tenant_id INT NULL`** (spec §27 — forward
compatibility only; BlueEye has no tenant system and V1 introduces none). No FKs
to existing BlueEye tables in either direction.

| Table | Holds |
| --- | --- |
| `service_test_applications` | name, description, `base_url`, enabled |
| `service_test_environments` | `application_id`, name, `base_url`, type (production/staging/development/test/custom), enabled |
| `service_test_credentials` | `application_id`, label, username, `secret_encrypted` (AES-256-GCM), never returned |
| `service_test_allowed_hosts` | `application_id`, `entry_type` (`host`/`ip`/`cidr`), `value`, `note`, `created_by` — the SSRF escape hatch (§6) |
| `service_test_tests` | `application_id`, name, `definition` JSON (the DSL), `version` INT, enabled |
| `service_test_test_steps` | denormalised step rows for ordering/drag & drop + per-step enable/rename |
| `service_test_test_versions` | prior `definition` snapshots (spec §38 — rollback later) |
| `service_test_runs` | **also the job queue**: status, `environment_id`, start/end, duration, `failed_step`, `error_message`, `screenshot_path`, browser, `console_errors`, `network_errors`, `claimed_by`, `claimed_at` |
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
offline against a fake driver** (`test-support/serviceTestsFakes.js`).

---

## 5. HTTP API — mounted at `/api/service-tests`

One line in `src/routes/index.js`:

```js
if (serviceTests) router.use('/api/service-tests', serviceTests.router);
```

The whole mount sits behind `requirePlanFeature(deps, 'service_tests')` (§8), and
each route additionally carries its role requirement.

| Route | Role |
| --- | --- |
| `GET/POST /applications`, `GET/PUT/DELETE /applications/:id` | read viewer+ · write **admin** |
| `GET/POST/PUT/DELETE /environments…` | read viewer+ · write **admin** |
| `GET/POST/PUT/DELETE /credentials…` | **admin only**, secret write-only, never returned |
| `GET/POST/DELETE /applications/:id/allowed-hosts…` | **admin only**, audited per entry |
| `POST /applications/:id/allowed-hosts/import` (`?dry_run=1`) | **admin only** |
| `GET /applications/:id/allowed-hosts/export.csv` | **admin only** |
| `GET/POST/PUT/DELETE /tests…` | read viewer+ · write **operator+** |
| `POST /tests/:id/run` | **operator+** — enqueues, returns `202 { run_id }` |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/screenshot` | viewer+ |
| `POST /discovery`, `GET /discovery/:id` | **operator+** |
| `GET /suggestions`, `POST /suggestions/:id/accept`, `POST /suggestions/:id/dismiss` | **operator+** |
| `GET/POST/PUT/DELETE /schedules…` | read viewer+ · write **operator+** |
| `GET /assurance/incidents`, `GET /assurance/incidents/:id` | viewer+ |
| `GET /assurance/certificates`, `GET /assurance/summary` | viewer+ |
| `POST /assurance/incidents/:id/resolve` | **operator+** — audited |
| `POST /assurance/certificates/check` | **operator+** — forces a re-read now, audited |

No route is public. No route is viewer-writable — so neither gate allowlist
(`PUBLIC_ROUTES`, `VIEWER_WRITE_ALLOWED` in `test/gate/security.test.js`) changes.
Credential, application, allowlist and test writes are recorded through
`auditLogger` under category `service_tests`.

Versioning: the mount path stays `/api/service-tests`; a future `/api/service-tests/v2`
mounts beside it because the router is built inside the module, not spliced into
`routes/index.js`.

---

## 6. Security

### The host policy — `src/serviceTests/security/hostPolicy.js`

This module makes the server a browser, so it is the one place a bug turns
BlueEye into an open proxy. Every navigation and every sub-request passes two
**independent** checks, and both must pass:

**Check 1 — the permanent deny-list.** Refused for everyone, always, and not
allowlistable at any privilege level:

- non-`http:`/`https:` schemes — `file:`, `ftp:`, `data:`, `blob:`, `ws:`, …
- loopback (`127.0.0.0/8`, `::1`, `localhost`, `*.localhost`)
- link-local and the cloud metadata endpoint (`169.254.0.0/16`, incl. `169.254.169.254`)
- `0.0.0.0/8` and the broadcast address

Loopback and metadata stay permanently closed on purpose. Loopback would let a
test browser reach BlueEye's own API from the server's own network position;
metadata endpoints are the classic SSRF pivot. Neither is something an operator
should be able to unlock by editing a list.

**Check 2 — the per-application allowlist.** A target is permitted only if it
matches the application's base-URL host, an environment base-URL host, or a row in
`service_test_allowed_hosts`. Everything else is refused, external links included.

Three entry types:

| `entry_type` | Example | Matching |
| --- | --- | --- |
| `host` | `portal.kunde.dk` | exact hostname (case-insensitive), no wildcards |
| `ip` | `10.20.30.40` | exact address (`parseCidr` treats a bare IP as `/32`) |
| `cidr` | `10.20.0.0/16` | `inScope()` against the parsed range |

**RFC1918 is allowlistable — that is the whole point.** BlueEye is on-prem
software and the applications customers want tested live on private ranges. What
the allowlist opens is *private LAN* addresses; what it can never open is
*host-local and metadata* addresses. That split is the design.

**Caps on a range.** A CIDR is far more blast radius than a hostname, so:

- prefixes shorter than `/16` are refused outright, whatever the cap
- total addresses across one application's entries are capped
  (`SERVICE_TEST_ALLOWLIST_MAX_ADDRESSES`, default 65 536 = one `/16`), counted with
  `totalAddresses()` so an over-cap list is refused before anything is allocated
- a range that overlaps the permanent deny-list is refused at write time, rather
  than silently having holes punched in it at request time

**Hostname entries still get the resolved-IP check.** The host is resolved and
*every* returned address goes through check 1, which closes the DNS-rebinding gap
the existing literal-only `ssrfGuard` documents. An allowlisted hostname that
resolves to `169.254.169.254` is still refused.

**Enforced at three points** — validation time (base URLs and allowlist writes),
navigation time (every `open`), and request time via Playwright `page.route()`,
which aborts every off-policy request the page itself makes, redirects included.

### Import / export

Operators arrive with an existing list of hosts or segments, so typing them one at
a time is not the normal path.

- **Export** — `GET …/allowed-hosts/export.csv`, columns `type,value,note`, built
  with `src/lib/csv.js` `toCsv` (formula-injection guard included).
- **Import** — `POST …/allowed-hosts/import`, admin only. Accepts the same CSV or
  a plain one-entry-per-line list; `entry_type` is inferred when the column is
  absent. Capped at 1 000 entries / 1 MB. Every row is validated **before**
  anything is written: on any invalid or over-cap row the whole import is
  rejected with the standard `400 { error:'Validation failed', details }` naming
  the offending line numbers. `?dry_run=1` returns exactly what would change
  without writing, so an operator can check a pasted list first.
- The import is one audit entry recording the count, plus the per-entry rows.

### The rest

**Budgets** — max pages (100), max depth (5), max requests, per-navigation timeout
(30 s), total crawl duration (5 min), max steps per test, max run duration. Stored
per discovery run so a change is visible in history.

**Discovery is read-only** (spec §8). `discovery/safety.js` classifies any control
whose text/method/action suggests mutation (submit on non-GET forms, delete/remove/
pay/send/reset wording, `type=submit` on an unknown form) as
`potentially_destructive`; the crawler records and skips them, never clicks them.
Contact forms are discovered but never submitted.

**Secrets** — encrypted at rest via `secretBox`, decrypted only inside the worker,
never in an API response, log line, error, exception, screenshot or test
definition. A dedicated gate-style test asserts a known credential value appears in
**no** run artefact.

---

## 7. Browser engine, sovereignty and disk usage

### There is no European alternative that changes the calculus

The binding constraint is the browser engine, not the automation library. Every
production engine is US-origin: Chromium (Google), Gecko (Mozilla), WebKit
(Apple). Replacing Playwright still leaves you running one of the three.

| Alternative | Governance | Verdict |
| --- | --- | --- |
| Puppeteer | Google (US) | Same category, fewer capabilities |
| Selenium / WebDriver | Software Freedom Conservancy (US) | The protocol is a W3C standard; the drivers are still Google/Mozilla |
| WebdriverIO | OpenJS Foundation (US), many European maintainers | Genuinely community-governed, still drives chromedriver/geckodriver |
| Cypress | Cypress.io (US, commercial) | Worse — commercial coupling |
| Servo | **Linux Foundation Europe** | The only European-governed engine, and it cannot run real web apps yet |
| Ladybird | US non-profit, Swedish founder | Independent engine, years away |

**Playwright is not in the category the convention targets.** "No US vendors" in
CLAUDE.md is about map tiles, GeoIP/ASN, geocoder and fonts — *services called
over the network at runtime* that send customer data to a US-controlled endpoint.
Playwright is Apache-2.0 source running locally, with no telemetry and no outbound
calls. Its one real US dependency is the browser download from Microsoft's CDN at
install time, and that is exactly what distro Chromium removes.

The durable answer to sovereignty here is the seam, not a different vendor:
`driver.js` is the only file that touches Playwright and `execute.js` dispatches
onto an interface. Moving to WebDriver BiDi — the W3C standard the field is
converging on — later means writing a second driver. Test definitions never change.

### Keeping disk usage down

Two separate problems. Image size is a one-off; artefacts grow without a ceiling.

**Image — approximate, to be verified at build time:**

| | Approx. on disk |
| --- | --- |
| `npm i playwright` + all three browsers | 1–1.5 GB |
| `playwright-core` alone | ~5 MB |
| Debian `chromium` + libs via apt | ~350–450 MB |
| `node:22-bookworm-slim` base | ~200 MB |
| **Worker total** | **~600–700 MB** |
| Server image today (alpine), **unchanged** | ~150–200 MB |

Levers, in descending order of effect:

1. **The server image does not change.** The worker is a separate image behind a
   compose profile — the same pattern `docker-compose.yml` already uses for
   `licens`. A customer who never enables Service Tests pulls nothing extra.
2. **`playwright-core`, not `playwright`.** The `playwright` package's postinstall
   downloads browsers; `playwright-core` does not. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
   as belt-and-braces.
3. **Chromium only.** Firefox/WebKit are prepared architecturally and never
   installed — that alone is two-thirds of the browser payload.
4. **Chromium from apt**, not the vendor download: security updates arrive through
   the normal Debian channel, nothing is fetched from a US CDN at build time, and
   apt deduplicates the shared libraries. `--no-install-recommends` and
   `rm -rf /var/lib/apt/lists/*` in the same layer. Playwright is pointed at it via
   `PLAYWRIGHT_CHROMIUM_PATH` → `executablePath`.
5. **Copy only what the worker needs** — `src/serviceTests/`, `src/lib/`,
   `src/db.js`, the worker entrypoint and the package files. Not the whole repo.
6. **`fonts-liberation`** (~2 MB) and no more. Without fonts, text renders as boxes
   and screenshots are worthless. These are local font files, not a hosted font
   service, so the EU-fonts convention is unaffected.

The alternative to lever 4 is Playwright's `chromium-headless-shell`, materially
smaller than full Chromium but only available down the vendor-download path.
Distro Chromium costs disk and buys the patching story.

### Artefacts are the real growth risk

A 1280×720 PNG screenshot is 100–300 KB. A test on "every 5 minutes" failing
across a weekend produces ~576 failures a day — roughly 115 MB/day, for one test.
So, from day one:

- screenshot **only on failure** (already the spec), viewport rather than full-page
- WebP or JPEG at quality ~70 instead of PNG — 5–10× smaller
- a retention policy plugged into the existing `src/analysis/retention/` pattern,
  with `SERVICE_TEST_SCREENSHOT_RETENTION_DAYS`
- a per-run artefact cap

Runtime hygiene: reuse one browser process across runs with a fresh `context` per
run, cap concurrent contexts, and run with `--disable-dev-shm-usage` plus a tmpfs
on `/dev/shm` — Chromium crashes in containers with a small shm.

### Worker and queue (spec §22–23)

```
UI → Express API → service_test_runs (status=queued) → worker claims → Playwright → result rows
```

Playwright never runs inside an Express request. `POST /tests/:id/run` inserts a
`queued` run and returns `202`. The worker (`scripts/service-test-worker.js`,
`npm run service-test-worker`) claims work with a conditional update —
`UPDATE … SET status='running', claimed_by=?, claimed_at=? WHERE id=? AND status='queued'` —
so the claim is atomic and multiple workers are safe from day one. A run stuck in
`running` past its timeout is reaped back to `error`. `queue.js` is the seam a real
queue (Redis, NATS) replaces later without touching the runner.

Without a running worker the UI shows runs as queued with "no worker connected"
(derived from the newest `claimed_at`), never a silent hang.

---

## 8. Licence and RBAC — two layers

The licence decides **whether the module exists**; RBAC decides **who may do what
inside it**. A licensed install with a viewer-only user gets a read-only Service
Tests tab; an unlicensed install gets no tab at all.

- New catalogue key **`service_tests`** in `FEATURE_CATALOG` (`src/license/plans.js`),
  `minPlan: 'professional'` — the tier where the comparable modules sit.
- Registered as `status: 'roadmap'` with a matching **ROADMAP.md** entry **before
  implementation starts**, then flipped to `available` when the module ships. That
  is the repo's own documented process (ROADMAP.md § "How to mark a roadmap item done").
- Server side: the whole `/api/service-tests` mount is wrapped in
  `requirePlanFeature(deps, 'service_tests')`, which returns the documented
  `403 { success:false, error:'feature_not_available', feature, message }` with an
  upgrade hint from `planService.upgradeHint()`.
- UI side: `data-feature="service_tests"` on the nav button, so the tab hides
  itself on an unlicensed install exactly like the other gated tabs.
- RBAC inside the module is the table in §5 — viewer reads, operator builds and
  runs, admin owns applications, credentials and the host allowlist.

Two known touch-points in existing code, both minimal and backward-compatible
(guardrail 1):

1. `test/gate/ui.test.js` currently checks `data-feature` values against
   `KNOWN_FEATURES` — the four **legacy proof** keys only, so no plan-catalogue key
   would pass. The assertion is extended to `KNOWN_FEATURES ∪ ALL_FEATURE_KEYS`.
   That closes a gap in the sweep rather than loosening it: today a nav button
   carrying any valid plan key fails the gate.
2. `test/featureCompletion.test.js` asserts `ROADMAP_FEATURE_KEYS` is empty
   ("everything catalogued is shipped"). Queuing a roadmap item makes that false by
   design, so it becomes "the only queued key is `service_tests`", and returns to
   empty when the module ships.

---

## 9. UI (spec §14, §29, §39)

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

The allowlist editor is an admin screen on the application: a table of entries, an
add row that accepts a hostname, an IP or a CIDR, **Import** (with the dry-run
preview) and **Export**. Refusals explain themselves — "10.0.0.0/8 covers 16.7
million addresses; the limit is 65 536" beats a generic validation error.

Failures render as the spec's shape: step number, plain-language cause, HTTP status,
likely cause, screenshot. All new strings go through `t('serviceTests.*')` and are
added to **both** `en` and `da` in `public/i18n.js` (the gate enforces key and
placeholder parity).

---

## 10. Gate extensions (deliberate, not loosening)

| Gate | Extension |
| --- | --- |
| `security.test.js` | Nothing to allowlist — no public and no viewer-write routes. Add one rule: no credential value ever appears in a run artefact |
| `ui.test.js` | Picks up the new `data-view` / `views.serviceTests` / `PAGE_INFO` / `t()` keys automatically. **Extend the `data-feature` check to `KNOWN_FEATURES ∪ ALL_FEATURE_KEYS`** (§8) |
| `validation.test.js` | The suite asserts every `src/validation/*.js` module has a named rule. Service Tests validators live in `src/serviceTests/validation/` for the standalone boundary, so **extend the sweep to that directory too** and add the per-module rules |
| `featureCompletion.test.js` | Roadmap-key assertion, per §8 |

Route-count and validator-count floors only rise.

---

## 11. What shipped

| Phase (spec §40) | Where it lives |
| --- | --- |
| 1–2 · structure + data model | `migrations/078_create_service_tests.sql` (15 tables), `src/serviceTests/storage/`, `ports.js` |
| 3–4 · applications + credentials | `api/applications.js`, `validation/`, `security/hostPolicy.js`, `security/allowlistIo.js` |
| 5 · the DSL | `engine/dsl.js` (22 step types), `validate.js`, `targeting.js`, `redact.js` — all pure |
| 6 · the engine | `runner/driver.js` (the only Playwright file), `execute.js`, `classify.js`, `artifacts.js` |
| 7 · Test Designer | `public/serviceAssurance.js` — drag & drop over the HTML5 API, no library |
| 8 · runs + results | `api/runs.js`, `scheduler/worker.js`, screenshots on failure only |
| 9 · Discovery | `discovery/crawl.js`, `extract.js`, `safety.js`, `runner/pageSnapshot.js` |
| 10 · suggestions | `suggest/rules.js` — six rules, each carrying its reason |
| 11 · scheduler | `scheduler/schedule.js`, `queue.js`, the worker loop |
| 12 · history | `runsRepository.history()` + the PASS/FAIL strip in the UI |
| 13 · security | the two-check host policy, redaction, DOM masking before capture, gate extensions |
| 14 · UI | `public/serviceAssurance.js` + `.css`, `views.serviceAssurance`, 107 i18n keys in en + da |
| 15 · **reacting** (§14 below) | `migrations/080_create_service_assurance_reactions.sql`, `src/serviceTests/assurance/` (certificate watch, incident policy, the sweep), `api/assurance.js`, the Health tab |

Every endpoint is tested for 400/401/403/404/500, the whole suite runs offline
(the DNS resolver, the browser and the driver are all injected), and the gate
sweeps the module's routes and validators alongside the rest of the server.

**Definition of done** is spec §41 — the 18-step non-technical user journey, end
to end, without writing code. The one step that is deliberately incomplete is
`upload`: a test can declare it, and the runner refuses it honestly rather than
reading a file off the worker's disk. Attaching a file to a test is the follow-up
that makes it real.

### How many jobs at once

Two dials, and they are not the same one:

| | What it adds | Where |
| --- | --- | --- |
| `runner.concurrency` | Jobs run side by side **inside one worker** | Settings → Service Assurance → Runner |
| worker replicas | More worker **processes/containers** | `docker compose --scale service-assurance-worker=N` |

Each lane builds its own browser (`browserFactory` is per-job, so a crashed page
can never poison the next), so concurrency is a memory dial as much as a
throughput one — budget a few hundred MB per lane. The setting is read once per
tick, so raising it takes effect on the next poll rather than on a restart.

Claiming is a conditional UPDATE either way, so N lanes on one worker race each
other exactly as N workers do: the same guarantee, no lock server, and no job
ever runs twice.

The worker count itself is deliberately NOT settable from the dashboard. A worker
is a separate container; for the server to start one it would need the Docker
socket, and anyone who compromised the dashboard could then start arbitrary
containers on the host. How many machines run is the orchestrator's business.

Leave `SERVICE_TEST_WORKER_ID` unset when scaling: the worker falls back to
`hostname-pid`, and each container has its own hostname. Pin it and every replica
shares one identity, overwriting each other's heartbeat row — the dashboard would
show one worker where three are running.

## 12. Running the worker

The API queues; the worker executes. Without one, runs sit at `queued` and the UI
says so rather than hanging.

```
# in the stack
COMPOSE_PROFILES=service-assurance docker compose up --build

# or directly
npm run service-test-worker
```

`scripts/deploy.sh` rebuilds the worker with the rest of the stack on any host
that already runs one, and keeps the replica count it finds — so a worker is
never left on old code while the server updates. The first time, opt in:

```bash
BLUEEYE_SERVICE_ASSURANCE=1 ./scripts/deploy.sh     # start one
BLUEEYE_ASSURANCE_WORKERS=3 ./scripts/deploy.sh     # start three
BLUEEYE_ASSURANCE_WORKERS=0 ./scripts/deploy.sh     # stop them again
```

A deployment that does not use Service Assurance builds nothing extra: the
worker image is Debian + Chromium, and it is not in the default service set.

Two things must match the API server, and both fail quietly rather than loudly
if they do not:

- **The secret key.** The worker decrypts the credentials the server encrypted,
  and both derive that AES key from `SECRET_ENCRYPTION_KEY`, falling back to
  `JWT_SECRET`. A different value means every test with a login fails with
  "credential unavailable". In the stack both services read the same
  `SERVER_JWT_SECRET` from `.env`, so there is nothing to keep in step by hand.
- **The artefact path.** The worker WRITES failure screenshots to
  `SERVICE_TEST_ARTIFACT_ROOT`; the API server READS them back to serve
  `/runs/:id/screenshot`. Point them at different places and screenshots are
  captured that nobody can open.

  `SERVICE_TEST_ARTIFACT_ROOT` is a path **inside the container**, not a path on
  the Docker host. In the stack both services set it to
  `/var/lib/blueeye/service-assurance` and mount the same named volume
  (`service-assurance-artifacts`) there — that shared volume, not the path
  string, is what makes a screenshot written by the worker readable by the
  server. Setting `SERVICE_TEST_ARTIFACT_ROOT` in `.env` does nothing in the
  Docker stack: `docker-compose.yml` sets the container path explicitly, and it
  has to stay in step with the mount point. To find where the bytes actually sit
  on the host, ask Docker:

  ```bash
  docker volume inspect blueeye_service-assurance-artifacts
  ```

  Running the worker **outside** Docker is the case where the variable is yours
  to set — and then it IS a host path, which must be a directory the worker can
  write and the server can read (the same machine, or shared storage).

## Run history charts

The Runs tab answers "what just happened". **History** answers "how has it been
going" — the question a weekly report is written from.

`GET /api/service-tests/stats` returns one row per bucket:

| period | buckets | what you see |
|---|---|---|
| `day` | 24 hours | which hour of the night it started failing |
| `week` | 7 days (Monday first, ISO) | the working week |
| `month` | 28-31 days | the calendar month, whatever its length |
| `year` | 12 months | the trend a report quotes |

`at=YYYY-MM-DD` picks the specific one — any date inside the period identifies
it, so one parameter covers all four. `test_id` or `application_id` narrow it;
omit both for the whole install. The response carries `prev_at`, `next_at` and
`has_next`, so the dashboard's ◀ ▶ buttons do no calendar arithmetic of their
own and a period that has not happened yet is not offered.

**Three decisions worth knowing:**

- **The calendar lives on the server** (`src/serviceTests/stats/period.js`). A
  month is not 30 days and a DST day is not 24 hours; one implementation is
  enough to get that right.
- **Aggregation happens in SQL.** A year of a five-minute schedule is ~105,000
  rows and the chart wants twelve numbers.
- **Buckets are cut in the viewer's time zone.** The browser sends its
  `getTimezoneOffset()` and the query shifts timestamps before grouping —
  bucketing in UTC files the first two hours of a Copenhagen day under the day
  before, and "Tuesday" has to mean the operator's Tuesday.

Empty buckets are part of the answer. A day with no runs is drawn as a gap with
a baseline tick, because "it stopped running on Thursday" is exactly the reading
the chart exists for, and a missing bar could equally mean "off the edge of the
chart".

Two charts share the x positions — outcomes as stacked bars, average duration as
a line — and never one chart with two y-axes: "12 runs" and "1.4 s" share no
scale. The line breaks over an empty bucket rather than dropping to zero; an hour
nothing ran in is not an hour everything was instant.

### Is a worker running?

Each worker writes a heartbeat row (`service_test_workers`, migration 079) on
every poll tick, so the answer does not depend on there being work to do. The
dashboard reads it at `GET /api/service-tests/runs/worker-status` and shows the
connected workers under **Administration → Settings → Service Assurance**.

The first cut derived liveness from the newest claim on the run queue, which was
wrong in exactly the case that mattered: a freshly started worker with an empty
queue has claimed nothing, so a correct install was told to go and set up the
worker it had just started. The claim-derived answer survives as a fallback for a
worker older than the heartbeat table. A worker counts as gone once its last
heartbeat is older than `queue.workerHeartbeatTimeoutMs` (default 60 s).

Scaling out is `--scale service-assurance-worker=3`: the claim is a conditional
`UPDATE`, so several workers never run the same job twice.

---

## 13. Decisions taken

1. **Playwright + distro Chromium in a separate Debian worker image** — agreed.
   Rationale and the disk-usage plan are §7.
2. **Host allowlist ships in V1, optional to use** — agreed, and extended: entries
   may be a hostname, a single IP or a **CIDR segment**, with **CSV import/export**
   and a dry-run preview (§6). Empty by default, so the module stays
   secure-by-default; loopback and metadata addresses remain permanently
   un-allowlistable.
3. **Licence *and* RBAC** — agreed. `service_tests` is a Professional-tier feature
   key; once the licence permits the module, access inside it is decided by role (§8).

---

## 14. Reacting — certificates and incidents

Until this shipped, the module recorded and stopped. A scheduled test failed at
02:00, `classify.js` wrote "The TLS certificate is expired, self-signed, or
issued for a different name" in plain language, and nobody read it until a
customer called. The module knew and did nothing. Worse, nothing looked at a
certificate at all until it had already broken a test — which is the day after it
should have been renewed.

`src/serviceTests/assurance/` closes both gaps. Three files, one loop:

| File | What it owns |
| --- | --- |
| `certificates.js` | The TLS handshake and what it reads: subject, issuer, SANs, `notAfter`, days remaining. No HTTP is sent — the socket is destroyed the moment the certificate is in hand |
| `policy.js` | The decision layer, pure: which failures are the SERVICE failing (DNS, refused, TLS, 5xx → CRIT) and which are the TEST drifting (missing element, failed assertion → WARN, and never worse); when days-remaining becomes a warning and when it becomes critical |
| `reactor.js` | The sweep, the incident state machine, and the `notify` port |

### Why the checker refuses to trust the certificate

`tls.connect` is called with `rejectUnauthorized: false`, deliberately. A
connection that refused an expired or self-signed certificate would report
"unreachable" and lose the exact fact the check exists to find. Nothing is
trusted as a result: `authorized` / `authorizationError` are read off the socket
and the verdict is computed from them, so an expired certificate is reported as
`expired` (the actionable half) rather than as a generic chain failure.

Only https addresses the module already knows — an application's own base URL and
its enabled environments' — are ever contacted, filtered through the same
permanent deny-list as everything else (`denyReason`), so this is a refresh, not
a scanner. Two environments on one host are one certificate and one row.

### The incident, not the observation

An incident is the durable "wrong since when": one open row per `subject_key`
(`test:<id>` or `certificate:<application_id>:<host>:<port>`). A repeat observation touches that
row, so a service down all weekend is one incident with 400 occurrences rather
than 400 incidents. Severity only ever moves UP while an incident is open — a
service flapping between 503 and a timeout must not quietly downgrade itself out
of an operator's alert threshold — and the next healthy check resolves it.

`notified_severity` records what was last SENT. That is what makes an alert a
state change rather than a heartbeat:

| Transition | Alert |
| --- | --- |
| nothing → open | yes, at the incident's severity |
| open → same or lower severity | **no** — it has already been reported |
| open → higher severity (WARN → CRIT) | yes |
| open → resolved | yes, at INFO |

**V3 changed the unit of an alert, not this table.** A sweep still decides per
incident whether something is worth SENDING; what changed is that everything one
sweep would have sent is grouped by what observably links it, and one message
goes out per problem rather than per incident — see
`docs/service-assurance-v3.md` §"one alert per problem". Every incident folded
into a group is named in that group's message, so nothing is suppressed
silently, and `Settings → Reactions → groupAlerts` turns it off for an operator
who would rather see all of them.

### Where the alert goes

Out through the **same dispatcher** as every analysis finding
(`src/analysis/alerting/`), wired in `src/server.js` as `assuranceNotify`. So an
operator configures email/webhook/syslog once, and severity floors, cooldowns and
maintenance windows apply to a certificate expiry exactly as they do to a
throughput anomaly. It is gated on the `service_tests` licence key as well as
alerting's, because a plan without Service Assurance should not be able to page
anyone about it. A channel that throws never stops the sweep: the incident is
already durable and the next sweep retries.

### Settings (the `assurance` section)

| Field | Default | What it decides |
| --- | --- | --- |
| `enabled` | on | The sweep at all |
| `notify` | on | Whether incidents leave the server. Off = recorded, silent — what you want for the first week |
| `watchCertificates` / `watchTests` | on | Which half of the loop runs |
| `sweepIntervalMs` | 5 min | How fast an operator hears |
| `certificateCheckIntervalMinutes` | 6 h | How often each certificate is re-read |
| `certificateWarnDays` / `certificateCriticalDays` | 30 / 7 | "Remind me a month out, wake me a week out" |
| `failureStreak` | 2 | Failing runs in a row before a test opens an incident. One failure is a bad minute |
| `incidentRetentionDays` | 90 | How long resolved incidents are kept |

Lowering the warning window quiets an incident on the next sweep without waiting
for the next certificate read: `status` was decided against the window as it was
then, and days-remaining is re-judged against the window as it is now.

### Where it runs

In the **API process**, as a background job — not in the browser worker. It needs
no browser, and the alerting configuration and licence gate live here. That has a
useful consequence: an install with no worker connected at all still gets its
certificates watched, which is the cheapest useful thing this module can do.

The dashboard's **Health** tab shows the open incidents and every watched
certificate, with a "Check certificates now" button for operator+. Resolving an
incident by hand is honest about itself — the confirm says the next check reopens
it if the problem is still there, because closing a ticket does not renew a
certificate.

