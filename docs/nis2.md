# NIS2 Reporting Center

A self-contained compliance module that gives an organisation one place to see
its NIS2 readiness, risks, controls, security incidents and management reporting.
It is **modular** — designed to be extended later with API import, AI-generated
recommendations and integration to tickets/assets/monitoring data, without schema
churn.

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
| `GET/POST /incidents`, `GET/PUT/DELETE /incidents/:id` | viewer/operator | Security-incident CRUD (mints `INC-YYYY-NNNN`) |
| `GET/POST /evidence`, `DELETE /evidence/:id` | viewer/operator | Evidence references (link/document metadata) |
| `GET/POST /reports`, `GET /reports/:id`, `DELETE /reports/:id` | viewer/operator | Generated reports (snapshot frozen for trend) |
| `POST /reports/:id/approve` | admin | Approve a draft report |
| `GET /audit` | admin | The module change trail |
| `GET /export/{risks,controls,incidents}.csv` | viewer+ | CSV export |
| `GET /export/{executive,readiness,risk,control,incident}.html` | viewer+ | Print-ready HTML → browser "Save as PDF" |

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
