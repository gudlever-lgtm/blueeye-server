# Local user creation with a one-time password

For customers that do **not** use SSO/LDAP, an admin can create a local user who
receives a cryptographically-random **one-time password** by email and is forced
to change it on first login. This complements the existing RBAC user CRUD and the
external auth paths (LDAP/AD, OIDC, SAML).

## When it is available

Local invitations are offered **only when no federated sign-in is active**. If
LDAP/AD, OIDC or SAML is enabled, the endpoints below return **403** and the
dashboard hides the button (customers on SSO manage users in their directory).
`GET /users/local-availability` is the single source of truth the UI reads.

An SMTP host must be configured (**Settings → Alerting** — the same SMTP used for
alert emails). Without it the endpoints answer **503** and the UI shows a hint.

## Flow

1. **Admin invites** — `POST /users/local { email, name?, role }` (admin, gated
   `rbac`). The server generates a ≥16-char random password
   (`src/auth/tempPassword.js`), bcrypt-hashes it, stores the user with
   `must_change_password = 1`, `temp_password_expires_at = now + 48h` (config
   `TEMP_PASSWORD_TTL_HOURS`, clamped 1–168) and `temp_password_created_by`, then
   emails the password (bilingual da/en). If the email fails the just-created user
   is **rolled back** and the call is **500** — nobody is left half-created. The
   plaintext password is **never** returned by the API and never logged.
2. **First login** — the user logs in normally with the one-time password. The
   response carries `mustChangePassword: true` and a JWT flagged the same way.
   A global gate (`src/routes/index.js`) refuses every route except
   `/auth/login`, `/auth/change-password`, `/auth/sso`, `/me` and `/health` with
   **403 `password_change_required`** until the change is done.
3. **Change** — `POST /auth/change-password { currentPassword, newPassword }`
   (authenticated). Verifies the current (one-time) password, enforces the
   baseline policy (**422**), stores the new hash, clears the one-time-password
   state, **revokes older tokens** and returns a fresh, unflagged token so the
   user continues seamlessly. Audited as `password_changed`.
4. **Expiry / resend** — a login after `temp_password_expires_at` is refused with
   **401 `temp_password_expired`** (a clear error, never a 500) and audited. An
   admin can `POST /users/:id/resend-temp-password` to generate + email a fresh
   one-time password (revoking any outstanding session for that user).

## Security

- The one-time password is only ever in the email body; the login **link never
  contains it**.
- Login attempts (including with a one-time password) reuse the existing
  brute-force lockout (`src/auth/loginThrottle.js`, 429). An *expired but correct*
  password does not count as a throttle failure.
- Audit log events: `user_create_local`, `user_temp_password_resend`,
  `login_success` (detail `must_change_password`), `temp_password_expired`,
  `password_changed`, `password_change_failure` — metadata only, never the
  password.

## Where the code lives

| Piece | File |
| --- | --- |
| Migration (users columns) | `migrations/056_user_temp_password.sql` |
| One-time password generator | `src/auth/tempPassword.js` |
| Email (bilingual) + send | `src/services/userMailer.js` (wired in `src/server.js` off the alerting SMTP) |
| Repository | `src/repositories/usersRepository.js` (`create`/`setTempPassword`/`clearTempPassword`) |
| Validation | `src/validation/userValidation.js` (`validateLocalUserCreate`/`validatePasswordChange`) |
| Invite + resend + availability | `src/routes/users.js` |
| Login temp handling + change-password | `src/routes/auth.js` |
| Forced-change gate + wiring | `src/routes/index.js` |
| JWT flag | `src/auth/jwt.js` + `src/auth/middleware.js` |
| Dashboard | `public/index.html` (`#force-change`) + `public/app.js` (`views.users`, force-change form) |
| Tests | `test/tempPassword*.test.js`, `test/userMailer.test.js`, `test/userLocalCreation.test.js`, `test/usersRepository.test.js` |
