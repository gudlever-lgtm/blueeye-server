"""Customer-facing REST API (Bearer api_key)."""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import authenticated_customer
from ..db import get_db
from ..models import Agent, ApiKey, Customer, TestConfig, TestResult

router = APIRouter(prefix="/api/v1", tags=["customer-api"])


class AgentOut(BaseModel):
    id: int
    name: str
    last_seen: Optional[datetime]
    active: bool


class ResultOut(BaseModel):
    id: int
    agent_id: int
    test_config_id: int
    test_type: str
    target: str
    timestamp: datetime
    status: str
    latency_ms: Optional[float]
    detail: Optional[dict]


@router.get("/agents", response_model=list[AgentOut])
async def list_agents(
    auth: tuple[Customer, ApiKey] = Depends(authenticated_customer),
    db: AsyncSession = Depends(get_db),
):
    customer, _ = auth
    rows = await db.execute(select(Agent).where(Agent.customer_id == customer.id))
    return [AgentOut.model_validate(a, from_attributes=True) for a in rows.scalars().all()]


@router.get("/results", response_model=list[ResultOut])
async def list_results(
    agent_id: Optional[int] = None,
    test_type: Optional[str] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    limit: int = Query(100, le=1000),
    auth: tuple[Customer, ApiKey] = Depends(authenticated_customer),
    db: AsyncSession = Depends(get_db),
):
    customer, _ = auth
    stmt = (
        select(TestResult, TestConfig)
        .join(TestConfig, TestConfig.id == TestResult.test_config_id)
        .where(TestResult.customer_id == customer.id)
    )
    if agent_id is not None:
        stmt = stmt.where(TestResult.agent_id == agent_id)
    if test_type is not None:
        stmt = stmt.where(TestConfig.test_type == test_type)
    if since is not None:
        stmt = stmt.where(TestResult.timestamp >= since)
    if until is not None:
        stmt = stmt.where(TestResult.timestamp <= until)
    stmt = stmt.order_by(desc(TestResult.timestamp)).limit(limit)

    rows = (await db.execute(stmt)).all()
    return [
        ResultOut(
            id=r.id,
            agent_id=r.agent_id,
            test_config_id=r.test_config_id,
            test_type=tc.test_type,
            target=tc.target,
            timestamp=r.timestamp,
            status=r.status,
            latency_ms=r.latency_ms,
            detail=r.detail_json,
        )
        for r, tc in rows
    ]


@router.get("/agents/{agent_id}/status")
async def agent_status(
    agent_id: int,
    auth: tuple[Customer, ApiKey] = Depends(authenticated_customer),
    db: AsyncSession = Depends(get_db),
):
    customer, _ = auth
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.customer_id != customer.id:
        raise HTTPException(status_code=404, detail="Agent not found")

    cfgs = (
        await db.execute(select(TestConfig).where(TestConfig.agent_id == agent_id))
    ).scalars().all()

    tests_status = []
    for tc in cfgs:
        latest = (await db.execute(
            select(TestResult)
            .where(TestResult.test_config_id == tc.id)
            .order_by(desc(TestResult.timestamp))
            .limit(1)
        )).scalar_one_or_none()
        tests_status.append({
            "test_config_id": tc.id,
            "test_type": tc.test_type,
            "target": tc.target,
            "enabled": tc.enabled,
            "latest": None if latest is None else {
                "timestamp": latest.timestamp,
                "status": latest.status,
                "latency_ms": latest.latency_ms,
                "detail": latest.detail_json,
            },
        })

    return {
        "agent_id": agent.id,
        "name": agent.name,
        "last_seen": agent.last_seen,
        "tests": tests_status,
    }
