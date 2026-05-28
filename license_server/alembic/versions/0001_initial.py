"""initial license server schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-28 00:00:00

"""
from alembic import op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "licenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key_hash", sa.String(length=128), nullable=False, unique=True),
        sa.Column("customer_name", sa.String(length=255), nullable=False),
        sa.Column("tier", sa.String(length=32), nullable=False, server_default="blueeye"),
        sa.Column("max_agents", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("features_json", sa.JSON(), nullable=True),
        sa.Column("fingerprint", sa.String(length=128), nullable=True),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_licenses_key_hash", "licenses", ["key_hash"], unique=True)
    op.create_index("ix_licenses_fingerprint", "licenses", ["fingerprint"])

    op.create_table(
        "admin_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_admin_users_email", "admin_users", ["email"], unique=True)


def downgrade() -> None:
    op.drop_table("admin_users")
    op.drop_table("licenses")
