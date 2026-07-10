# marketing/ — BlueEye sales page examples

Two self-contained example landing pages that **sell BlueEye licenses** — on-prem
network monitoring with explainable anomaly detection and a built-in NIS2
compliance module. Both pages carry the same product story and license tiers
(Pilot → Starter → Professional → Enterprise → MSP); they only differ in visual
direction.

These are static marketing pages, **not** part of the app dashboard in
[`public/`](../public). In keeping with the repo conventions they use **no build
step and no external CDN, fonts or JS libraries** — everything is inline vanilla
HTML/CSS/JS, so they open straight from disk and honour the "no US-based
vendors/SDKs" rule.

| File | Style | Highlights |
| --- | --- | --- |
| [`index.html`](index.html) | Chooser | Links to both examples |
| [`brutalism.html`](brutalism.html) | **Tactile Brutalism** | Raw borders, hard offset shadows, monospace, chunky pressable buttons, marquee ticker, feature matrix |
| [`webgl.html`](webgl.html) | **Responsive 3D & WebGL** | Live raw-WebGL network-globe backdrop (point-sphere + proximity mesh, reacts to mouse/scroll), glassmorphism, scroll-reveal + animated counters |

## Selling points (both pages)

- **100% on-prem** — one Node.js + MySQL server; no SaaS, no telemetry.
- **Privacy by design** — metadata only (ports/ASN/timings/5-tuple), never DPI;
  private/RFC1918 addresses are never geolocated.
- **Explainable analysis** — median + MAD z-score, no cloud ML; every finding
  carries a reason + evidence.
- **EU data sovereignty** — European / self-hosted tiles, GeoIP and fonts.
- **NIS2 built in** — risk register, control evidence, Art. 23 deadlines
  (24h / 72h / 1-month) and signed evidence manifests.
- **Air-gap licensing** — offline Ed25519-verified license proofs.

## Preview

Open any file directly in a browser (no server needed):

```bash
xdg-open marketing/index.html      # or: open marketing/index.html
```

The WebGL page degrades gracefully to a CSS gradient if WebGL is unavailable, and
respects `prefers-reduced-motion`.

> The tier names, agent limits and feature matrix mirror the license plans in
> `blueeye-licens` (`pilot` / `starter` / `professional` / `enterprise` / `msp`).
> Prices are shown as "Quote" placeholders — wire real figures before publishing.
