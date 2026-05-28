"""Admin UI: users, customers, licenses, API keys."""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import has_blackeye, require_role
from ..db import get_db
from ..licensing import (
    count_active_agents,
    current_status as license_status,
    server_fingerprint,
    validate_now,
)
from ..models import ApiKey, Customer, License, User
from ..security import generate_token, hash_password, sha256_hex

router = APIRouter(prefix="/admin", tags=["ui-admin"])
templates = Jinja2Templates(directory="app/templates")


def _ctx(request: Request, user: User, customer: Customer, **kwargs):
    return {
        "request": request,
        "user": user,
        "customer": customer,
        "has_blackeye": has_blackeye(customer),
        **kwargs,
    }


# ---- Users ----

@router.get("/users", response_class=HTMLResponse)
async def list_users(
    request: Request,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    if user.role == "superadmin":
        users = (await db.execute(select(User).order_by(User.email))).scalars().all()
    else:
        users = (await db.execute(
            select(User).where(User.customer_id == user.customer_id).order_by(User.email)
        )).scalars().all()
    return templates.TemplateResponse("admin/users.html", _ctx(request, user, customer, users=users))


@router.get("/users/new", response_class=HTMLResponse)
async def new_user_form(
    request: Request,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    customers = []
    if user.role == "superadmin":
        customers = (await db.execute(select(Customer).order_by(Customer.name))).scalars().all()
    return templates.TemplateResponse(
        "admin/user_form.html",
        _ctx(request, user, customer, target_user=None, customers=customers, error=None),
    )


@router.post("/users/new")
async def create_user(
    email: str = Form(...),
    password: str = Form(...),
    role: str = Form(...),
    customer_id: Optional[int] = Form(None),
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    if role not in ("superadmin", "admin", "viewer"):
        raise HTTPException(400, "Invalid role")
    if user.role != "superadmin" and role == "superadmin":
        raise HTTPException(403, "Forbidden")
    target_customer_id = customer_id if user.role == "superadmin" else user.customer_id
    if not target_customer_id:
        raise HTTPException(400, "Customer is required")
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    new = User(
        email=email.lower().strip(),
        password_hash=hash_password(password),
        role=role,
        customer_id=target_customer_id,
        active=True,
    )
    db.add(new)
    await db.commit()
    return RedirectResponse("/admin/users", status_code=302)


@router.get("/users/{user_id}/edit", response_class=HTMLResponse)
async def edit_user_form(
    user_id: int,
    request: Request,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "Not found")
    if user.role != "superadmin" and target.customer_id != user.customer_id:
        raise HTTPException(403, "Forbidden")
    customer = await db.get(Customer, user.customer_id)
    customers = []
    if user.role == "superadmin":
        customers = (await db.execute(select(Customer).order_by(Customer.name))).scalars().all()
    return templates.TemplateResponse(
        "admin/user_form.html",
        _ctx(request, user, customer, target_user=target, customers=customers, error=None),
    )


@router.post("/users/{user_id}/edit")
async def update_user(
    user_id: int,
    email: str = Form(...),
    role: str = Form(...),
    active: Optional[str] = Form(None),
    password: str = Form(""),
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "Not found")
    if user.role != "superadmin" and target.customer_id != user.customer_id:
        raise HTTPException(403, "Forbidden")
    if role not in ("superadmin", "admin", "viewer"):
        raise HTTPException(400, "Invalid role")
    if user.role != "superadmin" and role == "superadmin":
        raise HTTPException(403, "Forbidden")
    target.email = email.lower().strip()
    target.role = role
    target.active = (active == "on")
    if password:
        if len(password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        target.password_hash = hash_password(password)
    await db.commit()
    return RedirectResponse("/admin/users", status_code=302)


# ---- Customers (superadmin only) ----

@router.get("/customers", response_class=HTMLResponse)
async def list_customers(
    request: Request,
    user: User = Depends(require_role("superadmin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    customers = (await db.execute(select(Customer).order_by(Customer.name))).scalars().all()
    return templates.TemplateResponse(
        "admin/customers.html",
        _ctx(request, user, customer, customers=customers),
    )


@router.get("/customers/new", response_class=HTMLResponse)
async def new_customer_form(
    request: Request,
    user: User = Depends(require_role("superadmin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    return templates.TemplateResponse(
        "admin/customer_form.html",
        _ctx(request, user, customer, target=None, error=None),
    )


@router.post("/customers/new")
async def create_customer(
    name: str = Form(...),
    slug: str = Form(...),
    license_tier: str = Form("blueeye"),
    user: User = Depends(require_role("superadmin")),
    db: AsyncSession = Depends(get_db),
):
    if license_tier not in ("blueeye", "blackeye"):
        raise HTTPException(400, "Invalid tier")
    c = Customer(
        name=name.strip(),
        slug=slug.strip().lower(),
        license_tier=license_tier,
        active=True,
    )
    db.add(c)
    await db.commit()
    return RedirectResponse("/admin/customers", status_code=302)


# ---- Licenses ----

@router.get("/licenses", response_class=HTMLResponse)
async def list_licenses(
    request: Request,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    stmt = (
        select(License, Customer)
        .join(Customer, Customer.id == License.customer_id)
        .order_by(License.issued_at.desc())
    )
    if user.role != "superadmin":
        stmt = stmt.where(License.customer_id == user.customer_id)
    rows = (await db.execute(stmt)).all()
    customers = []
    if user.role == "superadmin":
        customers = (await db.execute(select(Customer).order_by(Customer.name))).scalars().all()
    return templates.TemplateResponse(
        "admin/licenses.html",
        _ctx(request, user, customer, rows=rows, customers=customers),
    )


@router.post("/licenses/issue")
async def issue_license(
    customer_id: int = Form(...),
    tier: str = Form("blackeye"),
    days: int = Form(365),
    user: User = Depends(require_role("superadmin")),
    db: AsyncSession = Depends(get_db),
):
    if tier not in ("blueeye", "blackeye"):
        raise HTTPException(400, "Invalid tier")
    target = await db.get(Customer, customer_id)
    if target is None:
        raise HTTPException(404, "Customer not found")
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(days=max(1, days))
    target.license_tier = tier
    target.license_expiry = expiry
    db.add(License(
        customer_id=target.id,
        tier=tier,
        issued_at=now,
        expires_at=expiry,
        status="active",
    ))
    await db.commit()
    return RedirectResponse("/admin/licenses", status_code=302)


@router.post("/licenses/{license_id}/revoke")
async def revoke_license(
    license_id: int,
    user: User = Depends(require_role("superadmin")),
    db: AsyncSession = Depends(get_db),
):
    lic = await db.get(License, license_id)
    if lic is None:
        raise HTTPException(404, "Not found")
    lic.status = "revoked"
    lic.expires_at = datetime.now(timezone.utc)
    target = await db.get(Customer, lic.customer_id)
    if target is not None:
        target.license_tier = "blueeye"
        target.license_expiry = None
    await db.commit()
    return RedirectResponse("/admin/licenses", status_code=302)


# ---- API keys ----

@router.get("/api-keys", response_class=HTMLResponse)
async def list_api_keys(
    request: Request,
    new_key: Optional[str] = None,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    stmt = (
        select(ApiKey, Customer)
        .join(Customer, Customer.id == ApiKey.customer_id)
        .order_by(ApiKey.created_at.desc())
    )
    if user.role != "superadmin":
        stmt = stmt.where(ApiKey.customer_id == user.customer_id)
    rows = (await db.execute(stmt)).all()
    customers = []
    if user.role == "superadmin":
        customers = (await db.execute(select(Customer).order_by(Customer.name))).scalars().all()
    return templates.TemplateResponse(
        "admin/api_keys.html",
        _ctx(request, user, customer, rows=rows, new_key=new_key, customers=customers),
    )


@router.post("/api-keys/new")
async def create_api_key(
    label: str = Form(...),
    scopes: str = Form("read"),
    expires_days: int = Form(0),
    customer_id: Optional[int] = Form(None),
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    target_customer_id = (
        customer_id if (user.role == "superadmin" and customer_id) else user.customer_id
    )
    token = generate_token(32)
    expires_at = None
    if expires_days > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(days=expires_days)
    key = ApiKey(
        customer_id=target_customer_id,
        key_hash=sha256_hex(token),
        label=label.strip(),
        scopes=scopes,
        expires_at=expires_at,
    )
    db.add(key)
    await db.commit()
    return RedirectResponse(f"/admin/api-keys?new_key={token}", status_code=302)


@router.post("/api-keys/{key_id}/revoke")
async def revoke_api_key(
    key_id: int,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    key = await db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "Not found")
    if user.role != "superadmin" and key.customer_id != user.customer_id:
        raise HTTPException(403, "Forbidden")
    await db.delete(key)
    await db.commit()
    return RedirectResponse("/admin/api-keys", status_code=302)


# ---- Platform license ----

@router.get("/license", response_class=HTMLResponse)
async def license_page(
    request: Request,
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    status = license_status()
    active_agents = await count_active_agents(db)
    ctx = _ctx(
        request, user, customer,
        license_state=status,
        active_agents=active_agents,
        fingerprint=server_fingerprint(),
    )
    return templates.TemplateResponse("admin/license.html", ctx)


@router.post("/license/revalidate")
async def license_revalidate(
    user: User = Depends(require_role("superadmin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    await validate_now(db)
    return RedirectResponse("/admin/license", status_code=302)
