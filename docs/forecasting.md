# Capacity / trend forecasting

Local + explainable forward projection — the same philosophy as the anomaly
detector (robust statistics, no ML, no cloud), turned from backward-looking
("how far is this from its baseline?") to forward-looking ("where is it heading,
and when does it hit the ceiling?").

## Engine (`src/analysis/forecast.js`)

`forecast(points, { capacity?, horizonDays?, now? })` over a numeric time series
`[{ t, v }]` (t = ms-epoch or Date):

- **Trend** — a **Theil–Sen** slope (the median of all pairwise slopes), the
  robust analogue of least-squares. Like the detector's median + MAD, it ignores
  a few outliers/spikes instead of being dragged by them. The intercept is the
  median of `v − slope·t` for the same reason.
- **Projection** — the fitted line evaluated `horizonDays` ahead.
- **Days-until-capacity** — when a `capacity` ceiling is given and the series is
  genuinely rising and still below it, `(capacity − current) / slopePerDay`.
- **Explainable** — every result carries a plain-language `explanation` and the
  `evidence` (method, sample count, window, slope) it was derived from.

Returns `{ ok:false, reason:'insufficient_data' }` below `MIN_POINTS` (4) — a
"trend" from two or three points is noise, not signal.

## API (`src/routes/forecast.js`)

`POST /api/forecast` (viewer+):

```jsonc
// request
{ "points": [{ "t": 1735689600000, "v": 120 }, ...], "capacity": 1000, "horizonDays": 30 }
// response
{ "ok": true, "direction": "rising", "slopePerDay": 8.3, "current": 240,
  "projected": 489, "daysUntilCapacity": 91, "evidence": { "method": "theil-sen", ... },
  "explanation": "Trend rising +8.3/day ... reaches capacity (1000) in ~91 day(s)." }
```

The dashboard already holds the time series behind its charts (throughput, link
utilisation, disk usage), so it POSTs one to render a projection + a
"days-until-full" badge. Server-side wiring of stored history (per-agent
throughput/disk trend straight from the rollup tables) is the natural next step.
