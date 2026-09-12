# Changelog

## 0.126.1 — severity rules, and a test you can rename or delete

### "This is a warning for us, not a critical"

BlueEyes decides severity at detection: the analyser from a median + MAD z-score,
Service Assurance from the kind of failure. Both are reasonable defaults and
neither knows your business — the packet loss that pages one customer at 3am is
the wifi at another one's warehouse.

A **severity rule** says: events matching this get that severity, from now on.
It covers both event sources — analysis findings and Service Assurance incidents
— through one rule set, one screen and one piece of logic.

The most specific matching rule wins, so `packet_loss on gw-core → CRIT` beats
`packet_loss → WARN` and a general rule stays safe to write. A tie goes to the
newest rule, because two equally specific rules matching the same event is a
person changing their mind.

Rules are applied where events are **stored**, not where they are read. Alerting
reads the stored severity, so a read-time rule would still page at 3am — and a
rule written today must not silently rewrite what you thought last March.

Two things a rule deliberately cannot do:

- **It cannot make an event disappear.** INFO is the floor. Something that
  silently deletes events is a different and far more dangerous control, and it
  is not going to hide behind this one.
- **It cannot change an event without saying so.** Every event a rule touched
  carries `original_severity` and `severity_rule_id`, and the row shows "was
  CRIT" next to the badge. A machine that quietly downgrades criticals is one
  where the dashboard goes green and nobody looks again.

Writing a rule does not touch events that already exist. Applying one backwards
is a separate action that counts first — "412 open events would be set to WARN"
— and changes nothing until it is confirmed. Deleting a rule does not un-decide
what it decided: the provenance goes to NULL and the stored severity stands.

Admin, not operator. A rule quietly changes what wakes people at 3am, across the
whole estate and indefinitely.

The entry point is the event itself: a "Severity rule…" button on each finding
and each incident opens the form already describing that event, because the
thought happens while looking at it, not in Settings an hour later. The full list
lives at Settings → Severity rules, with each rule's match count and when it last
fired — a rule nobody can tell is dead is a rule nobody dares delete.

A rule set that cannot be read leaves the detector's judgement alone: the cache
returns the last known set rather than an empty one, so a database hiccup cannot
silently turn every rule off and start paging on everything the operator muted.

`docs/severity-rules.md`, migration 086.

### A service test can be renamed, re-described and deleted

The designer only ever saved the STEPS. A test's name, description, login and
enabled flag were set once at creation and unreachable forever after, which is
how a test ends up called "Untitled" with nobody able to say what it is for. The
test page now has Edit and Delete.

Deleting a test removes it from every journey that used it — the step row
cascades — so the journey quietly gets shorter and keeps reporting healthy while
the thing it was watching is no longer watched. The confirm names those journeys
before it happens rather than after.

The application a test belongs to is deliberately NOT editable: moving a test
would leave its steps pointing at another application's pages and its history
describing a service it no longer tests.

### Fixed

- **A severity rule could not be edited.** `PUT` validates the stored rule merged
  with the patch, and a stored row carries every column — including the other
  source's, sitting at NULL. The wrong-source check refused those nulls, so every
  edit came back 400. Only match fields that carry a value are refused now.
- **Findings never reported a ruled severity.** The provenance columns were
  written but not selected, so `original_severity` never reached the dashboard —
  a downgraded critical would have looked exactly like a detected warning. Same
  fix on the Service Assurance incident shape.
- **The findings test fake mapped INSERT parameters positionally.** Adding two
  columns shifted every value one place and the failures surfaced three tests
  away. It reads the column names out of the statement now.

## 0.125.11 — a sweep of the V2 code, and two real bugs

Looked for the same class of trap as `Number(null) === 0`. The number coercion
itself came back clean — the sweep test holds and no new occurrence appeared —
but two comparisons were wrong in ways that would never have announced
themselves.

**Healing proposals were never deduplicated.** The check for an existing open
proposal compared `CAST(proposed_target AS CHAR)` against a JS `JSON.stringify`.
MySQL stores a JSON column in its OWN canonical form — object keys sorted, and a
space after each colon — so it was comparing

    {"name": "Log ind", "role": "button"}

against

    {"role":"button","name":"Log ind"}

and could never match. The dedup existed precisely so a test failing every five
minutes would not pile up three hundred identical proposals a day, and it was
failing silently, because "no row found" is also exactly what a first proposal
looks like. Now compared as JSON (`= CAST(? AS JSON)`), which is key-order
agnostic.

The same trap does NOT apply to the three JS-side comparisons: all of them put
both operands through `normalizeTarget()` first, which rebuilds the bag in a
fixed key order. Verified rather than assumed.

**Accepting a journey suggestion could reach into another application.** The
member lookup passed `discoveryId: suggestion.discovery_id`, and a null there
applies no discovery filter at all — so a journey suggestion without one would
have matched its members by NAME against every test suggestion in the database.
"Login" is the commonest suggestion there is. The test would then have been
created in whichever application that stray suggestion belonged to, and hung off
this journey. Now scoped by application as well, with an explicit per-member
check behind it.

**Also hardened:** evidence array-checks `console_errors` and `network_errors`
rather than only null-checking them — they are JSON columns, and a non-array in
one would turn "show me what happened" into a 500 on the one screen an operator
opens when something is already wrong. And the service map bounds how many tests
it walks (200) and says in the response when it was truncated: a map that quietly
shows two thirds of an estate is worse than one that admits it.

Checked and found clean: no unawaited repository calls, no `sort()` on a shared
array (every one operates on a freshly built list), no `parseInt` without a
radix, no SQL interpolation from anything but a fixed column allowlist, and no
`filter(Boolean)` that could drop a legitimate zero — `Boolean("0")` is true, so
the path-segment filter drops only empty segments.

The agent is bumped to 0.24.1 in lockstep. No agent code changed — V2 is entirely
server-side.

## 0.125.10 — performance baselines, evidence, and the service map

The last three of V2's P2 list, and the end of V2.

### Performance is metadata on a result, not a system (§9)

Nothing new is measured. The runner already times every step and every run;
`analysis/baseline.js` only says what those numbers mean against the same test's
own history. Median + MAD, like every statistic here — a mean and a standard
deviation let one 30-second timeout drag "normal" up until nothing ever looks
slow again, which is the failure mode of every naive latency alarm. Verified: a
30-second outlier moves the median by 5 ms.

Four rules, three to stop it crying wolf and one to stop it lying:

- fewer than five successful runs is **unknown**, never "normal";
- a failing run never enters a baseline — a timeout burns the whole step budget
  and a crash finishes instantly, so either makes "normal" a description of how
  the test BREAKS rather than how it works;
- the run being judged is excluded from the history it is judged against;
- slow needs to be outside the band AND at least 25% slower, so a test that is
  consistently 400 ms ±2 ms does not scream at 420.

Unexpectedly FAST is reported too, and is not good news by default: a run that
finishes in a fifth of the usual time is often a page that stopped loading
something.

### Evidence stores nothing new (§10)

URL, method, status, timings, failed requests, selector information, page
information, error messages, screenshots — all of it was already recorded.
`analysis/evidence.js` gathers it into one shape and `GET /runs/:id/evidence`
serves it, so "what did we see" is one request rather than four screens.

The secrets rule holds structurally: it assembles only from columns the runner
masked on the way IN, and adds no new source — there is nothing here to forget to
scrub. A spec asserts the whole assembled record against a forbidden-key list
anyway, because a guarantee nobody checks is folklore.

Status 0 is treated as a failure throughout. It means the request never completed
— DNS, a refused connection, a blocked host — and it reads as "fine" to anything
comparing with >= 400.

### The service map is computed on read, never stored (§11)

That is the line between it and the CMDB the spec warns against: a stored map is
a claim somebody has to maintain and that quietly rots. This one can only show
what runs observed, and a relation that stops being observed stops being drawn.
Read-only by design — there is no route to add, edit or annotate a node, because
the moment one exists the map has opinions of its own.

URLs collapse to ENDPOINTS (`/customers/4711/cases` → `/customers/{id}/cases`),
which turns ten thousand observed URLs into a readable handful, and the query
string is dropped entirely: it is where identifiers and secrets live, and a
filter does not make a different endpoint. A test nobody has grouped into a
journey still appears — hiding it would make the map lie by omission.

Drawn as nested lists rather than a graph, deliberately. A force-directed picture
of forty endpoints looks impressive and answers nothing; a list answers "which
endpoints does this journey depend on, and which have failed".

### Also

The fake runs repository returned `steps: []` from `findById`, discarding the
step rows the real one returns. Every reader that depends on them — evidence, the
service map — would have looked correct while testing nothing. Found by a spec
that expected a page URL and got null.

No migration: all three read data that already existed.

## 0.125.9 — self-healing selectors: proposed, never applied

    Original:   #login-button
    Suggested:  button "Log ind"

Applications change. A button gets a new id, a field is renamed, an `<a>`
becomes a `<button>` — and the test that was watching it fails in a way that
looks exactly like the service being broken, which is the one thing it must not
be confused with. BlueEyes now looks at what IS on the page and says what it
thinks the step meant.

**It never repoints a test on its own.** Not when it is confident, not when the
evidence is overwhelming. The spec says *testen må ikke ændres automatisk uden
brugerens accept*, and nothing in the module can: the repository cannot write a
definition, and `api/healing.js` is the single place a target is rewritten from
a proposal.

That rule is not caution for its own sake. A wrong heal is the worst thing this
feature could do — the test goes green, the dashboard goes green, and nobody
looks again while the service is broken or the test watches the wrong button. A
MISSED heal costs somebody five minutes in the designer. Everything is tuned to
that asymmetry, so nothing is proposed when:

- two candidates are indistinguishable — two buttons both called "Save" is
  exactly when a guess goes wrong;
- the evidence is a lone id, because an id is precisely what changes;
- the proposal equals what the step already says — the element failed for some
  other reason, and repointing it at itself would hide that.

The weights are the runner's own priority order in numbers (role → label → text
→ placeholder → name → id → CSS), and a CHANGED kind of element counts against
rather than being free. Writing it turned up a scoring bug worth keeping:
`name` was counted twice, because it is the accessible name when a role is
present and the HTML attribute otherwise — so the same fact was inflating the
total and printing as two independent pieces of evidence. It now mirrors
`strategiesFor()` exactly.

Proposals address a step by its flattened PATH (`2.1`), not an index, so a step
inside a condition block heals like any other. Healing that silently could not
reach nested steps would fail on exactly the tests complicated enough to break.

Accepting re-checks that the step still exists AND still says what the proposal
was made against — a stale proposal applied by position would repoint a
DIFFERENT step. Either check failing marks it stale rather than leaving it to be
accepted tomorrow. It then goes through the ordinary test save, so a heal gets a
version bump and a snapshot like any other edit, and the healing row survives the
decision: "why does this test point at a different button than it did in March"
is answerable six months later.

The browser side only OBSERVES: up to 200 visible interactive elements, each
described the way a target is. Every judgement happens on the server in
`engine/heal.js`, which is pure and tested on its own.

Migration 085. [docs/service-assurance-healing.md](docs/service-assurance-healing.md)
is the operator's guide.

## 0.125.8 — Discovery suggests journeys, not just tests

Discovery already proposed tests: "Login", "Search", "Availability". A test
suggestion answers *what could we check here*. It does not answer the question
the product exists to answer, which is *what does a user actually do here*.

```
Suggested journeys

  Sign in and use the application            confidence: medium
    1. Login
    2. Authenticated navigation
    3. Logout · optional
  Reason: Discovery found a login flow and reached pages behind it.
```

Rules, not AI — each is a stated condition over what Discovery found, carrying
the reason it was proposed so an operator judges it rather than trusts it.

**The journey rules read the TEST suggestions, not the crawl again.** So there
is exactly one place that knows how to turn a discovered element into a DSL
step; a journey suggestion only GROUPS what has already been proposed, and names
its members by name because the tests do not exist until it is accepted.

**Accepting one is the whole chain in a single request:** the member tests are
created, then the journey, then the ordering. A member the operator accepted
earlier on its own is REUSED — a second copy of the same check splits its
history across two rows and monitors nothing extra. A member that has gone
refuses the whole accept *before anything is created*: half a journey is worse
than a clear refusal.

Four deliberate rules:

- **"Availability" never becomes a journey.** Opening the front page and getting
  HTTP 200 is the definition of "the website is up" — the exact sentence
  journeys exist so BlueEyes stops saying. It stays a useful test.
- **A journey contained by a bigger one is dropped.** "Sign in" and "Sign in and
  use the application" both apply whenever there is a login with pages behind
  it; offering both means accepting two journeys that watch the same login.
- **Confidence is the weakest link.** A high-confidence login plus a
  low-confidence search is a low-confidence journey, so attention goes to the
  part that might be wrong.
- **Criticality is proposed, never decided.** The operator overrides it in the
  accept dialog, before anything is created. It is their judgement about their
  business.

The bulk "create selected tests" button refuses a journey rather than building
an empty test from its deliberately empty `proposed_steps`.

Migration 084 gives `service_test_suggestions` a `kind` rather than adding a
second suggestions table: the accept/dismiss flow, the discovery link and the
statuses already exist and behave identically for both.

One spec had to change with it, and the way it changed is the point: it pinned
`confidence` at parameter index 4, and adding a column shifted everything after
it. It now reads the position out of the statement's own column list, so the
next column to be added fails nothing that has nothing to do with it.

## 0.125.7 — the Number(null) trap, swept out of the whole codebase

`Number(null)` is `0`. `Number('')` is `0`. `Number('   ')` is `0`. `Number([])`
is `0`. And `Number.isFinite(0)` is `true` — so the careful-looking guard

    Number.isFinite(Number(row.duration_ms)) ? Number(row.duration_ms) : null

turns a MISSING value into a real-looking zero. Zero is never neutral here: it
is "instant", "0 Mbps", "no latency" — always the good end of whatever scale it
lands on. Missing data then reads as good news, which is the one direction
monitoring must never err in.

It had bitten three times before this sweep, twice in the journeys work that
found it. A full pass over the codebase turned up four more:

**`throughputHealth` — the worst.** A speed-test row with no figure became
`0 Mbps`, which is below every floor an admin can set, so the agent was flagged
**BAD** with "Download 0 Mbps". An outage invented out of absence.

**`discovery/extract`** — an unmeasured page reported `load_ms: 0`, the fastest
page in the estate; and a missing HTTP status became `0`, which is a REAL value
elsewhere in the module (apiLog uses it for "the request never completed").

**`recording/validate`** — an event without a timestamp became epoch 0, and the
translation sorts by timestamp, so it was sorted to the front of the journey.

**`changeFeed`** — a finding with no host id became `agent 0`, a host the row
could not name, which `agentId == null` checks downstream would then miss.

Also hardened: `apiLog`'s duration, which is the arithmetic cousin —
`5 - null` is `5`, so a missing start would have reported the absolute clock
value as an elapsed time.

The fix is `numOrNull` in `src/lib/num.js`, mirrored in
`src/serviceTests/storage/shape.js` because nothing under `src/serviceTests/`
may reach into its host. Absence — `null`, `undefined`, `''`, whitespace, `[]`,
`{}`, booleans — comes back as null; a genuine `0` comes back as `0`. Writing
the spec for it caught a gap in my own first version: `'   '` coerces to 0 too,
and a padded CHAR column is absence.

`test/numberCoercion.test.js` is the guard that keeps it from rotting: the two
copies of the helper are asserted to agree (two copies that drifted is exactly
how the password-field rule broke), and a `git grep` sweep refuses new
occurrences of the pattern outside a two-entry allowlist that must state its
reason — with a second test that fails if an allowlist entry outlives the line
it excuses. The sweep was verified by introducing a regression and watching it
fail.

The sister repos were checked and are clean of this specific trap: the agent's
`|| 0` cases are `/proc` counters where zero is the right default, and its link
speed read is already guarded by `> 0`.

## 0.125.6 — user journeys: what the service IS, not which URLs answer

The central V2 object (P1 #1). A test tells you a page answered. A journey tells
you whether someone can do their job:

```
Customer lookup                                    FAILED
  1. Login            ✗   required   HTTP 500 from /api/auth/login
  2. Search Customer  —   required   never run
  3. Open Customer    —   required   never run
  4. Logout           ✓   optional

"Login" is failing, so the user cannot get through.
```

Not four green ticks — one sentence an operator can act on.

**A journey owns no tests.** This is the decision everything else follows from.
It ORDERS tests that already exist and has no steps, no definition and no second
test format — so the designer, recording, the runner, history, screenshots,
incidents and schedules all work inside a journey the day it is created, without
one of them being taught what a journey is. The same test can be step 1 of
several journeys, which is the normal case for "Login" and the reason membership
is its own table rather than a column. Deleting a journey never deletes the
tests under it: a journey is a way of READING your monitoring, not its owner.
And a test now says which journeys depend on it, so nobody deletes one without
seeing they are about to stop watching a customer login.

**Required vs optional is the whole value.** A broken required step fails the
journey — the user cannot get through. A broken optional one degrades it: part
of the service is gone, the journey is not. Logout failing is not Login failing,
and a system that cannot say so makes its own alerts worthless.

Two rules that look like details and are not:

- **"Not known yet" is not a failure.** A journey nobody has run — or one
  described but not yet implemented — reports as unknown and says which.
  Colouring it red would train people to ignore red.
- **A journey's duration is unknown unless EVERY step was measured.** A partial
  sum against a whole-journey expectation reads as a SPEED-UP when it is really
  a missing measurement. Writing this turned up the same bug twice: `Number(null)`
  is `0` and `Number.isFinite(0)` is true, so a missing duration first counted as
  measured-and-zero in the rollup, then produced a verdict claiming the journey
  took 0 ms — comfortably inside any expectation. Missing data must never read as
  good news.

Criticality (Critical/High/Normal/Low) is the customer's judgement, not a
severity the system computes, and it orders the list so what matters most is
read first. The verdict is computed on read, never stored, so it cannot go
stale — and it always carries the sentence explaining it, because a status
nobody can check is a status nobody trusts.

Migration 083. `journeys/health.js` is pure and tested on its own;
[docs/service-assurance-journeys.md](docs/service-assurance-journeys.md) is the
operator's guide.

## 0.125.5 — the capture address belongs in Settings, not only in a file

Asked while deploying yesterday's mixed-content fix: does this have to be an
environment variable? No, and it should not have been.

**Service Assurance → Settings → Recording** now carries the address this server
is reached on. Blank means what it always meant — work it out from the request,
which is right for a direct install. It takes precedence over
`BLUEEYE_PUBLIC_URL`, because the two questions are answered by different
people: the env var needs a shell and a redeploy, this needs the dashboard and
the operator who just watched recording fail.

This is the settings catalogue's first free-text field, so it brought a
`STRING_FIELDS` kind with it. Each entry carries its own validator rather than a
bound — "valid" for a string is never a range — and an empty value always means
"not set" and falls back to the previous behaviour, so a blank field is never a
broken one. The address is parsed, not pattern-matched: `javascript:`,
`ftp://`, a bare hostname and a URL carrying a query are all refused, and a
trailing slash is trimmed on the way in so every caller can append a path.

`http://` is **accepted**, deliberately. A BlueEyes served over plain HTTP on an
internal network is a real deployment, and the recording dialog already warns
that HTTPS applications will refuse it. Refusing to store the truth would be
worse than reporting it.

Also fixed while testing it: the Docker stack never passed `BLUEEYE_PUBLIC_URL`
or `TRUST_PROXY` through to the server container at all. Compose reads `.env`
for `${VAR}` substitution, but a variable that is not named in the service's
`environment:` block never reaches the process — so setting either in `.env`
did nothing, silently. Both are wired now.

## 0.125.4 — the recorder was handed an address it could never use

`Blocked loading mixed active content "http://blueeye-server…/api/service-capture/events"`.

Not CSP, not CORS. The bookmarklet was built with an **http://** capture
address, and an HTTPS page refuses a plain-HTTP call as mixed active content
before it is even attempted. Almost every application worth monitoring is
HTTPS, so recording could not work anywhere.

Three causes, all mine:

**The configured public URL was never read.** The bookmarklet asked Express for
an app setting called `publicUrl`. Nothing sets it — the deployment's address
lives in `config.publicUrl` (`BLUEEYE_PUBLIC_URL`), which the enrollment
installer has always used. The module is now handed it explicitly, and it wins
over anything derived from the request.

**Behind a proxy, a derived address is always http.** The request reaches the
server over plain HTTP from the reverse proxy, so `req.protocol` says `http`
even when the operator is on HTTPS. A forwarded scheme now UPGRADES http to
https — and can do nothing else: it cannot change the host and cannot
downgrade, so a forged header can at worst point an operator's own bookmarklet
at https, which either works or visibly does not.

**And when it is still http, say so.** The start dialog now refuses to pretend:
it names the address, explains that an HTTPS application will refuse it, and
gives the fix (serve BlueEyes over HTTPS, or set `BLUEEYE_PUBLIC_URL` to the
https address when a proxy already terminates TLS). Handing someone a
bookmarklet that cannot work, and letting them discover it by performing a
whole journey, is the failure this feature can least afford.

The empty-recording message and the docs now name mixed content first, since it
is the failure that comes before CSP can even apply.

## 0.125.3 — the recorder says when it cannot reach us

Three fixes from watching someone use it.

**A recording could not be stopped from the dashboard.** The only Stop was the
badge on the customer's page — which stops by POSTing to BlueEyes. So a site
that blocks the recorder's connection blocks its goodbye too, and the row sat at
"Recording" with nobody able to end it: pressing Stop appeared to do nothing,
because from BlueEyes' side nothing happened. The route existed and was tested;
there was simply no button on it. The recordings strip now has one, and the
dashboard's own connection is never subject to the customer's policy.

**An empty recording offered a "Save as test" button** that could only fail. The
server refuses a stepless test, correctly — but the dialog put an enabled button
in front of the operator anyway, so pressing it produced an error that read as
"you did something wrong" when the truth was there had never been anything to
press it for. There is now no save button in that case, and the remaining button
says Close rather than Cancel, because there is nothing to cancel.

**A blocked flush was silent.** The badge counted what the recorder saw locally,
so an operator could perform an entire journey believing it was being recorded
and find an empty recording waiting for them. That is the worst possible failure
for this feature: it wastes the one thing recording is supposed to save.

The badge now turns amber after two consecutive failed flushes — two, not one,
because a single dropped packet is not a story worth alarming anyone about — and
distinguishes *never reached* from *connection lost*. Any HTTP response clears
it, including a 429: the server answering is not an unreachable server.

The commonest cause is the site's own `connect-src` policy refusing the
connection, which the browser reports to the console and to nobody else — a CSP
refusal is indistinguishable from a network error to the script it blocks. So
the badge, the empty-recording message and the docs all point at F12 → Console
and name the directive to look for.

## 0.125.2 — the application a test runs against, and a bookmarklet CSP cannot refuse

**The Tests list now names the application.** A test name is only unique within
its application, so four applications each with a "Login" produced four
identical rows with nothing to tell them apart. The list and the detail read
join the application in (LEFT, so a test whose application row is gone still
lists) and order by application first, so tests group under the service they
watch. The recordings strip does the same, for the same reason.

**The bookmarklet carries the recorder inline.** The first version did the tidy
thing — one `<script src>` served from here, fixable server-side without anyone
re-dragging a bookmark — and was refused by the first real site it met.

The distinction that matters: a bookmarklet's own code is THE USER ACTING, and
browsers exempt it from the page's Content-Security-Policy. A `<script src>` it
appends is THE PAGE LOADING A SCRIPT, and `script-src` refuses it. So the whole
recorder (about 23 KB encoded) now rides in the bookmarklet. Nothing was lost by
inlining: the capture token expires in minutes, so every recording needs a fresh
bookmark anyway and there is no stale copy to keep current. `/recorder.js` is
still served, so an operator can read what it does before trusting it, and the
recorder takes its config from either source.

**The wall this does not climb, now documented instead of discovered:**
`connect-src`. The recorder has to post what it saw back to BlueEyes, and a site
whose policy allows connections only to itself blocks that — no bookmarklet can
talk its way past it. The docs and the UI now say which directive to look for in
the console and give the three real options: record on an environment without
the header (the test stores paths, so it still runs against production), ask for
the BlueEyes address to be added to `connect-src`, or build the test in the
designer.

**The bookmark's icon.** A `javascript:` bookmark has no origin, so the browser
has no favicon to fetch and shows its generic globe whatever we do. The name is
the part we control, so the BlueEyes mark (◉) rides there, and the UI says why
rather than leaving it looking broken.

## 0.125.1 — recording: the bookmarklet, the capture path, and the review screen

The other half of V2 §1. The operator drags a bookmark to their bookmarks bar,
opens the real application, signs in as themselves and performs the journey.
BlueEye watches and writes the test.

**Why a bookmarklet.** The alternatives were a signed browser extension (better
capture, a new artifact to build and sign per browser, forever) and a headful
remote browser streamed to the dashboard (nothing to install, but BlueEye would
hold a live session with the customer's real traffic passing through it — the
opposite of the privacy rule, plus VNC as a new attack surface). The bookmarklet
needs no new infrastructure and records where it matters: the real application,
the real login, the operator's own machine.

The limit is stated rather than discovered: a site with a strict `script-src`
CSP refuses to load the recorder and the bookmark does nothing there. That is the
site's policy working correctly. The bookmarklet says so in an `onerror` alert,
the UI says so before the operator tries, and the fallback is the designer.

**The capture path is the one Service Assurance route with no session**, because
its caller is a script on the customer's own site which has no BlueEye session
and cannot get one. So the surface is split — `/api/service-tests/recordings`
keeps the licence gate, `requireAuth` and RBAC; `/api/service-capture` has the
capture token and nothing else. What keeps that from being a hole:

- a token exists only because an authorised operator on a licensed install
  started a recording;
- it is stored as SHA-256, never as itself, and shown exactly once;
- it resolves only while the recording is live and unexpired (30 minutes by
  default, capped at 240) — an abandoned session is not a capture endpoint left
  open on the internet, and a background job deletes it;
- it reaches exactly one row, append-only: no read, no list, no way to name
  another recording;
- missing, unknown, expired and stopped all answer the same `401 Unauthorized`,
  so the endpoint never tells a caller holding a guess which part was right;
- CORS allows the origin and never credentials, so a browser attaches no cookie;
- the ingest is bounded at every level — 200 events per batch, 2000 per
  recording, 512 bytes per field — and an unrecognised key is dropped rather
  than stored.

**The password rule is now enforced twice, from one definition.** The recorder
sends `value: null` for a password field, but it runs on a page the customer
controls, so trusting it would be trusting the wrong side of the boundary; the
server scrubs again on arrival. Writing the second check turned up a real gap in
the first: the two copies of "what is a password field" had drifted, and only one
of them looked at the element's visible LABEL — so a field labelled
"Adgangskode" with an innocuous `id` kept its value. Both sides now read
`recording/secrets.js`. The match is deliberately generous: a false positive
costs one step the operator corrects in the designer; a false negative puts a
real password in the database, the version history and the audit log.

Accepting a recording clears its raw events. The test is the artefact now, and
keeping the capture would keep a copy of everything the operator typed long after
it stopped being useful.

The translation learned one more thing while this was being tested end to end:
a navigation that FOLLOWED a click is a consequence, not an instruction. It now
becomes `assert_url_contains`. Replaying it as `open` was actively harmful — the
test would navigate straight to `/dashboard` and pass whether or not the login
that was supposed to take it there worked.

The ingest carries a rate limiter of its own (120 requests a minute), like the
other session-less endpoints. Generous on purpose: a real recording flushes
every two seconds for hours, and cutting an operator off mid-journey would be a
worse failure than the volume it guards against — which is also why a 429 backs
the recorder off (doubling its interval, up to 30 s) and re-queues the batch
rather than ending the recording. Only a 401 is terminal.

Two bookmarklet limits are documented rather than discovered: a strict
`script-src` CSP refuses to load the recorder at all, and a full page load
removes it — clicking the bookmark again resumes the *same* recording, and the
re-injection records the new page as the next step. Single-page applications
need one click for the whole journey.

Migration 082 adds `service_test_recordings`.

## 0.124.7 — recording: the translation to the existing DSL

The first half of V2 §1. A captured browser session becomes a definition —
`{ version, name, steps }`, the same object the designer edits, the validator
checks and the runner executes. That is the guardrail the spec states outright:
recording must not introduce a second test model, and a spec pins it by running
the output through `validateDefinition()` and asserting every emitted step type
is one the DSL already knows.

Every decision about what an observation MEANS lives here, pure and testable, so
the browser-side recorder can stay dumb and only observe:

- **A recorded password is never a literal.** It becomes
  `{{credential.password}}`, and a username field becomes
  `{{credential.username}}`. A real password in a definition would reach the
  database, the version history, the audit log and the designer's screen — and
  pin the test to one person's account. The field is recognised by input type OR
  by name/autocomplete, because a login form that uses `type="text"` is common
  and would otherwise leak.
- **Typing collapses** to one `fill` with the final value. Nobody wants a test
  that types a, ad, adm, admi, admin.
- **The focusing click is dropped** — clicking into a box and typing produces a
  click and an input on the same element, and the fill already implies reaching
  it. A click on a real control is never dropped.
- **Addresses become paths**, so a recorded test runs against whichever
  environment it is pointed at. Another host is kept whole rather than silently
  rewritten to point at the wrong site.
- **It never throws.** A recording arrives from a browser — truncated, out of
  order, carrying events from a version that did not exist when it started. Four
  good steps beat an error.

Not yet built: how the browser captures. The recorder has to run on the target
site, and the three ways of doing that (bookmarklet, extension, headful remote
browser) differ enough in infrastructure and attack surface to be a decision
rather than a detail — see docs/service-assurance-v2.md §1, which sets out the
trade-offs. The translation layer is identical under all three, which is why it
is built first and separately.

## 0.124.6 — the Health chart is a trend, one line per application

The ranking shipped in 0.124.5 answered "who was worst this month" but not "when
did it happen" — and when did it happen is the question a chart is for. It is a
time chart now: one line per application over the period's buckets, which is the
shape the request actually asked for.

**Which applications get a line:** the ones you select, or — when you have
selected none — the top few by incident count, so the chart opens on the services
that had the worst period. The searchable multi-select is how you ask about a
specific one.

**Three chart types**, chosen from the toolbar: line for a trend, grouped bars to
compare buckets side by side, stacked bars to read a total with its composition.
The data is identical in all three, so switching redraws from what is already in
hand and never re-fetches.

Empty buckets are in the answer as zeroes. A line that skips them lies about when
the trouble was: "it was quiet all week and then Thursday happened" only exists if
Monday to Wednesday are drawn.

**The palette is the design system's eight categorical slots, in their fixed
order** — that order is the colourblind-safety mechanism, not decoration. It was
run through the palette validator in both light and dark rather than eyeballed:
all eight clear the lightness band, chroma floor, adjacent CVD separation (worst
ΔE 9.1 light / 8.4 dark against a ≥8 target) and the normal-vision floor. Light
mode warns that three slots sit below 3:1 on the surface; the legend names every
series with its total, which satisfies the relief rule and doubles as the table
view. A ninth application folds into a neutral "Other" rather than getting a
generated hue nobody could tell from slot 3, and colour follows the application
rather than its rank, so narrowing the filter never repaints the survivors.

## 0.124.5 — which applications gave us the most trouble

The Health page counted open incidents and listed them. It could not answer the
question a service owner actually opens it with: *which of my services has been
the problem this month?*

A ranking of the applications with the most critical incidents, over a chosen
period — **month by default**, because the Health page's question is "how has
this month been", not "what happened in the last hour". Day / week / month / year
with a date picker and ◀ ▶ navigation, reusing the same `resolvePeriod()` the run
chart already uses, so "last month" means one thing in this install and the
buttons never do calendar arithmetic of their own.

Counted by when the incident **opened**, not by whether it is still open: a
problem that was raised and fixed inside the period is part of that period's
answer.

**A searchable, multiple-choice application filter.** Hand-rolled, because the
repo ships no UI library and is not about to grow one for a dropdown — and
deliberately not a native `<select multiple>`, which has no search and asks
people to ctrl-click to keep a selection. No selection means all; an EMPTY
selection means none, because "show me none of them" is a legitimate thing for a
multi-select to say and answering it with everything would be a lie.

Horizontal bars, one hue. Long application names would become rotated stubs on a
vertical column chart, and the bars reuse `.sa-bar-failed` — the red this page
already uses for "this is the bad one" — rather than introducing a second red for
the same concept. Because every bar is that one colour, filtering the list cannot
repaint the survivors; and with a single series the title carries the identity, so
there is no legend to read. Every bar is directly labelled: ten is few enough that
nobody should have to measure a bar against a gridline.

An empty ranking says "no critical incidents in this period" in words. An empty
chart area reads as broken, which is the opposite of the news.

`GET /api/service-tests/assurance/top-applications` — viewer+, every parameter
validated rather than coerced.

## 0.124.4 — which layer failed, and what a reroute cost

Two halves of the same question: when something breaks, *where* did it break?

**API correlation (V2 §5).** The runner watched every request the page made and
kept only the failures — no method, no timing. So "The server rejected the
request" could never be resolved into *which* request. Every `xhr`/`fetch`/
`document` call is now recorded with method, masked URL, status and duration, and
the run page reads as `Browser ✓ · Page ✓ · API ✗ · HTTP 503` over a table of
what failed and what was slowest. Three answers rather than one: "the test
failed" is what the operator already knows.

Not stored, on purpose: bodies, headers, cookies. URLs keep their sensitive query
values masked (`token`, `api_key`, `session`, …) and userinfo credentials
dropped — masked on the way IN, so a secret that never enters the column cannot
leave it through a template someone forgot to scrub. Images, fonts and
stylesheets are not recorded at all: a page load is a hundred of them and none
says whether the service works. Migration 081 adds `service_test_runs.api_calls`.

Collected on every run, not only a failing one — a test that passes while a
background call answers 503 is a service that is half-broken, and that run is the
one nobody would think to open.

**A reroute now says what it cost (V2 §6).** BlueEye already detected AS-path
changes; it could not say what the change did to the latency, and "the path
changed" is a fact an operator can do nothing with. A path-change finding carries
the round-trip time either side of it, and a reroute that measurably hurt is a
**WARN even when the origin AS is unchanged** — the case the old severity rule
could not see, because it only looked at the control plane.

The two sides are not symmetric, and the code says so rather than pretending.
A change is detected on the tick it happens, so the baseline is the **median** of
the runs on the old path — where noise protection is both needed and available —
while the new path usually has exactly one run. The sample counts are printed
("median of 1 run on the new path vs 12 on the old") instead of hidden, and a
shift counts only when it is material both relatively (≥25%) and absolutely
(≥10 ms): 15 ms on a 12 ms path is a different event from 15 ms on a 400 ms path.

Hop-level route-change detection is deliberately NOT added. ECMP means the hop
sequence legitimately differs run to run, so a hop-diff alarm would fire
constantly and be switched off within a week. The AS-path is the level at which a
change means something happened.

## 0.124.3 — a service that stopped working reaches the Changes page

The Changes feed merges ten sources under one premise: *what happened while I was
away*. Service Assurance was not among them, so the customer portal refusing
logins since 02:00 was visible only in a module nobody opens at the start of a
shift — while an LLDP neighbour disappearing was on the landing page.

Incidents are now a source. One incident can contribute two rows — it opened,
and (if it resolved inside the window) it closed — exactly as a probe outage
does, and a recovery is reported at INFO rather than at the severity of the fault
it ended.

**Incidents rather than failing runs**, deliberately: a test failing every five
minutes all weekend is ONE thing that happened, and the raw runs would bury every
other source on the page. The kind is collapsible for the same reason, so a
flapping service folds instead of filling the feed.

The source is **licence-gated at call time**, not at wiring time. The sweep runs
whatever the plan says, so incidents exist on an unlicensed install too, and the
feed must not surface a feature the customer has not bought — checked per request
so a licence that changes needs no restart. A deployment without the module, or
with an older one that has no window query, contributes nothing rather than
failing the source and marking the whole page partial.

Also: **[docs/service-assurance-v2.md](docs/service-assurance-v2.md)** — the V2
scope (recording, journeys, self-healing selectors, API correlation, failure
intelligence, baselines, service map, visual regression, accessibility) as the
design of record, with its build order. V1's "what it is not" list said no
self-healing selectors and no visual regression; V2 reverses both, and §0 records
that rather than leaving two documents disagreeing with each other.

## 0.124.2 — concurrency is a real dial, and a failure says what was observed

**`runner.concurrency` did nothing.** It was stored, validated and shown in
Settings, and read by no code: the worker loop claimed exactly one job per tick
whatever it said — a throughput dial that wasn't one. A tick now claims up to
`concurrency` jobs and runs them side by side. Each lane builds its own browser
(`browserFactory` is per-job already, so a crashed page can never poison the
next), which is also why the number matters: every extra lane is another
Chromium. The setting is read per tick, so raising it takes effect on the next
poll rather than on a restart, and a settings read that fails falls back to one
lane instead of stopping the queue. Claiming is a conditional UPDATE, so N lanes
on one worker race each other exactly as N workers do.

Two dials, not one: `concurrency` adds lanes on the machine you have,
`docker compose --scale service-assurance-worker=N` adds machines. The worker
count stays deliberately un-settable from the dashboard — a worker is a separate
container, and for the server to start one it would need the Docker socket.

**A failure now shows what was actually observed.** The classifier has always
collected which request returned which status; the run page threw it away and
showed only the generic one-liner, so "The server rejected the request" gave an
operator no way to find out WHICH request. The observations are rendered above
"Technical details", in the operator's words.

And a request the **allowed-hosts policy refused** is named there. It is recorded
as evidence, never as the verdict — a page calling a third-party analytics or
geo-IP service is usually irrelevant to whether the service works, and guessing
that it caused the failure would be inventing a conclusion. But it is the one
line an operator cannot work out for themselves: the address is not one they
registered, the page asked for it, so a blocked call otherwise surfaces as an
unexplained failure somewhere else entirely — a login that never completes
because its script is waiting on a lookup that will never return.

**Service Assurance has its own nav section**, rather than one entry under
Diagnostics. It is a module with five screens, and "are my public services
working?" is not the question the network diagnostics tools answer. Each entry
deep-links into the module's own tab.
## 0.124.0 — Service Assurance: run history as a chart

A new **History** tab, and the same chart on each test's own history. It answers
the question the Runs list cannot: how has this been going.

**Segmented by day, week, month or year**, and you pick the specific one — ◀ ▶
step through periods, or jump straight to a date. One bar is an hour on a day, a
day on a week or a month, a month on a year. A period that has not happened yet
is not offered.

Two charts sharing the x positions: outcomes as stacked bars, average duration
as a line. Never one chart with two y-axes — "12 runs" and "1.4 s" share no
scale, and a second axis is the quickest way to make a chart say something
untrue.

**A gap stays a gap.** An empty bucket is drawn with a baseline tick and the
duration line breaks over it, because "it stopped running on Thursday" is
exactly the reading this chart exists for — and an hour nothing ran in is not an
hour everything was instant.

**Days are cut in the viewer's time zone.** The browser sends its
`getTimezoneOffset()` and the query shifts timestamps before grouping. Bucketing
in UTC files the first two hours of a Copenhagen day under the day before, and
"Tuesday" has to mean the operator's Tuesday.

`GET /api/service-tests/stats?period=&at=&tz_offset=&test_id=&application_id=`
aggregates in SQL — a year of a five-minute schedule is ~105,000 rows and the
chart wants twelve numbers — and answers with every bucket in the period plus
where previous and next point, so the browser does no calendar arithmetic. The
calendar lives in one place, `src/serviceTests/stats/period.js`: a month is not
30 days and a DST day is not 24 hours.

The outcome colours were checked for colour-vision separation against the light
and the dark surface separately, rather than one set being auto-lightened for
dark mode.

**Also:** the module's CSS asked for `--fg`, which no theme defines — so every
input in Service Assurance rendered near-black text on a dark background. It is
`--text`, like the rest of the dashboard.

## 0.123.8 — one icon vocabulary: a trash can deletes, a × closes

A red "×" removed a step in the test designer while the same mark closed the
dialog two screens away. Now a red **trash can** is the only delete affordance
anywhere, and "×" only ever closes or cancels.

The step-row actions are inline SVG instead of font glyphs (✎ ● ⧉ ×). A glyph is
whatever the viewer's font decides — a different weight on every platform and
blurry at button size — where a stroked path is sharp at any zoom and inherits
the button's colour, so a `.danger` button draws a red can without a second rule.
They are 16px, two pixels larger than what they replaced, which were hard to hit
and harder to read. Enabled/disabled reads as an eye rather than ● / ○.

The two row-removers in the transaction editor carried the same red "×"; they are
trash cans too.

## 0.123.7 — repairing the tests that already carry the unfindable title step

0.123.6 stopped Discovery from SUGGESTING a title assertion that could never
pass. It could not do anything about the tests an operator had already accepted,
which still hold the broken step and still fail every run after the full step
timeout.

`npm run repair-title-assertions` turns them into the step they meant to be. It
is a dry run by default and lists what it would change; `-- --apply` writes.
Every write goes through the repository's own save(), so the old definition is
snapshotted into `service_test_test_versions` and the version is bumped — the
repair is auditable and revertable like any other edit, and running it twice is a
no-op.

It repairs one shape and nothing else: an `assert_text_contains` whose target is
exactly `{ text: X }` with a non-empty X equal to its own value. That cannot
collide with a hand-built step — the designer creates every targeted step as
`target: { text: '' }` and offers no way to edit a target afterwards, while
`value` is required and rejected when empty — so the shape is reachable only from
the suggestion generator. Steps nested in a condition block are repaired too.

**The step now reads as a sentence.** It rendered as
`Kontroller at teksten "X" indeholder "X"` — a tautology that said nothing about
what was being checked. It reads
`Kontroller at siden identificeres med titlen "X"`, and a failure says what the
title actually was.

**The failure screenshot was always a broken image.** It was
`<img src="/api/service-tests/runs/:id/screenshot">`, and an `<img>` cannot send
the `Authorization` header this dashboard authenticates with — so the request
arrived anonymous, answered 401, and the browser drew a broken-image icon. It is
fetched with the header and shown as an object URL, the way the CSV export
already worked, and only when the section is actually opened.

## 0.123.6 — a suggested test asserted a title that could never be found

Two things went wrong on the same screen, and they compounded.

**The suggested Login test could not pass on any site.** Its last step asserted
that the page contains the title of the page behind the login — but a title lives
in `<title>`, in `<head>`, and a text target resolves through `getByText`, which
only sees the body. The step was hunting the page for a string that is not on it.
It burned the full 30-second step timeout and failed with
`teksten "..." blev ikke fundet`, no matter how well the login itself worked. The
Availability suggestion had the identical step, so every accepted suggestion of
either kind failed on its last step.

There is a real step for this now: **`assert_title_contains`** reads the document
title instead of trying to locate it, and both rules use it. Where Discovery
recorded no title, the Login rule falls back to the address assertion it already
had. A worker that predates the step reports "no title" rather than crashing with
`driver.pageTitle is not a function`.

**The Runs screen did not say what each run was a run OF.** It lists every test
in the install together, and a row showed only a status, a time and an error — so
four failures from one site and a pass from another read as one service flapping,
and a test against a completely different host looked like the same failure
again. Runs now carry the test, application and environment names (one LEFT JOIN
on the read a human makes; the worker's claim path deliberately still doesn't pay
for it), and each row shows `Test · Application · Environment · scheduled`.

The "NEXT RUN" column header was also wrong — it labelled the time the run
STARTED with the schedule's "next run" string. It says Started now.

`GET /api/service-tests/runs` takes `?application_id=` so the list can be scoped
to one application.

## 0.123.5 — migration 080 could not be applied: a duplicate constraint name

The deploy died on the first statement of the migration the last release
shipped:

```
Applying migration: 080_create_service_assurance_reactions.sql
Migration 080 failed: Duplicate foreign key constraint name 'fk_stc_app'
```

InnoDB foreign key constraint names are **schema-global**, not per-table.
`service_test_credentials` has carried `fk_stc_app` since migration 078, and
`service_test_certificates` — also "stc" — asked for it again. MySQL refuses the
second one, so no table was created, no `schema_migrations` row was written, and
the server exited 1 before it ever started. Nothing in Service Assurance ran on
the new release.

The certificate table's keys are `stcert` now (`fk_stcert_app`, `fk_stcert_env`,
`uq_stcert_target`, `idx_stcert_*`). Migration 080 is corrected in place rather
than superseded by an 081: it failed on its first statement everywhere it ran, so
there is no partially-created table to repair and a re-run is clean.

**Why no test caught it.** There is no MySQL in the test run, so `schema.sql` is
verified structurally — and a duplicate constraint name is perfectly well-formed
SQL right up until a server tries to create the second one. Constraint names
being global is exactly what makes this checkable from the file alone, so
`test/schemaSnapshot.test.js` now sweeps all 73 foreign keys for a reused name.
It fails on the shipped migration and passes on the corrected one.

## 0.123.4 — Service Assurance reacts to what it finds

The module recorded and stopped. A scheduled test failed at 02:00, `classify.js`
wrote "The TLS certificate is expired, self-signed, or issued for a different
name" in plain language, the run row was saved — and nobody read it until a
customer called. Worse, nothing looked at a certificate at all until it had
already broken a test, which is the day after it should have been renewed.

Two things changed.

**Certificates are watched on their own schedule.** Every https address you have
registered — an application's base URL and its enabled environments' — gets a TLS
handshake every six hours (`assurance.certificateCheckIntervalMinutes`). The
handshake reads the certificate and nothing else: no HTTP is sent, and the socket
is dropped the moment the certificate is in hand. `rejectUnauthorized: false` is
deliberate — refusing an expired certificate would report "unreachable" and lose
the fact we came for — so the certificate is inspected first and judged second.
An expiry becomes a warning at 30 days and critical at 7, both configurable.

**Failures and expiries become incidents, and incidents become alerts.** One open
row per subject (`test:<id>`, `certificate:<app>:<host>:<port>`): opened when the
condition holds, escalated when it worsens, resolved when the next check is
healthy. A service down all weekend is one incident with 400 occurrences, not 400
incidents. An alert goes out on a state CHANGE — opened, escalated WARN→CRIT,
resolved — never once per observation, and through the same email/webhook/syslog
dispatcher as every analysis finding, so severity floors, cooldowns and
maintenance windows already apply.

The policy says what is worth waking someone for: DNS, a refused connection, a
TLS failure or a 5xx opens CRIT; a missing element or a failed assertion opens
WARN and never escalates past it, because a renamed button is the test drifting,
not the service failing. One failing run is a bad minute — two in a row is an
incident (`assurance.failureStreak`).

New: the **Health** tab (open incidents + every watched certificate, with "Check
certificates now"), the `assurance` settings section, `GET/POST
/api/service-tests/assurance/*`, and migration 080
(`service_test_certificates`, `service_test_incidents`).

The sweep runs in the API process, not the browser worker — it needs no browser,
and the alerting config lives there. So an install with no worker connected at
all still gets its certificates watched.

## 0.122.3 — the flaky test, named and fixed

The gate's new failure reporting caught it on the second try. It was not a
timing flake at all:

```
not ok 2066 - POST creates an integration; credentials are encrypted at rest
              and never returned
  assert.ok(!repo.rows[0].credentials_encrypted.includes('pw'))
```

The test fixture's password was the two-character string `pw`, and the
assertion looked for it inside the stored ciphertext. The stored form is
base64url, so the sequence `pw` turns up in the ciphertext **by chance** —
measured at 2.7% per encryption over 20,000 samples. Two files did this, so
roughly one suite run in eighteen failed, on correct code, with a message that
reads like a credential leak.

It also proved nothing when it passed: two characters of base64 is noise, not
evidence that a secret is encrypted. The fixtures now use a long, distinctive
password, which both removes the collision and makes the assertion mean what it
says. `test/secretBox.test.js` had the same shape with `svc` (one run in 5,000)
and is fixed with it.

Fixed in `test/integrationsApi.test.js`, `test/cmdbApi.test.js` and
`test/secretBox.test.js`. No production code changed — the encryption was
always correct.

## 0.122.2 — a failing gate now says which test failed

`main` went red after the last merge with `# fail 1` out of 3236 and no name.
The name is printed thousands of lines earlier in the TAP stream, and CI logs
are read through an API that returns the tail — so the one thing needed to fix
it was the one thing not visible. `scripts/gate.sh` now keeps each phase's
output and prints the failing test names at the end, next to the BLOCKED line.

**And two tests that asserted "eventually" with a fixed sleep.** Both wait for
an asynchronous thing to finish and then assert the result:

- `baselineCache` — `write()` is fire-and-forget (`mkdir` + `writeFile`) and the
  test slept 50 ms before reading the file back.
- `agentBinaryStore` — six waits of 50-200 ms for an async build to settle.

That encodes a guess about how fast the machine is: fine on a laptop, not on a
loaded CI runner, where it surfaces as one unexplained failure in a few thousand
that a re-run "fixes". They now poll for the condition with a generous deadline
via `test-support/waitFor.js` — the same assertion, without the timing
assumption, and faster on a fast machine.

Left alone: the waits that assert something did NOT happen (a debounce window,
a dropped result). There is nothing to poll for there, and a slow machine only
gives the unwanted event more time to appear — it cannot fail falsely.

This is not proof that either test caused the red run; the failure has not been
reproduced locally in fourteen runs, eight of them under load. It is the
plausible cause removed, and the reporting that will name the next one.

## 0.122.1 — the worker image was missing four files it requires

The worker still died at boot on a real deployment, for a second reason the
local fix could not show: `docker/Dockerfile.service-test-worker` copies a
hand-picked subset of the repo, and `src/config.js` was in it while the three
files it requires — `src/license/publicKey.js`, `src/license/serverIdentity.js`,
`src/enroll/fingerprint.js` (and through it `trustAnchorGuard.js`) — were not.
Inside the container that is MODULE_NOT_FOUND before the first line of
`main()`. Outside it, in a full checkout, the same code runs fine, which is why
it passed every test.

The worker no longer requires the server's config at all. The two things it
actually needs — the database connection and the secret key — move to
`src/lib/coreEnv.js`, which `src/config.js` now uses as well, so there is one
definition and two readers rather than a copy that drifts.

`test/serviceTestWorkerImage.test.js` walks the require graph from the
entrypoint and fails when a file in it is not covered by a COPY line. It fails
on the old Dockerfile and passes on the new one. The image's exact file set was
also run end to end: it reaches "polling for work".

## 0.122.0 — the Service Assurance worker actually starts

**The worker had never run.** `scripts/service-test-worker.js` did
`const config = require('../src/config')` where that module exports `{ config }`,
so `config.db` was undefined and the process died on the first statement of
`main()`. Docker reports that as `Started`, then restarts it, forever — and the
dashboard says no worker is connected, which is true and says nothing about why.
One word, and it made the whole feature inert.

A boot smoke test now spawns the entrypoint against a dead database and requires
it to reach "polling for work". The rest of the suite drives the worker loop with
injected fakes and never runs the entrypoint, which is exactly how this survived
a release. `test/serverBoot.test.js` guards `src/server.js` the same way.

**`scripts/deploy.sh` deploys the worker too.** It sits behind a compose profile,
so a deploy rebuilt the server and left the worker on old code. The script now
rebuilds it on any host that already has one and keeps the replica count it finds
there — three stay three. Opt in the first time with
`BLUEEYE_SERVICE_ASSURANCE=1`, choose a count with `BLUEEYE_ASSURANCE_WORKERS=n`,
and `=0` stops them. A deployment that does not use Service Assurance still
builds nothing extra.

## 0.121.0 — Service Assurance: the worker can say it is running

**A running worker was reported as missing.** Worker liveness was inferred from
the newest claim on the run queue, so a worker that had never been given
anything to do looked exactly like a worker that was never installed — and the
dashboard told the operator to go and set up the one they had just started. That
is the state every new install is in.

Workers now write a heartbeat (`service_test_workers`, migration 079) on every
poll tick, before anything else in the tick can fail. `worker-status` reports the
connected workers with host, version and last heartbeat; the claim-derived answer
stays as the fallback for a worker older than the table. A worker counts as gone
once its heartbeat is older than `queue.workerHeartbeatTimeoutMs` (60 s,
adjustable in Settings), and rows unseen for a week are pruned by the same sweep
that reaps abandoned runs.

**Administration → Settings → Service Assurance now opens with Workers** — the
list of what the server can actually see, so "is my worker running?" is answered
where the question gets asked, without queueing a test first. The Runs tab says
how many are connected instead of only warning when none are.

**`SECRET_ENCRYPTION_KEY` never reached the server container.** The compose file
passed it to the worker only. Set it in `.env` and the two sides derived
different keys, so every test with a login would have failed with "credential
unavailable" — the exact quiet failure the variable is commented as avoiding.
Both services read it now.

**`SERVICE_TEST_ARTIFACT_ROOT` is documented as what it is:** a path inside the
container, backed by a named volume mounted at the same path in both the server
and the worker. Setting it in `.env` does nothing in the Docker stack, because
the compose file has to keep it in step with the mount point. Outside Docker it
is yours to set, and there it is a host path. The handbook article and
`docs/service-assurance.md` both say so, with the `docker volume inspect` command
for finding where the bytes really are.

## 0.120.4 — Service Assurance: documentation, and a form that says why

**There was no documentation for Service Assurance at all.** The handbook had an
article for every other feature and nothing for this one, while the UI told
people to "see the documentation" without saying which. Two articles now exist:

- **Watch a web service with Service Assurance** (everyone) — the short version
  of the journey, what Discovery will and will not do, how to read a failure
  including a symptom/meaning/action table, and how logins are handled.
- **Starting the Service Assurance worker** (admins) — the compose profile, the
  standalone command, the two settings that must match this server and what
  breaks quietly when they do not, and how to tell it is working.

The "no worker" banner now links straight to that article for an administrator,
and tells an operator who can start one rather than sending them to a page their
role cannot open. The toast names the article, since a toast cannot carry a link.

**A form said "Validation failed" and stopped there.** The server had sent one
message per field; the client read `e.details` and `e.body.details` while
`api()` puts the parsed body on `e.data`. The reason was discarded on arrival.
Forms now show what the server actually said.

**A placeholder that read as a filled value.** The environment Name field showed
`Production` as its placeholder, which looks typed — so Save was pressed with an
empty name, and the resulting error was the bare "Validation failed" above. It
and the allowed-hosts field now read as examples.

**Export rendered as a bare link.** It sat between two buttons wearing
`ghost small`, which the shared stylesheet defines for `<button>`. It stays an
anchor, because it is a download, and now looks like its neighbours.

## 0.120.3 — Service Assurance: the things using it exposed

Five fixes from a first run through the module.

**The literal word "null" on the page.** `replaceChildren()` is native and takes
`(Node | string)`, so a conditional child written the obvious way —
`isAdmin() ? button : null` — was stringified and rendered. `el()` already
filtered those; a `mount()` helper now gives `replaceChildren` the same manners,
and all 30 call sites go through it.

**Empty states that described the wrong thing.** The global Runs tab said "This
test has not run yet" when no test anywhere had run; the global Schedules tab
said "This test does not run automatically". Both now speak for the whole list
and say what to do next, and the Discovery card explains what Discover will do
instead of just reporting absence.

**No way to create a schedule.** A schedule could only be added from inside a
test. The Schedules tab now has its own create action with a test picker, and
lists which test each schedule belongs to — a schedule list without the test
name is unreadable.

**Settings were in the wrong place, under the wrong names.** Every value there is
system-wide, so they now live in **Administration → Settings → Service
Assurance** with the rest of BlueEye's global configuration, licence pill and
all. What is per-application — base URL, environments, logins, allowed hosts —
stays on the application page. And the fields have human labels with units:
"Stop the whole crawl after — milliseconds", not `maxDurationMs`.

**Tab accepts a placeholder that is a prefix.** `https://` in an empty address
field is something you will type, not a hint about shape. Tab writes it and
leaves the caret at the end. Only when the field is empty — Tab keeps its normal
meaning the moment there is any text.

Also: the dashboard's live WebSocket no longer retries a refused upgrade forever.
An expired token makes the server answer 401 and destroy the socket, which a
browser reports only as a generic "can't establish a connection" — so the client
retried every four seconds indefinitely, hammering the server and burying the
real cause (a stale session) under console noise that looks like a proxy fault.
It now backs off, and after a few refusals asks the REST API who it is, which
runs the same "Session expired" path every other call uses.

## 0.120.2 — deploy-licens.sh says when blueeye-server is the stale one

Deploying the licence server failed on a service it was never asked to touch:

    error while interpolating services.service-assurance-worker.environment.JWT_SECRET:
    required variable JWT_SECRET is missing a value

`deploy-licens.sh` updates blueeye-licens, but the compose file it runs lives in
blueeye-server — and `docker compose` interpolates EVERY service in that file,
including ones outside the active profile. So an out-of-date blueeye-server
checkout breaks a licens deploy, and the error names a variable belonging to a
service nobody was deploying. (The variable itself was 0.120.1's fix; this is
about the operator having no way to tell.)

The script now checks before the compose step whether blueeye-server is behind
its remote, and if so says how far, why that matters here, and the exact command
to fix it. It is a warning, not a stop — a licens deploy against an older server
checkout is legitimate — and an unreachable remote reports "could not check"
rather than refusing to continue.

`deploy.sh` needs nothing: it pulls blueeye-server itself, so it is never the
stale one.

## 0.120.1 — Service Assurance: wire the worker to the stack it actually runs in

Two deployment bugs in the compose wiring from 0.120.0. Both would have failed
quietly, which is why they are worth a release of their own.

**The worker asked for a variable that does not exist.** Its service read
`${JWT_SECRET}`, but `.env` carries `SERVER_JWT_SECRET` and `LICENS_JWT_SECRET` —
one per service. Compose would have refused to start the worker. Worse if someone
had "fixed" it by inventing a `JWT_SECRET`: the worker decrypts the credentials
the API server encrypted, and both derive that AES key from
`SECRET_ENCRYPTION_KEY` falling back to `JWT_SECRET`, so a different value means
every test with a login fails with "credential unavailable" and nothing says why.
The worker now reads the same `SERVER_JWT_SECRET` the server service does.

**Screenshots were written where nobody could read them.** The worker mounted the
artefact volume and the API server did not, so a failure screenshot was captured
into a volume the process serving `/runs/:id/screenshot` could not see. Both now
mount the same named volume at the same path, and the server carries
`SERVICE_TEST_ARTIFACT_ROOT` to match.

`docs/service-assurance.md` now names both couplings explicitly rather than
leaving them to be discovered.

## 0.120.0 — BlueEye Service Assurance

**Know when your digital services stop working — before your users do.**

A new module, reachable from **Service Assurance** in the sidebar. Register the
web application you depend on, let Discovery look around it, accept the tests it
suggests, and run them on a schedule from a real browser. Nothing in the normal
flow requires code: steps are built by dragging them into order and filling in
forms, and the raw engine error lives behind "Technical details".

**The stored test never mentions Playwright.** A definition is a list of intents
("fill the field labelled Username"), and the runner decides how to carry them
out. `driver.js` is the only file in the module that requires `playwright-core`,
so the whole meaning of a test — step order, credential resolution, conditional
blocks, stop-at-first-failure — is exercised in the suite with no browser and no
network anywhere near it. Swapping to WebDriver BiDi later is a second driver,
not a rewrite, and not a single saved test changes.

**The browser runs in its own process.** `POST /tests/:id/run` queues a row and
returns 202; the worker (`npm run service-test-worker`, or the
`service-assurance` compose profile) claims it with a conditional
`UPDATE … WHERE status = 'queued'`. Several workers are therefore safe from day
one — `--scale service-assurance-worker=3` and none of them run the same job
twice. The server image is unchanged and carries no browser: the worker is a
separate Debian image with Chromium from apt, so nothing is fetched from a vendor
CDN at build time.

**SSRF gets two independent checks, and both must pass.** A permanent deny-list
(non-http(s) schemes, loopback, link-local, cloud metadata) that nothing can
unlock at any permission level, and a per-application allowlist that decides what
may be targeted. RFC1918 *is* allowlistable — on-prem applications live there —
and it takes an explicit, audited, admin-only entry naming a host, an address or
a CIDR range, with CSV import/export and a dry run. Ranges are capped across the
whole application, so twenty /24s cannot beat a limit a single /19 would hit. An
allowlisted hostname is resolved and every address it points at is judged again,
which closes the rebinding gap a literal-only guard leaves open. The policy runs
again at request time through Playwright's router, so a page cannot pull a
resource from somewhere it should not.

**Discovery is read-only, and fail-closed about it.** It never submits a form and
never clicks anything whose effect it cannot determine — an unlabelled button is
recorded and left alone rather than assumed safe. Suggestions are rule-based, not
AI, and each carries the reason it was proposed: *"Detected 1 password field, a
username field, a Login button."* A login flow is only ever claimed when a
password field is actually present.

**A failure is explained before it is dumped.** Step 4, "Klik på knappen Log
ind", `HTTP 503 from /api/auth/login`, likely cause: the service behind this
address. A 503 on the wire outranks the driver's own "timeout", because the
status is the useful half when both are true. A screenshot is captured on failure
only, after password fields are masked in the DOM.

**Credentials never surface.** They are encrypted with the existing `secretBox`,
decrypted only inside the worker, and every string leaving a run passes a
redactor seeded with the run's own secrets. A password too short to mask safely
is refused at entry rather than being unmaskable later.

Also: every limit — discovery budgets, the allowlist caps, runner timeouts,
screenshot retention — is stored in the database and changes from the UI without
a redeploy. Artefact retention ships with it, because one five-minute test
failing across a weekend writes ~115 MB/day at PNG sizes.

`service_tests` becomes an available Professional feature. 3221 tests, gate green.

## 0.119.0 — Service Tests, phase 1: the data model and the storage layer

First code for **Service Tests** (docs/service-assurance.md) — the no-code module for
verifying that critical web services and user journeys actually work. This is the
foundation only: 15 tables, the repositories over them, and the settings layer.
No routes, no Playwright, no UI yet.

**Migration 078** adds the `service_test_*` tables. Two things about their shape
are deliberate. There are **no foreign keys in either direction between these
tables and the rest of BlueEye** — the module is meant to be liftable out and run
standalone, and a cross-schema key would nail it down. And `service_test_runs`
**is the job queue**: a run is inserted `queued` and a worker claims it with a
conditional `UPDATE … WHERE id = ? AND status = 'queued'`, so two workers racing
for one row produce one winner and one miss rather than two executions. There is
no SELECT-then-UPDATE window anywhere in the repository.

**Every Service Tests limit lives in the database**, not in an environment
variable. `settings/defaults.js` holds the shipped default and the bounds for each
field; `service_test_settings` holds the override; the effective value is the merge.
An operator changes a discovery budget, the allowlist address cap, a runner timeout
or the screenshot retention window from the UI, and it applies without a redeploy.
A stored row that is unknown or out of bounds is discarded in favour of the
default, so a bad write can never quietly widen a security control.

**`src/serviceTests/ports.js`** is the module's whole dependency on its host. No
file under `src/serviceTests/` requires a BlueEye module; db, secrets, audit,
logger and clock arrive through one object. Extraction later means implementing
those ports against something else, not hunting for reach-ins.

Credentials are encrypted with the existing `secretBox` and **no read path returns
the plaintext** — `list()` and `findById()` report only `has_secret`, and a single
worker-only method decrypts. A rotated key or a tampered row yields null rather
than a wrong value.

**Licence key registered.** `service_tests` joins the catalogue as a Professional
feature with `status: 'roadmap'`, per the ROADMAP process of registering a key
before the work starts. Two existing tests needed a minimal update for that: the
roadmap-key assertion now names the queued key, and the UI gate's `data-feature`
check accepted only the four legacy proof keys, so **no plan-catalogue key could
pass it at all** — it now checks against the real set. That widens the sweep
rather than loosening it.

51 new specs cover the storage boundary: which statement is issued, with which
parameters, in which transaction, and how rows are shaped. Suite is 3085 tests.

Nothing is mounted yet, on purpose. Migration 046's first cut shipped tables whose
repository was never constructed, so no rows were ever written; here the wiring
lands in the same commit as the routes that use it.

## 0.118.5 — Service Tests: the three open decisions, answered

The plan in `docs/service-assurance.md` ended with three questions. All three are now
settled and written into it.

**Browser engine.** There is no European alternative worth switching to: the
binding constraint is the engine, not the automation library, and Chromium, Gecko
and WebKit are all US-origin. Servo is the only European-governed engine (Linux
Foundation Europe) and cannot run real web apps yet. Playwright also sits outside
what the "no US vendors" convention targets — that rule is about services called
over the network at runtime, and Playwright is Apache-2.0 source running locally
with no telemetry. Its one real US dependency is the browser download at install
time, which distro Chromium removes. The durable protection is the seam:
`driver.js` is the only file that touches Playwright, so WebDriver BiDi later
means a second driver, not a rewrite.

**Disk usage** gets its own section. The server image does not change at all — the
worker is a separate image behind a compose profile, the way `licens` already is.
`playwright-core` instead of `playwright`, Chromium only, Chromium from apt rather
than a vendor CDN, and a worker image that copies only what it needs. The section
also names the growth risk people miss: screenshots, where one five-minute test
failing across a weekend writes ~115 MB/day. Failure-only capture, WebP, a per-run
cap and a retention job on the existing `src/analysis/retention/` pattern.

**The host allowlist** stays optional and empty by default, and now accepts whole
**IP segments** and **host lists**, with CSV import/export and a dry-run preview.
`src/discovery/cidr.js` already has the maths, including an address count that
never enumerates. Ranges are capped (nothing shorter than a `/16`, 65 536
addresses per application by default), and the split that matters is written down:
RFC1918 is allowlistable because on-prem applications live there, while loopback
and cloud-metadata addresses can never be unlocked at any privilege level.

**Licence and RBAC, both.** `service_tests` becomes a Professional-tier feature
key; once the licence permits the module, access inside it is decided by role.
Two existing tests need a minimal, documented update for that — the UI gate checks
`data-feature` against the four legacy proof keys only, so no plan-catalogue key
can currently pass it, and the roadmap-key assertion has to allow a queued item.

Still plan only — no Service Tests code ships in this version.

## 0.118.4 — Service Tests V1: the integration plan

`docs/service-assurance.md` records the agreed design for **Service Tests** — the
no-code module where an operator registers a web application, runs Discovery,
accepts suggested tests, builds them with drag & drop, runs them and schedules
them. Plan only: no Service Tests code ships in this version.

What the plan pins down:

- **One module root** (`src/serviceTests/`) reached through a single factory and
  an adapter object, so the module can later run standalone. Its footprint in
  existing UI code is one nav button, one `views.serviceTests` line and one
  `PAGE_INFO` entry.
- **A neutral DSL** — the stored test definition never mentions Playwright.
  `execute.js` dispatches steps onto an injected driver, so the runner is unit
  tested offline against a fake.
- **Playwright stays out of the Express request lifecycle.** Runs are queued in
  `service_test_runs` and claimed atomically by a separate worker process on its
  own Debian + distro-Chromium image; the server image keeps no browser.
- **SSRF is the module's central risk** and gets its own policy: scheme
  allowlist, per-application host allowlist, a resolved-IP check that closes the
  DNS-rebinding gap, enforced again at request time through `page.route()`.
  Reaching an on-prem RFC1918 application takes an explicit, audited, admin-only
  allowlist entry — one host at a time.
- **Reuse over reinvention** — `secretBox` for credentials, `ssrfGuard` as the
  policy's base, the existing JWT/role middleware, audit logger and background-job
  contract. Nothing changes in blueeye-agent or blueeye-licens.

Three decisions are listed for sign-off before code: the Playwright/Chromium
worker image, the private-host allowlist, and whether Service Tests is licence-gated.

## 0.118.3 — One page width, framed data, and a bulk delete for expired codes

Every page came out a different width. Measured in a browser at 1920px:
Overview 1134px, Enrollment 1590px, Agents 650px, Settings 1617px — on the same
screen, in the same session.

`main#view` is a flex item in the `.shell` column, and `margin: 0 auto` there
beats the default `stretch`, so each page shrank to fit its own content. It is
now `width: 100%` capped at `--page-max` (1440px) and centred: the same four
pages all measure 1440px.

Data no longer floats on the page background:

- **A table, a scrolling table wrapper and a standalone empty state are
  surfaces** — panel background, border, resting elevation, the same treatment
  the Overview page's panels already had. A table drawn inside another surface
  still opts out.
- **`dataCard()`** frames a section that has its own heading, actions and note:
  the card carries the frame and the table runs flush to its edges. Enrollment's
  "Active codes" is the first section on it.

Enrollment also gets **Delete all expired (n)**, beside "+ New code":

- Admin-only, and shown only when there is something to clear.
- It deletes exactly the codes badged `expired` — timed out with uses left — so
  a `used` code, the one an enrolled agent is listed beside, is never swept up.
  No agent is disconnected either way: an enrolled agent holds its own permanent
  token, independent of the code.
- `DELETE /enrollment-codes/expired` answers `{ deleted: n }`; deleting nothing
  is a success, not a 404.

## 0.117.3 — The cross-agent sweep stops shouting the same fact every minute

A production log looked like this, sixty seconds apart, forever:

```
INFO cross-agent: cluster 771 kept open — unacknowledged CRIT member.
INFO cross-agent: cluster 773 kept open — unacknowledged CRIT member.
INFO cross-agent: cluster 774 kept open — unacknowledged CRIT member.
… 70 more
```

The retention rule never auto-closes a cluster that still holds an
unacknowledged CRIT finding, and the sweep re-checks every 60 seconds — so each
held cluster restated itself ~1 440 times a day. A fleet holding 70 of them
produced roughly 100 000 INFO lines a day, which buried every other line in
`docker compose logs` and filled the dashboard's admin Logs view with one
repeating sentence.

The count is the news, not the individual clusters:

- **One INFO line reports how many are held, and only when that number moves** —
  `70 inactive cluster(s) kept open — unacknowledged CRIT member.` — plus a
  single line when it reaches zero. Steady state is now silent.
- **The per-cluster detail drops to `debug`**, so `LOG_LEVEL=debug` still names
  them. Below the configured level the record is dropped before it reaches the
  log ring, so it costs nothing in production.

This matches how the same sweep already reported the other half of its work
(`resolved N inactive cluster(s).` has always been one summarised line).

Nothing about the retention rule itself changed: a cluster with an
unacknowledged CRIT member is still never auto-closed.

## 0.117.2 — A softer dashboard

The dashboard chrome has been redrawn around one token scale. Nothing moved and
nothing was renamed — panels, tables, chips and overlays just share a softer,
more consistent surface treatment across all 13 palettes.

What changed:

- **Wider radii, hairline dividers, shadows you feel rather than see.** A card
  is a panel background, a `1px` border and `var(--shadow)`. The line *between*
  rows inside it is `var(--hairline)` — lighter than the line *around* it, so a
  long table stops reading as a grid of cages.
- **One radius scale** — `--radius-xs` … `--radius-pill` (8/10/12/16/999px), one
  step per surface size. The ~60 hard-coded `border-radius: Npx` declarations
  now reference it. Literal radii are left only where they describe a shape
  (status dots, 3px bars).
- **Three elevation tokens** — resting, lifted, overlay. Interactive cards lift
  on hover instead of growing a heavier edge. Dark palettes restate the three
  (and only those), because a light shadow is invisible on a dark panel.
- **Status colour is derived again.** Badges, alert banners, the enrollment
  live-pill and the troubleshooting nodes carried literal `rgba(34,197,94,.15)`
  greens and ambers, which ignored the user's palette. They now use the
  `--ok-weak` / `--warn-weak` / `--bad-weak` / `--accent-weak` tints, so a theme
  switch re-tints every status surface.
- **Chrome**: the sidebar's active item is a soft accent pill (the hard 3px
  marker bar is gone), the topbar is translucent with a backdrop blur (with a
  solid fallback), the page gutter grew to 24/28px and tightens on phones, and
  focus is a soft halo that follows the element's radius instead of a square
  outline.
- **Small things that were wrong**: `.fs-chip` was two unrelated components
  sharing a class name — the Analysis severity chip was silently restyling the
  Fleet summary chip — now both are scoped to their own parent. Scrollbars are
  thin and palette-coloured. Inline `code` sits on a tint instead of in a
  bordered box. A `prefers-reduced-motion` guard turns off transitions.

`docs/design.md` writes down the scale and the rules of thumb for adding a
surface; `test/dashboardDesignTokens.test.js` fails if a panel radius or a
status tint is hard-coded again.
## 0.117.0 — Pre-build gate: security / UI / validation tests on every branch build

Every branch build now has to pass a gate before it exists. `scripts/gate.sh`
runs three sweep suites in `test/gate/` and then the full `npm test`:

- **security** — enumerates every registered Express route and checks the whole
  surface: the unauthenticated allowlist is exact, every other route is 401 for
  no/forged/expired/`alg=none` tokens, viewers can only write where an explicit
  allowlist says so, operators never reach admin routes, a `mustChangePassword`
  token is locked to the password-change routes, a missing id is 404 everywhere,
  a hostile id never 500s, 500s carry no detail in production, malformed/oversized
  bodies are 400/413, login lockout is 429, static serving cannot escape
  `public/`, headers + CSP keep the strict directives, and no private key or
  vendor token is committed.
- **ui** — parses every `public/*.js` and `*.css`, checks index.html ↔ app.js
  (`data-view` ↔ `views.<tab>` ↔ `PAGE_INFO`, `data-min-role`/`data-feature`
  values, every `t()` key present in BOTH locales with placeholder parity, every
  `api()` path mounted), and boots the real dashboard in jsdom: login screen,
  session boot, role-gated navigation, 401 teardown, XSS via server strings.
- **validation** — every `src/validation` module survives garbage input and
  rejects an empty object where it has required fields, the per-module rules are
  pinned, and the HTTP layer is swept: no POST/PUT/PATCH 500s on empty /
  non-object / prototype-polluting bodies, create endpoints answer the
  `Validation failed` contract, hostile query params never 500, agent ingest
  validates once the token is accepted, `schema.sql` matches the migrations.

The gate runs from Claude Code (a `PreToolUse` hook on `git push` in
`.claude/settings.json` — a failing gate blocks the push and feeds the failures
back), from the tracked git `pre-push` hook, and from the `gate` GitHub Actions
workflow on every branch push and pull request. Cached per commit + worktree state.
See `docs/gate.md`.

Found by the gate while wiring it up: the Investigate view had no `PAGE_INFO`
help entry (added, i18n-backed in en + da), and `parseId` threw on a
null-prototype input instead of returning null.

## 0.115.2 — The Windows install command no longer looks like a PowerShell stager

A customer's IPS fired on their own BlueEyes server:

```
IPS Alert 2: Potentially Bad Traffic. Signature ET ATTACK_RESPONSE PowerShell
NoProfile Command Received In Powershell Stagers.
From: <server>:3000, to: <operator PC>, protocol: TCP
```

Nothing was compromised. The Windows install command we handed out was
`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <url>/install.ps1 |
iex"` — a download cradle, which is the shape every PowerShell stager has. The
Emerging Threats rule matches that flag combination inside an HTTP response body,
so it went off on the **dashboard response** that showed an operator the command,
over cleartext `http://…:3000`. On the host the same pattern is what endpoint AV
blocks, which is the other half of why the agent was hard to get installed.

The command now downloads the script and runs the file:

```
<TLS/pin prelude> Invoke-WebRequest -UseBasicParsing -Uri '<url>/install.ps1' -OutFile "$env:TEMP\blueeye-install.ps1"; Set-ExecutionPolicy Bypass -Scope Process -Force; & "$env:TEMP\blueeye-install.ps1"
```

- **The script lands on disk before it runs**, so AMSI and antivirus can scan it,
  an operator can read it first, and it can be allowlisted by path.
- **`Set-ExecutionPolicy Bypass -Scope Process`** replaces the
  `-ExecutionPolicy Bypass` flag: this process only, no admin rights needed, the
  machine's policy untouched.
- **`-NoProfile` is gone.** It bought nothing in an elevated admin shell, and it
  is the literal token the rule matches on.
- The same applies to the **update** and **uninstall** commands, and to the
  generated scripts themselves — their own comments and hints used to spell the
  cradle out, so downloading `install.ps1` tripped the rule a second time.

Nothing is encoded or hidden, and integrity is unchanged: the download is still
pinned to the server's certificate fingerprint when one is configured, and the
agent bundle is still verified against the SHA-256 embedded in the script.

Around it:

- `GET /api/enroll/command` and `/api/enroll/update-command` return `steps`
  (`download` / `run` / `scriptUrl` / `scriptFile`) beside `oneLiner`, and the
  dashboard offers **"Run it in two steps"** so an operator can read the script
  in between.
- `install.ps1`, `update.ps1` and `uninstall.ps1` accept **`?download=1`** and come
  back as a named attachment — for a host that cannot fetch the script itself and
  needs it carried over.
- The command is now meant for an **elevated PowerShell** specifically; it is no
  longer wrapped in `powershell -Command "…"`, so `cmd.exe` is not a host for it.

If the IPS alert is what you are chasing: also put the dashboard behind TLS. The
command was only readable on the wire because it crossed the network in cleartext
on port 3000. `docs/enrollment.md` has the full reasoning under
**Why not `irm … | iex`**.

## 0.114.1 — Troubleshooting stops loading 28 000 alarms to draw four numbers

The Troubleshooting tab took the better part of a minute to paint on a busy
fleet. The cause was one line: for every live root cause it re-read each member
finding with `findingStore.get(id)`, one query per member. A hundred clusters
holding 28 574 alarms meant 28 574 round trips queued behind a ten-connection
pool — to compute four key figures and a severity badge.

Two changes, and the screen is back to one read:

- **The rollup hydrates in bulk, through a narrow projection.**
  `FindingStore.listByIds(ids, { light: true })` reads members in 1000-id
  `IN (...)` batches and selects only `id/host_id/metric/severity/kind/acked/
  created_at` — no `evidence` or `correlated_with` JSON. That is exactly what the
  severity, affected-device and classification rollups consume, and it is the
  difference between a few hundred KB and tens of MB on the wire. A store without
  `listByIds` still works; the per-id path is now the compatibility fallback, not
  the normal one.

- **The raw alarms are opt-in.** `GET /api/troubleshooting/faults?limit=&offset=
  &clusterId=` returns the full findings behind the live root causes, paged
  (1..500 per page, default 100), in the same order the root-cause panel renders.
  `/overview` never carries them.

On the dashboard, the **Active faults** card now says how many there are and
offers a link to list them. The figure itself was always free — it is the sum of
each cluster's stored member ids — so the card costs nothing; the rows behind it
are fetched only when asked, a page at a time, under a counter that reads
"Showing 200 of 28 574" while it works. Everything else on the screen is there
before you ask, as before.

A member whose finding retention has already purged still gets a row, flagged
`missing`, rather than being dropped: silently short pages would leave that
counter permanently unable to reach its total.

New strings are in both the en and da catalogues.

## 0.113.0 — Trace the path the traffic actually takes

Traceroute sends ICMP or UDP. Plenty of firewalls and transit providers drop or
rate-limit exactly those while passing the TCP session an application uses, so
the path map goes dark at hop 4 while the service it is tracing works fine. The
operator is left with a blank map and no way to tell "the path is broken" from
"the path won't answer *this* probe".

A second trace type answers that: **TCP traceroute** walks the same path with
TCP SYNs to a port, so it follows the route the real traffic takes.

`tcptraceroute` had been on the agent's installable-tool allowlist since the
install-tool feature shipped, and nothing used it. It does now
(`blueeye-agent/src/probes/tcptraceroute.js`), with a fallback: where the binary
is absent the probe traces with `traceroute -T -p <port>` instead, which the
traceroute package already provides for the ICMP probe — so on most hosts this
works with nothing installed. When BOTH are missing the reported reason names
`tcptraceroute`, because that is what auto-install can actually offer; naming
the fallback would promise a fix the allowlist cannot apply. Both binaries need
raw sockets, so a permission failure gets its own reason rather than an empty
path.

Server side, the two traces are deliberately **kept apart**:

- `GET /api/probes/path` takes `probeType` (`traceroute` default, or
  `tcptraceroute`) and echoes it back. An unrecognised value falls back to the
  default rather than 400 — the view still renders.
- A TCP trace stores its target as `host:port`, so the same host traced two ways
  stays two series.
- The hop table names which probe drew the path.

Averaging them would have been the easy default and the wrong one: an ICMP path
that dies at hop 4 beside a TCP path that completes IS the finding, and merging
the two erases it.

The hop record is identical either way, so `buildPathGraph`, the geo path
overlay, the metric timeline and the scheduled test packages all took the new
type without change.

## 0.112.1 — The events list says what its columns do not

The Events table repeated itself three times over. The server stores a
self-contained title — `${SEV} ${metric} on ${device (site)}` — which is right
where it stands alone (the detail-page heading, an ITSM ticket subject, an alert
body), but in the list severity, device and location are each already a column:

    CRIT | Open | CRIT probe.latency on Localhost agent test (gnf-server-agent)
         | Localhost agent test #1 | gnf-server-agent | 31/07/2026, 13:17:30

Three of five columns saying the same thing, with the one piece of information
unique to the title — `probe.latency` — buried in the middle of it.

The column is now **Condition**, rendering `EventTitle.conditionOf()`
(`public/eventTitle.js`): the title with a leading severity and a trailing
` on <device label>` removed. The full stored title is the cell's tooltip, and
nothing rewrites the stored value.

The trim is deliberately conservative, because a wrong strip silently changes
what an operator reads:

- the severity comes off only when it matches the row's own badge — a title
  describing a *different* severity is left alone;
- the device tail only on an EXACT match against the label that row is
  displaying, so an agent renamed since the title was stored keeps its full
  title rather than silently hiding the discrepancy;
- a metric that legitimately contains " on " is not mistaken for a device tail;
- a title that would trim away to nothing, or to a bare `on <device>` fragment,
  is shown as stored;
- a hand-written title is returned untouched.

### A guard for the wiring

`public/app.js` reaches its helpers through globals they register on `window`;
there is no build step and no module loader. A helper that is not script-tagged
in `index.html` is simply `undefined`, and the first row that touches it throws —
a blank table, no build error, nothing in the tests. A new test asserts every
`window.*` helper app.js uses is loaded, and that index.html loads no script that
does not exist. Mutation-checked by removing the tag.

### Not changed

The **location** column showing an agent-like name (`gnf-server-agent`) is not a
join bug — `list()` reads `locations.name` for the agent's `location_id`. That
site record is genuinely named that; rename it under Sites.

## 0.111.1 — One event per condition, and a changes feed you can scan

Two reports, and they turned out to have separate causes.

### The Events tab was one event per breach, not one per condition

`eventCaseService` grouped a new anomaly into an open event only if it arrived
within **60 s** of that event's last activity, while `autoResolveJob` waited
**15 min** of quiet before calling the condition finished. The gap between those
two numbers was a bug: for fourteen minutes an event was still **open**, but a
new anomaly refused to join it and opened a *second* open event on the same
device. Probes report on a cadence of minutes, so in practice every recurring
breach spawned its own event — one device with a flapping probe filled the tab
with near-identical rows.

Both now read one constant, `EVENT_ACTIVITY_WINDOW_MS`
(`src/eventCases/activityWindow.js`). Grouping and finishing are the same
judgement — "is this condition still going?" — so they cannot drift apart again;
a test asserts they agree. The 60 s came from the correlator, which answers a
different question: it groups findings that fired *simultaneously* into one root
cause, not a condition tracked over its lifetime.

Recurrence keeps an event alive — each anomaly that groups in advances
`last_event_at` — so a condition that keeps firing stays **one** event for as
long as it lasts. A quiet gap longer than the window still starts a new event,
which is the honest boundary: it means the condition cleared and came back.

**No migration.** This changes only how *new* events are grouped; existing rows
are untouched.

### The changes feed was hard to read

- **A horizontal scrollbar on the whole page.** `.chg-indicates` combined
  `flex-basis: 100%` with a left margin, so the line was 100% + 10.5rem wide and
  overflowed its container. It is padding now (inside the basis, under the global
  `box-sizing: border-box`).
- **Raw ISO timestamps** — `2026-07-31T11:05:05.000Z` filled the time column,
  because three feeds called `TimelineView.renderRow` without `formatTime` while
  every other timeline passed `fmtDate`. All three pass it now.
- **Chips marooned at the right edge.** The summary was `flex: 1 1 auto`, so it
  ate the free width and flung the row's own metadata — recurrence, folded count,
  device — hard against the right edge with a chasm between a sentence and the
  chips describing it. The summary now takes only the width it needs; only the
  device control stays right-aligned, and the list has a max measure so that rail
  never strands itself on a wide screen.
- **The severity was printed twice** — a `CRIT` badge next to a summary opening
  "CRIT probe.latency on…". The leading token is dropped when it matches the
  badge, and only then.
- **The same sentence on every row.** "What this indicates" is per *condition
  family*, so eight latency events repeated it verbatim eight times, doubling the
  height of the feed to say one thing. It prints once per run of a family now; a
  row with no family (a situation, an agent transition) does not break the run.
- Recurrence and folded-count chips read as one family instead of three
  different fills, and the current-state badge is short with the full sentence on
  hover.

### Guards for the silent-failure classes these came from

The dashboard has no build step, no CSS linter and no DOM test, so all three of
these failed quietly. New tests read the source: every `renderRow`/`renderInto`
caller passing an inline opts object must set `formatTime`; stylesheets must have
balanced comments and braces (an unclosed comment silently eats the next rule —
it happened while writing this); and no `flex-basis: 100%` item may carry a left
margin.

## 0.110.1 — The incident vocabulary leaves the code and the database

0.109.0 renamed what a customer *sees* — the tab, the API paths, the response
keys — and deliberately stopped at the storage layer. This finishes the job:
the tables, columns, module directories and audit categories now say what they
mean, and "incident" is reserved for the two places it is genuinely the right
word.

**Breaking.** Read the migration note below before upgrading.

### Two things were both called "incident", and they split

Migration **077** renames them, preserving every row:

| Before | After | What it is |
| --- | --- | --- |
| `incident_cases` | `event_cases` | Grouped anomalies — the Events tab |
| `incident_notes` | `event_notes` | The work log |
| `incident_clusters` | `event_clusters` | Situations (cross-agent) |
| `incident_playbook_runs` | `event_playbook_runs` | Remediation runs |
| `findings.incident_case_id` | `findings.event_case_id` | The link from 048 |
| `incidents` | `probe_outages` | Probe threshold breaches (025) — never an event |
| `incident_thresholds` | `probe_thresholds` | Their thresholds (024) |

The code follows: `src/incidentCases/` → `src/eventCases/`, `src/incidents/` →
`src/probeOutages/`, and the matching repositories, validators, routers and
tests. Every index and foreign key is renamed explicitly — MySQL carries the
OLD constraint names through a table rename, so otherwise the schema would
still be full of `fk_incident_*` pointing at `event_*` tables. Indexes InnoDB
auto-created to back a foreign key are renamed conditionally via
`information_schema`, because whether they exist depends on the server version
and a hard `RENAME INDEX` would abort the migration on a database that lacks
one.

### What deliberately keeps the word

- **NIS2** — `blueeye_nis2_incidents`, `src/nis2/`, the NIS2 tab and the CFCS
  report text. "Incident" is the word the directive uses, and a regulator reads
  the generated report against that wording.
- **ITSM** — ServiceNow's `incident` table, and the stored integration
  subscription names (`incident`, `anomaly`). Those live in customer configs;
  renaming them would silently unsubscribe live integrations.

### Breaking changes

- **`/api/incidents/*` is gone.** `/api/events/*` has been the canonical path
  since 0.109.0; the deprecated alias and the duplicated `incident`/`incidents`/
  `incidentId` response keys are removed. A test asserts the old paths now 404
  rather than quietly answering.
- **Probe-outage reports moved** off the event vocabulary they never belonged
  to: `/api/reports/incidents[.csv|.html]` → `/api/reports/probe-outages[…]`,
  the JSON key `incidents` → `probeOutages`, the CSV filename
  `blueeye-incidents.csv` → `blueeye-probe-outages.csv`, and
  `/api/reports/nis2-draft/:incident_id` → `/nis2-draft/:probe_outage_id`
  returning `probeOutageId`/`probeOutage`.
- **`/api/incident-clusters` → `/api/event-clusters`.**
- **`GET /api/dashboard/advanced`**: the widget `widgets.incidents` (probe
  outages) is now `widgets.probeOutages`, distinct from `widgets.eventCases`.
- **Target timeline**: the `incident` source is now `probe`, and its event types
  `incident.*` are now `probe.*`.
- **No compatibility views.** Anything still querying the old table names fails
  loudly on upgrade instead of silently reading a stale shim.

### The audit trail is read, not rewritten

Audit entries move from category `incident` to `event`. Existing rows are **not**
migrated: `audit_log` is hash-chained, so rewriting them would break the chain
and every later verification. The readers match both categories instead, so an
event opened before the upgrade keeps its full status history. `listByTarget`
now accepts an array of categories for exactly this.

### Upgrading

Run `npm run migrate`. The migration is data-preserving but **not reversible**,
and MySQL commits DDL implicitly — a failure part-way leaves a partially
renamed schema, so take a backup first. Update any external caller of the
removed paths before upgrading.

## 0.109.0 — Events, not incidents; and a feed that correlates instead of counting

Two complaints, one root cause. The changes feed listed an **anomaly** row *and* an
**event** row for the same detection, then repeated that pair every time the
condition came back — "Critical (52)" for a handful of actual problems. And the
row that did the double-counting was labelled `incident_case`, a table name, next
to a run-together `finding.probe.latencyprobe.latency`.

### Fewer rows, and what they indicate

Two reductions now run in `src/changes/changeFeed.js` **before** ordering and the
cap, so the cap's budget goes to distinct conditions instead of repeats of one —
a single flapping link can no longer push everything else off the page.

- **Roll-up.** An anomaly whose event is also on the feed is folded *into* that
  event, which carries `findingCount`. The event exists precisely to represent
  those anomalies; listing both double-counted one detection. Matched on
  `findings.incident_case_id`, with `primary_finding_id` as a second signal so the
  very first anomaly of a case (whose FK may not be written yet) folds too.
- **Collapse.** Repeats of one condition on one device become **one** row carrying
  `count`, `firstAt` and every `refIds`. A condition that reopened seven times in
  four hours is one chronic problem, and `7× since 07:15` says so where seven rows
  only implied it. Key: `kind|source|type|agentId|metric|severity` — a fold never
  crosses a device, a condition, a severity (an escalation stays its own row) or a
  transition direction, so "went offline" is never folded into "came back online".
  One-off artifacts (config captures, topology changes, playbook runs) and
  `currentState` rows are never folded: three config pushes are three pushes.
- **It says what it folded.** `rawTotal` and `correlated` join `total`, and the
  page prints them — a feed that quietly compressed 120 occurrences into 14 rows
  would otherwise read as a suspiciously quiet shift.
- **"What this indicates."** Each row carries a condition `family` from the new
  `src/changes/indications.js` (latency, interface, saturation, loss, certificate,
  routing, resources, …), rendered as one sentence under the row. Local,
  deterministic, regex-on-family — an unrecognised metric yields `null` and no
  sentence, because no interpretation beats a confident wrong one. Wording lives in
  `public/i18n.js` (`changes.indicates.*`, en + da), not in the server.
- `incidentCasesRepository.list()` now joins the primary anomaly's metric
  (`primaryMetric`), because correlating on the row id instead of the condition
  makes two unrelated events on one device look like one recurring problem.

### The rendering bugs behind the screenshot

- The feed renders its rows into `ul.timeline-list`, which never picked up the
  flex/gap rules `ul.timeline` has — so every chip abutted the next. Both parents
  are styled now.
- The type chip drops its source prefix and hides entirely when the summary
  already spells it out: `finding.probe.latency` beside "probe.latency on core-sw"
  was duplication twice over. Matched on **word boundaries**, so a site named
  Copenhagen cannot suppress an `open` status chip by containing the letters.
- `SOURCE_LABELS` had no entry for `incident_case`, which is why a table name
  reached the page. Every source a mapper emits now has a label, and a test
  asserts it.

### Events, not incidents

BlueEyes produces **events**; an **incident** is what a connected ITSM opens from
one, and it lives there with its own number, SLA and owner. Calling our own row an
incident made the two indistinguishable and implied BlueEyes does incident
management, which it deliberately does not. New doc: **`docs/events.md`**.

- The dashboard tab is **Events**; `views.events` / `views.event`, `PAGE_INFO.events`,
  and the page help now states the boundary outright.
- **`/api/events/*` is canonical.** `/api/incidents/*` stays mounted as a
  deprecated alias — the *same router instance*, so the two cannot drift — and
  every response carries `event`/`events`/`eventId` alongside the old
  `incident`/`incidents`/`incidentId` keys. Existing integrations keep working.
- The changes feed's two records that used to share the kind `incident` are now
  distinct: `event` (`incident_cases`) and `probe` (the probe-outage `incidents`,
  migration 025), whose transitions read `degraded`/`recovered`.
- **Unchanged on purpose:** the `incident_cases` / `incidents` / `incident_notes`
  tables (renaming buys nothing a customer sees and costs a migration on live data
  with five FKs); the integrations' stored subscription names (`incident`,
  `anomaly`) — renaming them would silently unsubscribe live integrations, and
  `incident` there now literally means "the subscription that opens an ITSM
  incident"; ServiceNow's `incident` table; and **NIS2 incidents**, where
  "incident" is the word the legislation uses.

## 0.108.0 — CMDB asset picker: search by asset ID, name or location

Linking an agent to its CMDB asset was a free-text box that searched asset
**names** only, and it was shown even when no CMDB was connected.

- **One term, three fields.** ServiceNow ORs `name` / `sys_id` / `asset_tag` /
  `location.name` in a single encoded query (the term is stripped of `^` and `,`
  so it cannot open a condition of its own); Nautobot merges its `q=` read with a
  `location=` read, deduplicated by id and best-effort — a rejected location
  filter leaves the `q` results intact. The custom connector stays config-driven.
- **A real dropdown.** The agent page's CMDB card is now a combobox: options are
  fetched per keystroke (debounced, min 2 chars — a CMDB holds more assets than a
  `<select>` can), each row shows name, id, type and location ("No location in
  CMDB" when it has none), and ↓/↑/Enter/Esc work.
- **New `GET /api/cmdb/assets/status`** (operator+, safe config only) — the card
  asks first, so with no CMDB connected it says so and points an admin at
  Settings → CMDB instead of offering a search that can only 404.

## 0.107.0 — Incidents say where they are (agent + location)

An incident read "WARN probe.latency on 1" and its Device column was empty, so
placing a case meant looking the agent id up somewhere else. Every surface that
names an incident now names the **agent** and the **location** it stands at.

- **The auto-generated title** resolves the agent: "WARN probe.latency on
  **core-sw (Copenhagen HQ)**". Best-effort — an unknown/deleted agent or a
  failed lookup falls back to "device 1" and never blocks the incident.
- **The read API** joins `agents` + `locations` onto `GET /api/incidents`,
  `GET /api/incidents/:id` and the similarity pool: `agentName`,
  `agentHostname`, `locationId`, `locationName`. Since it is a join on read, a
  renamed or relocated agent immediately reads correctly on **old** incidents
  too — the frozen title is not the only answer.
- **`explanation.where`** gains `locationId`/`locationName` and a ready-made
  `summary` ("core-sw (Copenhagen HQ)").
- **Dashboard**: the Incidents list gains **Device** and **Location** columns
  (location narrows client-side — incidents are keyed by device, not by site),
  the detail header names the agent (linked to its page) and its site, and the
  Overview "open incidents" rollup shows the same agent · site pair the
  probe-outage rollup already did.

Fixed along the way: the incident device was read as `deviceId` in the dashboard
and in the Overview rollup, but the repository has always returned `hostId` — so
the Device column, the detail header and the rollup rendered blank. The
"Affected path" card and the guide's config-context action were reading the same
missing field.

## 0.99.0 — Consolidated Troubleshooting Dashboard

One screen for an outage: **what is failing, what it affects, and when it
started** — without switching views.

New read endpoint `GET /api/troubleshooting/overview` (operator+) returns the
whole screen in one request: key figures, the L2/L3 topology with per-node
state, the correlated root causes with their blast radius, flow-pair baseline
deviations and a change timeline. New tab **Troubleshooting**.

**It owns no data.** No tables, no migrations — it is a read/aggregation layer
over five capabilities that already existed (topology rediscovery, service
dependency mapping, blast radius, flow-pair baselining, active discovery) plus
the cross-agent correlator, each of which keeps its own page and API.

Decisions worth knowing:

- **The rollup is preserved, not re-derived.** One cluster = one root cause,
  never one per affected device. The key figures make the collapse legible —
  "47 alarms → 3 causes" — instead of leaving the operator to divide.
- **Blast radius counts impact *beyond* the devices a cause already names**, so
  a root cause cannot inflate itself; L2-isolated hosts are not double-counted
  as service dependents.
- **Node state is derived and conservative.** `unreachable_downstream` exists
  nowhere in the schema; it means "we cannot hear it", which is not a claim that
  the host is broken — and an unknown agent status maps to `ok`, because we do
  not invent faults we have no evidence for.
- **One graph read.** `blastRadiusService.compute()` rebuilds the whole topology
  graph per call, so the service takes the graph once and runs the pure
  `computeBlastRadius` per node. A test asserts it.
- **Aggregating never widens access.** The endpoint adopts operator+, the
  strictest non-admin level of its sources; admin-only discovery candidates are
  included for admins only — as an empty list, not a 403 for everyone else.
- **Fail-closed per panel.** A dead domain lands in `failedSources`, sets
  `partial: true` and costs that one panel; it never blanks the screen.

Read-only — no agent command is pushed, so no signed command and no audit write.

The older location-driven anomaly view is unchanged and is now labelled
**Investigate**, which is what it does.

See `docs/troubleshooting-dashboard.md`.

## 0.98.2 — Rename: BlueEyes Network Resilience System

The product is now the **BlueEyes Network Resilience System**. Every
user-facing surface was updated — dashboard chrome and login, the built-in
documentation, plan labels ("BlueEyes Professional"), the one-time-password
email, ITSM/CMDB/webhook help text, installer and uninstaller output, and the
READMEs across server, agent and licens. Inline prose uses the short form
**BlueEyes**; the full name anchors the page titles, login screens, README
leads and the "What BlueEyes does" article.

Deliberately **not** renamed, because deployed installs and integrations key
off them: the `X-BlueEye-Signature` and `X-BlueEye-Protocol` HTTP headers, the
`BlueEyeAgent` Windows service, the `u_source = BlueEye` ServiceNow filter
tag, `BLUEEYE_*` environment variables, `blueeye_*` database objects, and the
`blueeye-server` / `blueeye-agent` / `blueeye-licens` package and repository
names. Renaming any of those would break agents in the field, saved ServiceNow
views and existing deployment config, so they stay on the old spelling until
there is a migration path.

## 0.96.3 — Fix: traffic map stuck on "Loading…"

The traffic map never rendered — the Overview (and the location page) sat on
**"Loading…"** indefinitely. A view's DOM is built *before* `render()` mounts
it, so the card's `/api/flows/map` fetch routinely resolved while its own
container was still detached; the `if (!root.isConnected) return` guard —
meant to abandon work after the user navigates away — fired on that race and
abandoned the *initial* render instead. Whoever won the race decided whether
the map appeared, so a fast API reliably lost.

Replaced with a `whenConnected(node)` helper that waits for the mount (with a
15 s cap, so navigating away still abandons cleanly) and polls via
`setTimeout` rather than `requestAnimationFrame`, which is paused in a hidden
tab. `drawTrafficMap` now also re-runs `invalidateSize()` + `fitBounds()` once
its container is actually laid out — Leaflet otherwise sizes to 0×0 and puts
the arcs off-screen. The Overview's map is a little shorter now so it doesn't
dominate the page.

## 0.96.0 — Traffic map (colored flow arrows), location drill-down page

**Traffic map.** Flows get a geographic view: colored arrows between your sites
and destination countries, where **color = traffic type** (the existing
admin-editable categories — DNS, Web, VPN, Facebook, …), **moving dashes =
direction** (drawn toward the receiving end; solid = both ways) and **width =
volume**. Backed by a new `GET /api/flows/map` (viewer+) endpoint —
`flowsRepository.mapFlows` groups public `flow_records` by (agent, country,
ASN, direction, service port), the route classifies each group into a category
(ASN match wins over port match) and aggregates to one arc per
(site, country, category) with an in/out byte split. Destinations are placed at
country centroids only; internal RFC1918 traffic is never geolocated. Surfaced
in three places:

- **Flows → Map mode** (third mode next to Unified/Bidirectional): scope to the
  selected agent, one site or the whole fleet; legend chips toggle categories;
  a top-flows side panel pans the map.
- **Overview**: a fleet-wide traffic map below the network path. Clicking an
  arc (a dataflow) opens Flows → Map scoped to that site; clicking a site pin
  opens the location page. The **network path shrank to a compact strip**
  (~25 % less height, capped width) to make room.
- **Location page**: the site's own scoped map + dataflow list.

**Location drill-down page.** Clicking a location anywhere (the agent page's
site name, the Locations list, a site pin on a traffic map) opens a full-width
per-site page: the Overview KPI cards scoped to the site, every agent there
(connection, health verdict, loss/latency/jitter, throughput, version,
last-seen — click through to the agent page), and the site's data flows.

**Layout.** The agent page's Config history / CMDB asset / Dependencies cards
now sit in a responsive grid using the full page width (the global login-card
`width: 320px` had left them stranded in a narrow column).

## 0.94.1 — Analysis overview + filterable/sortable tables

Adds an **Overview** panel to the Analysis (findings) page and makes both the
Analysis and Incidents tables filter/sort from their headers — no new tables,
no new collection.

**Overview panel.** The Analysis page now opens with an aggregate summary over
the current filter: total + unacknowledged counts, a severity breakdown, and
per-metric / per-host tables with count, average σ and peak σ. Backed by a new
`GET /api/findings/summary` (viewer+) endpoint and `FindingStore.summary()`,
which computes the aggregates in SQL (`GROUP BY severity|metric|host_id`) over
the same filter set as the list — one scan per grouping, never pulls raw rows to
total them. Severity chips and metric rows in the panel are clickable and drive
the same filters as the header controls.

**Filterable / sortable headers.** Both the Analysis and Incidents tables now
carry their filter controls **in the table header** — a filter row under the
sortable column labels — so each header both sorts (click the label, click again
to flip) and filters (the control beneath it). Analysis filters by Host /
Severity / Metric (metric options populated from the overview); Incidents by
Severity / Status / Device. `GET /api/findings` accepts `severity` and `metric`
query params (400 on an unknown severity). Both reuse a shared `sortableTable`
helper (client-side sort, numeric-aware, nulls last; optional per-column filter
row), styled like the existing Agents table.

## 0.90.0 — Per-flow-pair volume baselines + scheduled active discovery

Two features (migrations 068 + 069).

**Per-flow-pair volume baselines.** Extends per-metric anomaly detection to
per-`(src_host, dst_host, dst_port)`: baseline each pair's hourly traffic volume
and flag deviations. Reuses the existing median/MAD z-score (`src/analysis/
baselines.js`) — **no new statistical code**. Day-of-week + hour-of-day aware
(Tuesday 14:00 vs prior Tuesdays 14:00). A new append-only `flow_pair_hourly`
rollup (fed by the service-dep `tcpServiceFlows`+resolver path; history builds
forward, ~7-day raw flows can't backfill) feeds `flow_pair_baselines`; a
leader-only hourly job (`src/analysis/flowPairBaselineJob.js`) recomputes over a
14-day window (min 100 observations before scoring) and emits deviations to the
correlator as ordinary findings (`kind ANOMALY`, `metric flow.volume`) via
`findingStore.save`. Deviation only — **no** threat classification, **no** new
alerting channel. API `GET /api/topology/flow-baselines` (operator+, 400/404/500)
+ `POST …/recompute`. Config `FLOW_BASELINE_*`. See `docs/flow-pair-baselines.md`.

**Scheduled active discovery.** Finds devices passive collection misses by probing
an admin-configured CIDR scope. **Native Node only** (TCP connect via `net`,
reverse DNS via `dns.promises`; ICMP is an injectable probe, unsupported by
default since raw sockets need CAP_NET_RAW — no `nmap`/`ping`, ever). Scope is
explicit — never scans outside the configured CIDRs, refuses to start when scope
is unset/invalid or exceeds the address cap (default 65536, checked before any
probe), rate-limited (default 50/s). Results are `discovered_devices` candidates —
**never auto-enrolled**; an admin promotes one to a monitored SNMP device
(`agents` row). Every sweep is written to the hash-chained audit log with scope,
start, end and result count. **Admin-only** router (`/api/discovery/*`; viewer +
operator get 403 on every path). Engine `src/discovery/` (`cidr`, `rateLimiter`,
`probes`, `scanner`, `discoverySweepJob`); config `DISCOVERY_*` (`src/config.js`).
See `docs/discovery.md`. Documentation-center how-tos added for both features.

## 0.89.0 — Topology change detection (LLDP neighbour changes + audit evidence)

Detects and records LLDP/CDP topology changes between poll cycles. Each agent
capabilities report is diffed against the agent's previous neighbour snapshot;
differences become change records — `neighbour_added`, `neighbour_removed`,
`link_state_changed`, `port_moved` — with flap suppression (a revert within
`TOPOLOGY_FLAP_WINDOW_SECONDS`, default 300, collapses to one `flapping` record).

- **Reuses the delta/changes shape** — change records surface as the existing
  target-timeline event `{ timestamp, source:'topology', type, severity, summary,
  ref_id }` (new `topology` source in `src/timeline/targetTimeline.js`, rendered
  "Topology change"). No second changes format.
- **Hash-chained audit evidence** — each change is written to `audit_log` (mig
  033/041) via the fail-safe compliance logger (category `topology`, action
  `topology_<type>`, `actorRole:'system'`, no actor user).
- **Migration 067** — `topology_changes` table + nullable `lldp_neighbors.link_state`
  (so a previous snapshot can carry state to diff). Diff seam at
  `POST /agents/me/capabilities`: detect before upsert, reconcile removed/moved
  edges so they don't re-emit.
- **API** — `GET /api/topology/changes` (operator+, `?host=`): 400/404/500; changes
  also merge into `GET /api/targets/:id/timeline` (viewer+).
- Pure diff `src/topology/topologyDiff.js`; service `topologyChangeService.js`;
  repo `topologyChangesRepository.js`; `lldpNeighborsRepository` gains
  `listByAgent`/`deleteEdge` + `link_state`.
- Tests: each change type on synthetic snapshots, flap window boundaries
  (299/300/301s), no-change on identical, API 400/401/403/404/500, end-to-end
  ingest + timeline. Documentation-center how-to + `docs/topology-changes.md`.
- **Known gap:** the shipping agent doesn't collect LLDP yet, so this is dormant
  in production until an agent reports `capabilities.lldp` (and per-neighbour
  link state for `link_state_changed`). Server, storage and tests are ready.

## 0.88.0 — Blast radius (impact analysis from a failing node)

Given a **failing node** (agent id), computes which downstream hosts/services are
affected, from the unified topology graph. Two tiers, each with a justifying path:
`directly_isolated` (walk `l2_link` out from the node → hosts that lose L2
connectivity) and `dependency_affected` (walk `service_dep` in reverse from the
failing + isolated set → dependents, transitively). Depth-capped
(`BLAST_RADIUS_MAX_DEPTH`, default 4), cycle-safe, `O(V + E)` (a 5,000-node perf
test asserts <2s).

- Pure engine `src/topology/blastRadius.js` + `blastRadiusService.js` (builds the
  graph from the two bounded `listAll`s).
- **Incident enrichment** — `GET /api/incidents/:id` (viewer+) gains **one** added
  field, `blastRadius`, computed on read from the incident's `host_id`. Best-effort
  (topology failure → `blastRadius: null`, incident still served). **No schema
  change** — nothing persisted.
- **Ad-hoc endpoint** — `GET /api/topology/blast-radius/:node` (operator+),
  `?depth=N`; 404 unknown node, 400 invalid, 500 on topology-store failure.
- Tests: linear/star/cyclic topologies, depth cap, empty downstream, dependency
  chains, 5k-node perf; API 400/401/403/404/500 + incident-enrichment best-effort.
- **Documentation center** (Diagnostics how-tos) gains worked-example articles for
  the service dependency graph **and** blast radius. Docs `docs/blast-radius.md`.

## 0.87.0 — Service dependency graph (edge type `service_dep`)

Adds a **service dependency graph**: directed edges between monitored hosts derived
from observed **TCP** flows, aggregated over a rolling 24h window by
`(src_host_id, dst_host_id, dst_port)` with byte/packet/connection counts +
first/last-seen. This is the second edge type of the **unified topology graph** —
`l2_link` (LLDP, migration 063) and now `service_dep` (migration 066) — merged by one
host-keyed model in `src/topology/graph.js` (`buildTopologyGraph`), **not** a parallel
structure.

- **Storage:** new MySQL table `service_dependencies` (migration 066), modeled on
  `lldp_neighbors` — a keyed, upsert + age-out current-state edge table (not
  append-only telemetry). Repo `src/repositories/serviceDependenciesRepository.js`.
- **Aggregation:** a leader-only scheduled job (`src/topology/serviceDependencyJob.js`,
  in `server.js` `backgroundJobs`, default every 10 min) recomputes the rolling window
  **off the ingest hot path**. Pure aggregation + Top-N-per-source-host truncation in
  `src/topology/serviceDependencyAggregator.js` (default N=50, `SERVICE_DEP_TOP_N`).
  IP→host resolution (`src/topology/hostResolver.js`) maps an IP to a monitored host
  via the agent's own reported IPs (`capabilities.ips`) or an SNMP-monitored device's
  `monitor_config.snmp.host`; **edges with either endpoint unresolved are dropped**.
- **API (`/api/topology`, viewer+):** `GET /dependencies` (Top-N edges, `?host=` for one
  host — 404 unknown), `GET /graph` (unified typed graph), `POST /dependencies/recompute`
  (operator+ — the write path).
- **v1 scope:** TCP only; both endpoints must be monitored hosts; no process attribution;
  no service naming/classification.
- **Agent lockstep (blueeye-agent 0.18.0):** the sFlow/NetFlow collector now emits a
  capped per-5-tuple `traffic.flows` list (proto + dst_port, already decoded) and reports
  the host's own IPs via `capabilities.ips` — both additive and backward-compatible
  (older servers keep using `topTalkers`). Config: `SERVICE_DEP_WINDOW_HOURS` (24),
  `SERVICE_DEP_TOP_N` (50), `SERVICE_DEP_JOB_INTERVAL_MINUTES` (10). See
  `docs/service-dependencies.md`.

## 0.84.2 — Fix: `trigger` reserved word broke migration 065 (deploy hotfix)

`cluster_evidence_snapshots.trigger` (Fase 6) is a **MySQL reserved word** and was
used unquoted in the `CREATE TABLE` (migration 065) and in the repository's
`INSERT`/`SELECT` column lists — so `node src/migrate.js` failed with a syntax error
on a fresh deploy, aborting the container's `migrate && seed && server` startup chain
(`blueeye-server` exited 1). Backticked `` `trigger` `` everywhere it names the column.
Added a repository regression test asserting the emitted SQL backticks the column
(the fake pool doesn't parse SQL, so the original bug passed CI). No schema/behaviour
change — re-running the migration now applies cleanly (065 had rolled back, so nothing
was recorded).

## 0.84.0 — Automated read-only evidence snapshot on cluster open

When a cross-agent cluster opens, BlueEyes captures a **READ-ONLY** diagnostic
snapshot from each affected target over the **existing** authenticated, audited
agent-command path — then references one compressed blob per (cluster, target)
from the incident timeline. The capture is bounded and best-effort: it never
blocks clustering, alerting or the incident page.

**Audit note (premise partly off, as in F3–F5):** agent commands were **not
Ed25519-signed** before this (only release manifests were), there was **no
playbook/command executor for read-only diagnostics**, and nothing captured
point-in-time evidence for a cluster. This phase reuses the existing release
signing key + the `sendCommandAndWait` command path rather than inventing new
transport.

### Read-only by contract (defense in depth)
- Server allowlist `src/evidence/commandAllowlist.js` (`evidence-v1`) is the single
  source of truth for WHAT may be collected — `iface.counters`, `arp.table`,
  `snmp.reads`, `agent.state`, every entry `readOnly: true`. A would-be write item
  simply is not on the list.
- The **agent enforces its own copy** of the allowlist (`blueeye-agent`
  `src/evidenceCollector.js`) and hard-refuses any non-allowlisted item **without
  invoking a collector** — so a compromised/buggy server still cannot make an agent
  act.
- The evidence command is **Ed25519-signed** with the existing release key when one
  is configured; the agent verifies it and refuses a bad signature.

### Bounded + best-effort capture
- `src/evidence/snapshotService.js` — per-target hard timeout (default 30s),
  concurrency cap (default 4), an offline agent retried **once** after 60s then
  recorded `agent-offline`. Partial results are valid: each item's outcome
  (`ok`/`timeout`/`refused`/`agent-offline`) is stored. Every path swallows its own
  errors — the trigger is fire-and-forget from the clustering sweep.

### Evidence, not time series
- Migration `065_create_cluster_evidence_snapshots.sql` — one row per (cluster,
  target) with a **gzip blob** (`payload_gzip`), not metric rows; nothing lands in
  TimescaleDB. `src/repositories/evidenceSnapshotsRepository.js` gzips on write /
  gunzips on read so callers deal in plain text.
- Timeline gains an **`evidence`** source (`src/timeline/incidentTimeline.js`):
  "evidence snapshot captured" per target (INFO when complete, WARN for
  partial/offline/failed), linking to the raw-text viewer.

### Retention (existing never-delete rule)
- `src/evidence/evidenceRetention.js` — a 6h background job ages out snapshots older
  than `RETENTION_EVIDENCE_DAYS` (default 90) **except** those on a cluster that
  still has an **unacknowledged CRIT** finding.

### API + RBAC
- `GET /api/incident-clusters/:id/evidence` (viewer+) lists snapshots;
  `GET …/evidence/:sid` (viewer+) returns the decompressed raw text (`text/plain`);
  `POST …/evidence` (operator+) triggers a **manual re-snapshot**, rate-limited
  (once/min, `429` + `Retry-After`) and evidence-class **audit-logged**.

Agent bumped to **0.17.0** in lockstep (`evidence` command recognizer + collector).

## 0.83.0 — Cluster-level alerting, ITSM bridge & NIS2 draft

Rolls a clustered incident's notifications up to the CLUSTER: one alert lifecycle,
one ITSM ticket, one NIS2 draft — instead of N per member finding. Backward
compatible: un-clustered findings and low-confidence clusters keep per-finding
alerting unchanged.

**Audit note (premise partly off, as in F3/F4):** ITSM connectors had **no
worknote/comment method** and **no state-map**; nothing stored an external ticket
id per cluster; the cluster path never called the integrations dispatcher; and the
NIS2 persisted-draft path had **no template fallback** when Mistral is off.

### Alert rollup
- Pure engine `src/analysis/clusterRollup.js` — decides **opened / update /
  escalation / resolved / none** from the cluster's stored alert state. Digest
  window (default 10 min) + **CRIT escalation bypass**. Dispatcher gains
  `dispatchClusterEvent` with **per-channel digest** (`digestMode: 'silent'` skips
  mid-incident updates, still gets opened/escalation/resolved).
- Orchestrator `clusterNotifier.js` wired into the cluster sweep + the resolve API:
  cluster-opened alert, digested updates, immediate escalation, one resolution
  alert (duration + note).
- **Suppression**: a dispatch-time gate (`clusterAlertGate.js`) suppresses a
  finding's individual alert + ITSM emit once its host is in an open medium/high
  cluster; the sweep records every suppression (audit + cluster timeline —
  "rolled into cluster #X"), honouring the **race case** (already-alerted members
  are noted, never recalled). Migration **064** adds the rollup state + refs.

### ITSM bridge
- ServiceNow/custom connectors gain **worknote append** (`work_notes`, journal-only)
  + return the ticket ref; integrations dispatcher gains `emitCluster` /
  `emitClusterNote`. **One ticket per cluster** (idempotent `be-cluster-<id>`),
  worknotes on update/escalation/resolve, ref stored on the cluster. Reuses the
  existing retry/backoff; a connector failure never blocks alerting or the sweep.

### NIS2 cluster draft
- `clusterNis2.js` — **one** cluster-level draft via the existing pipeline,
  **fully functional without Mistral** (template fallback), AI-masked + clearly
  marked when enabled. Invariants preserved (`notification_required=false`, never
  auto-submitted, `[AI draft]`/`[Cluster draft]` title). Per-finding drafts
  suppressed with an audit link; `nis2_draft_id` stored on the cluster.

### API
- `GET /api/incident-clusters/:id/notifications` — the ONE ticket ref, the ONE
  NIS2 draft id, and the cluster-level alert history (viewer+, 400/401/404/500).

### Tests
Rollup (opened/digest/silent/escalation/resolved), notifier (opened + one ticket +
NIS2 + suppression; escalation worknote; digest hold; resolution; ITSM-failure
isolation; race case), NIS2 (invariants, works without Mistral, AI-marked,
idempotent), gate + pipeline suppression (individual alert + ITSM emit skipped),
ServiceNow worknote append, and the notifications API.

## 0.82.0 — LLDP neighbor graph for incident clustering

Adds a minimal, queryable L2 topology so cross-agent clustering can group findings
by neighbor adjacency when no shared-site (manual) topology applies.

**Audit note:** the brief assumed BlueEyes already collects LLDP as part of "L2 loop
detection" — it does **not** (no L2 loop detection, no SNMP/BRIDGE-MIB/LLDP
collection exists; `locator.js`'s "neighbor" means neighbor *agents*). And Fase 1's
topology signal is **shared-site** (`location_id`), not a manual dependency graph.
So this phase persists LLDP data arriving on the **existing agent report path**
(no new SNMP polling) and wires it in as a topology fallback.

### Persistence
- Migration **063** `lldp_neighbors` (`local_agent_id`, `local_chassis_id`,
  `local_port`, `remote_chassis_id`, `remote_port`, `last_seen`) + repository:
  upsert (bumps `last_seen`), batch upsert, age-out (default 24h, configurable),
  list/count. Ingested from a `capabilities.lldp` list in the agent's existing
  `POST /agents/me/capabilities` report — no new polling.

### Graph service
- Pure agent-projected graph (`src/topology/lldpGraph.js`): `adjacent` / `within-N
  hops` / `unknown`, via direct links (remote chassis = another agent's chassis)
  and shared segments (two agents on one switch). Partial coverage → partial graph;
  a pair with no path is **unknown, never "unrelated"**.
- TTL-cached service (`lldpGraphService.js`): rebuilds ≤ once/min (ageing out stale
  rows first), exposes a **sync** `relation()` for the clustering hot path.

### Fase 1 integration
- The correlator gains an LLDP topology pass **between** the site pass and the
  type pass, so **manual/site ALWAYS wins** (it consumes its findings first),
  LLDP fills the remainder, and anything else stays unknown. A cluster now records
  `topologySource` (`site`/`lldp`) and the evidence/`suspected_common_cause` names
  it ("LLDP: sw-03 adjacent to sw-04"). Wired via a background refresh/age-out job.

### API
- `GET /api/topology/neighbors` — viewer+, filter by `target` (both directions),
  pagination; 400/401/404/clean-500.

### Tests
- Graph queries (adjacent / 2-hop / unknown / partial coverage); upsert + age-out +
  TTL refresh; resolution order (site wins over LLDP); clustering integration
  (two LLDP-adjacent agents at different sites with different finding-types →
  clustered via LLDP, evidence names the source); ingest via the capabilities path;
  API 400/401/404/500.

## 0.81.0 — Recommended actions + post-remediation verification loop

Completes "not who's to blame, but what to do": a static finding-type → runbook
bridge on the incident (Situation) page, explicit operator-run playbooks, and a
verification cycle that re-checks whether the symptoms actually cleared. Queries +
UI; no new AI/ML (the Mistral advisory stays opt-in garnish).

**Audit note:** the phase brief assumed an existing playbook execution path with
retry/backoff, a `remediating` state, and playbook-success logging — none of which
existed (migration 055 explicitly deferred execution; `recordRun` was never
called; the state machine excludes playbook transitions). This phase builds the
minimal execution + verification path faithful to that schema's intent.

### Runbooks (static mapping first)
- Migration **061** `runbooks` (finding_type → title + markdown body + optional
  `linked_playbook_id`). Admin CRUD API `/api/runbooks` (+ `/playbooks` for the
  link editor); reads viewer+, writes admin. UI: **Settings → Runbooks**.

### Recommended actions on the incident page
- `GET /api/incident-clusters/:id/recommended-actions` — runbooks matching the
  cluster's dominant finding-types (rendered markdown), plus the cluster AI
  advisory **only when the assistant is enabled** (clearly AI-labelled).
- `POST /api/incident-clusters/:id/run-playbook` — operator+, confirm dialog,
  hash-chained audit, uses the run-recording execution model and **schedules a
  verification**. No auto-execution from clustering; existing auto-trigger rules
  untouched. 409 on a resolved cluster.
- Frontend: a "Recommended actions" panel (with a safe, dependency-free markdown
  renderer) + AI advisory directly below, on the Situation page.

### Verification loop
- Migration **062** `verification_runs`. After a playbook runs, a leader-only
  sweep (`verificationJob`) waits the configurable settle time (**Settings →
  Analysis → verify settle**, default 5 min) then re-checks the affected targets
  for fresh, unacknowledged findings of the relevant types:
  cleared → **passed** (suggest resolution, never auto-resolve); persists →
  **failed** with the current readings (cluster stays open). Every outcome is
  hash-chained-audited and surfaced on the cluster timeline as a new
  **`verification`** source.

### Tests
- Runbook CRUD (happy/400/401/403/404/clean-500); recommended-actions (match /
  no-match / advisory gated by Mistral) + run-playbook (202/400/403/404/409);
  verification (cleared, persisting-with-readings, settle-time respected,
  acked-ignored, error, no-reprocess, timeline emission, never auto-resolves);
  frontend jsdom (panel render, viewer vs operator, empty state, fetch-failure
  isolation, advisory placement, markdown-injection safety).

## 0.80.0 — Incident Situation View (timeline + what-changed + evidence)

One page per cross-agent situation (cluster) that answers, under pressure, what is
happening, where, since when, what changed right before, and what the evidence
says — "ét fælles billede". Queries + UI only; no new AI/ML. Builds on the Fase-1
cluster API and reuses the existing timeline, badge and advisory patterns.

### Backend
- **`GET /api/incident-clusters/:id/timeline`** — one chronologically merged event
  stream for the cluster's affected agents, from `first_seen − lookback` (default
  30 min, `?lookback=<minutes>`) to now, merging: member findings, cluster
  lifecycle transitions, playbook runs, agent connect/disconnect/enrol, and
  config-change captures. Each event carries `{ timestamp, source, target,
  severity, summary, ref_id }`. A separate **`whatChanged`** slice flags the
  sources-c–e events in the pre-incident window. viewer+; 400 on bad lookback,
  404 unknown cluster, clean 500; partial-failure tolerant (`partial` +
  `failedSources`, never a blank timeline).
- Pure merge `src/timeline/incidentTimeline.js` (reuses the per-target mappers,
  adds `target` + config/state-change sources) + fan-out
  `src/timeline/incidentTimelineService.js`. New windowed
  `configSnapshotsRepository.listForDeviceBetween`.

### Frontend
- **Situations** list (`views.clusters`) + per-situation page (`views.cluster`),
  cloning the incident list/detail patterns. Panels: header
  (status/confidence/root-cause/agents + RBAC-aware ack/resolve), a prominent
  **"What changed"** panel (explicit "no recorded changes" when empty — absence is
  diagnostic), an **Evidence** panel (Fase-1 confidence breakdown in plain
  language), the **merged timeline** (filterable by source, severity-coloured,
  rows deep-link to the affected device), and an optional AI advisory block
  (rendered read-only from the cluster; an independent failure domain — never
  breaks the page). Reuses `TimelineView`; page assembly + panels live in the pure,
  jsdom-tested `public/clusterView.js` (`window.ClusterView`). New nav entry +
  `PAGE_INFO.clusters` + a `type:'incident_cluster'` branch on the dashboard WS.

### Tests
- Backend: timeline merge ordering, lookback boundary, what-changed separation,
  400/401/404/partial/clean-500.
- Frontend (jsdom): full-data render, empty timeline, advisory disabled, advisory
  failing (page still renders), timeline failing, RBAC actions, source filter.
- Installed the declared `jsdom` devDependency so the DOM render tests (and the
  pre-existing `timelineView` suite) run.

## 0.79.1 — Cross-agent incident clusters: operator API + lifecycle

Builds the operator-facing surface on top of the existing cross-agent clustering
engine (detector + dedup/auto-resolve + AI advisory + alerting already shipped in
0.7x). No parallel correlation system — this reuses the engine as-is.

### Added
- **REST API** `/api/incident-clusters` (`src/routes/incidentClusters.js`):
  - `GET /` — list with `status` + `from`/`to` filters and `limit`/`offset`
    pagination (viewer+).
  - `GET /:id` — full cluster: hydrated member findings + evidence, affected
    agents/targets, a weighted **confidence breakdown** (signals + score vs the
    single-signal baseline), a suspected **root-cause layer**
    (network-/application-layer/undetermined, reusing the L2
    `isAppMetric`/`isNetMetric` classifiers) and a plain-language evidence
    summary (viewer+).
  - `POST /:id/ack` — acknowledge (operator+, hash-chained audit).
  - `POST /:id/resolve` — resolve with a **required free-text note** (operator+,
    audited).
- Pure read-model assembly `src/analysis/clusterView.js` and a
  `confidenceBreakdown` helper on `crossAgentCorrelator`.
- Migration **060** — `incident_clusters` gains the `acknowledged` status plus
  `acknowledged_at`/`acknowledged_by`, `resolved_by`, `resolution_note`.

### Changed
- Auto-resolve now **never closes a cluster that still holds an unacknowledged
  CRIT member finding** (existing retention rule), and the default quiet period is
  **30 min** (was 15). `open` and `acknowledged` both count as live for
  dedup/auto-resolve.
- `incidentClustersRepository` gains `acknowledge`/`resolve`/`count` and
  time-range + pagination on `list`.

### Tests
- API tests (happy path, 400/401/403/404/409, clean 500), pure unit tests for the
  confidence breakdown + root-cause classification + detail assembly, and a
  simulation test (10 agents, one shared finding-type within 3 min → exactly one
  cluster with all 10 members, confidence above the single-signal baseline).
