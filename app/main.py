"""BlueEye FastAPI application entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .db import init_db
from .licensing import validate_now
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
    await validate_now()
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


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 403 and "text/html" in request.headers.get("accept", ""):
        return HTMLResponse(
            content=(
                "<!doctype html><html><head><title>Access denied — BlueEye</title>"
                "<link rel='stylesheet' href='/static/style.css'></head><body>"
                "<main class='container'><h1>403 — Access denied</h1>"
                "<p>You do not have permission to view this page.</p>"
                "<p><a href='/dashboard'>Back to dashboard</a></p>"
                "</main></body></html>"
            ),
            status_code=403,
        )
    from fastapi.exception_handlers import http_exception_handler as _default
    return await _default(request, exc)


@app.get("/health")
async def health():
    return {"status": "ok"}
