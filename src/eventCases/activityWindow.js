'use strict';

// How long an event stays "live" — the span of quiet after which the condition
// counts as finished rather than still going.
//
// ONE constant, because two places have to agree on it and previously did not:
//
//   * eventCaseService groups a new anomaly into the open event on that device
//     when it arrives within this window of the event's last activity;
//   * autoResolveJob resolves an investigating event after this much quiet.
//
// They were 60 s and 15 min respectively, and that gap was a bug. For the
// fourteen minutes in between, the event was still OPEN but a new anomaly
// refused to join it — so it opened a SECOND open event on the same device.
// A probe breaching every few minutes (the normal case: probe cadence is
// minutes, not seconds) therefore produced a wall of near-identical events
// instead of one recurring one.
//
// The 60 s came from the correlator's DEFAULT_WINDOW_MS, which answers a
// different question. The correlator groups findings that fired *simultaneously*
// into one root cause; an event is a condition *tracked over its lifetime*. Only
// the second one is "is this still going?", and that is the judgement both
// callers here are making — so they read the same number.
//
// Recurrence keeps an event alive: every anomaly that groups in advances
// last_event_at, so a condition that keeps firing stays ONE event for as long as
// it lasts. A genuine quiet gap longer than this window is what starts a new
// one, which is the honest boundary — it means the condition cleared and came
// back, and merging across it would misreport when the problem started.
const EVENT_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

// THE SAME BUG, ONE LAYER UP: a finding source that de-dupes.
//
// "Recurrence keeps an event alive" holds only if the recurrence reaches the
// event. The probe pipeline deliberately does NOT re-raise an ongoing problem on
// every probe — it holds the same (metric, target) back for a cooldown. That
// cooldown was 30 min against this 15 min window, so a probe fault that never
// cleared still went quiet, AS FAR AS THE EVENT COULD SEE, for 30 min at a time:
// every re-raise landed after the window had closed and opened a NEW event on
// the same host, roughly every half hour, for as long as the fault lasted.
//
// So a source that holds recurrences back may hold them back for at most
// MAX_REFIRE_COOLDOWN_MS: the window minus REFIRE_SLACK_MS. The slack is how
// long after its cooldown expires a still-present condition can take to be
// raised again — the next probe/sample to arrive and be evaluated (agent probe
// cadence is 60 s by default; five minutes leaves room for a slow agent or a
// late batch). Derived here, next to the window it has to fit inside, so the
// two cannot drift apart again.
const REFIRE_SLACK_MS = 5 * 60 * 1000;
const MAX_REFIRE_COOLDOWN_MS = EVENT_ACTIVITY_WINDOW_MS - REFIRE_SLACK_MS;

module.exports = { EVENT_ACTIVITY_WINDOW_MS, REFIRE_SLACK_MS, MAX_REFIRE_COOLDOWN_MS };
