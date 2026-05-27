"""BlueEye FastAPI application entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .db import init_db
from .routers import (
    agent_api,
    customer_api,
    ui_admin,
    ui_auth,
    ui_billing,
    ui_dashboard,
)
from .scheduler import schedule_tests, scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("blueeye.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    scheduler.start()
    schedule_tests()
    log.info("BlueEye server started")
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)
        log.info("BlueEye server stopped")


app = FastAPI(title="BlueEye", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie="blueeye_session",
    same_site="lax",
    https_only=settings.SESSION_COOKIE_SECURE,
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.include_router(agent_api.router)
app.include_router(customer_api.router)
app.include_router(ui_auth.router)
app.include_router(ui_dashboard.router)
app.include_router(ui_admin.router)
app.include_router(ui_billing.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
