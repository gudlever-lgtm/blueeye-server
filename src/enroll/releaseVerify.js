'use strict';

// The Ed25519 verification step both installers run, in one place.
//
// WHY THIS IS SHARED RATHER THAN WRITTEN TWICE. It is the one piece of the
// install path that decides whether code is authentic. Two copies of it in two
// languages is two chances for one of them to drift into accepting something
// the other rejects, and the failure is silent — an installer that verifies
// nothing looks exactly like one that verifies everything.
//
// WHAT IS VERIFIED, AND WHAT THAT BUYS:
//
//   signature  Ed25519 over the release MANIFEST, checked against the key the
//              host has pinned. Authenticates who published the release.
//   sha256     the manifest's own sha256 field, compared to the bytes that
//              actually arrived. Binds the signature to THIS download — without
//              it a valid signature could be replayed over any tarball.
//
// Both are needed; either alone proves nothing useful. The manifest bytes come
// from the X-Release-Manifest header, which carries the CANONICAL form — the
// exact bytes that were signed — so nothing here has to reimplement the
// canonical JSON rules to check a signature.

// The verifier, as a standalone program. Run as:
//   node <file> <manifest-file> <signature-file> <key-file>
// Exit 0 = verified, 1 = not verified, 2 = could not even attempt.
//
// It reads the key as PEM, or as base64-of-PEM (the form the pinned
// BLUEEYE_RELEASE_PUBLIC_KEY may take), because both are in the field.
//
// Every failure path exits non-zero. There is deliberately no "assume fine"
// branch: a verifier that passes when it is confused is worse than none,
// because the caller stops looking.
const NODE_VERIFIER_JS = `'use strict';
const fs = require('fs');
const crypto = require('crypto');
try {
  const [manifestFile, signatureFile, keyFile] = process.argv.slice(2);
  if (!manifestFile || !signatureFile || !keyFile) process.exit(2);
  let key = fs.readFileSync(keyFile, 'utf8').trim();
  if (key.indexOf('-----BEGIN') !== 0) key = Buffer.from(key, 'base64').toString('utf8');
  const ok = crypto.verify(
    null,
    fs.readFileSync(manifestFile),
    crypto.createPublicKey(key),
    Buffer.from(fs.readFileSync(signatureFile, 'utf8').trim(), 'base64')
  );
  process.exit(ok ? 0 : 1);
} catch (err) {
  process.exit(2);
}
`;

// Pulls the sha256 out of the canonical manifest without a JSON parser — the
// installers are shell and PowerShell, and neither has one to hand.
//
// Safe to do by pattern HERE and nowhere else: the bytes have already been
// authenticated by the signature check, and the canonical form is fixed (keys
// sorted, no whitespace), so the field cannot move or be padded. The pattern
// requires exactly 64 hex characters, so a truncated or decorated value fails
// rather than matching something shorter.
const MANIFEST_SHA_REGEX = '"sha256":"[0-9a-f]{64}"';

// Kept identical on both platforms so a release that installs on one cannot be
// refused by the other for a reason that is not about the release.
const VERDICTS = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',   // no verifier on this host — see the fallback rule
  FAILED: 'failed',           // a verifier ran and said no. Always fatal.
});

module.exports = { NODE_VERIFIER_JS, MANIFEST_SHA_REGEX, VERDICTS };
