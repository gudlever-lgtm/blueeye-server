# Traffic types (categories) — v1

A per-agent breakdown of traffic into **categories** like *DNS*, *Web*,
*Facebook/Meta* or *Google*, shown as toggleable series in the dashboard
(Trafik → **Trafiktype**). It answers "how much of this agent's traffic is DNS /
Facebook / …" without inspecting any packet payload.

> **Metadata only — no DPI.** Categories are derived from flow *metadata*: the
> service **port** (DNS = 53, Web = 80/443, …) and the destination **ASN**
> (Facebook/Meta = AS32934, …). No packet contents are read or stored. This is
> the same privacy stance as the geo layer (RFC1918 is never geolocated).

## Two kinds of category

| Kind | Source | Examples | Reliability |
| ---- | ------ | -------- | ----------- |
| `port` | the agent's `byPort` summary (in stored result payloads) | DNS, Web, SSH, NTP, VoIP, VPN | **Exact** (port 53 *is* DNS) |
| `asn`  | destination ASN of geo-enriched `flow_records` | Facebook/Meta, Google, Netflix, Microsoft, Amazon, Apple, Cloudflare, Akamai | **Approximate** — CDNs/cloud blur it; one ASN can host many services |

The category list lives in [`src/flows/categories.js`](../src/flows/categories.js)
(`DEFAULT_CATEGORIES`). It is intentionally small and explainable; extend it by
editing that file (an admin-editable override is a planned follow-up — see
`listCategories(overrides)`).

## Requirements

- **Port categories** need a **flow source** on the agent (NetFlow/sFlow). With
  `proc`/`snmp` the agent only reports interface byte totals (no ports), so no
  port categories appear.
- **Organisation (ASN) categories** need the **geo/flow feature** enabled so
  `flow_records` are populated and ASN-enriched.

If neither is available the breakdown is simply empty (the UI says so) — the
live RX/TX chart is unaffected.

## API

`GET /api/flows/categories?agentId=<id>&from=<iso>&to=<iso>` (viewer+)

Returns time-bucketed bytes per category. Only categories with traffic in the
window are returned, biggest first; `points` align index-for-index with
`buckets`.

```jsonc
{
  "agentId": 1,
  "from": "2026-06-01T00:00:00.000Z",
  "to":   "2026-06-01T06:00:00.000Z",
  "bucketMs": 360000,
  "buckets": ["2026-06-01T00:00:00.000Z", "..."],
  "categories": [
    { "id": "web",      "label": "Web (HTTP/S)",    "kind": "port", "total": 1234567, "points": [/* bytes per bucket */] },
    { "id": "facebook", "label": "Facebook / Meta",  "kind": "asn",  "total": 456789,  "points": [/* ... */] },
    { "id": "dns",      "label": "DNS",              "kind": "port", "total": 12345,   "points": [/* ... */] }
  ]
}
```

- Defaults to the **last 6 hours** when `from`/`to` are omitted.
- The bucket size is chosen to give ~60 buckets, minimum 1 minute, aligned to the
  epoch grid so the port (JS) and ASN (SQL) buckets line up exactly.
- `400` on a missing/invalid `agentId` or bad dates; `404` if the agent does not
  exist. A failing flow query degrades gracefully (port categories still return).

`GET /api/flows/categories/defs` (viewer+) lists the category catalogue
(`{ id, label, kind }`) so the UI can build toggles.

## Implementation

- Router: [`src/routes/flows.js`](../src/routes/flows.js) (mounted at
  `/api/flows`).
- Port data: read from result payloads via `resultsRepo.findByAgentId`, summed
  from each measurement's `traffic.byPort`.
- ASN data: [`flowsRepository.asnSeries`](../src/repositories/flowsRepository.js)
  — `SELECT FLOOR(UNIX_TIMESTAMP(ts)/?) AS b, asn, SUM(bytes) … GROUP BY b, asn`.
- Classification: `classifyPort` / `classifyAsn` against the lookup index built
  from the category list.

## Tests

- [`test/flowsCategories.test.js`](../test/flowsCategories.test.js) — the route
  (auth, validation, 404, port/ASN classification, graceful flow-repo failure,
  500).
- [`src/flows/__tests__/categories.test.js`](../src/flows/__tests__/categories.test.js)
  — the classifier.
- `asnSeries` is covered in
  [`test/flowsRepository.test.js`](../test/flowsRepository.test.js).
