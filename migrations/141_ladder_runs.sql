-- 141 — the log of diagnoses run.
--
-- The Connection test's ladder walks the layers a packet meets and names the
-- first one that breaks. Until now that answer existed only on the screen of
-- whoever pressed the button: the audit trail recorded that probes were
-- DISPATCHED (who, when, against what), and nothing recorded what the walk
-- CONCLUDED. "We diagnosed this yesterday and it said the firewall" was not a
-- question this server could answer.
--
-- One row per walk. The verdict is written later, not at dispatch: probes come
-- back over the following seconds, so the conclusion is stamped on when the
-- ladder is next READ for that run, and each later read overwrites it. Last
-- write wins, which is the final state of that diagnosis.
--
-- WHY A TABLE AND NOT MORE AUDIT ROWS. The audit trail is a hash-chained record
-- of what somebody DID, and it is append-only by design — a verdict that
-- arrives four seconds after the action cannot be written back into the row
-- that recorded the action without breaking the chain. It is also the wrong
-- shape to read: nobody wants "every probe_start ever" to answer "what did the
-- last diagnosis of this host say". The audit row still exists and still
-- records the dispatch; this is the diagnosis.
--
-- WHAT IS NOT STORED: the per-rung sentences. They are rendered from the
-- measurements on demand, in the reader's own language, and a copy frozen in
-- English at run time would drift from the probe rows it claims to describe.
-- `stops_at` is the rung id, which is stable; the sentence is rebuilt from the
-- results whenever the row is opened.
CREATE TABLE IF NOT EXISTS `ladder_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  -- The far end of a two-way walk. NULL for every other ladder.
  `peer_agent_id` INT UNSIGNED NULL DEFAULT NULL,
  -- Which ladder was walked: 'reachability', 'two_way', 'local_host',
  -- 'device_location'. Not an ENUM — a ladder is added in code, and a schema
  -- change to register one would be a migration nobody expects.
  `ladder` VARCHAR(32) NOT NULL,
  -- What it was about: a destination, a device, or neither (local_host).
  `target` VARCHAR(255) NULL DEFAULT NULL,
  -- What the operator said was wrong, in their own words. Bounded at the API.
  `symptom` VARCHAR(500) NULL DEFAULT NULL,
  -- Filled in by a later read. `outcome` is the verdict's own word (stops /
  -- suspect / clear / partial / untested) and `stops_at` the rung id, or NULL
  -- while nothing has broken.
  `outcome` VARCHAR(16) NULL DEFAULT NULL,
  `stops_at` VARCHAR(32) NULL DEFAULT NULL,
  -- How many probes actually reached an agent. 0 means the walk was recorded
  -- and nothing ran, which is a different story from a walk that ran and found
  -- nothing wrong.
  `dispatched` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `started_at` DATETIME(3) NOT NULL,
  `verdict_at` DATETIME(3) NULL DEFAULT NULL,
  -- Who ran it. An email snapshot survives the user row being deleted, the
  -- same way event notes and health acknowledgements keep theirs.
  `started_by` INT UNSIGNED NULL DEFAULT NULL,
  `started_email` VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  -- "What did we last diagnose about this host" — the read the screen makes.
  KEY `idx_ladder_runs_agent_started` (`agent_id`, `started_at`),
  -- The open run a verdict is stamped onto, and the history of one target.
  KEY `idx_ladder_runs_lookup` (`agent_id`, `ladder`, `target`, `started_at`),
  -- Retention sweeps by age.
  KEY `idx_ladder_runs_started` (`started_at`),
  CONSTRAINT `fk_ladder_runs_agent` FOREIGN KEY (`agent_id`)
    REFERENCES `agents` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ladder_runs_peer` FOREIGN KEY (`peer_agent_id`)
    REFERENCES `agents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ladder_runs_user` FOREIGN KEY (`started_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
