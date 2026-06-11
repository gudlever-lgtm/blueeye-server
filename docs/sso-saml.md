# SSO — SAML 2.0

BlueEye supports **SP-initiated SAML 2.0 single sign-on** as a supplement to local
login. It is an **Enterprise** capability, gated behind the licence feature key
**`sso_saml`**. Local username/password login always remains as the fallback.

Signature and assertion validation are **hand-rolled** — no US SDK and no XML
library. `src/auth/samlXml.js` implements a small namespace-aware XML parser,
**exclusive canonicalization** (exc-c14n) and the slice of **XML-DSig** that SAML
IdPs emit (a single enveloped signature, exc-c14n transform, RSA-SHA256/SHA1).
Any IdP that signs assertions works: Keycloak, SimpleSAMLphp, Authentik, ADFS, …

## How it works

1. The login screen calls `GET /auth/sso`; if SAML is live it shows a
   **Sign in with SSO (SAML)** button linking to `/auth/saml/login`.
2. `GET /auth/saml/login` builds a SAML **AuthnRequest**, DEFLATE+base64-encodes
   it (HTTP-Redirect binding), stashes the request ID in a short-lived signed
   HttpOnly cookie and 302-redirects the browser to the IdP.
3. The IdP authenticates the user and **POSTs** a `SAMLResponse` back to the ACS
   (`POST /auth/saml/callback`, HTTP-POST binding).
4. The ACS verifies, in order:
   - **Signature** — exc-c14n + RSA signature against the configured IdP cert,
     and the referenced element's **digest**. Only the element that was actually
     digested + signed is trusted (defeats signature-wrapping / XSW).
   - **Issuer** equals the configured IdP entityID (when set).
   - **Conditions** — `NotBefore`/`NotOnOrAfter` within a 5-minute clock-skew.
   - **AudienceRestriction** lists this SP's entityID (the audience).
   - **SubjectConfirmationData** `NotOnOrAfter` not expired; `InResponseTo`
     matches the AuthnRequest we issued (when present).
5. The `NameID` becomes the email; the configured role attribute's values
   (`SAML_ROLE_ATTRIBUTE`, default `groups`) are matched against the **role map**
   (`saml_role_map`); the **highest** matching BlueEye role wins. **No match ⇒
   access denied** — there is no default role.
6. A local user is **just-in-time provisioned** (shared with LDAP/OIDC), a normal
   BlueEye JWT is issued, and the browser is redirected back with the token in the
   URL fragment.

## Configuration (environment variables)

| Variable | Required | Meaning |
| --- | --- | --- |
| `SAML_AUTH_ENABLED` | yes | Hard on/off gate. Default off. |
| `SAML_ENTRY_POINT` | yes | IdP SSO URL (HTTP-Redirect binding). |
| `SAML_SP_ENTITY_ID` | yes | This SP's entityID (also the AuthnRequest issuer). |
| `SAML_AUDIENCE` | no | Expected assertion audience. Defaults to the SP entityID. |
| `SAML_IDP_ENTITY_ID` | no | Expected assertion `<Issuer>`; blank skips the check. |
| `SAML_IDP_CERT` | yes | The IdP's X.509 signing certificate (PEM or bare base64). |
| `SAML_CALLBACK_URL` | yes | The ACS URL = `<public-url>/auth/saml/callback`. |
| `SAML_ROLE_ATTRIBUTE` | no | Attribute carrying groups/roles. Default `groups`. |

SAML is only **enabled** when the env flag is on, the licence covers `sso_saml`
**and** entry point + SP entityID + IdP cert are configured. SP metadata for the
IdP admin is served at `GET /auth/saml/metadata`.

## Mapping attributes to roles

Attribute→role mapping is admin-managed in the DB (`saml_role_map`) via the
licence-gated admin API, mirroring OIDC:

- `GET /api/saml/config` — env/licence/configured status (admin).
- `GET /api/saml/role-map` — list (admin); `POST`/`PUT`/`DELETE` — gated mutations.
- `GET /api/saml/login-audit` — recent SSO sign-in attempts (admin).

Every login attempt is recorded in `sso_login_audit` (shared with OIDC). **No
assertions or secrets are ever stored.**

## Security notes / limitations

- The verifier requires a **signed assertion** (or a signed response wrapping the
  assertion) and trusts only the digested element.
- Exclusive c14n is implemented for the common SAML shape; for maximum interop set
  the IdP to sign **assertions** with exc-c14n + RSA-SHA256.
- AuthnRequests are **unsigned** (`WantAuthnRequestsSigned=false`); security rests
  on assertion signature + audience + replay window, which is the standard SP posture.
