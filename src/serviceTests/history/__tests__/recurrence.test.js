'use strict';

// Recurrence detection: does it find the pattern, and does it refuse to invent
// one?
//
// The second half is the harder half. "Every Monday at 09:00" is the most
// useful sentence this module can produce and the easiest one to fabricate —
// three points can be made to lie on any line. So most of these specs are about
// what it declines to say.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findRecurrence, matchGrade, MATCH, MIN_OCCURRENCES, MIN_FOR_RHYTHM, FLAP_WINDOW_HOURS,
} = require('../recurrence');

const HOUR = 3600000;
const at = (iso) => new Date(iso);

let nextId = 100;
const incident = (over = {}) => ({
  id: (nextId += 1),
  subject_key: 'api:portal.kunde.dk',
  subject_label: 'Customer API',
  kind: 'http_500',
  severity: 'CRIT',
  summary: 'HTTP 500 from /api/customer/search',
  status: 'resolved',
  opened_at: at('2026-09-07T09:00:00Z'),
  resolved_at: at('2026-09-07T10:00:00Z'),
  ...over,
});

// A weekly series: same weekday, same hour, resolved an hour later each time.
function weekly(count, { start = '2026-08-03T09:00:00Z', resolveAfterHours = 1 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const opened = new Date(at(start).getTime() + i * 7 * 24 * HOUR);
    out.push(incident({
      opened_at: opened,
      resolved_at: resolveAfterHours === null ? null : new Date(opened.getTime() + resolveAfterHours * HOUR),
    }));
  }
  return out;
}

// ------------------------------------------------------------ what is "same"
test('sameness is graded, because the three grades send you to different places', () => {
  const a = incident();
  assert.equal(matchGrade(a, incident()), MATCH.IDENTICAL);
  assert.equal(matchGrade(a, incident({ kind: 'timeout' })), MATCH.SAME_SUBJECT);
  assert.equal(matchGrade(a, incident({ subject_key: 'api:anden.dk' })), MATCH.SAME_FAULT);
  assert.equal(matchGrade(a, incident({ subject_key: 'api:anden.dk', kind: 'timeout' })), null);
});

test('an incident with no subject and no kind matches nothing', () => {
  // Otherwise two empty rows are "identical" and every unclassified failure
  // becomes a recurrence of every other one.
  const blank = incident({ subject_key: '', kind: '' });
  assert.equal(matchGrade(blank, incident({ subject_key: '', kind: '' })), null);
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(matchGrade(incident(), bad), null);
    assert.equal(matchGrade(bad, incident()), null);
  }
});

test('a strong match is never diluted with looser ones', () => {
  // "12 occurrences" that is really 3 identical and 9 vaguely related is the
  // number that gets the whole feature switched off.
  const identical = weekly(4);
  const sameSubjectOnly = [incident({ kind: 'timeout' }), incident({ kind: 'tls_failure' })];
  const result = findRecurrence({
    incident: identical[3],
    history: [...identical.slice(0, 3), ...sameSubjectOnly],
  });
  assert.equal(result.match, MATCH.IDENTICAL);
  assert.equal(result.occurrences, 4, 'the loose matches were counted as the same problem');
});

test('a looser grade is used only when the strong one is not there', () => {
  const result = findRecurrence({
    incident: incident({ kind: 'http_500' }),
    history: [incident({ kind: 'timeout' }), incident({ kind: 'tls_failure' })],
  });
  assert.equal(result.match, MATCH.SAME_SUBJECT);
  assert.match(result.summary, /failed before in other ways/);
});

// -------------------------------------------------------- refusing to claim
test('one previous occurrence is a coincidence, not a recurrence', () => {
  assert.equal(findRecurrence({ incident: incident(), history: [incident()] }), null);
  assert.equal(findRecurrence({ incident: incident(), history: [] }), null);
});

test('the threshold counts the incident in hand, and says what it was', () => {
  const series = weekly(MIN_OCCURRENCES);
  const result = findRecurrence({ incident: series[series.length - 1], history: series.slice(0, -1) });
  assert.equal(result.occurrences, MIN_OCCURRENCES);
  assert.equal(result.minimum_occurrences, MIN_OCCURRENCES);
});

test('an incident is never its own precedent', () => {
  // The same row arriving in both arguments — which is exactly what a repository
  // that fetches "recent incidents" will hand over.
  const one = incident();
  assert.equal(findRecurrence({ incident: one, history: [one, one] }), null);
});

test('it never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {},
    { incident: null }, { incident: 'x' }, { incident: incident(), history: 'no' },
    { incident: incident(), history: [null, 7, {}] },
    { incident: incident({ opened_at: 'not a date' }), history: weekly(4) }]) {
    assert.doesNotThrow(() => findRecurrence(input), JSON.stringify(input));
  }
});

test('undated occurrences are counted but never given a gap', () => {
  const series = weekly(3);
  const undated = incident({ opened_at: null, resolved_at: null });
  const result = findRecurrence({ incident: series[2], history: [...series.slice(0, 2), undated] });
  assert.equal(result.occurrences, 4, 'it happened, whether or not anybody wrote down when');
  assert.equal(result.interval.samples, 2, 'and it contributed no interval it could not support');
});

// ---------------------------------------------------------------- rhythm
test('a weekly problem is named by its day and hour', () => {
  const series = weekly(5);
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.rhythm.kind, 'weekly');
  assert.match(result.rhythm.detail, /Monday around 09:00 UTC/);
  assert.equal(result.rhythm.confident, true);
});

test('three points are not a schedule, however neatly they line up', () => {
  // The rule this module is really about. Three perfectly weekly occurrences
  // look exactly like a batch job and are just as likely to be three bad days.
  const series = weekly(3);
  const result = findRecurrence({ incident: series[2], history: series.slice(0, 2) });
  assert.equal(result.rhythm.kind, null);
  assert.equal(result.rhythm.confident, false);
  assert.equal(result.rhythm.minimum, MIN_FOR_RHYTHM, 'it does not say what it would have needed');
  assert.ok(result.occurrences >= MIN_OCCURRENCES, 'the recurrence itself is still reported');
});

test('scattered occurrences get no rhythm at all', () => {
  const times = ['2026-08-03T09:00:00Z', '2026-08-05T14:00:00Z', '2026-08-12T22:00:00Z',
    '2026-08-19T03:00:00Z', '2026-09-01T17:00:00Z'];
  const series = times.map((iso) => incident({ opened_at: at(iso), resolved_at: new Date(at(iso).getTime() + HOUR) }));
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.rhythm.kind, null);
  assert.equal(result.rhythm.confident, false);
});

test('a nightly job is named as daily, not weekly', () => {
  const series = [];
  for (let i = 0; i < 5; i += 1) {
    const opened = new Date(at('2026-09-01T02:00:00Z').getTime() + i * 24 * HOUR);
    series.push(incident({ opened_at: opened, resolved_at: new Date(opened.getTime() + HOUR) }));
  }
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.rhythm.kind, 'daily');
  assert.match(result.rhythm.detail, /02:00 UTC/);
});

test('a machine cycle that lands on no clock face is reported as regular, not as a schedule', () => {
  const series = [];
  for (let i = 0; i < 5; i += 1) {
    const opened = new Date(at('2026-09-01T02:00:00Z').getTime() + i * 38 * HOUR);
    series.push(incident({ opened_at: opened, resolved_at: new Date(opened.getTime() + HOUR) }));
  }
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.rhythm.kind, 'regular');
  assert.match(result.rhythm.detail, /about every 38 hours/);
});

// ------------------------------------------------------- was it ever fixed
test('a problem that returns within hours of being resolved was not fixed', () => {
  const series = [];
  for (let i = 0; i < 4; i += 1) {
    const opened = new Date(at('2026-09-10T08:00:00Z').getTime() + i * 4 * HOUR);
    series.push(incident({ opened_at: opened, resolved_at: new Date(opened.getTime() + HOUR) }));
  }
  const result = findRecurrence({ incident: series[3], history: series.slice(0, 3) });
  assert.equal(result.flapping, true);
  assert.ok(result.resolution.median_quiet_hours <= FLAP_WINDOW_HOURS);
  assert.match(result.summary, /has not been fixed/);
});

test('a weekly problem that stays away for a week is not flapping', () => {
  const series = weekly(5);
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.flapping, false);
  assert.equal(result.chronic, false);
  assert.ok(result.resolution.median_quiet_hours > FLAP_WINDOW_HOURS);
});

test('an incident that never resolved cannot have flapped — it never stopped', () => {
  const series = weekly(5, { resolveAfterHours: null });
  const result = findRecurrence({ incident: series[4], history: series.slice(0, 4) });
  assert.equal(result.resolution.ever_resolved, false);
  assert.equal(result.flapping, false, 'never stopping and stopping-then-returning are different problems');
  assert.equal(result.chronic, false);
});

test('the current incident being open is said plainly', () => {
  const series = weekly(4);
  const open = incident({ opened_at: at('2026-09-12T09:00:00Z'), resolved_at: null, status: 'open' });
  const result = findRecurrence({ incident: open, history: series });
  assert.equal(result.resolution.still_open, true);
});

// -------------------------------------------------------- getting worse
test('shrinking gaps are only called shrinking with enough gaps to see a trend', () => {
  // Two occurrences close together after two far apart is not a trend, it is
  // four points — and a dashboard that cries wolf on four points gets ignored.
  const closing = [0, 168, 300, 340, 360, 372].map((h) => {
    const opened = new Date(at('2026-08-01T09:00:00Z').getTime() + h * HOUR);
    return incident({ opened_at: opened, resolved_at: new Date(opened.getTime() + HOUR) });
  });
  const result = findRecurrence({ incident: closing[5], history: closing.slice(0, 5) });
  assert.equal(result.interval.shrinking, true);

  const steady = weekly(5);
  assert.equal(findRecurrence({ incident: steady[4], history: steady.slice(0, 4) }).interval.shrinking, false);

  // Too few gaps to judge: null, not false. "We did not look" and "we looked and
  // it is not shrinking" must never collapse into the same answer.
  const three = weekly(3);
  assert.equal(findRecurrence({ incident: three[2], history: three.slice(0, 2) }).interval.shrinking, null);
});

// ---------------------------------------------------------------- reporting
test('the sentence from the spec is the sentence it produces', () => {
  const series = weekly(12);
  const result = findRecurrence({ incident: series[11], history: series.slice(0, 11) });
  assert.match(result.summary, /^Similar incidents detected\. Customer API, http_500\. 12 occurrences\./);
});

test('the occurrences are listed so the claim can be checked rather than trusted', () => {
  const series = weekly(6);
  const result = findRecurrence({ incident: series[5], history: series.slice(0, 5) });
  assert.equal(result.evidence.length, 6);
  for (const row of result.evidence) assert.ok(row.opened_at instanceof Date);
  assert.equal(result.span_days, 35);
});

test('a very long recurrence reports rather than lists', () => {
  const series = weekly(60);
  const result = findRecurrence({ incident: series[59], history: series.slice(0, 59) });
  assert.equal(result.occurrences, 60);
  assert.ok(result.evidence.length <= 25, 'a list of 60 rows is a report nobody reads');
});

test('it says it is rules, so an AI second opinion can never be confused with it', () => {
  const series = weekly(4);
  assert.equal(findRecurrence({ incident: series[3], history: series.slice(0, 3) }).source, 'rules');
});
