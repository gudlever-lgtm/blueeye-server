import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Deterministic ("canonical") JSON serialization — MUST be byte-identical to
 * the signer in blueeye-licenseserver (`src/signing.js`). Object keys are sorted
 * recursively so both sides hash the exact same bytes.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
    .join(',')}}`;
}

/**
 * Verify a signed `/validate` response against the embedded public key.
 *
 * Returns `{ ok, reason, payload }`. This checks the signature and algorithm
 * only — binding to our own serverId is the caller's responsibility (see
 * manager.js). The verified payload is a *license proof*, never an access token.
 */
export function verifyResponse(response, publicKeyPem) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'malformed response' };
  }
  const { payload, signature, algorithm } = response;
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string') {
    return { ok: false, reason: 'missing payload or signature' };
  }
  if (algorithm && algorithm !== 'ed25519') {
    return { ok: false, reason: `unsupported algorithm: ${algorithm}` };
  }
  let ok = false;
  try {
    const key = createPublicKey(publicKeyPem);
    ok = cryptoVerify(
      null, // null algorithm => Ed25519
      Buffer.from(canonicalize(payload), 'utf8'),
      key,
      Buffer.from(signature, 'base64')
    );
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
  if (!ok) {
    return { ok: false, reason: 'invalid signature' };
  }
  return { ok: true, payload };
}
