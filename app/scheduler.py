"""APScheduler bootstrap and recurring jobs."""
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import update

from .db import db_session
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


def schedule_tests() -> None:
    scheduler.add_job(
        expire_reset_tokens,
        "interval",
        seconds=300,
        id="expire_reset_tokens",
        replace_existing=True,
    )
