'use strict';

// Produces a SIGNED offline license file that this server can validate on-box
// with no external license server (see docs/licensing.md → "Offline license").
//
//   node scripts/sign-offline-license.js \
//     --key ./license-signing-private.pem \
//     --out ./license.json \
//     --org org-42 --plan professional --server <LICENSE_SERVER_ID> \
//     --from 2026-01-01 --until 2027-01-01 \
//     --max-agents 50 --max-test-paths 300 \
//     --feature rbac --feature sso_oidc
//
// IMPORTANT: signing uses the PRIVATE key — the same key pair blueeye-licens
// uses to sign online proofs (generate it there with scripts/generate-signing-key.js).
// This server only ever holds the matching PUBLIC key (LICENSE_PUBLIC_KEY) and
// verifies. Keep the private key OFF this server in production; this helper is an
// operator/issuer convenience. Point the server at the output with LICENSE_FILE.
const fs = require('fs');
const crypto = require('crypto');
const { canonicalize } = require('../src/lib/canonicalize');
const { ALL_FEATURE_KEYS } = require('../src/license/plans');

function parseArgs(argv) {
  const out = { feature: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
    if (key === 'feature') out.feature.push(val);
    else out[key] = val;
  }
  return out;
}

// Accepts a YYYY-MM-DD or full ISO string; returns an ISO 8601 UTC string.
function toIso(v, fallback) {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`invalid date: ${v}`);
  return new Date(t).toISOString();
}

function intOrNull(v) {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got: ${v}`);
  return n;
}

function run() {
  const args = parseArgs(process.argv);
  if (!args.key || !args.plan) {
    console.error('Usage: node scripts/sign-offline-license.js --key <private.pem> --plan <plan_key> [--out license.json] [--org ID] [--server ID] [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--max-agents N] [--max-test-paths N] [--feature KEY ...]');
    process.exit(2);
  }

  for (const f of args.feature) {
    if (!ALL_FEATURE_KEYS.includes(f)) {
      console.error(`Unknown feature key '${f}'. Valid keys: ${ALL_FEATURE_KEYS.join(', ')}`);
      process.exit(2);
    }
  }

  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const payload = {
    organization_id: args.org || null,
    plan_key: args.plan,
    serverId: args.server || '',
    valid_from: toIso(args.from, now.toISOString()),
    valid_until: toIso(args.until, oneYear.toISOString()),
    max_agents_override: intOrNull(args['max-agents']),
    max_test_paths_override: intOrNull(args['max-test-paths']),
    enabled_features_override: args.feature,
  };

  const privateKey = fs.readFileSync(args.key, 'utf8');
  const signature = crypto
    .sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey)
    .toString('base64');

  const file = { payload, signature };
  const json = `${JSON.stringify(file, null, 2)}\n`;
  if (args.out) {
    fs.writeFileSync(args.out, json, { mode: 0o600 });
    console.log(`Wrote signed offline license to ${args.out}`);
    console.log(`Point the server at it with: LICENSE_FILE=${args.out} (LICENSE_MODE=offline is implied).`);
  } else {
    process.stdout.write(json);
  }
}

run();
