-- 146 — event_patterns + alert_routes: one named match, used by every policy.
--
-- THE PROBLEM. BlueEyes already has a matcher: event_severity_rules (086) pins
-- down source/metric/kind/agent/application, blank means "any", and the most
-- specific rule wins. It is a good matcher and it is welded to exactly one
-- decision — what severity to store. So an operator who wants
--
--     "packet loss on the warehouse links is a warning, and it goes to the
--      Matrix room rather than to e-mail"
--
-- writes the match once as a severity rule and then cannot write it again for
-- alerting at all: the dispatcher sees only a severity, and its cooldown is
-- keyed per (host, metric, kind, …), so forty warehouse agents are forty
-- alerts.
--
-- A PATTERN is that same match, given a name and stored once. A severity rule
-- can point at one instead of carrying its own match fields, and an alert route
-- hangs off one to say where its events go. Nothing else about the matcher
-- changes: same fields, same "blank = any", same most-specific-wins — see
-- src/events/severityRules.js, which patterns reuse rather than reimplement.
--
-- WHAT A PATTERN IS NOT. It is not a query language. Four fields and
-- specificity cover what the matcher has always covered; a pattern with no
-- field set at all would govern every event from its source and is refused by
-- the validator, exactly as a severity rule is.
CREATE TABLE IF NOT EXISTS `event_patterns` (
  `id`             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`      INT              DEFAULT NULL,
  -- The name is the point of the table: it is what the severity rule and the
  -- alert route refer to, and what a person reads on the screen instead of
  -- re-deciphering four match fields. Unique, because two patterns called
  -- "Warehouse links" is a person who has lost track of which is which.
  `name`           VARCHAR(80)  NOT NULL,
  -- Which stream. The two sources have different match fields, so a pattern
  -- that spanned both would be impossible to reason about (as 086).
  `source`         ENUM('finding','service_assurance') NOT NULL,
  `match_metric`   VARCHAR(255)     DEFAULT NULL,
  `match_kind`     VARCHAR(60)      DEFAULT NULL,
  `match_host_id`  VARCHAR(255)     DEFAULT NULL,
  `match_application_id` INT        DEFAULT NULL,
  -- Why this grouping exists, in the operator's words. Required by the API for
  -- the same reason a severity rule's is: whoever inherits it needs to know.
  `reason`         VARCHAR(500)     DEFAULT NULL,
  -- Off keeps the row without applying it. A disabled pattern takes its
  -- severity rules and its alert route out of effect with it — the alternative
  -- (rules quietly falling back to their own stale match fields) is a pattern
  -- switched off that still changes severities.
  `enabled`        TINYINT(1)   NOT NULL DEFAULT 1,
  `created_by`     INT UNSIGNED     DEFAULT NULL,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_event_patterns_name` (`name`),
  KEY `idx_event_patterns_source` (`source`, `enabled`),
  CONSTRAINT `fk_event_patterns_user` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A severity rule may take its match from a pattern instead of carrying its
-- own. NULL is every rule that exists today, which keeps working untouched.
--
-- ON DELETE CASCADE, not SET NULL: a rule whose pattern is deleted would
-- otherwise fall back to its own match columns — blank for a pattern-backed
-- rule — and a rule with nothing pinned down governs EVERY event from its
-- source. Deleting a pattern takes its rules with it, which is what the screen
-- warns about before it does it.
ALTER TABLE `event_severity_rules`
  ADD COLUMN `pattern_id` INT NULL DEFAULT NULL AFTER `source`,
  ADD KEY `idx_event_severity_rules_pattern` (`pattern_id`),
  ADD CONSTRAINT `fk_event_severity_rules_pattern` FOREIGN KEY (`pattern_id`)
    REFERENCES `event_patterns` (`id`) ON DELETE CASCADE;

-- Where a pattern's events go, and from which severity. ONE row per pattern:
-- the pattern is the grouping, and a second route on the same grouping would
-- mean two answers to "where does this go" with nothing to break the tie. Two
-- destinations for two severities are two patterns.
--
-- WHAT IT CHANGES IN THE DISPATCHER (src/analysis/alerting/dispatcher.js):
--   * only the channels named here are tried, instead of every enabled one;
--   * `min_severity` here replaces the per-channel minimum for these events;
--   * the cooldown is keyed on the PATTERN rather than on (host, metric, kind,
--     …), so one condition across forty agents is one alert — which is the
--     reason most of this table exists.
-- An event that matches no pattern, or a pattern with no route, dispatches
-- exactly as it does today.
CREATE TABLE IF NOT EXISTS `alert_routes` (
  `id`             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `pattern_id`     INT          NOT NULL,
  -- Comma-separated channel names (email, webhook, matrix, syslog) — a short
  -- closed set the validator checks against src/analysis/alerting/config.js.
  -- NEVER empty: a route with no channel is a mute button, and muting has its
  -- own control (maintenance windows), which says so on the screen and expires.
  `channels`       VARCHAR(255) NOT NULL,
  -- Blank = keep each channel's own minimum.
  `min_severity`   ENUM('INFO','WARN','CRIT') DEFAULT NULL,
  -- Blank = the global ALERT_COOLDOWN_MS.
  `cooldown_ms`    INT UNSIGNED     DEFAULT NULL,
  `reason`         VARCHAR(500)     DEFAULT NULL,
  `enabled`        TINYINT(1)   NOT NULL DEFAULT 1,
  -- How often this route has actually decided an alert. A route nobody can tell
  -- is dead is one nobody dares delete (as 086's applied_count).
  `matched_count`  INT UNSIGNED NOT NULL DEFAULT 0,
  `last_matched_at` DATETIME        DEFAULT NULL,
  `created_by`     INT UNSIGNED     DEFAULT NULL,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_alert_routes_pattern` (`pattern_id`),
  CONSTRAINT `fk_alert_routes_pattern` FOREIGN KEY (`pattern_id`)
    REFERENCES `event_patterns` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alert_routes_user` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
