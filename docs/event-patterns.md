# Event patterns

BlueEyes has had a matcher since migration 086. A severity rule pins down
`source` / `metric` / `kind` / agent / application, a blank field means "any",
and the most specific rule wins. It is a good matcher, and it was welded to
exactly one decision: what severity to store.

So an operator who wants

> packet loss on the warehouse links is a warning here, not a critical — and it
> goes to the NOC's Matrix room, not to e-mail, and once per condition rather
> than once per agent

could write the first half, and could not express the second half at all. The
alerting dispatcher sees a severity and nothing else, and its cooldown is keyed
per `(host, metric, kind, severity, target)` — so forty warehouse agents are
forty alerts.

A **pattern** is that same match, with a name, stored once.

## What a pattern is

One row in `event_patterns` (migration 146):

| Field | Meaning |
|---|---|
| `name` | what the rules and the route refer to — "Warehouse links". Unique |
| `source` | `finding` (analysis) or `service_assurance` |
| `match_metric` | findings only — e.g. `packet_loss`. Blank = any |
| `match_kind` | e.g. `ANOMALY`, `FLATLINE`, or the SA failure kind. Blank = any |
| `match_host_id` | findings only — one agent. Blank = every agent |
| `match_application_id` | service assurance only. Blank = every application |
| `reason` | **required** — why this grouping exists |
| `enabled` | off keeps the row without applying it |

Same fields, same "blank = any", same most-specific-wins, same newest-wins tie
break. That is not a coincidence and not a copy: `src/events/patterns.js`
imports `scopeMatches` and `specificityOf` from `src/events/severityRules.js`,
so a pattern and a rule can never disagree about what "matches" means. One
surprising precedence rule in a product is one too many.

A pattern with **no** match field at all would cover every event from its
source, so it is refused rather than warned about — and an edit that would
remove the last one is refused too, because widening a pattern widens every
rule and the route hanging off it.

## What hangs off one

**A severity rule.** `event_severity_rules.pattern_id` points at a pattern
instead of the rule carrying its own match. The rule's own `match_*` columns are
then cleared, not kept: two places saying which events is a rule nobody can
read. The resolution happens in SQL, in `severityRulesRepository.active()`, so
the pure matcher, the backfill and the preview all keep seeing a plain rule.

**An alert route.** One row in `alert_routes`, at most one per pattern:

| Field | Meaning |
|---|---|
| `channels` | comma-separated: `email`, `webhook`, `matrix`, `syslog`. **Never empty** |
| `min_severity` | blank = keep each channel's own minimum |
| `cooldown_ms` | blank = the global `ALERT_COOLDOWN_MS`; `0` = every event |
| `reason` | **required** |
| `matched_count`, `last_matched_at` | how often it has actually decided an alert |

One route per pattern, because "where do these go" has one answer and a second
row would be a tie with nothing to break it. Two destinations for two
severities are two patterns.

## What the dispatcher does with it

`src/analysis/alerting/dispatcher.js` takes an optional `routing` port
(`routeFor(finding)` → `{ pattern, route, routed }`). When it answers:

- only the channels the route names are tried. A channel the route leaves out is
  reported as `skipped: not in the pattern route`, not as a failure;
- the route's `min_severity` **replaces** each channel's own minimum;
- `routed: false` means the event is below that minimum, and nothing is sent.
  Falling back to the per-channel minimums there would make the route's
  threshold decorative;
- the cooldown key is `pattern:<id>|<severity>` instead of the finding's own.
  **This is the point of the feature**: one condition across forty agents
  becomes one alert. Severity stays in the key, so a cooldown started by a WARN
  never swallows the CRIT escalation behind it;
- the route's own `cooldown_ms` replaces the global one.

An event that matches no pattern, or matches one with no route, dispatches
exactly as it did before patterns existed. A routing resolver that throws costs
the routing and never the alert.

Cluster alerts (`dispatchCluster`, `dispatchClusterEvent`) are **not** routed: a
cluster spans several hosts and metrics by definition, so there is no one
pattern it belongs to. They keep their own once-per-cluster guard.

## MITRE ATT&CK — the operator's label, not the detector's

A pattern may carry a technique and a tactic (`attack_technique`,
`attack_tactic`, migration 147). This is the only place in the codebase where an
ATT&CK technique is asserted, and the author matters.

**ATT&CK is not an indicator feed.** There are no addresses, hashes or domains
in it — it is a taxonomy of adversary behaviour. So there is nothing here to
match against: the matching is the one above, and ATT&CK only gives that match a
name other tools recognise. An IOC feed would be a different feature, and one
that collides with three house rules at once (metadata only, no cloud, no US
vendors).

**Why the pattern and not the detector.**
[attack-indication.md](attack-indication.md) is explicit: each detector "states
a fact with its numbers", and "none of these detectors classifies traffic as
malicious, scores a threat or names a technique". That restraint is what makes
the red line worth looking at — 212 failed logins is equally consistent with a
misconfigured backup job, and a red line over a sentence that turns out to be
the backup job teaches an operator to stop reading the line.

A technique on a pattern is a different statement by a different author: the
operator saying "on this network, we treat this match as T1110", beside the
`reason` the pattern already requires, with their account in the audit log. The
detector keeps saying "212 auth failures in 10 minutes on core-sw-1". Both are
true; only one is a judgement about an adversary.

**Both fields or neither.** A technique can belong to more than one tactic
(T1133 External Remote Services is Initial Access *and* Persistence), so the
tactic cannot be derived — the operator picks the one they mean. Half a mapping
groups as nothing, exports as nothing and draws as nothing while looking on
every screen like a mapping that works, so it is refused.

**The technique id is checked by shape, the tactic against a list.** Any
`T####` or `T####.###` is accepted: ATT&CK has some two hundred techniques, this
product ships a dozen suggestions, and a customer who has mapped one we have
never heard of is right. The fourteen Enterprise tactics *are* closed — they are
the columns of the published matrix, and an export has to name one to open in
ATT&CK Navigator at all.

**Some matches map to nothing, deliberately.** `peer.new_asn` and
`peer.new_country` ("this site has never reached that network before") are first
sightings, not adversary behaviour. Forcing T1041 Exfiltration onto them turns a
cloud migration into an exfiltration alert, so they appear against no suggested
technique — and an operator who wants one anyway can type it in, with a reason.

### Where it shows

| Surface | Shows |
|---|---|
| The red line's panel | the tactics **lit right now**, in matrix order, with counts. Two cells side by side is a progression — Discovery then Credential Access — which is the thing worth seeing and why it is a strip |
| Settings → Patterns | the tactics this install has **mapped**, lit or not: the "what can we even see" half, which is the question an auditor asks |
| The alert | `T1110` in the e-mail subject, a line in the Matrix message, `technique=`/`tactic=` in syslog, top-level `technique`/`tactic` in the webhook. Greppable and routable in the customer's own SIEM |
| `GET /api/event-patterns/attack/layer` | an **ATT&CK Navigator layer** (format 4.5), scored by how many open events each technique covers now |

**Why an export and not a matrix in the dashboard.** The published matrix is
fourteen columns and some two hundred techniques. An install that maps eight of
them renders as a grey wall with three dots in it — which reads as "this product
sees nothing" when the truth is the opposite. Navigator draws the matrix
properly, it is free, and a security team already has it open. So the product's
own screens show the tactics actually covered, and the full matrix is a file for
the tool built to draw one.

The strip in the red line's panel is built from the groups
`FindingStore.attackIndication()` already returns, matched against the patterns
with the **same pure matcher** the alerting path uses — so the strip and the
alert can never disagree about which pattern an event belongs to. It fails
quietly: every open browser polls that endpoint, and a tactic strip is worth
nothing beside the bar's own count.

## Two things a pattern deliberately cannot do

- **It cannot mute.** A route must name at least one channel. Silencing already
  exists as a control that says so on the screen and expires on its own
  (maintenance windows), and it is not going to hide behind alert routing. A
  severity rule still cannot push an event below INFO either.
- **It cannot be deleted quietly.** Deleting a pattern deletes the severity
  rules that follow it and its route (`ON DELETE CASCADE`), because a
  pattern-backed rule left behind would have no match of its own — and a rule
  with nothing pinned down governs every event from its source. The API answers
  with the counts, the dashboard says them in the confirmation, and the audit
  row records them.

## Counting before committing

Both forms count first. `POST /api/event-patterns/preview` takes a draft and
answers how many **open** events it covers; `GET /api/event-patterns/:id/matches`
asks the same for a saved one. Both are reads — nothing is written either way. A
pattern matching nothing is a typo in a match field far more often than it is a
pattern for the future, and this is where that shows.

Note the difference from a severity rule's `apply-to-open`: that is a dry run of
a **change** and counts only events whose severity would move. A pattern has no
severity, so it counts everything inside its scope.

## API

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/api/event-patterns` | viewer+ | list, each with its route and how many severity rules follow it |
| `GET` | `/api/event-patterns/:id` | viewer+ | one, with its route and its rules |
| `GET` | `/api/event-patterns/:id/matches` | admin | how many open events it covers |
| `POST` | `/api/event-patterns/preview` | admin | the same count for an unsaved draft |
| `POST` | `/api/event-patterns` | admin | create (409 on a duplicate name) |
| `PUT` | `/api/event-patterns/:id` | admin | edit / enable / disable |
| `DELETE` | `/api/event-patterns/:id` | admin | delete, with its rules and route |
| `PUT` | `/api/event-patterns/:id/route` | admin | upsert the alert route |
| `DELETE` | `/api/event-patterns/:id/route` | admin | back to the default routing |

ADMIN on every write, the same footing as severity rules: a pattern decides what
wakes people at 3am and now also where it reaches them, across the whole estate
and indefinitely. Every write is audited under the `event_pattern` category.

## Where it lives

| Piece | File |
|---|---|
| The judgement (pure — no DB, no clock) | `src/events/patterns.js` |
| The ATT&CK vocabulary + rollup + layer (pure) | `src/events/attack.js` |
| The match it reuses | `src/events/severityRules.js` (`scopeMatches`, `specificityOf`, `validateScope`) |
| Data access + the 30s cache the dispatcher reads | `src/repositories/eventPatternsRepository.js` |
| Pattern-backed rules, resolved in SQL | `src/repositories/severityRulesRepository.js` |
| HTTP | `src/routes/eventPatterns.js` |
| Routing | `src/analysis/alerting/dispatcher.js` (`routing` port, wired in `src/server.js`) |
| Dashboard | Settings → Patterns (`settingsPatternsView` in `public/app.js`) |
| Tests | `test/eventPatterns.test.js`, `test/attackMapping.test.js` |

See also [severity-rules.md](severity-rules.md) and [alerting.md](alerting.md).
