-- Transaction tests, v2 (normalized).
--
-- Migration 045 introduced a first cut (transaction_tests with a JSON `agents`
-- column + transaction_test_results) but the repository was never constructed in
-- src/server.js, so the router never mounted and no rows were ever written in
-- production — both tables are empty. This migration retires that dead schema and
-- replaces it with a normalized model that the /api/transactions module and the
-- WS transaction channel use:
--   * transaction_tests        — one row per named test (type http|tcp|dns + config)
--   * transaction_test_agents  — which agents run which test (join)
--   * transaction_results      — one row per (test, agent, run)
--
-- MySQL 8.4 note: JSON columns must NOT carry a DEFAULT (see commit 8bc21f0).

DROP TABLE IF EXISTS transaction_test_results;
DROP TABLE IF EXISTS transaction_tests;

CREATE TABLE transaction_tests (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  type        VARCHAR(16)  NOT NULL,                 -- http | tcp | dns
  config      JSON         NOT NULL,                 -- per-type: steps[] / {host,port} / {host,record}
  thresholds  JSON             DEFAULT NULL,         -- { consecutive_fails, latency_ms }
  interval_ms INT          NOT NULL DEFAULT 60000,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assignment join. Deleting a test or an agent cascades its assignments away.
CREATE TABLE transaction_test_agents (
  test_id   INT NOT NULL,
  agent_id  INT NOT NULL,
  PRIMARY KEY (test_id, agent_id),
  INDEX idx_txa_agent (agent_id),
  FOREIGN KEY (test_id)  REFERENCES transaction_tests(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)            ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One result per (agent, test, run). `detail` carries per-step timing / failure
-- context (metadata only — never response payload). Indexed for the per-test
-- results list and the time-bucketed heatmap aggregation.
CREATE TABLE transaction_results (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  test_id     INT         NOT NULL,
  agent_id    INT         NOT NULL,
  ran_at      DATETIME(3) NOT NULL,
  status      VARCHAR(16) NOT NULL,                  -- ok | fail | error
  latency_ms  INT             DEFAULT NULL,
  detail      JSON            DEFAULT NULL,
  INDEX idx_txr_test_agent_ran (test_id, agent_id, ran_at),
  INDEX idx_txr_ran (ran_at),
  FOREIGN KEY (test_id)  REFERENCES transaction_tests(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)            ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
