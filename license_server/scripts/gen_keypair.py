"""Generate a fresh Ed25519 keypair for license signing.

Usage:
    python -m license_server.scripts.gen_keypair

Prints:
- PRIVATE KEY (PEM) — load into the License Server via LICENSE_PRIVATE_KEY_PEM
  or write to the file pointed to by LICENSE_PRIVATE_KEY_FILE.
- PUBLIC KEY (PEM)  — paste into BlueEye Server's app/licensing.py as
  LICENSE_SERVER_PUBLIC_KEY_PEM.

Run this at build time. The same keypair must be used by both servers.
"""
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def main() -> None:
    priv = Ed25519PrivateKey.generate()
    priv_pem = priv.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    pub_pem = priv.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    print("# Ed25519 signing keypair for BlueEye License Server\n")
    print("# === PRIVATE KEY (keep on License Server only) ===")
    print(priv_pem.decode())
    print("# === PUBLIC KEY (embed in BlueEye Server source) ===")
    print(pub_pem.decode())


if __name__ == "__main__":
    main()
