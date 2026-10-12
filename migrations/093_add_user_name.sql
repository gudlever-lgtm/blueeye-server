-- 093 — a name on the user account.
--
-- BlueEyes has always keyed users by email, and every screen that had to show a
-- person showed the address. That is fine as an identity and poor as a label:
-- "who did this" in the user activity log reads as `drift-ops-2@example.dk`,
-- which nobody recognises at a glance during an incident review.
--
-- `name` is display only — it is never an identifier, never unique, and never
-- used to look a user up. The email stays the key. NULL means "no name given",
-- and every reader falls back to the email rather than inventing one.
--
-- The one-time-password flow already accepted an optional `name` for the email
-- greeting (validateName in src/validation/userValidation.js) and then threw it
-- away because there was nowhere to put it. This is where it goes.
ALTER TABLE users
  ADD COLUMN name VARCHAR(120) NULL DEFAULT NULL AFTER email;
