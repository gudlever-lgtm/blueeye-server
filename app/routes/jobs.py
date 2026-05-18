"""Job creation, listing, and result submission."""
import json

from flask import Blueprint, jsonify, request

from ..auth import require_client_cert
from ..config import Config
from ..db import get_cursor
from ..errors import ApiError

bp = Blueprint("jobs", __name__)


@bp.post("/jobs")
def create_job():
    """Queue a job for an agent.

    Parsing here is intentionally minimal: a malformed request body
    (non-JSON, or missing required keys) raises and is caught by the
    500 handler, which returns a structured {"error": ...} response.
    This is the documented internal-error path exercised by smoke tests.
    """
    require_client_cert()
    body = request.get_json(silent=True)
    job_type = body["type"]
    agent_id = body["agent_id"]
    target = body.get("target", "")
    params = body.get("params", {})

    if job_type not in Config.BUILTIN_CHECKS:
        raise ApiError(
            f"unknown job type '{job_type}'; "
            f"valid types: {', '.join(Config.BUILTIN_CHECKS)}",
            status=400,
        )

    with get_cursor() as cur:
        cur.execute("SELECT id FROM agents WHERE id = %s", (agent_id,))
        if cur.fetchone() is None:
            raise ApiError(f"unknown agent: {agent_id}", status=404)

        cur.execute(
            """
            INSERT INTO jobs (agent_id, type, target, params)
            VALUES (%s, %s, %s, %s)
            RETURNING id, agent_id, type, target, params, status, created_at
            """,
            (agent_id, job_type, target, json.dumps(params)),
        )
        return jsonify(cur.fetchone()), 201


@bp.get("/jobs")
def list_jobs():
    require_client_cert()
    agent_id = request.args.get("agent_id")
    with get_cursor() as cur:
        if agent_id:
            cur.execute(
                "SELECT id, agent_id, type, target, params, status, created_at "
                "FROM jobs WHERE agent_id = %s ORDER BY id DESC LIMIT 200",
                (agent_id,),
            )
        else:
            cur.execute(
                "SELECT id, agent_id, type, target, params, status, created_at "
                "FROM jobs ORDER BY id DESC LIMIT 200"
            )
        return jsonify(jobs=cur.fetchall())


@bp.post("/jobs/<int:job_id>/results")
def submit_result(job_id):
    """Record the outcome of a job reported by an agent."""
    require_client_cert()
    body = request.get_json(silent=True) or {}
    status = body.get("status", "ok")
    data = body.get("data", {})
    error_message = body.get("error")

    with get_cursor() as cur:
        cur.execute("SELECT agent_id FROM jobs WHERE id = %s", (job_id,))
        job = cur.fetchone()
        if job is None:
            raise ApiError(f"unknown job: {job_id}", status=404)

        cur.execute(
            """
            INSERT INTO results (job_id, agent_id, status, data, error_message)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, job_id, agent_id, status, data, error_message, created_at
            """,
            (job_id, job["agent_id"], status, json.dumps(data), error_message),
        )
        result = cur.fetchone()
        cur.execute(
            "UPDATE jobs SET status = %s WHERE id = %s",
            ("done" if status == "ok" else "error", job_id),
        )
        return jsonify(result), 201
