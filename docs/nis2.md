# Reporting (NIS2 + Report Generator)

The **Reporting** tab has two sub-sections:

- **NIS2** — a *stationary* compliance module with fixed parameters: readiness
  dashboard, risk register, control evidence, security incidents, generated
  management reports and an audit trail.
- **Report Generator** — a flexible, *selector-driven* custom report builder:
  pick sections, set per-section filters, choose columns, then preview or export
  as PDF (print-ready HTML), CSV or JSON.

The module is **modular** — designed to be extended later with API import,
AI-generated recommendations and integration to tickets/assets/monitoring data,
without schema churn. Both sub-sections share the `/api/nis2/*` API; the split is
a UI organisation (`views.reporting` → `nis2Module()` / `reportGenerator()`).

## Get-started

A fresh install has no data, so the NIS2 dashboard shows a **get-started guide**
(`nis2GetStarted()`) with the recommended workflow and a one-click
`POST /api/nis2/seed` (operator+) that creates one baseline control per category
(status `Missing`) — a no-op (409) once any control exists, so it can't
duplicate.

## NIS2 module

## Surface

Mounted at `/api/nis2` (`src/routes/nis2.js`). All endpoints sit behind the
existing user-JWT RBAC:

- **Reads** — `viewer+`
- **Writes** (risks/controls/incidents/evidence CRUD, report generation) — `operator+`
- **Report approval** + **audit trail** — `admin` (the admin/compliance role)

| Method + path | Role | Purpose |
| --- | --- | --- |
| `GET /dashboard` | viewer+ | Readiness score, headline counts, per-category status, top recommended actions |
| `GET/POST /risks`, `GET/PUT/DELETE /risks/:id` | viewer/operator | Risk register CRUD |
| `GET/POST /controls`, `GET/PUT/DELETE /controls/:id` | viewer/operator | Control-evidence CRUD; `?withoutEvidence=true` = prioritised gap list |
| `GET/POST /incidents`, `GET/PUT/DELETE /incidents/:id` | viewer/operator | Security-incident CRUD (mints `INC-YYYY-NNNN`). Reads carry computed Art.23 reporting **`deadlines`** (24h early-warning / 72h notification / 1-month final), anchored on `detectedAt`, for incidents with a reporting duty (`notificationRequired`/`nis2Relevant`). |
| `GET /deadlines` | viewer+ | NIS2 Art.23 reporting-deadline overview — duty-bearing incidents, most-urgent first (`overdue` → `due-soon` → `upcoming`) + counts. Computed (no stored columns); status is time-based (submission to the authority isn't tracked). |
| `GET/POST /evidence`, `DELETE /evidence/:id` | viewer/operator | Evidence references (link/document metadata) |
| `GET/POST /reports`, `GET /reports/:id`, `DELETE /reports/:id` | viewer/operator | Generated reports (snapshot frozen for trend) |
| `POST /reports/:id/approve` | admin | Approve a draft report |
| `GET /reports/:id/evidence` | viewer+ | **Signed + timestamped evidence manifest** — `{ manifest, signature, publicKey }`. The manifest binds the report's content hash (`sha256` over its canonical bytes) and a server timestamp (`signedAt`), Ed25519-signed with the server's key. Verify offline: recompute the hash, then verify `signature` over `canonicalize(manifest)` with `publicKey` (the same key agents use for signed releases). The cryptographic complement to the draft→approved organisational sign-off. `503` when no signing key exists; compliance-pack gated. |
| `GET /audit` | admin | The module change trail |
| `GET /export/{risks,controls,incidents}.csv` | viewer+ | CSV export |
| `GET /export/{executive,readiness,risk,control,incident}.html` | viewer+ | Print-ready HTML → browser "Save as PDF" |
| `POST /seed` | operator+ | Seed one baseline control per category (get-started) |
| `GET /custom-reports/sources` | viewer+ | Report Generator source catalogue (admin-only sources hidden from non-admins) |
| `POST /custom-reports/preview` | viewer+ | Build a custom report (JSON; rows capped per section) |
| `POST /custom-reports/export` | viewer+ | Export a custom report — `format`: `html` \| `csv` \| `json` |

## Inline guidance (what & why)

So a first-time user can fill the module in well enough to produce a NIS2 report,
each register explains itself in place:

- **Register explainers** — Dashboard, Risk Register, Controls, Incidents and
  Reports each open with a small *“What / Why”* box (`nis2Explain()` in
  `public/app.js`, styled `.nis2-explain`) that says what the register is and why
  it matters under NIS2 (Art. 21 risk-management measures; Art. 23 incident
  notification — 24 h / 72 h / 1-month deadlines).
- **Field hints** — the New/Edit modals carry per-field guidance. `openModal`
  renders an optional `field.hint` as a muted `.field-hint` note under the input;
  `selField(name, label, options, value, hint)` takes the same. Used across the
  risk/control/incident forms (e.g. likelihood × impact, management acceptance,
  evidence reference, *notification required*).
- **Dashboard KPIs** carry `title` tooltips explaining each headline count.
- **Report intros** — the print-ready register PDFs pass a `sec.intro` to
  `renderRegisterHtml` (risk/control/incident/readiness), and the Report
  Generator **source descriptions** (`SOURCES[*].description`) spell out what each
  selectable section contributes — so the *generated* report is self-describing too.

This is copy only — no schema or API change — and the enums stay mirrored between
`src/nis2/constants.js` and the dashboard `NIS2_*` constants.

## Report Generator

`src/nis2/reportBuilder.js` declares the available **sources** (`summary`,
`categories`, `risks`, `controls`, `incidents`, and the admin-only `audit`),
each with its projectable columns, default column set and understood filters.
`GET /custom-reports/sources` serves this catalogue (so the UI selectors never
drift from the server), `buildCustomReport(spec, data, { isAdmin })` applies a
validated spec to the loaded data (filter → sort → project columns) and returns
sections directly compatible with `renderRegisterHtml`. The audit source is
gated: the route returns 403 if a non-admin requests it, and the builder skips it
as defence in depth. CSV export (`customReportToCsv`) emits a heading + header +
rows per section, using the injection-safe `cell()`.

## Readiness scoring (local + explainable)

`src/nis2/dashboard.js` is a pure function — no DB, no ML. The readiness score is
the **mean of the ten category scores**; each category score is the mean of its
controls' evidence health (`OK=100`, `Partial=50`, `Missing/Overdue=0`). A
category with no controls scores 0 and is labelled `no-data`. Risk exposure
(open critical / high-medium), recent incidents and controls-without-evidence are
surfaced as separate headline counts, and the top five recommended actions are
ranked across overdue/missing controls, unmitigated critical/high risks, incidents
with a notification obligation, and categories with no controls.

Risk score is `likelihood × impact` (both 1–5, so 1–25), computed **server-side**
on every write so the stored value can never drift from its inputs; it is banded
Low / Medium / High / Critical (`riskBand` in `src/nis2/constants.js`).

## Reports & PDF

`POST /reports` generates a draft and **freezes the current headline metrics** in
`snapshot_json`, so the next report of the same type can show the delta
("development since last report"). The executive report (`src/nis2/report.js`)
renders to a standalone, self-contained HTML document with its own print CSS —
the dashboard fetches it with the bearer token and opens it in a new window for
the browser's *Save as PDF*. CSV export uses the shared, injection-safe
`src/lib/csv.js`.

## Audit trail

Every create/update/delete (and report approval) writes a row to
`blueeye_audit_log` via `nis2AuditRepository` with `user_id`/`user_email`,
`action`, `entity_type`, `entity_id` and `old_value`/`new_value` JSON snapshots.
Audit writes are **best-effort** — a failed audit never fails the user's request.

## Security

Prepared statements throughout (mysql2 placeholders), input validation in
`src/validation/nis2Validation.js` (enum/length/range checks; evidence
references must be `http(s)`/absolute-path), RBAC as above, and the audit log.
Evidence is stored as a **reference** (link/metadata) rather than an uploaded
binary, so the module needs no object store.

## Where things live

- Router: `src/routes/nis2.js` (mounted in `src/routes/index.js`)
- Scoring: `src/nis2/dashboard.js` · Reports/HTML: `src/nis2/report.js` · Enums: `src/nis2/constants.js`
- Repositories: `src/repositories/nis2{Risks,Controls,Incidents,Reports,Evidence,Audit}Repository.js`
- Validation: `src/validation/nis2Validation.js`
- Schema: `migrations/031_create_nis2.sql`
- Dashboard UI: `views.nis2` + `PAGE_INFO.nis2` in `public/app.js`; styles under `/* NIS2 */` in `public/styles.css`
- Tests: `test/nis2Dashboard.test.js` (pure scoring/report) + `test/nis2Api.test.js` (routes/RBAC); fakes in `test-support/fakes.js`
