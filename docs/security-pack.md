# Security pack (Enterprise)

The **security pack** (`security_pack`, Enterprise) bundles four enforced
authentication-hardening controls. Everything is **opt-in** (each control has its
own `enabled` flag, off by default) and **licence-gated**: enforcement only
activates when the signed licence includes `security_pack` *and* the control is
enabled in **Settings → Security** (`PUT /api/settings/security`). A server
without the entitlement behaves exactly as before.

Pure rules live in `src/security/` (no I/O, unit-tested in isolation); the glue
to config, the licence gate and persistence is `src/security/securityService.js`,
wired into the auth/user/me/settings routes.

| Control | Enforced where | Response on violation |
| --- | --- | --- |
| Password policy | `routes/users.js` (create/update), `routes/me.js` (self-change) | **422** `{ reason: 'password_policy', violations }` |
| Brute-force lockout | `routes/auth.js` (login) | **429** + `Retry-After` |
| IP allowlist | `routes/auth.js` (after auth, before token) | **403** `{ reason: 'ip_not_allowlisted' }` |
| Tamper-evident audit | `repositories/auditLogRepository.js` | `GET /api/audit-log/verify` → `{ ok, brokenAt }` |

The status codes are deliberately distinct from the generic ones (400 malformed
input, 401 bad credentials) so the audit log and clients can tell *why* a login
or change was refused.

## 1. Password policy (`security.passwordPolicy`)

`src/security/passwordPolicy.js` — minimum length, character-class requirements,
reuse-of-the-last-N history and max age.

- **Validated at creation and change.** `POST /users`, `PUT /users/:id` (admin
  reset) and `PUT /me/password` (self-service) run the candidate through the
  policy. Base input validation (≥ 8 chars) still returns **400**; a *policy*
  violation returns **422** with a `violations[]` list of `{ code, message }`.
- **History.** Past hashes are archived in `password_history` on every change;
  `recentPasswordHashes` returns the current + last N hashes so a reuse is
  rejected (`code: 'reuse'`). Only bcrypt hashes are stored — never plaintext.
- **Max age.** `users.password_changed_at` is stamped on each change. At login the
  response carries `passwordExpired: true` when the password is older than
  `maxAgeDays` (non-blocking — the user can still sign in to change it).

Fields: `enabled, minLength (8–72), requireUppercase, requireLowercase,
requireDigit, requireSymbol, historyCount (0–50), maxAgeDays (0–3650)`.

## 2. Brute-force lockout (`security.lockout`)

`src/security/lockout.js` + `repositories/authLockoutRepository.js` — counts
failed logins **per user (email)** and **per source IP** in the `auth_lockouts`
table. After `maxAttempts` failures within `windowSeconds`, the principal is
locked with **exponential backoff** (`baseBackoffSeconds`, doubling, capped at
`maxBackoffSeconds`). While locked, login returns **429** (with `Retry-After`)
*before* any credential check — so a lockout is distinguishable from a wrong
password in the audit log (`login_locked` vs `login_failure`). A successful login
clears both counters.

## 3. IP allowlist (`security.ipAllowlist`)

`src/security/ipAllowlist.js` — per-role CIDR allowlisting (IPv4 + IPv6), a
natural companion to LDAP/AD RBAC. The effective allowlist for a user is
`global ∪ roles[userRole]`; if that combined list is non-empty and the source IP
is not in it, login is refused with **403** (`ip_not_allowlisted`) *after* the
credentials check but before a token is issued. An empty effective list means
"no restriction for this principal" → allowed. The source IP honours
`X-Forwarded-For` via Express `trust proxy`.

## 4. Tamper-evident audit retention (`security.audit`)

`repositories/auditLogRepository.js` — every `audit_log` row is **hash-chained**:
`entry_hash = sha256(prev_hash || canonical(fields))` (migration 037 adds
`prev_hash` + `entry_hash`). Altering or removing any row breaks the chain.
`GET /api/audit-log/verify` (admin, gated `audit_log`) walks the chain and
returns `{ ok, checked, brokenAt }`, so the append-only retention requirement can
be evidenced for NIS2 reporting. Rows written before the migration have NULL
hashes and are skipped (the chain anchors at the first hashed row).

## Config & wiring

- Settings: `settingsService.getSecurity()/setSecurity()` (`app_settings` key
  `security`); HTTP `GET/PUT /api/settings/security` (admin; writes gated
  `security_pack`). `GET` reports a `licensed` flag so the UI can show
  enforcement as active vs. config-only.
- Construction: `createSecurityService({ settingsService, featureGate, usersRepo,
  lockoutRepo })` in `src/server.js`, injected into the auth/users/me routers.
- Tests: `test/securityUnit.test.js` (pure rules), `test/securityPack.test.js`
  (route enforcement), `test/auditChain.test.js` (hash chain),
  `test/usersRepository.test.js` (history). Fakes: `makeAuthLockoutRepo`, the
  `security` seed on `makeSettingsService`, `verifyChain` on `makeAuditLogRepo`.
