# Baseline as context

300 Mbit means nothing. "220% above normal for a Tuesday at 14:00" means
something.

`public/baselineMetric.js` renders a metric with an optional **second line**
giving that context. It lives in one place so throughput, latency, loss and
jitter read the same wherever they appear, instead of four views each inventing
their own phrasing.

## Scope: this shipped in reduced form, on purpose

The feature was specified as "baseline per **interface** and flow-pair", used
"everywhere throughput, latency, loss or jitter is shown". Only part of that is
possible against this codebase. What exists:

| Dimension | Status |
| --- | --- |
| Flow-pair traffic **volume**, day-of-week + hour | ✅ `flow_pair_baselines` (migration 068) |
| Per **interface** | ❌ interfaces are not a persisted entity — health is computed on the fly from `results.payload`, so there is nothing to key a baseline to |
| **Latency / loss / jitter**, day-of-week + hour | ❌ the metric baselines in `src/analysis/baselines.js` are a **disk file** keyed by `hostId\|metric\|UTC-hour` — **no day-of-week dimension**, and no API |

So "220% above normal for a **Tuesday** at 14:00" is not expressible for latency
today: the only latency baseline that exists cannot tell Tuesday from Saturday.
Rather than approximate it — which would put a confident sentence under a number
that does not support it — the component renders **nothing** where no baseline
exists, and the provider registry is where the missing dimensions plug in later.

Closing the gaps needs, in order: (1) persisted interfaces, (2) a day-of-week
aware latency/loss/jitter baseline in the database rather than a file.

## The rule

**No baseline → no secondary field.** No placeholder, no `–`, no guessed
context.

An empty space says "we do not know". A placeholder invites the reader to think
something was measured and came back unremarkable — which, under a number
someone is about to make a call on, is worse than saying nothing.

A test asserts the rendered node has exactly one child (the value) and no
leftover placeholder text.

"Normal for a Tuesday at 14:00" **is** rendered when a baseline exists and the
value is unremarkable — "we checked, it is normal" is information, and silence
there would be indistinguishable from having no baseline at all.

## Provider interface

```js
{ name, lookup(metric) -> baseline | null }
```

`baseline` is `{ median, mad?, sampleCount?, observationCount?, updatedAt?, dow?, hour? }`.
Only `median` is required.

The component does not know where baselines come from. `flowPairProvider(rows)`
builds one over `GET /api/baselines/flow-pair`; a lookup for a slot with no
baseline returns `null` rather than borrowing a neighbouring slot's number.

`PROVIDERS` is the registry a latency/loss/jitter provider registers into when a
data source for it exists — no call site changes.

## Edge cases

**Baseline = 0.** No division by zero, ever. `compare()` returns
`comparable: false` with `pct: null` and the absolute difference instead: there
is no meaningful percentage of zero, and printing one would mean inventing a
denominator. A test asserts the rendered text contains neither `NaN` nor
`Infinity`.

**Negative deviation.** Rendered as "60% below normal" with its own
`.bm-below` class — not "-60% below normal", which reads as a double negative.

**Small deviations.** Below ±5% the value is reported as normal. Calling a 1%
wobble "above normal" trains people to ignore the line.

**A provider that throws** costs the context, never the value.

## Baseline age on hover

The `title` attribute carries how many observations the baseline rests on and
when it was last recomputed. A baseline built from three days of data is not the
same claim as one built from three months, and the person deciding whether to act
on "220% above normal" needs to know which they are looking at. Under 100
observations the wording changes to "still building".

## Which slot the sentence describes

The weekday/hour come from the baseline row's own `dow`/`hour`, not from the
current time — so a number read on a Friday still says "Tuesday at 14:00" if that
is the bucket it came from. Weekday names go through the translation catalogue
(`weekday.0`…`weekday.6`), not `toLocaleDateString`: a slot is a day-of-week
*index*, not a date. (An earlier hardcoded English array produced "normal for en
Tuesday" under Danish; the parity test caught it.)

## API

`GET /api/baselines/flow-pair?host=<agentId>&limit=` · **viewer+**

Returns `{ host, baselines[], building }`.

`building: true` means this host has no baselines yet — normal for ~14 days after
a fresh install, because history builds **forward** (raw flow records cannot be
backfilled). It is a `200`, not a `404`, and it lets the UI say *why* there is no
context rather than leaving the technician wondering whether the page is broken.

**RBAC note.** viewer+ is deliberate: this is per-`(src,dst,port)` traffic volume,
the same class of metadata a viewer already reads in the Flows explorer, with a
comparison attached. The operator+ `/api/topology/flow-baselines` route is left
untouched — it sits next to the recompute `POST` and is a diagnostic surface, not
a display one.

`503` (repo not wired, i.e. no migration 068) is distinct from `200` with
`building: true` (wired, but this host has no baseline yet).

## Files

- Component `public/baselineMetric.js` (+ `.bm-*` CSS)
- Router `src/routes/baselines.js`
- Data `flow_pair_baselines` (migration 068) via `flowPairBaselinesRepository.listForHost`
- Tests `test/baselineMetric.test.js` (pure + jsdom), `test/baselinesApi.test.js`
