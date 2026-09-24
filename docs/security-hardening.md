# Baseline security hardening — password history, max age, IP allowlist

Migration `041_baseline_security_hardening.sql` declared three always-on
controls. The audit hash chain shipped with it; this document covers the other
two, which had their table (`password_history`) and column
(`users.password_changed_at`) but no code until now:

| Control | Setting (`app_settings` key `security`) | Default |
| --- | --- | --- |
| Password history | `passwordHistory` — how many recent passwords a new one may not match (0–24, 0 = off) | `5` |
| Password max age | `passwordMaxAgeDays` — days before a local password must be changed (0–3650, 0 = off) | `0` (off) |
| IP allowlist by role | `ipAllowlist: { admin: [...], operator: [...], viewer: [...] }` — addresses/CIDRs, IPv4 or IPv6 | all empty (unrestricted) |

All three are **baseline**: never licence-gated, configured under
**Settings → Authentication → Security** (admin), API `GET/PUT
/api/settings/security`.

## Who each control applies to

| | Local password | LDAP/AD | OIDC / SAML | API token |
| --- | --- | --- | --- | --- |
| Password history | yes | no | no | no |
| Password max age | yes | no | no | no |
| IP allowlist | yes | yes | yes | yes (by the token's role) |

Directory and SSO users have no password BlueEyes chose or knows: the provisioner
gives them an unusable random hash, which is never recorded in the history. The
max age is carried in the session itself — only the local sign-in and
change-password paths put a `pwdAt` claim in the JWT — so an SSO/LDAP session or
an API token can never be "expired". One-time passwords (the local invite) are
not remembered either: they are random and replaced at first login, which is
itself a forced change.

## 1. Password history

Every path that sets a local password goes through `src/auth/passwordHistory.js`:

| Path | Checked | Remembered |
| --- | --- | --- |
| `POST /auth/change-password` (self-service and the forced first-login change) | yes | yes |
| `PUT /users/:id` with a password (admin reset) | yes | yes |
| `POST /users` (admin creates with a password) | — (no history yet) | yes |
| `POST /users/local`, `POST /users/:id/resend-temp-password` (one-time password) | no | no |
| JIT provisioning of an LDAP/OIDC/SAML user | no | no |
| `scripts/seed-superadmin.js`, `src/migrate.js` seed (break glass, outside the app) | no | no |

The check bcrypt-compares the new password with the user's **current** hash and
the `N` newest rows of `password_history`. Once a user has history the newest row
*is* the current password, so the window is "the last N, the current one
included"; the explicit current-hash check covers accounts from before this
change. A match answers **400**:

```json
{ "error": "password_reused", "messageKey": "auth.pw.reused", "messageParams": { "n": 5 },
  "message": "That password is one of your last 5 passwords. Choose a different one.",
  "details": { "newPassword": "…" } }
```

(`details.password` on the admin reset.) The dashboard says it in the user's
language from `messageKey`.

After the change the new hash is appended and the user's history is pruned to
`N` rows. `N = 0` turns the check off **and** prunes the history to nothing on
the next change — switching the control off does not keep old hashes around.
Recording is best-effort: the password has already changed, so a failed history
write is logged rather than reported as a failed change.

Cost: one bcrypt compare per remembered hash, so the cap of 24 also caps how long
a change can take.

## 2. Password max age

`users.password_changed_at` is stamped with `NOW()` by every repository write of
`password_hash` (create, update, one-time password set and clear). A row that has
never had it set (every account from before this change) counts from `created_at`.

- **At sign-in** a local user whose password is older than `passwordMaxAgeDays`
  still gets a token, and the response says `"passwordExpired": true`; the
  dashboard goes straight to the change-password screen.
- **On every request** `src/auth/securityGate.js` compares the token's `pwdAt`
  with the policy. Expired → **403** `{ "error": "password_expired" }` on every
  route except `/auth/change-password`, `/auth/login`, `/auth/sso`, `/me` and
  `/health` — the same set the one-time-password gate leaves open. No database
  read: the set time is in the token.
- Changing the password mints a token with a fresh `pwdAt`; the old tokens are
  revoked as before (`tokens_valid_after`).

Turning the max age on applies to the next request of every live local session.
A token minted before this release carries no `pwdAt` and is never treated as
expired; it ages out with the JWT lifetime.

## 3. Role-based IP allowlist

A role with a non-empty list may only be served from an address inside it; a
role with no list is unrestricted. Checked:

- **at sign-in** (local, LDAP, OIDC callback, SAML ACS) — only once the credential
  is known good, because the role is not known before. Local/LDAP answer **403**
  `{ "error": "ip_not_allowed" }` (no token); OIDC/SAML redirect with
  `?sso_error=ip-not-allowed`;
- **on every authenticated request** by the security gate (user JWTs and API
  tokens alike) → **403** `ip_not_allowed`; the dashboard signs the session out
  and the login screen says why;
- **on the dashboard WebSocket upgrade** (`/ws/dashboard`), which bypasses Express.

**The address** is `req.ip` — the app's own trust-proxy decision
(`TRUST_PROXY`, `src/app.js`). With it off (the default) the socket peer is the
client and any `X-Forwarded-For` header is ignored, so a client cannot talk its
way into the list. With it on, Express trusts exactly one hop: the address the
proxy appended (the last `X-Forwarded-For` entry), never the leftmost one a client
can forge. The WebSocket upgrade re-derives the same thing from the same switch
(`upgradeClientIp`). An IPv4 client on a dual-stack socket (`::ffff:10.0.0.1`)
matches an IPv4 list; an address that cannot be parsed matches nothing.

**Audit.** Every refusal is written to the hash-chained `audit_log`:
`login_ip_denied` (sign-in, outcome `denied`) or `ip_denied` (a request, outcome
`denied`, the method and path as the target). A token replayed from outside the
list would otherwise write one row per request into a table that is never
purged, so request denials are recorded once per principal + address per five
minutes. SSO refusals are also in the SSO sign-in audit on the Authentication tab.

**The lock-out guard.** `PUT /api/settings/security` refuses (**409**
`allowlist_excludes_you`, nothing saved, audited as `denied`) an admin list that
does not contain the address the saving admin is using, with a message that
names the address. Restricting the *other* roles is not a self lock-out and is
allowed. If every admin ends up outside the list anyway (a network change), see
[auth-lockout.md](auth-lockout.md) → "Locked out by the IP allowlist".

## Caching and failure behaviour

The policy is read on every authenticated request, so it is cached
(`createSecurityPolicy`, 5 s). A save on this instance applies to the very next
request; a save on another instance within 5 s. If the settings table cannot be
read the **last-known** policy stays in force — a database hiccup does not drop
the allowlist. Before the first successful read the defaults apply, which
restrict nothing by address.

## Where the code lives

| Piece | File |
| --- | --- |
| Pure rules, validation, cache | `src/auth/securityPolicy.js` |
| Request gate, WebSocket helpers | `src/auth/securityGate.js` (mounted in `src/routes/index.js`) |
| Password history service | `src/auth/passwordHistory.js` |
| History table access | `src/repositories/passwordHistoryRepository.js` |
| `password_changed_at` stamping | `src/repositories/usersRepository.js` |
| Sign-in / change-password | `src/routes/auth.js`; SSO callbacks `src/routes/oidc.js`, `src/routes/saml.js` |
| Admin reset / create | `src/routes/users.js` |
| Settings API + lock-out guard | `src/routes/authSecurity.js`; storage `src/services/settings.js` (`getSecurity`/`setSecurity`) |
| `pwdAt` claim | `src/auth/jwt.js` |
| Dashboard | `settingsAuthView` → `authSecuritySection` in `public/app.js`; change screen `#force-change`; keys `set.sec.*`, `auth.*` in `public/i18n.js` |
| Tests | `test/securityHardening.test.js` (unit + API), `test/settingsAuthPage.test.js` (jsdom) |
