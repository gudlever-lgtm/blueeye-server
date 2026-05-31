-- 007 — mark protected (super-admin) users. A protected user is always an admin
-- and cannot be demoted or deleted; only a password reset is allowed.
ALTER TABLE users
  ADD COLUMN protected TINYINT(1) NOT NULL DEFAULT 0 AFTER role;
