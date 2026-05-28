import { dirname, join } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;

// Embedded license public key. This is the vendor's Ed25519 public key used to
// verify validation responses from the BlueEye License server. It is shipped
// with the build and set at install time — override with LICENSE_PUBLIC_KEY to
// point at your own license server's key. The matching private key lives only
// on the license server and never here. (The default below is a demo key.)
const DEFAULT_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQ5VNABY/Ltjlet7jZwtbnf8364rwyT5TTxEPGuSLbMM=
-----END PUBLIC KEY-----`;

const dbPath = process.env.DB_PATH ?? '/data/blueeye.db';

// License enforcement is on by default once a LICENSE_KEY is configured. It can
// be explicitly forced on/off with LICENSE_ENABLED. With no key and no explicit
// opt-in it stays off, so local/dev runs need no license server.
const licenseEnabled =
  (process.env.LICENSE_ENABLED ?? (process.env.LICENSE_KEY ? 'true' : 'false')) !==
  'false';

const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4000', 10),
  dbPath,
  rcaUrl: process.env.RCA_URL ?? 'http://blueeye-rca:5000',
  rcaEnabled: (process.env.RCA_ENABLED ?? 'true') !== 'false',

  // --- License validation (set at install time; not exposed via CRUD) ---
  licenseEnabled,
  licenseKey: process.env.LICENSE_KEY ?? '',
  serverId: process.env.SERVER_ID ?? '',
  licenseServerUrl: process.env.LICENSE_SERVER_URL ?? 'http://blueeye-licens:6000',
  licensePublicKey: process.env.LICENSE_PUBLIC_KEY ?? DEFAULT_LICENSE_PUBLIC_KEY,
  licenseGraceDays: parseInt(process.env.LICENSE_GRACE_DAYS ?? '14', 10),
  licenseValidateIntervalMs: parseInt(
    process.env.LICENSE_VALIDATE_INTERVAL_MS ?? String(6 * HOUR_MS),
    10
  ),
  licenseCachePath:
    process.env.LICENSE_CACHE_PATH ?? join(dirname(dbPath), 'license-cache.json'),
};

export default config;
