import { readFileSync } from 'node:fs';
import { LICENSE_PUBLIC_KEY_PEM } from './license/publicKey.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The license public key is set at install/build time, not via CRUD. Prefer an
// explicit override (env), otherwise use the key embedded in the build.
function resolveLicensePublicKey() {
  if (process.env.LICENSE_PUBLIC_KEY) {
    return process.env.LICENSE_PUBLIC_KEY;
  }
  if (process.env.LICENSE_PUBLIC_KEY_PATH) {
    try {
      return readFileSync(process.env.LICENSE_PUBLIC_KEY_PATH, 'utf8');
    } catch {
      // fall back to the embedded key
    }
  }
  return LICENSE_PUBLIC_KEY_PEM;
}

const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4000', 10),
  dbPath: process.env.DB_PATH ?? '/data/blueeye.db',
  rcaUrl: process.env.RCA_URL ?? 'http://blueeye-rca:5000',
  rcaEnabled: (process.env.RCA_ENABLED ?? 'true') !== 'false',

  // License validation against blueeye-licenseserver. Install-time config (not
  // CRUD). Enforcement is enabled only when LICENSE_KEY is set, so existing
  // unlicensed/dev deployments keep their current behavior.
  license: {
    enabled: Boolean(process.env.LICENSE_KEY),
    licenseKey: process.env.LICENSE_KEY ?? null,
    serverId: process.env.SERVER_ID ?? null,
    serverUrl: process.env.LICENSE_SERVER_URL ?? 'http://blueeye-licenseserver:4100',
    publicKeyPem: resolveLicensePublicKey(),
    pollIntervalMs: parseInt(process.env.LICENSE_POLL_INTERVAL_MS ?? String(6 * HOUR_MS), 10),
    graceMs: parseInt(process.env.LICENSE_GRACE_MS ?? String(14 * DAY_MS), 10),
    cachePath: process.env.LICENSE_CACHE_PATH ?? '/data/license-cache.json',
  },
};

export default config;
