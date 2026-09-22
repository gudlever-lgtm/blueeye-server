-- 115 — per-user acknowledgements on the Changes page.
--
-- The Changes feed owns no events: it is assembled on every request from a
-- dozen sources, and several of its rows (a silent agent, version skew) are
-- derived from current state and exist in no table at all. So an
-- acknowledgement cannot be written back to "the event" — for most rows there
-- is none. It is stored here instead, against the row's `ackKey`: a hash of the
-- CONDITION the row describes (see ackKeyFor in src/changes/changeFeed.js),
-- which is stable across reloads and windows.
--
-- PER USER, like the seen-marker in 074. Acknowledging a row hides it from the
-- caller's own view; it does not claim the problem for the team. The sources
-- that have a shared acknowledgement (findings, event clusters) keep theirs.
--
-- A NEW occurrence re-opens the row: the route compares the row's newest
-- timestamp with `acked_at`, so a condition that fires again after it was
-- acknowledged is shown again. DATETIME(3) because that comparison is against
-- millisecond timestamps — a whole-second column would round an acknowledgement
-- made at 12:00:00.400 down past a row stamped 12:00:00.300 half the time.
--
-- Bounded: the repository ignores and prunes rows older than 30 days, the
-- longest window the page can show.
CREATE TABLE IF NOT EXISTS `change_acks` (
  `user_id` INT UNSIGNED NOT NULL,
  `ack_key` CHAR(64) NOT NULL,
  `acked_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`user_id`, `ack_key`),
  -- The prune: "this user's acknowledgements older than the window".
  KEY `idx_change_acks_user_time` (`user_id`, `acked_at`),
  CONSTRAINT `fk_change_acks_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
