"""Authenticated dashboard, agents, tests, results."""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import has_blackeye, require_user
from ..config import settings
from ..db import get_db
from ..licensing import check_agent_quota, count_active_agents
from ..models import Agent, Customer, TestConfig, TestResult, User
from ..security import generate_token, sha256_hex

router = APIRouter(tags=["ui-dashboard"])
templates = Jinja2Templates(directory="app/templates")


def _base_ctx(request: Request, user: User, customer: Customer) -> dict:
    return {
        "request": request,
        "user": user,
        "customer": customer,
        "has_blackeye": has_blackeye(customer),
    }


@router.get("/", response_class=HTMLResponse)
async def root(request: Request):
    target = "/dashboard" if request.session.get("user_id") else "/login"
    return RedirectResponse(target)


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    agents = (await db.execute(
        select(Agent).where(Agent.customer_id == customer.id).order_by(Agent.name)
    )).scalars().all()

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.AGENT_OFFLINE_AFTER_SECONDS)
    summary = []
    for a in agents:
        last_seen = a.last_seen
        if last_seen is not None and last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        online = last_seen is not None and last_seen > cutoff
        latest = (await db.execute(
            select(TestResult)
            .where(TestResult.agent_id == a.id)
            .order_by(desc(TestResult.timestamp))
            .limit(1)
        )).scalar_one_or_none()
        summary.append({"agent": a, "online": online, "latest": latest})

    recent_fails = (await db.execute(
        select(TestResult, TestConfig, Agent)
        .join(TestConfig, TestConfig.id == TestResult.test_config_id)
        .join(Agent, Agent.id == TestResult.agent_id)
        .where(TestResult.customer_id == customer.id, TestResult.status == "fail")
        .order_by(desc(TestResult.timestamp))
        .limit(10)
    )).all()

    ctx = _base_ctx(request, user, customer)
    ctx.update({"summary": summary, "recent_fails": recent_fails})
    return templates.TemplateResponse("dashboard.html", ctx)


@router.get("/agents", response_class=HTMLResponse)
async def list_agents(
    request: Request,
    new_token: Optional[str] = None,
    new_id: Optional[int] = None,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    agents = (await db.execute(
        select(Agent).where(Agent.customer_id == customer.id).order_by(Agent.name)
    )).scalars().all()
    ctx = _base_ctx(request, user, customer)
    ctx.update({"agents": agents, "new_token": new_token, "new_id": new_id})
    return templates.TemplateResponse("agents.html", ctx)


@router.get("/agents/new", response_class=HTMLResponse)
async def new_agent_form(
    request: Request,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    customer = await db.get(Customer, user.customer_id)
    return templates.TemplateResponse("agent_new.html", _base_ctx(request, user, customer))


@router.post("/agents/new")
async def create_agent(
    name: str = Form(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    check_agent_quota(await count_active_agents(db) + 1)
    token = generate_token(32)
    agent = Agent(
        customer_id=user.customer_id,
        name=name.strip(),
        token_hash=sha256_hex(token),
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)
    return RedirectResponse(f"/agents?new_token={token}&new_id={agent.id}", status_code=302)


@router.post("/agents/{agent_id}/revoke")
async def revoke_agent(
    agent_id: int,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.customer_id != user.customer_id:
        raise HTTPException(404, "Not found")
    agent.active = False
    # Overwrite token_hash so the agent can never re-authenticate.
    agent.token_hash = sha256_hex(generate_token(32))
    await db.commit()
    return RedirectResponse("/agents", status_code=302)


@router.get("/tests/{agent_id}", response_class=HTMLResponse)
async def list_tests(
    agent_id: int,
    request: Request,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.customer_id != user.customer_id:
        raise HTTPException(404, "Not found")
    customer = await db.get(Customer, user.customer_id)
    tests = (await db.execute(
        select(TestConfig).where(TestConfig.agent_id == agent_id).order_by(TestConfig.id)
    )).scalars().all()
    ctx = _base_ctx(request, user, customer)
    ctx.update({"agent": agent, "tests": tests})
    return templates.TemplateResponse("tests.html", ctx)


@router.post("/tests/{agent_id}/new")
async def create_test(
    agent_id: int,
    test_type: str = Form(...),
    target: str = Form(...),
    interval_seconds: int = Form(60),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    if test_type not in ("http", "ping", "dns"):
        raise HTTPException(400, "Invalid test type")
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.customer_id != user.customer_id:
        raise HTTPException(404, "Not found")
    tc = TestConfig(
        agent_id=agent_id,
        customer_id=user.customer_id,
        test_type=test_type,
        target=target.strip(),
        interval_seconds=max(10, int(interval_seconds)),
        enabled=True,
    )
    db.add(tc)
    await db.commit()
    return RedirectResponse(f"/tests/{agent_id}", status_code=302)


@router.post("/tests/{agent_id}/{tc_id}/toggle")
async def toggle_test(
    agent_id: int,
    tc_id: int,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    tc = await db.get(TestConfig, tc_id)
    if tc is None or tc.agent_id != agent_id or tc.customer_id != user.customer_id:
        raise HTTPException(404, "Not found")
    tc.enabled = not tc.enabled
    await db.commit()
    return RedirectResponse(f"/tests/{agent_id}", status_code=302)


@router.post("/tests/{agent_id}/{tc_id}/delete")
async def delete_test(
    agent_id: int,
    tc_id: int,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "viewer":
        raise HTTPException(403, "Forbidden")
    tc = await db.get(TestConfig, tc_id)
    if tc is None or tc.agent_id != agent_id or tc.customer_id != user.customer_id:
        raise HTTPException(404, "Not found")
    await db.delete(tc)
    await db.commit()
    return RedirectResponse(f"/tests/{agent_id}", status_code=302)


@router.get("/results", response_class=HTMLResponse)
async def results(
    request: Request,
    agent_id: Optional[int] = None,
    test_type: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(200, le=1000),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    customer = await db.get(Customer, user.customer_id)
    stmt = (
        select(TestResult, TestConfig, Agent)
        .join(TestConfig, TestConfig.id == TestResult.test_config_id)
        .join(Agent, Agent.id == TestResult.agent_id)
        .where(TestResult.customer_id == user.customer_id)
    )
    if agent_id:
        stmt = stmt.where(TestResult.agent_id == agent_id)
    if test_type:
        stmt = stmt.where(TestConfig.test_type == test_type)
    if status:
        stmt = stmt.where(TestResult.status == status)
    stmt = stmt.order_by(desc(TestResult.timestamp)).limit(limit)

    rows = (await db.execute(stmt)).all()
    agents = (await db.execute(
        select(Agent).where(Agent.customer_id == user.customer_id).order_by(Agent.name)
    )).scalars().all()

    ctx = _base_ctx(request, user, customer)
    ctx.update({
        "rows": rows,
        "agents": agents,
        "filter_agent_id": agent_id,
        "filter_test_type": test_type,
        "filter_status": status,
    })
    return templates.TemplateResponse("results.html", ctx)
