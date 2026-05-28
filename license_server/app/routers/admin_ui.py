"""Admin UI for license management."""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import require_admin
from ..db import get_db
from ..models import AdminUser, License
from ..security import generate_license_key, hash_password, sha256_hex, verify_password

router = APIRouter(tags=["admin"])
templates = Jinja2Templates(directory="license_server/app/templates")


@router.get("/", response_class=HTMLResponse)
async def root(request: Request):
    target = "/admin/licenses" if request.session.get("admin_id") else "/admin/login"
    return RedirectResponse(target)


@router.get("/admin/login", response_class=HTMLResponse)
async def login_form(request: Request):
    if request.session.get("admin_id"):
        return RedirectResponse("/admin/licenses", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "error": None})


@router.post("/admin/login", response_class=HTMLResponse)
async def login_submit(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(AdminUser).where(AdminUser.email == email.lower().strip()))
    admin = result.scalar_one_or_none()
    if admin is None or not admin.active or not verify_password(password, admin.password_hash):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Invalid email or password"},
            status_code=401,
        )
    request.session["admin_id"] = admin.id
    return RedirectResponse("/admin/licenses", status_code=302)


@router.get("/admin/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/admin/login", status_code=302)


@router.get("/admin/licenses", response_class=HTMLResponse)
async def list_licenses(
    request: Request,
    new_key: Optional[str] = None,
    admin: AdminUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(select(License).order_by(License.created_at.desc()))).scalars().all()
    return templates.TemplateResponse(
        "licenses.html",
        {"request": request, "admin": admin, "rows": rows, "new_key": new_key},
    )


@router.get("/admin/licenses/new", response_class=HTMLResponse)
async def new_license_form(
    request: Request,
    admin: AdminUser = Depends(require_admin),
):
    return templates.TemplateResponse(
        "license_new.html",
        {"request": request, "admin": admin, "error": None},
    )


@router.post("/admin/licenses/new")
async def create_license(
    customer_name: str = Form(...),
    tier: str = Form("blueeye"),
    max_agents: int = Form(5),
    features: str = Form(""),
    valid_days: int = Form(365),
    admin: AdminUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if tier not in ("blueeye", "blackeye"):
        raise HTTPException(400, "Invalid tier")
    key = generate_license_key()
    feature_list = [f.strip() for f in features.split(",") if f.strip()]
    lic = License(
        key_hash=sha256_hex(key),
        customer_name=customer_name.strip(),
        tier=tier,
        max_agents=max(1, int(max_agents)),
        features_json=feature_list,
        expires_at=datetime.now(timezone.utc) + timedelta(days=max(1, int(valid_days))),
        active=True,
    )
    db.add(lic)
    await db.commit()
    return RedirectResponse(f"/admin/licenses?new_key={key}", status_code=302)


@router.post("/admin/licenses/{license_id}/deactivate")
async def deactivate(
    license_id: int,
    admin: AdminUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    lic = await db.get(License, license_id)
    if lic is None:
        raise HTTPException(404, "Not found")
    lic.active = False
    await db.commit()
    return RedirectResponse("/admin/licenses", status_code=302)


@router.post("/admin/licenses/{license_id}/rebind")
async def rebind(
    license_id: int,
    admin: AdminUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    lic = await db.get(License, license_id)
    if lic is None:
        raise HTTPException(404, "Not found")
    lic.fingerprint = None
    lic.activated_at = None
    await db.commit()
    return RedirectResponse("/admin/licenses", status_code=302)
