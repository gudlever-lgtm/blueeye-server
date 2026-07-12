# SSO — OpenID Connect (OIDC)

BlueEye supports **single sign-on via OpenID Connect** (authorization-code flow
with **PKCE**) as a supplement to local login. It is a **Professional** capability,
gated behind the licence feature key **`sso_oidc`**. Local username/password login
always remains available as the fallback.

The implementation is **hand-rolled** — no US SSO SDK. Discovery and the token
exchange use the platform `fetch`; the id-token signature is verified with Node's
own crypto (JWK → `KeyObject`) plus `jsonwebtoken`. Any **EU / self-hosted** IdP
that speaks standard OIDC works: Keycloak, Authentik, Zitadel, Kanidm, …

## How it works

1. The login screen calls `GET /auth/sso`; if OIDC is live it shows a
   **Sign in with SSO (OIDC)** button linking to `/auth/oidc/login`.
2. `GET /auth/oidc/login` discovers the IdP (`.well-known/openid-configuration`),
   mints a `state`, `nonce` and PKCE `code_verifier`/`code_challenge`, stashes the
   first three in a short-lived **signed, HttpOnly cookie**, and 302-redirects the
   browser to the IdP's authorization endpoint.
3. The IdP authenticates the user and redirects back to
   `GET /auth/oidc/callback?code=…&state=…`.
4. The callback verifies the cookie + `state` (CSRF guard), exchanges the code at
   the token endpoint (PKCE proof; client secret if configured), and **verifies
   the id-token**: JWKS signature, `iss`, `aud` (= client id), `exp`, and the
   `nonce`. The signing algorithm is pinned to the asymmetric set (RS*/PS*/ES*) —
   `none`/HS* are rejected to prevent algorithm-confusion attacks.
5. The user's groups (the `OIDC_ROLE_CLAIM`, default `groups`) are matched against
   the **role map** (`oidc_role_map`); the **highest** matching BlueEye role wins
   (admin > operator > viewer). **No match ⇒ access denied** — there is no default
   role.
6. A local user is **just-in-time provisioned** (same shared provisioner as
   LDAP/SAML), a normal BlueEye JWT is issued, and the browser is redirected back
   with the token in the URL **fragment** (never logged server-side).

## Configuration (environment variables)

| Variable | Required | Meaning |
| --- | --- | --- |
| `OIDC_AUTH_ENABLED` | yes | Hard on/off gate (`true`/`1`/`yes`/`on`). Default off. |
| `OIDC_ISSUER` | yes | IdP issuer URL, e.g. `https://id.acme.dk/realms/blueeye`. |
| `OIDC_CLIENT_ID` | yes | The client registered at the IdP. |
| `OIDC_CLIENT_SECRET` | no | Set for a confidential client; omit for a public PKCE client. |
| `OIDC_REDIRECT_URI` | yes | Must equal `<public-url>/auth/oidc/callback` and be registered at the IdP. |
| `OIDC_SCOPES` | no | Default `openid email profile`. |
| `OIDC_ROLE_CLAIM` | no | The id-token claim carrying groups/roles. Default `groups`. |

OIDC is only **enabled** when the env flag is on, the licence covers `sso_oidc`,
**and** issuer + client id + redirect are configured.

## Mapping claims to roles

Group→role mapping is admin-managed in the DB (`oidc_role_map`) via the
licence-gated admin API:

- `GET  /api/oidc/config` — env/licence/configured status + the (non-secret)
  issuer/client/redirect (admin).
- `GET  /api/oidc/role-map` — list mappings (admin).
- `POST /api/oidc/role-map` `{ claimValue, role }` — add a mapping (gated).
- `PUT  /api/oidc/role-map/:id`, `DELETE /api/oidc/role-map/:id` — edit/remove (gated).
- `GET  /api/oidc/login-audit` — recent SSO sign-in attempts (admin).
- `POST /api/oidc/test` — verify the issuer's discovery document is reachable (gated).

Every login attempt is recorded in `sso_login_audit` (shared with SAML) —
subject, outcome, reason, granted role, groups matched, source IP. **No tokens or
secrets are ever stored.**
