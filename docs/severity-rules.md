# Severity rules

BlueEyes decides severity at detection. The analyser judges a finding from a
median + MAD z-score; Service Assurance judges an incident from the kind of
failure. Both are reasonable defaults, and neither knows your business.

The packet loss that pages one customer at 3am is the wifi at another one's
warehouse. A severity rule says:

> events matching **this** get **that** severity, from now on.

## What a rule is

One row in `event_severity_rules` (migration 086):

| Field | Meaning |
|---|---|
| `source` | `finding` (analysis) or `service_assurance` |
| `match_metric` | findings only — e.g. `packet_loss`. Blank = any |
| `match_kind` | e.g. `ANOMALY`, `FLATLINE`, or the SA failure kind. Blank = any |
| `match_host_id` | findings only — one agent. Blank = every agent |
| `match_application_id` | service assurance only. Blank = every application |
| `severity` | `INFO` / `WARN` / `CRIT` — what to store instead |
| `reason` | **required** — why this rule exists |
| `enabled` | off keeps the row without applying it |
| `applied_count`, `last_applied_at` | how often it has actually fired |

A blank match field means "any". A rule with **no** match fields at all would
govern every event from its source, so it is refused rather than warned about.

### Which rule wins

The most specific matching rule — the one that pins down the most fields. So
`packet_loss on gw-core → CRIT` beats `packet_loss → WARN`, which is the order a
person expects and the only one that makes a general rule safe to write.

Two equally specific rules matching the same event is a person changing their
mind, so the **newest** one wins.

## When a rule applies

At **store time**, not read time. Every finding passes through
`FindingStore.save()` and every incident through the Service Assurance reactor;
the rule is applied there, once.

Store time rather than read time, for two reasons:

- **Alerting reads the stored severity.** Applying rules on read would still
  page at 3am, which is the entire thing the rule exists to stop.
- **History has to stay honest.** A rule written today must not silently rewrite
  what you thought last March.

A rule therefore does **not** touch events that already exist. Applying one
backwards is a separate, explicit action —
`POST /api/severity-rules/:id/apply-to-open` — which counts first (`dry_run` is
the default) and only changes rows once you send `{ "confirm": true }`. It is
scoped to events that are still open: acknowledged findings and resolved
incidents are left as they were.

## Two things a rule deliberately cannot do

- **It cannot make an event disappear.** `INFO` is the floor. Something that
  silently deletes events is a different and far more dangerous control, and it
  is not going to hide behind this one.
- **It cannot change an event without saying so.** Every event a rule touched
  carries `original_severity` and `severity_rule_id`, and the dashboard shows
  "was CRIT" next to the badge. A machine that quietly downgrades criticals is
  one where the dashboard goes green and nobody looks again.

Deleting a rule does not un-decide what it decided: the foreign key is
`ON DELETE SET NULL`, so the provenance goes to NULL and the stored severity
stands.

## Where it lives

| Piece | File |
|---|---|
| The judgement (pure — no DB, no clock) | `src/events/severityRules.js` |
| Data access + the 30s cache the write path uses | `src/repositories/severityRulesRepository.js` |
| HTTP | `src/routes/severityRules.js` |
| Applied to findings | `src/analysis/findings.js` (`decideSeverity`) |
| Applied to Service Assurance | `src/serviceTests/assurance/reactor.js`, through the `severityRules` **port** |
| Dashboard | Settings → Severity rules (`public/app.js`), plus a "Severity rule…" button on each finding and incident |
| Tests | `test/severityRules.test.js` |

Service Assurance receives the rules as a port (`{ decide(event) }`) rather than
importing the module, because nothing under `src/serviceTests/` may require a
BlueEye host module — that is the extraction boundary.

## HTTP

| Method | Path | Role |
|---|---|---|
| GET | `/api/severity-rules` | viewer |
| GET | `/api/severity-rules/:id` | viewer |
| POST | `/api/severity-rules` | **admin** |
| PUT | `/api/severity-rules/:id` | **admin** |
| DELETE | `/api/severity-rules/:id` | **admin** |
| POST | `/api/severity-rules/:id/apply-to-open` | **admin** |
| POST | `/api/severity-rules/preview` | viewer (stores nothing) |

Admin, not operator. A rule quietly changes what wakes people at 3am, across the
whole estate and indefinitely — a different kind of act from resolving an event
or building a test, and it belongs with the people who own the alerting
configuration.

`PUT` validates the **whole merged rule**, not the patch. Validating the patch
alone would let an edit clear the last match field and turn a narrow rule into
one that governs every event from its source.

## Failure behaviour

A rule set that cannot be read leaves the detector's judgement alone. The cache
returns the last known set rather than an empty one, and an empty one rather
than throwing — a database hiccup must not silently turn every rule off and
start paging on everything the operator muted, and it must not stop an event
being stored at all.

The `applied_count` bump is best-effort and not awaited: a counter that fails
must never fail a write.
