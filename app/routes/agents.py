"""Agent registration and job polling."""
from flask import Blueprint, jsonify, request

from ..auth import require_client_cert
from ..db import get_cursor
from ..errors import ApiError

bp = Blueprint("agents", __name__)


@bp.post("/agents/register")
def register():
    """Register or refresh an agent. Identity is the client certificate CN."""
    cn = require_client_cert()
    body = request.get_json(silent=True) or {}
    location = body.get("location", "unknown")
    connection = body.get("connection", "unknown")

    with get_cursor() as cur:
        cur.execute(
            """
            INSERT INTO agents (id, location, connection)
            VALUES (%s, %s, %s)
            ON CONFLICT (id) DO UPDATE
              SET location = EXCLUDED.location,
                  connection = EXCLUDED.connection,
                  last_seen = now()
            RETURNING id, location, connection, last_seen, created_at
            """,
            (cn, location, connection),
        )
        agent = cur.fetchone()
    return jsonify(agent), 201


@bp.get("/agents")
def list_agents():
    require_client_cert()
    with get_cursor() as cur:
        cur.execute(
            "SELECT id, location, connection, last_seen, created_at "
            "FROM agents ORDER BY location, id"
        )
        return jsonify(agents=cur.fetchall())


@bp.get("/agents/<agent_id>/jobs")
def poll_jobs(agent_id):
    """Return pending jobs for an agent and mark them dispatched."""
    require_client_cert()
    with get_cursor() as cur:
        cur.execute("SELECT id FROM agents WHERE id = %s", (agent_id,))
        if cur.fetchone() is None:
            raise ApiError(f"unknown agent: {agent_id}", status=404)

        cur.execute("UPDATE agents SET last_seen = now() WHERE id = %s", (agent_id,))
        cur.execute(
            """
            UPDATE jobs SET status = 'dispatched'
            WHERE id IN (
                SELECT id FROM jobs WHERE agent_id = %s AND status = 'pending'
            )
            RETURNING id, agent_id, type, target, params, status, created_at
            """,
            (agent_id,),
        )
        return jsonify(jobs=cur.fetchall())


@bp.get("/agents/<agent_id>/results")
def agent_results(agent_id):
    """Recent results for one agent."""
    require_client_cert()
    with get_cursor() as cur:
        cur.execute("SELECT id FROM agents WHERE id = %s", (agent_id,))
        if cur.fetchone() is None:
            raise ApiError(f"unknown agent: {agent_id}", status=404)

        cur.execute(
            """
            SELECT r.id, r.job_id, j.type, j.target, r.status,
                   r.data, r.error_message, r.created_at
            FROM results r
            JOIN jobs j ON j.id = r.job_id
            WHERE r.agent_id = %s
            ORDER BY r.created_at DESC
            LIMIT 100
            """,
            (agent_id,),
        )
        return jsonify(results=cur.fetchall())
