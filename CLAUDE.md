# CLAUDE.md — blueeye-server

On-prem network‑monitoring + central‑licensing server (Node.js + Express + MySQL).

## Start here: the code map

**[CODEMAP.md](CODEMAP.md)** is the navigation aid — boot flow, directory map, the
full HTTP route table, the data model, the dashboard structure, and a
"where do I change X?" index. Read it before making changes.

## Conventions (must follow)

- **CommonJS only** — `require`/`module.exports`. **Not** TypeScript, **not** ESM.
  No build step (the dashboard in `public/` is dependency‑free vanilla JS + hand‑written CSS).
- **No US‑based vendors/SDKs** — map tiles, GeoIP/ASN, geocoder and fonts must be
  European or self‑hosted.
- **Privacy by design** — metadata only (ports/ASN/timings/5‑tuple), never payload/DPI;
  RFC1918/private addresses are never geolocated.
- **Analysis is local + explainable** — robust statistics (median + MAD z‑score), no ML
  libraries, no cloud. Every finding/result carries an explanation + evidence.
- **Dependency injection everywhere** — `createX(deps)` factories; `src/server.js` wires
  the real MySQL pool, tests wire fakes from `test-support/fakes.js`.
- **Version every change** — bump `package.json` `version` on each update (patch = fix,
  minor = feature, major = breaking), and bump the agent in lockstep when its code
  changes. The dashboard's **Settings → Updates** panel and the per‑agent "update" badge
  read these versions, so the bump is what makes "update available" appear. Use
  `npm version <patch|minor> --no-git-tag-version` (don't hand‑edit; it keeps
  `package-lock.json` in sync). Tags aren't pushed from CI here — the version field is
  the source of truth. `npm version` also runs the `version` hook
  (`scripts/stamp-release-date.js`), which stamps `package.json` `releaseDate` with
  today's date — the dashboard footer shows `BlueEye server · v<version> · <releaseDate>`
  (served by `GET /system/version`), so don't hand‑edit the date; let the bump set it.

## Working in this repo

- Run tests: `npm test` (`node --test`; auto-discovers `test/**` and `src/**/__tests__`).
  Test Express endpoints for 400/401/403/404/500; mock outbound calls (LLM/SMTP/geocoder).
- DB: numbered `migrations/NNN_*.sql` (tracked in `schema_migrations`), run `npm run migrate`.
- Adding a feature usually means: a router in `src/routes/` (mounted in `routes/index.js`),
  a repository in `src/repositories/`, validation in `src/validation/`, a dashboard
  `views.<tab>` in `public/app.js` (+ a `data-view` button in `public/index.html`), a
  `PAGE_INFO` help entry, and tests + a fake in `test-support/fakes.js`.
- Per-feature docs live in `docs/` (analysis, geo, alerting, retention, traffic-types, …).

## ai-codex (AI codebase index)

- [`ai-codex`](https://github.com/skibidiskib/ai-codex) generates a compact, token-cheap
  `.ai-codex/` index for AI assistants. Run it with `npm run codex` (wraps
  `npx ai-codex`); defaults come from `codex.config.json`.
- **Status: currently a no-op here.** ai-codex only reads ESM `export`/TypeScript,
  Next.js/SvelteKit routing, and Prisma/Drizzle schemas. This repo is CommonJS + vanilla
  JS + raw `schema.sql` (see conventions above), so every generator is skipped and
  `.ai-codex/` comes out empty. **Rely on [CODEMAP.md](CODEMAP.md)** for navigation — it
  hand-covers what ai-codex would auto-generate. The `codex` script + config are kept
  wired up so the index starts producing output if the stack ever adopts TS/Prisma.

## Sister repos

- **blueeye-agent** — runs on customer machines; reports traffic/system/flows/probes.
  Agent-side data changes (e.g. probes, interface errors/discards) require redeploying
  agents (`git pull && ./install.sh`); keep the server backward‑compatible.
- **blueeye-licens** — signs Ed25519 license proofs that `src/license/` verifies offline.
