# Visual regression

*Spec: `docs/service-assurance-v2.md` §8.*

Opt-in screenshot baselines on chosen steps: accept one, compare against it,
accept a new one when the page legitimately changes, ignore the parts you know
move.

## The problem this feature usually fails at

The spec's own warning: it "must not turn small dynamic differences into false
failures".

Every visual regression tool that ends up switched off is switched off for the
same reason. A clock, a carousel, an A/B slot or one pixel of antialiasing turns
the build red once too often, somebody adds the flag that skips it, and nobody
looks at it again. A check nobody looks at watches nothing.

So this one is deliberately reluctant, with four defences in order:

1. **A per-pixel colour tolerance** (default 12/255), so antialiasing and
   sub-pixel text rendering are not differences. Two screenshots of an
   *unchanged* page are never byte-identical.
2. **Ignore regions** you draw over the parts you know move.
3. **A percentage threshold** (default 0.5%), so a handful of changed pixels is
   not a report.
4. **A difference is never a failure.** The run's status stays about whether the
   service works.

The comparison is per-channel rather than a Euclidean distance, on purpose: a red
button turning green moves two channels a long way, and averaging would dilute
that toward the middle. The thing a person would obviously call *different* must
not be what the maths smooths away.

## Accepting is an act

Nothing is compared until somebody accepts a baseline. A picture captured
automatically on first sight would be a baseline of whatever the page looked like
that day — **including broken** — and every later comparison would be against
that.

So the flow is: a run happens, you look at the screenshot, and you say *yes, this
is what it should look like*. The row records who and when, because a baseline
nobody will admit to accepting is one nobody dares replace.

The image always comes from a **run**, never an upload: a baseline has to be
something this test actually produced against this service.

## One baseline per step per environment

The same journey against staging and production legitimately looks different, and
one shared baseline would report that difference forever. An environment-specific
baseline wins over an environment-less one; the general one is the fallback for a
test that only ever runs in one place.

## The four answers

| Status | Meaning |
| --- | --- |
| `match` | The same page, within tolerance. Reported as a match, not as "0.2% different" — that phrasing invites somebody to treat a clean comparison as a small problem |
| `changed` | Enough of it moved to be worth a person looking, with the changed areas as a few boxes |
| `resized` | A **different shape** of page. Not a percentage: a page that grew a section is not "3.4% different", and a percentage over the overlap answers a question nobody asked |
| `uncomparable` | One of them could not be read at all |

`uncomparable` matters more than it looks. Reporting an unreadable baseline as a
match would mean a step **silently stops being watched** — the worst failure mode
this feature has, because everything keeps reporting green.

Note what is *not* in that list: `fail`.

## Where the pictures live

Baselines live on disk under the artifact root, at `baselines/<test>/`, and
deliberately **not** in a run directory. Retention deletes old runs; a baseline
that vanished when the run it came from aged out would stop watching the page
without anybody being told. A baseline is a decision somebody made, not an
artefact of one execution. There is a test for exactly this.

Always PNG, whatever format run screenshots use — a JPEG baseline would make
every comparison fight its own compression artefacts.

The database stores the path, not the image. A few hundred baselines as blobs
would turn every dump into hundreds of megabytes to solve a problem the artifact
store already solves.

## The PNG decoder

Comparing encoded bytes is useless — two encoders, or the same encoder on a
different day, produce different bytes for an identical picture. So the pixels
have to be decoded, and `src/serviceTests/visual/png.js` does it in about two
hundred lines: PNG is inflate plus five filter types, and `zlib` is in the
standard library.

Written rather than installed because the alternative is an image dependency
(usually with native bindings) in a product whose pitch is that it runs on your
own machine with nothing phoning home.

It decodes what Playwright emits — 8-bit, non-interlaced — and **refuses
everything else by name** rather than guessing. A decoder that quietly mis-read a
16-bit image would produce a difference that looks real and is not, which is far
worse than a clear "cannot read this".

## API

| | |
| --- | --- |
| `GET /api/service-tests/baselines?test_id=` | what is being watched |
| `POST /api/service-tests/baselines` | accept a run's screenshot as the baseline |
| `PUT /api/service-tests/baselines/:id` | ignore regions, tolerance, threshold, on/off |
| `DELETE /api/service-tests/baselines/:id` | stop watching this step |
| `GET /api/service-tests/baselines/:id/image` | the baseline picture |

`PUT` deliberately cannot change the **image**. Replacing what the page should
look like is accepting a new baseline, which records who did it and when; letting
an edit swap the picture would lose that.

`DELETE` leaves the file on disk. The row is cheap to delete and an unlinked file
is swept with the rest — deleting the picture would make an accidental delete
unrecoverable.

Turning a baseline **off** keeps it and its ignore regions while stopping the
comparison, so "we know this page is in flux this month" does not mean deleting
work.

## Where it lives

| Piece | File |
| --- | --- |
| PNG decode (pure) | `src/serviceTests/visual/png.js` |
| The comparison (pure) | `src/serviceTests/visual/compare.js` |
| Per-step capture during a run | `captureFor()` in `runner/execute.js` |
| Baseline storage on disk | `saveBaseline()` in `runner/artifacts.js` |
| Data access | `src/serviceTests/storage/baselinesRepository.js` |
| HTTP | `src/serviceTests/api/baselines.js` |
| Dashboard | `visualPanel()` in `public/serviceAssurance.js` |
| Data model | migration 088 |

A step that FAILED is never photographed: comparing the error state against the
working one would call it a visual change, which is a second wrong answer on top
of the real failure.
