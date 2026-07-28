-- 075 — interface state + state transitions (Fase 2b).
--
-- The changes landing page (mig 074) could report agent up/down and topology
-- link changes, but NOT interface up/down — the one dimension a technician asks
-- about most. Interfaces are not a persisted entity here: interface health is
-- computed on the fly from `results.payload.traffic` by
-- src/health/interfaceHealth.js, so only the CURRENT state ever existed.
--
-- Deriving that history by polling current state was explicitly ruled out: a
-- poller sees whatever state happens to be true when it looks, misses everything
-- between two looks, and produces a change log that quietly lies about when
-- things happened. So this records transitions AT THE SEAM where state is
-- already determined — the results ingest path — which is the only place that
-- sees every observation.
--
-- TWO TABLES, mirroring the lldp_neighbors + topology_changes pair (mig 063/067)
-- that solves the identical problem for L2 links:
--
--   interface_states       the current known state per (agent, iface). Upserted
--                          on every report; it exists ONLY to diff against.
--   interface_state_transitions  one row per actual change. The history.
--
-- A snapshot table rather than "read the latest transition" because an interface
-- that never changes state would have its last transition aged out by retention,
-- and we would then re-announce its state as a change the next time it is seen.
--
-- FLAP SUPPRESSION: an interface that bounces down/up repeatedly is the classic
-- intermittent fault, and it is also the classic way to fill a change feed with
-- 400 rows nobody can read. A transition that REVERSES a recent one (within
-- INTERFACE_FLAP_WINDOW_SECONDS) collapses onto the earlier row as `flapping`
-- with a bumped `flap_count`, exactly as topology_changes does. The signal is
-- preserved — arguably sharpened, since "flapping 14 times" is the finding —
-- without the noise.
--
-- No FK from transitions to states: the two are keyed the same way but have
-- independent lifetimes (states is current, transitions is history under its own
-- retention), and a cascade from one to the other would delete evidence.
CREATE TABLE IF NOT EXISTS interface_states (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  iface VARCHAR(190) NOT NULL,
  -- The status vocabulary of computeInterfaceHealth: ok | warn | bad | down.
  status VARCHAR(16) NOT NULL,
  oper_status VARCHAR(32) NULL DEFAULT NULL,   -- as reported (up/down/dormant/…)
  -- Backticked: VIRTUAL is a reserved word in MySQL (generated columns), so an
  -- unquoted identifier is a syntax error and the whole migration — and, since the
  -- container runs `migrate && server`, the whole server — fails to start.
  `virtual` TINYINT(1) NOT NULL DEFAULT 0,     -- docker0/veth/tun… (idle, not faulty)
  first_seen DATETIME(3) NOT NULL,
  last_seen DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iface_state (agent_id, iface),
  KEY idx_iface_state_last_seen (last_seen),
  CONSTRAINT fk_iface_state_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interface_state_transitions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  iface VARCHAR(190) NOT NULL,
  from_status VARCHAR(16) NULL DEFAULT NULL,   -- NULL only for a first-ever sighting
  to_status VARCHAR(16) NOT NULL,
  oper_status VARCHAR(32) NULL DEFAULT NULL,
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  summary VARCHAR(512) NOT NULL,
  -- Flap collapse: >1 means this row absorbed that many reversing transitions.
  flap_count INT UNSIGNED NOT NULL DEFAULT 1,
  flapping TINYINT(1) NOT NULL DEFAULT 0,
  detected_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iface_trans_agent (agent_id, detected_at),
  KEY idx_iface_trans_detected (detected_at),
  KEY idx_iface_trans_iface (agent_id, iface, detected_at),
  CONSTRAINT fk_iface_trans_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
