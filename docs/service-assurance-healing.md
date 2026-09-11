# When a test can no longer find something

Applications change. A button gets a new id, a field gets renamed, a developer
swaps a `<a>` for a `<button>`. The test that was watching it stops working —
and the failure looks exactly like the service being broken, which is the one
thing it must not be confused with.

BlueEyes looks at what *is* on the page and tells you what it thinks the step
meant:

```
This test cannot find an element

Step 1 (click)                                      confidence: high

  The test points at          →     Found on the page
  the button "Log ind"              the button "Log ind"

  the button "Log ind" no longer matches on id "login-button" → "signin-btn":
  same kind of element (button), still called "Log ind".

  [ Use the new one ]  [ Keep it as it is ]
```

## Nothing changes until you say so

**BlueEyes never repoints a test on its own.** Not when it is confident, not
when the evidence is overwhelming, not ever.

That is not caution for its own sake. A wrong heal is the worst thing this
feature could do: the test goes green, the dashboard goes green, and nobody
looks again — while the service is broken or the test is watching the wrong
button. A *missed* heal costs somebody five minutes in the designer.

So everything about it is biased towards proposing **nothing** rather than
something plausible-but-wrong:

- **Two elements it cannot tell apart → no proposal.** Two buttons both called
  "Save" is exactly when a guess goes wrong.
- **Weak evidence → no proposal.** A matching id on its own is not enough; an id
  is the thing that changes.
- **A proposal identical to what the step already says → no proposal.** The
  element failed for some other reason (timing, a hidden ancestor), and
  repointing the step at itself would hide that.

## How it decides

The priority order is the same one the runner uses to find elements in the first
place — role, label, text, placeholder, name, id, CSS — and the weights say the
same thing in numbers:

| Evidence | Worth | Why |
| --- | --- | --- |
| Same label | strongest | the words a person reads off the screen |
| Same accessible name | strongest | what you would call the button |
| Same visible text / placeholder | strong | |
| Same kind of element (button, link, field) | strong | a button that became a link is usually not the same control |
| Same `name` attribute | strong | |
| Same id | weakest | an id is precisely what tends to change |
| Same CSS path | nothing | a CSS path matching is what just failed |

A *different* kind of element counts **against** the match. Applications do turn
links into buttons, so it is not disqualifying — but it is not free either.

**Confidence** is what you should read before deciding:

- **High** — strong evidence, and nothing else on the page came close. You can
  accept without opening the application.
- **Medium** — a good match, but worth a look. Usually the words changed.
- **Low** — shown so you know it exists, not because BlueEyes believes it.

## Accept, reject, or neither

- **Use the new one** repoints the step and saves the test like any other edit,
  so it gets a version bump and a snapshot in the test's history.
- **Keep it as it is** records that you decided against it. The proposal is not
  offered again.
- **Neither** — edit the step yourself in the designer below. The proposal stays
  until you decide, and accepting after a manual edit is refused (see below).

You can also accept a *modified* version: if BlueEyes found the right element but
you would rather point at it a different way, the API takes your target instead
of its own.

## What stops a stale proposal from doing damage

A proposal describes a step as it was when the run failed. By the time somebody
reads it, the test may have changed. So accepting re-checks two things:

1. **The step still exists** at the path the proposal names. If it was deleted or
   reordered, the accept is refused — applying it would repoint a *different*
   step, which is the worst possible outcome.
2. **The step still says what the proposal was made against.** If somebody
   already re-targeted it by hand, this is not the step the proposal described,
   even though it sits in the same place.

In both cases the proposal is marked **stale** rather than left to be accepted
again tomorrow.

Accepting one proposal also makes the other open proposals for that step stale —
they were alternatives to a question that now has an answer.

## It is a log, not just a prompt

The row survives the decision. What the test used to point at, what was
proposed, what you chose, when, and who — so *"why does this test point at a
different button than it did in March"* has an answer six months later, in the
healing history as well as in the test's version history.

## Steps inside a condition block

They heal too. Proposals address a step by its **path** (`0`, or `2.1` for the
second step inside the block at index 2) rather than by a plain index — otherwise
healing would quietly not work on exactly the tests that are complicated enough
to break.

## For the technically curious

The browser side only *observes*: when a step's target does not resolve, the
driver collects up to 200 visible interactive elements and describes each one the
same way a target is described. Every judgement about what those observations
mean happens on the server, in `src/serviceTests/engine/heal.js`, which is a pure
function and tested on its own. Data model:
`migrations/085_create_service_test_healing.sql`.
