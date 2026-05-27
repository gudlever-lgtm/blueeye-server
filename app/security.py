"""Hashing and token utilities."""
import hashlib
import secrets

import bcrypt


def hash_password(password: str) -> str:
    # bcrypt operates on the first 72 bytes of the input; longer passwords are
    # silently truncated by the library, which matches standard bcrypt behaviour.
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def generate_token(nbytes: int = 32) -> str:
    return secrets.token_hex(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
