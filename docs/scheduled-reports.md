# Scheduled reports

The availability and probe-outage reports, over a rolling window, mailed to the
people who need them — without anybody remembering to pull them.

Where to find it: **Reporting → Scheduled reports**.

## Why

The exports answer a question somebody asked: open the page, pick a period,
download a file. The same two reports also serve a recurring obligation — the
monthly SLA figure for a customer, the weekly outage list for a service review —
and a report nobody remembers to pull is a report that is missing on the day it
is asked for.

## What a schedule says

| Field | Meaning |
|---|---|
| `report` | `availability` or `probe_outages` — the two the exports cover |
| `format` | `csv` or `html` (the printable report), sent as an attachment |
| `window_days` | The period is **relative** and computed at send time ("the last 30 days") |
| `params` | The report's own filters: `location_id`, and `severity` for outages |
| `schedule_spec` | The recurrence from migration 099 — the same calendar the test packages use |
| `recipients` | Who it goes to (1–20 addresses) |

The window is the field worth pausing on. A stored `from`/`to` would send the
same fortnight forever; days-back means every send covers the days before it.

## Delivery

Sending reuses the **alerting SMTP settings** (Settings → Alerting), like the
one-time-password mail does, so an administrator configures a mail server once
for the whole product. `src/services/reportMailer.js` builds the transport
lazily through an injected factory, so editing SMTP at runtime takes effect
without a restart.

A send never throws into the job: it returns `{ ok, detail }`, which is stored on
the schedule as `last_run_status` and shown in its row. A schedule that has been
failing for three weeks says so on the screen that created it, rather than
looking healthy because nothing threw where anybody could see.

`POST /:id/send-now` runs **the same build and the same send** the timer
performs — a "does this work" is a real answer, not a different code path. A
mail server nobody configured answers **409 with the reason**, not 500: it is
something the operator can act on.

## Roles

| Action | Role | Why |
|---|---|---|
| Read the schedules | viewer+ | It is a list of what this system sends |
| Create / edit / delete | **admin** | It sends data out of the building to an address list, on a timer, from then on |
| Send now | operator+ | The same report to the same already-approved addresses |

Creating, updating, deleting and sending are all written to the audit trail with
the recipients — who it goes to is the point of the record.

## What is validated, and why there

`src/validation/reportScheduleValidation.js`:

* **Recipients** are checked against an address pattern that refuses CR/LF and
  commas. That address is handed to an SMTP server, so the rule that matters is
  that it cannot carry a header with it.
* **`window_days`** is 1–400. A schedule asking for a decade of rows every
  morning is a mistake, not a report.
* **The recurrence** goes through the same `validateRecurrence` as a test
  package, so it inherits the five-minute floor and the calendar rules.
* **A location filter that names no location** is refused when the schedule is
  created — otherwise it mails an empty report every month until somebody
  notices.

## Files

| What | Where |
|---|---|
| Report definitions (columns, rows, rendering) | `src/reports/definitions.js` — shared with the HTTP exports |
| Storage | `report_schedules` (migration 100) · `src/repositories/reportSchedulesRepository.js` |
| Validation | `src/validation/reportScheduleValidation.js` |
| Mail | `src/services/reportMailer.js` |
| The job | `src/services/reportScheduler.js` (a background job in `src/server.js`) |
| Router | `src/routes/reportSchedules.js` → `/api/report-schedules` |
| Screen | `reportSchedulesPanel()` / `editReportSchedule()` in `public/app.js`, `rs.*` in `public/i18n.js` |
| Tests | `test/reportSchedules.test.js` · `test/repeatSchedule.test.js` |

See also [connection-test.md](connection-test.md) for the recurrence itself.
