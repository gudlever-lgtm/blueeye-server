-- Severity rules — "this kind of event is a warning for us, not a critical".
--
-- BlueEyes decides severity at detection time: the analysis detector from a MAD
-- z-score, Service Assurance from the kind of failure. Both are reasonable
-- defaults and neither knows your business. A packet-loss anomaly that pages one
-- customer at 3am is background noise to another.
--
-- So a rule says: events matching THIS get THAT severity, from now on.
--
-- WHAT THIS IS NOT: a mute button. A rule can move an event to INFO; it can
-- never make one disappear. Something that silently deletes events is a
-- different and far more dangerous control, and it is not going to hide behind
-- this one.
--
-- Applied at STORE time, not at read time. That is deliberate:
--
--   * alerting reads the stored severity, and not paging on it is the whole
--     point of the feature;
--   * history stays a record of what was decided AT THE TIME. With read-time
--     rules, a rule written today would silently rewrite what you thought last
--     March, and "why did nobody act on this" becomes unanswerable.
--
-- Existing open events are therefore NOT touched by writing a rule. Applying one
-- backwards is a separate, explicit action with its own count and audit entry.
CREATE TABLE event_severity_rules (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  -- Which stream this rule governs. Kept explicit rather than inferred: the two
  -- sources have different match fields, and a rule that accidentally spanned
  -- both would be impossible to reason about.
  source         ENUM('finding','service_assurance') NOT NULL,
  -- The match. A NULL field means "any" — so a rule with only `match_metric`
  -- covers that metric everywhere, and adding `match_host_id` narrows it to one
  -- agent. Specificity (how many fields are set) decides which rule wins.
  match_metric   VARCHAR(255)      DEFAULT NULL,
  match_kind     VARCHAR(60)       DEFAULT NULL,
  match_host_id  VARCHAR(255)      DEFAULT NULL,
  match_application_id INT         DEFAULT NULL,
  severity       ENUM('INFO','WARN','CRIT') NOT NULL,
  -- Why the operator made this rule, in their words. Required by the API: a
  -- rule that silently downgrades criticals and cannot say why is exactly the
  -- thing somebody inherits in two years and dare not delete.
  reason         TEXT              DEFAULT NULL,
  enabled        TINYINT(1)    NOT NULL DEFAULT 1,
  -- How often it has actually fired. A rule that has never matched is either
  -- wrong or no longer needed, and without this nobody would ever find out.
  applied_count  INT           NOT NULL DEFAULT 0,
  last_applied_at DATETIME(3)      DEFAULT NULL,
  created_by     INT               DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_esr_source (source, enabled),
  CONSTRAINT fk_esr_application FOREIGN KEY (match_application_id)
    REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Provenance on the events themselves.
--
-- An event whose severity came from a rule MUST say so, with what it would have
-- been and which rule changed it. Without that, this feature is a machine for
-- quietly hiding criticals: the dashboard goes green and nobody looks again.
ALTER TABLE findings
  ADD COLUMN original_severity ENUM('INFO','WARN','CRIT') DEFAULT NULL AFTER severity,
  ADD COLUMN severity_rule_id INT DEFAULT NULL AFTER original_severity,
  ADD CONSTRAINT fk_findings_severity_rule FOREIGN KEY (severity_rule_id)
    REFERENCES event_severity_rules(id) ON DELETE SET NULL;

ALTER TABLE service_test_incidents
  ADD COLUMN original_severity ENUM('INFO','WARN','CRIT') DEFAULT NULL AFTER severity,
  ADD COLUMN severity_rule_id INT DEFAULT NULL AFTER original_severity,
  ADD CONSTRAINT fk_sti_severity_rule FOREIGN KEY (severity_rule_id)
    REFERENCES event_severity_rules(id) ON DELETE SET NULL;
