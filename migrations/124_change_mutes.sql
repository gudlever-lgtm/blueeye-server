-- 124 — per-user "Mute this rule" on the Changes page.
--
-- An acknowledgement (115) hides ONE row until its condition happens again. A
-- mute hides a whole KIND of row — every row of one source + type, on every
-- host — for a fixed time: "stop showing me version skew until tomorrow". The
-- key is the row's `muteKey` (muteKeyFor in src/changes/changeFeed.js).
--
-- PER USER, for the same reason as 115: the Changes feed owns no events, and
-- muting what one person sees must not change what the next shift sees. A mute
-- never touches alerting — rules that page people live in severity_rules and
-- alert_rules and are not affected.
--
-- TIME-BOXED, never permanent: a mute that outlives the reason for it is how a
-- landing page quietly stops showing the thing that matters. `muted_until` is
-- always set; the repository reads only live rows and prunes expired ones on
-- the next mute.
CREATE TABLE IF NOT EXISTS `change_mutes` (
  `user_id` INT UNSIGNED NOT NULL,
  `mute_key` CHAR(64) NOT NULL,
  `muted_until` DATETIME(3) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `mute_key`),
  -- The read and the prune: "this user's mutes that are still live".
  KEY `idx_change_mutes_user_until` (`user_id`, `muted_until`),
  CONSTRAINT `fk_change_mutes_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
