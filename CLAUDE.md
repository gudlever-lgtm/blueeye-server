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
- **New UI text goes through the translation layer** — `t('some.key')` via
  `public/i18n.js` (en/da). The pre-existing screens are still hardcoded English and
  migrate opportunistically; don't add new hardcoded strings. Add keys to BOTH
  catalogues (a parity test enforces it, including placeholder parity).
- **Version every change** — bump `package.json` `version` on each update (patch = fix,
  minor = feature, major = breaking), and bump the agent in lockstep when its code
  changes. The dashboard's **Settings → Updates** panel and the per‑agent "update" badge
  read these versions, so the bump is what makes "update available" appear. Use
  `npm version <patch|minor> --no-git-tag-version` (don't hand‑edit; it keeps
  `package-lock.json` in sync). Tags aren't pushed from CI here — the version field is
  the source of truth. `npm version` also runs the `version` hook
  (`scripts/stamp-release-date.js`), which stamps `package.json` `releaseDate` with
  today's date — the dashboard footer shows `BlueEyes server · v<version> · <releaseDate>`
  (served by `GET /system/version`), so don't hand‑edit the date; let the bump set it.

## Working in this repo

- Run tests: `npm test` (`node --test`; auto-discovers `test/**` and `src/**/__tests__`).
  Test Express endpoints for 400/401/403/404/500; mock outbound calls (LLM/SMTP/geocoder).
- DB: numbered `migrations/NNN_*.sql` (tracked in `schema_migrations`), run `npm run migrate`.
  After adding a migration run `npm run build-schema` — `schema.sql` is generated from
  the migration chain and `npm test` fails when it is stale. Never hand-edit it.
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

## Pre-build gate (security / UI / validation tests)

No branch build exists without the gate passing. `scripts/gate.sh` runs the three
gate suites in `test/gate/` — **security**, **ui**, **validation** — and then the
full `npm test`, and refuses the build on any failure. It runs from three places
that all call the same script:

- **Claude Code** — `.claude/settings.json` has a `PreToolUse` hook on `Bash`
  (`.claude/hooks/pre-push-gate.sh`): any `git push` runs the gate first; a failing
  gate blocks the push (exit 2) and feeds the failures back to Claude to fix.
- **git** — `.githooks/pre-push` (activated by the SessionStart hook via
  `core.hooksPath`) runs it for every human push too.
- **CI** — `.github/workflows/gate.yml` runs it on every branch push and pull request.

The result is cached per `HEAD` + worktree state (`.git/blueeye-gate.stamp`), so a
push straight after a green run is instant. `scripts/gate.sh --force` re-runs;
`BLUEEYE_SKIP_GATE=1` skips (emergency only, printed loudly).

The gate suites sweep the whole surface rather than one feature at a time (every
registered route, every validator, every `data-view`/`t()` key). **When you add a
route, a validator, a nav view or an i18n key, the gate tells you what to extend**
(an allowlist entry, a PAGE_INFO entry, a catalogue key) — extend it deliberately,
never loosen the sweep.

## Sister repos

- **blueeye-agent** — runs on customer machines; reports traffic/system/flows/probes.
  Agent-side data changes (e.g. probes, interface errors/discards) require redeploying
  agents (`git pull && ./install.sh`); keep the server backward‑compatible.
- **blueeye-licens** — signs Ed25519 license proofs that `src/license/` verifies offline.
  Those proofs also carry the newest **published** server/agent versions, which drive
  "update available" in Settings → Updates (`docs/updates.md`) — so bumping a version in
  these repos is what eventually tells customers an update exists.
