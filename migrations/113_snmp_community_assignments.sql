-- 113 — a community is assigned to SITES and to AGENTS, not to one site.
--
-- WHAT 112 GOT HALF-RIGHT. A credential profile carried a single
-- `location_id`, and NULL meant "the global default". That gives a site exactly
-- one shared community and no way to say WHICH agents may use it — and the two
-- questions are different:
--
--   * a SITE answers "which communities are valid on this network";
--   * an AGENT answers "which of them is this host allowed to speak".
--
-- The second one is the access control. An agent is a Linux box in a wiring
-- closet; the read-only community of the core switch does not belong on every
-- one of them just because they share a postcode. So the grant is explicit:
-- AN AGENT WALKS ONLY WITH A COMMUNITY ASSIGNED TO IT. No assignment, no named
-- credential, and the device reports that it has none rather than quietly
-- polling with 'public'.
--
-- WHAT DOES NOT CHANGE. The resolution still runs ON THE SERVER and the agent
-- still receives exactly ONE credential per device. Several communities per
-- site is not several attempts per device: the server picks the first one, in
-- the site's own order, that the polling agent is also allowed to use, and
-- sends that. Trying them in sequence at the agent is credential spraying —
-- the reason 112 refused it has not changed, and having more of them assigned
-- makes it worse, not better.
--
-- NOTHING BREAKS ON UPGRADE. The backfill at the bottom copies every existing
-- `location_id` into the new table, marks the old NULL rows as the global
-- default, and grants every existing community to every existing agent — so a
-- fleet that upgrades polls exactly what it polled before. Narrowing it is then
-- an admin's deliberate act, which is the only way an access rule is worth
-- anything.

-- Which communities are valid at a site. Many-to-many in both directions: a
-- site may have several (a core switch and an access stack under different
-- strings), and one community may serve twenty sites.
CREATE TABLE IF NOT EXISTS `snmp_profile_locations` (
  `profile_id` INT UNSIGNED NOT NULL,
  `location_id` INT UNSIGNED NOT NULL,
  -- The site's ORDER of preference. Lower first, `profile_id` breaking ties, so
  -- resolution is deterministic: the same device resolves to the same community
  -- on every poll, rather than to whichever row the optimiser returned first.
  -- This is an ORDER, not a retry list — only the first usable one is ever sent.
  `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`profile_id`, `location_id`),
  -- The read this table exists for: "the communities for this site, in order".
  KEY `idx_snmp_profile_loc_site` (`location_id`, `priority`, `profile_id`),
  -- CASCADE both ways. An assignment is not a fact about the world that should
  -- outlive its site or its community; it is a link between two rows, and a
  -- dangling one would resolve to a credential that no longer exists.
  CONSTRAINT `fk_snmp_profile_loc_profile` FOREIGN KEY (`profile_id`)
    REFERENCES `snmp_credential_profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_snmp_profile_loc_location` FOREIGN KEY (`location_id`)
    REFERENCES `locations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which communities an AGENT may walk with. This is the access rule, and it is
-- a grant rather than a filter: a row here is the only thing that lets an
-- agent be handed this community for any device it polls.
--
-- Deliberately NOT derived from the agent's own `location_id`. An agent moves
-- sites by an admin editing a dropdown, and a credential grant that follows a
-- dropdown is a credential grant nobody decided to make.
CREATE TABLE IF NOT EXISTS `snmp_profile_agents` (
  `profile_id` INT UNSIGNED NOT NULL,
  `agent_id` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`profile_id`, `agent_id`),
  -- "What may this agent use" — asked once per config fetch, per agent.
  KEY `idx_snmp_profile_agent_agent` (`agent_id`, `profile_id`),
  CONSTRAINT `fk_snmp_profile_agent_profile` FOREIGN KEY (`profile_id`)
    REFERENCES `snmp_credential_profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_snmp_profile_agent_agent` FOREIGN KEY (`agent_id`)
    REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The global default becomes a COLUMN rather than the absence of a site.
--
-- 112 encoded it as `location_id IS NULL`, which was serviceable while a
-- profile had exactly one site. With the sites in their own table, "assigned to
-- no site" and "the fallback for every site" would be the same state — and they
-- are opposite intentions. One says the community is not in use anywhere; the
-- other says it is in use everywhere.
ALTER TABLE `snmp_credential_profiles`
  ADD COLUMN `is_global_default` TINYINT(1) NOT NULL DEFAULT 0 AFTER `location_id`;

-- Carry 112's single site into the join table before the column goes.
INSERT IGNORE INTO `snmp_profile_locations` (`profile_id`, `location_id`, `priority`)
  SELECT `id`, `location_id`, 0 FROM `snmp_credential_profiles` WHERE `location_id` IS NOT NULL;

-- ...and 112's "NULL means global" into the new column.
UPDATE `snmp_credential_profiles` SET `is_global_default` = 1 WHERE `location_id` IS NULL;

-- Every existing community to every existing agent, so an upgrade changes
-- nothing about what is polled today. The rule starts being a restriction the
-- moment an admin edits it, and not before — an access rule that breaks
-- monitoring on the deploy that introduces it gets turned off, not obeyed.
INSERT IGNORE INTO `snmp_profile_agents` (`profile_id`, `agent_id`)
  SELECT p.`id`, a.`id` FROM `snmp_credential_profiles` p CROSS JOIN `agents` a;

-- The column is gone rather than left dead: two places to record which site a
-- community belongs to is one place to read the stale one from.
ALTER TABLE `snmp_credential_profiles` DROP FOREIGN KEY `fk_snmp_profile_location`;
ALTER TABLE `snmp_credential_profiles` DROP COLUMN `location_id`;
