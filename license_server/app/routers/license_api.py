"""Public license API: activate + validate."""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..jwt_signer import sign_license
from ..models import License
from ..security import sha256_hex

log = logging.getLogger("license.api")
router = APIRouter(prefix="/v1/license", tags=["license"])


class ActivateRequest(BaseModel):
    license_key: str
    fingerprint: str
    customer_name: Optional[str] = None


class ValidateRequest(BaseModel):
    license_key: str
    server_fingerprint: str
    active_agent_count: int = 0
    version: Optional[str] = None


@router.post("/activate")
async def activate(req: ActivateRequest, db: AsyncSession = Depends(get_db)):
    lic = await _lookup(db, req.license_key)
    if lic.expires_at and lic.expires_at < datetime.now(timezone.utc):
        raise HTTPException(403, "License expired")

    if lic.fingerprint and lic.fingerprint != req.fingerprint:
        raise HTTPException(
            409,
            "License is already bound to a different server fingerprint. "
            "Deactivate it from the admin UI to rebind.",
        )

    if lic.fingerprint is None:
        lic.fingerprint = req.fingerprint
        lic.activated_at = datetime.now(timezone.utc)
        if req.customer_name and not lic.customer_name:
            lic.customer_name = req.customer_name
        await db.commit()
        log.info("License %s activated on %s", lic.id, req.fingerprint)

    return {
        "ok": True,
        "tier": lic.tier,
        "max_agents": lic.max_agents,
        "expires_at": lic.expires_at,
    }


@router.post("/validate")
async def validate(req: ValidateRequest, db: AsyncSession = Depends(get_db)):
    lic = await _lookup(db, req.license_key)
    now = datetime.now(timezone.utc)

    if lic.expires_at and lic.expires_at < now:
        raise HTTPException(403, "License expired")

    if lic.fingerprint and lic.fingerprint != req.server_fingerprint:
        raise HTTPException(
            403,
            "Server fingerprint does not match the activated license.",
        )

    if lic.fingerprint is None:
        # First contact since activation flow — bind transparently so the
        # client doesn't have to call /activate explicitly.
        lic.fingerprint = req.server_fingerprint
        lic.activated_at = now

    lic.last_seen = now
    await db.commit()

    payload = {
        "tier": lic.tier,
        "max_agents": lic.max_agents,
        "features": lic.features_json or [],
        "customer_name": lic.customer_name,
        "fingerprint": req.server_fingerprint,
        "expires_at": lic.expires_at.isoformat() if lic.expires_at else None,
        "active_agent_count_reported": req.active_agent_count,
        "version_reported": req.version,
    }
    return {"license_jwt": sign_license(payload), "payload": payload}


async def _lookup(db: AsyncSession, license_key: str) -> License:
    result = await db.execute(
        select(License).where(License.key_hash == sha256_hex(license_key))
    )
    lic = result.scalar_one_or_none()
    if lic is None or not lic.active:
        raise HTTPException(404, "Unknown or inactive license")
    return lic
