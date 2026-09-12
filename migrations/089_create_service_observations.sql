-- V3 Phase 1: the observation model (docs/service-assurance-v3.md).
--
-- An OBSERVATION is one typed fact a run produced, with a source. Everything
-- V3 reasons over — correlation, root cause, incidents, health — reads
-- observations rather than re-parsing screenshots, error strings and prose.
--
-- Why a table rather than another JSON column on the run: correlation asks
-- questions ACROSS runs ("has this API failed before", "did the network look
-- fine every time"), and a JSON blob per run cannot be queried that way without
-- reading every row. This is the first thing in the module that is genuinely
-- relational.
--
-- Written by the run, never by a person. An observation is what was seen; if it
-- can be edited it is an opinion, and the whole point is that the evidence
-- underneath a conclusion is not editable.
CREATE TABLE IF NOT EXISTS service_observations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- Where it came from. A run is the usual source; a sweep (certificates, the
  -- assurance reactor) can record one without a run, which is why this is
  -- nullable rather than part of the key.
  run_id INT DEFAULT NULL,
  test_id INT DEFAULT NULL,
  journey_id INT DEFAULT NULL,
  application_id INT DEFAULT NULL,
  environment_id INT DEFAULT NULL,

  -- WHICH LAYER was observed. The correlation engine's whole job is relating
  -- facts across layers ("the API failed but the network was fine"), so the
  -- layer is a column and not a string buried in a JSON blob.
  layer ENUM('browser','page','api','application','server','network','infrastructure','assurance')
    NOT NULL,
  -- What kind of fact. Deliberately open text rather than an ENUM: the set grows
  -- with every detector, and a migration per new fact type would mean the
  -- detectors cannot ship independently. The gate sweeps the known set instead.
  kind VARCHAR(64) NOT NULL,

  -- What it was ABOUT — an endpoint, a host, a selector, a step. Free text
  -- because the subject of an observation genuinely differs by layer.
  subject VARCHAR(512) DEFAULT NULL,

  -- The three-valued answer. `ok`/`bad` is what correlation reasons over;
  -- `unknown` is a real answer and the reason this is not a boolean — "we did
  -- not look" and "we looked and it was fine" must never collapse.
  outcome ENUM('ok','bad','unknown') NOT NULL DEFAULT 'unknown',

  -- A measurement where there is one (a duration, a status code, a count), so
  -- anomaly detection and baselines can read observations too.
  value DOUBLE DEFAULT NULL,
  unit VARCHAR(32) DEFAULT NULL,

  -- One sentence in the operator's words. Every finding in this repo carries its
  -- explanation; an observation is no different.
  summary VARCHAR(512) DEFAULT NULL,
  -- The raw supporting facts. Redacted before it gets here.
  detail JSON DEFAULT NULL,

  -- When it was OBSERVED, which is not when the row was written. A run that took
  -- four minutes produced observations across four minutes, and a timeline built
  -- from insert time would be a timeline of the database rather than the outage.
  observed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Correlation reads by (application, layer, time) and by subject over time
  -- ("has this endpoint failed before"). Both are covered.
  KEY idx_obs_app_time (application_id, observed_at),
  KEY idx_obs_layer (application_id, layer, outcome, observed_at),
  KEY idx_obs_subject (application_id, kind, subject(191), observed_at),
  KEY idx_obs_run (run_id),
  KEY idx_obs_journey (journey_id, observed_at),

  -- Observations follow their run out of the database: retention is what keeps
  -- this table from being the module's growth risk, and an observation whose run
  -- is gone has nothing to point at.
  CONSTRAINT fk_obs_run FOREIGN KEY (run_id)
    REFERENCES service_test_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_test FOREIGN KEY (test_id)
    REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_journey FOREIGN KEY (journey_id)
    REFERENCES service_test_journeys(id) ON DELETE SET NULL,
  CONSTRAINT fk_obs_app FOREIGN KEY (application_id)
    REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_env FOREIGN KEY (environment_id)
    REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
