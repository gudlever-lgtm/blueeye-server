# Pre-build gate — security / UI / validation tests

Every branch build of BlueEyes passes a gate before it exists. The same gate
lives in all three repos (`blueeye-server`, `blueeye-agent`, `blueeye-licens`):
`scripts/gate.sh` runs three sweep suites in `test/gate/` and then the full
`npm test`, and exits non-zero if anything fails.

```
[gate] blueeye-server v0.116.0 — security / ui / validation gate
[gate] ▶ security:   node --test test/gate/security.test.js
[gate] ▶ ui:         node --test test/gate/ui.test.js
[gate] ▶ validation: node --test test/gate/validation.test.js
[gate] ▶ full suite: npm test --silent
[gate] PASS — blueeye-server v0.116.0 may be built (58s)
```

## Where it runs

| Trigger | Mechanism | On failure |
| --- | --- | --- |
| Claude Code runs `git push` | `.claude/settings.json` → `PreToolUse` hook (matcher `Bash`) → `.claude/hooks/pre-push-gate.sh` | exit 2: the push is blocked and the failing output is fed back to Claude, which fixes the tests before a branch build is created |
| Anyone runs `git push` | `.githooks/pre-push` (activated by the SessionStart hook via `core.hooksPath`) | push refused |
| Branch push / pull request on GitHub | `.github/workflows/gate.yml` | red check |

All three call the same script, so the rule is the same everywhere.

The result is cached in `.git/blueeye-gate.stamp` keyed on `HEAD` plus a hash
of the worktree state (status + diff), so a push right after a green run is
instant and the git hook does not re-run what the Claude hook just ran.
`scripts/gate.sh --force` ignores the cache. `BLUEEYE_SKIP_GATE=1` skips the
gate entirely — emergency only; it prints a loud warning and must never be
used for a build that ships.

## What the suites sweep (server)

The suites deliberately enumerate the surface instead of listing features, so
a new route/validator/view is covered the moment it exists — and the gate says
what to extend when the new thing needs a deliberate decision.

**`test/gate/security.test.js`** — walks every route registered on the Express
app (`test/gate/_routes.js`) and asserts:

- the unauthenticated surface is *exactly* `PUBLIC_ROUTES` (health, login, SSO
  flows, enrollment downloads, `POST /agents/enroll`); everything else is 401
  without a token and for foreign-secret, `alg=none`, expired and garbage tokens;
- a user JWT is never accepted as an agent token and vice versa;
- viewers may write only to `VIEWER_WRITE_ALLOWED`; operators never reach the
  admin-only administration routes; a `mustChangePassword` token is locked to
  the password-change routes;
- a missing id is 404 on every GET/DELETE with an id; a hostile id never 500s;
- 500s are generic (no message, no stack) in production; 404s are JSON;
- malformed JSON → 400, > 1 MB → 413, non-object bodies never 500;
- login: 400 on missing fields, indistinguishable 401s, 429 lockout after five
  failures (also for the correct password), no hash in the response;
- static serving cannot escape `public/`, dotfiles / `schema.sql` /
  `package.json` are not served;
- security headers + CSP keep `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`, no inline/eval scripts;
- weak JWT secrets are flagged and refused in production; no private key or
  vendor token is committed; `.env` is ignored and `.env.example` has placeholders.

**`test/gate/ui.test.js`** — the dashboard has no build step, so:

- every `public/*.js` parses as a classic script; every `*.css` is balanced;
- `index.html` references only local assets that exist and are served, plus
  the CSP-allowed Leaflet CDN; no inline scripts or `on*` handlers;
- every `data-view` button has a `views.<tab>` handler and a `PAGE_INFO` entry;
  `data-min-role` / `data-feature` values are known;
- every `t('key')` exists in **both** locales, catalogues are in parity, and
  placeholders match; every `api('/…')` path is mounted in `src/routes/index.js`;
- the real dashboard boots in jsdom against a fake `fetch`: login screen,
  failed login message, session boot per role with role-gated navigation, 401
  teardown, and server-supplied strings never parsed as HTML.

**`test/gate/validation.test.js`**:

- every exported function in `src/validation/*` survives garbage (undefined,
  null, strings, numbers, arrays, functions, symbols, null-prototype objects,
  100 kB strings) and rejects `{}` where it has required fields;
- the per-module rules are pinned (users, locations, enrollment codes, probe
  specs, test packages, transactions, events, API tokens, preferences, time
  ranges, thresholds, agent monitor config, integrations, CMDB, LDAP/OIDC/SAML
  role maps, NIS2);
- the HTTP layer: no POST/PUT/PATCH route 500s on empty, non-object or
  prototype-polluting bodies; create endpoints answer `{ error: 'Validation
  failed', details }`; hostile query params never 500; agent ingest validates
  once the agent token is accepted; `schema.sql` matches the migration chain.

The agent's suites cover the same three categories for its surface (signed
commands, token perms, cert pinning, same-host-only redirects, curl/regex
hardening, allowlists, signed self-update; the CLI, doctor report and shipped
scripts; config coercion, probe targets and command recognisers). The licence
server's suites mirror the server's for its API and dashboard.

## Extending the gate

- **New route** → the security sweep fails if it is reachable without a token
  or writable by a viewer: add it to `PUBLIC_ROUTES` / `VIEWER_WRITE_ALLOWED`
  only if that is intended.
- **New nav view** → add `views.<tab>` and a `PAGE_INFO` entry (i18n-backed).
- **New UI text** → `t('key')` with the key in both catalogues.
- **New validator** → export it from `src/validation`; if `{}` is a valid input,
  list it in `ACCEPTS_EMPTY`; add a per-module rule.
- **Version** — bump `package.json` as usual; the gate prints the version it
  approved.
