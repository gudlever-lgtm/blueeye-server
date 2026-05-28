// Embedded Ed25519 public key used to verify license validations from
// blueeye-licenseserver. This is set at build/install time and is NOT a CRUD
// value — rotating it requires redeploying the server (see
// docs/LICENSE_VERIFICATION.md).
//
// It can be overridden at runtime via LICENSE_PUBLIC_KEY (inline PEM) or
// LICENSE_PUBLIC_KEY_PATH (path to PEM) — see src/config.js.
//
// The matching private key lives only in blueeye-licenseserver. A public key is
// safe to embed and distribute.
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9t271qaBYut4TNuBHT34FhL0ukBzxrqKVQWuKcneBI=
-----END PUBLIC KEY-----
`;
