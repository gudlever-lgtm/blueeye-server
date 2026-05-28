"""APScheduler bootstrap and recurring jobs."""
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import update

from .config import settings
from .db import db_session
from .licensing import validate_now
from .models import User

log = logging.getLogger("blueeye.scheduler")
scheduler = AsyncIOScheduler()


async def expire_reset_tokens() -> None:
    now = datetime.now(timezone.utc)
    async with db_session() as db:
        result = await db.execute(
            update(User)
            .where(User.reset_expiry.is_not(None), User.reset_expiry < now)
            .values(reset_token=None, reset_expiry=None)
        )
        await db.commit()
        if result.rowcount:
            log.info("Expired %d password reset token(s)", result.rowcount)


async def revalidate_license() -> None:
    try:
        await validate_now()
    except Exception:
        log.exception("license revalidation crashed")


def schedule_tests() -> None:
    scheduler.add_job(
        expire_reset_tokens,
        "interval",
        seconds=300,
        id="expire_reset_tokens",
        replace_existing=True,
    )
    scheduler.add_job(
        revalidate_license,
        "interval",
        seconds=settings.LICENSE_VALIDATE_INTERVAL_SECONDS,
        id="revalidate_license",
        replace_existing=True,
    )
