# License verification

`blueeye-server` validates its license against
[`blueeye-licenseserver`](../../blueeye-licenseserver) and verifies the signed
response against an **embedded Ed25519 public key**. This means a valid license
cannot be forged by anyone who does not hold the license server's private key —
not even by spoofing the license server or tampering with the network path.

## Trust model

> **The validation is a license proof, not an access token.**

The signed `/validate` response only governs:

1. whether the license is valid, and
2. the `max_agents` capacity cap.

It is **never** used to authenticate agents. Agent bearer tokens are issued and
verified entirely locally by `blueeye-server` (Flow 1); the license server never
sees, issues, or validates an agent token. Keeping these flows separate means a
license outage can (at most, after the grace period) stop *new* agents from
connecting — it can never become a single point of auth for the whole fleet.

## Configuration (install-time, not CRUD)

| Setting              | Env                       | Notes                                  |
| -------------------- | ------------------------- | -------------------------------------- |
| License key          | `LICENSE_KEY`             | Enables enforcement when set           |
| Server identity      | `SERVER_ID`               | Must match `payload.serverId`          |
| License server URL   | `LICENSE_SERVER_URL`      | Default `http://blueeye-licenseserver:4100` |
| Embedded public key  | `src/license/publicKey.js`| Override: `LICENSE_PUBLIC_KEY[_PATH]`  |
| Offline grace        | `LICENSE_GRACE_MS`        | Default 14 days                        |
| Re-validation period | `LICENSE_POLL_INTERVAL_MS`| Default 6 hours                        |
| Cache file           | `LICENSE_CACHE_PATH`      | Default `/data/license-cache.json`     |

## Where the public key is embedded

```
src/license/publicKey.js   →  LICENSE_PUBLIC_KEY_PEM (the embedded key, used by default)
keys/license_public.pem    →  reference copy / source for LICENSE_PUBLIC_KEY_PATH
```

Current embedded key:

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9t271qaBYut4TNuBHT34FhL0ukBzxrqKVQWuKcneBI=
-----END PUBLIC KEY-----
```

To rotate: replace the constant in `src/license/publicKey.js` (and
`keys/license_public.pem`) with the new public key from
`blueeye-licenseserver`’s `npm run keys:generate`, then redeploy.

## Flow

1. **Startup + every 6h** — POST `{licenseKey, serverId, agentCount}` to
   `LICENSE_SERVER_URL/validate`.
2. **Verify** — recompute the canonical JSON of `payload` and check the Ed25519
   signature against the embedded public key (`src/license/verify.js`).
3. **Bind** — reject the response if the signature is invalid **or**
   `payload.serverId !== SERVER_ID`.
4. **Cache** — on a verified `valid: true`, write `{payload, verifiedAt}` to
   `LICENSE_CACHE_PATH`.
5. **Grace** — if the license server is unreachable, keep honoring the cached
   validation for `LICENSE_GRACE_MS` (14 days). After that → hard fail.
6. **Enforce** — `max_agents` from the cached validation gates *new* agent
   WebSocket connections (`src/ws/server.js`). Re-connections of already-known
   agents are always allowed.

## Modules

| File                      | Responsibility                                       |
| ------------------------- | ---------------------------------------------------- |
| `src/license/publicKey.js`| The embedded Ed25519 public key                      |
| `src/license/verify.js`   | `canonicalize()` + `verifyResponse()` (signature)    |
| `src/license/cache.js`    | Read/write the on-disk validation cache              |
| `src/license/manager.js`  | Poll, verify, bind, cache, grace, capacity gate      |

`canonicalize()` MUST stay byte-identical to the signer in
`blueeye-licenseserver/src/signing.js`.
