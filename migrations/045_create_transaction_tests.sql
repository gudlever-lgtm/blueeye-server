-- Transaction tests: named multi-step HTTP sequences run by agents.
-- Secrets (Bearer tokens, passwords, etc.) are stored server-side in the
-- `secrets` column and NEVER returned by the read API; only their names
-- are exposed so the UI can show "set / not set" per secret.

CREATE TABLE IF NOT EXISTS transaction_tests (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(32)  NOT NULL DEFAULT 'http',
  steps         JSON         NOT NULL,
  secrets       JSON         NOT NULL DEFAULT '{}',
  secret_names  JSON         NOT NULL DEFAULT '[]',
  agents        JSON         NOT NULL DEFAULT '["all"]',
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One result row per (agent, test, run). Steps carries per-step timing and
-- error detail; error_detail carries the top-level failure context (phase +
-- code) used to build the human-readable diagnosis in the dashboard.
CREATE TABLE IF NOT EXISTS transaction_test_results (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  test_id      INT          NOT NULL,
  agent_id     INT          NOT NULL,
  ran_at       DATETIME(3)  NOT NULL,
  status       VARCHAR(16)  NOT NULL,
  duration_ms  INT          DEFAULT NULL,
  steps        JSON         DEFAULT NULL,
  error_detail JSON         DEFAULT NULL,
  INDEX idx_test_agent_ran (test_id, agent_id, ran_at),
  INDEX idx_ran_at (ran_at),
  FOREIGN KEY (test_id) REFERENCES transaction_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
