# User journeys

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
| `DELETE /api/service-tests/journeys/:id` | delete the journey (never its tests) |

Steps are sent as a **whole list** rather than added and removed one at a time,
because the screen is a drag & drop list: "this is the order now" is the only
statement such a UI can make truthfully. A step must name a test belonging to the
journey's own application — a journey is about one service, and a step pointing
elsewhere would make its verdict a statement about something else.

Data model: `migrations/083_create_service_test_journeys.sql`. The verdict logic
is `src/serviceTests/journeys/health.js`, pure and tested on its own.
