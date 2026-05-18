"""Operator dashboard for troubleshooting outages by location/connection."""
from flask import Blueprint, render_template

from .db import get_cursor

bp = Blueprint("dashboard", __name__)


@bp.get("/")
def dashboard():
    with get_cursor() as cur:
        cur.execute(
            "SELECT id, location, connection, last_seen FROM agents "
            "ORDER BY location, id"
        )
        agents = cur.fetchall()

        cur.execute(
            """
            SELECT r.id, r.job_id, r.agent_id, j.type, j.target,
                   r.status, r.data, r.error_message, r.created_at
            FROM results r
            JOIN jobs j ON j.id = r.job_id
            ORDER BY r.created_at DESC
            LIMIT 200
            """
        )
        results = cur.fetchall()

        cur.execute("SELECT count(*) AS c FROM results WHERE status <> 'ok'")
        error_count = cur.fetchone()["c"]

    results_by_agent = {}
    for row in results:
        results_by_agent.setdefault(row["agent_id"], []).append(row)

    return render_template(
        "dashboard.html",
        agents=agents,
        results_by_agent=results_by_agent,
        total_results=len(results),
        error_count=error_count,
    )
