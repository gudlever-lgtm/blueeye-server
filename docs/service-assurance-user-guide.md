# The in-app user guide (Service Assurance → User guide)

A next-next walkthrough of Service Assurance, in the dashboard itself: one step
per thing you actually do, in the order the module needs them done, and — the
part a handbook never gets right — **the values to put in**.

It exists because [service-assurance-guide.md](service-assurance-guide.md) is a
document you have to know exists, open in a repository, and read next to the
screen you are working in. This is the same knowledge, on that screen, with the
running system's own numbers in it.

## Where it lives

- `public/index.html` — nav button `data-view="guide"`, the **first** entry in
  the *Service Assurance* group, gated `data-min-role="operator"` +
  `data-feature="service_tests"` like the rest of the module.
- `public/serviceAssuranceGuide.js` — the module (`window.ServiceAssuranceGuide`).
  Its own classic script, no build step.
- `public/app.js` — `views.guide` mounts it with the shared helpers (`el`, `api`,
  `t`, `toast`, role predicates) plus three deep links: `openTab` (a Service
  Assurance screen), `openSettings` (a Settings sub-tab) and `openDocs` (a
  Documentation article). `PAGE_INFO.guide` is the hero + *More info* drawer.
- `public/serviceAssurance.css` — the `.guide-*` block.
- `public/i18n.js` — every string, `guide.*`, in **en and da**.

## The fourteen steps

| # | Step | What it covers |
| --- | --- | --- |
| 1 | What you are about to do | What the module is, the order, what it will never do |
| 2 | Before you start | Licence, a running worker, operator+ |
| 3 | Register the application | Name, address, environments, the login |
| 4 | Allow the addresses | Entry types, the caps, the four ranges nothing can allow |
| 5 | Let it look around | Discovery, signing in, the crawl budgets |
| 6 | Tests | Accept / build / record, what to assert, the runner limits |
| 7 | Journeys | Required vs optional, criticality, the verdict table |
| 8 | Put it on a schedule | The five cadences, and which to use for what |
| 9 | Read the first run | The chain, the ranked causes, seen vs deduced vs invisible |
| 10 | The health score | The four parts and their weights, "not measured", the dash |
| 11 | Incidents | The lifecycle, the failure streak, certificate days, recurrence |
| 12 | Alerts | The state-change table, grouping, the first-week setting |
| 13 | The values, in one place | Your settings next to the shipped defaults |
| 14 | You are set up | The weekly routine, and the symptom → meaning table |

## Two design rules

**The numbers come from the running system.** Everything quotable — crawl
budgets, runner timeouts, the failure streak, certificate thresholds, the
allowlist caps — is read from `GET /api/service-tests/settings`, which returns
the effective values *and* the defaults. So the guide cannot quote a default the
operator has changed, and a default that moves in code moves here with it. The
only hardcoded numbers left are the health weights (nothing serves them) and
they are pinned to `SCORE_WEIGHTS` by `test/serviceAssuranceGuide.test.js`.

**The state is garnish; the guidance is the point.** Each step can carry a live
line — *a worker is connected*, *2 applications have no allowed hosts:
Selvbetjening, Intranet*, *4 values differ from the default* — read from nine
endpoints at mount. Every one of those probes is wrapped: a 403 (no licence), a
404 (an endpoint that moved) or a 500 costs its own status line and nothing
else. A banner says the state could not be read, and all fourteen steps still
render with their tables. The suite asserts exactly that, for all three codes.

## RBAC and licence

Operator+ and `service_tests`, the same gate as every other entry in the group —
the guide describes operator work, and a viewer who reached it anyway is told in
step 2 that their role cannot create anything. It **reads and never writes**:
nine GETs, no POST, no PUT.

## Adding or changing a step

1. Add an entry to `STEPS` in `public/serviceAssuranceGuide.js`
   (`{ id, body() }`) and a title case to `stepTitle()`.
2. Add its keys to **both** catalogues in `public/i18n.js`. Keys are always
   literals inside `t('…')` — never built by concatenation, because the gate
   sweep (`test/gate/ui.test.js`) can only check what it can see, and
   `test/serviceAssuranceGuide.test.js` fails on a concatenated key.
3. Quote a number by reading it from settings (`quote(section, field)`), not by
   typing it.
4. Bump `package.json` version (`npm version patch|minor --no-git-tag-version`).

## Related

- [service-assurance-guide.md](service-assurance-guide.md) — the written guide,
  the same journey at more length, and the entry point to the designs of record.
- [documentation-center.md](documentation-center.md) — the built-in handbook the
  guide links into.
