"""license_cache singleton

Revision ID: 0002_license_cache
Revises: 0001_initial
Create Date: 2026-05-28 00:00:00

"""
from alembic import op
import sqlalchemy as sa


revision = "0002_license_cache"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "license_cache",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("signature", sa.Text(), nullable=False),
        sa.Column("cached_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("license_cache")
