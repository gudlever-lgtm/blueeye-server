-- Transaction tests, v2 (normalized, respec).
--
-- Migration 045 introduced a first cut (transaction_tests with a JSON `agents`
-- column + transaction_test_results) but the repository was never constructed in
-- src/server.js, so the router never mounted and no rows were ever written in
-- production — both tables are empty. This migration retires that dead schema and
-- replaces it with the normalized model used by /api/transactions, the WS
-- transaction channel and the MAD baseline job.
--
--   transaction_tests       — one row per named test (type http|tcp|dns|icmp +
--                             JSON config; secrets AES-256-GCM in config_secrets)
--   transaction_test_agents — which agents run which test (join, PK on both)
--   transaction_results     — one row per (test, agent, run); NO foreign keys so
--                             the table can later move to TimescaleDB
--   transaction_baselines   — median + MAD per (test, agent, step), recomputed
--                             hourly, for deviation detection at ingest
--
-- MySQL 8.4 note: JSON columns must NOT carry a DEFAULT (see commit 8bc21f0).

DROP TABLE IF EXISTS transaction_test_results;
DROP TABLE IF EXISTS transaction_baselines;
DROP TABLE IF EXISTS transaction_results;
DROP TABLE IF EXISTS transaction_test_agents;
DROP TABLE IF EXISTS transaction_tests;

CREATE TABLE transaction_tests (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  type           ENUM('http','tcp','dns','icmp') NOT NULL,
  target         VARCHAR(255)     DEFAULT NULL,      -- host/url summary (display + tcp/dns/icmp target)
  config         JSON         NOT NULL,              -- per-type: steps[] / {port} / {record} / {}
  config_secrets JSON             DEFAULT NULL,      -- AES-256-GCM blob of { name: value } (never returned)
  interval_sec   INT          NOT NULL DEFAULT 60,
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assignment join. PK on (test_id, agent_id). No FKs (kept lean; the app deletes
-- assignments explicitly on test/agent removal).
CREATE TABLE transaction_test_agents (
  test_id  INT NOT NULL,
  agent_id INT NOT NULL,
  PRIMARY KEY (test_id, agent_id),
  INDEX idx_txa_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One result per (agent, test, run). step_timings carries per-step ms; detail is
-- structured JSON-in-string {phase,step,errno} for failures. NO foreign keys —
-- this table is destined for TimescaleDB.
CREATE TABLE transaction_results (
  time        DATETIME(3) NOT NULL,
  test_id     INT         NOT NULL,
  agent_id    INT         NOT NULL,
  status      ENUM('ok','fail','timeout','error') NOT NULL,
  latency_ms  INT             DEFAULT NULL,
  step_timings JSON           DEFAULT NULL,
  step_failed TINYINT         DEFAULT NULL,
  deviation   ENUM('normal','slower','faster') DEFAULT NULL,
  detail      VARCHAR(255)    DEFAULT NULL,
  INDEX idx_txr_test_agent_time (test_id, agent_id, time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Robust baseline per (test, agent, step): median + MAD over the last 7 days of
-- ok results, recomputed hourly by the baseline job. step 0 = whole-test latency;
-- steps 1..N = per-step timings (http). PK on (test, agent, step).
CREATE TABLE transaction_baselines (
  test_id      INT     NOT NULL,
  agent_id     INT     NOT NULL,
  step         TINYINT NOT NULL,
  median_ms    INT     NOT NULL,
  mad_ms       INT     NOT NULL,
  sample_count INT     NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (test_id, agent_id, step)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
