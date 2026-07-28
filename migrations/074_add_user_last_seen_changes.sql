-- 074 — per-user "I have seen the changes up to here" marker.
--
-- The landing page answers "what happened since I last looked", which needs a
-- per-user reference point. This is that column.
--
-- WHY A COLUMN AND NOT users.preferences:
-- `preferences` is a JSON blob written by PUT /me/preferences, whose entire
-- semantics are "the user changed a setting". A seen-marker has the opposite
-- rule — it must move ONLY on an explicit "mark as seen", never as a side effect
-- of a read. Sharing a write path between something that should update freely
-- and something that must not is exactly how a marker ends up silently
-- advancing on every page load, at which point the landing page can never show
-- the user anything again. A separate column keeps the two rules apart.
--
-- NULL = this user has never marked anything seen. The route treats that as
-- "fall back to the default window" rather than "everything since the epoch":
-- a first-time visitor wants the last day, not four years of history.
ALTER TABLE users
  ADD COLUMN last_seen_changes DATETIME NULL DEFAULT NULL AFTER preferences;
