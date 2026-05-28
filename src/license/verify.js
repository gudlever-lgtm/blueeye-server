import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Verify a signed license token against the embedded public key.
 *
 * The license server returns a token as `{ signedLicense, signature, alg }`
 * where:
 *   - `signedLicense` is the base64 of the exact UTF-8 JSON bytes that were
 *     signed (the license claims).
 *   - `signature`     is the base64 Ed25519 signature over those same bytes.
 *
 * Signing over an opaque base64 blob (rather than re-serialising the parsed
 * object) avoids any JSON canonicalisation mismatch between signer and
 * verifier: we verify the bytes exactly as they were signed, then parse.
 *
 * @param {string} signedLicense base64 of the signed JSON payload
 * @param {string} signature     base64 Ed25519 signature
 * @param {string|Buffer} publicKeyPem  SPKI/PEM Ed25519 public key
 * @returns {object} the parsed license claims
 * @throws if anything is missing, the signature is invalid, or the payload is
 *         not valid JSON.
 */
export function verifySignedLicense(signedLicense, signature, publicKeyPem) {
  if (!signedLicense || !signature) {
    throw new Error('missing signed license or signature');
  }
  if (!publicKeyPem) {
    throw new Error('no license public key configured');
  }

  const key = createPublicKey(publicKeyPem);
  const data = Buffer.from(signedLicense, 'base64');
  const sig = Buffer.from(signature, 'base64');

  // Algorithm `null` selects EdDSA for an Ed25519 key.
  const ok = cryptoVerify(null, data, key, sig);
  if (!ok) {
    throw new Error('invalid signature');
  }

  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('license payload is not valid JSON');
  }
}
