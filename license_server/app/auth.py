"""Admin session auth for the License Server."""
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import AdminUser


async def current_admin(request: Request, db: AsyncSession) -> Optional[AdminUser]:
    admin_id = request.session.get("admin_id")
    if not admin_id:
        return None
    user = await db.get(AdminUser, admin_id)
    if user is None or not user.active:
        request.session.clear()
        return None
    return user


async def require_admin(
    request: Request, db: AsyncSession = Depends(get_db)
) -> AdminUser:
    user = await current_admin(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user
