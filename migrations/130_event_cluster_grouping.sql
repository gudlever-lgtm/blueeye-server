-- 130 — a situation records WHY its findings were grouped.
--
-- The cross-agent correlator used to group on time + site alone, so a stored
-- cluster's confidence tier WAS its explanation. It now groups on the SUBJECT a
-- finding is about (a probe target, a switch, a port, a transaction test, the
-- agent itself) and joins different subjects only through a topology relation
-- (same switch, LLDP, one upstream of the other, agent-level findings at the
-- same site). The tier no longer says which of those matched, so the reasons
-- are stored with the cluster: `grouping_basis` is
--   { "subjects": ["target:8.8.8.8", ...],
--     "reasons":  [{ "kind": "target", "detail": "8.8.8.8 seen failing by 2 agents" }, ...] }
-- It is also what lets a later sweep fold a recurring fault back into its open
-- cluster when the earlier member findings have scrolled out of the detection
-- window (same subject => same situation), instead of opening a new one every
-- time a probe re-raises.
--
-- Nullable: clusters stored before this migration have no recorded reasons and
-- are explained from their tier, exactly as before.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'event_clusters'
                      AND column_name = 'grouping_basis'),
  'DO 0',
  'ALTER TABLE event_clusters ADD COLUMN grouping_basis JSON NULL DEFAULT NULL AFTER suspected_common_cause');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
