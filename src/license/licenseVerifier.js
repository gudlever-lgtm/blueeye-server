'use strict';

const fs = require('fs');
const { verifyProof } = require('./verify');
const { ALL_FEATURE_KEYS } = require('./plans');

// LicenseVerifier — validates a LOCAL, offline license file entirely on-box: no
// contact with any external license server. The file is a signed proof:
//
//   {
//     "payload": {
//       "organization_id":           "...",
//       "plan_key":                  "professional",
//       "serverId":                  "<this server's id>",   // optional binding
//       "valid_from":                "2026-01-01T00:00:00Z",
//       "valid_until":               "2027-01-01T00:00:00Z",
//       "max_agents_override":        50,        // optional, null = use plan
//       "max_test_paths_override":    300,       // optional, null = use plan
//       "enabled_features_override": ["rbac", "sso_oidc"]  // optional add-ons
//     },
//     "signature": "<base64 Ed25519 signature over canonicalize(payload)>"
//   }
//
// The signature is produced by blueeye-licens with the PRIVATE key; this server
// only ever holds the PUBLIC key and verifies (same primitive + canonical bytes
// as the online proof, so a license can be issued by the very same signer).
//
// The signed payload is ONLY evidence of license status — never an access token.
//
//   const verifier = createLicenseVerifier({ publicKey, serverId });
//   const result = verifier.verifyFile('/etc/blueeye/license.json');
//   if (!result.valid) // -> restricted mode
function createLicenseVerifier({ publicKey, serverId = '', now = () => Date.now() } = {}) {
  // A non-negative integer override, or null (meaning "use the plan default").
  function normLimit(v) {
    if (v === null || v === undefined) return null;
    return Number.isInteger(v) && v >= 0 ? v : null;
  }

  // enabled_features_override may be an array of keys (["rbac", ...]) or a map
  // ({ rbac: true, ... }). Returns a { key: true } map of the granted keys.
  // Unknown keys are ignored (fail-closed) so a typo never silently grants.
  function normFeatures(v) {
    const out = {};
    if (Array.isArray(v)) {
      for (const k of v) if (ALL_FEATURE_KEYS.includes(k)) out[k] = true;
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) if (ALL_FEATURE_KEYS.includes(k) && v[k] === true) out[k] = true;
    }
    return out;
  }

  function parseTime(v) {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  }

  function fail(status, reason) {
    return { valid: false, status, reason, payload: null };
  }

  // Verifies an already-parsed license object. Pure (modulo the injected clock).
  function verify(file) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      return fail('malformed', 'license is not an object');
    }
    const payload = file.payload;
    const signature = file.signature;
    if (!payload || typeof payload !== 'object' || typeof signature !== 'string') {
      return fail('malformed', 'license is missing payload or signature');
    }

    // 1) Cryptographic trust — reject anything we cannot verify with the public key.
    if (!verifyProof(payload, signature, publicKey)) {
      return fail('invalid_signature', 'signature does not verify against the configured public key');
    }

    // 2) Optional server binding — a license that names a server must match.
    if (serverId && payload.serverId && payload.serverId !== serverId) {
      return fail('server_mismatch', `license is bound to a different server (${payload.serverId})`);
    }

    // 3) Validity window.
    const from = parseTime(payload.valid_from);
    const until = parseTime(payload.valid_until);
    if (Number.isNaN(from) || Number.isNaN(until)) {
      return fail('malformed', 'valid_from / valid_until is not a valid date');
    }
    const t = now();
    if (from !== null && t < from) return fail('not_yet_valid', `license is not valid until ${payload.valid_from}`);
    if (until !== null && t > until) return fail('expired', `license expired on ${payload.valid_until}`);

    // Trusted, in-window license.
    return {
      valid: true,
      status: 'valid',
      reason: null,
      payload,
      organizationId: payload.organization_id ?? null,
      plan: typeof payload.plan_key === 'string' ? payload.plan_key : '',
      validFrom: payload.valid_from ?? null,
      validUntil: payload.valid_until ?? null,
      limits: {
        max_agents: normLimit(payload.max_agents_override),
        max_test_paths: normLimit(payload.max_test_paths_override),
      },
      features: normFeatures(payload.enabled_features_override),
    };
  }

  // Reads + parses a license file from disk, then verifies it. A missing file or
  // unparseable JSON is a clean, non-throwing result (→ restricted mode), so the
  // server always boots even with no/garbled license.
  function verifyFile(filePath) {
    if (!filePath) return fail('missing', 'no license file configured');
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return fail('missing', `license file not found at ${filePath}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail('malformed', 'license file is not valid JSON');
    }
    return verify(parsed);
  }

  return { verify, verifyFile };
}

module.exports = { createLicenseVerifier };
