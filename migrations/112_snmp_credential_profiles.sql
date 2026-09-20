-- 112 — SNMP credential profiles, and SNMPv3.
--
-- WHAT WAS PROPOSED, AND WHAT IS BUILT.
--
-- The proposal was: a profile per site, an optional profile per subnet, an
-- override per device, and the AGENT tries them in order, remembers what
-- worked and reports auth_failed per device.
--
-- The hierarchy is built. The ordered trying is NOT, and the reason is in
-- SNMP-AUDIT.md: trying credentials in sequence against an address is
-- credential spraying, and it is technically identical to an attack whatever
-- the intent.
--
--   * Against v3 it is actively harmful. v3 is authenticated, failed authPriv
--     attempts are logged as security events on most platforms and some lock
--     the account.
--   * Against v2c it produces silent failure. A wrong community usually gets
--     no error at all, just a timeout — three profiles x 30 s per device per
--     cycle, sequentially, against a 60 s interval floor. The polling collapses
--     before it finds anything.
--   * It is out of step with the rest of this feature, which checks the SSRF
--     deny-list TWICE for every device and keeps the community out of
--     SAFE_COLUMNS so a route cannot leak it by accident.
--
-- So the profile is resolved ON THE SERVER — device override, then the site
-- profile, then the global default — and the agent receives ONE credential per
-- device, exactly as it does today. The agent never learns that profiles exist,
-- which keeps the secret surface on the agent exactly the size it already is.
--
-- The subnet level is deliberately left out. `locations` already exists and is
-- what `snmp_devices.location_id` points at; a middle tier needing CIDR matching
-- on the server has to earn its place with a case that site + override cannot
-- express, and none was given.
CREATE TABLE IF NOT EXISTS `snmp_credential_profiles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(190) NOT NULL,
  -- NULL is the GLOBAL default: the profile used by a device whose site has
  -- none of its own. At most one row may have it (enforced in the repository,
  -- not by a unique index, because MySQL treats NULLs as distinct).
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `version` ENUM('1', '2c', '3') NOT NULL DEFAULT '2c',

  -- v1/v2c. One shared secret, and the protocol sends it in clear text.
  `community_encrypted` TEXT NULL DEFAULT NULL,

  -- v3. Everything here is secretBox (AES-256-GCM) at rest, the same
  -- `src/lib/secretBox.js` the integrations and the LDAP bind password use, and
  -- none of it is ever returned by a read.
  --
  -- The three security levels are a CONSEQUENCE of which keys are set rather
  -- than a column of their own: a user with no auth key is noAuthNoPriv, with
  -- an auth key is authNoPriv, with both is authPriv. Storing the level
  -- separately would let it disagree with the keys.
  `v3_user` VARCHAR(190) NULL DEFAULT NULL,
  `v3_auth_proto` ENUM('md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512') NULL DEFAULT NULL,
  `v3_auth_key_encrypted` TEXT NULL DEFAULT NULL,
  `v3_priv_proto` ENUM('des', 'aes', 'aes256b', 'aes256r') NULL DEFAULT NULL,
  `v3_priv_key_encrypted` TEXT NULL DEFAULT NULL,
  -- Some devices need the engine id stated rather than discovered.
  `v3_context` VARCHAR(190) NULL DEFAULT NULL,

  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_snmp_profile_name` (`name`),
  KEY `idx_snmp_profile_location` (`location_id`),
  CONSTRAINT `fk_snmp_profile_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A device may name a profile explicitly. NULL means "resolve it" — by site,
-- then globally — and a device with its own `community_encrypted` still wins
-- over both, so every existing row keeps working with nothing to migrate.
--
-- ON DELETE SET NULL: deleting a profile must not delete the switches that used
-- it. They fall back to the resolution chain, and a device with nothing left to
-- resolve to reports that it has no credential rather than silently polling
-- with 'public'.
ALTER TABLE `snmp_devices`
  ADD COLUMN `credential_profile_id` INT UNSIGNED NULL DEFAULT NULL AFTER `community_encrypted`,
  ADD CONSTRAINT `fk_snmp_devices_profile` FOREIGN KEY (`credential_profile_id`)
    REFERENCES `snmp_credential_profiles` (`id`) ON DELETE SET NULL;

-- v3 on the device row too, so a device can be v3 while its profile is v2c or
-- the other way round. The version that RUNS is the one on the credential that
-- was resolved, which is what the repository returns.
ALTER TABLE `snmp_devices`
  MODIFY COLUMN `version` ENUM('1', '2c', '3') NOT NULL DEFAULT '2c';
