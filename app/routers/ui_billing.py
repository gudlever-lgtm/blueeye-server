"""BlackEye upgrade flow via Mollie."""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import has_blackeye, require_user
from ..config import settings
from ..db import get_db
from ..models import Customer, License, User

log = logging.getLogger("blueeye.billing")
router = APIRouter(tags=["ui-billing"])
templates = Jinja2Templates(directory="app/templates")


def _mollie_client():
    # Import lazily so the rest of the app boots even when Mollie isn't installed
    # in some dev environment.
    from mollie.api.client import Client

    client = Client()
    if settings.MOLLIE_API_KEY:
        client.set_api_key(settings.MOLLIE_API_KEY)
    return client


@router.get("/billing/upgrade", response_class=HTMLResponse)
async def upgrade_page(
    request: Request,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    return templates.TemplateResponse(
        "billing/upgrade.html",
        {
            "request": request,
            "user": user,
            "customer": customer,
            "has_blackeye": has_blackeye(customer),
            "price": settings.BLACKEYE_ANNUAL_PRICE_EUR,
            "error": None,
        },
    )


@router.post("/billing/upgrade")
async def upgrade_create_payment(
    request: Request,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    customer = await db.get(Customer, user.customer_id)
    if has_blackeye(customer):
        return RedirectResponse("/billing/upgrade", status_code=302)
    if not settings.MOLLIE_API_KEY:
        return templates.TemplateResponse(
            "billing/upgrade.html",
            {
                "request": request,
                "user": user,
                "customer": customer,
                "has_blackeye": False,
                "price": settings.BLACKEYE_ANNUAL_PRICE_EUR,
                "error": "Payments are not configured on this server.",
            },
            status_code=503,
        )

    base = settings.PUBLIC_BASE_URL.rstrip("/")
    try:
        payment = _mollie_client().payments.create({
            "amount": {
                "currency": "EUR",
                "value": f"{settings.BLACKEYE_ANNUAL_PRICE_EUR:.2f}",
            },
            "description": f"BlueEye BlackEye annual license — {customer.name}",
            "redirectUrl": f"{base}/billing/upgrade",
            "webhookUrl": f"{base}/billing/webhook",
            "metadata": {"customer_id": customer.id},
        })
    except Exception as exc:
        log.error("Mollie payment create failed: %s", exc)
        return templates.TemplateResponse(
            "billing/upgrade.html",
            {
                "request": request,
                "user": user,
                "customer": customer,
                "has_blackeye": False,
                "price": settings.BLACKEYE_ANNUAL_PRICE_EUR,
                "error": "Payment provider unavailable, please try again later.",
            },
            status_code=502,
        )

    db.add(License(
        customer_id=customer.id,
        tier="blackeye",
        mollie_payment_id=payment.id,
        status="pending",
    ))
    await db.commit()
    return RedirectResponse(payment.checkout_url, status_code=302)


@router.post("/billing/webhook")
async def webhook(request: Request, db: AsyncSession = Depends(get_db)):
    form = await request.form()
    payment_id = form.get("id")
    if not payment_id:
        raise HTTPException(400, "Missing id")
    try:
        payment = _mollie_client().payments.get(payment_id)
    except Exception as exc:
        log.error("Mollie webhook fetch failed for %s: %s", payment_id, exc)
        raise HTTPException(502, "Provider unavailable") from exc

    lic = (await db.execute(
        select(License).where(License.mollie_payment_id == payment_id)
    )).scalar_one_or_none()
    if lic is None:
        log.warning("Webhook for unknown payment %s", payment_id)
        return {"ok": True}

    if payment.is_paid():
        now = datetime.now(timezone.utc)
        expiry = now + timedelta(days=365)
        lic.status = "active"
        lic.issued_at = now
        lic.expires_at = expiry
        customer = await db.get(Customer, lic.customer_id)
        if customer is not None:
            customer.license_tier = "blackeye"
            customer.license_expiry = expiry
        await db.commit()
        log.info(
            "BlackEye activated for customer %s via payment %s",
            lic.customer_id, payment_id,
        )
    elif payment.is_failed() or payment.is_canceled() or payment.is_expired():
        lic.status = "failed"
        await db.commit()
    return {"ok": True}
