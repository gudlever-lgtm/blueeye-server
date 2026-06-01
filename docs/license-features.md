# License feature-gating

Phase 11. Makes the analysis, assistant, alerting and geo modules **license-gated**
on top of the existing Ed25519-signed license validation (blueeye-licens →
blueeye-server). No new license mechanism — it reads a `features` map that is
part of the signed proof.

## How it works

The license proof from blueeye-licens carries a signed `features` object:

```json
{ "features": { "analysis": true, "assistant": false, "alerting": false, "geo": false } }
```

Because `features` is inside the Ed25519-signed payload, an on-prem server
cannot grant itself a module by editing it — the signature would stop matching
(verified in blueeye-licens' `validate.test.js`).

`src/license/features.js` reads the map from the already-validated license
(`licenseManager.getFeatures()`), **fail-closed**: a missing field, a non-object
map, or no valid license all mean *not allowed*. The license manager caches the
parsed proof and refreshes it on renewal, so entitlements always reflect the
latest validation.

## License vs config

Two independent gates, with **distinct** messages so operators can tell them apart:

- **License** = *may* the customer use the module (`isFeatureEnabled`).
- **Config** = has the customer *switched it on* (the existing `*_ENABLED` flags).

| Module | Gate |
| --- | --- |
| analysis detector | runs only if `isFeatureEnabled('analysis')` **and** `ANALYSIS_ENABLED` |
| assistant endpoint | `403` *"Funktionen er ikke inkluderet i jeres licens"* when unlicensed (checked **before** the config "slået fra" `403`) |
| alerting dispatcher | skipped (`reason: 'unlicensed'`) when alerting isn't licensed |
| geo endpoints | `403` *"…ikke inkluderet i jeres licens"* when geo isn't licensed |

## API

`GET /license/features` → `{ analysis, assistant, alerting, geo }` booleans, so
the dashboard can hide/grey-out modules the customer isn't licensed for (the Geo
and Analyse tabs are hidden when their feature is off).

## Tests

`test/licenseFeatures.test.js` (fail-closed gate logic) and
`test/licenseGating.test.js` (assistant license-vs-config `403`, geo `403`,
analysis pipeline + alerting dispatcher gating, `/license/features`). The
signed-payload tamper test lives in blueeye-licens' `validate.test.js`.
