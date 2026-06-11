-- 038 — JWT revocation support. A leaked or post-deprovisioning token otherwise
-- stays valid until it expires (12h). `tokens_valid_after` records an instant
-- before which a user's tokens are no longer accepted; requireAuth compares it
-- against the token's `iat`. Set on password/role change, delete, or an explicit
-- revoke. NULL means the user has never had tokens revoked.
ALTER TABLE users
  ADD COLUMN tokens_valid_after DATETIME NULL DEFAULT NULL;
