-- V3 Phase 1: the incident lifecycle and its timeline.
--
-- EXTENDS the V2 incident rather than creating a second one. The spec is
-- explicit — reuse V1/V2 tables where possible, avoid duplicate data models —
-- and a parallel `service_incidents` would mean two tables that both mean
-- "something is wrong", drifting apart within a month.
--
-- Everything here is additive. Existing rows keep their meaning: an incident
-- that was 'open' yesterday is still 'open' today.

-- The lifecycle the spec asks for. 'open' stays the entry state so nothing that
-- writes today has to change; the three new states are what a person moves an
-- incident THROUGH.
--
-- Widening an ENUM is safe for existing rows. What is NOT safe is the reader:
-- six queries treated `status = 'open'` as "not resolved", and an incident moved
-- to 'investigating' would have vanished from the dashboard — the one place it
-- most needs to be. Those are changed in the same commit to ask for the active
-- states by name.
ALTER TABLE service_test_incidents
  MODIFY COLUMN status ENUM('open','investigating','identified','resolved','closed')
    NOT NULL DEFAULT 'open';

ALTER TABLE service_test_incidents
  -- What the correlation engine concluded, and how sure it was. Stored rather
  -- than recomputed because it is a judgement made AT A MOMENT, from the
  -- evidence available then. Recomputing it later against today's data would
  -- quietly rewrite what the operator was told during the outage.
  ADD COLUMN correlated_layer VARCHAR(32) DEFAULT NULL AFTER likely_cause,
  -- 0-100, and NULL when there was no conclusion to be confident about.
  ADD COLUMN confidence TINYINT UNSIGNED DEFAULT NULL AFTER correlated_layer,

  -- Impact, which the spec insists is a different question from severity.
  -- Severity is how bad the technical fault is; impact is what it costs the
  -- business. A CRIT on a page nobody uses is not a high-impact incident.
  ADD COLUMN impact ENUM('low','medium','high','critical') DEFAULT NULL AFTER confidence,
  ADD COLUMN impact_reason VARCHAR(512) DEFAULT NULL AFTER impact,
  -- Which user journeys stopped working. ["Customer Search", "Create Case"]
  ADD COLUMN affected_journeys JSON DEFAULT NULL AFTER impact_reason,
  -- Deliberately NOT a user count. The spec says: if the number of affected
  -- users is not known, say Unknown — never invent it. There is no column here
  -- to hold a number BlueEyes cannot observe.

  -- Set when somebody takes it, so "who is on this" is answerable without a
  -- separate tool. No foreign key to `users`, matching every other user
  -- reference in this module — and because ON DELETE SET NULL would erase who
  -- handled an incident the moment they left.
  ADD COLUMN acknowledged_at DATETIME(3) DEFAULT NULL AFTER resolved_by,
  ADD COLUMN acknowledged_by INT DEFAULT NULL AFTER acknowledged_at;

-- The timeline.
--
-- Built from events that ACTUALLY HAPPENED, each with the time it happened —
-- not a narrative composed afterwards. That is the whole requirement: an
-- operator reading "14:07 service marked DEGRADED" must be able to trust that
-- something marked it degraded at 14:07.
--
-- Append-only in practice: rows are written as things occur and never edited.
-- A timeline that can be rewritten is a timeline nobody can rely on during a
-- post-mortem, which is exactly when it is read.
CREATE TABLE IF NOT EXISTS service_incident_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,

  -- What kind of thing happened. Open text rather than an ENUM: the set grows
  -- with every detector, and a migration per new event type would mean
  -- detectors cannot ship independently.
  kind VARCHAR(64) NOT NULL,
  -- One sentence, in the operator's words. This is what the timeline SHOWS.
  summary VARCHAR(512) NOT NULL,
  -- The supporting facts, redacted before they get here.
  detail JSON DEFAULT NULL,

  -- Who or what caused this entry. A person acknowledging an incident and a
  -- sweep observing a recovery are both real events, and the timeline must not
  -- present one as the other.
  source ENUM('run','sweep','correlation','rule','person','notification') NOT NULL DEFAULT 'run',
  actor_id INT DEFAULT NULL,

  -- When it HAPPENED, which is not when the row was written. A run that took
  -- four minutes produced events across four minutes, and ordering by insert
  -- time would be a timeline of the database rather than of the outage.
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The only query this table serves: one incident's events in order.
  KEY idx_sie_incident (incident_id, occurred_at, id),

  CONSTRAINT fk_sie_incident FOREIGN KEY (incident_id)
    REFERENCES service_test_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
