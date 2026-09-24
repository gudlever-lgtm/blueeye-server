# Directory outages and the fail-closed SSO guard

**Short answer: a directory outage cannot lock an administrator out of BlueEyes.**
Sign-in does not consult the guard that fails closed, and the guard only ever sits
on endpoints that already require a signed-in admin. This page shows why that
holds, what an operator actually sees when the directory breaks, and the ways back
in — in the order you should try them.

It also names the one change that *would* create a real lockout, so nobody makes
it by accident.

> **Operators want the in-app version.** The same guidance — what still works,
> and the four ways back in — is in the dashboard under **Documentation →
> Administration & setup → "Directory logins stopped working"** (`/docs/auth-lockout`,
> admin-only, en/da). Settings → Users links straight to it when the check cannot
> be answered. This page is the engineering account of *why* it holds.

## What "fails closed" means here

`ssoOrLdapActive()` in `src/routes/users.js` answers one question: *is any
federated sign-in method (LDAP/AD, OIDC, SAML) live on this install?* Local user
creation with an emailed one-time password is refused while one is, because a
local password account behind a live directory is a bypass of it.

It used to swallow an error from a provider check and answer **"no SSO here"**.
That is the dangerous direction: on the one install where something was already
broken, it silently re-enabled the bypass it exists to prevent. It now answers
**"possibly active"** and the caller refuses with a reason:

```
403  Local user creation is refused: could not determine whether LDAP/AD
     sign-in is active. Fix the LDAP/AD configuration, or disable it, and
     try again.
```

That is the safe direction, and it is also the shape of change that strands
people — the directory breaks, and the tool you would use to get back in is the
tool that just locked itself. It does not happen here, for structural reasons
rather than luck.

## Why it cannot lock you out

**1. Sign-in never asks the guard.** `POST /auth/login` has its own LDAP check
(`src/routes/auth.js`), and that one deliberately fails **open**: if
`isEnabled()` throws, or the bind fails, or the directory is unreachable, it
falls through to local password auth. A broken directory degrades to local
sign-in; it never refuses it.

**2. The guard is only on already-authenticated routes.** All three endpoints it
gates sit behind `requireAuth` + `requireRole(ADMIN)`. To be refused by it you
must already be signed in as an admin — so by the time you can hit the closed
path, you are not locked out.

**3. There is always a way to create an account.** `POST /users` is not gated.
See below.

## What the guard covers, and what it does not

| Endpoint | Gated? | Why |
| --- | --- | --- |
| `POST /auth/login` | **no** | sign-in must survive a directory outage; falls back to local auth |
| `POST /users` | **no** | admin types a password and hands it over out of band — no mail server needed. **This is the recovery path.** |
| `POST /users/local` | yes → 403 | server generates and **emails** a one-time password; the self-service flow that would quietly grow local accounts behind a live directory |
| `POST /users/:id/resend-temp-password` | yes → 403 | same flow, same reason |
| `GET /users/local-availability` | reports | answers **200** with `ssoActive` / `ssoMethod` / `ssoIndeterminate` so the UI can explain itself rather than showing a dead control |

Be clear about what this means: the guard stops the **emailed one-time password**
flow, not all local account creation. An admin on an SSO install can still create
a local password account through **New user**, and the dashboard always offers
that button — only **Invite** is conditional (`public/views/users.js`). The code
comment describing the guard as preventing local accounts generally overstates
what is enforced.

That gap is what keeps the fail-closed change safe. Closing it without first
building a replacement break-glass path converts a rare, readable 403 into a
genuine lockout.

## How rare is the indeterminate state?

Rarer than it sounds, which is worth knowing before you go hunting for it:

- **The LDAP server being down does not trigger it.** `isEnabled()` reads the
  *stored config* (a database row), not the directory. An unreachable domain
  controller breaks `authenticate()`, not `isEnabled()`.
- **A database failure does not trigger it either.** `isEnabled()` catches its own
  repository error, logs it, and returns `false` (see `src/auth/ldap.js`).
- **OIDC and SAML `isEnabled()` are synchronous and in-memory** — config plus a
  licence check, no I/O.

What is left is a licence-layer failure (`featureGate.isFeatureEnabled` /
`licenseManager` throwing) or a provider object that is broken outright. So the
fail-closed branch is a safety net for a rare state, not an everyday path. The
everyday LDAP failure is a bind failure, which has always fallen back to local
login and still does.

## What the operator sees when the directory breaks

| What broke | Directory logins | Local logins | Local invite | Where it says so |
| --- | --- | --- | --- | --- |
| DC unreachable / bind fails | fail | **work** | offered (SSO still "on") | `ldap_login_audit`, Settings → Authentication → Test |
| Config row unreadable | fail | **work** | offered (reads as disabled) | server log: `ldap: could not read the directory config …` |
| Licence/provider check throws | fail | **work** | **403, indeterminate** | server log: `users: could not determine whether LDAP/AD sign-in is active …` |
| LDAP disabled by an admin | n/a | **work** | offered | Settings → Authentication |
| Admin's address outside the admin IP allowlist | n/a | **refused (403 `ip_not_allowed`)** | n/a | `audit_log` `login_ip_denied`; step 3a below |

The row that matters: **local logins work in every directory failure.** The last
row is not a directory failure — it is a policy the admin set on purpose.

## Getting back in

Try these in order. Most incidents end at step 1.

**1. Sign in with a local account.** Any local admin still works while the
directory is down. This is the normal answer.

**2. Create an account from the dashboard.** *Settings → Users → **New user***
(`POST /users`) — type a password and hand it over out of band. Not gated, works
with SSO active or indeterminate, needs no mail server.

**3. Turn the directory off so the guard opens.** *Settings → Authentication* →
clear `enabled`, or set `LDAP_AUTH_ENABLED=false` and restart. The invite flow
comes back and the 403 goes away. Fix the directory, then switch it back on.

**3a. Locked out by the IP allowlist.** The one rule local accounts are under
too is the role-based IP allowlist (*Settings → Authentication → Security*,
[security-hardening.md](security-hardening.md)). The dashboard refuses to save an
admin list that excludes the saving admin's own address, but a network change
(a new NAT address, a proxy that stops sending `X-Forwarded-For`) can still leave
every admin outside it. Sign in from an allowed address; failing that, clear the
policy in the database (shell access) — it is read again within seconds:

```sql
UPDATE app_settings
   SET value = JSON_SET(value, '$.ipAllowlist.admin', JSON_ARRAY())
 WHERE setting_key = 'security';
```

**4. Break glass (needs shell + database access).** If no local admin exists at
all:

```sh
SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD='<a strong one>' \
  node scripts/seed-superadmin.js
```

This upserts a **protected** admin — always admin, cannot be demoted or deleted
through the API, password-change only. Re-running resets the password.

> **Set `SUPERADMIN_PASSWORD` explicitly.** The script falls back to a hardcoded
> default when it is unset. Running it bare on a reachable install leaves a
> protected admin with a publicly-known password. Change it immediately if that
> has already happened.

`src/migrate.js` also seeds an initial admin when the `users` table has none,
generating a strong password and printing it **once** — check the deploy log
before assuming an install has no way in.

## The change that would break this

Putting `ssoOrLdapActive()` on `POST /users` would close the documented gap above
and create the lockout: directory indeterminate → guard closed → no way to make an
account → a server only recoverable with shell access.

If that gap is ever worth closing, build the replacement first. In rough order of
preference:

1. **Exempt the protected super-admin.** The `protected` flag already marks an
   account the API cannot demote or delete; let it create local accounts
   regardless of SSO state. Smallest change, keeps one guaranteed way in.
2. **A break-glass mode with a trail.** Allow the create, mark the account as
   created during an SSO-indeterminate window, and raise an audit event plus a
   dashboard banner so it cannot happen quietly.
3. **Fail closed only when the answer is genuinely unknown, not when SSO is
   merely on.** Distinguishing the two is already in the response
   (`ssoIndeterminate`); the policy could follow.

What it should *not* do is gate the route and rely on `scripts/seed-superadmin.js`
as the recovery story. That needs shell and database access on the host, which is
exactly what the admin locked out of the dashboard may not have.

## Tests

`test/ldapLockoutSafety.test.js` pins all four properties — sign-in surviving a
throwing or unreachable directory, the guard answering 403/200 rather than 500,
`POST /users` staying open as the way back in (and the account it makes being able
to sign in), and an install with no SSO wired being unable to reach the closed
path at all. If somebody gates `POST /users`, that file fails first.

`test/userLocalCreation.test.js` pins the closed behaviour itself — that a
throwing provider refuses rather than allows, and that the refusal names the
method and what to do about it.

`test/usersPage.test.js` pins the screen telling the two cases apart: an
unanswerable check is a **warning** that names the method, says local sign-in is
unaffected and links the article; a genuine "SSO is on" stays the calm info note.
`test/docsPage.test.js` opens every article, so the new one cannot ship broken.

## Where the code lives

| Piece | File |
| --- | --- |
| The guard | `src/routes/users.js` (`ssoOrLdapActive`) |
| Login fallback (fails **open**, by design) | `src/routes/auth.js` |
| LDAP enable check + config-read logging | `src/auth/ldap.js` (`isEnabled`) |
| OIDC / SAML enable checks (sync, in-memory) | `src/auth/oidc.js`, `src/auth/saml.js` |
| Licence gate that can throw | `src/license/features.js`, `src/license/planService.js` |
| Which buttons the UI shows, and the indeterminate note | `public/views/users.js` |
| In-app article (`/docs/auth-lockout`) | `DOCS` in `public/app.js`, `docs.lockout.*` keys in `public/i18n.js`, id in `public/routes.js` |
| Break-glass admin | `scripts/seed-superadmin.js`, `src/migrate.js` (`seedAdminIfNeeded`) |

See also [ldap-auth.md](ldap-auth.md), [sso-oidc.md](sso-oidc.md),
[sso-saml.md](sso-saml.md) and [user-local-otp.md](user-local-otp.md).
