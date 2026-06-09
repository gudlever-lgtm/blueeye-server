# External authentication (LDAP / Active Directory)

Adds LDAP/AD login as a **supplement** to the existing local JWT login. The same
code path serves Microsoft AD and OpenLDAP — only the configurable filters differ.
After a successful LDAP bind, BlueEye issues the **same JWT** as local login, so the
rest of the system sees no difference.

## Data model

| Table | Migration | Purpose |
| --- | --- | --- |
| `ldap_config` | 028 | single-row connection config (`host`, `port`, `use_tls`, `bind_dn`, `bind_pw_encrypted`, `base_dn`, `user_filter`, `group_filter`, `enabled`). |
| `ldap_role_map` | 028 | maps an LDAP group DN → a BlueEye role. |
| `ldap_login_audit` | 029 | one row per login attempt (username, ok, reason, granted role, groups matched, source IP). |

The bind password is encrypted with **AES-256-GCM** (`src/lib/secretBox.js`) — never
stored or returned in plaintext (mirrors the integration-credentials pattern).

## Login flow (`src/routes/auth.js` + `src/auth/ldap.js`)

`POST /auth/login { email, password }`:

1. **If LDAP is enabled** — `LDAP_AUTH_ENABLED=true` **and** a stored config with
   `enabled=true` — try it first:
   - service-bind (or anonymous) and search for the user by `user_filter`
     (`{{username}}` substituted, RFC 4515-escaped against injection);
   - re-bind **as the user** with the supplied password (the actual auth);
   - resolve the user's groups → the **highest** mapped role; **no mapped group ⇒
     access denied** (there is deliberately no default role);
   - on success, **just-in-time provision** (or role-realign) a local user — a
     protected super-admin is never demoted — and issue the JWT (`auth: "ldap"`).
2. **Otherwise / on any LDAP miss** — fall back to local JWT auth (unchanged).

Every LDAP attempt (success and failure) is written to `ldap_login_audit`. Local
login is never audited here, so existing behaviour is untouched.

### TLS

LDAPS is required: a plaintext bind (`use_tls=false`) to a **non-local** host is
refused — both when saving the config (validation) and again before any credential
leaves the process (`src/auth/ldap.js`). Loopback hosts may use plaintext (e.g. a
local stunnel sidecar). An empty password is rejected before binding (directories
treat it as an unauthenticated bind that "succeeds").

## Package

Binds via **[`ldapts`](https://github.com/ldapts/ldapts)** (MIT, maintained), which is
**lazily required** like the email channel's nodemailer — no hard dependency, and the
client factory is injected so tests never touch it.

## API (`/api/ldap`, admin only)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/ldap/config` | the env flag + **licence flag** (`licensed`) + stored config (safe; **no bind password**) + `bindPasswordSet` (so the UI can render a write-only password field). |
| `PUT` | `/api/ldap/config` | upsert config (bind password write-only; `clearBindPassword` to wipe). `400` invalid / plaintext-non-local; `403` when the licence lacks `sso_ldap`. |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/ldap/role-map[/:id]` | group→role CRUD. `409` duplicate group, `404` unknown. Reads are open; **writes** require `sso_ldap` (`403`). |
| `GET` | `/api/ldap/login-audit?limit=` | recent sign-in attempts (newest first, `limit` clamped 1–500) — for the dashboard's "Recent sign-ins" panel. Never carries a password. |
| `POST` | `/api/ldap/test` | bind with the service account to verify connectivity. `403` without `sso_ldap`. |

## Dashboard UI (**Settings → Authentication**, admin only)

`settingsAuthView` in `public/app.js` is the admin surface (grouped under
**Access & security** in the redesigned Settings nav):

- **Directory connection** — host/port/TLS, search-bind DN + write-only bind
  password, base DN, user/group filters, an *enable* switch, **Save** and a
  **Test connection** button (`POST /api/ldap/test`).
- **Group → role mapping** — add/change/delete rows mapping a group DN to a role.
- **Recent sign-ins** — the login-audit panel (success/failure + reason, granted
  role, groups matched, source IP), so an admin can confirm logins are flowing.

When the server wasn't started with `LDAP_AUTH_ENABLED=true` the tab shows an
"Inactive — server flag required" banner (settings are saved but not yet live).

## Licensing (`sso_ldap`, Enterprise)

Directory auth is a packaged plan feature — `sso_ldap` in `src/license/plans.js`
(label *"LDAP / Active Directory auth"*), granted from the **Enterprise** tier
(alongside `sso_oidc`/`sso_saml`). It is enforced in two places:

- **Server-side login** — `createLdapAuth({ featureGate })`: `isEnabled()` /
  `authenticate()` return "off" when the licence lacks `sso_ldap`, so an expired
  licence safely **falls back to local auth** rather than locking everyone out.
- **Config API** — every mutation + the connectivity test require `sso_ldap`
  (`requireFeature`, `403 { reason:'license' }`); reads stay open so an admin can
  still inspect state. The feature shows in **Settings → License**'s matrix.

## Configuration

`LDAP_AUTH_ENABLED` (default `false`) is the only env var — everything else is
runtime config in the DB. The bind password is encrypted with
`SECRET_ENCRYPTION_KEY` (see `.env.example`). Directory login is live only when
**all three** hold: the env flag is on, the licence includes `sso_ldap`, and an
admin has stored a config with `enabled=true`.

## Tests

`test/ldapAuth.test.js` (bind success/fail, group hit/miss, role precedence, TLS
enforcement, disabled fallback, injection escaping, ldapts-unavailable, **licence
gate → off + local fallback**), `test/ldapApi.test.js` (config + role-map CRUD
400/401/403/404/409/500, bind-password redaction, **`licensed`/`bindPasswordSet`
flags**, **`sso_ldap` write gate → 403**, **login-audit**), `test/authLdap.test.js`
(login via LDAP, JIT provisioning, role realign, local fallback, audit). The LDAP
client is injected — no real directory in tests.
