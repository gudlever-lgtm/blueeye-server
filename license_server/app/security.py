"""Password hashing + license key generation."""
import hashlib
import secrets

import bcrypt


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def generate_license_key() -> str:
    # Five 5-character blocks: BLU-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX  (matches the
    # shape customers will paste back into BlueEye Server's .env).
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
    blocks = ["".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(5)]
    return "BLU-" + "-".join(blocks)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
