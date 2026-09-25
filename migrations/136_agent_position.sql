-- 136 — an agent's own position on the map.
--
-- Until now an agent was only ever where its SITE was: latitude/longitude live
-- on `locations`, and an agent borrowed them through location_id. That is right
-- for a probe in an office, and wrong for one that runs in a cloud data centre,
-- behind a VPN exit, or in a rack somewhere the site record does not describe.
-- The traceroute map measures every hop from the agent's position, so a wrong
-- position makes every hop wrong (docs/geo.md, "Is the agent where its site
-- says?").
--
-- Both NULL (the default) means "use the site's position", so every existing
-- agent reads exactly as before. Set together or not at all — enforced by the
-- validator (src/validation/agentValidation.js validateAgentPosition). Same type
-- as locations.latitude/longitude (migration 008).

ALTER TABLE agents
  ADD COLUMN latitude DECIMAL(9,6) NULL DEFAULT NULL AFTER location_id,
  ADD COLUMN longitude DECIMAL(9,6) NULL DEFAULT NULL AFTER latitude;
