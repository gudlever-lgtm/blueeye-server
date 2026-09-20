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

This is the general-purpose shape: it works for any metric, and it is the only
option when the series lives in the browser (a chart the user has already
brushed). It takes the series AND the ceiling from the caller.

For a long time that was the ONLY shape, and the honest state of this feature
was that nothing called it — the engine was correct and tested, and unreachable
from the product, because assembling a series and inventing a capacity number
was work no screen did. `GET /api/forecast/interfaces` is the part that was
missing.

`GET /api/forecast/interfaces?agentId=&days=&horizonDays=` (viewer+):

```jsonc
{ "agentId": 7, "windowDays": 14, "horizonDays": 30, "samples": 12480,
  "capacity": { "metric": "utilPct", "ceiling": 100, "basis": "negotiated link speed" },
  "interfaces": [
    { "iface": "eth0", "ok": true, "direction": "rising", "slopePerDay": 4.2,
      "current": 82, "projected": 100, "daysUntilCapacity": 4.3,
      "speedMbps": 1000, "samples": 12480,
      "explanation": "Trend rising +4.2/day (robust Theil–Sen over 336 samples). …" }
  ] }
```

The server reads both halves itself, and neither needed new storage
(`src/analysis/interfaceForecast.js`):

- **the series** — every agent result already carries per-interface
  `rx/txBytesPerSec`, kept for the retention window. Utilisation is derived with
  the SAME `computeInterfaceHealth()` the Interfaces screen and the fleet rollup
  use, so there is one definition of "utilisation", not two.
- **the ceiling** — the interface's own negotiated `speedMbps`. A 1 Gbit port is
  full at 1 Gbit. That is a real limit, not a number an operator had to type into
  a settings screen and then keep true.

Because utilisation is a percentage, the ceiling is 100 for every link whatever
its speed — which is the reason to forecast the percentage rather than the byte
rate.

Two practical bounds: the series is downsampled to at most 400 time-bucketed
averages before fitting (Theil–Sen is O(n²), and averaging rather than sampling
keeps the trend from depending on which minute happened to be picked), and the
read is capped at 20 000 rows over at most 90 days.

An interface whose speed the agent cannot read (many SNMP devices, most virtual
ports) produces no utilisation percentage at all, so it is absent rather than
listed with an invented limit. An interface with too little history reports
`ok:false, reason:'insufficient_data'` and the UI leaves it out of the table.

Results are sorted most-urgent-first: soonest to saturate, then steepest. The
Interfaces screen renders them in a panel under the current-state table, read
once per agent rather than on that table's five-second poll — it reads two weeks
of history, and the answer moves in days.
