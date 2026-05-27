"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-27 00:00:00

"""
from alembic import op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=64), nullable=False, unique=True),
        sa.Column("license_tier", sa.String(length=32), nullable=False, server_default="blueeye"),
        sa.Column("license_expiry", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("ad_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ad_settings_json", sa.Text(), nullable=True),
    )
    op.create_index("ix_customers_slug", "customers", ["slug"], unique=True)

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False, server_default="viewer"),
        sa.Column("reset_token", sa.String(length=128), nullable=True),
        sa.Column("reset_expiry", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_customer_id", "users", ["customer_id"])
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_reset_token", "users", ["reset_token"])

    op.create_table(
        "agents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False, unique=True),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_agents_customer_id", "agents", ["customer_id"])
    op.create_index("ix_agents_token_hash", "agents", ["token_hash"], unique=True)

    op.create_table(
        "test_configs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("agent_id", sa.Integer(), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("test_type", sa.String(length=16), nullable=False),
        sa.Column("target", sa.String(length=512), nullable=False),
        sa.Column("interval_seconds", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_test_configs_agent_id", "test_configs", ["agent_id"])
    op.create_index("ix_test_configs_customer_id", "test_configs", ["customer_id"])

    op.create_table(
        "test_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("test_config_id", sa.Integer(), sa.ForeignKey("test_configs.id"), nullable=False),
        sa.Column("agent_id", sa.Integer(), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("detail_json", sa.JSON(), nullable=True),
    )
    op.create_index("ix_test_results_test_config_id", "test_results", ["test_config_id"])
    op.create_index("ix_test_results_agent_id", "test_results", ["agent_id"])
    op.create_index("ix_test_results_customer_id", "test_results", ["customer_id"])
    op.create_index("ix_test_results_timestamp", "test_results", ["timestamp"])

    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("key_hash", sa.String(length=128), nullable=False, unique=True),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("scopes", sa.String(length=255), nullable=False, server_default="read"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_api_keys_customer_id", "api_keys", ["customer_id"])
    op.create_index("ix_api_keys_key_hash", "api_keys", ["key_hash"], unique=True)

    op.create_table(
        "licenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("tier", sa.String(length=32), nullable=False),
        sa.Column("mollie_payment_id", sa.String(length=128), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
    )
    op.create_index("ix_licenses_customer_id", "licenses", ["customer_id"])
    op.create_index("ix_licenses_mollie_payment_id", "licenses", ["mollie_payment_id"])


def downgrade() -> None:
    op.drop_table("licenses")
    op.drop_table("api_keys")
    op.drop_table("test_results")
    op.drop_table("test_configs")
    op.drop_table("agents")
    op.drop_table("users")
    op.drop_table("customers")
