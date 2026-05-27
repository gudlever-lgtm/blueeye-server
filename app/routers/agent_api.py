"""Agent-facing API: checkin + result submission."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import authenticated_agent
from ..db import get_db
from ..models import Agent, TestConfig, TestResult

router = APIRouter(prefix="/api/agent", tags=["agent"])


class TestConfigOut(BaseModel):
    id: int
    test_type: str
    target: str
    interval_seconds: int
    enabled: bool


class CheckinResponse(BaseModel):
    agent_id: int
    name: str
    tests: list[TestConfigOut]
    server_time: datetime


class ResultIn(BaseModel):
    test_config_id: int
    timestamp: datetime
    status: str = Field(pattern="^(ok|warn|fail)$")
    latency_ms: Optional[float] = None
    detail: Optional[dict] = None


class ResultsBatch(BaseModel):
    results: list[ResultIn]


@router.post("/checkin", response_model=CheckinResponse)
async def checkin(
    agent: Agent = Depends(authenticated_agent),
    db: AsyncSession = Depends(get_db),
):
    agent.last_seen = datetime.now(timezone.utc)
    await db.commit()
    rows = await db.execute(
        select(TestConfig).where(
            TestConfig.agent_id == agent.id,
            TestConfig.enabled.is_(True),
        )
    )
    tests = rows.scalars().all()
    return CheckinResponse(
        agent_id=agent.id,
        name=agent.name,
        tests=[TestConfigOut.model_validate(t, from_attributes=True) for t in tests],
        server_time=datetime.now(timezone.utc),
    )


@router.post("/results")
async def submit_results(
    batch: ResultsBatch,
    agent: Agent = Depends(authenticated_agent),
    db: AsyncSession = Depends(get_db),
):
    agent.last_seen = datetime.now(timezone.utc)

    config_ids = {r.test_config_id for r in batch.results}
    if not config_ids:
        await db.commit()
        return {"accepted": 0}

    rows = await db.execute(select(TestConfig).where(TestConfig.id.in_(config_ids)))
    by_id = {tc.id: tc for tc in rows.scalars().all()}

    for r in batch.results:
        tc = by_id.get(r.test_config_id)
        if tc is None or tc.agent_id != agent.id:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown or unowned test_config_id {r.test_config_id}",
            )
        db.add(TestResult(
            test_config_id=r.test_config_id,
            agent_id=agent.id,
            customer_id=agent.customer_id,
            timestamp=r.timestamp,
            status=r.status,
            latency_ms=r.latency_ms,
            detail_json=r.detail,
        ))
    await db.commit()
    return {"accepted": len(batch.results)}
