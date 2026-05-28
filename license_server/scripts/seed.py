"""Bootstrap: create the default admin user."""
import asyncio
import logging

from sqlalchemy import select

from license_server.app.config import settings
from license_server.app.db import SessionLocal
from license_server.app.models import AdminUser
from license_server.app.security import hash_password

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("license.seed")


async def main() -> None:
    async with SessionLocal() as db:
        email = settings.DEFAULT_ADMIN_EMAIL.lower()
        existing = (await db.execute(select(AdminUser).where(AdminUser.email == email))).scalar_one_or_none()
        if existing is None:
            db.add(AdminUser(
                email=email,
                password_hash=hash_password(settings.DEFAULT_ADMIN_PASSWORD),
                active=True,
            ))
            await db.commit()
            log.info("Created admin %s (password from DEFAULT_ADMIN_PASSWORD)", email)
        else:
            log.info("Admin %s already exists", email)


if __name__ == "__main__":
    asyncio.run(main())
