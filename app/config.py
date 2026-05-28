"""Application settings loaded from environment / .env."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://blueeye:blueeye@localhost:5432/blueeye"
    SECRET_KEY: str = "dev-secret-please-change"

    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "BlueEye <noreply@blueeye.local>"

    PUBLIC_BASE_URL: str = "http://localhost:8000"

    MOLLIE_API_KEY: str = ""
    BLACKEYE_ANNUAL_PRICE_EUR: float = 499.00

    DEFAULT_SUPERADMIN_EMAIL: str = "admin@blueeye.local"
    DEFAULT_SUPERADMIN_PASSWORD: str = "admin"

    PASSWORD_RESET_TOKEN_TTL_SECONDS: int = 3600
    AGENT_OFFLINE_AFTER_SECONDS: int = 180

    SESSION_COOKIE_SECURE: bool = False

    LICENSE_SERVER_URL: str = ""
    LICENSE_KEY: str = ""
    LICENSE_VALIDATE_INTERVAL_SECONDS: int = 86400
    LICENSE_GRACE_PERIOD_SECONDS: int = 7 * 86400
    LICENSE_HTTP_TIMEOUT_SECONDS: int = 10
    LICENSE_FREE_TIER_MAX_AGENTS: int = 5
    BLUEEYE_VERSION: str = "0.1.0"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
