# User journeys

> **New to Service Assurance?** Read [the guide](service-assurance-guide.md) first — it is written to be read front to back. This document is a design of record.

A test tells you a page answered. A **journey** tells you whether someone can
actually do their job.

```
Customer lookup                                    FAILED
  1. Login            ✗   required   HTTP 500 from /api/auth/login
  2. Search Customer  —   required   never run
  3. Open Customer    —   required   never run
  4. Logout           ✓   optional

"Login" is failing, so the user cannot get through.
```

That is the whole point of the feature: not four green ticks, but one sentence
an operator can act on.

## What a journey is

A complete thing a user does, described in their words — "Customer lookup", not
"GET /api/customers". It carries:

| | |
| --- | --- |
| **Name and description** | what the user is trying to do |
| **Criticality** | Critical / High / Normal / Low — what it costs the business when it breaks. Your judgement, not a number BlueEyes works out |
| **Expected duration** | how long the whole thing should take. Blank is fine — no expectation is better than a guessed one |
| **Environment** | which environment this describes. Staging gets its own journey rather than a flag |
| **Steps** | the tests that prove it, in order |

## A journey owns no tests

This matters more than it sounds. A journey **orders tests that already exist**.
It has no steps of its own, no separate definition, no second test format.

So everything that works for a test works inside a journey on the day you create
one: the designer, recording, the runner, history, screenshots, incidents,
schedules. Nothing had to be taught about journeys.

It also means:

- **The same test can be step 1 of several journeys.** "Login" usually is. That
  is normal, not a mistake.
- **Deleting a journey never deletes the tests under it.** A journey is a way of
  *reading* your monitoring, not its owner.
- **A test tells you which journeys depend on it**, on its own page — so nobody
  deletes a test without seeing that they are about to stop watching a customer
  login.

## Required vs optional steps

This is the distinction that makes the verdict worth reading.

- A **required** step failing → the journey **failed**. The user cannot get through.
- An **optional** step failing → the journey is **degraded**. Part of the service
  is gone; the journey is not.

Logout failing is not the same event as Login failing. A monitoring system that
cannot say so makes its own alerts worthless, and people start ignoring them.

## How the verdict is worked out

Each step's **latest** run decides its outcome:

| Run | Outcome | Effect on the journey |
| --- | --- | --- |
| pass | works | — |
| warning | works, something was off | degrades, never fails |
| fail / error | does not work | fails it if required, degrades it if optional |
| queued / running | not known **yet** | neither good nor bad |
| never run | never found out | neither good nor bad |

Then:

- any required step broken → **Failed**
- any optional step broken, or any warning → **Degraded**
- everything working → **Healthy**
- nothing has run → **Not known yet**

**"Not known yet" is deliberately not a failure.** A journey nobody has run is
not a broken one, and colouring it red would train people to ignore red. An
empty journey — described but not yet implemented — reports the same way and
says so.

## Duration

A journey's duration is the sum of its steps' durations, and **only when every
step has one**. If any step is unmeasured, the journey's duration is unknown.

That rule exists because the alternative is worse: a partial sum compared against
an expectation for the whole journey reads as a *speed-up* when it is really a
missing measurement. Missing data must never look like good news.

A duration verdict appears only when you stated an expectation, and the tolerance
is generous (1.5×) — a synthetic journey drives a real browser over a real
network, and calling 1.1× "slow" would fire constantly.

## The application roll-up

The Journeys screen shows one verdict per application: the **worst** journey
decides the word, and the counts say how widespread it is. Journeys are listed
critical-first, so what matters most is read first.

## Discovery suggests journeys, not just tests

Discovery already proposes tests — "Login", "Search", "Availability". A test
suggestion answers *what could we check here*. It does not answer the question
the product exists to answer, which is *what does a user actually do here*.

So Discovery now also proposes journeys:

```
Suggested journeys

  Sign in and use the application            confidence: medium
    1. Login
    2. Authenticated navigation
    3. Logout · optional
  Reason: Discovery found a login flow and reached pages behind it.

  Sign in and search                         confidence: medium
    1. Login
    2. Search
  Reason: found a search field and a login flow, so the search is probably
  behind the login.
```

Rules, not AI — each one is a stated condition over what Discovery found, and
each carries its reason so you can judge it rather than trust it.

**Accepting a journey builds everything it needs**: the member tests, then the
journey that orders them. That is the chain the whole feature is for —
Discovery → suggested journey → you accept → tests created → runs → results
become evidence. A member you already accepted on its own is **reused**, never
duplicated, so history does not end up split across two copies of the same check.

If a member suggestion has gone (a newer Discovery replaced it, say), the accept
is **refused before anything is created** rather than leaving you a journey
missing its middle.

### When you already have a journey for that flow

The first time anyone runs Discovery on a service they already monitor, the
suggestion will describe a journey they built by hand months ago. Accepting used
to create a second one silently — same tests in it, both reporting on the same
service, nothing saying so.

Now the accept is **refused once, with 409**, and says what it found:

```json
{
  "error": "This application already has a journey covering some of these steps",
  "overlaps": [{
    "journey_id": 4,
    "name": "Fellis run for About Fellis",
    "step_count": 2,
    "already_covers": ["Login"],
    "would_add": ["Authenticated navigation"]
  }]
}
```

Two ways to answer, and the operator picks — which journey is the real one is a
judgement about their service, not something a heuristic gets to decide:

| Send | What happens |
| --- | --- |
| `{ "merge_into_journey_id": 4 }` | the **missing** steps are appended to journey 4, in the suggestion's order, after what is already there |
| `{ "confirm": true }` | a separate journey is created, as before |

Merging never re-orders what you built — appending is the only change it makes,
because rewriting your ordering to match a heuristic's would be a much ruder act
than suggesting one. And a member the overlap report called *already covered*
reuses that journey's existing test rather than creating a second one under the
same name; that duplicate was the complaint in the first place.

Matching is by the tests themselves where they exist, and by **name** where they
do not (a suggested test does not exist until something accepts it), scoped to
the one application. Name matching across an estate would be meaningless —
"Login" is the commonest test name there is — but inside one application it is
the same check a person would make.

With no overlapping journey, nothing changes: the accept creates the journey
without asking anything.

Four things the rules deliberately do:

- **"Availability" never becomes a journey.** Opening the front page and getting
  HTTP 200 is the definition of "the website is up" — the exact sentence
  journeys exist so BlueEyes stops saying. It stays a useful test.
- **The smaller journey is dropped when a bigger one contains it.** "Sign in"
  and "Sign in and use the application" both apply whenever there is a login
  with pages behind it; offering both means accepting two journeys that watch
  the same login.
- **Confidence is the weakest link.** A high-confidence login plus a
  low-confidence search is a low-confidence journey, so your attention goes to
  the part that might be wrong.
- **Criticality is proposed, not decided.** The heuristic suggests one; you
  change it in the same dialog, before anything is created. It is your judgement
  about your business, and BlueEyes does not get a vote.

## Who can do what

| | Viewer | Operator | Admin |
| --- | --- | --- | --- |
| See journeys and their verdicts | ✓ | ✓ | ✓ |
| Create, edit, re-order, delete | | ✓ | ✓ |

Same as tests, deliberately: describing the journeys your service is made of is
the same kind of work as building the tests under them, done by the same people.

## API

| | |
| --- | --- |
| `GET /api/service-tests/journeys` | every journey with its verdict, plus the application roll-up |
| `POST /api/service-tests/journeys` | create |
| `GET /api/service-tests/journeys/:id` | one journey, its verdict and its steps |
| `PUT /api/service-tests/journeys/:id` | rename, re-rate, set the expectation |
| `PUT /api/service-tests/journeys/:id/steps` | replace the membership, in order |
| `POST /api/service-tests/journeys/:id/run` | run the whole journey now — one queued run per step |
| `DELETE /api/service-tests/journeys/:id` | delete the journey (never its tests) |

Running a journey is running its member tests: one queued run each, in the
journey's order, using the journey's environment unless the request names
another. There is no third kind of run and no new worker protocol — the worker
picks these up the way it picks up any other run, and the verdict is computed
from their results as it always was. The response lists every run it queued, so
"it is running" is a list of things you can open rather than a spinner, and it
carries the worker status so a queued journey with no worker reads as a
configuration problem rather than a hang. A journey with no steps is refused
rather than answered with an empty list.

Steps are sent as a **whole list** rather than added and removed one at a time,
because the screen is a drag & drop list: "this is the order now" is the only
statement such a UI can make truthfully. A step must name a test belonging to the
journey's own application — a journey is about one service, and a step pointing
elsewhere would make its verdict a statement about something else.

Data model: `migrations/083_create_service_test_journeys.sql`. The verdict logic
is `src/serviceTests/journeys/health.js`, pure and tested on its own.
