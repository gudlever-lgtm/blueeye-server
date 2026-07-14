# Documentation centre (built-in handbook)

The **Documentation** tab (`views.docs`, nav item under *Diagnostics*) is an
in-app handbook: step-by-step troubleshooting how-tos with worked examples for
everyone, plus admin-only setup guides for the external systems BlueEye connects
to (ServiceNow ITSM/CMDB, alerting, SSO/LDAP, enrollment, retention).

It is intentionally **static, dependency-free content** — the same style as the
`PAGE_INFO` help drawers — so it needs no backend, no database and no build step,
and it versions with the dashboard.

## Where it lives

- `public/index.html` — nav button `data-view="docs"` in the *Diagnostics* group.
  No `data-min-role`, so the tab itself is visible to every role.
- `public/app.js`:
  - `views.docs` — renders a two-pane browser (grouped topic rail on the left,
    the selected article on the right). Mirrors the Settings nav (`.settings-nav`).
  - `DOCS` — the content array. Each **section** is
    `{ section, admin, articles: [{ id, title, body: () => [nodes] }] }`.
  - `docsLead` / `docsCode` / `docsSteps` / `docsExpect` / `docsTable` — small
    DOM-builder helpers used by the article bodies.
  - `docsTopic` — module-level state for the selected article id.
  - `PAGE_INFO.docs` — the page hero + *More info* drawer.
- `public/styles.css` — `.docs-*` block (article column, code blocks, tables).

## RBAC (admin has full access)

Sections carry an `admin` flag. `views.docs` filters the array with
`DOCS.filter((s) => !s.admin || isAdmin())` before rendering, so:

- **Getting started** and **Troubleshooting how-tos** — `admin: false`, shown to
  everyone (viewer+).
- **Administration & setup** — `admin: true`, shown to admins only. This is where
  the connector/setup guides live (e.g. *Connect ServiceNow*, which documents the
  required credentials/role, the idempotent create/update behaviour, and the exact
  success/error responses to expect).

Cross-links inside articles use `viewLink` / `settingsLink`, which already degrade
to plain text when the target page is hidden by role or licence — so an article
never links a non-admin into a dead end.

## Adding or editing an article

1. Find the right section in `DOCS` (or add a new section object; set `admin`).
2. Append an article `{ id, title, body }`. Give it a stable, unique `id`
   (used for selection state) and build the `body` with `el(...)` and the
   `docs*` helpers. Prefer `viewLink`/`settingsLink` over hard-coded prose for
   any reference to another page or Settings tab.
3. Bump `package.json` version (`npm version patch|minor --no-git-tag-version`).

No tests are required — the content is static client-side DOM with no backend
surface (the `node --test` suite covers `src/**` and `test/**` only).
