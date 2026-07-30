# Events — and why they are not incidents

BlueEyes produces **events**. It does not produce incidents.

An **event** is a correlated technical observation about one device: "latency to
this probe target has been far above baseline on `core-sw` since 07:15, seven
times over". It is owned by the monitoring, it opens and closes on evidence, and
nobody is accountable for it.

An **incident** is a service-desk record. It has a number, an SLA, an assignee, a
priority set by someone, and a customer waiting on it. It lives in the ITSM —
ServiceNow, TOPdesk, a custom connector — and an event is what **opens** one.

Calling our own row an "incident" made those two indistinguishable, and the
confusion had a cost: the dashboard implied BlueEyes was doing incident
management, which it deliberately is not. It detects, correlates and explains;
your service desk does the rest. So the noun in this product is **event**, and
"incident" is reserved for the thing an ITSM owns.

The exception is **NIS2 incidents** (`docs/nis2.md`). Those are regulatory
reports to an authority, and "incident" is the word the legislation uses. They
keep it.

## The vocabulary, precisely

| Term | Table | What it is |
| --- | --- | --- |
| **Anomaly** (a *finding*) | `findings` | One statistical detection: a metric deviated from its baseline. The raw unit. |
| **Event** | `incident_cases` | One or more anomalies on the **same device** inside a correlation window, tracked open → investigating → resolved → closed. |
| **Situation** | `incident_clusters` | One condition seen across **several devices**, with a suspected common cause. |
| **Probe outage** | `incidents` | An active-probe threshold breach (migration 025). A different, older concept — not an event. |
| **Incident** | — | Lives in your ITSM. BlueEyes writes to it, never stores it. |

The tables keep their historical names on purpose. Renaming `incident_cases`
buys nothing a customer can see and costs a migration on live data — including
five foreign keys and every report that joins them. The names a customer *does*
see (the tab, the rows, the API paths, the response keys) are the ones that
changed.

## Event → ITSM incident

`src/integrations/` is the outbound path. A connector subscribes to event types
and posts to the target's own incident table:

    event (BlueEyes)  ──dispatcher──▶  ServiceNow  ──▶  incident INC0012345
                                      TOPdesk     ──▶  incident
                                      custom ITSM ──▶  whatever it maps to

The wire names of those subscriptions (`incident`, `anomaly`) are **stored in
customer integration configs**, so they are unchanged — renaming them would
silently unsubscribe live integrations. `incident` there means "a CRIT-severity
event", which is now literally accurate: it is the subscription that opens an
ITSM *incident*.

See `docs/integrations.md` for the connector contract.

## HTTP surface

Canonical paths, viewer+ for reads, operator+ for writes:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/events` | List. Filters: `status`, `severity`, `hostId`, `from`, `to`. |
| `GET` | `/api/events/:id` | One event + its anomalies, playbook runs, explanation. |
| `GET` | `/api/events/:id/timeline` | Merged event timeline. |
| `GET` | `/api/events/:id/similar` | Scored similar past events. |
| `GET` | `/api/events/:id/guide` | Deterministic troubleshooting steps. |
| `GET` | `/api/events/:id/recommendation` | Playbook → history → optional AI. |
| `GET` | `/api/events/:id/config-context` | The config change suspected of triggering it. |
| `PATCH` | `/api/events/:id` | Status transition (audited). |
| `GET`/`POST` | `/api/events/:id/notes` | Append-only work log. |

**`/api/incidents/*` remains mounted as a deprecated alias** of every path above —
same router instance, so the two can never drift — and every response carries
both keys:

| Canonical | Deprecated alias |
| --- | --- |
| `events` | `incidents` |
| `event` | `incident` |
| `eventId` | `incidentId` |

Existing integrations keep working untouched. New callers should use `/api/events`
and the `event*` keys; the alias is kept for compatibility, not for parity of
documentation.

## Fewer rows, and what they indicate

The changes feed (`docs/changes-feed.md`) used to list an anomaly row *and* an
event row for the same detection, then repeat that pair every time the condition
came back — 52 critical rows for a handful of actual problems. Two reductions now
run before ordering:

1. **Roll-up** — an anomaly whose event is also on the feed is folded *into* that
   event, which carries `findingCount`. The event exists precisely to represent
   those anomalies; listing both double-counted one detection.
2. **Collapse** — repeats of the same condition on the same device become one row
   with `count`, `firstAt` and every `refIds`. A condition that reopened seven
   times in four hours is one chronic problem, and `7× since 07:15` says so
   where seven rows only implied it.

Neither crosses a device, a condition, a severity or a transition direction, so
"went offline" can never be folded into "came back online". The response reports
`rawTotal` and `correlated` alongside `total`, and the page states what it folded —
a feed that quietly compressed 120 occurrences into 14 rows would otherwise read
as a suspiciously quiet shift.

Each row also carries a `family` (`latency`, `interface`, `saturation`, …) from
`src/changes/indications.js`, which the dashboard turns into one sentence about
what the condition *indicates*. That mapping is local, deterministic and
regex-on-metric-family: an unrecognised metric yields `null` and no sentence,
because no interpretation is better than a confident wrong one.
