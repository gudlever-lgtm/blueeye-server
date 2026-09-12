'use strict';

const { numOrNull } = require('../storage/shape');

// Recurrence detection (V3 Phase 2, docs/service-assurance-v3.md §"Historical
// intelligence and recurrence").
//
//     Similar incidents detected. Customer API, HTTP 500. 12 occurrences.
//
// The question this answers is not "has this happened before" — a counter does
// that. It is the one an operator actually has at 09:00 on a Monday:
//
//     Is this the same problem coming back, and did anybody ever fix it?
//
// Those are different questions and they have different answers. A problem that
// resolves and returns every week was never fixed; it was waited out. A problem
// whose gaps are shrinking is getting worse. A problem seen three times in one
// afternoon and never since is one bad afternoon. Reporting all three as
// "12 occurrences" throws away everything that made the number worth having.
//
// PURE: an incident and the incidents before it in, a pattern out. No database,
// no clock beyond the `now` that is handed in.
//
// Two rules:
//
//   1. A PATTERN NEEDS ENOUGH SAMPLES TO BE ONE. Two incidents eleven days
//      apart are not a fortnightly cycle, and a "every Monday at 09:00" drawn
//      through three points is astrology with a timestamp. Every claim here
//      names the minimum it needed, and refuses below it rather than hedging.
//   2. Sameness is a JUDGEMENT and it is graded. Two incidents can be the same
//      fault on the same thing, the same thing failing differently, or the same
//      fault spreading across different things — and those send somebody to
//      three different places. Collapsing them into one "similar" is how a
//      recurrence report stops being read.

// How two incidents can be the same problem, strongest first. The order is the
// order they are preferred in: a set of identical matches is never diluted with
// looser ones.
const MATCH = {
  // The same fault on the same thing. "HTTP 500 on the Customer API", again.
  IDENTICAL: 'identical',
  // The same thing, failing differently. Worth knowing: a host that breaks in
  // four different ways is a host with something wrong with it.
  SAME_SUBJECT: 'same_subject',
  // The same fault, somewhere else. This is how a spreading problem looks
  // before anybody has called it one.
  SAME_FAULT: 'same_fault',
};

const MATCH_ORDER = [MATCH.IDENTICAL, MATCH.SAME_SUBJECT, MATCH.SAME_FAULT];

// Below this there is no recurrence to report — one prior occurrence is a
// coincidence, and a screen that says "seen before!" every second failure is one
// people learn to scroll past.
const MIN_OCCURRENCES = 3;

// A rhythm needs this many gaps to be a rhythm. Four occurrences give three
// gaps, which is the fewest that can be consistent rather than merely two
// points and a line through them.
const MIN_FOR_RHYTHM = 4;

// How much the gaps may vary and still be called regular, as a fraction of the
// median gap. A quarter is loose on purpose: real recurrences drift — a weekly
// batch job is not a metronome — and a threshold that only accepts a metronome
// would never fire on anything real.
const RHYTHM_TOLERANCE = 0.25;

// An incident that came back within this long of being resolved was not fixed.
// Somebody watched it go away.
const FLAP_WINDOW_HOURS = 6;

// The gaps have to shrink by this much before "it is getting worse" is said.
// Below it, the difference is the drift any real recurrence has.
const WORSENING_RATIO = 0.7;

const HOUR = 3600000;

const asDate = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const text = (v) => (v === null || v === undefined ? '' : String(v));

function median(values) {
  // Exported, so it is called by things this file does not control — and
  // `values.filter` on a null is one of the throws the never-throw sweep exists
  // to catch. It caught this one.
  const list = (Array.isArray(values) ? values : []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

// How alike are these two incidents?
//
// Returned as a grade rather than a boolean, because the grades mean different
// things and the caller has to be able to tell them apart. Null when they are
// not the same problem at all — which is most pairs, and saying so clearly is
// what keeps the ones that ARE from being buried.
function matchGrade(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  const sameSubject = text(a.subject_key) !== '' && text(a.subject_key) === text(b.subject_key);
  const sameKind = text(a.kind) !== '' && text(a.kind) === text(b.kind);
  if (sameSubject && sameKind) return MATCH.IDENTICAL;
  if (sameSubject) return MATCH.SAME_SUBJECT;
  if (sameKind) return MATCH.SAME_FAULT;
  return null;
}

// The pattern, if there is one.
//
// `incident` is the one being looked at; `history` is everything that came
// before it, in any order. Returns null when there is nothing worth saying —
// which is the common case, and an empty report would read as a finding.
function findRecurrence(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const incident = (input.incident && typeof input.incident === 'object' && !Array.isArray(input.incident))
    ? input.incident : null;
  if (!incident) return null;
  const now = asDate(input.now) || new Date();

  const history = (Array.isArray(input.history) ? input.history : [])
    .filter((x) => x && typeof x === 'object')
    // The incident is never its own precedent, however it arrives.
    .filter((x) => String(x.id) !== String(incident.id));

  // Graded, then taken at the strongest grade that clears the minimum. A set of
  // identical matches is never diluted with looser ones — "12 occurrences" that
  // is really 3 identical and 9 vaguely-related is the number that gets the
  // whole feature switched off.
  const graded = new Map(MATCH_ORDER.map((g) => [g, []]));
  for (const past of history) {
    const grade = matchGrade(incident, past);
    if (grade) graded.get(grade).push(past);
  }

  let match = null;
  let related = [];
  for (const grade of MATCH_ORDER) {
    // +1 for the incident in hand: it is an occurrence too.
    if (graded.get(grade).length + 1 >= MIN_OCCURRENCES) { match = grade; related = graded.get(grade); break; }
  }
  if (!match) return null;

  // Ordered by when they started. Anything undated is counted but cannot carry
  // a gap — a recurrence with no timestamps is still a recurrence.
  const all = [...related, incident]
    .map((x) => ({
      id: x.id ?? null,
      opened_at: asDate(x.opened_at),
      resolved_at: asDate(x.resolved_at),
      severity: x.severity || null,
      summary: x.summary || null,
      status: x.status || null,
    }))
    .sort((a, b) => {
      if (a.opened_at && b.opened_at) return a.opened_at - b.opened_at;
      if (a.opened_at) return 1;
      if (b.opened_at) return -1;
      return 0;
    });

  const dated = all.filter((x) => x.opened_at);
  const first = dated[0] ? dated[0].opened_at : null;
  const last = dated.length ? dated[dated.length - 1].opened_at : null;

  // The gaps between one starting and the next, in hours.
  const gaps = [];
  for (let i = 1; i < dated.length; i += 1) {
    gaps.push((dated[i].opened_at - dated[i - 1].opened_at) / HOUR);
  }

  // How long each one lasted, and how long the quiet between them was. The
  // second is the one that answers "did anybody fix it": a problem that returns
  // an hour after being closed was not fixed.
  const durations = [];
  const quiets = [];
  for (let i = 0; i < dated.length; i += 1) {
    const row = dated[i];
    if (row.resolved_at && row.opened_at) durations.push((row.resolved_at - row.opened_at) / HOUR);
    const next = dated[i + 1];
    if (row.resolved_at && next && next.opened_at) quiets.push((next.opened_at - row.resolved_at) / HOUR);
  }

  const everResolved = dated.some((x) => x.resolved_at);
  const medianQuiet = median(quiets);
  // "It came back before anybody had finished writing it up." Only claimable
  // when something actually resolved — an incident that never closed cannot
  // have flapped, it simply never stopped.
  const flapping = quiets.length >= 2 && medianQuiet !== null && medianQuiet <= FLAP_WINDOW_HOURS;
  // Never stayed fixed: it resolved, and every quiet period was short.
  const chronic = everResolved && quiets.length >= 2 && quiets.every((q) => q <= FLAP_WINDOW_HOURS * 4);

  return {
    match,
    // The count INCLUDES the one in hand. "12 occurrences" means twelve times,
    // not twelve previous times plus this one — the off-by-one everybody makes
    // reading it aloud.
    occurrences: all.length,
    first_seen: first,
    last_seen: last,
    span_days: first && last ? Math.max(0, Math.round((last - first) / 86400000)) : null,
    // Every claim below names what it needed, so a reader can see why a rhythm
    // was or was not reported rather than guessing at a threshold.
    minimum_occurrences: MIN_OCCURRENCES,
    interval: intervalOf(gaps),
    resolution: {
      ever_resolved: everResolved,
      median_hours: median(durations),
      median_quiet_hours: medianQuiet,
      still_open: !incident.resolved_at,
    },
    flapping,
    chronic,
    rhythm: rhythmOf(dated),
    summary: summarise(incident, match, all.length, gaps, flapping, chronic),
    // The occurrences themselves, so the claim can be checked rather than
    // trusted. Capped: a recurrence with 400 members is a report, not a list.
    evidence: all.slice(-25).map((x) => ({
      id: x.id,
      opened_at: x.opened_at,
      resolved_at: x.resolved_at,
      severity: x.severity,
      summary: x.summary,
    })),
    source: 'rules',
    now,
  };
}

// The gaps, and whether they are closing.
function intervalOf(gaps) {
  const med = median(gaps);
  if (med === null) return { median_hours: null, shrinking: null, samples: gaps.length };
  // Getting worse is the first half compared with the second, not the last gap
  // compared with the median — one short gap is noise, and a trend read off a
  // single point is how a dashboard cries wolf.
  let shrinking = null;
  if (gaps.length >= 4) {
    const half = Math.floor(gaps.length / 2);
    const early = median(gaps.slice(0, half));
    const late = median(gaps.slice(half));
    if (early !== null && late !== null && early > 0) shrinking = (late / early) <= WORSENING_RATIO;
  }
  return { median_hours: med, shrinking, samples: gaps.length };
}

// Does it happen at a particular time?
//
// The most actionable historical finding there is — "every Monday around 09:00"
// names a batch job somebody can go and look at. It is also the easiest thing
// here to make up, so it is the most heavily guarded: a weekday has to hold for
// every occurrence, not most, and below MIN_FOR_RHYTHM nothing is claimed at
// all.
function rhythmOf(dated) {
  if (dated.length < MIN_FOR_RHYTHM) {
    return { kind: null, detail: null, samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: false };
  }
  const days = dated.map((x) => x.opened_at.getUTCDay());
  const hours = dated.map((x) => x.opened_at.getUTCHours());

  const sameDay = days.every((d) => d === days[0]);
  const hourSpread = Math.max(...hours) - Math.min(...hours);
  const sameHour = hourSpread <= 2;

  if (sameDay && sameHour) {
    return {
      kind: 'weekly',
      detail: `every ${WEEKDAY[days[0]]} around ${String(hours[0]).padStart(2, '0')}:00 UTC`,
      samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: true,
    };
  }
  if (sameDay) {
    return {
      kind: 'weekly',
      detail: `every ${WEEKDAY[days[0]]}`,
      samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: true,
    };
  }
  if (sameHour) {
    return {
      kind: 'daily',
      detail: `around ${String(hours[0]).padStart(2, '0')}:00 UTC`,
      samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: true,
    };
  }
  // Regular without landing on a clock face: "about every 38 hours". Reported,
  // because a machine cycle is a real thing, but not dressed up as a schedule.
  const gaps = [];
  for (let i = 1; i < dated.length; i += 1) gaps.push((dated[i].opened_at - dated[i - 1].opened_at) / HOUR);
  const med = median(gaps);
  if (med !== null && med > 0 && gaps.every((g) => Math.abs(g - med) <= med * RHYTHM_TOLERANCE)) {
    return {
      kind: 'regular',
      detail: `about every ${Math.round(med)} hour${Math.round(med) === 1 ? '' : 's'}`,
      samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: true,
    };
  }
  return { kind: null, detail: null, samples: dated.length, minimum: MIN_FOR_RHYTHM, confident: false };
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The sentence from the spec, plus the part that makes it worth reading.
//
//     Similar incidents detected. Customer API, HTTP 500. 12 occurrences.
//
// The count alone says it happened a lot. What an operator needs next is
// whether it was ever fixed, and that is what the tail of this sentence is for.
function summarise(incident, match, occurrences, gaps, flapping, chronic) {
  const what = [text(incident.subject_label) || text(incident.subject_key), text(incident.kind)]
    .filter(Boolean).join(', ');
  const head = match === MATCH.IDENTICAL
    ? `Similar incidents detected. ${what}. ${occurrences} occurrences.`
    : match === MATCH.SAME_SUBJECT
      ? `This has failed before in other ways. ${what}. ${occurrences} incidents on the same thing.`
      : `The same failure has been seen elsewhere. ${text(incident.kind)}. ${occurrences} occurrences across different subjects.`;

  if (flapping) return `${head} It keeps coming back within hours of being resolved, so it has not been fixed.`;
  if (chronic) return `${head} It has been resolved and returned each time.`;
  const med = median(gaps);
  if (med !== null && med >= 24) return `${head} Roughly every ${Math.round(med / 24)} day${Math.round(med / 24) === 1 ? '' : 's'}.`;
  return head;
}

module.exports = {
  findRecurrence, matchGrade, median,
  MATCH, MATCH_ORDER, MIN_OCCURRENCES, MIN_FOR_RHYTHM, RHYTHM_TOLERANCE,
  FLAP_WINDOW_HOURS, WORSENING_RATIO,
};
