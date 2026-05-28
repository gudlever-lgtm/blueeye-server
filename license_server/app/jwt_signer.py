"""Sign license JWTs with the Ed25519 private key."""
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import jwt

from .config import settings

log = logging.getLogger("license.jwt")

_private_key_pem: Optional[str] = None


def _load_private_key() -> str:
    global _private_key_pem
    if _private_key_pem is not None:
        return _private_key_pem

    if settings.LICENSE_PRIVATE_KEY_PEM:
        _private_key_pem = settings.LICENSE_PRIVATE_KEY_PEM
        return _private_key_pem

    if settings.LICENSE_PRIVATE_KEY_FILE:
        path = Path(settings.LICENSE_PRIVATE_KEY_FILE)
        if not path.exists():
            raise RuntimeError(f"LICENSE_PRIVATE_KEY_FILE not found: {path}")
        _private_key_pem = path.read_text()
        return _private_key_pem

    raise RuntimeError(
        "No license signing key configured. Set LICENSE_PRIVATE_KEY_PEM or "
        "LICENSE_PRIVATE_KEY_FILE in the environment."
    )


def sign_license(payload: dict) -> str:
    """Sign the payload with EdDSA. Caller supplies the business fields;
    we set the standard timestamps."""
    now = int(datetime.now(timezone.utc).timestamp())
    claims = {
        **payload,
        "iat": now,
        "nbf": now,
        "exp": now + settings.LICENSE_JWT_TTL_SECONDS,
        "iss": "blueeye-license-server",
    }
    return jwt.encode(claims, _load_private_key(), algorithm="EdDSA")
