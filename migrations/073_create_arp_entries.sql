-- 073 — ARP/neighbour entries: the IP↔MAC identity source.
--
-- The technician searches for what the phone told them, and sometimes that is a
-- MAC address. Before this table the server had no queryable MAC at all:
--
--   * lldp_neighbors.remote_chassis_id is often a MAC, but it identifies a
--     SWITCH CHASSIS, not a client — wrong answer to "where is this laptop".
--   * arp.table WAS already collected, but only as a gzip blob inside
--     cluster_evidence_snapshots (mig 065): raw command output, unparsed,
--     unindexed, and only for clusters that happened to trigger a capture.
--
-- So the data existed and was unusable. This table parses it into rows.
--
-- TWO INGEST SOURCES, both folding into the same table via `source`:
--   'evidence'    — parsed out of an evidence snapshot's arp.table payload as it
--                   is captured. Needs no agent change, so it works against
--                   agents already in the field, but only fires when a cluster
--                   opens.
--   'capabilities'— the agent reports its own neighbour table on the regular
--                   capabilities cycle. Fresh and continuous, but only from
--                   agents new enough to send it.
-- Neither is authoritative on its own; together they cover the fleet during the
-- rollout, which is why `source` is recorded per row rather than assumed.
--
-- IDENTITY: one row per (agent_id, ip). An IP's MAC changing is an UPDATE, not a
-- second row — the current occupant of an address is what a search must return,
-- and keeping history here would turn an identity lookup into a time query. The
-- previous MAC is not lost silently: `mac_changed_at` marks when the binding
-- last moved, which is exactly the signal that says "this answer may be stale in
-- an interesting way".
--
-- Scoped per agent, not global: the same RFC1918 address legitimately exists at
-- several sites, and collapsing them would resolve 192.168.1.10 to whichever
-- site reported last. The search layer surfaces all matches with their agent.
--
-- PRIVACY: metadata only, consistent with the rest of the product — an address
-- pairing observed on the local segment. No payload, no DPI, no user identity.
-- Broadcast/multicast MACs are dropped by the parser, not stored and filtered.
CREATE TABLE IF NOT EXISTS arp_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,                    -- the agent that observed it
  ip VARCHAR(45) NOT NULL,                           -- IPv4 or IPv6 (neighbour table)
  mac CHAR(17) NOT NULL,                             -- normalised aa:bb:cc:dd:ee:ff
  interface VARCHAR(64) NULL DEFAULT NULL,           -- local device the entry was seen on
  source ENUM('evidence', 'capabilities') NOT NULL DEFAULT 'capabilities',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  -- When the MAC behind this IP last CHANGED. NULL = never moved since first
  -- seen. A recent value is the "this binding just moved" signal.
  mac_changed_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_arp_agent_ip (agent_id, ip),
  KEY idx_arp_mac (mac),                             -- MAC → where is it (the search path)
  KEY idx_arp_ip (ip),                               -- IP → which MAC/agent
  KEY idx_arp_last_seen (last_seen),                 -- age-out sweep
  CONSTRAINT fk_arp_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
