-- Authenticated discovery (V2 Discovery, extended).
--
-- Discovery crawls what a logged-out visitor sees. It DETECTS the login form and
-- stops there — so everything behind the sign-in, which is where the actual user
-- journeys live, has been invisible.
--
-- Two ways in, because of the chicken-and-egg: on a brand new application there
-- is no login test yet.
--
--   login_test_id  replay an existing test's steps, then crawl from there. The
--                  most reliable route: that test already encodes how to sign
--                  into THIS application, including any two-step flow, cookie
--                  banner or tenant picker.
--
--   credential_id  use the login form the anonymous pass already found, with a
--                  stored credential. Needs no prior setup at all, which is what
--                  makes the first authenticated discovery possible.
--
-- The second bootstraps the first: a successful credential-based discovery
-- suggests a Login test from the form it just used, so every later rediscover
-- takes the reliable route.
ALTER TABLE service_test_discoveries
  ADD COLUMN login_test_id INT DEFAULT NULL AFTER environment_id,
  ADD COLUMN credential_id INT DEFAULT NULL AFTER login_test_id,

  -- Did it ACTUALLY get in? Not "was a credential supplied" — whether the crawl
  -- reached a signed-in state. A discovery that asked to authenticate and could
  -- not must never be read as a map of the authenticated site.
  ADD COLUMN authenticated TINYINT(1) NOT NULL DEFAULT 0 AFTER credential_id,

  -- How far it got before the session went. A crawl can be logged out halfway
  -- and carry on mapping the PUBLIC site while reporting it as authenticated —
  -- worse than not having the feature, because the map would be trusted. When
  -- this is set, the discovery says so rather than presenting a partial map as
  -- a whole one.
  ADD COLUMN session_lost_at_page INT DEFAULT NULL AFTER authenticated,
  -- Why authentication did not happen or did not hold, in the operator's words.
  ADD COLUMN auth_note VARCHAR(512) DEFAULT NULL AFTER session_lost_at_page,

  -- Pages only reachable once signed in. The whole point of the feature, and the
  -- number that tells an operator whether it was worth it.
  ADD COLUMN authenticated_page_count INT NOT NULL DEFAULT 0 AFTER page_count,

  -- WHERE the login form is and what it looks like, from the anonymous pass.
  -- Only the count was kept before, which is enough to say "there is a login
  -- here" and useless for actually filling it in. This is what makes the
  -- credential route possible with no prior test:
  --   { url, confidence, usernameField, passwordField, submitLabel }
  -- Field DESCRIPTIONS only — labels and names, never a value, and never a
  -- credential.
  ADD COLUMN detected_login JSON DEFAULT NULL AFTER login_count,

  -- No foreign keys to tests or credentials. A discovery is a RECORD OF WHAT
  -- HAPPENED, and deleting the test it borrowed must not delete the history of
  -- the crawl that used it — nor silently null the column that says how it got
  -- in. The ids are kept as a plain reference, the same way this module treats
  -- every other backward-looking link.
  ADD KEY idx_std_login_test (login_test_id);
