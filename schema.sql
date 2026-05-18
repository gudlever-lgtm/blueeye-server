-- BlueEye server schema. Applied automatically on startup (idempotent).

CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,            -- client certificate Common Name
    location    TEXT NOT NULL DEFAULT 'unknown',
    connection  TEXT NOT NULL DEFAULT 'unknown',
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
    id          SERIAL PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,               -- ping | dns | http
    target      TEXT NOT NULL DEFAULT '',
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | dispatched | done | error
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS results (
    id            SERIAL PRIMARY KEY,
    job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id      TEXT NOT NULL,
    status        TEXT NOT NULL,             -- ok | error
    data          JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_agent_status ON jobs (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_results_job ON results (job_id);
CREATE INDEX IF NOT EXISTS idx_results_created ON results (created_at DESC);
