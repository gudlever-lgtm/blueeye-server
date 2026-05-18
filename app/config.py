import os


class Config:
    DATABASE_URL = os.environ.get(
        "DATABASE_URL", "postgresql://blueeye:blueeye@localhost:5432/blueeye"
    )
    CA_CERT_PATH = os.environ.get("CA_CERT_PATH", "certs/ca.crt")
    SERVER_CERT = os.environ.get("SERVER_CERT", "certs/server.crt")
    SERVER_KEY = os.environ.get("SERVER_KEY", "certs/server.key")
    PORT = int(os.environ.get("PORT", "8443"))

    # Job types the agent knows how to run.
    BUILTIN_CHECKS = ("ping", "dns", "http")
