# The in-app guides (nav group: Guides)

Five next-next walkthroughs in the dashboard itself — **Monitoring, Fleet,
Diagnostics, Service Assurance, Insights** — one step per thing you actually do,
in the order the product needs them done, and, the part a handbook never gets
right, **the values to put in**.

They exist because `docs/` is a directory in a repository and the person
learning the product has a browser open on the screen they are stuck on.

## Where it lives

- `public/index.html` — the `Guides` nav group, one button per track:
  `data-view="guide"` + `data-guide="<track>"`. Viewer+ (reading how a thing
  works is not the same permission as doing it); the Service Assurance entry
  additionally carries `data-feature="service_tests"`, because a guide to a
  module you have not bought is a brochure.
- `public/guides.js` — the module (`window.Guides`). One engine, five step
  arrays (`monitoringSteps()`, `fleetSteps()`, `diagnosticsSteps()`,
  `assuranceSteps()`, `insightsSteps()`). A step is `{ id, title(), body() }`
  and carries its own title, so adding one never means editing a lookup
  somewhere else.
- `public/app.js` — `views.guide` mounts it with the shared helpers (`el`,
  `api`, `t`, `toast`, role predicates), the requested `track`, and four deep
  links: `openView` (any dashboard view), `openTab` (a Service Assurance
  sub-tab), `openSettings` (a Settings sub-tab), `openDocs` (a Documentation
  article). `PAGE_INFO.guide` is the hero + *More info* drawer. `guideTrack`
  holds which entry was clicked.
- `public/serviceAssurance.css` — the `.guide-*` block.
- `public/i18n.js` — every string, `guide.*`, in **en and da**.

## The five tracks

| Track | Steps | Covers |
| --- | --- | --- |
| `monitoring` | 7 | Changes and what "mark as seen" really does, the Overview's verdicts, Traffic and the per-agent traffic source, Sites, Destinations |
| `fleet` | 7 | Enrolment and the signing key, the agent page, interface verdicts, NIC firmware drift, keeping agents current |
| `diagnostics` | 6 | Which tool answers which question, which probe for which symptom, saved tests and transaction tests, Flows/Topology, the outage screen |
| `assurance` | 14 | The Service Assurance module end to end: application, allowlist, discovery, tests, journeys, schedules, runs, health, incidents, alerts, every setting |
| `insights` | 7 | The vocabulary (finding / event / situation / report), how a finding is made, events and situations, alerting, retention, reporting |

## Two design rules

**The numbers come from the running system.** Service Assurance's budgets,
timeouts, failure streak, certificate thresholds and allowlist caps are read
from `GET /api/service-tests/settings`, which returns the effective values *and*
the defaults — so a guide cannot quote a default an operator has changed, and a
default that moves in code moves here with it. The three tables that cannot be
served that way carry their numbers in the module and are **pinned by
`test/guides.test.js`**:

| Table | Pinned to |
| --- | --- |
| `HEALTH_WEIGHTS` | `SCORE_WEIGHTS` (`src/serviceTests/health/serviceHealth.js`) |
| `ANALYSIS_VALUES` / `RETENTION_VALUES` | `ANALYSIS_DEFAULTS` / `RETENTION_DEFAULTS` (`src/services/settings.js`) |
| `HEALTH_THRESHOLDS` | `THRESHOLDS` (`src/health/probeHealth.js`) + the utilization rules in `src/health/interfaceHealth.js` |

**Live state is garnish; the guidance is the point.** A step can carry a line
read from the API — *1 of 2 agents are not connected*, *2 applications have no
allowed hosts: Selvbetjening, Intranet*, *4 values differ from the default*.
Every probe is wrapped: a 403, a 404 or a 500 costs its own status line, a
banner says the state could not be read, and every step still renders with its
tables. The suite asserts that for all three codes.

The two bundles a guide loads:

- **assurance** — nine Service Assurance endpoints, plus per-application detail
  for up to five applications (the allowlist check).
- **everything else** — `/agents`, `/locations`, and `GET /api/settings` **only
  when the reader is an admin**: a 403 nobody could have avoided is noise in the
  banner. A non-admin sees the default column and "admin only" where the live
  value would be.

## Two details the first audit pass added

**A link the reader cannot follow is worse than no link.** `viewBlockedReason`
(in `app.js`, shared with the help drawers' `viewLink`) reads the nav: hidden by
role, locked by licence, or open. A step that names Enrollment or
Troubleshooting for a viewer renders it greyed with the reason rather than a
button that would land them on a different screen, and every Settings tab the
guides link to is administrator-only, so for anybody else those are greyed too.

**Counted lines carry both forms.** `I18n.plural(key, n, params)` picks
`key.one` or `key.other` and fills `{count}` itself, so a guide says "One test
exists" and "4 tests exist" rather than "1 test(s)". The gate sweep
(`test/gate/ui.test.js`) checks both forms exist in both locales for every
literal `plural('…')` call; the keys handed to `countStatus` as plain strings
are checked by `test/guides.test.js` instead, which also walks every step of
every guide asserting no `{placeholder}` survives to the screen.

## Doing the thing, not just describing it

Six steps carry an **action card**: a small form that creates the thing the step
is about, so "Applications → New, fill in two fields, come back" becomes one
button.

| Guide | Step | What it does | Endpoint | Role |
| --- | --- | --- | --- | --- |
| Monitoring | Sites | creates a site | `POST /locations` | operator |
| Fleet | Add an agent | generates an enrollment code | `POST /enrollment-codes` | operator |
| Diagnostics | Probes | runs one ping from a chosen agent | `POST /agents/:id/probe` | operator |
| Service Assurance | Register the application | creates the application | `POST /api/service-tests/applications` | admin |
| Service Assurance | Allow the addresses | adds one allowlist entry | `POST …/applications/:id/allowed-hosts` | admin |
| Service Assurance | Tests | creates a two-step test (open + assert the title) | `POST /api/service-tests/tests` | operator |

The rules they follow, because a guide that writes to a production system has to
be more careful than one that only talks:

- it writes **only** when the reader presses the button, and the button says
  exactly what it will create;
- it calls **the same endpoint the real screen calls**, so the same validation,
  the same RBAC and the same audit entry apply — there is no second, laxer way
  in through the guide;
- a 400 comes back **on the field that caused it**, with the server's own
  message rather than a friendlier guess;
- a reader whose role cannot do it is told so instead of being handed a button
  that answers 403;
- on success the live state is re-read, so the step's status line stops saying
  "not yet" while the thing sits there created.

`test/dashboardSmoke.test.js` exercises these end to end — the guide's button,
through the real router, into the module's own list — because a hand-written
fake that answers 201 to anything cannot prove the payload is one the validator
accepts.

## RBAC and licence

Viewer+ for all five. The Service Assurance track follows `service_tests` like
the module it describes, and its step 2 tells a viewer in as many words that
their role can read the guide but not create anything. Reading a guide never
writes; the action cards above are the only writes, and each is gated at the
role its endpoint requires.

## Adding or changing a step

1. Add an entry to the track's array in `public/guides.js`
   (`{ id, title(), body() }`).
2. Add its keys to **both** catalogues in `public/i18n.js`. Keys are always
   literals inside `t('…')` — never built by concatenation, because the gate
   sweep (`test/gate/ui.test.js`) can only check what it can see, and
   `test/guides.test.js` fails on a concatenated key.
3. Quote a number by reading it from a settings endpoint where one serves it,
   and otherwise add it to a pinned table above — never by typing it into a
   sentence.
4. Bump `package.json` version (`npm version patch|minor --no-git-tag-version`).

## Related

- [service-assurance-guide.md](service-assurance-guide.md) — the written
  Service Assurance guide, and the entry point to that module's designs of
  record.
- [documentation-center.md](documentation-center.md) — the built-in handbook
  (Documentation), which the guides link into.
