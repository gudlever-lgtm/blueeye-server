# Accessibility checks

*Spec: `docs/service-assurance-v2.md` §9.*

BlueEyes already drives a real browser through a real journey. While it is there,
it can answer a second question at almost no cost: **can everybody use this?**

## The one rule everything else follows from

**An accessibility finding never fails a run.**

The spec says these are reported *separately from functional failures*, and that
is not a presentation detail. An image with no alt text is not the service being
down. Mixing the two costs you both:

- the run status stops meaning "the journey works"
- the accessibility report becomes the thing people switch off to get a green
  build — and a switched-off check protects nobody

So the findings ride **beside** the result. `status` is decided before the audit
runs and nothing in the audit can touch it. On screen they sit below the steps,
in their own panel, with no red and no status chip: nothing that can be mistaken
for the verdict.

## What is checked

| Rule | Impact | What it means |
| --- | --- | --- |
| `button-name` / `link-name` | serious | A control a screen reader announces as just "button" or "link" |
| `field-label` | serious | A form field with nothing saying what belongs in it |
| `placeholder-not-label` | moderate | A field identified only by its placeholder, which vanishes on the first keystroke |
| `image-alt` | serious | An `<img>` with **no** `alt` attribute at all |
| `heading-h1` | moderate | No level-1 heading — what someone jumping by headings lands on first |
| `heading-order` | minor | A skipped level (h2 → h4), which reads as a missing section |
| `keyboard-reachable` | serious | Clickable with a mouse, unreachable with a keyboard |
| `tabindex-positive` | moderate | A positive `tabindex`, which jumps the queue instead of joining it |
| `html-lang` | serious | No `lang`, so a screen reader pronounces the page as another language |
| `document-title` | moderate | No title — "Untitled" in every tab, bookmark and load announcement |

**Impact, not severity.** Deliberately a different vocabulary from
CRIT/WARN/INFO, so nobody reads a finding as an incident and so the two can never
be summed into one misleading number.

## What is deliberately NOT flagged

A report earns its reputation on its false positives. A noisy one is switched off
within a week.

- **`alt=""` is correct** and is never a finding. It is how you say "this picture
  carries no information". Flagging it pushes people into writing noise for a
  screen reader to read out. *Absent* and *empty* are different facts, and the
  collector keeps them apart rather than flattening both to "falsy".
- **Hidden elements are not problems.** `aria-hidden`, `hidden`, `display:none`
  and `visibility:hidden` are how carousels, drawers and off-screen menus are
  built. They are not part of the page.
- **Going back up a heading level is normal.** h3 → h2 is just the next section.
  Only downward jumps count.
- **A placeholder alongside a real label** is good practice, not a fault.
- **A disabled control** is not a keyboard problem — it is deliberately
  unavailable to everybody.

## What it does not claim

These are **basic checks, not an audit.** A page with no findings is a page where
*these checks* found nothing — the panel says so in as many words rather than
implying the page is accessible.

Hand-written rules rather than a library, matching the repo's local-and-
explainable rule: no cloud, no heavyweight dependency, and no third-party auditor
injected into a customer's page under test. The cost is narrower coverage, which
is why the wording above is careful.

One thing the collector genuinely cannot see: a click handler added with
`addEventListener`. No script can enumerate those. `keyboard-reachable` therefore
finds the common case (inline `onclick`, button-ish classes) and does not pretend
to find all of them.

## "Not collected" is not "clean"

`accessibility` is **NULL** when the check did not run:

- the worker predates the feature
- the page would not evaluate (navigated away, closed, cross-origin)
- the check is turned off

Null is never rendered as an empty, reassuring panel — nothing is shown at all. A
page nobody looked at is not a page that passed. When a report *is* present it
carries `checked.elements`, so a zero-finding result can be read honestly.

## Turning it off

Settings → Service Assurance → `runner.accessibility`. On by default: it costs
one read-only evaluate at the end of a run and can never change the outcome. The
switch is there for a customer with a page it chokes on, so they can stop
collecting without losing the test.

## Where it lives

| Piece | File |
| --- | --- |
| The rules (pure — no DOM, no browser, no clock) | `src/serviceTests/a11y/rules.js` |
| The in-page collector (read-only, facts only) | `src/serviceTests/a11y/collect.js` |
| Driver method | `accessibilitySnapshot()` in `runner/driver.js` |
| Attached to the result | `auditPage()` in `runner/execute.js` |
| Storage | `service_test_runs.accessibility`, migration 087 |
| Dashboard | `accessibilityPanel()` in `public/serviceAssurance.js` |
| Tests | `src/serviceTests/a11y/__tests__/` |

The split between `collect.js` and `rules.js` is the point: the collector needs a
DOM and so cannot be unit-tested, which means it must contain nothing worth
arguing about. Every judgement lives in `rules.js`, where it can be argued with in
a test.
