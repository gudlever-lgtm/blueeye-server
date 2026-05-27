"""Login / logout / password reset UI routes."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..mailer import send_password_reset
from ..models import User
from ..security import generate_token, hash_password, verify_password

router = APIRouter(tags=["ui-auth"])
templates = Jinja2Templates(directory="app/templates")


@router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    if request.session.get("user_id"):
        return RedirectResponse("/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "error": None})


@router.post("/login", response_class=HTMLResponse)
async def login_submit(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == email.lower().strip()))
    user = result.scalar_one_or_none()
    if user is None or not user.active or not verify_password(password, user.password_hash):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Invalid email or password"},
            status_code=401,
        )
    request.session["user_id"] = user.id
    return RedirectResponse(url="/dashboard", status_code=302)


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=302)


@router.get("/forgot-password", response_class=HTMLResponse)
async def forgot_form(request: Request):
    return templates.TemplateResponse("forgot_password.html", {"request": request, "sent": False})


@router.post("/forgot-password", response_class=HTMLResponse)
async def forgot_submit(
    request: Request,
    email: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == email.lower().strip()))
    user = result.scalar_one_or_none()
    if user is not None and user.active:
        token = generate_token(24)
        user.reset_token = token
        user.reset_expiry = datetime.now(timezone.utc) + timedelta(
            seconds=settings.PASSWORD_RESET_TOKEN_TTL_SECONDS
        )
        await db.commit()
        send_password_reset(user.email, token)
    # Always render the success state so the response doesn't disclose whether
    # the address belongs to a real account.
    return templates.TemplateResponse("forgot_password.html", {"request": request, "sent": True})


@router.get("/reset-password", response_class=HTMLResponse)
async def reset_form(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    user = await _user_for_reset_token(db, token)
    return templates.TemplateResponse(
        "reset_password.html",
        {
            "request": request,
            "token": token,
            "valid": user is not None,
            "error": None,
            "done": False,
        },
    )


@router.post("/reset-password", response_class=HTMLResponse)
async def reset_submit(
    request: Request,
    token: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    user = await _user_for_reset_token(db, token)
    if user is None:
        return templates.TemplateResponse(
            "reset_password.html",
            {
                "request": request,
                "token": token,
                "valid": False,
                "error": "Invalid or expired token",
                "done": False,
            },
            status_code=400,
        )
    if password != password_confirm or len(password) < 8:
        return templates.TemplateResponse(
            "reset_password.html",
            {
                "request": request,
                "token": token,
                "valid": True,
                "error": "Passwords must match and be at least 8 characters",
                "done": False,
            },
            status_code=400,
        )
    user.password_hash = hash_password(password)
    user.reset_token = None
    user.reset_expiry = None
    await db.commit()
    return templates.TemplateResponse(
        "reset_password.html",
        {
            "request": request,
            "token": token,
            "valid": True,
            "error": None,
            "done": True,
        },
    )


async def _user_for_reset_token(db: AsyncSession, token: str) -> User | None:
    if not token:
        return None
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(User).where(
            User.reset_token == token,
            User.reset_expiry > now,
            User.active.is_(True),
        )
    )
    return result.scalar_one_or_none()
