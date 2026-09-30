-- 143 — accept the open findings of event cases that are already concluded.
--
-- The red attack-indication bar at the top of every page counts findings with
-- `acked = 0` (src/analysis/findings.js → attackIndication). Concluding an
-- event case never touched them, so an operator who resolved the very event
-- the bar pointed at was left with the bar still lit and no control anywhere
-- on that screen that could put it out. The routers do this now, on every path
-- that moves a case to `resolved` or `closed`.
--
-- This is the backlog those routers cannot reach: the cases concluded before
-- the fix. One indexed UPDATE, and it says exactly what the routers say.
--
-- Re-runnable: `acked = 0` in the WHERE means a second apply matches nothing.
-- It is also non-destructive in the direction that matters — accepting a
-- finding hides it from the open lists, it does not delete it, and the row
-- keeps every column it had.

UPDATE findings f
  JOIN event_cases e ON e.id = f.event_case_id
   SET f.acked = 1
 WHERE f.acked = 0
   AND e.status IN ('resolved', 'closed');
