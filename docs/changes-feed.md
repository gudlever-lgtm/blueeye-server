# Changes feed — the landing page

A status dashboard full of green answers a question nobody asked. A shift starts
with **"what happened while I was away"**, and until now the only way to answer
that was to open six screens and compare them to memory.

`GET /api/changes` · viewer+ · read-only aggregation. This is now the default
route; the fleet grid moved to `/fleet`. It was not deleted — it is still the
right screen for bulk operations across agents. It was never the right screen to
open on.

## The marker rule

`since=last_login` reads `users.last_seen_changes` (migration 074), and that
column moves **only** on an explicit `POST /api/changes/seen` — never on a GET.

This is the one rule the feature rests on. A marker that advanced on read would
mean the page could never show anyone anything after their first load, which is
exactly the failure it exists to prevent. A test asserts that three GETs leave
the marker untouched.

The write is **monotonic** (`GREATEST` against the stored value): a tab left open
since this morning cannot mark an old timestamp as seen and re-surface changes
someone already dealt with.

`NULL` (never marked) falls back to the default window, not the epoch — a
first-time visitor wants their shift, not four years of history.

## What it reports

| Kind | Source | Transition-logged? |
| --- | --- | --- |
| `agent_state` | `audit_events` (`agent.online`/`offline`/`enrolled`) | ✅ |
| `finding` | `findings` | ✅ (creation) |
| `probe` | `events` (probe outages) — **degrade and recover** | ✅ |
| `event` | `event_cases` | ✅ |
| `cluster` | `event_clusters` | ✅ |
| `topology` | `topology_changes` (links appeared/disappeared) | ✅ |
| `playbook` | `event_playbook_runs` | ✅ |
| `config` | `config_snapshots` | ✅ |
| `interface_state` | `interface_state_transitions` (mig 075) | ✅ |
| `agent_health` | derived — heartbeat + version skew | ❌ **current state** |

`probe` and `event` used to share the kind `event`, which is what made one
row render as the raw string `event_case`. They are different records: see
[events.md](events.md) for the vocabulary.

A probe outage contributes **two** events when both ends fall in the window:
"the link came back" matters to a handover exactly as much as "it went down". A
recovery is always surfaced at `INFO`, never at the severity of the fault it
ended, or the page turns red for things that are now fine.

## Current state vs. change

`agent.heartbeat_stale` and `agent.version_skew` carry `currentState: true` and
are stamped `now`.

Neither is transition-logged: `agents.last_seen` and
`agents.capabilities.agentVersion` are overwritten on every report, so we know
the condition holds *now* but not when it began. **Deriving history by polling
current state is exactly what this page must not do**, so these rows are labelled
"current state" in the UI rather than dressed up as something that happened in
the window. `withinWindow()` exempts them, so a short window does not silently
drop them either.

## Interface transitions

Interfaces are **not a persisted entity** in this codebase — health is computed on
the fly from `results.payload.traffic`, so only the current state ever existed.

That gap is now closed by migration 075, which records transitions **at the
results-ingest seam** — the one place that sees every observation. Deriving the
history by polling current state was explicitly ruled out: a poller sees whatever
is true when it looks, misses everything between two looks, and produces a change
log that quietly lies about timing.

Flapping interfaces collapse onto **one** row with a count. See
`docs/interface-transitions.md`.

## Correlation — fewer rows, and what they indicate

The feed's job is answering "what happened", and a page listing every raw
occurrence does not answer it. Before ordering, two reductions run:

1. **Roll-up** — an anomaly whose `event` row is also on the feed is folded *into*
   that event, which then carries `findingCount`. The event exists precisely to
   represent those anomalies; listing both double-counted one detection, and is
   why the page read as twice as busy as reality.
2. **Collapse** — repeats of the same condition on the same device become **one**
   row carrying `count`, `firstAt` and every `refIds`. A condition that reopened
   seven times in four hours is one chronic problem; `7× since 07:15` states that
   where seven separate rows only implied it.

The correlation key is `kind | source | type | agentId | metric | severity`, so a
fold can never cross a device, a condition, a severity (an escalation stays its
own row) or a transition direction — "went offline" is never folded into "came
back online". `currentState` rows and one-off artifacts (config captures, topology
changes, playbook runs) are never folded: three config pushes are three pushes.

Correlation runs **before** the cap, so the cap's budget is spent on distinct
conditions instead of on repeats of one — a single flapping link can no longer
push every other condition off the page. `rawTotal` and `correlated` report what
was folded, and the page states it: a feed that quietly compressed 120
occurrences into 14 rows would otherwise read as a suspiciously quiet shift.

Pass `correlate: false` to `buildChangeFeed()` for the raw stream (an export, an
audit).

Each row also carries a `family` from `src/changes/indications.js` — the condition
family its metric belongs to (`latency`, `interface`, `saturation`, …) — which the
dashboard renders as one sentence about what the condition *indicates*. The
mapping is local, deterministic and regex-on-family: an unrecognised metric yields
`null` and no sentence, because no interpretation beats a confident wrong one. The
wording lives in `public/i18n.js` (`changes.indicates.<family>`, en + da), not in
the server.

## Event shape

Identical to `src/timeline/targetTimeline.js` and the topology change feed:

```
{ timestamp, source, type, severity, summary, ref_id, agentId, kind, currentState }
```

plus the correlation fields: `metric`, `family`, `count`, `firstAt`, `refIds`,
`findingCount`.

Sharing the shape means the dashboard renders these rows through
`TimelineView.renderRow` instead of growing a second row renderer that drifts
from the first.

## Ordering, grouping and the cap

Newest-first, with severity breaking a timestamp tie so a CRIT never hides under
an INFO from the same second. Grouped `CRIT` → `WARN` → `INFO`; an empty group is
omitted rather than shown as a heading with nothing under it.

The cap is applied to the **ordered** list, so what falls off is always the
oldest — never a silent middle slice — and `total`/`truncated` report what was
dropped so a truncated page cannot read as a complete one.

Per-source fetches are bounded at 500 rows: a fleet reconnecting after a WAN blip
produces thousands of `agent.online` rows, and one noisy source must not push
every other source's events off the page.

## Parameters

| | |
| --- | --- |
| `since` | ISO timestamp, or `last_login` (the marker). Future → 400. Older than 30d → 400. |
| `window` | `30m` / `6h` / `7d`, or a bare number of minutes. Default 24h, max 30d. |
| `limit` | 1..500, default 200 |
| `offset` | ≥ 0 |

An unparseable `window` is a **400, not a silent fallback to the default** — on
this page, quietly showing the wrong time range is worse than an error.

## Empty is an answer

An empty window returns `200` with an empty list **and the reference times**.
Never 404, never a blank body: "nothing changed since 06:00" is the answer, and
the timestamp is the half that makes it meaningful.

## Partial failure

Sources fan out with `Promise.allSettled`. One failing source sets `partial: true`
and names it in `failedSources`; the rest still answer. This is the page a shift
*starts* on — one dead source must not empty it.

Loading the agent list is the one fatal failure (it happens before the fan-out
and every mapper labels from it): that is a 500.

## Files

- Migration `migrations/074_add_user_last_seen_changes.sql`
- Pure read-model `src/changes/changeFeed.js` (mappers, window, correlation, ordering, grouping)
- Condition families `src/changes/indications.js`
- Fan-out `src/changes/changesService.js`
- Vocabulary (event vs. incident vs. situation vs. probe outage): [events.md](events.md)
- Router `src/routes/changes.js`
- Fleet-wide repo additions: `remediationPlaybooksRepository.listRunsBetween`, `configSnapshotsRepository.listBetween`, `usersRepository.get/setLastSeenChanges`
- UI `views.changes` + `changesRowEl()` in `public/app.js`, `.chg-*` CSS, `PAGE_INFO.changes`
- Tests `test/changesFeed.test.js` (pure), `test/changesApi.test.js` (HTTP)
