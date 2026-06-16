-- Lokationsdrevet investigation-resultater. Gemmer output fra
-- runInvestigation() inkl. klassifikation, beviser og eventuel AI-narrativ.
CREATE TABLE IF NOT EXISTS investigations (
  id              CHAR(36)      NOT NULL,
  location_ref    JSON          NOT NULL,
  window_from     DATETIME      NOT NULL,
  window_to       DATETIME      NOT NULL,
  classification  ENUM('LOCAL','UPSTREAM','DOWNSTREAM','APP_NOT_NET','INSUFFICIENT_DATA') NOT NULL,
  confidence      DECIMAL(4,3)  NOT NULL DEFAULT 0,
  explanation     TEXT          NOT NULL,
  evidence        JSON          NOT NULL,
  suspected_segment JSON        NULL,
  related_finding_ids JSON      NOT NULL DEFAULT ('[]'),
  workaround_hints   JSON      NOT NULL DEFAULT ('[]'),
  narrative       TEXT          NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_investigations_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
