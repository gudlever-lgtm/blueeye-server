-- 095 — a monitor starts watching only once it has worked once.
--
-- Until now a new monitor was due the moment it was saved: `dueForCheck` treats
-- a NULL `last_run_at` as "never run, so run it", and the sweep took it on the
-- next tick. Mistype the mail server and the monitor fails every interval from
-- then on, opening an incident after the failure streak — so an operator finds
-- out about their own typo as an outage, at two in the morning, from an alert.
--
-- `activated_at` is the gate. NULL means PENDING: the monitor is saved, it is
-- visible, "Check now" runs it, and the sweep leaves it alone. The first check
-- that comes back `ok` or `slow` (the exchange worked; `slow` only means it was
-- over a threshold) stamps this column, and from that moment it is scheduled
-- like any other.
--
-- While pending, a failing check opens NO incident and sends NO alert. That is
-- the half that matters: setting a monitor up is not an outage.
--
-- An operator can also stamp it by hand ("Activate anyway"), because the gate
-- would otherwise be a trap: when the service is genuinely down at the moment
-- you create the monitor, watching it is exactly what you want.
ALTER TABLE service_monitors
  ADD COLUMN activated_at DATETIME(3) NULL DEFAULT NULL AFTER enabled;

-- Monitors that already exist keep running. An upgrade that silently paused
-- every monitor on the estate — because none of them had a column that did not
-- exist yesterday — would be the worst possible reading of this feature.
--
-- Scoped to rows that have actually run: a monitor created moments before the
-- upgrade and never checked starts pending, which is the new behaviour and
-- costs nothing. One that has run (even failing) was being watched before, and
-- stays watched.
UPDATE service_monitors
   SET activated_at = COALESCE(last_run_at, created_at)
 WHERE activated_at IS NULL
   AND last_run_at IS NOT NULL;
