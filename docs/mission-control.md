# Mission Control — the Overview screen

`public/views/home.js`. The screen every shift starts on, and the answer to one
question: **what should somebody do next.**

It stores nothing, measures nothing and decides nothing. Five reads, all of them
endpoints another screen already calls:

| source | read | what it contributes |
| --- | --- | --- |
| fleet | `GET /api/fleet/health` | agents, and which of them are not reporting reliably |
| tshoot | `GET /api/troubleshooting/overview` | the live correlated root causes |
| changes | `GET /api/changes` | what changed in the last 24 h |
| events | `GET /api/events` | the per-device cases an operator works (`event_cases`) |
| situations | `GET /api/event-clusters` | the cross-agent clusters (`event_clusters`) |

Each read stands on its own. One failing takes its own panel down and says which
call failed; the counts it fed read as a dash, never a zero.

## One queue, not four lists

The screen used to show three shortlists side by side — root causes, unhealthy
agents, recent changes. Each was correct and none answered the question, because
"which of these matters most this minute" needs all three at once, and the reader
was doing that join by eye on arrival.

**Needs attention** is one ranked list. A row is not a new object: it IS a
situation, an event case, a correlated cause or an agent that stopped reporting,
and opening it opens that record — with its status, its timeline and its work
log (`docs/event-cases.md`, `docs/event-work-log.md`). No parallel incident
model was introduced, and none should be.

### The score

`attentionRows()` in `public/views/home.js` — pure, exported, and tested
directly in `test/homePage.test.js`, because the ordering is the product
decision on this screen.

| term | weight | why |
| --- | --- | --- |
| severity | ×1000 | CRIT before WARN before INFO. Nothing outranks it. |
| impact | ×50, capped at 9 | devices or members covered; past nine the difference stops being actionable |
| unattended | +300 | nobody has picked it up. An open thing outranks one somebody is already on — that is what makes it a queue |
| evidence | +120 | OBSERVED outranks SUSPECTED at equal severity |
| age | +hours, capped at 24 | a tie-breaker, never a driver: an old INFO must not climb over a fresh CRIT |

Equal scores fall back to a stable key, so two tied rows do not swap places on
every poll.

## Observed, suspected, no data

The **Basis** column, and the reason it exists: a correlated cause rendered like
a measurement is how somebody replaces the wrong switch.

| basis | what it means | which rows |
| --- | --- | --- |
| **Observed** | grouped from findings that actually fired on that device | event cases |
| **Suspected** | a cause the correlation proposes; the evidence is on the record behind the row | situations, root causes |
| **No data** | nothing is arriving, so everything it measures is *unknown* rather than fine | offline agents |

Impact is what the system **computed**: the row says "affects 9 devices", never
"9 devices are down". A situation carries the correlator's own `confidence`, and
it travels with the row rather than being restated as certainty.

## What we cannot see

The honest counterpart to the queue. An agent that is offline, stale or degraded
is not a healthy agent with a warning badge — every number that came from it is
now unknown, and a screen showing its last value as if it were current is worse
than one showing nothing.

- **NONE** — offline. Nothing is arriving.
- **UNRELIABLE** — online but not OK. What arrives cannot be leaned on.

The panel leads with "N of M agents are not sending data we can rely on", so the
gap is a sentence rather than something to infer from a table.

**Absence of data never renders as health.** An empty queue is "Nothing in the
queue" only when every source answered; with one source down it reads "Nothing
we could see", and a test asserts there is no green state over missing data.

## Related

- `docs/ui-contract.md` — the page template, the components, and what the rail is
  organised by
- `docs/event-cases.md` / `docs/event-work-log.md` — the records a queue row opens
- `docs/cross-agent-correlation.md` — how a situation is formed, and what its
  confidence means
