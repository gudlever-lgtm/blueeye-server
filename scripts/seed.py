"""Bootstrap: create the default superadmin and a demo customer."""
import asyncio
import logging

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.models import Customer, User
from app.security import hash_password

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("blueeye.seed")


async def main() -> None:
    async with SessionLocal() as db:
        demo = (await db.execute(
            select(Customer).where(Customer.slug == "demo")
        )).scalar_one_or_none()
        if demo is None:
            demo = Customer(name="Demo Corp", slug="demo", license_tier="blueeye", active=True)
            db.add(demo)
            await db.commit()
            await db.refresh(demo)
            log.info("Created demo customer (slug=%s)", demo.slug)
        else:
            log.info("Demo customer already exists (slug=%s)", demo.slug)

        email = settings.DEFAULT_SUPERADMIN_EMAIL.lower()
        existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if existing is None:
            db.add(User(
                customer_id=demo.id,
                email=email,
                password_hash=hash_password(settings.DEFAULT_SUPERADMIN_PASSWORD),
                role="superadmin",
                active=True,
            ))
            await db.commit()
            log.info("Created superadmin %s (password from DEFAULT_SUPERADMIN_PASSWORD)", email)
        else:
            log.info("Superadmin %s already exists", email)


if __name__ == "__main__":
    asyncio.run(main())
