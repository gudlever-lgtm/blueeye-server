-- BlueEye Service Assurance — worker heartbeats.
--
-- Worker liveness used to be inferred from the newest claim on the run queue,
-- which lies in the one case that matters: a freshly started worker that has
-- never claimed anything reads as "no worker connected", so the operator is
-- told to install what is already running. A heartbeat row is written every
-- poll tick, so a worker is visible from the moment it boots.
--
-- One row per worker id (hostname-pid, or SERVICE_TEST_WORKER_ID). Rows are
-- upserted, never accumulated, and a worker that stops simply stops updating
-- last_seen_at.
CREATE TABLE service_test_workers (
  worker_id    VARCHAR(190) NOT NULL PRIMARY KEY,
  hostname     VARCHAR(255)     DEFAULT NULL,
  version      VARCHAR(64)      DEFAULT NULL,
  started_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_stw_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
