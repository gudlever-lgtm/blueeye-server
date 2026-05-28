"""License Server settings."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://license:license@localhost:5432/licenses"
    SECRET_KEY: str = "license-dev-secret-please-change"

    # PEM-encoded Ed25519 private key. Held ONLY on the License Server; the
    # matching public key is embedded in BlueEye Server source.
    LICENSE_PRIVATE_KEY_PEM: str = ""
    LICENSE_PRIVATE_KEY_FILE: str = ""

    # JWTs handed out are good for this many seconds. Short-lived to keep the
    # cache window meaningful but long enough to survive transient outages.
    LICENSE_JWT_TTL_SECONDS: int = 7200

    DEFAULT_ADMIN_EMAIL: str = "admin@license.local"
    DEFAULT_ADMIN_PASSWORD: str = "admin"

    SESSION_COOKIE_SECURE: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
