"""Authentication and authorization helpers."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import Agent, ApiKey, Customer, User
from .security import sha256_hex


async def current_user(request: Request, db: AsyncSession) -> Optional[User]:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = await db.get(User, user_id)
    if user is None or not user.active:
        request.session.clear()
        return None
    return user


async def require_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    from fastapi.responses import RedirectResponse as _RR
    user = await current_user(request, db)
    if user is None:
        raise _RR(url=f"/login?next={request.url.path}", status_code=302)
    return user


def require_role(*roles: str):
    async def _check(user: User = Depends(require_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user
    return _check


async def authenticated_agent(request: Request, db: AsyncSession = Depends(get_db)) -> Agent:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")
    result = await db.execute(
        select(Agent).where(Agent.token_hash == sha256_hex(token), Agent.active.is_(True))
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=401, detail="Invalid agent token")
    return agent


async def authenticated_customer(
    request: Request, db: AsyncSession = Depends(get_db)
) -> tuple[Customer, ApiKey]:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")
    result = await db.execute(select(ApiKey).where(ApiKey.key_hash == sha256_hex(token)))
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    if api_key.expires_at and api_key.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="API key expired")
    customer = await db.get(Customer, api_key.customer_id)
    if customer is None or not customer.active:
        raise HTTPException(status_code=401, detail="Customer inactive")
    return customer, api_key


def has_blackeye(customer: Customer) -> bool:
    if customer.license_tier != "blackeye":
        return False
    if customer.license_expiry is None:
        return False
    expiry = customer.license_expiry
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry > datetime.now(timezone.utc)


def require_blackeye(customer: Customer) -> None:
    if not has_blackeye(customer):
        raise HTTPException(status_code=402, detail="BlackEye license required")
