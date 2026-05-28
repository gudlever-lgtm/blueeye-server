"""License Server FastAPI app."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .db import init_db
from .routers import admin_ui, license_api

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("license.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    log.info("License Server started")
    yield
    log.info("License Server stopped")


app = FastAPI(title="BlueEye License Server", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie="license_session",
    same_site="lax",
    https_only=settings.SESSION_COOKIE_SECURE,
)

app.mount(
    "/static",
    StaticFiles(directory="license_server/app/static"),
    name="static",
)

app.include_router(license_api.router)
app.include_router(admin_ui.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
